import { describe, it, expect, vi } from 'vitest';
import { hashTypedData } from 'viem';
import {
  selectAccept,
  authorizationDigest,
  toSignature,
  buildAuthorization,
  paymentHeader,
  randomNonce,
  payWithNear,
  deriveEvmAddress,
  SIGNER_CONTRACT,
  rsvFromMpc,
  signArgs,
  SIGN_GAS,
  SIGN_DEPOSIT,
  type Accept,
} from './near.ts';

/**
 * These cover everything between the 402 and the signature, which is all of
 * it except the one call that costs gas. The signer is injected so the whole
 * path runs without a NEAR account.
 *
 * Verified against production on 2026-10-20: a payment built by payWithNear
 * with a structurally valid but fake {r,s,v} is rejected by the facilitator
 * with "invalid_exact_evm_payload_signature: invalid signature: not for a
 * valid curve point" — i.e. it parsed the payload, matched scheme and
 * network, and got as far as recovering the key. Everything these tests cover
 * is the part that already works live.
 */
const ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x7662E00f8Ab4C362166e1FF649Ff6c2A638c80AD';
const FROM = '0x000000000000000000000000000000000000dEaD' as const;

const base: Accept = {
  scheme: 'exact',
  network: 'base',
  maxAmountRequired: '2000',
  payTo: PAY_TO,
  asset: ASSET,
  maxTimeoutSeconds: 900,
  extra: { name: 'USD Coin', version: '2' },
};
const solana: Accept = {
  scheme: 'exact',
  network: 'solana',
  maxAmountRequired: '2000',
  payTo: 'CXSdm7NgrFXooHbvN6CdNgMvmqTkVLzu6JCVZR3J3Ygh',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  extra: { name: 'USD Coin' },
};

const sig = { r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}`, v: 0 } as const;

describe('selectAccept', () => {
  it('takes the EVM option even when Solana is offered first', () => {
    expect(selectAccept({ accepts: [solana, base] })?.network).toBe('base');
  });

  it('refuses Solana alone — its exact scheme is not an EIP-712 digest', () => {
    expect(selectAccept({ accepts: [solana] })).toBeNull();
  });

  it('refuses a non-exact scheme and a malformed address', () => {
    expect(selectAccept({ accepts: [{ ...base, scheme: 'upto' }] })).toBeNull();
    expect(selectAccept({ accepts: [{ ...base, payTo: 'not-an-address' }] })).toBeNull();
    expect(selectAccept({ accepts: [] })).toBeNull();
  });
});

describe('authorizationDigest', () => {
  const auth = {
    from: FROM,
    to: PAY_TO as `0x${string}`,
    value: '2000',
    validAfter: '0',
    validBefore: '9999999999',
    nonce: `0x${'ab'.repeat(32)}` as `0x${string}`,
  };

  it('matches the EIP-3009 digest viem produces independently', () => {
    const ref = hashTypedData({
      domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: ASSET },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: { from: auth.from, to: auth.to, value: 2000n, validAfter: 0n, validBefore: 9999999999n, nonce: auth.nonce },
    });
    expect(authorizationDigest(base, auth)).toBe(ref);
  });

  it('uses the domain from the CHALLENGE, not a table here', () => {
    // A domain that disagrees with the token contract recovers the wrong
    // address and is rejected at verify with no useful error, so the server's
    // own `extra` has to win.
    const odd = authorizationDigest({ ...base, extra: { name: 'Other Coin', version: '7' } }, auth);
    expect(odd).not.toBe(authorizationDigest(base, auth));
  });

  it('refuses a network it has no chain id for', () => {
    expect(() => authorizationDigest({ ...base, network: 'moonbase' }, auth)).toThrow(/chain id/i);
  });
});

describe('toSignature', () => {
  it('normalises a recovery id of 0/1 to 27/28', () => {
    expect(toSignature({ ...sig, v: 0 }).endsWith('1b')).toBe(true);
    expect(toSignature({ ...sig, v: 1 }).endsWith('1c')).toBe(true);
    expect(toSignature({ ...sig, v: 27 }).endsWith('1b')).toBe(true);
    expect(toSignature({ ...sig, v: 28 }).endsWith('1c')).toBe(true);
  });

  it('produces exactly 65 bytes', () => {
    expect(toSignature(sig)).toHaveLength(2 + 130);
  });

  it('left-pads a short r or s rather than shifting every later byte', () => {
    const s = toSignature({ r: '0xab', s: '0xcd', v: 1 });
    expect(s).toHaveLength(2 + 130);
    expect(s.slice(2, 66)).toBe('ab'.padStart(64, '0'));
  });

  it('rejects a recovery id it cannot use instead of signing garbage', () => {
    expect(() => toSignature({ ...sig, v: 5 })).toThrow(/recovery id/i);
  });
});

describe('buildAuthorization', () => {
  const now = 1_800_000_000_000;

  it('backdates validAfter, because facilitators compare against their own clock', () => {
    const a = buildAuthorization(base, FROM, now);
    expect(Number(a.validAfter)).toBe(now / 1000 - 60);
  });

  it('honours the resource maxTimeoutSeconds for the window', () => {
    expect(Number(buildAuthorization(base, FROM, now).validBefore)).toBe(now / 1000 + 900);
    expect(Number(buildAuthorization({ ...base, maxTimeoutSeconds: undefined }, FROM, now).validBefore)).toBe(now / 1000 + 600);
  });

  it('authorises exactly what was quoted, never more', () => {
    expect(buildAuthorization(base, FROM, now).value).toBe('2000');
  });

  it('never repeats a nonce — a reused one makes the second payment unredeemable', () => {
    const seen = new Set(Array.from({ length: 200 }, () => randomNonce()));
    expect(seen.size).toBe(200);
    expect([...seen].every((n) => /^0x[0-9a-f]{64}$/.test(n))).toBe(true);
  });
});

describe('paymentHeader', () => {
  it('echoes the network back exactly as the server named it', () => {
    const auth = buildAuthorization(base, FROM, 1_800_000_000_000);
    const decoded = JSON.parse(atob(paymentHeader(base, auth, toSignature(sig))));
    expect(decoded).toMatchObject({ x402Version: 1, scheme: 'exact', network: 'base' });
    expect(decoded.payload.authorization.from).toBe(FROM);
    expect(decoded.payload.signature).toHaveLength(132);
  });
});

describe('payWithNear', () => {
  const challenge = (accepts: Accept[]) =>
    new Response(JSON.stringify({ x402Version: 1, accepts }), { status: 402, headers: { 'content-type': 'application/json' } });

  it('probes, signs once, and retries with the header', async () => {
    const sign = vi.fn(async () => sig);
    const calls: RequestInit[] = [];
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      calls.push(init!);
      return calls.length === 1 ? challenge([base]) : new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const r = await payWithNear({ url: 'https://api.test/x402/tools/token-price', from: FROM, sign, fetchImpl: f as never });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(2);
    expect((calls[1].headers as Record<string, string>)['X-PAYMENT']).toBeTruthy();
    expect(r.status).toBe(200);
    expect(r.chargedMicroUsd).toBe(2000);
  });

  it('charges nothing in its own ledger when the paid call fails', async () => {
    const f = vi.fn(async () => challenge([base])); // still 402 after paying
    const r = await payWithNear({ url: 'https://api.test/x', from: FROM, sign: async () => sig, fetchImpl: f as never });
    expect(r.chargedMicroUsd).toBe(0);
  });

  it('does not pay for something that was never priced', async () => {
    const sign = vi.fn(async () => sig);
    const f = vi.fn(async () => new Response(JSON.stringify({ free: true }), { status: 200 }));
    const r = await payWithNear({ url: 'https://api.test/x', from: FROM, sign, fetchImpl: f as never });
    expect(sign).not.toHaveBeenCalled();
    expect(r.status).toBe(200);
    expect(r.chargedMicroUsd).toBe(0);
  });

  it('says why when only Solana is offered, instead of signing the wrong thing', async () => {
    const f = vi.fn(async () => challenge([solana]));
    await expect(
      payWithNear({ url: 'https://api.test/x', from: FROM, sign: async () => sig, fetchImpl: f as never }),
    ).rejects.toThrow(/EVM "exact"/);
  });

  it('returns the digest, so a caller can reconcile a call it is unsure about', async () => {
    const f = vi.fn(async (_u: unknown, init?: RequestInit) =>
      (init?.headers as Record<string, string>)?.['X-PAYMENT']
        ? new Response('{}', { status: 200 })
        : challenge([base]),
    );
    const r = await payWithNear({ url: 'https://api.test/x', from: FROM, sign: async () => sig, fetchImpl: f as never });
    expect(r.digest).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('deriveEvmAddress', () => {
  /**
   * Checked against chainsig.js's own deriveChildPublicKey on 2026-10-20.
   * These three addresses came out of the official SDK; this package computes
   * them with @noble alone, avoiding chainsig.js's bitcoin/cosmos/sui/xrpl/
   * aptos/solana bundle. If a refactor breaks the derivation, it breaks here
   * rather than by sending money to an address nobody controls.
   */
  it.each([
    ['example.near', 'ethereum-1', '0xEF4Ea05e5c11057DeCC8E1bd6F5369f2acD91fA5'],
    ['example.near', 'ethereum-2', '0x273EeB4d7651d9296ec5bD9A6cEeBCa219101cb8'],
    ['glianalabs.near', 'gliana-x402', '0xf0dA966094f7FB5a0De3348657620019c2e477d4'],
  ])('matches chainsig.js for %s on path %s', async (acct, path, want) => {
    expect(await deriveEvmAddress(acct, path, 'mainnet')).toBe(want);
  });

  it('is deterministic — the same inputs always give the same address', async () => {
    const a = await deriveEvmAddress('glianalabs.near', 'gliana-x402');
    const b = await deriveEvmAddress('glianalabs.near', 'gliana-x402');
    expect(a).toBe(b);
  });

  it('gives a DIFFERENT address per path, which is why a path must not drift', async () => {
    const a = await deriveEvmAddress('glianalabs.near', 'gliana-x402');
    const b = await deriveEvmAddress('glianalabs.near', 'gliana-x402-v2');
    expect(a).not.toBe(b);
  });

  it('gives a different address per account', async () => {
    expect(await deriveEvmAddress('a.near', 'p')).not.toBe(await deriveEvmAddress('b.near', 'p'));
  });

  it('separates mainnet and testnet — different MPC root keys', async () => {
    const m = await deriveEvmAddress('example.near', 'ethereum-1', 'mainnet');
    const t = await deriveEvmAddress('example.near', 'ethereum-1', 'testnet');
    expect(m).not.toBe(t);
  });

  it('returns a checksummed address', async () => {
    const a = await deriveEvmAddress('example.near', 'ethereum-1');
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(a).not.toBe(a.toLowerCase()); // EIP-55 mixed case
  });

  it('names the right signer contract per network', () => {
    expect(SIGNER_CONTRACT.mainnet).toBe('v1.signer');
    expect(SIGNER_CONTRACT.testnet).toBe('v1.signer-prod.testnet');
  });
});

describe('rsvFromMpc — against a real v1.signer reply', () => {
  /**
   * Captured verbatim from v1.signer-prod.testnet on 2026-10-20, signing the
   * EIP-712 digest of a real $0.002 token-price challenge as
   * gliana-x402.testnet on path "gliana-x402". The MPC call took 15.2s.
   *
   * This fixture is the end-to-end proof: the signature the MPC produced
   * recovers to the very address deriveEvmAddress computes offline. If either
   * half ever drifts, this fails.
   */
  const MPC = {
    scheme: 'Secp256k1',
    big_r: { affine_point: '03e09c880963b5cd2153642f6f10301aec9a1bceb0783b6f33fe9d7e74b5740c95' },
    s: { scalar: '141d56e2d36a97f9c675a841b44695c7966c937d2f09f1d87f4bcbec774a51d6' },
    recovery_id: 0,
  };
  const DIGEST = '0xd53967c2206eed8332557328bf85739de29d9bafcac5917e96190a8fc57f07f8' as const;

  it('recovers to the address derived offline for that account and path', async () => {
    const { recoverAddress } = await import('viem');
    const recovered = await recoverAddress({ hash: DIGEST, signature: toSignature(rsvFromMpc(MPC)) });
    expect(recovered).toBe(await deriveEvmAddress('gliana-x402.testnet', 'gliana-x402', 'testnet'));
  });

  it('drops the compressed-point prefix — r is x, not the whole 33 bytes', () => {
    const { r } = rsvFromMpc(MPC);
    expect(r).toBe('0xe09c880963b5cd2153642f6f10301aec9a1bceb0783b6f33fe9d7e74b5740c95');
    expect(r).toHaveLength(66);
  });

  it('keeping the prefix byte recovers a DIFFERENT address — the trap', async () => {
    const { recoverAddress } = await import('viem');
    const wrong = toSignature({ r: `0x${MPC.big_r.affine_point.slice(0, 64)}`, s: `0x${MPC.s.scalar}`, v: 0 });
    const got = await recoverAddress({ hash: DIGEST, signature: wrong }).catch(() => '0xfailed');
    expect(got).not.toBe(await deriveEvmAddress('gliana-x402.testnet', 'gliana-x402', 'testnet'));
  });

  it('builds sign args on the secp256k1 domain, unprefixed', () => {
    const a = signArgs(DIGEST, 'gliana-x402');
    expect(a.request.payload_v2.Ecdsa).toBe(DIGEST.slice(2));
    expect(a.request.domain_id).toBe(0);
    expect(a.request.path).toBe('gliana-x402');
  });

  it('attaches the max gas a call may carry', () => {
    expect(SIGN_GAS).toBe(300_000_000_000_000n);
    expect(SIGN_DEPOSIT).toBe(1n);
  });
});
