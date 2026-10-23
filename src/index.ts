#!/usr/bin/env node
/**
 * GlianaAI MCP server — exposes pay-per-call generative AI (100+ models: LLM chat/text,
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
 *   GLIANA_MAX_PER_CALL_USD / GLIANA_MAX_PER_DAY_USD  optional spending caps, checked
 *                      against the exact 402 price BEFORE paying (see spend.ts).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Mppx, tempo } from 'mppx/client';
import { solana } from '@solana/mpp/client';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes } from '@solana/kit';
import bs58 from 'bs58';
import { baseMethod } from './rails.js';
import { CapRefusal, SpendLedger, capOnChallenge, capsFromEnv, priceFromWwwAuthenticate, refusal } from './spend.js';
import { z } from 'zod';

const API = (process.env.GLIANA_API_URL ?? 'https://api.glianalabs.com').replace(/\/+$/, '');

/**
 * Read a key, preferring a FILE over an inline value.
 *
 * An inline key lives in the MCP client's config JSON — a file that gets synced
 * to cloud storage, committed by accident, and screenshotted when someone asks
 * for help. `*_KEY_FILE` points at a file you control the permissions on, so
 * the secret never enters the config at all.
 *
 * Inline still works: breaking existing installs to make a point would be
 * worse than the risk. But the file path is documented first and warned about
 * here, because "paste your private key into this JSON" is a fair thing for a
 * reviewer to refuse.
 */
function readKey(name: string): string | undefined {
  const file = process.env[`${name}_FILE`]?.trim();
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch (err) {
      console.error(`${name}_FILE could not be read (${String(err).slice(0, 80)}) — that rail is disabled.`);
      return undefined;
    }
  }
  const inline = process.env[name]?.trim();
  if (inline) {
    console.error(
      `${name} was supplied inline. Prefer ${name}_FILE=/path/to/key (chmod 600) so the key is not stored ` +
        'in your MCP client config. Use a dedicated wallet holding only what you intend to spend.',
    );
  }
  return inline;
}

const RAW_EVM = readKey('GLIANA_WALLET_KEY');
const RAW_SOL = readKey('GLIANA_SOLANA_KEY');
const RAW_API_KEY = readKey('GLIANA_API_KEY');
const RAIL = (process.env.GLIANA_RAIL ?? '').trim().toLowerCase();

/**
 * The prepaid-balance key (`gk_…`), if one is configured.
 *
 * This is the rail that does NOT need a wallet. The gateway charges a prepaid
 * balance behind the key and answers 200 directly — no 402 handshake, no
 * signing, no chain, no gas. It is the only payment method here that does not
 * require a private key in the MCP client's config file, which is the thing a
 * reviewer can fairly refuse (see readKey above).
 *
 * Validated by SHAPE, not by a round trip: an obviously malformed value should
 * say so at startup rather than failing on the first paid call. The gateway is
 * the only authority on whether a well-formed key is real.
 */
function glianaKey(): string | null {
  const k = RAW_API_KEY?.trim();
  if (!k) return null;
  if (!/^gk_[A-Za-z0-9_-]{8,}$/.test(k)) {
    console.error('GLIANA_API_KEY does not look like a gateway key (expected gk_…) — the balance rail is disabled.');
    return null;
  }
  return k;
}

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
    return {
      error:
        'No payment method configured. Either set GLIANA_API_KEY (a gk_… key with a prepaid balance — no wallet, ' +
        'no private key, top up at https://dashboard.glianalabs.com), or set GLIANA_WALLET_KEY (base/tempo) ' +
        'and/or GLIANA_SOLANA_KEY (solana) to pay per call from your own wallet.',
    };
  if (rail === 'base') {
    if (!evmAccount) return { error: 'GLIANA_RAIL=base needs GLIANA_WALLET_KEY (a 0x key holding USDC on Base).' };
    return { rail, method: baseMethod(evmAccount) };
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

/**
 * Make one paid call, over whichever rail is configured.
 *
 * The `gk_` key WINS when both are present. That mirrors the gateway's own rule
 * (lib/keys.ts: "a gk_ key is something the caller deliberately attached, so it
 * wins") and it is the safer default: spending a prepaid balance someone topped
 * up on purpose beats spending from a wallet whose key happens to be in the
 * same config file.
 *
 * ONE attempt, never an automatic retry — on Solana the gateway BROADCASTS the
 * signed transaction, so a retry broadcasts a second one and the wallet pays
 * TWICE (a 402 can be an in-flight tx the gateway could not confirm in time,
 * not a true failure). The caller re-invokes the tool to retry deliberately.
 * The balance rail cannot double-charge this way, but the rule is kept uniform
 * so no call site has to know which rail it got.
 */
const CAPS = capsFromEnv(process.env);
const ledger = new SpendLedger();
const capped = CAPS.perCallMicro !== null || CAPS.perDayMicro !== null;

async function paidFetch(path: string, body: string): Promise<{ rail: string; res: Response } | { error: string }> {
  const url = `${API}${path}`;
  const headers = { 'content-type': 'application/json' };
  const key = glianaKey();
  if (key) {
    let quoted: number | null = null;
    if (capped) {
      // The balance rail answers 200 with no 402, so the price is never seen
      // before the charge. An unpaid request is free and returns the exact
      // challenge the gateway would bill (same priceForRequest), so ask that
      // first. A 4xx here is the pre-charge guard speaking — hand it back as is.
      const probe = await fetch(url, { method: 'POST', headers, body });
      if (probe.status !== 402) return { rail: 'balance', res: probe };
      quoted = priceFromWwwAuthenticate(probe.headers.get('www-authenticate'));
      if (quoted === null) return { error: 'Not paid: could not read the price to check it against your spending caps.' };
      const why = refusal(quoted, CAPS, ledger.spentToday());
      if (why) return { error: why };
    }
    const res = await fetch(url, { method: 'POST', headers: { ...headers, authorization: `Bearer ${key}` }, body });
    if (res.ok && capped) ledger.record(Number(res.headers.get('x-gliana-charged-micro-usd')) || quoted || 0);
    return { rail: 'balance', res };
  }
  const picked = resolveRail();
  if ('error' in picked) return { error: picked.error };
  let quoted = 0;
  // Fresh client per attempt so a stale 402 challenge is never reused.
  const mppx = Mppx.create({
    methods: [picked.method] as never,
    polyfill: false,
    // The challenge carries the exact price, and this runs before anything is
    // signed — the one point where a wallet payment can still be stopped free.
    onChallenge: capOnChallenge(CAPS, () => ledger.spentToday(), (micro) => (quoted = micro)) as never,
  });
  let res: Response;
  try {
    res = await mppx.fetch(url, { method: 'POST', headers, body });
  } catch (err) {
    if (err instanceof CapRefusal) return { error: err.message };
    throw err;
  }
  if (res.ok && capped) ledger.record(quoted);
  return { rail: picked.rail, res };
}

/**
 * What to tell the caller about a 402, which means something different per rail.
 *
 * On the balance rail a 402 is NOT a failed settlement — it is the gateway
 * saying "top up" or "daily cap", and it carries the instruction in the body.
 * Telling someone to go fund a wallet would be wrong and confusing, so the
 * gateway's own `detail` is relayed verbatim.
 */
async function paymentRefused(rail: string, res: Response, retryWhat: string): Promise<string> {
  if (rail === 'balance') {
    const e = (await res.json().catch(() => ({}))) as { error?: string; detail?: string; topup_url?: string };
    const where = e.topup_url ? ` Top up: ${e.topup_url}` : '';
    return `${e.detail ?? e.error ?? 'The prepaid balance could not cover this call.'}${where}`;
  }
  return `Payment did not settle over ${rail} — check the wallet holds USDC on that chain, then call ${retryWhat} again.`;
}

/** Remaining balance after a charge, when the gateway reported one. */
const balanceNote = (res: Response): string => {
  const left = res.headers.get('x-gliana-balance-micro-usd');
  return left ? `, ${usd(Number(left))} left` : '';
};

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

/**
 * A utility tool as the gateway describes itself at GET /v1/tools.
 *
 * Fetched live rather than hardcoded here. The gateway is the single source for
 * the catalog, prices and schemas already (that's why list_models exists), and
 * the tool list had drifted for exactly the reason a hardcoded list always does:
 * six endpoints shipped and this file still advertised the old ten. Reading the
 * listing means a new endpoint is usable from MCP the moment it deploys, with no
 * npm release.
 *
 * `method` matters: the free reference endpoints are GET with query parameters,
 * so a POST-only runner cannot reach them at all. `priceMicroUsd === 0` marks the
 * ones that need no wallet.
 */
type UtilityTool = {
  name: string;
  path: string;
  method?: 'GET' | 'POST';
  priceMicroUsd: number;
  example?: Record<string, unknown>;
  guidance?: string;
};

/** Cached for the process; the listing itself is edge-cached for 5 minutes. */
let toolCatalog: UtilityTool[] | null = null;
async function listTools(): Promise<UtilityTool[]> {
  if (toolCatalog) return toolCatalog;
  const { tools } = await getJson<{ tools: UtilityTool[] }>('/v1/tools');
  toolCatalog = tools;
  return tools;
}
type Price = { model: string; costMicroUsd: number; unit: string; units: number };
type InferResult = { model: string; costMicroUsd: number; output: unknown };

/**
 * The published version, read from package.json at startup so it cannot drift
 * from what npm actually shipped. `files: ['dist']` means package.json sits one
 * level above the bundled entry point.
 */
const PKG_VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
  } catch {
    // Never let a packaging quirk stop the server from starting.
    return '0.0.0';
  }
})();

const server = new McpServer(
  {
    name: 'gliana-ai',
    // Read from package.json, not typed twice. It had drifted to 0.5.0 while the
    // package shipped 0.5.2, so every client — and Glama's introspection check —
    // was told the wrong version.
    version: PKG_VERSION,
    title: 'GlianaAI',
    websiteUrl: 'https://ai.glianalabs.com',
    icons: [
      { src: 'https://ai.glianalabs.com/icon-512.png', mimeType: 'image/png', sizes: ['512x512'] },
      { src: 'https://ai.glianalabs.com/logo.svg', mimeType: 'image/svg+xml', sizes: ['any'] },
    ],
  },
  {
    instructions:
      'GlianaAI — pay-per-call generative AI across 100+ models (LLM chat/text, image, video, music, speech) plus utility ' +
      'and data tools. No signup or API key. list_models to browse models, get_price to quote, get_schema for inputs, ' +
      'generate to run one. list_tools to browse utility tools (scraping, OCR, extraction, reference data), then `tool` ' +
      'to run one; recipe for multi-model pipelines. Discovery is free, and some utility tools are free too — ' +
      'list_tools reports those at priceMicroUsd 0. Set GLIANA_WALLET_KEY / GLIANA_SOLANA_KEY to pay for the rest.',
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
    const paid = await paidFetch('/v1/infer', JSON.stringify({ model, ...input }));
    if ('error' in paid) return fail(paid.error);
    const { rail, res } = paid;

    if (res.status === 401) return fail(await paymentRefused(rail, res, 'generate'));
    if (res.status === 402) return fail(await paymentRefused(rail, res, 'generate'));
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
    if (url) return okv(`${result.model} → ${url}\ncharged ${cost} via ${rail}${balanceNote(res)}`, structured);
    return okv(`${result.model} (charged ${cost} via ${rail}${balanceNote(res)}):\n${JSON.stringify(result.output, null, 2)}`, structured);
  },
);

/**
 * The utility-tool equivalent of list_models. Exists so no client, and no
 * description in this file, has to carry a hardcoded list that goes stale.
 */
server.registerTool(
  'list_tools',
  {
    description:
      'List every GlianaAI utility tool (name, HTTP method, per-call price, an example input, and usage guidance), read ' +
      'live from the gateway so it is always current. Free — no payment. Call this before `tool` to pick one and learn ' +
      'its input shape. Tools reported at priceMicroUsd 0 are free to call and need no wallet.',
    inputSchema: {},
    outputSchema: {
      tools: z.array(
        z.object({
          name: z.string(),
          method: z.string().describe('GET tools take query parameters; POST tools take a JSON body.'),
          priceMicroUsd: z.number().describe('0 means free — no wallet needed.'),
          priceUsd: z.string(),
          example: z.record(z.any()),
          guidance: z.string(),
        }),
      ),
    },
    annotations: { title: 'List utility tools', readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const all = await listTools();
    const tools = all.map((t) => ({
      name: t.name,
      method: t.method ?? 'POST',
      priceMicroUsd: t.priceMicroUsd,
      priceUsd: usd(t.priceMicroUsd),
      example: t.example ?? {},
      guidance: t.guidance ?? '',
    }));
    const lines = tools.map(
      (t) => `- ${t.name} (${t.method}, ${t.priceMicroUsd === 0 ? 'free' : t.priceUsd}) ${t.guidance || ''}`.trim(),
    );
    return okv(`${tools.length} utility tools:\n${lines.join('\n')}`, { tools });
  },
);

server.registerTool(
  'tool',
  {
    description:
      'Run a UTILITY tool (not an AI model) — scraping, screenshots, social cards, market data, chain RPC, ' +
      'OCR, address parsing, structured extraction, Indonesian reference data. ' +
      'Call list_tools FIRST for the live list with prices and input shapes: it is read from the gateway, so it is ' +
      'never out of date, and this description deliberately does not enumerate them. ' +
      'Most tools are PAID and settle a flat price from your wallet (base/tempo/solana); the ones list_tools reports ' +
      'at priceMicroUsd 0 are free and need no wallet at all.',
    inputSchema: {
      name: z.string().describe('Utility tool name exactly as list_tools reports it, e.g. scrape, ocr-id, address-id, extract, exchange-rate, prayer-times.'),
      args: z.record(z.any()).describe("The tool's input, as list_tools shows in `example`. For GET tools these become query parameters; for POST tools, the JSON body."),
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
    // Ask the gateway what this tool is before deciding how to call it. A tool we
    // don't recognise is still attempted as a paid POST, so a brand-new endpoint
    // works without waiting for an npm release.
    const known = await listTools()
      .then((all) => all.find((t) => t.name === name))
      .catch(() => undefined);

    // FREE + GET: the reference endpoints (wilayah, prayer-times, verify-nik) take
    // query parameters and cost nothing, so they need no wallet and must not go
    // through a payment attempt. Before this they were unreachable from MCP —
    // the runner only ever POSTed a JSON body.
    if (known && known.priceMicroUsd === 0 && known.method === 'GET') {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(args ?? {})) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
      const res = await fetch(`${API}/v1/tools/${name}?${qs}`, { headers: { accept: 'application/json' } });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) return fail(String(j.detail ?? j.error ?? `Request failed (HTTP ${res.status})`));
      return okv(`${name} (free):\n${JSON.stringify(j, null, 2)}`, {
        tool: name,
        costMicroUsd: 0,
        costUsd: '$0.0000',
        rail: 'none',
        result: j,
      });
    }

    const paid = await paidFetch(`/v1/tools/${name}`, JSON.stringify(args ?? {}));
    if ('error' in paid) return fail(paid.error);
    const { rail, res } = paid;

    if (res.status === 401 || res.status === 402) return fail(await paymentRefused(rail, res, 'tool'));
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
    return okv(`${name} (charged ${cost} via ${rail}${balanceNote(res)}):\n${JSON.stringify(result, null, 2)}`, structured);
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
    const paid = await paidFetch(`/v1/recipes/${name}`, JSON.stringify(args ?? {}));
    if ('error' in paid) return fail(paid.error);
    const { rail, res } = paid;

    if (res.status === 401 || res.status === 402) return fail(await paymentRefused(rail, res, 'recipe'));
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
    return okv(`${name} → ${r.url ?? '(no url)'}\ncharged ${cost} via ${rail}${balanceNote(res)}`, structured);
  },
);

server.registerTool(
  'get_balance',
  {
    description:
      'FREE. Remaining prepaid balance on the configured GLIANA_API_KEY. Call this before an expensive generate to ' +
      'check there is enough, or after a paid call reports insufficient_balance. Returns an error when no gk_ key is ' +
      'configured (this server is then paying per call from a wallet instead).',
    inputSchema: {},
    outputSchema: {
      accountId: z.string(),
      balanceMicroUsd: z.number(),
      balanceUsd: z.string(),
    },
    annotations: { title: 'Get balance (free)', readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    const key = glianaKey();
    if (!key)
      return fail(
        'No GLIANA_API_KEY configured, so there is no prepaid balance to report. Mint a key and top it up at ' +
          'https://dashboard.glianalabs.com, or keep paying per call from a wallet.',
      );
    // GET /v1/keys/balance answers { account_id, balance_micro_usd, balance_usd }.
    // The daily cap is NOT reported here — it only appears in a 402
    // `daily_cap_reached` body, which paymentRefused relays verbatim.
    const res = await fetch(`${API}/v1/keys/balance`, {
      headers: { accept: 'application/json', authorization: `Bearer ${key}` },
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return fail(String(j.detail ?? j.error ?? `Could not read the balance (HTTP ${res.status})`));
    const micro = Number(j.balance_micro_usd ?? 0);
    return okv(`balance ${usd(micro)}`, {
      accountId: String(j.account_id ?? ''),
      balanceMicroUsd: micro,
      balanceUsd: String(j.balance_usd ?? usd(micro)),
    });
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

  // `watch` runs INSTEAD of the MCP server: a poll loop that pays per call from
  // the same wallet (see watch.ts). Imported dynamically so the server's start
  // up never loads the x402 client stack it does not use — and so stdout, which
  // is the MCP transport below, stays untouched when we are not watching.
  if (process.argv[2] === 'watch') {
    const { runWatch } = await import('./watch.js');
    process.exit(
      await runWatch(process.argv.slice(3), {
        api: API,
        evmAccount,
        solanaSigner,
        evmNetwork: process.env.GLIANA_EVM_NETWORK,
        svmNetwork: process.env.GLIANA_SVM_NETWORK,
      }),
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stderr only — stdout is the MCP transport.
  if (glianaKey()) {
    // The key wins over any wallet (see paidFetch), so say which one will spend.
    const also = [evmAccount && 'base/tempo', solanaSigner && 'solana'].filter(Boolean).join(', ');
    console.error(
      `gliana-ai MCP ready (${API}). Paying from the prepaid balance on GLIANA_API_KEY` +
        `${also ? ` (wallet rails ${also} are configured but the key takes precedence — unset GLIANA_API_KEY to use them)` : ''}.`,
    );
  } else {
    const rails = [evmAccount && 'base', evmAccount && 'tempo', solanaSigner && 'solana'].filter(Boolean).join(', ') || 'none';
    console.error(
      `gliana-ai MCP ready (${API}). generate rails: ${rails}${RAIL ? ` (using ${RAIL})` : ''}.` +
        (rails === 'none'
          ? ' No payment method configured — set GLIANA_API_KEY (prepaid, no wallet) or a wallet key to enable paid calls.'
          : ''),
    );
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
