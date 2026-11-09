# PLOVER

Walk into the jaws. Walk out whole.

The Egyptian plover is said to step into a crocodile's open mouth, pick its teeth and step out again unharmed. PLOVER does that for OTC on Solana. A holder sells a big block of a token straight to one buyer in a single transaction, and the pool never closes on anyone. There is no program and no escrow of ours, and PLOVER never holds a token, a lamport or a key.

- Site: https://ploveronsol.fun
- X: https://x.com/ploveronsol
- API: https://ploveronsol.fun/v1

## The walk

1. **The seller lists a block.** Token, size, price in SOL, and an optional lock. The wallet signs a message, and nothing moves.
2. **A buyer asks.** The ask is a signed message too. The seller can also name a buyer up front instead.
3. **The seller signs for one buyer.** The whole swap is signed against a [durable nonce](https://solana.com/developers/guides/advanced/introduction-to-durable-nonces) instead of a recent blockhash, so the signature can wait days for the buyer, not about a minute.
4. **The buyer walks out.** The buyer adds their signature and sends. Tokens and SOL swap in that one transaction. If the seller has sold the tokens, or the buyer is short of SOL, nothing happens and nobody pays.

To back out, the seller withdraws the nonce account. After that the signed block can never land, and the rent goes back to the seller.

### Why a block always names its buyer

If anyone could take a discounted block, a bot would grab it and sell into the pool in the same second, and the chart would take the bite anyway. That is why every PLOVER block is signed for one wallet only.

### A better price for holding

The seller can require the buyer to hold. The tokens then go into a [Jupiter Lock](https://github.com/jup-ag/jup-lock-starter) escrow (`LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn`) in the buyer's name, opened in the same transaction. It has one cliff on the chosen date and `cancel_mode 0`, so nobody can cancel or redirect it, not even the seller.

## What one block contains

| # | Instruction | Signed by |
|---|---|---|
| 1 | `AdvanceNonceAccount` (seller is the nonce authority) | seller |
| 2 | compute budget | none |
| 3 | open the buyer's token account (or the escrow's) | buyer pays |
| 4 | `transfer_checked` from seller to buyer, or `create_vesting_escrow_v2` for the buyer | seller |
| 5 | SOL from buyer to seller | buyer |
| 6 | fee: 0.5% of the price, from buyer to the PLOVER fee wallet | buyer |
| 7 | memo `plover:<block id>` | none |

The buyer signs only as the payer. Before a buyer ever sees a block, `worker/src/tx.js` checks every instruction in it and refuses anything else that touches the buyer's wallet. It checks:
- the nonce
- the amount, the mint and its decimals
- the price and the fee
- the lock terms
- the seller's Ed25519 signature

`test/tx-test.mjs` holds the tampered blocks it has to refuse.

Tokens with transfer fees, transfer hooks, permanent delegates or other taxing extensions are refused.

## Layout

```
site/plover.js       nonce, block and cancel instructions (browser and node)
site/index.html      the whole site
worker/src/index.js  API, the board in D1, /rpc allowlist, cron that settles signed blocks
worker/src/tx.js     transaction parser and the block rules
test/                mainnet simulation, tamper tests, full API flow on a faked chain
```

## Run it

```bash
npm install
npm test
SOL_RPC_URL=<helius url> npm run dev
```

`npm run check` simulates real blocks on mainnet against a token holder (`RPC=... SELLER=<holder> MINT=<mint>`). It needs no keys and moves no funds.

To deploy:
1. Create a D1 database and put its id in `worker/wrangler.jsonc`.
2. Run `schema.sql` on it.
3. Set the `SOL_RPC_URL` secret (Helius, with DAS).
4. Run `npm run deploy`.

## License

MIT
