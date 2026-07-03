#!/usr/bin/env node
/**
 * GlianaAI MCP server — exposes pay-per-call generative AI (70+ models: LLM chat/text,
 * image, video, music, speech) to any MCP client (Claude Desktop, Cursor, …).
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
const okv = (s: string, structured: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: s }],
  structuredContent: structured,
});
const fail = (s: string) => ({ content: [{ type: 'text' as const, text: s }], isError: true });

const modelShape = {
  id: z.string(),
  provider: z.string(),
  category: z.string(),
  unit: z.string(),
  priceLabel: z.string(),
};

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

const server = new McpServer(
  {
    name: 'gliana-ai',
    version: '0.3.0',
    title: 'GlianaAI',
    websiteUrl: 'https://ai.glianalabs.com',
    icons: [
      { src: 'https://ai.glianalabs.com/icon-512.png', mimeType: 'image/png', sizes: ['512x512'] },
      { src: 'https://ai.glianalabs.com/logo.svg', mimeType: 'image/svg+xml', sizes: ['any'] },
    ],
  },
  {
    instructions:
      'GlianaAI — pay-per-call generative AI across 70+ models (LLM chat/text, image, video, music, speech). No signup or ' +
      'API key. list_models to browse, get_price to quote, get_schema for inputs, generate to run (paid from ' +
      'your own wallet over base/tempo/solana). Set GLIANA_WALLET_KEY / GLIANA_SOLANA_KEY to enable generate.',
  },
);

server.registerTool(
  'list_models',
  {
    description:
      'List every GlianaAI model (id, category, provider, per-call price). Free — no payment. Use this to pick a model before get_price/generate.',
    inputSchema: {},
    outputSchema: { count: z.number(), models: z.array(z.object(modelShape)) },
    annotations: { title: 'List models', readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    const { models } = await getJson<{ models: CatalogModel[] }>('/v1/models');
    const byCat: Record<string, CatalogModel[]> = {};
    for (const m of models) (byCat[m.category] ??= []).push(m);
    const out = Object.entries(byCat)
      .map(([cat, ms]) => `## ${cat}\n` + ms.map((m) => `- ${m.id} (${m.provider}) — ${m.priceLabel}`).join('\n'))
      .join('\n\n');
    return okv(`${models.length} models on GlianaAI:\n\n${out}`, { count: models.length, models });
  },
);

server.registerTool(
  'get_price',
  {
    description:
      'Quote the exact cost of one call for a model (optionally with input that affects price, e.g. video duration or TTS character count). Free.',
    inputSchema: {
      model: z.string().describe('Model id from list_models, e.g. "nano-banana-2" or "veo-3.1-fast".'),
      input: z.record(z.any()).optional().describe('Optional model input that affects price (e.g. { duration: 8 } or { text: "..." }).'),
    },
    outputSchema: {
      model: z.string(),
      costMicroUsd: z.number(),
      costUsd: z.string(),
      unit: z.string(),
      units: z.number(),
    },
    annotations: { title: 'Get price', readOnlyHint: true, openWorldHint: true },
  },
  async ({ model, input }) => {
    const qs = new URLSearchParams({ model });
    if (input) for (const [k, v] of Object.entries(input)) qs.set(k, String(v));
    const p = await getJson<Price>(`/v1/price?${qs.toString()}`);
    return okv(`${p.model}: ${usd(p.costMicroUsd)} (${p.units} ${p.unit}${p.units === 1 ? '' : 's'}).`, {
      model: p.model,
      costMicroUsd: p.costMicroUsd,
      costUsd: usd(p.costMicroUsd),
      unit: p.unit,
      units: p.units,
    });
  },
);

server.registerTool(
  'get_schema',
  {
    description: 'Get a model’s input fields (names, types, which are required, defaults). Use before generate to know what to send. Free.',
    inputSchema: { model: z.string().describe('Model id from list_models.') },
    outputSchema: {
      model: z.string(),
      category: z.string(),
      required: z.array(z.string()),
      props: z.record(z.any()),
    },
    annotations: { title: 'Get input schema', readOnlyHint: true, openWorldHint: true },
  },
  async ({ model }) => {
    const s = await getJson<{ model: string; category: string; required: string[]; props: Record<string, unknown> }>(
      `/v1/schema?model=${encodeURIComponent(model)}`,
    );
    return okv(
      `${s.model} (${s.category})\nrequired: ${s.required.join(', ') || '—'}\n\nfields:\n${JSON.stringify(s.props, null, 2)}`,
      { model: s.model, category: s.category, required: s.required, props: s.props },
    );
  },
);

server.registerTool(
  'generate',
  {
    description:
      'Run a model and return the result — a media URL for image/video/audio/music models, assistant text for text (LLM) models. Text models take OpenAI-style input: { messages: [{ role, content }, …], max_tokens? }. PAID: settles the price from your wallet over the configured rail (base/tempo/solana). Call get_schema first for the input shape, get_price for the cost. File inputs (image/video/audio, e.g. image-to-video or video-to-video `video_uri`) take a public URL — upload a local file with POST /v1/media (≤40MB) to get one. Array file fields (e.g. `images`, `reference_images` for multi-reference models) take an ARRAY of such URLs.',
    inputSchema: {
      model: z.string().describe('Model id from list_models.'),
      input: z.record(z.any()).describe('Model input, e.g. { prompt: "a red fox" } or { text: "hello" }. See get_schema.'),
    },
    outputSchema: {
      model: z.string(),
      costMicroUsd: z.number(),
      costUsd: z.string(),
      rail: z.string(),
      url: z.string().optional().describe('Media URL of the result, when the model returns media.'),
      output: z.any().describe('Raw model output.'),
    },
    annotations: { title: 'Generate (paid)', readOnlyHint: false, openWorldHint: true },
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

    // SINGLE attempt — never auto-retry. On Solana the gateway BROADCASTS the
    // signed tx, so a retry broadcasts a SECOND transaction and the wallet pays
    // TWICE (a 402 can be an in-flight tx the gateway couldn't confirm in time,
    // not a true failure). The caller re-invokes generate to retry deliberately.
    const res = await run();

    if (res.status === 402)
      return fail(`Payment did not settle over ${rail} — check the wallet holds USDC on that chain, then call generate again.`);
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
    const structured = {
      model: result.model,
      costMicroUsd: result.costMicroUsd,
      costUsd: cost,
      rail,
      ...(url ? { url } : {}),
      output: result.output,
    };
    if (url) return okv(`${result.model} → ${url}\ncharged ${cost} via ${rail}`, structured);
    return okv(`${result.model} (charged ${cost} via ${rail}):\n${JSON.stringify(result.output, null, 2)}`, structured);
  },
);

server.registerTool(
  'tool',
  {
    description:
      'Run a paid UTILITY tool (not an AI model). PAID: settles a flat price from your wallet (base/tempo/solana). ' +
      'Tools: `scrape` {url}→markdown, `screenshot` {url}→PNG url, `og-image`/`quote-card`/`code-image`/`tweet-image` ' +
      '{…}→PNG url, `youtube-thumbnail` {title,background?}→PNG, `meme` {image,top?,bottom?}→PNG, `card` {preset,title}→PNG ' +
      '(preset: og/instagram-square/story/linkedin/podcast), `auto-og` {url}→PNG (scrape+render), `rpc` {chain,method,params?}, ' +
      '`token-price` {ids,vs?}, `face-detect` {image_url|image_base64}→face boxes, `face-embed` {image_url|image_base64}→512-d ' +
      'ArcFace vector per face, `face-compare` {a:{image_url},b:{image_url}}→cosine similarity + match. ' +
      'Full list: GET /openapi.json or https://ai.glianalabs.com/docs#tools.',
    inputSchema: {
      name: z.string().describe('Utility tool name, e.g. scrape, screenshot, og-image, youtube-thumbnail, quote-card, code-image, tweet-image, meme, card, auto-og, rpc, token-price, face-detect, face-embed, face-compare.'),
      args: z.record(z.any()).describe("The tool's input body, e.g. { url } for scrape, { ids } for token-price."),
    },
    outputSchema: {
      tool: z.string(),
      costMicroUsd: z.number(),
      costUsd: z.string(),
      rail: z.string(),
      result: z.any().describe('Tool result (markdown, url, prices, or rpc result).'),
    },
    annotations: { title: 'Utility tool (paid)', readOnlyHint: false, openWorldHint: true },
  },
  async ({ name, args }) => {
    const picked = resolveRail();
    if ('error' in picked) return fail(picked.error);
    const { rail, method } = picked;

    const body = JSON.stringify(args ?? {});
    // SINGLE attempt — same reason as generate (Solana broadcasts; a retry double-pays).
    const mppx = Mppx.create({ methods: [method] as never, polyfill: false });
    const res = await mppx.fetch(`${API}/v1/tools/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

    if (res.status === 402)
      return fail(`Payment did not settle over ${rail} — check the wallet holds USDC on that chain, then call tool again.`);
    if (res.status === 400) {
      const e = (await res.json().catch(() => ({}))) as { detail?: string };
      return fail(`Missing/invalid input (no charge): ${e.detail ?? 'see https://ai.glianalabs.com/docs#tools'}`);
    }
    if (res.status === 503) return fail(`Tool "${name}" is not enabled on this server.`);
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      return fail(e.detail ?? e.error ?? `Request failed (HTTP ${res.status})`);
    }

    const r = (await res.json()) as { tool?: string; costMicroUsd?: number; [k: string]: unknown };
    const cost = usd(r.costMicroUsd ?? 0);
    const { tool: _t, costMicroUsd: _c, ...result } = r;
    const structured = { tool: name, costMicroUsd: r.costMicroUsd ?? 0, costUsd: cost, rail, result };
    return okv(`${name} (charged ${cost} via ${rail}):\n${JSON.stringify(result, null, 2)}`, structured);
  },
);

server.registerTool(
  'recipe',
  {
    description:
      'Run a paid multi-model RECIPE pipeline (chains models in one call). PAID: settles the SUM of the steps from ' +
      'your wallet (base/tempo/solana). Recipes: `image-to-video` {prompt,motionPrompt?} text→image→animated video ' +
      '(3-8x cheaper than a native text-to-video model), `image-to-video-hd` (crisper still), `image-to-video-audio` ' +
      '(video with sound), `brainrot-video` {motionPrompt?,reference_image?} random Italian-brainrot creature → video ' +
      'with audio (no prompt). Override steps with { imageModel, videoModel }. See https://ai.glianalabs.com/docs#recipes.',
    inputSchema: {
      name: z.string().describe('Recipe name: image-to-video, image-to-video-hd, image-to-video-audio, or brainrot-video.'),
      args: z.record(z.any()).describe('Recipe input, e.g. { prompt, motionPrompt?, duration?, resolution? }.'),
    },
    outputSchema: {
      recipe: z.string(),
      costMicroUsd: z.number(),
      costUsd: z.string(),
      rail: z.string(),
      url: z.string().optional().describe('Final media URL (the last step).'),
      result: z.any().describe('Each step output.'),
    },
    annotations: { title: 'Recipe (paid)', readOnlyHint: false, openWorldHint: true },
  },
  async ({ name, args }) => {
    const picked = resolveRail();
    if ('error' in picked) return fail(picked.error);
    const { rail, method } = picked;

    // SINGLE attempt — same reason as generate (Solana broadcasts; a retry double-pays).
    const mppx = Mppx.create({ methods: [method] as never, polyfill: false });
    const res = await mppx.fetch(`${API}/v1/recipes/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args ?? {}),
    });

    if (res.status === 402)
      return fail(`Payment did not settle over ${rail} — check the wallet holds USDC on that chain, then call recipe again.`);
    if (res.status === 400 || res.status === 404) {
      const e = (await res.json().catch(() => ({}))) as { detail?: string };
      return fail(`Bad request (no charge): ${e.detail ?? 'see https://ai.glianalabs.com/docs#recipes'}`);
    }
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      return fail(e.detail ?? e.error ?? `Request failed (HTTP ${res.status})`);
    }

    const r = (await res.json()) as { recipe?: string; costMicroUsd?: number; url?: string; [k: string]: unknown };
    const cost = usd(r.costMicroUsd ?? 0);
    const { recipe: _r, costMicroUsd: _c, ...result } = r;
    const structured = { recipe: name, costMicroUsd: r.costMicroUsd ?? 0, costUsd: cost, rail, url: r.url, result };
    return okv(`${name} → ${r.url ?? '(no url)'}\ncharged ${cost} via ${rail}`, structured);
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
