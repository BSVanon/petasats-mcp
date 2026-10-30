<p align="center"><img src="assets/petasats-logo.svg" alt="PetaSats" width="240"></p>

# PetaSats MCP

Buy BSV with USDC on Base from your AI app through a local, non-custodial MCP server.

## What it does

PetaSats supports USDC on Base to BSV only. Keys are made and kept on your machine.

1. You lock USDC in the swap contract on Base.
2. The market maker locks BSV.
3. The kit verifies the lock against a merkle proof and block headers, then claims BSV and reveals the secret.
4. The market maker uses that secret to claim USDC.

Swaps are about $5 to $100. Each buyer may make three swaps and $200 per day; a shared daily total also applies. They usually take 15 to 25 minutes.

## Install and connect

Use Node.js 22 or newer. Pinning `petasats-mcp@0.2.3` is recommended.

```sh
claude mcp add petasats -- npx -y petasats-mcp
```

Claude Desktop (`claude_desktop_config.json`), Cursor (`~/.cursor/mcp.json`):

```json
{"mcpServers":{"petasats":{"command":"npx","args":["-y","petasats-mcp"]}}}
```

VS Code (`.vscode/mcp.json`):

```json
{"servers":{"petasats":{"type":"stdio","command":"npx","args":["-y","petasats-mcp"]}}}
```

Codex (CLI, IDE extension, or app):

```sh
codex mcp add petasats -- npx -y petasats-mcp
```

Any client that starts local stdio servers can use command `npx` and args `-y petasats-mcp`. First start creates keys in `~/.petasats`; `PETASATS_HOME` changes that location. Back up `keys.json`: it is the only copy.

## Fund the kit

`wallet_info` shows the Base address. Send it USDC on Base and a little ETH for gas; 0.0002 ETH covers many swaps.

## Use it

Ask: “Buy $20 of BSV and send it to 1...”

| Tool | Moves funds |
| --- | --- |
| get_quote | No |
| swap_asset_to_bsv | Yes |
| wait_for_swap | No |
| swap_status | No |
| wallet_info | No |
| stop_spending | No |
| withdraw_bsv | Yes |
| withdraw_base | Yes |
| fund_wallet | No — it only plans a USDC-to-BSV swap and returns a quote |
| list_liquidity | No |

## Limits you control

You can create `~/.petasats/limits.json` to restrict where an AI may send funds and how much it may swap per UTC day:

```json
{
  "format": "petasats.limits/1",
  "bsvDestinations": ["1BoatSLRHtKNngkdXEeobR76b53LETtpyT"],
  "baseDestinations": ["0x1111111111111111111111111111111111111111"],
  "maxSwapUsdPerDay": 50
}
```

Keep this file private to your user account: `chmod 600 ~/.petasats/limits.json`. The kit refuses a limits file that other users can read or write. It rereads the file before every money operation. A refusal says that it was refused by your limits file and that nothing was sent. Use `npx petasats-mcp limits` to inspect it.

`stop_spending` stops new swaps and withdrawals immediately. Only you can resume with `npx petasats-mcp resume`; recovery for swaps already started keeps working.

These controls protect against an AI that can only use the kit's tools. An AI app that can run shell commands or edit files as you can also edit `limits.json` or `STOP`.

## Progress and reporting

The server gives the AI an operating guide. With a person watching, it reports one line per stage and a final summary with transaction IDs. For a program it returns only the result. Reporting never holds up a swap, and nothing asks for confirmation after a swap starts.

## Safety model

Funds can go only to the swap contract on Base, the kit’s own addresses, or an address you provide. The kit verifies before reveal. The market maker’s BSV can return about four hours (24 blocks) after lock; your USDC refunds after about 16 hours if the swap does not finish. Recovery resumes after restart. Run one swap at a time and keep the server running during a swap.

## Costs

`get_quote` shows the rate and comparison with market mid. You pay Base gas in ETH, the BSV claim fee, and a small extra BSV fee with `deliver_to`. See `get_quote` for protocol fees.

## Verify what you run

The npm package is built by GitHub Actions from a tagged commit and published with npm provenance. Run `npm audit signatures`; the npm page links the build to its commit and workflow run. `dist/petasats-mcp.mjs` is not minified. Source under `src/` is exported from the development repository for each release with internal development comments removed and internal names replaced by neutral ones; apart from that it is identical.

## Files, status, and recovery

The kit uses `~/.petasats`. Run `npx petasats-mcp status` for status and `npx petasats-mcp recover` after interruption.

A Base withdrawal left pending (for example after a fee rise) is re-sent unchanged; new swaps and Base withdrawals wait until it confirms. Run `npx petasats-mcp withdrawals` to list pending withdrawals. If a finalized nonce was consumed but its receipt cannot be found, check the transaction in a Base explorer, then explicitly record the outcome with `npx petasats-mcp withdrawal <hash> sent` or `npx petasats-mcp withdrawal <hash> not-sent`.

Repeating the same Base withdrawal (same asset, amount, and address) within an hour is refused as a likely retry. Do not run two AI apps using the kit on the same folder at the same time.

A swap started with version 0.2.0 or 0.2.1 whose USDC lock never landed can stay at "Waiting for BSV lock" and block new swaps and withdrawals. If no other copy of the kit used the same folder while that swap ran, set `PETASATS_RESOLVE_OLD_STUCK_SWAPS=1` in the kit's environment (for example `"env":{"PETASATS_RESOLVE_OLD_STUCK_SWAPS":"1"}` in your client's server entry) and restart the kit. It then sends a zero-value transaction to its own Base address so the old lock can never land, and marks the swap failed once that transaction is final, usually within 30 minutes. Swaps started with 0.2.2 or later resolve without this setting.

## Troubleshooting

`busy`, `limit`, `rate_limited`, `unavailable`, and `declined` mean nothing was locked. If keys-file permissions are wrong, restore owner-only access. For RPC trouble, check your network connection and retry.

## Security, license, and disclaimer

See [SECURITY.md](SECURITY.md). PetaSats uses the Open BSV License v4; third-party notices are in `THIRD_PARTY_NOTICES.md`. This is experimental software: use small amounts and there is no warranty.
