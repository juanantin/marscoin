#!/usr/bin/env node
/* ==========================================================================
   Reward indexer — GitHub Actions edition
   --------------------------------------------------------------------------
   Same scan logic as worker/, but state lives in the repo instead of KV and
   the output is committed as data/rewards.json — which the site already reads.
   So this needs no Cloudflare account, no KV, no secrets: just Actions.

   Run locally:  RPC_URL=https://mainnet.base.org node scripts/index-rewards.mjs
   ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { indexRange, makeRpc, toNumber, countHolders } from '../worker/src/indexer.js';
import {
  STREAMS, START_BLOCK, CHUNK_SIZE, CONFIRMATIONS, EXCLUDE_FROM_HOLDERS, TOKENS,
  holderPayout, DEXSCREENER_KEX_TOKEN, CONTRACTS,
} from '../worker/src/config.js';
import { tokenPriceUsd } from '../worker/src/price.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'data', 'rewards-state.json');
const OUT_FILE = path.join(ROOT, 'data', 'rewards.json');

const RPC_URL = process.env.RPC_URL || 'https://mainnet.base.org';
// A run is bounded by wall clock, not chunk count: Actions bills by the minute
// and a backfill can always finish on the next run.
const BUDGET_MS = Number(process.env.BUDGET_MS || 8 * 60 * 1000);

/* Public RPCs rate-limit hard during a backfill. Retry those rather than
   losing the run, since a lost run means a lost scan window. */
function retrying(rpc, tries = 5) {
  return async function (method, params) {
    let wait = 800;
    for (let i = 0; ; i++) {
      try {
        return await rpc(method, params);
      } catch (err) {
        const m = String(err.message || err);
        const transient = /429|rate|timeout|ETIMEDOUT|ECONNRESET|502|503|504/i.test(m);
        if (!transient || i >= tries - 1) throw err;
        process.stdout.write(`  ${m} — retrying in ${wait}ms\n`);
        await new Promise((r) => setTimeout(r, wait));
        wait *= 2;
      }
    }
  };
}

const SUM_STREAMS = STREAMS.filter((s) => s.kind !== 'balances');
const BALANCE_STREAMS = STREAMS.filter((s) => s.kind === 'balances');

const readJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
};

function loadState() {
  const s = readJson(STATE_FILE, null);
  return s || { cursor: START_BLOCK, totals: {}, balances: {}, head: null, updatedAt: null };
}

function holderCount(balances) {
  const kept = {};
  for (const a in balances) if (!EXCLUDE_FROM_HOLDERS.includes(a)) kept[a] = balances[a];
  return countHolders(kept);
}

/** Market cap, liquidity and 24h volume for the pool. Null on any failure. */
async function pairStats() {
  try {
    const res = await fetch(
      'https://api.dexscreener.com/latest/dex/pairs/base/' + CONTRACTS.pool,
      { headers: { accept: 'application/json' } });
    if (!res.ok) return {};
    const d = await res.json();
    const p = (d && d.pair) || (d && d.pairs && d.pairs[0]);
    if (!p) return {};
    const n = (v) => (isFinite(parseFloat(v)) ? parseFloat(v) : null);
    return {
      marketCap: n(p.marketCap) ?? n(p.fdv),
      liquidity: p.liquidity ? n(p.liquidity.usd) : null,
      volume24h: p.volume ? n(p.volume.h24) : null,
    };
  } catch { return {}; }
}

async function main() {
  const started = Date.now();
  const rpc = retrying(makeRpc(RPC_URL));
  const state = loadState();

  const head = parseInt(await rpc('eth_blockNumber'), 16) - CONFIRMATIONS;
  if (!isFinite(head) || head <= 0) throw new Error('bad head block from ' + RPC_URL);

  const totals = {};
  SUM_STREAMS.forEach((s) => { totals[s.id] = BigInt(state.totals?.[s.id] || '0'); });
  const balances = { ...(state.balances || {}) };

  const startCursor = state.cursor;
  let cursor = state.cursor;
  let passes = 0;
  let scanError = null;

  // Keep scanning until caught up or out of time. Whatever is scanned before a
  // failure is still banked below, so a flaky RPC costs a window, not the run.
  try {
    while (cursor <= head && Date.now() - started < BUDGET_MS) {
      const res = await indexRange({
        rpc, streams: STREAMS, from: cursor, to: head,
        chunkSize: CHUNK_SIZE, maxChunks: 40,
        stopOnError: true,          // keep the chunks that landed
      });
      if (res.error) scanError = res.error;

      SUM_STREAMS.forEach((s) => { totals[s.id] += res.totals[s.id]; });
      for (const s of BALANCE_STREAMS) {
        for (const [addr, delta] of Object.entries(res.balances[s.id])) {
          const next = BigInt(balances[addr] || '0') + delta;
          if (next === 0n) delete balances[addr]; else balances[addr] = next.toString();
        }
      }

      if (res.cursor === cursor) break;          // no progress; don't spin
      cursor = res.cursor;
      passes++;
      process.stdout.write(`  scanned to ${cursor - 1} (${head - cursor + 1} behind)\n`);
      if (res.error) break;                      // banked what we could; stop here
    }
  } catch (err) {
    scanError = err;
    console.error('  scan stopped:', err.message);
  }

  const complete = cursor > head;
  const [kex, market] = await Promise.all([tokenPriceUsd(DEXSCREENER_KEX_TOKEN, TOKENS.KEX), pairStats()]);

  // feesIn is what reached the rewards contract; holderPayout strips the
  // protocol's cut off the outflow so "distributed" means paid to holders.
  const asTokens = {};
  SUM_STREAMS.forEach((st) => { asTokens[st.id] = toNumber(totals[st.id], st.decimals); });
  const feesIn = asTokens.feesIn ?? 0;
  const distributed = holderPayout(asTokens);
  const holders = holderCount(balances);

  const prev = readJson(OUT_FILE, {});

  fs.writeFileSync(STATE_FILE, JSON.stringify({
    cursor, head, complete, passes,
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v.toString()])),
    balances,
    updatedAt: new Date().toISOString(),
  }, null, 0) + '\n');

  // Preserve the doc block so the file stays self-explanatory.
  fs.writeFileSync(OUT_FILE, JSON.stringify({
    ...(prev.__doc ? { __doc: prev.__doc } : {}),
    totalDistributed: complete ? distributed : null,
    totalDistributedUsd: complete && kex != null ? distributed * kex : null,
    totalFeesCollected: complete && kex != null ? feesIn * kex : null,
    // The same fees in $STONKEX, so the tile can show the token amount next to
    // the dollar figure without depending on the price lookup succeeding.
    totalFeesTokens: complete ? feesIn : null,
    holders: complete ? holders : null,
    marketCap: market.marketCap ?? null,
    liquidity: market.liquidity ?? null,
    volume24h: market.volume24h ?? null,
    updatedAt: new Date().toISOString(),
    meta: {
      synced: complete, blocksBehind: Math.max(0, head - cursor + 1),
      kexPriceUsd: kex,
    },
  }, null, 2) + '\n');

  console.log(complete
    ? `synced · fees ${feesIn.toFixed(2)} KEX · to holders ${distributed.toFixed(2)} KEX · holders ${holders}`
    : `partial · ${head - cursor + 1} blocks behind · continues next run`);

  // Advancing the cursor at all is progress worth committing, so only fail the
  // job when a run achieved nothing — otherwise the commit step is skipped and
  // the scan window is thrown away.
  if (scanError && cursor === startCursor) throw scanError;
}

main().catch((err) => { console.error('indexer failed:', err.message); process.exit(1); });
