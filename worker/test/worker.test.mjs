/* End-to-end over the Worker's own handlers, with a fake KV and RPC: proves
   totals survive the KV round-trip (BigInt is stored as a string), that a
   second run resumes instead of re-counting, and that the served payload is
   the shape the site reads. */

import assert from 'node:assert/strict';
import test from 'node:test';

const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const E18 = 10n ** 18n;

function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(k, type) { const v = store.get(k); return v == null ? null : (type === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

/* Chain with one distribution and one fee transfer, plus a moving head. */
function makeEnv(head, transfers) {
  const KV = fakeKV();
  const rpcCalls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('dexscreener')) {
      return { ok: true, json: async () => ({ pairs: [{
        chainId: 'base',
        baseToken: { address: '0x5ab000ff9B9FfE0349CE5ffA5fD86f217C3680F5' },
        liquidity: { usd: 3400000 }, priceUsd: '0.25',
      }]}) };
    }
    const body = JSON.parse(init.body);
    rpcCalls.push(body.method);
    if (body.method === 'eth_blockNumber') {
      return { ok: true, json: async () => ({ result: '0x' + head.toString(16) }) };
    }
    const f = body.params[0];
    const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
    // topics: [T] = balances, [T, from] = paidOut, [T, null, to] = feesIn
    const key = f.topics.length === 2 ? 'paidOut' : f.topics.length === 3 ? 'feesIn' : null;
    const logs = (key ? transfers[key] || [] : [])
      .filter(([b]) => b >= from && b <= to)
      .map(([, amt]) => ({ data: word(amt) }));
    return { ok: true, json: async () => ({ result: logs }) };
  };
  return { env: { STONKEX: KV, RPC_URL: 'http://rpc.test', ADMIN_TOKEN: 'secret' }, KV, rpcCalls };
}

const START = 50530608;

/* The real runtime keeps a Worker alive until every waitUntil promise settles,
   so the fake has to as well — otherwise scheduled() returns before the sync
   it kicked off has written anything. */
function makeCtx() {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), settled: () => Promise.all(pending) };
}

async function runCron(mod, env) {
  const ctx = makeCtx();
  await mod.scheduled({}, env, ctx);
  await ctx.settled();
}

const ctx = makeCtx();

test('cron sync banks totals, then a later run resumes without re-counting', async () => {
  const mod = (await import('../src/index.js')).default;
  const { HOLDER_SHARE } = await import('../src/config.js');

  // First run: head only a little past the start block.
  const a = makeEnv(START + 999, {
    paidOut: [[START + 10, 5n * E18], [START + 500, 3n * E18]],
    feesIn: [[START + 20, 12n * E18]],
  });
  await runCron(mod, a.env);

  let res = await mod.fetch(new Request('https://w/'), a.env, ctx);
  let body = await res.json();
  // 8 KEX left the contract; only the holders' share counts as distributed.
  assert.equal(body.totalDistributed, 8 * HOLDER_SHARE);
  assert.equal(body.totalDistributedUsd, 8 * HOLDER_SHARE * 0.25);
  assert.equal(body.totalFeesCollected, 3);            // 12 KEX in × $0.25
  assert.equal(body.meta.synced, true);

  // Head advances; a new payout lands. Reuse the same KV.
  const b = makeEnv(START + 1999, {
    paidOut: [[START + 10, 5n * E18], [START + 500, 3n * E18], [START + 1500, 4n * E18]],
    feesIn: [[START + 20, 12n * E18]],
  });
  b.env.STONKEX = a.KV;                                 // carry state over
  await runCron(mod, b.env);

  res = await mod.fetch(new Request('https://w/'), b.env, ctx);
  body = await res.json();
  // 8 already banked + 4 new. The first two must NOT be counted twice.
  assert.equal(body.totalDistributed, 12 * HOLDER_SHARE);
  assert.equal(body.totalFeesCollected, 3);

  const dbg = await (await mod.fetch(new Request('https://w/debug'), b.env, ctx)).json();
  assert.equal(dbg.blocksBehind, 0);
  assert.equal(dbg.lastError, null);
  assert.equal(dbg.startBlock, START);
  assert.equal(typeof dbg.rawTotals.paidOut, 'string');   // stored as string
  assert.equal(dbg.rawTotals.paidOut, (12n * E18).toString());
});

test('fees track the rewards contract, not the platform-wide fee locker', async () => {
  const { STREAMS, CONTRACTS } = await import('../src/config.js');
  const fees = STREAMS.find((s) => s.id === 'feesIn');
  assert.equal(fees.to.toLowerCase(), CONTRACTS.rewardsIndex.toLowerCase(),
    'the fee locker is shared by every coin on the platform');
  assert.equal(fees.from, undefined);
});

test('holder payout strips the protocol cut, matching Stockify', async () => {
  const { holderPayout } = await import('../src/config.js');
  // Stockify reported 77,671.73 collected and 69,904.56 paid to holders.
  assert.equal(holderPayout({ paidOut: 77671.73125011318 }).toFixed(2), '69904.56');
  assert.equal(holderPayout({ paidOut: 0 }), 0);
});

test('serves CORS and the documented shape', async () => {
  const mod = (await import('../src/index.js')).default;
  const { env } = makeEnv(START + 99, { paidOut: [], feesIn: [] });
  const res = await mod.fetch(new Request('https://w/'), env, ctx);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const body = await res.json();
  for (const k of ['totalDistributed', 'totalDistributedUsd', 'totalFeesCollected', 'updatedAt', 'meta']) {
    assert.ok(k in body, 'missing ' + k);
  }
});

test('reset requires the admin token', async () => {
  const mod = (await import('../src/index.js')).default;
  const { env, KV } = makeEnv(START + 99, { paidOut: [[START + 1, E18]], feesIn: [] });
  await runCron(mod, env);
  assert.ok(KV.store.size > 0);

  let res = await mod.fetch(new Request('https://w/reset', { method: 'POST' }), env, ctx);
  assert.equal(res.status, 401);
  assert.ok(KV.store.size > 0, 'state must survive an unauthorised reset');

  res = await mod.fetch(new Request('https://w/reset', {
    method: 'POST', headers: { authorization: 'Bearer secret' },
  }), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(KV.store.size, 0);
});

test('a failing RPC is recorded, not thrown, and totals are kept', async () => {
  const mod = (await import('../src/index.js')).default;
  const { env, KV } = makeEnv(START + 99, { paidOut: [[START + 1, 9n * E18]], feesIn: [] });
  await runCron(mod, env);

  globalThis.fetch = async (url) => String(url).includes('dexscreener')
    ? { ok: false, json: async () => ({}) }
    : { ok: false, status: 503, json: async () => ({}) };

  await runCron(mod, env);                              // must not reject
  const dbg = await (await mod.fetch(new Request('https://w/debug'), env, ctx)).json();
  assert.match(dbg.lastError, /503/);
  assert.equal(dbg.rawTotals.paidOut, (9n * E18).toString(), 'totals survive an error');
});

test('counts holders from transfers, across a resumed backfill', async () => {
  const mod = (await import('../src/index.js')).default;
  const { CONTRACTS } = await import('../src/config.js');

  const ZERO = '0x0000000000000000000000000000000000000000';
  const A = '0x1111111111111111111111111111111111111111';
  const B = '0x2222222222222222222222222222222222222222';
  const POOL = CONTRACTS.pool.toLowerCase();
  const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const topic = (a) => '0x' + '0'.repeat(24) + a.slice(2);
  const xfer = (f, t, amt) => ({ topics: [T, topic(f), topic(t)], data: word(amt) });

  const KV = fakeKV();
  // Two windows of history; the second run must build on the first.
  const windows = [
    { head: START + 99, logs: { [START + 1]: xfer(ZERO, A, 10n * E18), [START + 2]: xfer(ZERO, POOL, 90n * E18) } },
    { head: START + 199, logs: { [START + 150]: xfer(A, B, 4n * E18) } },
  ];

  for (const wnd of windows) {
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('dexscreener')) return { ok: true, json: async () => ({ pairs: [] }) };
      const body = JSON.parse(init.body);
      if (body.method === 'eth_blockNumber') {
        return { ok: true, json: async () => ({ result: '0x' + wnd.head.toString(16) }) };
      }
      const f = body.params[0];
      const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
      // only the balances stream has no from/to topic filter
      if (f.topics.length !== 1) return { ok: true, json: async () => ({ result: [] }) };
      const logs = Object.entries(wnd.logs).filter(([b]) => +b >= from && +b <= to).map(([, l]) => l);
      return { ok: true, json: async () => ({ result: logs }) };
    };
    await runCron(mod, { STONKEX: KV, RPC_URL: 'http://rpc.test', ADMIN_TOKEN: 'secret' });
  }

  const env = { STONKEX: KV, RPC_URL: 'http://rpc.test', ADMIN_TOKEN: 'secret' };
  const dbg = await (await mod.fetch(new Request('https://w/debug'), env, ctx)).json();

  // A has 6, B has 4, and the pool's 90 is excluded — so two holders.
  assert.equal(dbg.holders, 2, 'pool must not count as a holder');
  assert.equal(dbg.addressesTracked, 3, 'pool is still tracked, just not counted');

  const body = await (await mod.fetch(new Request('https://w/'), env, ctx)).json();
  assert.equal(body.holders, 2);
});

test('withholds the holder count until the backfill has finished', async () => {
  const mod = (await import('../src/index.js')).default;
  const { env } = makeEnv(START + 500000, { paidOut: [], feesIn: [] });
  await runCron(mod, env);                       // far more blocks than one run covers

  const body = await (await mod.fetch(new Request('https://w/'), env, ctx)).json();
  const dbg = await (await mod.fetch(new Request('https://w/debug'), env, ctx)).json();
  assert.equal(dbg.synced, false);
  assert.equal(body.holders, null, 'a partial scan under-counts, so publish nothing');
  assert.ok(dbg.blocksBehind > 0);
});
