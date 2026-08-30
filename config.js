/* ==========================================================================
   MARSCOIN — site configuration
   --------------------------------------------------------------------------
   This is the only file you need to edit.
   ========================================================================== */

window.MARSCOIN_CONFIG = {
  /* Build stamp. Shown in the ?debug=1 panel, so you can confirm which version
     a browser actually has rather than guessing at a cache. Bump it together
     with the ?v= on the script tags in index.html whenever you deploy. */
  version: '2026-08-30.3',

  /* ---- Branding -------------------------------------------------------
     The two tickers appear in tile labels and chips. Change them here and
     the dashboard follows; the copy baked into index.html is the only other
     place they are written out. */

  ticker: 'MARSCOIN',        // the token people buy
  rewardTicker: 'SPCX',      // the token holders earn

  /* ---- Token ----------------------------------------------------------

     $MARSCOIN is set; the reward token is not. With only the first filled in:
         · the CA button copies, and the CHART pill links to DexScreener
         · market cap, liquidity, 24h volume and holders all resolve
         · "total fees" and "total $SPCX distributed" stay on an em dash —
           those are protocol figures, so they need sources.rewards below
         · a USD value for distributed rewards cannot be derived until
           rewardTokenAddress is set

     Use the full 42-character 0x… address, checksummed or lowercase. */

  // $MARSCOIN on Base — the token people buy, and the one the CA button copies.
  contractAddress: '0x61199398e8c51d6Cde7d5D2Ff579A3065340826b',

  // $SPCX, the reward token. Used to price "total distributed" in USD when the
  // rewards source doesn't already give a USD figure.
  rewardTokenAddress: '',

  chain: 'base',    // DexScreener chain slug
  chainId: 8453,    // EVM chain id

  /* Related contracts. Optional — the site falls back to a token-wide search
     when a pool address is missing, these just make the lookup exact.
       pool         the $MARSCOIN pool, priced by DexScreener
       rewardPool   the $SPCX pool, used to price distributed rewards
       feeLocker    where trading fees accrue
       rewardsIndex the rewards distributor, i.e. the fee routing target */
  contracts: {
    pool: '',
    rewardPool: '',
    feeLocker: '',
    rewardsIndex: '',
  },

  /* ---- Links ---------------------------------------------------------- */

  links: {
    x: 'https://x.com/marscoin_base',

    // Leave null to auto-build a DexScreener link from the contract address.
    // With no address set either, the CHART pill renders inert rather than
    // linking somewhere broken.
    chart: null,

    // Each ecosystem card's lockup plate links to its partner.
    launchedIn: 'https://www.thestonks.exchange/',
    rewardsBy: 'https://www.stockify.finance/',
  },

  /* ======================================================================
     DATA SOURCES
     Each source fills in the fields it knows about. Later sources win, so
     `rewards` can override anything. Whatever no source provides falls back
     to `stats` below, and anything still missing renders as "—".
     ====================================================================== */

  sources: {

    /* Market cap, liquidity, 24h volume, and the token price.
       Public API, no key, CORS-enabled. */
    dexscreener: {
      enabled: true,
    },

    /* Holder count. DexScreener does not report holders, and no single explorer
       is reliable for a freshly launched token, so the providers below are
       tried IN ORDER and the first one to return a count above zero wins. A
       zero is treated as "no answer" and falls through to the next provider: a
       launched token with liquidity cannot have none. Run the page with
       ?debug=1 to see which provider answered.

         blockscout     — base.blockscout.com. Free, no key. Answers 0 until it
                          has indexed the token.
         geckoterminal  — free, no key. Only has a count for tokens it indexes.
         etherscan      — Etherscan V2 multichain. Needs `etherscanApiKey`, and
                          its tokenholdercount action requires a PAID plan.
         moralis        — needs `moralisApiKey`; the free tier is enough.

       Providers without a key are skipped, so the key-free ones are tried first
       and the rest only engage once you fill a key in.

       ▸ The reliable answer is the indexer in worker/: it counts holders from
         $MARSCOIN transfer history, so it needs no explorer at all. Once it is
         deployed and synced it supplies `holders` through sources.rewards and
         this whole chain becomes a fallback.

       Set `enabled: false` to stop fetching holders here entirely. */
    holders: {
      enabled: true,
      providers: ['blockscout', 'geckoterminal', 'etherscan', 'moralis'],

      blockscoutBase: 'https://base.blockscout.com',
      geckoterminalBase: 'https://api.geckoterminal.com/api/v2',
      etherscanApiKey: '',
      moralisApiKey: '',
    },

    /* Rewards figures — total fees collected and total $SPCX distributed.
       These are protocol numbers, so they come from the project's own API.

       ▸ SET `url` TO THE JSON ENDPOINT that carries the reward totals.
         Pass one URL or an array of them; each is read through `fields` below
         and the first source to yield a number for a metric wins.

       No public explorer exposes these: a browser cannot sum transfer logs
       over Base history, so they need either an endpoint that serves them or
       an indexer. worker/ is that indexer — a Cloudflare Worker that reads the
       totals off Base and serves exactly this shape. Once deployed:
         url: ['https://marscoin-rewards.<you>.workers.dev', 'data/rewards.json'],
       and data/rewards.json stays as the fallback if it is ever down.

       `fields` maps our metric names onto the response. Values are dot-paths,
       so 'data.stats.totalFeesUsd' and 'rewards.0.amount' both work. Several
       common spellings are listed per metric — the first one that resolves to a
       number wins, so you can usually just add yours to the front of the list.

       The endpoint must send permissive CORS headers, since the browser calls
       it directly. If it doesn't, proxy it from your own domain.              */
    rewards: {
      enabled: true,
      // A string, or an array of them — the first source with a number for a
      // metric wins, so put live endpoints in front of the committed file.
      url: 'data/rewards.json',

      fields: {
        totalFeesCollected: [
          'totalFeesCollected', 'totalFeesUsd', 'feesCollectedUsd', 'fees.totalUsd',
          'data.totalFeesCollected', 'stats.totalFeesCollected',
        ],
        totalFeesTokens: ['totalFeesTokens', 'feesTokens', 'data.totalFeesTokens'],
        totalDistributed: [
          'totalDistributed', 'totalRewardsDistributed', 'rewardsDistributed',
          'data.totalDistributed', 'stats.totalDistributed',
        ],
        totalDistributedUsd: [
          'totalDistributedUsd', 'totalRewardsDistributedUsd', 'rewardsDistributedUsd',
          'data.totalDistributedUsd', 'stats.totalDistributedUsd',
        ],
        holders: [
          'holders', 'holderCount', 'totalHolders', 'data.holders', 'stats.holders',
        ],
        marketCap: ['marketCap', 'marketCapUsd', 'data.marketCap'],
        liquidity: ['liquidity', 'liquidityUsd', 'data.liquidity'],
        volume24h: ['volume24h', 'volume24hUsd', 'volumeUsd24h', 'data.volume24h'],
      },
    },
  },

  // How often to refresh, in seconds. 0 disables auto-refresh.
  refreshSeconds: 60,

  /* Tile sparklines. Each refresh appends the values it just read to a short
     history kept in this browser's localStorage, and the line is drawn from
     that. It is this visitor's own record of the numbers, so a fresh browser
     shows no lines until `minPoints` refreshes have happened — nothing is
     seeded, back-filled or invented. Set `enabled: false` to drop them. */
  sparklines: {
    enabled: true,
    minPoints: 4,      // fewer than this and the tile simply has no line
    maxPoints: 60,     // ~1 hour of history at refreshSeconds: 60
  },

  /* ---- Fallbacks ------------------------------------------------------ */
  // Used only where no source supplies a value. Leave a field null and the
  // tile shows "—" rather than a number that isn't real.

  stats: {
    totalFeesCollected: null,
    totalFeesTokens: null,
    totalDistributed: null,
    totalDistributedUsd: null,
    holders: null,
    marketCap: null,
    liquidity: null,
    volume24h: null,
  },

};
