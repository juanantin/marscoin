# Setting this up for a new token

A copy of the STONKEX Strategy site with the indexed figures cleared. Everything
below is what is still token-specific; the rest of the code reads from it.

## 1. Addresses

`config.js`
- `contractAddress`     the token people buy — the CA button copies this
- `rewardTokenAddress`  the token holders are paid in
- `contracts.pool`      the trading pair, used for market cap / liquidity / volume
- `contracts.rewardPool`, `contracts.feeLocker`, `contracts.rewardsIndex`
- `links.x`             the project's X account

`worker/src/config.js`
- the same addresses in `TOKENS` and `CONTRACTS`
- **`START_BLOCK`** — the block the token was deployed in. Leave the old value
  and the backfill either scans a huge empty range or misses history entirely.
- `STREAMS` and `HOLDER_SHARE` encode one assumption: fees arrive at
  `rewardsIndex` in the reward token, and holders receive 90% of what leaves it.
  Check that against the project's own published figures before trusting a
  single number on the page.

## 2. Branding

- `images/` — header video + its poster frame, and `stkstr_icon.png`.
  Regenerate `favicon.ico`, `images/favicon.png` and `images/apple-touch-icon.png`
  from the icon (apple-touch-icon must be flattened onto white).
- `index.html` — `<title>`, the description and OG/Twitter meta, the dashboard
  headline and sub-line, and the tile labels naming the reward token.
- `assets/css/styles.css` — only if the palette changes.
- The two ecosystem lockups at the bottom stay as they are if the token launched
  on the same platform.

## 3. Repo settings

- Add an `RPC_URL` secret (Settings ▸ Secrets ▸ Actions) if you have a private
  Base RPC. Without it the indexer falls back to the public `mainnet.base.org`,
  which is rate-limited and makes the first backfill slow.
- The indexer workflow runs four times an hour and commits `data/rewards.json`
  and `data/rewards-state.json` back to the branch it ran on.

## 4. Verify before launch

Run the page with `?debug=1` to see which source answered for each tile, and
compare the fee and distribution figures against the project's own stats page.
That comparison is what caught two wrong figures on the original build.

`README.md` has the full architecture.
