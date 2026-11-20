# Privacy

The PetaSats kit runs on your computer. It sends no analytics or usage data, and it never sends its keys anywhere.

To work, it may contact these services directly from your computer:

- **The counterparty**, through the Anvil message relay at anvil.sendbsv.com: quote and swap messages, signed with the
  kit's own identity key. They carry amounts, the kit's public Base and BSV addresses, and the swap's hashes.
- **Public Base RPC providers** (base-rpc.publicnode.com, base.drpc.org, mainnet.base.org, base-public.nodies.app):
  to read the kit's balances and send its own Base transactions.
- **Public BSV services** (api.whatsonchain.com, anvil.sendbsv.com, mainnet-chaintracks.babbage.systems,
  bananablocks.com, api.bitails.io, arc.gorillapool.io, ordinals.gorillapool.io): to read coins and block headers and
  to broadcast the kit's own BSV transactions.

Each service sees the requests it receives and your IP address, under its own privacy policy. The kit's records and
logs stay in its folder on your computer (~/.petasats, or the folder PETASATS_HOME names).
