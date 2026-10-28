#!/usr/bin/env node
/**
 * GlianaAI MCP server — exposes pay-per-call generative AI (100+ models: LLM chat/text,
 * image, video, music, speech) to any MCP client (Claude Desktop, Cursor, …).
 *
 * Discovery tools (list_models / get_price / get_schema) are free. `generate`
 * runs a model and settles the gateway's 402 from YOUR wallet via mppx. One
 * /v1/infer challenge offers Tempo, Base (USDC), and Solana (USDC); the MCP pays
 * whichever rail you've configured. Keys are read from the client config and
 * never leave this process — non-custodial, same model as ai.glianalabs.com.
 *
 * Config (env):
 *   GLIANA_WALLET_KEY  0x EVM private key — enables `base` and `tempo`.
 *   GLIANA_SOLANA_KEY  Solana secret key (base58 or JSON array) — enables `solana`.
 *   GLIANA_RAIL        base | tempo | solana — which rail to pay with (default: base,
 *                      else solana). Fund the wallet on the matching chain.
 *   GLIANA_API_URL     defaults to https://api.glianalabs.com.
 *   GLIANA_MAX_PER_CALL_USD / GLIANA_MAX_PER_DAY_USD  optional spending caps, checked
 *                      against the exact 402 price BEFORE paying (see spend.ts).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Mppx, tempo } from 'mppx/client';
import { solana } from '@solana/mpp/client';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes } from '@solana/kit';
import bs58 from 'bs58';
import { baseMethod } from './rails.js';
import { CapRefusal, SpendLedger, capOnChallenge, capsFromEnv, priceFromWwwAuthenticate, refusal } from './spend.js';
import { z } from 'zod';
import { ed25519 } from '@noble/curves/ed25519';
import { AUTO_WALLET_CAPS, loadOrCreateWallet, type LoadedWallet } from './wallet.js';

const API = (process.env.GLIANA_API_URL ?? 'https://api.glianalabs.com').replace(/\/+$/, '');

/**
 * Read a key, preferring a FILE over an inline value.
 *
 * An inline key lives in the MCP client's config JSON — a file that gets synced
 * to cloud storage, committed by accident, and screenshotted when someone asks
 * for help. `*_KEY_FILE` points at a file you control the permissions on, so
 * the secret never enters the config at all.
 *
 * Inline still works: breaking existing installs to make a point would be
 * worse than the risk. But the file path is documented first and warned about
 * here, because "paste your private key into this JSON" is a fair thing for a
 * reviewer to refuse.
 */
function readKey(name: string): string | undefined {
  const file = process.env[`${name}_FILE`]?.trim();
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch (err) {
      console.error(`${name}_FILE could not be read (${String(err).slice(0, 80)}) — that rail is disabled.`);
      return undefined;
    }
  }
  const inline = process.env[name]?.trim();
  if (inline) {
    console.error(
      `${name} was supplied inline. Prefer ${name}_FILE=/path/to/key (chmod 600) so the key is not stored ` +
        'in your MCP client config. Use a dedicated wallet holding only what you intend to spend.',
    );
  }
  return inline;
}

let RAW_EVM = readKey('GLIANA_WALLET_KEY');
let RAW_SOL = readKey('GLIANA_SOLANA_KEY');

/**
 * Pay with a NEAR account (2026-10-29): GLIANA_NEAR_KEY_FILE points at
 * {"account_id":"…","private_key":"ed25519:…"}. NEAR Chain Signatures sign the Base
 * USDC payment, so no EVM key exists anywhere. With GLIANA_NEAR_ALLOWANCE set, the
 * key is the AGENT's and may only ask that agent-allowance contract, which holds
 * the Base address and signs within its owner's budget (src/near-signer.ts).
 */
const NEAR_KEY: { account_id: string; private_key: string } | null = (() => {
  const raw = readKey('GLIANA_NEAR_KEY');
  if (!raw) return null;
  try {
    const k = JSON.parse(raw) as { account_id?: string; private_key?: string };
    if (k.account_id && k.private_key?.startsWith('ed25519:')) return { account_id: k.account_id, private_key: k.private_key };
  } catch {
    /* fall through */
  }
  console.error('GLIANA_NEAR_KEY(_FILE) must be {"account_id":"…","private_key":"ed25519:…"} — the NEAR rail is disabled.');
  return null;
})();
const NEAR_ALLOWANCE = process.env.GLIANA_NEAR_ALLOWANCE?.trim() || null;
const NEAR_NETWORK = (process.env.GLIANA_NEAR_NETWORK?.trim() === 'testnet' ? 'testnet' : 'mainnet') as 'mainnet' | 'testnet';
const NEAR_PATH = process.env.GLIANA_NEAR_PATH?.trim() || 'gliana-x402';

/**
 * No wallet key configured: use (or make) the agent's own wallet, a file on this
 * machine (src/wallet.ts). Keys supplied in the config always win, so nothing
 * changes for an install that already pays from a wallet.
 */
let AUTO_WALLET: LoadedWallet | null = null;
// A configured NEAR account is a wallet too: no self-made one beside it.
if (!RAW_EVM && !RAW_SOL && !NEAR_KEY) {
  const r = loadOrCreateWallet(process.env, (k) => ({
    evm: privateKeyToAccount(k.evm).address,
    solana: bs58.encode(ed25519.getPublicKey(bs58.decode(k.solana))),
  }));
  if ('wallet' in r) {
    AUTO_WALLET = r.wallet;
    RAW_EVM = r.wallet.keys.evm;
    RAW_SOL = r.wallet.keys.solana;
    console.error(
      r.wallet.created
        ? `Made this agent's own wallet at ${r.wallet.path}${r.wallet.encrypted ? ' (encrypted)' : ' (owner-only file; set GLIANA_PASSPHRASE before first start to encrypt it)'}. Back that file up: it is the only copy of the keys. Call the wallet tool for its addresses.`
        : `Using the agent's wallet at ${r.wallet.path}.`,
    );
  } else {
    console.error(r.none);
  }
}
const RAW_API_KEY = readKey('GLIANA_API_KEY');
const RAIL = (process.env.GLIANA_RAIL ?? '').trim().toLowerCase();

/**
 * The prepaid-balance key (`gk_…`), if one is configured.
 *
 * This is the rail that does NOT need a wallet. The gateway charges a prepaid
 * balance behind the key and answers 200 directly — no 402 handshake, no
 * signing, no chain, no gas. It is the only payment method here that does not
 * require a private key in the MCP client's config file, which is the thing a
 * reviewer can fairly refuse (see readKey above).
 *
 * Validated by SHAPE, not by a round trip: an obviously malformed value should
 * say so at startup rather than failing on the first paid call. The gateway is
 * the only authority on whether a well-formed key is real.
 */
function glianaKey(): string | null {
  const k = RAW_API_KEY?.trim();
  if (!k) return null;
  if (!/^gk_[A-Za-z0-9_-]{8,}$/.test(k)) {
    console.error('GLIANA_API_KEY does not look like a gateway key (expected gk_…) — the balance rail is disabled.');
    return null;
  }
  return k;
}

// EVM account (Base + Tempo) from a 0x key — signs locally, no gas for the USDC transfer.
let evmAccount: ReturnType<typeof privateKeyToAccount> | null = null;
if (RAW_EVM) {
  try {
    evmAccount = privateKeyToAccount((RAW_EVM.startsWith('0x') ? RAW_EVM : `0x${RAW_EVM}`) as `0x${string}`);
  } catch {
    console.error('GLIANA_WALLET_KEY is not a valid 0x private key — base/tempo disabled.');
  }
}

// Solana signer built async at startup (see main()).
let solanaSigner: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>> | null = null;

async function buildSolanaSigner(key: string) {
  const bytes = key.startsWith('[') ? Uint8Array.from(JSON.parse(key) as number[]) : bs58.decode(key);
  if (bytes.length === 64) return createKeyPairSignerFromBytes(bytes);
  if (bytes.length === 32) return createKeyPairSignerFromPrivateKeyBytes(bytes);
  throw new Error('GLIANA_SOLANA_KEY must be a 32- or 64-byte secret key (base58 or JSON array).');
}

/** Which rail to pay with, and whether its key is present. */
function resolveRail(): { rail: string; method: unknown } | { error: string } {
  const rail = RAIL || (evmAccount ? 'base' : solanaSigner ? 'solana' : NEAR_KEY ? 'near' : '');
  if (!rail)
    return {
      error:
        'No payment method configured. Either set GLIANA_API_KEY (a gk_… key with a prepaid balance — no wallet, ' +
        'no private key, top up at https://dashboard.glianalabs.com), or set GLIANA_WALLET_KEY (base/tempo) ' +
        'and/or GLIANA_SOLANA_KEY (solana) to pay per call from your own wallet. ' +
        'Without any key, the free tools still work — call list_tools: those at priceMicroUsd 0 (Indonesian regions, ' +
        'prayer times, holidays, NIK/NPWP checks, QRIS, terbilang, and `references` for real books and journal articles to cite) need no wallet.',
    };
  if (rail === 'base') {
    if (!evmAccount) return { error: 'GLIANA_RAIL=base needs GLIANA_WALLET_KEY (a 0x key holding USDC on Base).' };
    return { rail, method: baseMethod(evmAccount) };
  }
  if (rail === 'tempo') {
    if (!evmAccount) return { error: 'GLIANA_RAIL=tempo needs GLIANA_WALLET_KEY (a 0x key holding USDC on Tempo).' };
    return { rail, method: tempo({ account: evmAccount }) };
  }
  if (rail === 'solana') {
    if (!solanaSigner) return { error: 'GLIANA_RAIL=solana needs GLIANA_SOLANA_KEY (a Solana key holding USDC).' };
    return { rail, method: solana.charge({ signer: solanaSigner as never }) };
  }
  if (rail === 'near') {
    if (!NEAR_KEY) return { error: 'GLIANA_RAIL=near needs GLIANA_NEAR_KEY_FILE (a NEAR account key file).' };
    return { rail, method: null };
  }
  return { error: `Unknown GLIANA_RAIL "${rail}". Use base, tempo, solana, or near.` };
}

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;

/**
 * Make one paid call, over whichever rail is configured.
 *
 * The `gk_` key WINS when both are present. That mirrors the gateway's own rule
 * (lib/keys.ts: "a gk_ key is something the caller deliberately attached, so it
 * wins") and it is the safer default: spending a prepaid balance someone topped
 * up on purpose beats spending from a wallet whose key happens to be in the
 * same config file.
 *
 * ONE attempt, never an automatic retry — on Solana the gateway BROADCASTS the
 * signed transaction, so a retry broadcasts a second one and the wallet pays
 * TWICE (a 402 can be an in-flight tx the gateway could not confirm in time,
 * not a true failure). The caller re-invokes the tool to retry deliberately.
 * The balance rail cannot double-charge this way, but the rule is kept uniform
 * so no call site has to know which rail it got.
 */
// A wallet this server made starts with limits ($1 a call, $5 a day) unless the person set their own.
const ENV_CAPS = capsFromEnv(process.env);
const CAPS = AUTO_WALLET && ENV_CAPS.perCallMicro === null && ENV_CAPS.perDayMicro === null ? { ...AUTO_WALLET_CAPS } : ENV_CAPS;
const ledger = new SpendLedger();
const capped = CAPS.perCallMicro !== null || CAPS.perDayMicro !== null;

async function paidFetch(path: string, body: string, walletOnly = false): Promise<{ rail: string; res: Response } | { error: string }> {
  const url = `${API}${path}`;
  const headers = { 'content-type': 'application/json' };
  // walletOnly: top_up, which must never be paid FROM the balance it is funding.
  const key = walletOnly ? null : glianaKey();
  if (key) {
    let quoted: number | null = null;
    if (capped) {
      // The balance rail answers 200 with no 402, so the price is never seen
      // before the charge. An unpaid request is free and returns the exact
      // challenge the gateway would bill (same priceForRequest), so ask that
      // first. A 4xx here is the pre-charge guard speaking — hand it back as is.
      const probe = await fetch(url, { method: 'POST', headers, body });
      if (probe.status !== 402) return { rail: 'balance', res: probe };
      quoted = priceFromWwwAuthenticate(probe.headers.get('www-authenticate'));
      if (quoted === null) return { error: 'Not paid: could not read the price to check it against your spending caps.' };
      const why = refusal(quoted, CAPS, ledger.spentToday());
      if (why) return { error: why };
    }
    const res = await fetch(url, { method: 'POST', headers: { ...headers, authorization: `Bearer ${key}` }, body });
    if (res.ok && capped) ledger.record(Number(res.headers.get('x-gliana-charged-micro-usd')) || quoted || 0);
    return { rail: 'balance', res };
  }
  const picked = resolveRail();
  if ('error' in picked) return { error: picked.error };
  if (picked.rail === 'near') return nearFetch(path, body);
  let quoted = 0;
  // Fresh client per attempt so a stale 402 challenge is never reused.
  const mppx = Mppx.create({
    methods: [picked.method] as never,
    polyfill: false,
    // The challenge carries the exact price, and this runs before anything is
    // signed — the one point where a wallet payment can still be stopped free.
    onChallenge: capOnChallenge(CAPS, () => ledger.spentToday(), (micro) => (quoted = micro)) as never,
  });
  let res: Response;
  try {
    res = await mppx.fetch(url, { method: 'POST', headers, body });
  } catch (err) {
    if (err instanceof CapRefusal) return { error: err.message };
    throw err;
  }
  if (res.ok && capped) ledger.record(quoted);
  return { rail: picked.rail, res };
}

/** The x402 twin of each paid path: the NEAR payer speaks x402 (EIP-3009 on Base). */
function x402PathOf(path: string, body: string): { path: string; body: string } | null {
  if (path === '/v1/infer') {
    const { model, ...input } = JSON.parse(body) as { model?: string };
    return model ? { path: `/x402/${encodeURIComponent(model)}`, body: JSON.stringify(input) } : null;
  }
  const m = /^\/v1\/(tools|recipes)\/([a-z0-9-]+)$/.exec(path);
  return m ? { path: `/x402/${m[1]}/${m[2]}`, body } : null;
}

let nearFrom: `0x${string}` | null = null;
/** The Base address the NEAR rail pays from: the allowance contract's, else the account's. */
async function nearAddress(): Promise<`0x${string}`> {
  if (!nearFrom) {
    const { deriveEvmAddress } = await import('./near.js');
    nearFrom = await deriveEvmAddress(NEAR_ALLOWANCE ?? NEAR_KEY!.account_id, NEAR_PATH, NEAR_NETWORK);
  }
  return nearFrom;
}

/** One payment from a NEAR account — ONE attempt, like every rail: the nonce is single-use. */
async function nearFetch(path: string, body: string): Promise<{ rail: string; res: Response } | { error: string }> {
  const target = x402PathOf(path, body);
  if (!target) return { error: 'This call cannot be paid from a NEAR account yet (only models, tools and recipes).' };
  const [{ payWithNear }, { directSigner, allowanceSigner }] = await Promise.all([import('./near.js'), import('./near-signer.js')]);
  const sign = NEAR_ALLOWANCE ? allowanceSigner(NEAR_KEY!, NEAR_ALLOWANCE, NEAR_NETWORK) : directSigner(NEAR_KEY!, NEAR_PATH, NEAR_NETWORK);
  let quoted = 0;
  try {
    const r = await payWithNear({
      url: `${API}${target.path}`,
      body: JSON.parse(target.body),
      from: await nearAddress(),
      sign,
      // The spending caps apply here too, checked against the 402's price before anything is signed.
      beforeSign: (micro) => {
        quoted = micro;
        const why = refusal(micro, CAPS, ledger.spentToday());
        if (why) throw new CapRefusal(why);
      },
    });
    if (r.status === 200 && capped) ledger.record(quoted);
    return { rail: 'near', res: new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } }) };
  } catch (err) {
    return { error: String((err as Error)?.message ?? err).slice(0, 400) };
  }
}

/**
 * What to tell the caller about a 402, which means something different per rail.
 *
 * On the balance rail a 402 is NOT a failed settlement — it is the gateway
 * saying "top up" or "daily cap", and it carries the instruction in the body.
 * Telling someone to go fund a wallet would be wrong and confusing, so the
 * gateway's own `detail` is relayed verbatim.
 */
async function paymentRefused(rail: string, res: Response, retryWhat: string): Promise<string> {
  if (rail === 'balance') {
    const e = (await res.json().catch(() => ({}))) as { error?: string; detail?: string; topup_url?: string };
    const where = e.topup_url ? ` Top up: ${e.topup_url}` : '';
    return `${e.detail ?? e.error ?? 'The prepaid balance could not cover this call.'}${where}`;
  }
  if (rail === 'near') {
    return `Payment did not settle: the Base address ${await nearAddress()} (paid from ${NEAR_ALLOWANCE ?? NEAR_KEY?.account_id}) may hold too little USDC — send USDC on Base there, then call ${retryWhat} again.`;
  }
  if (AUTO_WALLET) {
    const where = rail === 'solana' ? solanaSigner?.address : evmAccount?.address;
    return `Payment did not settle over ${rail}. This agent's own wallet may be empty: send USDC on ${rail === 'solana' ? 'Solana' : 'Base'} to ${where}, then call ${retryWhat} again (the wallet tool shows both addresses).`;
  }
  return `Payment did not settle over ${rail} — check the wallet holds USDC on that chain, then call ${retryWhat} again.`;
}

/** Remaining balance after a charge, when the gateway reported one. */
const balanceNote = (res: Response): string => {
  const left = res.headers.get('x-gliana-balance-micro-usd');
  return left ? `, ${usd(Number(left))} left` : '';
};

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}`);
  return (await r.json()) as T;
}

const ok = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const okv = (s: string, structured: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: s }],
  structuredContent: structured,
});
const fail = (s: string) => ({ content: [{ type: 'text' as const, text: s }], isError: true });

const modelShape = {
  id: z.string(),
  provider: z.string(),
  category: z.string(),
  unit: z.string(),
  priceLabel: z.string(),
};

/** Find a renderable media URL in an inference result (gateway or raw provider shape). */
function mediaUrl(output: unknown): string | null {
  const o = output as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  for (const c of [o, o.result, o.output].filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')) {
    for (const k of ['url', 'image', 'video', 'audio']) {
      const v = c[k];
      if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
    }
  }
  return null;
}

type CatalogModel = { id: string; provider: string; category: string; unit: string; priceLabel: string };

/**
 * A utility tool as the gateway describes itself at GET /v1/tools.
 *
 * Fetched live rather than hardcoded here. The gateway is the single source for
 * the catalog, prices and schemas already (that's why list_models exists), and
 * the tool list had drifted for exactly the reason a hardcoded list always does:
 * six endpoints shipped and this file still advertised the old ten. Reading the
 * listing means a new endpoint is usable from MCP the moment it deploys, with no
 * npm release.
 *
 * `method` matters: the free reference endpoints are GET with query parameters,
 * so a POST-only runner cannot reach them at all. `priceMicroUsd === 0` marks the
 * ones that need no wallet.
 */
type UtilityTool = {
  name: string;
  path: string;
  method?: 'GET' | 'POST';
  priceMicroUsd: number;
  example?: Record<string, unknown>;
  guidance?: string;
};

/** Cached for the process; the listing itself is edge-cached for 5 minutes. */
let toolCatalog: UtilityTool[] | null = null;
async function listTools(): Promise<UtilityTool[]> {
  if (toolCatalog) return toolCatalog;
  const { tools } = await getJson<{ tools: UtilityTool[] }>('/v1/tools');
  toolCatalog = tools;
  return tools;
}
type Price = { model: string; costMicroUsd: number; unit: string; units: number };
type InferResult = { model: string; costMicroUsd: number; output: unknown };

/**
 * The published version, read from package.json at startup so it cannot drift
 * from what npm actually shipped. `files: ['dist']` means package.json sits one
 * level above the bundled entry point.
 */
const PKG_VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
  } catch {
    // Never let a packaging quirk stop the server from starting.
    return '0.0.0';
  }
})();

/**
 * Every request to the gateway says it came from this server (2026-10-29): npm
 * counted ~1,200 downloads in a month while the gateway could not tell a single
 * call of ours from anyone else's — and the free lookups leave no usage row at
 * all. The gateway counts calls by this User-Agent (per day, per path); nothing
 * else about the caller is sent. mppx's own requests go through fetch too.
 */
const USER_AGENT = `gliana-ai-mcp/${PKG_VERSION}`;
const baseFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(API)) return baseFetch(input, init);
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  if (!headers.has('user-agent')) headers.set('user-agent', USER_AGENT);
  return baseFetch(input, { ...init, headers });
}) as typeof fetch;

const server = new McpServer(
  {
    name: 'gliana-ai',
    // Read from package.json, not typed twice. It had drifted to 0.5.0 while the
    // package shipped 0.5.2, so every client — and Glama's introspection check —
    // was told the wrong version.
    version: PKG_VERSION,
    title: 'GlianaAI',
    websiteUrl: 'https://ai.glianalabs.com',
    icons: [
      { src: 'https://ai.glianalabs.com/icon-512.png', mimeType: 'image/png', sizes: ['512x512'] },
      { src: 'https://ai.glianalabs.com/logo.svg', mimeType: 'image/svg+xml', sizes: ['any'] },
    ],
  },
  {
    instructions:
      'GlianaAI — pay-per-call generative AI across 100+ models (LLM chat/text, image, video, music, speech) plus utility ' +
      'and data tools. No signup or API key. list_models to browse models, get_price to quote, get_schema for inputs, ' +
      'generate to run one. list_tools to browse utility tools (scraping, OCR, extraction, reference data), then `tool` ' +
      'to run one; recipe for multi-model pipelines. Discovery is free, and some utility tools are free too — ' +
      'list_tools reports those at priceMicroUsd 0. Set GLIANA_WALLET_KEY / GLIANA_SOLANA_KEY to pay for the rest.',
  },
);

server.registerTool(
  'list_models',
  {
    description:
      'List every GlianaAI model (id, category, provider, per-call price). Free — no payment. Use this to pick a model before get_price/generate.',
    inputSchema: {},
    outputSchema: { count: z.number(), models: z.array(z.object(modelShape)) },
    annotations: { title: 'List models', readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    const { models } = await getJson<{ models: CatalogModel[] }>('/v1/models');
    const byCat: Record<string, CatalogModel[]> = {};
    for (const m of models) (byCat[m.category] ??= []).push(m);
    const out = Object.entries(byCat)
      .map(([cat, ms]) => `## ${cat}\n` + ms.map((m) => `- ${m.id} (${m.provider}) — ${m.priceLabel}`).join('\n'))
      .join('\n\n');
    return okv(`${models.length} models on GlianaAI:\n\n${out}`, { count: models.length, models });
  },
);

server.registerTool(
  'get_price',
  {
    description:
      'Quote the exact cost of one call for a model (optionally with input that affects price, e.g. video duration or TTS character count). Free.',
    inputSchema: {
      model: z.string().describe('Model id from list_models, e.g. "nano-banana-2" or "veo-3.1-fast".'),
      input: z.record(z.any()).optional().describe('Optional model input that affects price (e.g. { duration: 8 } or { text: "..." }).'),
    },
    outputSchema: {
      model: z.string(),
      costMicroUsd: z.number(),
      costUsd: z.string(),
      unit: z.string(),
      units: z.number(),
    },
    annotations: { title: 'Get price', readOnlyHint: true, openWorldHint: true },
  },
  async ({ model, input }) => {
    const qs = new URLSearchParams({ model });
    if (input) for (const [k, v] of Object.entries(input)) qs.set(k, String(v));
    const p = await getJson<Price>(`/v1/price?${qs.toString()}`);
    return okv(`${p.model}: ${usd(p.costMicroUsd)} (${p.units} ${p.unit}${p.units === 1 ? '' : 's'}).`, {
      model: p.model,
      costMicroUsd: p.costMicroUsd,
      costUsd: usd(p.costMicroUsd),
      unit: p.unit,
      units: p.units,
    });
  },
);

server.registerTool(
  'get_schema',
  {
    description: 'Get a model’s input fields (names, types, which are required, defaults). Use before generate to know what to send. Free.',
    inputSchema: { model: z.string().describe('Model id from list_models.') },
    outputSchema: {
      model: z.string(),
      category: z.string(),
      required: z.array(z.string()),
      props: z.record(z.any()),
    },
    annotations: { title: 'Get input schema', readOnlyHint: true, openWorldHint: true },
  },
  async ({ model }) => {
    const s = await getJson<{ model: string; category: string; required: string[]; props: Record<string, unknown> }>(
      `/v1/schema?model=${encodeURIComponent(model)}`,
    );
    return okv(
      `${s.model} (${s.category})\nrequired: ${s.required.join(', ') || '—'}\n\nfields:\n${JSON.stringify(s.props, null, 2)}`,
      { model: s.model, category: s.category, required: s.required, props: s.props },
    );
  },
);

server.registerTool(
  'generate',
  {
    description:
      'Run a model and return the result — a media URL for image/video/audio/music models, assistant text for text (LLM) models. Text models take OpenAI-style input: { messages: [{ role, content }, …], max_tokens? }. PAID: settles the price from your wallet over the configured rail (base/tempo/solana). Call get_schema first for the input shape, get_price for the cost. File inputs (image/video/audio, e.g. image-to-video or video-to-video `video_uri`) take a public URL — upload a local file with POST /v1/media (≤40MB) to get one. Array file fields (e.g. `images`, `reference_images` for multi-reference models) take an ARRAY of such URLs.',
    inputSchema: {
      model: z.string().describe('Model id from list_models.'),
      input: z.record(z.any()).describe('Model input, e.g. { prompt: "a red fox" } or { text: "hello" }. See get_schema.'),
    },
    outputSchema: {
      model: z.string(),
      costMicroUsd: z.number(),
      costUsd: z.string(),
      rail: z.string(),
      url: z.string().optional().describe('Media URL of the result, when the model returns media.'),
      output: z.any().describe('Raw model output.'),
    },
    annotations: { title: 'Generate (paid)', readOnlyHint: false, openWorldHint: true },
  },
  async ({ model, input }) => {
    const paid = await paidFetch('/v1/infer', JSON.stringify({ model, ...input }));
    if ('error' in paid) return fail(paid.error);
    const { rail, res } = paid;

    if (res.status === 401) return fail(await paymentRefused(rail, res, 'generate'));
    if (res.status === 402) return fail(await paymentRefused(rail, res, 'generate'));
    if (res.status === 400) {
      const e = (await res.json().catch(() => ({}))) as { detail?: string };
      return fail(`Missing/invalid input (no charge): ${e.detail ?? 'see get_schema'}`);
    }
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      return fail(e.detail ?? e.error ?? `Request failed (HTTP ${res.status})`);
    }

    const result = (await res.json()) as InferResult;
    const url = mediaUrl(result.output);
    const cost = usd(result.costMicroUsd);
    const structured = {
      model: result.model,
      costMicroUsd: result.costMicroUsd,
      costUsd: cost,
      rail,
      ...(url ? { url } : {}),
      output: result.output,
    };
    if (url) return okv(`${result.model} → ${url}\ncharged ${cost} via ${rail}${balanceNote(res)}`, structured);
    return okv(`${result.model} (charged ${cost} via ${rail}${balanceNote(res)}):\n${JSON.stringify(result.output, null, 2)}`, structured);
  },
);

/**
 * The utility-tool equivalent of list_models. Exists so no client, and no
 * description in this file, has to carry a hardcoded list that goes stale.
 */
server.registerTool(
  'list_tools',
  {
    description:
      'Index of every GlianaAI utility tool: one short line each (name, method, price, what it does), read live from ' +
      'the gateway. Free — no payment. Pass `name` to get ONE tool in full (example input + usage guidance) before ' +
      'calling it with `tool`; pass `category` to list only that group. Tools at price 0 are free and need no wallet.',
    inputSchema: {
      name: z.string().optional().describe('One tool name: returns its full example input and guidance.'),
      category: z.string().optional().describe('Only tools in this category (e.g. search, data, finance, media).'),
    },
    annotations: { title: 'List utility tools', readOnlyHint: true, openWorldHint: false },
  },
  // Compact on purpose. The full listing (66 tools with examples and guidance,
  // twice — text and structuredContent) was ~10k tokens, and an agent keeps it
  // in context and re-sends it EVERY step: a 13-step Rampung job paid ~130k
  // input tokens for a list it used two entries of (2026-10-25).
  async ({ name, category }) => {
    const all = await listTools();
    if (name) {
      const t = all.find((x) => x.name === name);
      if (!t) return okv(`No tool named "${name}". Call list_tools with no arguments for the index.`, { found: false });
      const method = t.method ?? 'POST';
      const price = t.priceMicroUsd === 0 ? 'free' : usd(t.priceMicroUsd);
      return okv(
        `${t.name} (${method}, ${price})\n${t.guidance ?? ''}\nExample input: ${JSON.stringify(t.example ?? {})}`,
        { name: t.name, method, priceMicroUsd: t.priceMicroUsd, example: t.example ?? {}, guidance: t.guidance ?? '' },
      );
    }
    const rows = category ? all.filter((t) => (t as { category?: string }).category === category) : all;
    const lines = rows.map((t) => {
      const price = t.priceMicroUsd === 0 ? 'free' : usd(t.priceMicroUsd);
      return `- ${t.name} (${t.method ?? 'POST'}, ${price}) ${firstSentence(t.guidance ?? '')}`;
    });
    return okv(`${rows.length} utility tools (list_tools {name} for one in full):\n${lines.join('\n')}`, { count: rows.length });
  },
);

/** The first sentence of a description, cut to 140 characters — enough to pick a tool. */
function firstSentence(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim();
  const end = s.search(/[.!](\s|$)/);
  const one = end > 0 ? s.slice(0, end + 1) : s;
  return one.length > 140 ? `${one.slice(0, 139)}…` : one;
}

server.registerTool(
  'tool',
  {
    description:
      'Run a UTILITY tool (not an AI model) — scraping, screenshots, social cards, market data, chain RPC, ' +
      'OCR, address parsing, structured extraction, Indonesian reference data. ' +
      'Call list_tools FIRST for the live list with prices and input shapes: it is read from the gateway, so it is ' +
      'never out of date, and this description deliberately does not enumerate them. ' +
      'Most tools are PAID and settle a flat price from your wallet (base/tempo/solana); the ones list_tools reports ' +
      'at priceMicroUsd 0 are free and need no wallet at all.',
    inputSchema: {
      name: z.string().describe('Utility tool name exactly as list_tools reports it, e.g. scrape, ocr-id, address-id, extract, exchange-rate, prayer-times.'),
      args: z.record(z.any()).describe("The tool's input, as list_tools shows in `example`. For GET tools these become query parameters; for POST tools, the JSON body."),
    },
    outputSchema: {
      tool: z.string(),
      costMicroUsd: z.number(),
      costUsd: z.string(),
      rail: z.string(),
      result: z.any().describe('Tool result (markdown, url, prices, or rpc result).'),
    },
    annotations: { title: 'Utility tool (paid)', readOnlyHint: false, openWorldHint: true },
  },
  async ({ name, args }) => {
    // Ask the gateway what this tool is before deciding how to call it. A tool we
    // don't recognise is still attempted as a paid POST, so a brand-new endpoint
    // works without waiting for an npm release.
    const known = await listTools()
      .then((all) => all.find((t) => t.name === name))
      .catch(() => undefined);

    // FREE + GET: the reference endpoints (wilayah, prayer-times, verify-nik) take
    // query parameters and cost nothing, so they need no wallet and must not go
    // through a payment attempt. Before this they were unreachable from MCP —
    // the runner only ever POSTed a JSON body.
    if (known && known.priceMicroUsd === 0 && known.method === 'GET') {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(args ?? {})) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
      const res = await fetch(`${API}/v1/tools/${name}?${qs}`, { headers: { accept: 'application/json' } });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) return fail(String(j.detail ?? j.error ?? `Request failed (HTTP ${res.status})`));
      return okv(`${name} (free):\n${JSON.stringify(j, null, 2)}`, {
        tool: name,
        costMicroUsd: 0,
        costUsd: '$0.0000',
        rail: 'none',
        result: j,
      });
    }

    const paid = await paidFetch(`/v1/tools/${name}`, JSON.stringify(args ?? {}));
    if ('error' in paid) return fail(paid.error);
    const { rail, res } = paid;

    if (res.status === 401 || res.status === 402) return fail(await paymentRefused(rail, res, 'tool'));
    if (res.status === 400) {
      const e = (await res.json().catch(() => ({}))) as { detail?: string };
      return fail(`Missing/invalid input (no charge): ${e.detail ?? 'see https://ai.glianalabs.com/docs#tools'}`);
    }
    if (res.status === 503) return fail(`Tool "${name}" is not enabled on this server.`);
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      return fail(e.detail ?? e.error ?? `Request failed (HTTP ${res.status})`);
    }

    const r = (await res.json()) as { tool?: string; costMicroUsd?: number; [k: string]: unknown };
    const cost = usd(r.costMicroUsd ?? 0);
    const { tool: _t, costMicroUsd: _c, ...result } = r;
    const structured = { tool: name, costMicroUsd: r.costMicroUsd ?? 0, costUsd: cost, rail, result };
    return okv(`${name} (charged ${cost} via ${rail}${balanceNote(res)}):\n${JSON.stringify(result, null, 2)}`, structured);
  },
);

server.registerTool(
  'recipe',
  {
    description:
      'Run a paid multi-model RECIPE pipeline (chains models in one call). PAID: settles the SUM of the steps from ' +
      'your wallet (base/tempo/solana). Recipes: `image-to-video` {prompt,motionPrompt?} text→image→animated video ' +
      '(3-8x cheaper than a native text-to-video model), `image-to-video-hd` (crisper still), `image-to-video-audio` ' +
      '(video with sound), `brainrot-video` {motionPrompt?,reference_image?} random Italian-brainrot creature → video ' +
      'with audio (no prompt). Override steps with { imageModel, videoModel }. See https://ai.glianalabs.com/docs#recipes.',
    inputSchema: {
      name: z.string().describe('Recipe name: image-to-video, image-to-video-hd, image-to-video-audio, or brainrot-video.'),
      args: z.record(z.any()).describe('Recipe input, e.g. { prompt, motionPrompt?, duration?, resolution? }.'),
    },
    outputSchema: {
      recipe: z.string(),
      costMicroUsd: z.number(),
      costUsd: z.string(),
      rail: z.string(),
      url: z.string().optional().describe('Final media URL (the last step).'),
      result: z.any().describe('Each step output.'),
    },
    annotations: { title: 'Recipe (paid)', readOnlyHint: false, openWorldHint: true },
  },
  async ({ name, args }) => {
    const paid = await paidFetch(`/v1/recipes/${name}`, JSON.stringify(args ?? {}));
    if ('error' in paid) return fail(paid.error);
    const { rail, res } = paid;

    if (res.status === 401 || res.status === 402) return fail(await paymentRefused(rail, res, 'recipe'));
    if (res.status === 400 || res.status === 404) {
      const e = (await res.json().catch(() => ({}))) as { detail?: string };
      return fail(`Bad request (no charge): ${e.detail ?? 'see https://ai.glianalabs.com/docs#recipes'}`);
    }
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      return fail(e.detail ?? e.error ?? `Request failed (HTTP ${res.status})`);
    }

    const r = (await res.json()) as { recipe?: string; costMicroUsd?: number; url?: string; [k: string]: unknown };
    const cost = usd(r.costMicroUsd ?? 0);
    const { recipe: _r, costMicroUsd: _c, ...result } = r;
    const structured = { recipe: name, costMicroUsd: r.costMicroUsd ?? 0, costUsd: cost, rail, url: r.url, result };
    return okv(`${name} → ${r.url ?? '(no url)'}\ncharged ${cost} via ${rail}${balanceNote(res)}`, structured);
  },
);

server.registerTool(
  'get_balance',
  {
    description:
      'FREE. Remaining prepaid balance on the configured GLIANA_API_KEY. Call this before an expensive generate to ' +
      'check there is enough, or after a paid call reports insufficient_balance. Returns an error when no gk_ key is ' +
      'configured (this server is then paying per call from a wallet instead).',
    inputSchema: {},
    outputSchema: {
      accountId: z.string(),
      balanceMicroUsd: z.number(),
      balanceUsd: z.string(),
    },
    annotations: { title: 'Get balance (free)', readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    const key = glianaKey();
    if (!key)
      return fail(
        'No GLIANA_API_KEY configured, so there is no prepaid balance to report. Mint a key and top it up at ' +
          'https://dashboard.glianalabs.com, or keep paying per call from a wallet.',
      );
    // GET /v1/keys/balance answers { account_id, balance_micro_usd, balance_usd }.
    // The daily cap is NOT reported here — it only appears in a 402
    // `daily_cap_reached` body, which paymentRefused relays verbatim.
    const res = await fetch(`${API}/v1/keys/balance`, {
      headers: { accept: 'application/json', authorization: `Bearer ${key}` },
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return fail(String(j.detail ?? j.error ?? `Could not read the balance (HTTP ${res.status})`));
    const micro = Number(j.balance_micro_usd ?? 0);
    return okv(`balance ${usd(micro)}`, {
      accountId: String(j.account_id ?? ''),
      balanceMicroUsd: micro,
      balanceUsd: String(j.balance_usd ?? usd(micro)),
    });
  },
);

server.registerTool(
  'wallet',
  {
    description:
      'FREE. The wallet this server pays from: its Base and Solana addresses (send USDC there to fund it), where its key ' +
      'file is, and the spending limits. Never returns the private key. Use it when the user asks how to fund the agent ' +
      'or where its money is.',
    inputSchema: {},
    annotations: { title: 'Wallet (free)', readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const evm = evmAccount?.address ?? null;
    const sol = solanaSigner?.address ?? null;
    if (NEAR_KEY && !evm && !sol) {
      const from = await nearAddress();
      return ok(
        [
          NEAR_ALLOWANCE
            ? `Paying from NEAR: the agent account ${NEAR_KEY.account_id} may only ask the allowance contract ${NEAR_ALLOWANCE} (${NEAR_NETWORK}), which holds the Base address and signs within its owner's budget. Its policy: \`near view ${NEAR_ALLOWANCE} get_policy\`.`
            : `Paying from the NEAR account ${NEAR_KEY.account_id} (${NEAR_NETWORK}) through NEAR Chain Signatures — no EVM private key exists.`,
          `Base (USDC): ${from} — send USDC on Base here. https://basescan.org/address/${from}`,
          `The NEAR account needs ~0.35 NEAR for signing gas (300 TGas is reserved per payment, mostly refunded). Each payment takes ~15-20 s.`,
        ].join('\n'),
      );
    }
    if (!evm && !sol) return fail('No wallet is configured. Remove GLIANA_NO_AUTO_WALLET to let this server make one, or set GLIANA_WALLET_KEY / GLIANA_SOLANA_KEY.');
    const caps = [CAPS.perCallMicro !== null ? `${usd(CAPS.perCallMicro)} per call` : null, CAPS.perDayMicro !== null ? `${usd(CAPS.perDayMicro)} per day` : null].filter(Boolean).join(', ');
    return ok(
      [
        AUTO_WALLET ? `This agent's own wallet (made by this server), stored at ${AUTO_WALLET.path}${AUTO_WALLET.encrypted ? ', encrypted' : ''}. Back that file up: it is the only copy of the keys.` : 'The wallet from your configured key.',
        evm ? `Base (USDC): ${evm} — send USDC on Base here; paying needs no ETH. https://basescan.org/address/${evm}` : null,
        sol ? `Solana (USDC): ${sol} — https://solscan.io/account/${sol}` : null,
        `Spending limits: ${caps || 'none set'}${AUTO_WALLET && caps ? ' (defaults for a self-made wallet; change with GLIANA_MAX_PER_CALL_USD / GLIANA_MAX_PER_DAY_USD)' : ''}.`,
        'Fund it with only what you intend the agent to spend.',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  },
);

server.registerTool(
  'top_up',
  {
    description:
      'Add money to the prepaid balance of the configured GLIANA_API_KEY (the balance shown at https://dashboard.glianalabs.com). ' +
      'With a wallet key configured (GLIANA_WALLET_KEY / GLIANA_SOLANA_KEY) this PAYS `usd` from that wallet now and the ' +
      'balance is credited at once — it spends real money, so only call it when the user asked to top up. Without a wallet ' +
      'it returns an exact USDC amount and address for the user to send from any wallet or exchange (credited within ' +
      'about 15 minutes; check with get_balance). usd: whole dollars, 1-100 (5, 10, 25, 50 or 100 for a manual transfer).',
    inputSchema: {
      usd: z.number().int().min(1).max(100).describe('Dollars to add to the balance.'),
      network: z.enum(['base', 'solana']).optional().describe('For a manual transfer: which chain to send USDC on (default base).'),
    },
    annotations: { title: 'Top up balance', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ usd: amount, network }) => {
    const key = glianaKey();
    if (!key)
      return fail('No GLIANA_API_KEY configured: there is no balance to top up. Create a key at https://dashboard.glianalabs.com, put it in GLIANA_API_KEY, then try again.');
    const body = JSON.stringify({ usd: amount, key });
    if (evmAccount || solanaSigner) {
      const paid = await paidFetch('/v1/keys/topup', body, true);
      if ('error' in paid) return fail(paid.error);
      const j = (await paid.res.json().catch(() => ({}))) as Record<string, unknown>;
      if (paid.res.status === 402) return fail(await paymentRefused(paid.rail, paid.res, 'top_up'));
      if (!paid.res.ok) return fail(String(j.detail ?? j.error ?? `Top-up failed (HTTP ${paid.res.status})`));
      return ok(`Topped up $${amount} from the ${paid.rail} wallet. Balance now ${j.balance_usd ? `$${j.balance_usd}` : 'updated'}.`);
    }
    // No wallet here: a quote for the user to pay by hand.
    const res = await fetch(`${API}/v1/keys/topup/usdc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ usd: amount, key, network: network ?? 'base' }),
    });
    const q = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return fail(String(q.detail ?? q.error ?? `Could not open a top-up (HTTP ${res.status})`));
    return ok(
      `To add $${amount}, send EXACTLY ${q.amountUsdc} USDC on ${q.network} to ${q.address}` +
        ` (token ${q.tokenAddress}). The odd cents identify the payment, so send that exact amount; if an exchange takes its fee ` +
        `out of the amount, add it. Credited within about 15 minutes of arriving — check with get_balance. ` +
        `This quote is watched for 24 hours.` +
        (q.payUrl ? ` Phone wallet link (Solana Pay): ${q.payUrl}` : ''),
    );
  },
);

async function main() {
  if (RAW_SOL) {
    try {
      solanaSigner = await buildSolanaSigner(RAW_SOL);
    } catch (err) {
      console.error(`GLIANA_SOLANA_KEY invalid — solana disabled: ${(err as Error).message}`);
    }
  }

  // `watch` runs INSTEAD of the MCP server: a poll loop that pays per call from
  // the same wallet (see watch.ts). Imported dynamically so the server's start
  // up never loads the x402 client stack it does not use — and so stdout, which
  // is the MCP transport below, stays untouched when we are not watching.
  if (process.argv[2] === 'watch') {
    const { runWatch } = await import('./watch.js');
    process.exit(
      await runWatch(process.argv.slice(3), {
        api: API,
        evmAccount,
        solanaSigner,
        evmNetwork: process.env.GLIANA_EVM_NETWORK,
        svmNetwork: process.env.GLIANA_SVM_NETWORK,
      }),
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stderr only — stdout is the MCP transport.
  if (glianaKey()) {
    // The key wins over any wallet (see paidFetch), so say which one will spend.
    const also = [evmAccount && 'base/tempo', solanaSigner && 'solana'].filter(Boolean).join(', ');
    console.error(
      `gliana-ai MCP ready (${API}). Paying from the prepaid balance on GLIANA_API_KEY` +
        `${also ? ` (wallet rails ${also} are configured but the key takes precedence — unset GLIANA_API_KEY to use them)` : ''}.`,
    );
  } else {
    const rails = [evmAccount && 'base', evmAccount && 'tempo', solanaSigner && 'solana', NEAR_KEY && (NEAR_ALLOWANCE ? `near (allowance ${NEAR_ALLOWANCE})` : 'near')].filter(Boolean).join(', ') || 'none';
    console.error(
      `gliana-ai MCP ready (${API}). generate rails: ${rails}${RAIL ? ` (using ${RAIL})` : ''}.` +
        (rails === 'none'
          ? ' No payment method configured — set GLIANA_API_KEY (prepaid, no wallet) or a wallet key to enable paid calls.'
          : ''),
    );
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
