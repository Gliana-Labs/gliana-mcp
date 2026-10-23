import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SpendLedger, capsFromEnv, challengeMicro, parseUsd, priceFromWwwAuthenticate, refusal } from './spend.js';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('parseUsd', () => {
  it('reads dollars into micro-USD', () => {
    expect(parseUsd('1.5')).toBe(1_500_000);
    expect(parseUsd('$0.25')).toBe(250_000);
  });
  it('treats unset, blank, zero, negative and junk as no cap', () => {
    for (const v of [undefined, '', '0', '-1', 'abc']) expect(parseUsd(v)).toBeNull();
  });
});

describe('challengeMicro', () => {
  it('USDC atomic units are micro-USD', () => {
    expect(challengeMicro({ amount: '46800' })).toBe(46_800);
  });
  it('honours decimals (Stripe quotes cents)', () => {
    expect(challengeMicro({ amount: '5', decimals: 2 })).toBe(50_000);
  });
});

describe('priceFromWwwAuthenticate', () => {
  it('takes the highest of several challenges', () => {
    const h =
      `Payment id="a", method="tempo", request="${b64({ amount: '46800' })}", ` +
      `Payment id="b", method="stripe", request="${b64({ amount: '5', decimals: 2 })}"`;
    expect(priceFromWwwAuthenticate(h)).toBe(50_000);
  });
  it('is null when there is nothing to read', () => {
    expect(priceFromWwwAuthenticate(null)).toBeNull();
    expect(priceFromWwwAuthenticate('Payment request="!!!"')).toBeNull();
  });
});

describe('refusal', () => {
  const caps = capsFromEnv({ GLIANA_MAX_PER_CALL_USD: '1', GLIANA_MAX_PER_DAY_USD: '2' });
  it('allows a call inside both caps', () => {
    expect(refusal(500_000, caps, 1_000_000)).toBeNull();
  });
  it('refuses over the per-call cap', () => {
    expect(refusal(1_000_001, caps, 0)).toMatch(/per-call cap/);
  });
  it('refuses when the day total would pass the cap', () => {
    expect(refusal(600_000, caps, 1_500_000)).toMatch(/daily cap/);
  });
  it('no caps configured means nothing is refused', () => {
    expect(refusal(99_000_000, capsFromEnv({}), 99_000_000)).toBeNull();
  });
});

describe('SpendLedger', () => {
  it('accumulates within a day and survives a new instance (a server restart)', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'spend-')), 'nested', 'spend.json');
    new SpendLedger(file).record(300_000);
    new SpendLedger(file).record(200_000);
    expect(new SpendLedger(file).spentToday()).toBe(500_000);
  });
});
