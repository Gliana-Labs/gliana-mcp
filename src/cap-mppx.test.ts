/**
 * The cap must stop a wallet payment INSIDE mppx, not just report one.
 *
 * Drives the real mppx client (no mock of the library) against a recorded live
 * 402 from the gateway. A paid retry is the second HTTP request, so "exactly one
 * request" is the proof nothing was signed and sent. 0.8.0 returned undefined
 * from onChallenge, mppx fell through to createCredential, and this test would
 * have seen two requests.
 */
import { readFileSync } from 'node:fs';
import { Mppx, evm, tempo } from 'mppx/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { CapRefusal, capOnChallenge, capsFromEnv } from './spend.js';

const header = readFileSync(new URL('./fixtures/challenge-402.txt', import.meta.url), 'utf8').trim();
const account = privateKeyToAccount(generatePrivateKey());

function fakeGateway() {
  const calls: Array<{ paid: boolean }> = [];
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    const paid = !!(h.get('authorization') || h.get('payment-signature') || h.get('x-payment'));
    calls.push({ paid });
    return paid
      ? new Response('{"ok":true}', { status: 200 })
      : new Response('{"error":"payment_required"}', { status: 402, headers: { 'www-authenticate': header } });
  });
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

for (const [name, method] of [['evm (Base)', evm({ account })], ['tempo', tempo({ account })]] as const) {
  describe(`wallet cap through real mppx — ${name}`, () => {
    it('over the cap: rejects with CapRefusal and sends no payment', async () => {
      const gw = fakeGateway();
      const caps = capsFromEnv({ GLIANA_MAX_PER_CALL_USD: '0.01' }); // price in the fixture is $0.0468
      const mppx = Mppx.create({
        methods: [method] as never,
        polyfill: false,
        fetch: gw.fetch,
        onChallenge: capOnChallenge(caps, () => 0, () => {}) as never,
      });
      await expect(mppx.fetch('https://api.glianalabs.com/v1/infer', { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(
        CapRefusal,
      );
      expect(gw.calls).toEqual([{ paid: false }]);
    });
  });
}

describe('capOnChallenge under the cap', () => {
  it('creates the credential and reports the quoted price', async () => {
    const quoted: number[] = [];
    const createCredential = vi.fn(async () => 'cred');
    const fn = capOnChallenge(capsFromEnv({ GLIANA_MAX_PER_CALL_USD: '1' }), () => 0, (m) => quoted.push(m));
    await expect(fn({ request: { amount: '46800' } }, { createCredential })).resolves.toBe('cred');
    expect(createCredential).toHaveBeenCalledOnce();
    expect(quoted).toEqual([46_800]);
  });

  it('with no caps configured, never refuses', async () => {
    const createCredential = vi.fn(async () => 'cred');
    const fn = capOnChallenge(capsFromEnv({}), () => 0, () => {});
    await expect(fn({ request: { amount: '99000000' } }, { createCredential })).resolves.toBe('cred');
  });
});
