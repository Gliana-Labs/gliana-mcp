/**
 * Spending caps, enforced BEFORE anything is paid.
 *
 * The gateway already caps a gk_ key at $5/day server-side, but a wallet rail
 * has no ceiling at all: an agent in a loop, or one talked into a 4K video,
 * spends whatever the wallet holds. These caps are the client-side answer, and
 * they apply to every rail so a config means the same thing whichever one pays.
 *
 * Both are opt-in (unset = no cap) so upgrading never breaks a working install.
 * The day total lives in a small file, not in memory: MCP clients restart the
 * server per session, and an in-memory total would reset with every restart.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Caps = { perCallMicro: number | null; perDayMicro: number | null };

/** "1.50" → 1_500_000. Anything unparseable or ≤ 0 means "no cap", said once at startup. */
export function parseUsd(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw.trim().replace(/^\$/, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1_000_000);
}

export function capsFromEnv(env: NodeJS.ProcessEnv): Caps {
  return { perCallMicro: parseUsd(env.GLIANA_MAX_PER_CALL_USD), perDayMicro: parseUsd(env.GLIANA_MAX_PER_DAY_USD) };
}

/**
 * Price of one challenge in micro-USD.
 *
 * Atomic units over `decimals` — 6 for USDC on every crypto rail, where atomic
 * units happen to equal micro-USD, but a Stripe challenge is in cents
 * (decimals 2), so the field is honoured rather than assumed.
 */
export function challengeMicro(request: Record<string, unknown>): number | null {
  const amount = Number(request.amount);
  if (!Number.isFinite(amount)) return null;
  const decimals = Number(request.decimals ?? (request.methodDetails as Record<string, unknown> | undefined)?.decimals ?? 6);
  return Math.round((amount / 10 ** decimals) * 1_000_000);
}

/**
 * Highest price across every `Payment` challenge in a WWW-Authenticate header.
 *
 * All rails quote the same call, so they should agree; taking the max means a
 * disagreement can only make the cap stricter, never looser.
 */
export function priceFromWwwAuthenticate(header: string | null): number | null {
  if (!header) return null;
  let best: number | null = null;
  for (const m of header.matchAll(/request="([^"]+)"/g)) {
    try {
      const json = Buffer.from(m[1], 'base64url').toString('utf8');
      const micro = challengeMicro(JSON.parse(json) as Record<string, unknown>);
      if (micro !== null) best = Math.max(best ?? 0, micro);
    } catch {
      // A challenge we cannot read is skipped, not trusted.
    }
  }
  return best;
}

type Ledger = { day: string; micro: number };

const today = () => new Date().toISOString().slice(0, 10);

export class SpendLedger {
  constructor(private readonly file = join(homedir(), '.gliana-ai-mcp', 'spend.json')) {}

  spentToday(): number {
    try {
      const l = JSON.parse(readFileSync(this.file, 'utf8')) as Ledger;
      return l.day === today() ? l.micro : 0;
    } catch {
      return 0;
    }
  }

  record(micro: number): void {
    const next: Ledger = { day: today(), micro: this.spentToday() + micro };
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
      writeFileSync(this.file, JSON.stringify(next));
    } catch (err) {
      // Failing to record must not fail a call that already settled.
      console.error(`could not record spend (${String(err).slice(0, 80)}) — the daily cap may undercount.`);
    }
  }
}

/** Why a call priced at `micro` must not be paid, or null when it may. */
export function refusal(micro: number, caps: Caps, spentToday: number): string | null {
  const usd = (n: number) => `$${(n / 1_000_000).toFixed(4)}`;
  if (caps.perCallMicro !== null && micro > caps.perCallMicro) {
    return `Not paid: this call costs ${usd(micro)}, over your per-call cap of ${usd(caps.perCallMicro)} (GLIANA_MAX_PER_CALL_USD). Nothing was charged.`;
  }
  if (caps.perDayMicro !== null && spentToday + micro > caps.perDayMicro) {
    return `Not paid: ${usd(micro)} on top of ${usd(spentToday)} already spent today would pass your daily cap of ${usd(caps.perDayMicro)} (GLIANA_MAX_PER_DAY_USD). Nothing was charged.`;
  }
  return null;
}

/** Thrown to abort a payment. Carries the message the caller is shown. */
export class CapRefusal extends Error {}

/**
 * An mppx `onChallenge` that enforces the caps on a wallet rail.
 *
 * It THROWS to refuse. Returning `undefined` does not stop mppx: its fetch does
 * `onChallengeCredential ?? (await createCredential())`, so an undefined return
 * falls through to the default and signs the payment anyway (true in 0.6.31 and
 * 0.15.0). 0.8.0 returned undefined here, which paid over-cap calls on wallet
 * rails and then reported "Not paid". A throw rejects mppx.fetch before any
 * credential exists.
 */
export function capOnChallenge(caps: Caps, spentToday: () => number, onQuoted: (micro: number) => void) {
  return async (challenge: { request: unknown }, { createCredential }: { createCredential: () => Promise<string> }) => {
    const micro = challengeMicro(challenge.request as Record<string, unknown>);
    if (caps.perCallMicro !== null || caps.perDayMicro !== null) {
      if (micro === null) throw new CapRefusal('Not paid: could not read the price to check it against your spending caps.');
      const why = refusal(micro, caps, spentToday());
      if (why) throw new CapRefusal(why);
    }
    onQuoted(micro ?? 0);
    return createCredential();
  };
}
