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

Add to your MCP client config.

**Claude Desktop** (`claude_desktop_config.json`) / **Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "gliana-ai": {
      "command": "npx",
      "args": ["-y", "gliana-ai-mcp"],
      "env": {
        "GLIANA_WALLET_KEY_FILE": "/absolute/path/to/gliana-wallet.key"
      }
    }
  }
}
```

### Payment rails

`generate` settles the gateway's 402 from your wallet. Pick a rail and set its key:

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

Keys are needed only for paid calls. The discovery tools — and the free utility
tools `list_tools` reports at `priceMicroUsd: 0` — work without any wallet.

Restart the client. Ask it to *"list GlianaAI models"* or *"generate an image of a
red fox with nano-banana-2"*.

## Funding

Fund the wallet with a few dollars of USDC on your chosen chain (Base, Tempo, or
Solana). You pay only the per-call price (see `get_price`); there's no
subscription and no balance held by us.

> Use a dedicated low-balance wallet for agents. Never paste your main wallet's
> key into any config.

## Links

- Website: https://ai.glianalabs.com
- API docs: https://ai.glianalabs.com/docs
- Discoverable on [mppscan](https://mppscan.com) and [x402scan](https://www.x402scan.com)

MIT © Gliana Labs
