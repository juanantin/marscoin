/* ==========================================================================
   What the indexer watches.
   --------------------------------------------------------------------------
   ⚠ NOT YET FULLY CONFIGURED. $MARSCOIN is set; TOKENS.SPCX,
   CONTRACTS.rewardsIndex and START_BLOCK are still empty, so
   the Worker reports `configured: false` and serves nulls rather than zeros —
   see CONFIGURED at the foot of this file. Fill in the four addresses and the
   launch block, then check /debug after the first sync and confirm which flow
   is "fees collected" versus "distributed" before trusting the numbers.
   worker/README.md walks through it.
   ========================================================================== */

export const CHAIN_ID = 8453;                    // Base

export const TOKENS = {
  // $MARSCOIN — the token people buy
  MARS: '0x61199398e8c51d6Cde7d5D2Ff579A3065340826b',
  // $SPCX — the reward token, 18 decimals
  SPCX: '',
};

export const CONTRACTS = {
  pool: '',
  feeLocker: '',
  // The "rewards" routing target — the contract fees are distributed from
  rewardsIndex: '',
};

// The block $MARSCOIN launched at. Nothing relevant happened before it, so the
// scan starts there rather than at genesis — a backfill from 0 would take days.
export const START_BLOCK = 0;

/* What each stream means, and why it is shaped this way:

   `feesIn` — $SPCX arriving at the rewards contract. That IS "fees collected".
   Watch the rewards contract, NOT the fee locker: on a launchpad the locker is
   shared by every coin on the platform, so pointing at it sums the whole
   platform's fees instead of this token's.

   `paidOut` — everything leaving the rewards contract: the holder payments
   plus the protocol's cut. Not the number the tile wants on its own, which is
   why HOLDER_SHARE below exists.

   `holders` — every $MARSCOIN transfer folded into a running balance per
   address; addresses left holding something are the holder count.

   Check all three against the rewards dashboard for this token after the
   first sync — /debug prints the raw totals. */
/* Share of the outflow that reaches holders. Set it to this token's split as
   the rewards dashboard reports it (0.9 = "90% holders · 10% protocol") — or
   set PROTOCOL_ADDRESS below and the protocol's share is subtracted exactly
   instead, which survives any change to the percentage. */
export const HOLDER_SHARE = 0.9;
export const PROTOCOL_ADDRESS = null;

export function buildStreams(tokens, contracts) {
  const streams = [
    { id: 'feesIn', kind: 'sum', token: tokens.SPCX, to: contracts.rewardsIndex, decimals: 18 },
    { id: 'paidOut', kind: 'sum', token: tokens.SPCX, from: contracts.rewardsIndex, decimals: 18 },
    { id: 'holders', kind: 'balances', token: tokens.MARS, decimals: 18 },
  ];

  if (PROTOCOL_ADDRESS) {
    streams.push({
      id: 'protocolOut', kind: 'sum', token: tokens.SPCX,
      from: contracts.rewardsIndex, to: PROTOCOL_ADDRESS, decimals: 18,
    });
  }
  return streams;
}

export const STREAMS = buildStreams(TOKENS, CONTRACTS);

/** Tokens that actually reached holders. */
export function holderPayout(totals) {
  const paidOut = totals.paidOut ?? 0;
  if (PROTOCOL_ADDRESS) return Math.max(0, paidOut - (totals.protocolOut ?? 0));
  return paidOut * HOLDER_SHARE;
}

/* Addresses that hold supply but are not holders in the sense the tile means:
   the pool itself, the fee locker, the rewards contract. */
export function excludeFromHolders(contracts) {
  return [contracts.pool, contracts.feeLocker, contracts.rewardsIndex]
    .filter(Boolean)
    .map((a) => a.toLowerCase());
}

export const EXCLUDE_FROM_HOLDERS = excludeFromHolders(CONTRACTS);

/* Scan pacing. A Worker run is short, so it takes bites and resumes. Raise
   MAX_CHUNKS_PER_RUN to backfill faster; lower CHUNK_SIZE if the RPC complains
   (it halves automatically anyway). */
export const CHUNK_SIZE = 2000;
export const MAX_CHUNKS_PER_RUN = 60;
export const CONFIRMATIONS = 5;

// Price the token totals in USD. Public, no key.
export const DEX = 'https://api.dexscreener.com/latest/dex/';

export const DEXSCREENER_PAIR = DEX + 'pairs/base/' + CONTRACTS.pool;
export const DEXSCREENER_SPCX_TOKEN = DEX + 'tokens/' + TOKENS.SPCX;

/* ==========================================================================
   Per-deployment resolution
   --------------------------------------------------------------------------
   Everything above is the default. Any of it can be overridden by a wrangler
   [vars] entry (or a secret) of the same name, so one build can be pointed at
   a different token without editing this file:

     TOKEN_MARS  TOKEN_SPCX  POOL  FEE_LOCKER  REWARDS_INDEX  START_BLOCK

   `configured` is false while the essential four are still unset. The Worker
   checks it before scanning, so an unconfigured deployment serves nulls and
   says so rather than publishing a confident row of zeros.
   ========================================================================== */

export function resolveConfig(env = {}) {
  const tokens = {
    MARS: env.TOKEN_MARS || TOKENS.MARS,
    SPCX: env.TOKEN_SPCX || TOKENS.SPCX,
  };

  const contracts = {
    pool: env.POOL || CONTRACTS.pool,
    feeLocker: env.FEE_LOCKER || CONTRACTS.feeLocker,
    rewardsIndex: env.REWARDS_INDEX || CONTRACTS.rewardsIndex,
  };

  const startBlock = Number(env.START_BLOCK ?? START_BLOCK) || 0;
  const streams = buildStreams(tokens, contracts);

  return {
    tokens,
    contracts,
    startBlock,
    streams,
    sumStreams: streams.filter((s) => s.kind !== 'balances'),
    balanceStreams: streams.filter((s) => s.kind === 'balances'),
    exclude: excludeFromHolders(contracts),
    spcxTokenUrl: DEX + 'tokens/' + tokens.SPCX,
    configured: Boolean(tokens.MARS && tokens.SPCX && contracts.rewardsIndex && startBlock > 0),
  };
}

export const CONFIGURED = resolveConfig().configured;
