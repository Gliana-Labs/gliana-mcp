import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { generatePrivateKey } from 'viem/accounts';
import bs58 from 'bs58';

/**
 * The agent's own wallet (2026-10-29), made the first time the server starts
 * with no wallet key configured — so an agent can pay per call and top up its
 * balance without anyone pasting a private key into a config file.
 *
 * NON-CUSTODIAL: the keys are generated here, stored only in a file on this
 * machine, and never sent anywhere — not to GlianaAI, not in tool output, not
 * in logs. Lose the file and the money in it is gone; that is the trade for
 * nobody else ever holding it.
 *
 * The file (default ~/.gliana/wallet.json, or GLIANA_WALLET_FILE):
 *   - created with exclusive-create, so an existing wallet is NEVER overwritten
 *   - mode 0600 in a 0700 folder: readable by this user only, like an SSH key
 *   - encrypted (scrypt + AES-256-GCM) when GLIANA_PASSPHRASE is set; the same
 *     passphrase is then needed on every start
 *   - addresses stored in the clear, so `wallet` can show them without the secret
 *
 * Two independent keys (an EVM key for Base/Tempo, a Solana key) rather than one
 * seed phrase: there is nothing here for a person to write down, and the file is
 * the backup either way.
 */

export type WalletKeys = { evm: `0x${string}`; solana: string };
type Sealed = { kdf: 'scrypt'; N: number; r: number; p: number; salt: string; iv: string; tag: string; ct: string };
type WalletFile = { version: 1; created: string; addresses?: { evm?: string; solana?: string }; plain?: WalletKeys; sealed?: Sealed };

const SCRYPT = { N: 1 << 15, r: 8, p: 1 };

export function walletPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.GLIANA_WALLET_FILE?.trim() || join(homedir(), '.gliana', 'wallet.json');
}

function seal(keys: WalletKeys, passphrase: string): Sealed {
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32, { ...SCRYPT, maxmem: 64 * 1024 * 1024 });
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(keys), 'utf8'), c.final()]);
  return { kdf: 'scrypt', ...SCRYPT, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function unseal(s: Sealed, passphrase: string): WalletKeys {
  const key = scryptSync(passphrase, Buffer.from(s.salt, 'base64'), 32, { N: s.N, r: s.r, p: s.p, maxmem: 64 * 1024 * 1024 });
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64'));
  d.setAuthTag(Buffer.from(s.tag, 'base64'));
  // A wrong passphrase fails the GCM tag here instead of yielding garbage keys.
  return JSON.parse(Buffer.concat([d.update(Buffer.from(s.ct, 'base64')), d.final()]).toString('utf8')) as WalletKeys;
}

export type LoadedWallet = { keys: WalletKeys; path: string; created: boolean; encrypted: boolean };

/**
 * The agent's wallet: read the file if it exists, else (unless turned off) make
 * one. `addressesOf` is given the new keys so their public addresses can be
 * stored beside them. Returns null with a reason when there is no usable wallet.
 */
export function loadOrCreateWallet(
  env: NodeJS.ProcessEnv,
  addressesOf: (k: WalletKeys) => { evm: string; solana: string },
): { wallet: LoadedWallet } | { none: string } {
  const path = walletPath(env);
  const passphrase = env.GLIANA_PASSPHRASE ?? '';
  let raw: string | null = null;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    raw = null;
  }
  if (raw !== null) {
    let file: WalletFile;
    try {
      file = JSON.parse(raw) as WalletFile;
    } catch {
      return { none: `${path} is not a wallet file — left untouched; no wallet in use.` };
    }
    try {
      const mode = statSync(path).mode & 0o077;
      if (mode) console.error(`${path} is readable by other users — run: chmod 600 ${path}`);
    } catch {
      /* the read worked, so this is only advice */
    }
    if (file.sealed) {
      if (!passphrase) return { none: `${path} is encrypted: set GLIANA_PASSPHRASE to use it.` };
      try {
        return { wallet: { keys: unseal(file.sealed, passphrase), path, created: false, encrypted: true } };
      } catch {
        return { none: `GLIANA_PASSPHRASE does not open ${path} — no wallet in use.` };
      }
    }
    if (file.plain?.evm && file.plain?.solana) return { wallet: { keys: file.plain, path, created: false, encrypted: false } };
    return { none: `${path} holds no keys — left untouched; no wallet in use.` };
  }

  if (['1', 'true', 'yes'].includes((env.GLIANA_NO_AUTO_WALLET ?? '').trim().toLowerCase())) return { none: 'GLIANA_NO_AUTO_WALLET is set: no wallet made.' };

  const keys: WalletKeys = { evm: generatePrivateKey(), solana: bs58.encode(randomBytes(32)) };
  const file: WalletFile = {
    version: 1,
    created: new Date().toISOString(),
    // Written once and never rewritten: a second write is a chance to lose the keys.
    addresses: addressesOf(keys),
    ...(passphrase ? { sealed: seal(keys, passphrase) } : { plain: keys }),
  };
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // 'wx': fails if the file appeared meanwhile — a wallet is never overwritten.
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return loadOrCreateWallet(env, addressesOf);
    return { none: `Could not create ${path} (${String(err).slice(0, 80)}) — no wallet in use.` };
  }
  return { wallet: { keys, path, created: true, encrypted: Boolean(passphrase) } };
}

/** Spending limits for a wallet this server made, when the person set none: $1 a call, $5 a day. */
export const AUTO_WALLET_CAPS = { perCallMicro: 1_000_000, perDayMicro: 5_000_000 };
