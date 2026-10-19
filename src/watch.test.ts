import { describe, it, expect, vi } from 'vitest';
import { parseArgs, quoteFromChallenge, runWatch, type WatchDeps } from './watch.ts';

/**
 * The budget cap is the only thing standing between this command and an
 * unbounded spend loop, so it is tested against the actual loop rather than by
 * reading the condition. Nothing here touches the network or a wallet.
 */
const API = 'https://api.example.test';
const PRICE_MICRO = 2000; // $0.002, our cheapest real tool price

const challenge = (micro = PRICE_MICRO) => ({
  x402Version: 1,
  accepts: [
    { scheme: 'exact', network: 'base', maxAmountRequired: String(micro) },
    { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', maxAmountRequired: String(micro) },
  ],
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function deps(over: Partial<WatchDeps> = {}): WatchDeps {
  return {
    api: API,
    evmAccount: {},
    solanaSigner: null,
    fetchImpl: vi.fn(async () => json(challenge(), 402)) as never,
    payingFetchImpl: vi.fn(async () => json({ price: 1 })) as never,
    sleepImpl: async () => {},
    ...over,
  };
}

const quiet = () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  return () => {
    log.mockRestore();
    err.mockRestore();
  };
};

describe('parseArgs', () => {
  it('refuses to run without a spend ceiling', () => {
    expect(parseArgs(['--tool', 'token-price'])).toEqual({ error: expect.stringContaining('--budget') });
  });

  it('refuses a zero, negative or junk budget', () => {
    for (const b of ['0', '-1', 'abc', 'Infinity']) {
      expect(parseArgs(['--tool', 't', '--budget', b])).toHaveProperty('error');
    }
  });

  it('refuses an interval tight enough to be a hot loop', () => {
    expect(parseArgs(['--tool', 't', '--budget', '1', '--every', '4'])).toHaveProperty('error');
    expect(parseArgs(['--tool', 't', '--budget', '1', '--every', '5'])).not.toHaveProperty('error');
  });

  it('needs a tool, and rejects unknown flags rather than ignoring them', () => {
    expect(parseArgs(['--budget', '1'])).toHaveProperty('error');
    expect(parseArgs(['--tool', 't', '--budget', '1', '--yolo'])).toEqual({ error: expect.stringContaining('--yolo') });
  });

  it('lets --list and --help through with no other argument', () => {
    expect(parseArgs(['--list'])).toMatchObject({ list: true });
    expect(parseArgs(['--help'])).toMatchObject({ help: true });
  });
});

describe('quoteFromChallenge', () => {
  it('reads the price out of a live 402', () => {
    expect(quoteFromChallenge(challenge())).toMatchObject({ micro: PRICE_MICRO });
  });

  it('takes the MAX across options, so a mixed-price challenge cannot underestimate the spend', () => {
    const mixed = { accepts: [{ network: 'base', maxAmountRequired: '2000' }, { network: 'solana', maxAmountRequired: '9000' }] };
    expect(quoteFromChallenge(mixed)!.micro).toBe(9000);
  });

  it('returns null for anything it cannot price, so the caller refuses to start', () => {
    for (const bad of [null, {}, { accepts: [] }, { accepts: [{ network: 'base' }] }, { accepts: [{ maxAmountRequired: '0' }] }]) {
      expect(quoteFromChallenge(bad)).toBeNull();
    }
  });
});

describe('the spend loop', () => {
  it('stops at the budget instead of at a call count', async () => {
    const restore = quiet();
    const d = deps();
    // $0.01 budget at $0.002 a call = exactly 5 calls, and then it must stop.
    const code = await runWatch(['--tool', 'token-price', '--budget', '0.01', '--every', '5'], d);
    restore();
    expect(code).toBe(0);
    expect(d.payingFetchImpl).toHaveBeenCalledTimes(5);
  });

  it('never starts a call the remaining budget cannot cover', async () => {
    const restore = quiet();
    const d = deps();
    // $0.003 affords ONE $0.002 call; the second would exceed, so it must not fire.
    await runWatch(['--tool', 'token-price', '--budget', '0.003'], d);
    restore();
    expect(d.payingFetchImpl).toHaveBeenCalledTimes(1);
  });

  it('honours --max below the budget', async () => {
    const restore = quiet();
    const d = deps();
    await runWatch(['--tool', 'token-price', '--budget', '10', '--max', '3'], d);
    restore();
    expect(d.payingFetchImpl).toHaveBeenCalledTimes(3);
  });

  it('counts a throw as spent and does NOT retry it — paying twice for one answer is worse', async () => {
    const restore = quiet();
    const paying = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue(json({ price: 1 }));
    const d = deps({ payingFetchImpl: paying as never });
    await runWatch(['--tool', 'token-price', '--budget', '0.006'], d);
    restore();
    // 3 attempts at $0.002 exhausts $0.006 — the failed one consumed budget
    // exactly like a successful one, and was not re-attempted.
    expect(paying).toHaveBeenCalledTimes(3);
  });

  it('stops dead on a 400 instead of re-sending a body already refused', async () => {
    const restore = quiet();
    // The first version re-sent a malformed input every tick, forever, free.
    const paying = vi.fn(async () => json({ error: 'missing_input', detail: 'Required: { symbols }' }, 400));
    const d = deps({ payingFetchImpl: paying as never });
    const code = await runWatch(['--tool', 'token-price', '--budget', '10'], d);
    restore();
    expect(code).toBe(2);
    expect(paying).toHaveBeenCalledTimes(1);
  });

  it('does not charge for a handler error', async () => {
    const restore = quiet();
    const paying = vi
      .fn()
      .mockResolvedValueOnce(json({ error: 'upstream' }, 503))
      .mockResolvedValue(json({ price: 1 }));
    const d = deps({ payingFetchImpl: paying as never });
    await runWatch(['--tool', 'token-price', '--budget', '0.004'], d);
    restore();
    // A 503 settles nothing, so the budget still bought two paid calls after
    // it: 1 free failure + 2 charged = 3 attempts.
    expect(paying).toHaveBeenCalledTimes(3);
  });

  it('gives up after 5 transient failures with nothing succeeding, rather than spinning', async () => {
    const restore = quiet();
    const paying = vi.fn(async () => json({ error: 'upstream' }, 503));
    const d = deps({ payingFetchImpl: paying as never });
    const code = await runWatch(['--tool', 'token-price', '--budget', '10'], d);
    restore();
    expect(code).toBe(1);
    expect(paying).toHaveBeenCalledTimes(5);
  });

  it('bails out instead of spinning when the wallet is unfunded (402 after paying)', async () => {
    const restore = quiet();
    const paying = vi.fn(async () => json(challenge(), 402));
    const d = deps({ payingFetchImpl: paying as never });
    const code = await runWatch(['--tool', 'token-price', '--budget', '10'], d);
    restore();
    expect(code).toBe(1);
    expect(paying).toHaveBeenCalledTimes(1);
  });

  it('refuses to start when the resource does not quote a 402', async () => {
    const restore = quiet();
    for (const [status, expected] of [[404, 2], [200, 2]] as const) {
      const d = deps({ fetchImpl: vi.fn(async () => json({}, status)) as never });
      expect(await runWatch(['--tool', 'token-price', '--budget', '1'], d)).toBe(expected);
      expect(d.payingFetchImpl).not.toHaveBeenCalled();
    }
    restore();
  });

  it('dry-run reads the live quote, pays nothing, and needs no wallet', async () => {
    const restore = quiet();
    const d = deps({ evmAccount: null, solanaSigner: null });
    const code = await runWatch(['--tool', 'token-price', '--budget', '0.5', '--dry-run'], d);
    restore();
    expect(code).toBe(0);
    expect(d.payingFetchImpl).not.toHaveBeenCalled();
  });

  it('respects a price INCREASE seen in the challenge, rather than the price it started with', async () => {
    const restore = quiet();
    // Quoted at $0.005, not the $0.002 default: a $0.01 budget buys 2, not 5.
    const d = deps({ fetchImpl: vi.fn(async () => json(challenge(5000), 402)) as never });
    await runWatch(['--tool', 'token-price', '--budget', '0.01'], d);
    restore();
    expect(d.payingFetchImpl).toHaveBeenCalledTimes(2);
  });
});
