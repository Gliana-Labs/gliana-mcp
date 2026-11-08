/**
 * Saku, started by the agent (2026-11-09). Instead of holding a wallet key that can spend everything in it, the agent
 * asks its user for a budget enforced on NEAR (github.com/Gliana-Labs/gliana-near-x402):
 *
 *   1. `saku_setup` makes a NEAR key for this agent, here, and keeps it in ~/.gliana/saku.json (owner-only). Only
 *      the public half ever leaves this machine, inside the link below.
 *   2. The user opens saku.glianalabs.com/?new&agent_key=…&name=…, sets the limits and the sellers, and confirms one
 *      transaction in their own NEAR wallet. The factory creates `<name>.<factory>` (the allowance, which holds the
 *      Base address and has no key of its own) and `agent-<name>.<factory>`, whose only key is this one and may only
 *      call `pay` on that allowance.
 *   3. `saku_setup` again sees the allowance on chain, notes it in the file, and from the next start the server
 *      pays through it. Opt-in all the way: nothing changes unless the user confirms in their wallet.
 *
 * Precedence on start: keys set in the config > a confirmed saku.json > the self-made wallet (src/wallet.ts).
 * Each payment through it takes ~15-20 s (NEAR's MPC signs), and one the allowance holds waits for the owner.
 */
import { readFileSync, renameSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { KeyPair } from '@near-js/crypto';

export type SakuNetwork = 'mainnet' | 'testnet';
/** The factories (contract/factory in gliana-near-x402). Mainnet's opens after an audit; until then it doesn't answer. */
export const SAKU_FACTORY: Record<SakuNetwork, string> = { testnet: 'saku-factory.testnet', mainnet: 'saku.cocoanutx.near' };
export const SAKU_SITE = 'https://saku.glianalabs.com';

export type SakuFile = {
  version: 1;
  network: SakuNetwork;
  name: string;
  allowance: string;
  agent: string;
  public_key: string;
  private_key: string;
  created: string;
  /** Set once the allowance was seen on chain with this agent: only then does the server pay through it. */
  confirmed?: string;
};

export const sakuPath = (env: NodeJS.ProcessEnv) => env.GLIANA_SAKU_FILE?.trim() || join(homedir(), '.gliana', 'saku.json');

export function readSaku(env: NodeJS.ProcessEnv): SakuFile | null {
  try {
    const f = JSON.parse(readFileSync(sakuPath(env), 'utf8')) as SakuFile;
    return f.agent && f.allowance && f.private_key?.startsWith('ed25519:') ? f : null;
  } catch {
    return null;
  }
}

/** a-z and 0-9 joined by single dashes, 2 to 24 long, not starting with `agent-` (the factory's own rule). */
export function validSakuName(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length >= 2 && name.length <= 24 && !name.startsWith('agent-');
}

export function sakuAccounts(name: string, network: SakuNetwork) {
  const factory = SAKU_FACTORY[network];
  return { factory, allowance: `${name}.${factory}`, agent: `agent-${name}.${factory}` };
}

export function setupLink(f: Pick<SakuFile, 'network' | 'name' | 'public_key'>): string {
  return `${SAKU_SITE}/?new&network=${f.network}&name=${encodeURIComponent(f.name)}&agent_key=${encodeURIComponent(f.public_key)}`;
}

/**
 * Writes the file whole, through a temporary file and a rename, so a crash never leaves half a key. `fresh` refuses
 * to replace an existing file: a key is never overwritten.
 */
export function writeSaku(env: NodeJS.ProcessEnv, f: SakuFile, fresh: boolean) {
  const path = sakuPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (fresh) {
    writeFileSync(path, `${JSON.stringify(f, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } else {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(f, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, path);
  }
  chmodSync(path, 0o600);
}

export function newSaku(name: string, network: SakuNetwork): SakuFile {
  const kp = KeyPair.fromRandom('ed25519');
  return { version: 1, network, name, ...sakuAccounts(name, network), public_key: kp.getPublicKey().toString(), private_key: kp.toString(), created: new Date().toISOString() };
}

/** A NEAR view call, FastNEAR first (fast), the foundation's RPC if it's busy. Throws `missing` for no such account/method. */
export async function nearView<T>(network: SakuNetwork, account: string, method: string, args: object = {}): Promise<T> {
  const urls = [process.env.GLIANA_NEAR_RPC_URL?.trim() || `https://rpc.${network}.fastnear.com`, `https://rpc.${network}.near.org`];
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } });
  let last = 'no NEAR RPC answered';
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        last = `${new URL(url).hostname} HTTP ${res.status}`;
        continue;
      }
      const j = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: { cause?: { name?: string } } };
      const cause = j.error?.cause?.name ?? '';
      if (j.result?.error || /UNKNOWN_ACCOUNT|NO_CONTRACT_CODE|CONTRACT_EXECUTION_ERROR/.test(cause)) throw Object.assign(new Error(String(j.result?.error ?? cause)), { missing: true });
      if (!j.result?.result) {
        last = `${new URL(url).hostname} gave no answer`;
        continue;
      }
      return JSON.parse(Buffer.from(j.result.result).toString('utf8')) as T;
    } catch (e) {
      if ((e as { missing?: boolean }).missing) throw e;
      last = String((e as Error).message ?? e);
    }
  }
  throw new Error(last);
}

/** Has the user made the allowance yet, with this key's account as its agent? */
export async function sakuState(f: SakuFile): Promise<{ state: 'ready'; from: string } | { state: 'pending' } | { state: 'taken'; agent: string }> {
  try {
    const p = await nearView<{ agent: string; from: string }>(f.network, f.allowance, 'get_policy');
    return p.agent === f.agent ? { state: 'ready', from: p.from } : { state: 'taken', agent: p.agent };
  } catch (e) {
    if ((e as { missing?: boolean }).missing) return { state: 'pending' };
    throw e;
  }
}
