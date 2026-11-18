---
name: petasats-buy-bsv
description: 'Use when the user or agent needs BSV and holds USDC on Base: "buy BSV", "buy BSV with USDC", "swap USDC for BSV", "get BSV for an agent", "fund a BSV address from Base", "send the BSV to this address". Buys BSV through the local, non-custodial petasats MCP server (npm petasats-mcp): a quote, a cross-chain atomic swap, and delivery to a BSV address.'
license: Open BSV License version 4 (see LICENSE)
compatibility: Node.js 22+; the petasats MCP server (stdio, npm petasats-mcp@0.2.20); USDC and a little ETH on Base
metadata:
  author: BSVanon
  version: "0.1.0"
  facts-from: "petasats-mcp 0.2.20"
---

# petasats-buy-bsv

Buy BSV with USDC on Base from an AI app. The `petasats` MCP server runs on the user's machine and settles each purchase as a cross-chain atomic swap. Its keys are made and kept there, and PetaSats never holds the coins.

## What this skill is for

Use it when the user wants to:

- buy BSV with USDC on Base, for themselves or for an agent;
- get a price for USDC to BSV before buying;
- have the bought BSV sent to a BSV address;
- check on, or recover, a purchase already started.

It covers USDC on Base to BSV only.

## Set up

1. Use Node.js 22 or newer. Pin one release everywhere, here `petasats-mcp@0.2.20`:
   `claude mcp add petasats -- npx -y petasats-mcp@0.2.20`
   Any client that starts local stdio servers can use command `npx` with args `-y petasats-mcp@0.2.20`.
2. The first start creates the kit's keys in `~/.petasats` (`PETASATS_HOME` changes that). Tell the user to back up `keys.json`: it is the only copy. Run one copy of a kit home at a time.
3. To fund the kit, `wallet_info` shows its Base address. The user sends it USDC on Base and a little ETH for gas (0.0002 ETH covers many swaps).

## Buy BSV

1. Call `get_quote` for the USD amount. It moves nothing. Show the user the rate, its comparison with the market mid, and the fees.
2. Start a swap only when the user has asked for that purchase: the amount, and where the BSV goes. A quote is not a go. Then call `swap_asset_to_bsv`, with `deliver_to` set to the user's BSV address when they want the BSV sent on.
3. Call `wait_for_swap` (or `swap_status`) until it finishes. Report one line per stage and end with the transaction IDs.

Standard speed is the default: the kit waits for one BSV confirmation, about 10 minutes on average. Request `speed: "fast"` only when the user asks for it and accepts its risk (see Trust model).

If the BSV goes to an address from BSV Desktop, the user keeps its Get paid screen open until the BSV arrives: BSV Desktop adds incoming funds only while that screen is open.

## Rules

- Never ask for, print, copy or move the kit's keys. The kit signs on the user's machine.
- `swap_asset_to_bsv`, `withdraw_bsv` and `withdraw_base` move funds. Call them only on the user's instruction. `get_quote`, `wait_for_swap`, `swap_status`, `wallet_info`, `list_liquidity` and `fund_wallet` (it only plans a USDC-to-BSV swap and returns a quote) move nothing.
- `busy`, `limit`, `rate_limited`, `unavailable` and `declined` mean nothing was locked. Tell the user, and do not retry in a loop.
- A refusal by the user's limits file (`~/.petasats/limits.json`) is final. Never edit `limits.json` or `STOP` in the kit's folder: they are the user's controls.
- `stop_spending` stops new swaps and withdrawals at once. Only the user can resume, with `npx petasats-mcp@0.2.20 resume`. Swaps already started keep recovering.
- Run one swap at a time, and keep the server running during a swap. After an interruption, `npx petasats-mcp@0.2.20 recover` resumes it, and `npx petasats-mcp@0.2.20 status` shows where things stand.

## Trust model

- The counterparty quotes a price, can decline or delay a swap, and locks BSV for the user. It cannot take the USDC without the swap secret, and the kit reveals that secret only by claiming the BSV.
- If the counterparty never locks BSV, the USDC refunds to the user once the Base lock expires, about 10 hours (180,000 Base blocks) after locking.
- The counterparty's BSV lock can return to it after at most 12 BSV blocks, so the kit claims well before then. Standard settlement reveals the secret only after the BSV lock is in a block and checked against a merkle proof and block headers.
- Fast mode reveals against an unconfirmed BSV lock. If the counterparty double-spends that lock, the user can lose the swap amount. It runs only when requested, both sides agree, and the amount is within the quote's fast cap.
- The user trusts the npm package they run (built by GitHub Actions and published with npm provenance), the Base RPC and BSV data services the kit reads, and the BSV network's first-seen rule while a transaction is unconfirmed.

Full details are in the kit's README: https://github.com/BSVanon/petasats-mcp#trust-model
