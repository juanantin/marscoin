# MARSCOIN

Single-page site for **MARSCOIN** — buy `$MARSCOIN`, get `$SPCX`.
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

- **Link bar** — X and chart as icon-only pills, plus a contract-address button
  that copies the CA to the clipboard and flashes a `COPIED!` confirmation.
- **Hero** — the animated MARSCOIN banner, looping silently. The poster is
  the clip's own first frame, so poster → playback is seamless. Viewers with
  `prefers-reduced-motion: reduce` get the poster as a still and the video never
  downloads.
- **Dashboard** — six live tiles: total `$SPCX` distributed (tokens plus its
  USD value), total fees collected (USD plus the same figure in `$SPCX`),
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
| Total $SPCX distributed | project rewards API | **needs `sources.rewards.url`** |

### Addresses

**None are set yet.** Every address in `config.js` is an empty string, so the CA
button reports `NO ADDRESS SET`, the chart pill is inert, and every market tile
shows an em dash. Nothing on the page invents a figure in the meantime.

Fill these in — `config.js` for the site, `worker/src/config.js` (or wrangler
`[vars]`) for the indexer:

| | `config.js` | `worker/src/config.js` |
|---|---|---|
| `$MARSCOIN` — the token people buy | `contractAddress` | `TOKENS.MARS` |
| `$SPCX` — the reward token | `rewardTokenAddress` | `TOKENS.SPCX` |
| Pool, priced by DexScreener | `contracts.pool` | `CONTRACTS.pool` |
| Fee locker | `contracts.feeLocker` | `CONTRACTS.feeLocker` |
| Rewards index — the distributor | `contracts.rewardsIndex` | `CONTRACTS.rewardsIndex` |
| Launch block | — | `START_BLOCK` |

Match the reward token on its **address**, not its symbol: ticker collisions are
common, and the wrong one silently prices every reward figure wrong.

### Market data — DexScreener

The known pool is queried first — `GET /latest/dex/pairs/base/<pool>` — falling
back to the token search, `GET /latest/dex/tokens/<contract>`. Public, no key,
CORS-enabled.

Pool-first matters here: `$MARSCOIN` trades against `$SPCX` rather than a
usual quote, and the token search can come back empty for a pair like that while
the pool itself resolves fine. Of any list of pairs, the deepest-liquidity one on
`chain` wins; `marketCap` is preferred over `fdv`. Pool addresses live in
`contracts`, or override with `sources.dexscreener.pairAddress`.

### Holders — Blockscout

DexScreener does not report holder counts, and no single explorer is dependable
for a token this new — Blockscout was answering `0` for `$MARSCOIN`, which just
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
holders from `$MARSCOIN` transfer history — every transfer folded into a
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

Fees collected and `$SPCX` distributed are protocol figures. No explorer
knows them, so they have to be fed in. Three ways, cheapest first.

**1. Edit the committed file.** `sources.rewards.url` already points at
`data/rewards.json`. Put numbers in it, push, done — same origin, no CORS, no
infrastructure:

```json
{ "totalFeesCollected": 1284.37, "totalDistributed": 8412906.5 }
```

Leave `totalDistributedUsd` out and it is derived from the live `$SPCX`
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

It scans `eth_getLogs` for `$SPCX` Transfer events, filtered by counterparty,
from the token's launch block (`START_BLOCK`) forward — so the range is bounded,
not all of chain history. Each run takes a bite, banks running totals in KV, and
saves its cursor, so backfill is just several runs. Only the standard Transfer
event is used, meaning none of it needs the rewards contract's ABI.

Deploy instructions, routes and tests are in [`worker/README.md`](worker/README.md).
Once it is up:

```js
url: ['https://marscoin-rewards.<you>.workers.dev', 'data/rewards.json'],
```

The streams were verified against Stockify's own panel for this token and now
agree to the cent:

| | Stockify | Indexer |
|---|---|---|
| Fees collected | 77,671.73 SPCX | 77,671.73 |
| Paid to holders | 69,904.56 SPCX | 69,904.56 |

Two things were wrong before that check. `feesIn` watched the platform's fee
locker, which **every** coin on thestonks.exchange shares, so it summed the whole
platform: 3,548,527 SPCX against a true 77,672. And "distributed" summed
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
✓ ok     dexscreener:pair:0x…
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

## Deploying

`index.html` loads the stylesheet, `config.js` and `app.js` with a `?v=` query,
and a CDN keys its cache on the full URL. **Change any of them without changing
that query and browsers keep serving the old file** — the change is pushed,
deployed, and invisible. So make this the last step before every deploy:

```bash
node scripts/stamp.mjs        # today's date, next free suffix
```

It rewrites every `?v=` in `index.html` and the matching `version:` in
`config.js`, so the `?debug=1` panel names the build the browser actually has.

## Running it

Any static host works — GitHub Pages, Netlify, Vercel, Cloudflare Pages, S3. Locally:

```bash
python3 -m http.server 8000
```

then open <http://localhost:8000>. (Clipboard copy needs `https://` or `localhost`;
the page falls back to `execCommand` elsewhere.)

## Notes

- Dark theme only, by design — the brand artwork is built for a black ground.
  Type is JetBrains Mono throughout the chrome, Inter for the fine print.
- The link bar's X and chart pills are icon-only — each carries an `aria-label`,
  so nothing is lost to a screen reader. The CA pill keeps its text, since the
  address is the content.
- Both ecosystem cards pair a photograph (`images/launch.png`, `images/dome.png`)
  with the partner's own lockup on a plate; the plate is the link, and its URL
  comes from `links.launchedIn` / `links.rewardsBy` in `config.js`.
  The photo is a fixed-width panel rather than a full-bleed background: the
  source images are square, and covering the whole card cropped them to a strip.
  It is masked on its right edge so it dissolves into the card.
- `images/stonkex_button_dark.png` is the supplied `stonkex_button.png` with its
  "STONKS" wordmark lifted from `#2b3347` to near-white. That ink was darkened
  for the old white page and sat at 1.4:1 on this one — effectively invisible.
  The icon tile and the blue `.EXCHANGE` are untouched, and the original file is
  kept as-is.
- `favicon.ico`, `images/favicon.png`, `images/apple-touch-icon.png` and the two
  manifest icons are all generated from `images/marscoin_logo.png`, cropped to
  the artwork's own bounds. Regenerate them together if the mark changes
  (apple-touch-icon is flattened onto white — iOS renders transparency as black).
- `images/marscoin_header.mp4` is the hero clip. It is **768×384**, so it is
  upscaled roughly 2.5× on a desktop retina screen and looks soft there —
  re-export at 1536×768 or larger and drop it in if you want it crisp. It plays
  at **half speed**: the rate is set through `defaultPlaybackRate`, because the
  media load algorithm resets `playbackRate` to it on `load()`.
  `images/marscoin_og.jpg` is the 1200×630 Open Graph share image, cut from the
  clip's first frame.
- The hero copy sits over the planet from 760px up, and drops beneath the clip
  below that, where there is no room to overlay it legibly.
- Tile sparklines are drawn from a short history the browser keeps in
  `localStorage` as the dashboard polls — this visitor's own record of the
  figures. Nothing is seeded or back-filled, so a fresh browser shows no lines
  until `sparklines.minPoints` refreshes have happened.
- On mobile the hero runs edge to edge, the dashboard drops to two tiles per row, and
  the ecosystem blocks stack. Tested at 390px wide with no horizontal overflow.
