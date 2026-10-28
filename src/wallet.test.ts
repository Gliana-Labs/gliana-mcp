import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519';
import { createKeyPairSignerFromPrivateKeyBytes } from '@solana/kit';
import { loadOrCreateWallet } from './wallet.js';

const addressesOf = (k: { evm: `0x${string}`; solana: string }) => ({
  evm: privateKeyToAccount(k.evm).address,
  solana: bs58.encode(ed25519.getPublicKey(bs58.decode(k.solana))),
});
const fresh = () => join(mkdtempSync(join(tmpdir(), 'gliana-wallet-')), 'sub', 'wallet.json');

describe('the agent wallet file', () => {
  it('is made once, owner-only, and the same keys come back on the next start', () => {
    const path = fresh();
    const a = loadOrCreateWallet({ GLIANA_WALLET_FILE: path }, addressesOf);
    if (!('wallet' in a)) throw new Error(a.none);
    expect(a.wallet.created).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
    const b = loadOrCreateWallet({ GLIANA_WALLET_FILE: path }, addressesOf);
    if (!('wallet' in b)) throw new Error(b.none);
    expect(b.wallet.created).toBe(false);
    expect(b.wallet.keys).toEqual(a.wallet.keys);
    const file = JSON.parse(readFileSync(path, 'utf8'));
    expect(file.addresses).toEqual(addressesOf(a.wallet.keys));
  });

  it('with a passphrase, holds no key in the clear and needs the passphrase to open', () => {
    const path = fresh();
    const a = loadOrCreateWallet({ GLIANA_WALLET_FILE: path, GLIANA_PASSPHRASE: 'kuda lumping 7' }, addressesOf);
    if (!('wallet' in a)) throw new Error(a.none);
    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain(a.wallet.keys.evm.slice(2));
    expect(text).not.toContain(a.wallet.keys.solana);
    expect(loadOrCreateWallet({ GLIANA_WALLET_FILE: path }, addressesOf)).toEqual({ none: expect.stringMatching(/encrypted: set GLIANA_PASSPHRASE/) });
    expect(loadOrCreateWallet({ GLIANA_WALLET_FILE: path, GLIANA_PASSPHRASE: 'wrong' }, addressesOf)).toEqual({ none: expect.stringMatching(/does not open/) });
    const b = loadOrCreateWallet({ GLIANA_WALLET_FILE: path, GLIANA_PASSPHRASE: 'kuda lumping 7' }, addressesOf);
    expect('wallet' in b && b.wallet.keys).toEqual(a.wallet.keys);
  });

  it('never overwrites a file that is there, even one it cannot read', () => {
    const path = fresh();
    loadOrCreateWallet({ GLIANA_WALLET_FILE: path, GLIANA_NO_AUTO_WALLET: '' }, addressesOf);
    writeFileSync(path, 'not json');
    expect(loadOrCreateWallet({ GLIANA_WALLET_FILE: path }, addressesOf)).toEqual({ none: expect.stringMatching(/left untouched/) });
    expect(readFileSync(path, 'utf8')).toBe('not json');
  });

  it('the Solana address shown is the one the payment signer uses', async () => {
    const path = fresh();
    const a = loadOrCreateWallet({ GLIANA_WALLET_FILE: path }, addressesOf);
    if (!('wallet' in a)) throw new Error(a.none);
    const signer = await createKeyPairSignerFromPrivateKeyBytes(bs58.decode(a.wallet.keys.solana));
    expect(signer.address).toBe(addressesOf(a.wallet.keys).solana);
  });

  it('makes nothing when turned off', () => {
    const path = fresh();
    expect(loadOrCreateWallet({ GLIANA_WALLET_FILE: path, GLIANA_NO_AUTO_WALLET: '1' }, addressesOf)).toEqual({ none: expect.stringMatching(/no wallet made/) });
    expect(() => statSync(path)).toThrow();
  });
});
