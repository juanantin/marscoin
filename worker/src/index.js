/* ==========================================================================
   SPCX rewards indexer — Cloudflare Worker
   --------------------------------------------------------------------------
   cron  → indexes forward from the saved cursor, banking totals in KV
   GET /        → the JSON the site reads (same shape as data/rewards.json)
   GET /debug   → sync state: cursor, head, blocks behind, raw stream totals
   POST /reset  → clear state and rescan from START_BLOCK (needs ADMIN_TOKEN)
   ========================================================================== */

import { indexRange, makeRpc, toNumber, countHolders } from './indexer.js';
import {
  CHUNK_SIZE, MAX_CHUNKS_PER_RUN, CONFIRMATIONS, holderPayout, resolveConfig,
} from './config.js';
import { tokenPriceUsd } from './price.js';

const STATE_KEY = 'state:v1';
const BALANCES_KEY = 'balances:v1';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Short edge cache: the cron writes at most once a minute anyway.
      'cache-control': 'public, max-age=30',
      ...CORS,
      ...extraHeaders,
    },
  });
}

async function loadState(env, cfg) {
  const raw = await env.MARSCOIN.get(STATE_KEY, 'json');
  if (!raw) return { cursor: cfg.startBlock, totals: {}, updatedAt: null, lastError: null };
  return raw;
}

async function saveState(env, state) {
  await env.MARSCOIN.put(STATE_KEY, JSON.stringify(state));
}

/** Totals live in KV as decimal strings — JSON has no BigInt. */
function totalsToBigInt(totals, sumStreams) {
  const out = {};
  sumStreams.forEach((s) => { out[s.id] = BigInt((totals && totals[s.id]) || '0'); });
  return out;
}

/* Balances are a per-address running map, kept across runs. Each scan returns
   deltas for the blocks it covered, which are added in here. */
async function loadBalances(env) {
  return (await env.MARSCOIN.get(BALANCES_KEY, 'json')) || {};
}

function mergeDeltas(stored, deltas) {
  for (const addr in deltas) {
    const next = BigInt(stored[addr] || '0') + deltas[addr];
    if (next === 0n) delete stored[addr];        // keep the map from growing forever
    else stored[addr] = next.toString();
  }
  return stored;
}

function holderCount(balances, exclude) {
  const filtered = {};
  for (const a in balances) {
    if (exclude.indexOf(a) === -1) filtered[a] = balances[a];
  }
  return countHolders(filtered);
}

function totalsToStrings(totals) {
  const out = {};
  Object.keys(totals).forEach((k) => { out[k] = totals[k].toString(); });
  return out;
}

/** $SPCX price in USD, or null. Never fatal — the totals matter more. */
function spcxPriceUsd(cfg, fetchImpl) {
  return tokenPriceUsd(cfg.spcxTokenUrl, cfg.tokens.SPCX, fetchImpl);
}

async function sync(env, ctx, cfg) {
  const rpc = makeRpc(env.RPC_URL);
  const state = await loadState(env, cfg);

  const head = parseInt(await rpc('eth_blockNumber'), 16) - CONFIRMATIONS;
  if (!isFinite(head) || head <= 0) throw new Error('bad head block');

  const running = totalsToBigInt(state.totals, cfg.sumStreams);
  let balances = cfg.balanceStreams.length ? await loadBalances(env) : null;

  if (state.cursor <= head) {
    const res = await indexRange({
      rpc,
      streams: cfg.streams,
      from: state.cursor,
      to: head,
      chunkSize: CHUNK_SIZE,
      maxChunks: MAX_CHUNKS_PER_RUN,
    });

    cfg.sumStreams.forEach((s) => { running[s.id] += res.totals[s.id]; });
    cfg.balanceStreams.forEach((s) => { balances = mergeDeltas(balances, res.balances[s.id]); });

    state.cursor = res.cursor;
    state.complete = res.complete;
    state.chunksLastRun = res.chunksUsed;

    if (balances) await env.MARSCOIN.put(BALANCES_KEY, JSON.stringify(balances));
  }

  state.holders = balances ? holderCount(balances, cfg.exclude) : null;
  state.addressesTracked = balances ? Object.keys(balances).length : null;
  state.totals = totalsToStrings(running);
  state.head = head;
  state.updatedAt = new Date().toISOString();
  state.lastError = null;

  await saveState(env, state);
  return state;
}

/** Shape the site expects. Unknown values stay null so tiles show a dash. */
function present(state, spcx, cfg) {
  const totals = totalsToBigInt(state.totals, cfg.sumStreams);
  const byId = {};
  cfg.sumStreams.forEach((s) => { byId[s.id] = toNumber(totals[s.id], s.decimals); });

  const feesIn = byId.feesIn ?? 0;
  const feesUsd = spcx != null ? feesIn * spcx : null;
  // Strip the protocol's cut off the outflow, so "distributed" is what holders
  // actually received rather than everything that left the contract.
  const distributed = holderPayout(byId);

  return {
    totalDistributed: distributed,
    totalDistributedUsd: spcx != null ? distributed * spcx : null,
    // Cumulative fees valued at the CURRENT price, not the price at the time of
    // each transfer. Good enough for a headline figure; say so if it matters.
    totalFeesCollected: feesUsd,
    // Same fees expressed in $SPCX, for the token chip beside the dollars.
    totalFeesTokens: feesIn,

    // Counted from transfers, so no explorer is involved. Only trustworthy once
    // the backfill has finished — a partial scan under-counts.
    holders: state.complete ? (state.holders ?? null) : null,

    updatedAt: state.updatedAt,
    meta: {
      configured: true,
      synced: !!state.complete,
      blocksBehind: state.head && state.cursor ? Math.max(0, state.head - state.cursor + 1) : null,
      spcxPriceUsd: spcx,
    },
  };
}

export default {
  async scheduled(event, env, ctx) {
    const cfg = resolveConfig(env);
    // No token addresses yet — a scan would sum an empty filter and bank zeros.
    if (!cfg.configured) return;
    ctx.waitUntil(sync(env, ctx, cfg).catch(async (err) => {
      const state = await loadState(env, cfg);
      state.lastError = String(err && err.message || err);
      state.updatedAt = new Date().toISOString();
      await saveState(env, state);
    }));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cfg = resolveConfig(env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/reset' && request.method === 'POST') {
      const auth = request.headers.get('authorization') || '';
      if (!env.ADMIN_TOKEN || auth !== 'Bearer ' + env.ADMIN_TOKEN) {
        return json({ error: 'unauthorized' }, 401);
      }
      await env.MARSCOIN.delete(STATE_KEY);
      await env.MARSCOIN.delete(BALANCES_KEY);
      return json({ ok: true, message: 'state cleared; next cron rescans from ' + cfg.startBlock });
    }

    if (!cfg.configured) {
      return json({
        error: 'not configured',
        message: 'Set TOKENS.MARS, TOKENS.SPCX, CONTRACTS.rewardsIndex and ' +
                 'START_BLOCK in worker/src/config.js, then redeploy.',
        // The site reads these keys; null keeps the tiles on a dash rather
        // than printing a zero that looks like a real total.
        totalDistributed: null,
        totalDistributedUsd: null,
        totalFeesCollected: null,
        totalFeesTokens: null,
        holders: null,
        updatedAt: null,
        meta: { configured: false, synced: false, blocksBehind: null, spcxPriceUsd: null },
      }, 200, { 'cache-control': 'no-store' });
    }

    const state = await loadState(env, cfg);

    if (url.pathname === '/debug') {
      return json({
        cursor: state.cursor,
        head: state.head ?? null,
        blocksBehind: state.head ? Math.max(0, state.head - state.cursor + 1) : null,
        synced: !!state.complete,
        chunksLastRun: state.chunksLastRun ?? null,
        updatedAt: state.updatedAt,
        lastError: state.lastError,
        startBlock: cfg.startBlock,
        holders: state.holders ?? null,
        addressesTracked: state.addressesTracked ?? null,
        rawTotals: state.totals,          // base units, as indexed
        streams: cfg.streams.map((s) => ({
          id: s.id, kind: s.kind || 'sum', token: s.token,
          from: s.from || null, to: s.to || null,
        })),
        contracts: cfg.contracts,
      }, 200, { 'cache-control': 'no-store' });
    }

    // Let a manual GET /sync push it along too, handy while backfilling.
    if (url.pathname === '/sync') {
      try {
        const next = await sync(env, ctx, cfg);
        const price = await spcxPriceUsd(cfg);
        return json(present(next, price, cfg), 200, { 'cache-control': 'no-store' });
      } catch (err) {
        return json({ error: String(err && err.message || err) }, 502, { 'cache-control': 'no-store' });
      }
    }

    const price = await spcxPriceUsd(cfg);
    return json(present(state, price, cfg));
  },
};
