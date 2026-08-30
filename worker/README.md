# SPCX rewards indexer

Sums `$SPCX` flows on Base and serves them as the JSON the site reads, so
"total fees collected" and "total $SPCX distributed" stay current without
anyone editing a file.

A browser can't do this — scanning transfer logs across Base history on every
page load isn't feasible — so it runs on a cron and banks running totals in KV.

## How it works

`eth_getLogs` for ERC-20 `Transfer` events, filtered by token and by the
counterparty address. Only the standard Transfer event is used, so **none of
this needs the rewards contract's ABI** — handy, since it may not be verified.

Each cron run scans forward from a saved cursor in chunks, adds to the running
totals, and saves the new cursor. Runs are therefore incremental and resumable;
a backfill just takes several of them. Chunks halve automatically when the RPC
says the range is too large.

Totals are kept as exact `BigInt` base units and only converted to decimal at
the edge, so nothing is lost to float rounding.

## Deploy

```bash
cd worker
npm install -g wrangler        # if you don't have it
wrangler login

wrangler kv namespace create MARSCOIN   # paste the id into wrangler.toml
wrangler secret put RPC_URL            # a Base RPC; public one rate-limits
wrangler secret put ADMIN_TOKEN        # any random string, guards /reset

wrangler deploy
```

Then point the site at it — in the repo root `config.js`:

```js
sources: { rewards: { url: ['https://marscoin-rewards.<you>.workers.dev', 'data/rewards.json'] } }
```

The array is a fallback chain, so the committed file still covers you if the
Worker is down.

## Routes

| | |
|---|---|
| `GET /` | the JSON the site reads |
| `GET /debug` | cursor, head, `blocksBehind`, raw base-unit totals, last error |
| `GET /sync` | run one scan step now — useful while backfilling |
| `POST /reset` | clear state and rescan from `START_BLOCK` (needs `Authorization: Bearer $ADMIN_TOKEN`) |

After deploying, watch `/debug` until `blocksBehind` reaches 0. `lastError` is
where RPC trouble shows up.

## ⚠ Configure it first, then verify the streams

`src/config.js` ships **unset**: no addresses, `START_BLOCK` at 0. In that state
`resolveConfig()` reports `configured: false`, the cron does not run, and `GET /`
answers with nulls and `meta.configured: false` — never a row of zeros that would
read as real totals on the site.

Set `TOKENS.MARS`, `TOKENS.SPCX`, `CONTRACTS.rewardsIndex` and `START_BLOCK`
(plus `pool` and `feeLocker`), either in that file or as wrangler `[vars]` of the
same name — `TOKEN_MARS`, `TOKEN_SPCX`, `POOL`, `FEE_LOCKER`, `REWARDS_INDEX`,
`START_BLOCK` — which override the file, so one build can serve any token.

Then confirm **which flow is "fees" and which is "distributed"** against the
contracts. As written:

- `feesIn` — `$SPCX` arriving at `rewardsIndex`. Point this at the rewards
  contract, never at a launchpad's shared fee locker: that locker collects for
  every coin on the platform, so watching it sums the whole platform's fees.
- `distributed` — `$SPCX` leaving `rewardsIndex`, less the protocol's cut
  (`HOLDER_SHARE`, or exactly via `PROTOCOL_ADDRESS`). If that contract serves
  other tokens as well, this over-counts.

Sanity-check `/debug`'s `rawTotals` against the rewards dashboard for the token
before pointing the site at the Worker. Adjust `STREAMS` in `src/config.js`, then
`POST /reset` to rescan.

If `rewardsIndex` turns out to be verified on Basescan and exposes a cumulative
total as a view function, a single `eth_call` beats this whole approach — read
it directly and skip the log scan.

## Notes

- `totalFeesCollected` values cumulative fees at the **current** `$SPCX`
  price, not the price at the time of each transfer. Fine for a headline
  number; if you need true cost basis, capture the price per block instead.
- `START_BLOCK` is the token's launch block from `/api/coins`, so the scan
  covers its whole life without touching earlier history.

## Tests

```bash
npm test
```

Covers chunking, resume without double-counting, the chunk-halving retry, exact
BigInt summation past `Number` precision, the KV round-trip, auth on `/reset`,
and that a failing RPC is recorded rather than losing banked totals.
