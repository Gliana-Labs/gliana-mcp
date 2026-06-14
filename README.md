# GlianaAI MCP server

Pay-per-call generative AI for any MCP client (Claude Desktop, Cursor, …).
**59 models** — image, video, music, speech — with **no signup and no API key**.
Each `generate` is paid per call from **your own wallet** over MPP / x402.

- Browse + price models for free (`list_models`, `get_price`, `get_schema`).
- `generate` runs a model and settles the gateway's 402 from your wallet (USDC on
  Base). Your private key is read from the client config and **never leaves your
  machine** — non-custodial, same model as [ai.glianalabs.com](https://ai.glianalabs.com).

## Tools

| Tool | Paid? | Description |
|------|-------|-------------|
| `list_models` | free | Every model: id, category, provider, per-call price. |
| `get_price` | free | Exact cost of one call (input affects it — video duration, TTS length). |
| `get_schema` | free | A model's input fields (required, defaults). |
| `generate` | **paid** | Run a model → media URL. Pays from your wallet. |

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
        "GLIANA_WALLET_KEY": "0xYOUR_EVM_PRIVATE_KEY"
      }
    }
  }
}
```

### Payment rails

`generate` settles the gateway's 402 from your wallet. Pick a rail and set its key:

| Rail | Env var | Wallet needs |
|------|---------|--------------|
| **base** (default) | `GLIANA_WALLET_KEY` (0x EVM key) | USDC on Base — gasless EIP-3009 signature |
| **tempo** | `GLIANA_WALLET_KEY` (same 0x key) | USDC on Tempo |
| **solana** | `GLIANA_SOLANA_KEY` (base58 or JSON-array secret key) | USDC on Solana |

- `GLIANA_RAIL` — `base` \| `tempo` \| `solana`. Optional; defaults to `base` (or
  `solana` if only a Solana key is set). The wallet must hold USDC on that chain.
- `GLIANA_API_URL` — optional, defaults to `https://api.glianalabs.com`.

Keys are needed only for `generate`; the discovery tools work without any.

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
