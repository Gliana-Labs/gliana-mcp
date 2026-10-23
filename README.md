# GlianaAI MCP server

[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/gliana-labs/gliana-mcp)
[![smithery badge](https://smithery.ai/badge/glianalabs/gliana-ai)](https://smithery.ai/servers/glianalabs/gliana-ai)
[Glama server page](https://glama.ai/mcp/servers/Gliana-Labs/gliana-mcp)

Pay-per-call generative AI for any MCP client (Claude Desktop, Cursor, …).
**90+ models** — image, video, video editing, music, speech, LLM chat — plus utility,
market-data and SEC-filing tools, with **no signup and no API key**. Paid calls settle per call from
**your own wallet** over MPP / x402.

- Browse + price everything for free (`list_models`, `get_price`, `get_schema`,
  `list_tools`).
- `generate` runs a model and settles the gateway's 402 from your wallet (USDC on
  Base). Your private key is read from the client config and **never leaves your
  machine** — non-custodial, same model as [ai.glianalabs.com](https://ai.glianalabs.com).

## Tools

| Tool | Paid? | Description |
|------|-------|-------------|
| `list_models` | free | Every model: id, category, provider, per-call price. |
| `get_price` | free | Exact cost of one call (input affects it — video duration, TTS length). |
| `get_schema` | free | A model's input fields (required, defaults). |
| `generate` | **paid** | Run a model → media URL, or assistant text for chat models. |
| `list_tools` | free | Every utility tool: price, HTTP method, example input, guidance. |
| `tool` | mostly **paid** | Run one utility tool — scraping, screenshots, social cards, OCR, structured extraction, market data, chain RPC, reference data. |
| `recipe` | **paid** | Run a multi-model pipeline in one call (e.g. text→image→video). |
| `get_balance` | free | Prepaid balance left on your `gk_` key (only when one is configured). |

`list_tools` reads the gateway live, so it is never out of date — which is why this
table doesn't enumerate the utility tools. A written-down list goes stale the moment
a new endpoint ships, and this one had.

Some utility tools are **free and need no wallet at all** (`list_tools` reports them
at `priceMicroUsd: 0`) — currently the Indonesian reference endpoints: official
region data, prayer times, and NIK verification.

### File inputs

Models that take a source file (image-to-video, video-to-video, transcription) accept
a **public URL** in their file field (e.g. `image`, `video_uri`). Have a local file?
Upload it first — no key, no payment:

```bash
curl -X POST https://api.glianalabs.com/v1/media \
  -H "content-type: video/mp4" --data-binary @clip.mp4
# → { "url": "https://api.glianalabs.com/v1/media/<id>.mp4" }
```

Pass the returned `url` into the model field. Max 40 MB; video / image / audio only.

## Install

**Claude Code** — install the plugin (bundles this server plus a skill that tells
Claude when and how to use it):

```
/plugin install gliana-ai --marketplace Gliana-Labs/gliana-mcp
```

Then set `GLIANA_API_KEY` in your shell (see *Paying* below) and restart Claude
Code. The plugin ships with spending caps of $1 per call and $10 per day; override
them with `GLIANA_MAX_PER_CALL_USD` / `GLIANA_MAX_PER_DAY_USD`.

**Cursor** — one click: [Add GlianaAI to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=gliana-ai&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImdsaWFuYS1haS1tY3AiXSwiZW52Ijp7IkdMSUFOQV9BUElfS0VZIjoiZ2tfeW91cl9rZXkiLCJHTElBTkFfTUFYX1BFUl9DQUxMX1VTRCI6IjEiLCJHTElBTkFfTUFYX1BFUl9EQVlfVVNEIjoiMTAifX0=),
then replace `gk_your_key` in `~/.cursor/mcp.json`.

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.gliana-ai]
command = "npx"
args = ["-y", "gliana-ai-mcp"]
env = { GLIANA_API_KEY = "gk_your_key", GLIANA_MAX_PER_CALL_USD = "1", GLIANA_MAX_PER_DAY_USD = "10" }
```

**Claude Desktop** (`claude_desktop_config.json`) and any other MCP client:

```json
{
  "mcpServers": {
    "gliana-ai": {
      "command": "npx",
      "args": ["-y", "gliana-ai-mcp"],
      "env": {
        "GLIANA_API_KEY": "gk_your_key",
        "GLIANA_MAX_PER_CALL_USD": "1",
        "GLIANA_MAX_PER_DAY_USD": "10"
      }
    }
  }
}
```

### Paying

Two ways. **Pick the first one unless you specifically want the second.**

#### 1. Prepaid key — no wallet, no private key

```json
"env": { "GLIANA_API_KEY": "gk_your_key" }
```

Sign in at [dashboard.glianalabs.com](https://dashboard.glianalabs.com) with a
Google account, mint a key, and top it up (card, or bank transfer / QRIS in
rupiah). **This is the one route that needs an account** — option 2 below needs
none at all.

Paid calls then return `200` directly — no 402 handshake, nothing signed, no
chain, no gas, and nothing in your config that can spend more than you loaded.
Each key carries a daily cap on top of its balance.

So the trade is: an account, in exchange for never putting a private key in a
config file.

`get_balance` (free) reports what is left, and every paid call appends the
remaining balance to its result.

#### 2. Your own wallet — pay per call from your own USDC

The non-custodial route: the gateway's 402 is settled by a signature made on
your machine. **No account, no signup, no balance held by us** — that is the
whole point of it.

The cost is that a **private key has to live in your MCP client's config**,
which is a fair thing for a reviewer to refuse. If that is a problem, use the
prepaid key above.

> **Use a dedicated wallet, funded with only what you intend to spend.**
> This server signs payments locally — the key never leaves your machine and is
> never sent to us — but it is still a private key on a machine running an AI
> agent. Do not use a wallet that holds anything you would miss.
>
> **Prefer `*_KEY_FILE` over the inline variable.** Your MCP client config gets
> synced to cloud storage, committed by accident, and screenshotted when you ask
> someone for help. A file you `chmod 600` does not:
>
> ```bash
> printf '%s' '0xYOUR_KEY' > ~/.gliana-wallet.key && chmod 600 ~/.gliana-wallet.key
> ```
>
> Inline still works if you prefer it — the server just warns on stderr.

| Rail | Env var | Wallet needs |
|------|---------|--------------|
| **base** (default) | `GLIANA_WALLET_KEY_FILE` or `GLIANA_WALLET_KEY` (0x EVM key) | USDC on Base — gasless EIP-3009 signature |
| **tempo** | same key as base | USDC on Tempo |
| **solana** | `GLIANA_SOLANA_KEY_FILE` or `GLIANA_SOLANA_KEY` (base58 or JSON-array secret key) | USDC on Solana |

- `GLIANA_RAIL` — `base` \| `tempo` \| `solana`. Optional; defaults to `base` (or
  `solana` if only a Solana key is set). The wallet must hold USDC on that chain.
- `GLIANA_API_URL` — optional, defaults to `https://api.glianalabs.com`.

**If both are set, the prepaid key wins** and the server says so on startup.
That matches the gateway's own rule — a `gk_` key is something you attached
deliberately, so it should be what spends — and it means a leftover wallet key
in your config cannot quietly become the thing paying.

Neither is needed for the discovery tools or for the free utility tools that
`list_tools` reports at `priceMicroUsd: 0`.

### Spending caps

```json
"env": { "GLIANA_MAX_PER_CALL_USD": "1", "GLIANA_MAX_PER_DAY_USD": "10" }
```

Both optional. When set, every paid call is priced **before** anything is paid —
from the gateway's own 402 quote, the same number it would bill — and refused if
it would exceed either cap. A refusal costs nothing and says which cap it hit.

- Works on every rail. On a wallet rail the check runs on the 402 challenge
  before it is signed; on the prepaid key it costs one extra free request.
- The day total is kept in `~/.gliana-ai-mcp/spend.json`, so restarting the
  client does not reset it. The prepaid key also has its own server-side daily cap.
- An agent in a loop, or one talked into a 30-second 1080p video, is exactly what
  these are for. With a wallet rail there is otherwise no ceiling but the balance.

Restart the client. Ask it to *"list GlianaAI models"* or *"generate an image of a
red fox with nano-banana-2"*.

## `watch` — poll one endpoint on a timer

The MCP server answers a client's questions. `watch` is the other shape: a loop
that calls one cheap endpoint on a schedule and pays per call from the same
wallet, printing one JSON line per poll so it composes with `jq` or a log drain.

```bash
# What would it cost? Reads the live 402 quote, pays nothing, needs no wallet.
npx gliana-ai-mcp watch --tool token-price --input '{"symbol":"SOL"}' \
  --budget 0.50 --dry-run
# → {"costUsd":0.002,"pollsAffordable":250,"runtimeHours":4.17}

# What is worth polling, with live prices?
npx gliana-ai-mcp watch --list

# Run it.
npx gliana-ai-mcp watch --tool token-price --input '{"symbol":"SOL"}' \
  --every 60 --budget 0.50
# → {"t":"...","call":1,"costUsd":0.002,"spentUsd":0.002,"result":{...}}
```

`watch` pays from a **wallet** (`--rail base` or `--rail solana`), not from a
prepaid key — see "Why the x402 rail" below.

`--budget <usd>` is **required** and is a hard stop — there is no default,
because an unbounded spend loop is not something this command will do on your
behalf. Before every poll it checks the budget against the *live* quote, so a
price change is picked up immediately rather than at the price it started with.
A call that fails after the money may already have moved is counted as spent and
is never retried, since paying twice for one answer is worse than missing a tick.
`Ctrl-C` prints a summary.

Payment goes over the x402 rail (`/x402/tools/<name>`) rather than `/v1`. Same
price and same handler; the difference is that x402 settles through a public
facilitator, so the calls are independently verifiable and not just visible to
us. `--rail base` (default with `GLIANA_WALLET_KEY`) or `--rail solana`.

## Funding

With a **prepaid key**, top up at [dashboard.glianalabs.com](https://dashboard.glianalabs.com)
and check what is left with `get_balance`.

With a **wallet**, fund it with a few dollars of USDC on your chosen chain
(Base, Tempo, or Solana).

Either way you pay only the per-call price (see `get_price`) — no subscription.

> Use a dedicated low-balance wallet for agents. Never paste your main wallet's
> key into any config.

## Links

- Website: https://ai.glianalabs.com
- API docs: https://ai.glianalabs.com/docs
- Discoverable on [mppscan](https://mppscan.com) and [x402scan](https://www.x402scan.com)

MIT © Gliana Labs
