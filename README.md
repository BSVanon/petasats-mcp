# PetaSats MCP 0.1.0

PetaSats MCP lets your AI app buy BSV with USDC on Base. It runs on your own computer as a local MCP server and swaps with Carl, the PetaSats market maker, through a cross-chain atomic swap. It is non-custodial: the kit makes its keys on your machine and keeps them there, and no server ever holds your funds.

## What it does today

- **USDC on Base to BSV only.**
- **Swap size:** from about $5 (Carl declines smaller swaps) up to $100.
- **Daily limits:** each buyer can make at most 3 swaps and $200 per day. All buyers share a daily total, so the door can be busy or full. If it is, try again later.
- **Quotes** last about 60 seconds. The swap checks your `min_bsv_out` again before it starts.

## Install

You need Node.js 22 or newer.

```sh
npm install -g https://github.com/BSVanon/petasats-mcp/releases/download/v0.1.0/petasats-mcp-0.1.0.tgz
```

The release page lists the archive's SHA-256 in `SHA256SUMS`. To check a downloaded copy:

- macOS: `shasum -a 256 petasats-mcp-0.1.0.tgz`
- Linux: `sha256sum petasats-mcp-0.1.0.tgz`
- Windows: `certutil -hashfile petasats-mcp-0.1.0.tgz SHA256`

## Set up

```sh
petasats-mcp init
```

This creates the kit folder: `~/.petasats`, or the folder named in `PETASATS_HOME`. It prints:

- `base_address`: send USDC on Base here, plus a little ETH on Base for gas (about $1 is plenty);
- `bsv_address`: the kit's own BSV address;
- `mcp.command` and `mcp.args`: the exact launch command for your AI app.

**Back up the kit folder.** Its `keys.json` is the only copy of the kit's keys. If you lose it while funds are in the kit, those funds are lost.

## Connect your AI app

Wherever `COMMAND` and `ARG` appear below, use the `mcp.command` and `mcp.args` values that `petasats-mcp init` printed. They are full paths, so they work even when a desktop app does not see your shell's PATH. Restart the app after you change its settings.

**Claude Desktop.** Open Settings, then Developer, then Edit Config, and add:

```json
{ "mcpServers": { "petasats": { "command": "COMMAND", "args": ["ARG"] } } }
```

**Claude Code:**

```sh
claude mcp add --scope user petasats -- COMMAND ARG
```

**Codex** (the CLI or the Codex app). Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.petasats]
command = "COMMAND"
args = ["ARG"]
```

**Cursor, Gemini CLI and Qwen Code.** Add the Claude Desktop JSON above to `~/.cursor/mcp.json`, `~/.gemini/settings.json` or `~/.qwen/settings.json`.

On Windows, write each backslash in a JSON path as two backslashes.

Assistants that run only in a web browser cannot start local tools yet.

## Use it

Ask your AI app things like:

- "Get a quote for 10 USDC to BSV."
- "Swap 10 USDC to BSV and deliver it to <your BSV address>. Don't accept less than 98% of the quoted BSV."
- "Show my swap status."
- "Withdraw the kit's confirmed BSV to <your BSV address>."

Your AI app converts the units. The tools take amounts in the smallest units: USDC has 6 decimals, and BSV amounts are in satoshis.

| Tool | What it does |
| --- | --- |
| `list_liquidity` | Shows the supported route. |
| `get_quote` | Gets a live USDC to BSV quote from Carl. |
| `swap_asset_to_bsv` | Starts a swap in the background. With `deliver_to`, the BSV goes on to that address once it confirms. |
| `swap_status` | Shows each swap's progress and its next step. |
| `wallet_info` | Shows the kit's addresses, balances and caps. It never shows a key. |
| `withdraw_bsv` | Sends the kit's confirmed BSV to an address. |
| `fund_wallet` | Plans a swap that funds a BSV address. It moves nothing. |

## Timing and safety

A swap takes about 30 to 60 minutes:

1. Your USDC lock needs 6 Base confirmations.
2. Carl's BSV lock then needs at least 1 BSV confirmation.
3. The kit checks that lock's merkle proof before it claims the BSV.

**Keep your AI app (or `petasats-mcp`) running until the swap shows delivered.** The kit must be online to claim the BSV. If the app closes, reopen it or run `petasats-mcp recover`; swaps resume from their saved records.

If a swap cannot finish, it unwinds:

- Carl's BSV returns to Carl up to about 4 hours (24 blocks) after he locks it.
- Your USDC can be refunded to you about 16 hours (28,800 Base blocks) after you lock it.

Network fees are paid on both chains, and a refund also costs gas. `petasats-mcp status` lists your swaps from the command line.

## Update

Install the newer release with the same `npm install -g` command. Your kit folder and keys stay where they are.

## Troubleshooting

"Money tools unavailable" usually means one of these:

- `petasats-mcp init` has not run;
- the kit folder's `config.json` was edited;
- the kit cannot reach the network.

Run `petasats-mcp init` again (it never replaces existing keys), check your connection, and restart your AI app.

## Disclaimer

Experimental software. Use small amounts. There is no warranty: see the license in `LICENSE`. Third-party licenses are in `THIRD_PARTY_NOTICES.md`.
