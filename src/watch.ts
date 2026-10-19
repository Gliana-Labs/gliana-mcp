/**
 * `gliana-ai-mcp watch` — poll one paid endpoint on a timer, from your own wallet.
 *
 * Why this exists: on x402 the sellers with volume all have the same shape, one
 * cheap endpoint something polls on a schedule. Our catalog is the opposite —
 * mostly one-shot generative calls — so nothing we sell has a reason to be
 * called twice. This is the missing half: a buyer with a cadence. It prints one
 * JSON line per poll, so it composes with jq, a log drain, or a shell `while`.
 *
 * It pays /x402/tools/<name>, not /v1/tools/<name>. Same price, same handler —
 * the difference is that the x402 rail settles through a public facilitator, so
 * the call is independently verifiable rather than only visible to us.
 *
 * MONEY SAFETY — the three rules this file is built around:
 *
 *  1. `--budget` is required and is a HARD stop. Before every poll it compares
 *     the budget against what is already spent PLUS the live quote; it never
 *     starts a call it cannot afford.
 *  2. The price comes from the live 402 on every poll, never from a table in
 *     here. If we reprice upward mid-run, the budget maths sees it immediately.
 *  3. A paid call that fails AFTER the money moved is counted as spent and is
 *     never retried automatically. Retrying is how you pay twice for one
 *     answer; the loop logs it and waits for the next tick instead.
 */
import { x402Client } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { registerExactSvmScheme } from '@x402/svm/exact/client';

export type WatchDeps = {
  api: string;
  /** viem account, when a 0x key is configured. */
  evmAccount: unknown | null;
  /** @solana/kit signer, when a Solana key is configured. */
  solanaSigner: unknown | null;
  evmNetwork?: string;
  svmNetwork?: string;
  /** Test seams. Unset in production: the real fetch and a real signing client. */
  fetchImpl?: typeof globalThis.fetch;
  payingFetchImpl?: typeof globalThis.fetch;
  sleepImpl?: (ms: number) => Promise<void>;
};

const DEFAULT_EVM_NET = 'eip155:8453';
const DEFAULT_SVM_NET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

const USAGE = `
gliana-ai-mcp watch — poll one paid endpoint on a timer, paying per call from your wallet.

  npx gliana-ai-mcp watch --tool <name> [--input '<json>'] --budget <usd> [options]

Required
  --tool <name>       Tool to poll, e.g. token-price, perp-markets, exchange-rate, dex-pairs.
                      Run with --list to see what is sellable right now.
  --budget <usd>      Hard cap on TOTAL spend. The loop stops before exceeding it.
                      There is no default: an unbounded spend loop is not a thing
                      this command will do for you.

Options
  --input '<json>'    Request body, e.g. '{"symbol":"SOL"}'. Default {}.
  --every <seconds>   Poll interval, default 60, minimum 5.
  --max <n>           Stop after n successful polls.
  --rail <r>          base | solana. Default: base if GLIANA_WALLET_KEY is set, else solana.
  --dry-run           Fetch the 402 quote, print it, pay nothing, exit.
  --list              List pollable (cheap, GET-shaped) tools with prices and exit.
  --quiet             Only print the result object, no per-call accounting.

Each poll prints one JSON line: {"t","call","costUsd","spentUsd","result"}.
Ctrl-C prints a summary and exits 0.

Wallet keys come from the same env as the MCP server (GLIANA_WALLET_KEY /
GLIANA_SOLANA_KEY, or the *_FILE variants). Use a dedicated wallet holding only
what you intend to spend.
`.trim();

type Args = {
  tool?: string;
  input: Record<string, unknown>;
  budgetUsd?: number;
  everySec: number;
  max?: number;
  rail?: string;
  dryRun: boolean;
  list: boolean;
  quiet: boolean;
  help: boolean;
};

export function parseArgs(argv: string[]): Args | { error: string } {
  const a: Args = { input: {}, everySec: 60, dryRun: false, list: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} needs a value`);
      return v;
    };
    try {
      switch (k) {
        case '--tool': a.tool = next(); break;
        case '--input': a.input = JSON.parse(next()) as Record<string, unknown>; break;
        case '--budget': a.budgetUsd = Number(next()); break;
        case '--every': a.everySec = Number(next()); break;
        case '--max': a.max = Number(next()); break;
        case '--rail': a.rail = next().toLowerCase(); break;
        case '--dry-run': a.dryRun = true; break;
        case '--list': a.list = true; break;
        case '--quiet': a.quiet = true; break;
        case '-h': case '--help': a.help = true; break;
        default: return { error: `Unknown option "${k}". Run with --help.` };
      }
    } catch (err) {
      return { error: (err as Error).message };
    }
  }
  if (a.help || a.list) return a;
  if (!a.tool) return { error: 'Missing --tool. Run with --list to see what is pollable.' };
  // An unbounded loop spending real money needs an explicit ceiling, not a
  // default one. Refusing here is the whole safety story of this command.
  if (a.budgetUsd === undefined) return { error: 'Missing --budget <usd>. This command will not run without a spend ceiling.' };
  if (!Number.isFinite(a.budgetUsd) || a.budgetUsd <= 0) return { error: '--budget must be a positive number of dollars.' };
  if (!Number.isFinite(a.everySec) || a.everySec < 5) return { error: '--every must be at least 5 seconds.' };
  if (a.max !== undefined && (!Number.isInteger(a.max) || a.max < 1)) return { error: '--max must be a positive whole number.' };
  return a;
}

/** The quote for one call, read from the live 402 — never from a local table. */
export function quoteFromChallenge(body: unknown): { micro: number; network: string } | null {
  const accepts = (body as { accepts?: Array<Record<string, unknown>> } | null)?.accepts;
  if (!Array.isArray(accepts) || !accepts.length) return null;
  // Every option on one of our resources carries the same price, so the first
  // is representative; take the max anyway so a future per-network price can
  // only make the budget check more conservative, never less.
  let micro = 0;
  for (const a of accepts) {
    const raw = a.maxAmountRequired ?? a.amount;
    const n = Number(raw);
    if (Number.isFinite(n)) micro = Math.max(micro, n);
  }
  return micro > 0 ? { micro, network: String(accepts[0].network ?? '?') } : null;
}

const usd = (micro: number) => micro / 1_000_000;
const fmt = (dollars: number) => `$${dollars.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;

function buildPayingFetch(deps: WatchDeps, rail: string) {
  let client = new x402Client();
  if (rail === 'base') {
    if (!deps.evmAccount) throw new Error('--rail base needs GLIANA_WALLET_KEY (a 0x key holding USDC on Base).');
    client = registerExactEvmScheme(client, { signer: deps.evmAccount as never, networks: [(deps.evmNetwork ?? DEFAULT_EVM_NET) as never] });
  } else if (rail === 'solana') {
    if (!deps.solanaSigner) throw new Error('--rail solana needs GLIANA_SOLANA_KEY (a Solana key holding USDC).');
    client = registerExactSvmScheme(client, { signer: deps.solanaSigner as never, networks: [(deps.svmNetwork ?? DEFAULT_SVM_NET) as never] });
  } else {
    throw new Error(`Unknown --rail "${rail}". Use base or solana.`);
  }
  return wrapFetchWithPayment(fetch, client);
}

/**
 * Statuses that mean "this request is wrong", not "try again later".
 *
 * Re-sending a body the gateway already refused costs nothing (its guards run
 * before the charge) but it will never succeed, so the loop stops and says so
 * rather than printing the same rejection every tick. 408 and 429 are timing,
 * not correctness; 402 is handled separately as an unfunded wallet.
 */
const isPermanent = (status: number) => status >= 400 && status < 500 && status !== 402 && status !== 408 && status !== 429;

/** How many transient failures in a row before giving up on a run. */
const MAX_TRANSIENT_FAILURES = 5;

/** The tool's own published example body, used to make a 400 self-explanatory. */
async function exampleFor(api: string, tool: string, doFetch: typeof globalThis.fetch): Promise<string | null> {
  try {
    const r = await doFetch(`${api}/v1/tools`, { headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    const { tools = [] } = (await r.json()) as { tools?: Array<{ name?: string; example?: unknown }> };
    const hit = tools.find((x) => x.name === tool);
    return hit?.example ? JSON.stringify(hit.example) : null;
  } catch {
    return null;
  }
}

/** Tools worth polling: cheap enough that a loop is sane, and not browser/AI-heavy. */
const POLLABLE_CATEGORIES = new Set(['market', 'osint', 'security']);
const POLLABLE_MAX_MICRO = 10_000; // $0.01

async function listPollable(api: string, doFetch: typeof globalThis.fetch): Promise<number> {
  const r = await doFetch(`${api}/v1/tools`, { headers: { accept: 'application/json' } });
  if (!r.ok) {
    console.error(`GET /v1/tools -> HTTP ${r.status}`);
    return 1;
  }
  const { tools = [] } = (await r.json()) as { tools?: Array<Record<string, unknown>> };
  const rows = tools
    .filter((t) => Number(t.priceMicroUsd) > 0 && Number(t.priceMicroUsd) <= POLLABLE_MAX_MICRO && POLLABLE_CATEGORIES.has(String(t.category)))
    .sort((a, b) => Number(a.priceMicroUsd) - Number(b.priceMicroUsd));
  if (!rows.length) {
    console.log('No pollable tools found (the live /v1/tools list is the source, so this can change).');
    return 0;
  }
  console.log('Pollable tools (price per call, from the live catalog):\n');
  for (const t of rows) {
    console.log(`  ${fmt(usd(Number(t.priceMicroUsd))).padEnd(10)} ${String(t.name).padEnd(18)} ${String(t.category).padEnd(10)} ${String(t.guidance ?? '').replace(/^Input: [^.]*\.\s*/, '').slice(0, 58)}`);
  }
  console.log('\nEach tool\'s own example body is in GET /v1/tools (field `example`).');
  console.log('\nExample:\n  npx gliana-ai-mcp watch --tool token-price --input \'{"symbol":"SOL"}\' --every 60 --budget 0.50');
  return 0;
}

export async function runWatch(argv: string[], deps: WatchDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    console.error(parsed.error);
    return 2;
  }
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (parsed.list) return listPollable(deps.api, doFetch);

  const rail = parsed.rail ?? (deps.evmAccount ? 'base' : deps.solanaSigner ? 'solana' : '');
  // The wallet is only needed to PAY. --dry-run deliberately works without one:
  // seeing the quote and the runtime a budget buys is how you decide whether to
  // fund a wallet at all, so it must not be gated behind having funded one.
  if (!rail && !parsed.dryRun) {
    console.error('No wallet configured. Set GLIANA_WALLET_KEY (base) and/or GLIANA_SOLANA_KEY (solana).');
    return 2;
  }
  const url = `${deps.api}/x402/tools/${parsed.tool}`;
  const body = JSON.stringify(parsed.input);

  // Learn the price from the resource itself before anything is signed. An
  // unpaid POST returns the 402 challenge and costs nothing.
  const probe = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  if (probe.status === 404) {
    console.error(`${parsed.tool} is not on the x402 rail. Run --list for what is.`);
    return 2;
  }
  if (probe.status !== 402) {
    console.error(`Expected a 402 quote from ${url}, got HTTP ${probe.status}. Not starting.`);
    return 2;
  }
  let quote = quoteFromChallenge(await probe.json().catch(() => null));
  if (!quote) {
    console.error('Could not read a price out of the 402 challenge. Not starting.');
    return 2;
  }

  if (parsed.dryRun) {
    const polls = Math.floor(parsed.budgetUsd! / usd(quote.micro));
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          resource: url,
          rail: rail || '(none configured — fund a wallet to run for real)',
          costUsd: usd(quote.micro),
          budgetUsd: parsed.budgetUsd,
          pollsAffordable: polls,
          runtimeHours: Number(((polls * parsed.everySec) / 3600).toFixed(2)),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  let payingFetch: typeof globalThis.fetch;
  try {
    payingFetch = deps.payingFetchImpl ?? buildPayingFetch(deps, rail);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }

  let spentMicro = 0;
  let calls = 0;
  let failures = 0;
  let stopping = false;
  const started = Date.now();
  const budgetMicro = Math.round(parsed.budgetUsd! * 1_000_000);

  const summary = (why: string) => {
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    console.error(
      `\n${why}. ${calls} paid call${calls === 1 ? '' : 's'}, ${failures} failure${failures === 1 ? '' : 's'}, ` +
        `${fmt(usd(spentMicro))} of ${fmt(parsed.budgetUsd!)} spent over ${mins} min on ${rail}.`,
    );
  };

  const onSignal = () => {
    if (stopping) process.exit(130);
    stopping = true;
    summary('Stopped');
    process.exit(0);
  };
  if (!deps.payingFetchImpl) {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }

  console.error(
    `watching ${parsed.tool} every ${parsed.everySec}s on ${rail}: ${fmt(usd(quote.micro))}/call, ` +
      `budget ${fmt(parsed.budgetUsd!)} (~${Math.floor(budgetMicro / quote.micro)} calls). Ctrl-C to stop.`,
  );

  while (!stopping) {
    // Rule 1: never start a call the budget cannot cover, priced at the latest
    // quote we have seen rather than the one we started with.
    if (spentMicro + quote.micro > budgetMicro) {
      summary('Budget reached');
      return 0;
    }
    if (parsed.max !== undefined && calls >= parsed.max) {
      summary(`Reached --max ${parsed.max}`);
      return 0;
    }

    const t = new Date().toISOString();
    let res: Response | null = null;
    try {
      res = await payingFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    } catch (err) {
      // Rule 3: the payment may well have settled before this threw, so this
      // call is treated as money spent and is NOT retried. Charging twice for
      // one answer is worse than missing a tick.
      failures++;
      spentMicro += quote.micro;
      console.error(`${t} poll failed after payment may have settled (${String(err).slice(0, 120)}) — counted as spent, not retried.`);
    }

    if (res) {
      if (res.status === 402) {
        // Still a 402 after the client tried to pay: the wallet is short, or
        // this rail is unfunded. Stop rather than spin.
        const next = quoteFromChallenge(await res.json().catch(() => null));
        if (next) quote = next;
        summary(`Still 402 after paying — wallet likely unfunded on ${rail}`);
        return 1;
      }
      if (!res.ok) {
        // A 4xx/5xx from the handler: on this gateway the middleware only
        // settles below 400, so nothing moved. Free to try again next tick —
        // but only if trying again could plausibly work.
        failures++;
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        if (isPermanent(res.status)) {
          // A rejected INPUT will be rejected identically forever. The first
          // version of this loop re-sent a malformed body every tick until
          // someone noticed and hit Ctrl-C: free, but useless, and it buried
          // the one line that said what was wrong.
          console.error(`${t} HTTP ${res.status} (no charge): ${detail}`);
          const hint = await exampleFor(deps.api, parsed.tool!, doFetch);
          if (hint) console.error(`\nThe published example body for ${parsed.tool} is:\n  --input '${hint}'`);
          summary(`Stopped on a permanent HTTP ${res.status} — the request will not start working on its own`);
          return 2;
        }
        console.error(`${t} HTTP ${res.status} (no charge, retrying): ${detail}`);
        if (failures - calls >= MAX_TRANSIENT_FAILURES) {
          summary(`Stopped after ${MAX_TRANSIENT_FAILURES} failures with nothing succeeding`);
          return 1;
        }
      } else {
        calls++;
        spentMicro += quote.micro;
        const result = await res.json().catch(() => null);
        const line = parsed.quiet
          ? JSON.stringify(result)
          : JSON.stringify({ t, call: calls, costUsd: usd(quote.micro), spentUsd: usd(spentMicro), result });
        console.log(line);
      }
    }

    if (stopping) break;
    await sleep(parsed.everySec * 1000);
  }
  summary('Stopped');
  return 0;
}
