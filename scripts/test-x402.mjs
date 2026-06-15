#!/usr/bin/env node
/**
 * End-to-end NATIVE x402 paid test: pays a /x402/<model> resource using the
 * @x402 client (matching our @x402/hono server — the challenge is in the
 * `payment-required` header, which Coinbase's x402-fetch does NOT read). This
 * exercises the @x402/hono paywall + facilitator settlement — a different path
 * than the MPP /v1/infer test (test-generate.mjs).
 *
 *   cd gliana-mcp && npm install
 *   # Base USDC:
 *   GLIANA_WALLET_KEY=0xYOURKEY node scripts/test-x402.mjs
 *   # Solana USDC (reuse the same wallet as test-generate):
 *   GLIANA_SOLANA_KEY=YOURBASE58KEY node scripts/test-x402.mjs
 *   # other model:  MODEL=nano-banana-2 INPUT='{"prompt":"a red fox"}' GLIANA_WALLET_KEY=0x.. node scripts/test-x402.mjs
 *
 * Key never leaves this process. Uses the cheapest model (tts-1) by default.
 */
import { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes } from '@solana/kit';
import bs58 from 'bs58';

const API = (process.env.GLIANA_API_URL || 'https://api.glianalabs.com').replace(/\/+$/, '');
const EVM_NET = 'eip155:8453'; // Base
const SVM_NET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'; // Solana mainnet (CAIP-2, truncated)

const model = process.env.MODEL || 'tts-1';
const input = process.env.INPUT ? JSON.parse(process.env.INPUT) : { text: 'Hello from GlianaAI over native x402.' };

const client = new x402Client();
const rails = [];

const evmKey = process.env.GLIANA_WALLET_KEY?.trim();
if (evmKey) {
  client.register(EVM_NET, new ExactEvmScheme(privateKeyToAccount(evmKey.startsWith('0x') ? evmKey : `0x${evmKey}`)));
  rails.push('base');
}

const solKey = process.env.GLIANA_SOLANA_KEY?.trim();
if (solKey) {
  const bytes = solKey.startsWith('[') ? Uint8Array.from(JSON.parse(solKey)) : bs58.decode(solKey);
  const signer = bytes.length === 64 ? await createKeyPairSignerFromBytes(bytes) : await createKeyPairSignerFromPrivateKeyBytes(bytes);
  client.register(SVM_NET, new ExactSvmScheme(signer));
  rails.push('solana');
}

if (rails.length === 0) {
  console.error('Set GLIANA_WALLET_KEY (Base USDC) and/or GLIANA_SOLANA_KEY (Solana USDC).');
  process.exit(1);
}

const fetchWithPay = wrapFetchWithPayment(fetch, client);
console.error(`Paying via native x402 (${rails.join('/')}) → POST ${API}/x402/${model}…`);

const res = await fetchWithPay(`${API}/x402/${model}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(input),
});
const text = await res.text();
console.error(`HTTP ${res.status}`);

if (res.ok) {
  const j = JSON.parse(text);
  console.log(`\n✅ PAID via NATIVE x402 — charged $${(j.costMicroUsd / 1e6).toFixed(6)}`);
  console.log('output:', JSON.stringify(j.output, null, 2));
  const pr = res.headers.get('payment-response');
  if (pr) {
    try {
      console.log('settlement:', JSON.stringify(decodePaymentResponseHeader(pr)));
    } catch {
      /* ignore */
    }
  }
} else {
  console.log(`\n❌ ${text}`);
  process.exit(1);
}
