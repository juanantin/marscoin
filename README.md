# STONKEX Strategy

Single-page site for **Stonk Exchange Strategy** — buy `$STONKEXSTR`, get `$STONKEX`.
1B total supply on Base chain.

Static HTML/CSS/JS. No build step, no dependencies, no framework.

```
index.html            markup
config.js             ← the only file you need to edit
assets/css/styles.css
assets/js/app.js
images/               branding
```

## What's on the page

- **Link bar** — X, chart, and a contract-address button that copies the CA to the
  clipboard and flashes a `COPIED!` confirmation.
- **Hero** — the animated STONKEX Strategy banner, looping silently. The poster is
  the clip's own first frame, so poster → playback is seamless. Viewers with
  `prefers-reduced-motion: reduce` get the poster as a still and the video never
  downloads.
- **Dashboard** — six live tiles: total `$STONKEX` distributed (tokens plus its
  USD value), total fees collected (USD plus the same figure in `$STONKEX`),
  total holders, market cap, liquidity and 24h volume. Values blink a `…`
  placeholder until the first load resolves.
- **Ecosystem** — the [The Stonks Exchange](https://www.thestonks.exchange/) and
  [Stockify](https://www.stockify.finance/) lockups, each one the link itself.

## Data sources

Everything configurable lives in `config.js`. Each source fills in the fields it
knows about and they merge in order, so a later source overrides an earlier one.
Whatever no source provides falls back to `stats`, and anything still missing
renders as `—` rather than as a number that isn't real.

| Metric | Source | Status |
|---|---|---|
| Market cap, liquidity, 24h volume | DexScreener | live, no key |
| Holders | Blockscout → Routescan → … | live, no key |
| Total fees collected | project rewards API | **needs `sources.rewards.url`** |
| Total $STONKEX distributed | project rewards API | **needs `sources.rewards.url`** |

### Addresses

| | |
|---|---|
| `$STONKEXSTR` | `0x80081d759E5e0154fB15D5ee8De5085D89E3dCcC` |
| `$STONKEX` (reward token) | `0x5ab000ff9B9FfE0349CE5ffA5fD86f217C3680F5` |
| Pool | `0x550b95fcb0e309c552FAe9670b1A514D443CA463` |
| Fee locker | `0x71D1D363176723f85d98B8B430DF33cde89f0A7f` |
| Rewards index | `0xf01a4dabfd54d1A6a1812a95F7151e8DA851DE2E` |

The reward token is the `quote` side of this token's pair in `/api/coins`, where
the same address is listed as "The Stonks Exchange" (STONKEX) — note a second,
earlier token also carries that name, so match on the address, not the symbol.

### Market data — DexScreener

The known pool is queried first — `GET /latest/dex/pairs/base/<pool>` — falling
back to the token search, `GET /latest/dex/tokens/<contract>`. Public, no key,
CORS-enabled.

Pool-first matters here: `$STONKEXSTR` trades against `$STONKEX` rather than a
usual quote, and the token search can come back empty for a pair like that while
the pool itself resolves fine. Of any list of pairs, the deepest-liquidity one on
`chain` wins; `marketCap` is preferred over `fdv`. Pool addresses live in
`contracts`, or override with `sources.dexscreener.pairAddress`.

### Holders — Blockscout

DexScreener does not report holder counts, and no single explorer is dependable
for a token this new — Blockscout was answering `0` for `$STONKEXSTR`, which just
means it hadn't indexed the holders yet.

So `sources.holders.providers` lists several, tried **in order**, and the first
to return a count above zero wins:

| Provider | Key | Notes |
|---|---|---|
| `blockscout` | none | `base.blockscout.com`. Reads `holders_count`, `holders`, then `token_holders_count` on `…/counters`. Has not indexed this token — answered `0`, then errors |
| `geckoterminal` | none | Token info route. Only has a count for tokens it has indexed |
| `etherscan` | `etherscanApiKey` | Etherscan V2 multichain. Its `tokenholdercount` action needs a **paid** plan |
| `moralis` | `moralisApiKey` | Free tier is enough |

**The dependable answer is [`worker/`](worker/), not any of these.** It counts
holders from `$STONKEXSTR` transfer history — every transfer folded into a
running balance per address, then addresses with a positive balance counted,
with the pool and fee contracts excluded. No explorer involved, so nothing to
guess at. Once it is deployed and synced it supplies `holders` through
`sources.rewards` and this chain becomes a fallback. The count is withheld until
the backfill finishes, since a partial scan under-counts.

**A zero is treated as no answer** and falls through to the next provider — a
launched token with liquidity cannot have zero holders, so a zero is an
un-indexed explorer, not data. Providers with no key configured are skipped, so
the two key-free ones run first and the rest only engage once you add a key.

Run with `?debug=1` to see which provider answered.

### Rewards — feeding fees and distribution

Fees collected and `$STONKEX` distributed are protocol figures. No explorer
knows them, so they have to be fed in. Three ways, cheapest first.

**1. Edit the committed file.** `sources.rewards.url` already points at
`data/rewards.json`. Put numbers in it, push, done — same origin, no CORS, no
infrastructure:

```json
{ "totalFeesCollected": 1284.37, "totalDistributed": 8412906.5 }
```

Leave `totalDistributedUsd` out and it is derived from the live `$STONKEX`
price. Any field left `null` shows as an em dash, so the file is safe to publish
half-filled. Fine for a launch; it is a manual number, so it goes stale between
pushes.

**2. Ask Stockify.** Stockify runs the rewards for this token — its own listing
mentions "20k already distributed", so it tracks these numbers. If they expose an
endpoint, that is the correct source and the least work:

```js
url: ['https://<stockify-endpoint>', 'data/rewards.json'],
```

The array is a fallback chain: the endpoint answers when it can, the file covers
it when it doesn't. Add the response's own key names to the front of the matching
list in `sources.rewards.fields` if they differ from the ones already there.

**3. Let GitHub Actions index it — no accounts, no infrastructure.**
[`.github/workflows/index-rewards.yml`](.github/workflows/index-rewards.yml)
runs [`scripts/index-rewards.mjs`](scripts/index-rewards.mjs) every 15 minutes,
scans Base, and commits the refreshed `data/rewards.json` — the file the site
already reads. It also counts holders, so that stops depending on explorers too.

Nothing to set up: enable Actions on the repo and it runs. State lives in
`data/rewards-state.json`, so each run resumes where the last stopped and a first
backfill finishes over a few runs. Optionally set an `RPC_URL` secret to a
private Base endpoint — the public one works but rate-limits, which only means
the backfill takes longer. `workflow_dispatch` lets you trigger a run by hand.

**4. Or run it as a Cloudflare Worker — [`worker/`](worker/).** Same scan logic,
serving over HTTP instead of committing a file. Better if you want sub-minute
freshness or would rather not commit state to the repo.

It scans `eth_getLogs` for `$STONKEX` Transfer events, filtered by counterparty,
from the token's launch block (**50530608**) forward — so the range is bounded,
not all of chain history. Each run takes a bite, banks running totals in KV, and
saves its cursor, so backfill is just several runs. Only the standard Transfer
event is used, meaning none of it needs the rewards contract's ABI.

Deploy instructions, routes and tests are in [`worker/README.md`](worker/README.md).
Once it is up:

```js
url: ['https://stonkex-rewards.<you>.workers.dev', 'data/rewards.json'],
```

The streams were verified against Stockify's own panel for this token and now
agree to the cent:

| | Stockify | Indexer |
|---|---|---|
| Fees collected | 77,671.73 STONKEX | 77,671.73 |
| Paid to holders | 69,904.56 STONKEX | 69,904.56 |

Two things were wrong before that check. `feesIn` watched the platform's fee
locker, which **every** coin on thestonks.exchange shares, so it summed the whole
platform: 3,548,527 STONKEX against a true 77,672. And "distributed" summed
everything leaving the rewards contract, which is fees collected, not the
holders' share — the two differ by the protocol's 10%.

`HOLDER_SHARE` in `worker/src/config.js` carries that 90/10 split, read off
Stockify's own "TO HOLDERS 90% · 10% protocol · 0% creator". If the split ever
changes, update it — or set `PROTOCOL_ADDRESS` and the cut is subtracted exactly
instead, which survives any change to the percentage.

And check the index contract on Basescan first: if it is verified and exposes a
cumulative total as a view function, one `eth_call` replaces the whole log scan.

### Debugging

Append `?debug=1` to the URL. A panel under the dashboard lists every source and
what it returned, and the same detail goes to the console:

```
✓ ok     dexscreener:pair:0x550b95fc…
· empty  holders:blockscout
✓ ok     holders:blockscout:counters
```

Reading it:

- **`Failed to fetch`** — CORS, a blocked host, or the page opened over `file://`.
  Serve it over `http://` (see Running it) rather than double-clicking the file.
- **`HTTP 404`** — wrong address or route.
- **`ok, empty`** — the request worked but that source has nothing for this
  token; the next fallback takes over.

If a tile shows `—`, no source produced a number for it. That is the intended
behaviour, not a bug: nothing invented is shown as real.

`refreshSeconds` controls the poll interval (default 60).

## Deploying

`index.html` loads `config.js` and `app.js` with a `?v=` cache buster, and
`config.js` carries a matching `version`. **Bump both on every deploy** — a CDN
will otherwise keep serving the previous JS for hours after the HTML updates,
which looks exactly like a push that never landed.

To check what a browser actually has, load the site with `?debug=1`: the first
line of the panel is the build stamp. If it is not the version you just pushed,
the problem is the deploy or a cache, not the code — hard-refresh, purge the
CDN, and confirm the host is building the right branch.

## Running it

Any static host works — GitHub Pages, Netlify, Vercel, Cloudflare Pages, S3. Locally:

```bash
python3 -m http.server 8000
```

then open <http://localhost:8000>. (Clipboard copy needs `https://` or `localhost`;
the page falls back to `execCommand` elsewhere.)

## Notes

- Light theme only, by design — the brand artwork is built for a white ground.
- Both ecosystem lockups sit on the same white plate at a matched size. The
  Stonks.Exchange wordmark shipped near-white (built for a dark background), so
  `images/stonkex_button.png` has had that wordmark recoloured dark — the icon and
  the blue `.EXCHANGE` are untouched. Swap in an official light-background lockup
  if Stonks.Exchange publishes one.
- `favicon.png` and `apple-touch-icon.png` are generated from
  `images/stkstr_icon.png`. Regenerate them together if the mark changes
  (apple-touch-icon is flattened onto white — iOS renders transparency as black).
  `images/logo.png` came from the same source and is kept unused, in case the
  mark ever returns to the link bar.
- `images/stonkex_header.mp4` is the source clip stripped of its audio track and
  re-encoded (2.2MB → 627KB). It is **768×384**, so it is upscaled roughly 2.5× on a
  desktop retina screen and looks soft there — re-export at 1536×768 or larger and
  drop it in if you want it crisp. `images/stonkex_header.png` is kept only as the
  Open Graph share image.
- On mobile the hero runs edge to edge, the dashboard drops to two tiles per row, and
  the ecosystem blocks centre. Tested at 390px wide with no horizontal overflow.
