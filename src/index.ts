#!/usr/bin/env node
/**
 * GlianaAI MCP server — exposes pay-per-call generative AI (59 models: image,
 * video, music, speech) to any MCP client (Claude Desktop, Cursor, …).
 *
 * Discovery tools (list_models / get_price / get_schema) are free. `generate`
 * runs a model and settles the gateway's 402 from YOUR wallet via mppx. One
 * /v1/infer challenge offers Tempo, Base (USDC), and Solana (USDC); the MCP pays
 * whichever rail you've configured. Keys are read from the client config and
 * never leave this process — non-custodial, same model as ai.glianalabs.com.
 *
 * Config (env):
 *   GLIANA_WALLET_KEY  0x EVM private key — enables `base` and `tempo`.
 *   GLIANA_SOLANA_KEY  Solana secret key (base58 or JSON array) — enables `solana`.
 *   GLIANA_RAIL        base | tempo | solana — which rail to pay with (default: base,
 *                      else solana). Fund the wallet on the matching chain.
 *   GLIANA_API_URL     defaults to https://api.glianalabs.com.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Mppx, evm, tempo } from 'mppx/client';
import { solana } from '@solana/mpp/client';
import { privateKeyToAccount } from 'viem/accounts';
import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes } from '@solana/kit';
import bs58 from 'bs58';
import { z } from 'zod';

const API = (process.env.GLIANA_API_URL ?? 'https://api.glianalabs.com').replace(/\/+$/, '');

const RAW_EVM = process.env.GLIANA_WALLET_KEY?.trim();
const RAW_SOL = process.env.GLIANA_SOLANA_KEY?.trim();
const RAIL = (process.env.GLIANA_RAIL ?? '').trim().toLowerCase();

// EVM account (Base + Tempo) from a 0x key — signs locally, no gas for the USDC transfer.
let evmAccount: ReturnType<typeof privateKeyToAccount> | null = null;
if (RAW_EVM) {
  try {
    evmAccount = privateKeyToAccount((RAW_EVM.startsWith('0x') ? RAW_EVM : `0x${RAW_EVM}`) as `0x${string}`);
  } catch {
    console.error('GLIANA_WALLET_KEY is not a valid 0x private key — base/tempo disabled.');
  }
}

// Solana signer built async at startup (see main()).
let solanaSigner: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>> | null = null;

async function buildSolanaSigner(key: string) {
  const bytes = key.startsWith('[') ? Uint8Array.from(JSON.parse(key) as number[]) : bs58.decode(key);
  if (bytes.length === 64) return createKeyPairSignerFromBytes(bytes);
  if (bytes.length === 32) return createKeyPairSignerFromPrivateKeyBytes(bytes);
  throw new Error('GLIANA_SOLANA_KEY must be a 32- or 64-byte secret key (base58 or JSON array).');
}

/** Which rail to pay with, and whether its key is present. */
function resolveRail(): { rail: string; method: unknown } | { error: string } {
  const rail = RAIL || (evmAccount ? 'base' : solanaSigner ? 'solana' : '');
  if (!rail)
    return { error: 'No wallet configured. Set GLIANA_WALLET_KEY (base/tempo) and/or GLIANA_SOLANA_KEY (solana) to enable generate.' };
  if (rail === 'base') {
    if (!evmAccount) return { error: 'GLIANA_RAIL=base needs GLIANA_WALLET_KEY (a 0x key holding USDC on Base).' };
    return { rail, method: evm({ account: evmAccount }) };
  }
  if (rail === 'tempo') {
    if (!evmAccount) return { error: 'GLIANA_RAIL=tempo needs GLIANA_WALLET_KEY (a 0x key holding USDC on Tempo).' };
    return { rail, method: tempo({ account: evmAccount }) };
  }
  if (rail === 'solana') {
    if (!solanaSigner) return { error: 'GLIANA_RAIL=solana needs GLIANA_SOLANA_KEY (a Solana key holding USDC).' };
    return { rail, method: solana.charge({ signer: solanaSigner as never }) };
  }
  return { error: `Unknown GLIANA_RAIL "${rail}". Use base, tempo, or solana.` };
}

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}`);
  return (await r.json()) as T;
}

const ok = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const fail = (s: string) => ({ content: [{ type: 'text' as const, text: s }], isError: true });

/** Find a renderable media URL in an inference result (gateway or raw provider shape). */
function mediaUrl(output: unknown): string | null {
  const o = output as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  for (const c of [o, o.result, o.output].filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')) {
    for (const k of ['url', 'image', 'video', 'audio']) {
      const v = c[k];
      if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
    }
  }
  return null;
}

type CatalogModel = { id: string; provider: string; category: string; unit: string; priceLabel: string };
type Price = { model: string; costMicroUsd: number; unit: string; units: number };
type InferResult = { model: string; costMicroUsd: number; output: unknown };

const server = new McpServer({ name: 'gliana-ai', version: '0.2.0' });

server.tool(
  'list_models',
  'List every GlianaAI model (id, category, provider, per-call price). Free — no payment. Use this to pick a model before get_price/generate.',
  {},
  async () => {
    const { models } = await getJson<{ models: CatalogModel[] }>('/v1/models');
    const byCat: Record<string, CatalogModel[]> = {};
    for (const m of models) (byCat[m.category] ??= []).push(m);
    const out = Object.entries(byCat)
      .map(([cat, ms]) => `## ${cat}\n` + ms.map((m) => `- ${m.id} (${m.provider}) — ${m.priceLabel}`).join('\n'))
      .join('\n\n');
    return ok(`${models.length} models on GlianaAI:\n\n${out}`);
  },
);

server.tool(
  'get_price',
  'Quote the exact cost of one call for a model (optionally with input that affects price, e.g. video duration or TTS character count). Free.',
  {
    model: z.string().describe('Model id from list_models, e.g. "nano-banana-2" or "veo-3.1-fast".'),
    input: z.record(z.any()).optional().describe('Optional model input that affects price (e.g. { duration: 8 } or { text: "..." }).'),
  },
  async ({ model, input }) => {
    const qs = new URLSearchParams({ model });
    if (input) for (const [k, v] of Object.entries(input)) qs.set(k, String(v));
    const p = await getJson<Price>(`/v1/price?${qs.toString()}`);
    return ok(`${p.model}: ${usd(p.costMicroUsd)} (${p.units} ${p.unit}${p.units === 1 ? '' : 's'}).`);
  },
);

server.tool(
  'get_schema',
  'Get a model’s input fields (names, types, which are required, defaults). Use before generate to know what to send. Free.',
  { model: z.string().describe('Model id from list_models.') },
  async ({ model }) => {
    const s = await getJson<{ model: string; category: string; required: string[]; props: Record<string, unknown> }>(
      `/v1/schema?model=${encodeURIComponent(model)}`,
    );
    return ok(
      `${s.model} (${s.category})\nrequired: ${s.required.join(', ') || '—'}\n\nfields:\n${JSON.stringify(s.props, null, 2)}`,
    );
  },
);

server.tool(
  'generate',
  'Run a model and return the result (media URL). PAID: settles the price from your wallet over the configured rail (base/tempo/solana). Call get_schema first for the input shape, get_price for the cost.',
  {
    model: z.string().describe('Model id from list_models.'),
    input: z.record(z.any()).describe('Model input, e.g. { prompt: "a red fox" } or { text: "hello" }. See get_schema.'),
  },
  async ({ model, input }) => {
    const picked = resolveRail();
    if ('error' in picked) return fail(picked.error);
    const { rail, method } = picked;

    const body = JSON.stringify({ model, ...input });
    const run = () => {
      // Fresh client per attempt so a stale 402 challenge is never reused.
      const mppx = Mppx.create({ methods: [method] as never, polyfill: false });
      return mppx.fetch(`${API}/v1/infer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    };

    let res = await run();
    if (res.status === 402) res = await run(); // one retry with a fresh challenge

    if (res.status === 402)
      return fail(`Payment did not settle over ${rail} — check the wallet holds USDC on that chain and try again.`);
    if (res.status === 400) {
      const e = (await res.json().catch(() => ({}))) as { detail?: string };
      return fail(`Missing/invalid input (no charge): ${e.detail ?? 'see get_schema'}`);
    }
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      return fail(e.detail ?? e.error ?? `Request failed (HTTP ${res.status})`);
    }

    const result = (await res.json()) as InferResult;
    const url = mediaUrl(result.output);
    const cost = usd(result.costMicroUsd);
    if (url) return ok(`${result.model} → ${url}\ncharged ${cost} via ${rail}`);
    return ok(`${result.model} (charged ${cost} via ${rail}):\n${JSON.stringify(result.output, null, 2)}`);
  },
);

async function main() {
  if (RAW_SOL) {
    try {
      solanaSigner = await buildSolanaSigner(RAW_SOL);
    } catch (err) {
      console.error(`GLIANA_SOLANA_KEY invalid — solana disabled: ${(err as Error).message}`);
    }
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const rails = [evmAccount && 'base', evmAccount && 'tempo', solanaSigner && 'solana'].filter(Boolean).join(', ') || 'none';
  // Stderr only — stdout is the MCP transport.
  console.error(`gliana-ai MCP ready (${API}). generate rails: ${rails}${RAIL ? ` (using ${RAIL})` : ''}.`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
