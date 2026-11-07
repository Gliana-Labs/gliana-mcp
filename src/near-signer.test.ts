import { describe, expect, it } from 'vitest';
import { waitForOwner } from './near-signer.js';

const SIG = { big_r: { affine_point: '02aa' }, s: { scalar: 'bb' }, recovery_id: 0 };
const noWait = async () => undefined;

describe('a payment held for the owner', () => {
  it('waits, then hands back the signature once they approve', async () => {
    const answers = [{ status: 'waiting', signature: null }, { status: 'signing', signature: null }, { status: 'signed', signature: JSON.stringify(SIG) }];
    let n = 0;
    expect(await waitForOwner(async () => answers[n++], '3', 'a.near', 1000, () => 0, noWait)).toEqual(SIG);
    expect(n).toBe(3);
  });
  it('says so when the owner rejects it', async () => {
    await expect(waitForOwner(async () => ({ status: 'rejected', signature: null }), '3', 'a.near', 1000, () => 0, noWait)).rejects.toThrow(/rejected payment 3/);
  });
  it('gives up in time, saying nothing was paid and where the owner can look', async () => {
    let t = 0;
    await expect(waitForOwner(async () => ({ status: 'waiting', signature: null }), '3', 'a.near', 10, () => (t += 4), noWait)).rejects.toThrow(/Nothing was paid.*contract=a\.near/);
  });
});
