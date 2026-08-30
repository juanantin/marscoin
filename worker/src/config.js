/* ==========================================================================
   What the indexer watches.
   --------------------------------------------------------------------------
   ⚠ The addresses below come from thestonks.exchange's own APIs, but which
   flow represents "fees collected" versus "distributed" has NOT been confirmed
   against the contracts. Check /debug after the first sync and adjust before
   trusting the numbers — see worker/README.md.
   ========================================================================== */

export const CHAIN_ID = 8453;                    // Base

export const TOKENS = {
  // $STONKEXSTR — the token people buy
  STR: '0x80081d759E5e0154fB15D5ee8De5085D89E3dCcC',
  // $STONKEX — the reward token, 18 decimals
  KEX: '0x5ab000ff9B9FfE0349CE5ffA5fD86f217C3680F5',
};

export const CONTRACTS = {
  pool: '0x550b95fcb0e309c552FAe9670b1A514D443CA463',
  feeLocker: '0x71D1D363176723f85d98B8B430DF33cde89f0A7f',
  // /api/fee-routing reports this token routes to "rewards" via this contract
  rewardsIndex: '0xf01a4dabfd54d1A6a1812a95F7151e8DA851DE2E',
};

// The block $STONKEXSTR launched at, per /api/coins. Nothing relevant happened
// before it, so the scan starts here rather than at genesis.
export const START_BLOCK = 50530608;

/* Verified against Stockify's own panel for this token
   (stockify.finance, contract 0xf01a4dab…51DE2E), which reported:

     fees collected   77,671.73 STONKEX  ($125)
     paid to holders  69,904.56 STONKEX  ($113)   ← exactly 90% of the above
     split            90% holders · 10% protocol · 0% creator
     waiting          0 STONKEX

   `feesIn` — $STONKEX arriving at the rewards contract. That IS "fees
   collected". It previously watched the fee locker, which every coin on the
   platform shares, so it was summing the whole platform's fees: 3,548,527
   STONKEX against a true 77,672.

   `paidOut` — everything leaving the rewards contract: the holder payments
   plus the protocol's 10%. Not the number the tile wants on its own.

   `holders` — every $STONKEXSTR transfer folded into a running balance per
   address; addresses left holding something are the holder count. */
export const STREAMS = [
  { id: 'feesIn', kind: 'sum', token: TOKENS.KEX, to: CONTRACTS.rewardsIndex, decimals: 18 },
  { id: 'paidOut', kind: 'sum', token: TOKENS.KEX, from: CONTRACTS.rewardsIndex, decimals: 18 },
  { id: 'holders', kind: 'balances', token: TOKENS.STR, decimals: 18 },
];

/* Share of the outflow that reaches holders, from Stockify's "TO HOLDERS 90% ·
   10% protocol · 0% creator". Update it if that split ever changes — or set
   PROTOCOL_ADDRESS below and the protocol's share is subtracted exactly
   instead, which survives any change to the percentage. */
export const HOLDER_SHARE = 0.9;
export const PROTOCOL_ADDRESS = null;

if (PROTOCOL_ADDRESS) {
  STREAMS.push({
    id: 'protocolOut', kind: 'sum', token: TOKENS.KEX,
    from: CONTRACTS.rewardsIndex, to: PROTOCOL_ADDRESS, decimals: 18,
  });
}

/** Tokens that actually reached holders. */
export function holderPayout(totals) {
  const paidOut = totals.paidOut ?? 0;
  if (PROTOCOL_ADDRESS) return Math.max(0, paidOut - (totals.protocolOut ?? 0));
  return paidOut * HOLDER_SHARE;
}

/* Addresses that hold supply but are not holders in the sense the tile means:
   the pool itself, the fee locker, the rewards contract. */
export const EXCLUDE_FROM_HOLDERS = [
  CONTRACTS.pool,
  CONTRACTS.feeLocker,
  CONTRACTS.rewardsIndex,
].map((a) => a.toLowerCase());

/* Scan pacing. A Worker run is short, so it takes bites and resumes. Raise
   MAX_CHUNKS_PER_RUN to backfill faster; lower CHUNK_SIZE if the RPC complains
   (it halves automatically anyway). */
export const CHUNK_SIZE = 2000;
export const MAX_CHUNKS_PER_RUN = 60;
export const CONFIRMATIONS = 5;

// Price the token totals in USD. Public, no key.
export const DEXSCREENER_PAIR =
  'https://api.dexscreener.com/latest/dex/pairs/base/' + CONTRACTS.pool;
export const DEXSCREENER_KEX_TOKEN =
  'https://api.dexscreener.com/latest/dex/tokens/' + TOKENS.KEX;
