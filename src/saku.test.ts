import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newSaku, readSaku, sakuAccounts, setupLink, validSakuName, writeSaku } from './saku.js';

const env = () => ({ GLIANA_SAKU_FILE: join(mkdtempSync(join(tmpdir(), 'saku-')), 'saku.json') }) as NodeJS.ProcessEnv;

describe('saku setup started by the agent', () => {
  it('names follow the factory: no agent- prefix, single dashes, 2-24', () => {
    for (const ok of ['ab', 'my-agent', 'bot-x1y2z']) expect(validSakuName(ok), ok).toBe(true);
    for (const bad of ['a', 'agent-x', 'My', 'a--b', '-a', 'a_b', 'x'.repeat(25)]) expect(validSakuName(bad), bad).toBe(false);
  });

  it('the agent account is agent-<name> under the factory', () => {
    expect(sakuAccounts('shop', 'testnet')).toEqual({ factory: 'saku-factory.testnet', allowance: 'shop.saku-factory.testnet', agent: 'agent-shop.saku-factory.testnet' });
  });

  it('the link carries the public key and never the private one', () => {
    const f = newSaku('shop', 'testnet');
    const link = setupLink(f);
    expect(f.private_key.startsWith('ed25519:')).toBe(true);
    expect(link).toContain(encodeURIComponent(f.public_key));
    expect(link).not.toContain(f.private_key.slice(8, 30));
    expect(link.startsWith('https://saku.glianalabs.com/?new&network=testnet&name=shop&agent_key=ed25519')).toBe(true);
  });

  it('writes the key owner-only and never overwrites one', () => {
    const e = env();
    const f = newSaku('shop', 'testnet');
    writeSaku(e, f, true);
    expect(statSync(e.GLIANA_SAKU_FILE!).mode & 0o777).toBe(0o600);
    expect(() => writeSaku(e, newSaku('other', 'testnet'), true)).toThrow();
    expect(readSaku(e)?.private_key).toBe(f.private_key);
    writeSaku(e, { ...f, confirmed: 'now' }, false);
    const back = JSON.parse(readFileSync(e.GLIANA_SAKU_FILE!, 'utf8'));
    expect([back.private_key, back.confirmed]).toEqual([f.private_key, 'now']);
  });
});
