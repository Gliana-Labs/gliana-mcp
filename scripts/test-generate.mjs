#!/usr/bin/env node
/**
 * End-to-end paid test: pays the gateway's 402 from your wallet and runs a model.
 * Uses the CHEAPEST model (tts-1, ~$0.001) so the test costs a fraction of a cent.
 *
 *   cd gliana-mcp && npm install
 *   GLIANA_WALLET_KEY=0xYOURKEY node scripts/test-generate.mjs
 *
 * Rails: base (default) / tempo via GLIANA_WALLET_KEY; solana via GLIANA_SOLANA_KEY.
 * The key never leaves this process — same model as the MCP `generate` tool.
 */
import { Mppx, evm, tempo } from 'mppx/client';
import { solana } from '@solana/mpp/client';
import { privateKeyToAccount } from 'viem/accounts';
import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes } from '@solana/kit';
import bs58 from 'bs58';

const API = (process.env.GLIANA_API_URL || 'https://api.glianalabs.com').replace(/\/+$/, '');
const RAIL = (process.env.GLIANA_RAIL || (process.env.GLIANA_SOLANA_KEY ? 'solana' : 'base')).toLowerCase();

async function buildMethod() {
  if (RAIL === 'solana') {
    const key = process.env.GLIANA_SOLANA_KEY;
    if (!key) throw new Error('GLIANA_RAIL=solana needs GLIANA_SOLANA_KEY');
    const bytes = key.startsWith('[') ? Uint8Array.from(JSON.parse(key)) : bs58.decode(key);
    const signer = bytes.length === 64 ? await createKeyPairSignerFromBytes(bytes) : await createKeyPairSignerFromPrivateKeyBytes(bytes);
    return solana.charge({ signer });
  }
  const key = process.env.GLIANA_WALLET_KEY;
  if (!key) throw new Error(`GLIANA_RAIL=${RAIL} needs GLIANA_WALLET_KEY (a 0x key holding USDC on ${RAIL})`);
  const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);
  return RAIL === 'tempo' ? tempo({ account }) : evm({ account });
}

const method = await buildMethod();
const body = JSON.stringify({ model: 'tts-1', text: 'Hello from GlianaAI — the paid loop works.' });
console.error(`Paying via ${RAIL} → POST ${API}/v1/infer (model tts-1, ~$0.001)…`);

const run = () => Mppx.create({ methods: [method], polyfill: false })
  .fetch(`${API}/v1/infer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

let res = await run();
if (res.status === 402) res = await run(); // retry once with a fresh challenge

const text = await res.text();
console.error(`HTTP ${res.status}`);
if (res.ok) {
  const j = JSON.parse(text);
  console.log(`\n✅ PAID + GENERATED — charged $${(j.costMicroUsd / 1e6).toFixed(6)} via ${RAIL}`);
  console.log('output:', JSON.stringify(j.output, null, 2));
} else {
  console.log(`\n❌ ${text}`);
  if (res.status === 402) console.log('Payment did not settle — check the wallet holds USDC on', RAIL);
  process.exit(1);
}
