# STONKEX rewards indexer

Sums `$STONKEX` flows on Base and serves them as the JSON the site reads, so
"total fees collected" and "total $STONKEX distributed" stay current without
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

wrangler kv namespace create STONKEX   # paste the id into wrangler.toml
wrangler secret put RPC_URL            # a Base RPC; public one rate-limits
wrangler secret put ADMIN_TOKEN        # any random string, guards /reset

wrangler deploy
```

Then point the site at it — in the repo root `config.js`:

```js
sources: { rewards: { url: ['https://stonkex-rewards.<you>.workers.dev', 'data/rewards.json'] } }
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

## ⚠ Verify the streams before trusting the numbers

The addresses in `src/config.js` come from thestonks.exchange's own APIs, but
**which flow is "fees" and which is "distributed" has not been confirmed against
the contracts.** As written:

- `distributed` — `$STONKEX` leaving `rewardsIndex` (`0xf01a4dab…51DE2E`).
  If that contract serves other tokens as well, this over-counts.
- `feesIn` — `$STONKEX` arriving at `feeLocker` (`0x71D1D363…f0A7f`). That
  locker is shared by every coin on the platform, so this one almost certainly
  over-counts as written. **Fix this first.**

Sanity-check `/debug`'s `rawTotals` against what thestonks.exchange shows for
the token before pointing the site at the Worker. Adjust `STREAMS` in
`src/config.js`, then `POST /reset` to rescan.

If `rewardsIndex` turns out to be verified on Basescan and exposes a cumulative
total as a view function, a single `eth_call` beats this whole approach — read
it directly and skip the log scan.

## Notes

- `totalFeesCollected` values cumulative fees at the **current** `$STONKEX`
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
