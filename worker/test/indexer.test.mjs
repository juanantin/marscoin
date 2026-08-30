/* Exercises the scan logic against a fake RPC: chunking, resume, BigInt
   summation, decimal conversion, and the chunk-halving retry. Run: npm test */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addressTopic, streamTopics, sumTransferLogs, toNumber, hexToBigInt,
  isRangeTooLarge, indexRange, TRANSFER_TOPIC,
} from '../src/indexer.js';

const KEX = '0x5ab000ff9B9FfE0349CE5ffA5fD86f217C3680F5';
const DIST = '0xf01a4dabfd54d1A6a1812a95F7151e8DA851DE2E';

const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

/* Fake chain: one transfer of `amount` at each listed block. */
function fakeRpc(transfersByBlock, opts = {}) {
  const maxRange = opts.maxRange ?? Infinity;
  const calls = { getLogs: 0, rejected: 0 };
  const rpc = async (method, params) => {
    if (method !== 'eth_getLogs') throw new Error('unexpected ' + method);
    const { fromBlock, toBlock } = params[0];
    const from = parseInt(fromBlock, 16);
    const to = parseInt(toBlock, 16);
    if (to - from + 1 > maxRange) {
      calls.rejected++;
      throw new Error('query returned more than 10000 results');
    }
    calls.getLogs++;
    return Object.entries(transfersByBlock)
      .filter(([b]) => +b >= from && +b <= to)
      .map(([b, amount]) => ({ blockNumber: '0x' + (+b).toString(16), data: word(amount) }));
  };
  return { rpc, calls };
}

const stream = { id: 'distributed', token: KEX, from: DIST, decimals: 18 };

test('address is left-padded to a 32-byte topic', () => {
  const t = addressTopic(DIST);
  assert.equal(t.length, 66);
  assert.equal(t, '0x000000000000000000000000' + DIST.slice(2).toLowerCase());
  assert.throws(() => addressTopic('0xnope'), /bad address/);
});

test('topic filter keeps position and drops trailing nulls', () => {
  assert.deepEqual(streamTopics({ from: DIST }), [TRANSFER_TOPIC, addressTopic(DIST)]);
  // a `to`-only filter must keep the null so `to` stays in the third slot
  assert.deepEqual(streamTopics({ to: DIST }), [TRANSFER_TOPIC, null, addressTopic(DIST)]);
  assert.deepEqual(streamTopics({}), [TRANSFER_TOPIC]);
});

test('sums transfer values exactly, beyond Number precision', () => {
  const big = 10n ** 30n;                       // far past 2^53
  const logs = [{ data: word(big) }, { data: word(big) }, { data: '0x' }];
  assert.equal(sumTransferLogs(logs), big * 2n);
  assert.equal(hexToBigInt('0x'), 0n);
  assert.equal(sumTransferLogs([]), 0n);
});

test('converts base units to whole tokens', () => {
  assert.equal(toNumber(10n ** 18n, 18), 1);
  assert.equal(toNumber(2500000000000000000n, 18), 2.5);
  assert.equal(toNumber(0n, 18), 0);
  assert.equal(toNumber(8412906500000000000000000n, 18), 8412906.5);
});

test('recognises range-limit errors, not real ones', () => {
  assert.ok(isRangeTooLarge(new Error('query returned more than 10000 results')));
  assert.ok(isRangeTooLarge(new Error('block range is too large')));
  assert.ok(isRangeTooLarge(new Error('Log response size exceeded')));
  assert.ok(!isRangeTooLarge(new Error('execution reverted')));
  assert.ok(!isRangeTooLarge(new Error('unauthorized')));
});

test('scans a whole range in chunks and totals every transfer', async () => {
  const { rpc, calls } = fakeRpc({ 100: 5n * 10n ** 18n, 250: 3n * 10n ** 18n, 999: 2n * 10n ** 18n });
  const res = await indexRange({ rpc, streams: [stream], from: 100, to: 999, chunkSize: 100 });

  assert.equal(res.complete, true);
  assert.equal(res.cursor, 1000);                       // next unscanned block
  assert.equal(calls.getLogs, 9);                       // 900 blocks / 100
  assert.equal(toNumber(res.totals.distributed, 18), 10);
});

test('stops at maxChunks and resumes exactly where it left off', async () => {
  const chain = { 100: 1n * 10n ** 18n, 300: 2n * 10n ** 18n, 700: 4n * 10n ** 18n };

  const first = await indexRange({ rpc: fakeRpc(chain).rpc, streams: [stream], from: 100, to: 999, chunkSize: 100, maxChunks: 3 });
  assert.equal(first.complete, false);
  assert.equal(first.cursor, 400);
  assert.equal(toNumber(first.totals.distributed, 18), 3);   // blocks 100 and 300 only

  const second = await indexRange({ rpc: fakeRpc(chain).rpc, streams: [stream], from: first.cursor, to: 999, chunkSize: 100 });
  assert.equal(second.complete, true);
  assert.equal(toNumber(second.totals.distributed, 18), 4);  // block 700, counted once

  // Resuming must not double-count or skip.
  assert.equal(toNumber(first.totals.distributed + second.totals.distributed, 18), 7);
});

test('halves the chunk when the RPC rejects the range, and still totals correctly', async () => {
  const { rpc, calls } = fakeRpc({ 150: 6n * 10n ** 18n }, { maxRange: 100 });
  const res = await indexRange({ rpc, streams: [stream], from: 100, to: 399, chunkSize: 800, minChunkSize: 25 });

  assert.ok(calls.rejected >= 3, 'should have been pushed back before fitting');
  assert.equal(res.complete, true);
  assert.equal(toNumber(res.totals.distributed, 18), 6);
});

test('gives up on a non-range error rather than looping', async () => {
  const rpc = async () => { throw new Error('unauthorized'); };
  await assert.rejects(
    indexRange({ rpc, streams: [stream], from: 1, to: 10, chunkSize: 5 }),
    /unauthorized/
  );
});

test('tracks several streams independently in one pass', async () => {
  const feeStream = { id: 'feesIn', token: KEX, to: DIST, decimals: 18 };
  const rpc = async (_m, [f]) => {
    const isFrom = f.topics[1] !== null && f.topics.length === 2;
    return [{ data: word(isFrom ? 10n ** 18n : 7n * 10n ** 18n) }];
  };
  const res = await indexRange({ rpc, streams: [stream, feeStream], from: 1, to: 100, chunkSize: 100 });
  assert.equal(toNumber(res.totals.distributed, 18), 1);
  assert.equal(toNumber(res.totals.feesIn, 18), 7);
});

/* ---- holder counting ---------------------------------------------------- */

import { decodeTransfer, applyTransfers, countHolders, ZERO_ADDRESS } from '../src/indexer.js';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';
const topic = (a) => '0x' + '0'.repeat(24) + a.slice(2);
const xfer = (from, to, amount) => ({ topics: [TRANSFER_TOPIC, topic(from), topic(to)], data: word(amount) });

test('decodes from, to and value out of a Transfer log', () => {
  const d = decodeTransfer(xfer(A, B, 42n));
  assert.equal(d.from, A);
  assert.equal(d.to, B);
  assert.equal(d.value, 42n);
});

test('mints credit the recipient and ignore the zero address', () => {
  const deltas = applyTransfers({}, [xfer(ZERO_ADDRESS, A, 100n)]);
  assert.equal(deltas[A], 100n);
  assert.equal(ZERO_ADDRESS in deltas, false);
  assert.equal(countHolders(deltas), 1);
});

test('a wallet that sends everything away stops counting', () => {
  const deltas = applyTransfers({}, [
    xfer(ZERO_ADDRESS, A, 100n),
    xfer(A, B, 100n),                 // A is now empty
  ]);
  assert.equal(deltas[A], 0n);
  assert.equal(deltas[B], 100n);
  assert.equal(countHolders(deltas), 1);
});

test('burns to the zero address reduce the holder, not the void', () => {
  const deltas = applyTransfers({}, [xfer(ZERO_ADDRESS, A, 100n), xfer(A, ZERO_ADDRESS, 100n)]);
  assert.equal(countHolders(deltas), 0);
  assert.equal(ZERO_ADDRESS in deltas, false);
});

test('zero-value transfers do not create phantom holders', () => {
  const deltas = applyTransfers({}, [xfer(A, B, 0n)]);
  assert.deepEqual(deltas, {});
  assert.equal(countHolders(deltas), 0);
});

test('counts holders across a chunked scan', async () => {
  const byBlock = {
    10: xfer(ZERO_ADDRESS, A, 500n),
    20: xfer(A, B, 200n),
    150: xfer(A, C, 100n),
    260: xfer(C, B, 100n),            // C empties out again
  };
  const rpc = async (_m, [f]) => {
    const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
    return Object.entries(byBlock).filter(([b]) => +b >= from && +b <= to).map(([, l]) => l);
  };
  const stream = { id: 'holders', kind: 'balances', token: KEX, decimals: 18 };
  const res = await indexRange({ rpc, streams: [stream], from: 0, to: 299, chunkSize: 100 });

  assert.equal(res.balances.holders[A], 200n);   // 500 − 200 − 100
  assert.equal(res.balances.holders[B], 300n);   // 200 + 100
  assert.equal(res.balances.holders[C], 0n);     // received then sent
  assert.equal(countHolders(res.balances.holders), 2);
});

test('stopOnError banks the chunks that succeeded instead of losing them', async () => {
  let calls = 0;
  const rpc = async (_m, [f]) => {
    if (++calls > 3) throw new Error('rpc HTTP 429');
    const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
    return (from <= 150 && to >= 150) ? [{ data: word(5n * 10n ** 18n) }] : [];
  };
  const res = await indexRange({
    rpc, streams: [stream], from: 100, to: 9999, chunkSize: 100, stopOnError: true,
  });

  assert.ok(res.error, 'the error is reported, not swallowed');
  assert.equal(res.complete, false);
  assert.ok(res.cursor > 100, 'cursor advanced past the chunks that worked');
  assert.equal(toNumber(res.totals.distributed, 18), 5, 'and their totals survived');
});

test('without stopOnError it still throws, discarding the partial pass', async () => {
  let calls = 0;
  const rpc = async () => { if (++calls > 2) throw new Error('rpc HTTP 429'); return []; };
  await assert.rejects(
    indexRange({ rpc, streams: [stream], from: 1, to: 9999, chunkSize: 100 }),
    /429/
  );
});
