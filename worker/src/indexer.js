/* ==========================================================================
   ERC-20 flow indexer
   --------------------------------------------------------------------------
   Sums ERC-20 Transfer amounts over a block range, in chunks, resuming from a
   saved cursor. Pure — the RPC is injected — so it runs in a Worker and under
   `npm test` alike.

   Only the standard Transfer event is used, so none of this needs the ABI of
   the contract being watched. That matters: the rewards contract may not be
   verified, but its token movements are still plain ERC-20 transfers.
   ========================================================================== */

// keccak256("Transfer(address,address,uint256)")
export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Left-pad an address to a 32-byte topic. */
export function addressTopic(addr) {
  const clean = String(addr).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(clean)) throw new Error('bad address: ' + addr);
  return '0x' + '0'.repeat(24) + clean;
}

/**
 * Topic filter for a stream. Trailing nulls are dropped — some RPCs reject a
 * filter that ends in them.
 */
export function streamTopics(stream) {
  const topics = [
    TRANSFER_TOPIC,
    stream.from ? addressTopic(stream.from) : null,
    stream.to ? addressTopic(stream.to) : null,
  ];
  while (topics.length && topics[topics.length - 1] === null) topics.pop();
  return topics;
}

export function hexToBigInt(hex) {
  if (hex === undefined || hex === null || hex === '0x' || hex === '') return 0n;
  return BigInt(hex);
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Pull from/to/value out of a standard Transfer log. */
export function decodeTransfer(log) {
  const topics = log.topics || [];
  const addr = (t) => '0x' + String(t).slice(-40).toLowerCase();
  return {
    from: topics[1] ? addr(topics[1]) : null,
    to: topics[2] ? addr(topics[2]) : null,
    value: hexToBigInt(log.data),
  };
}

/**
 * Fold transfers into a map of address -> balance delta. Mints and burns move
 * through the zero address, which is not a holder, so it is skipped.
 */
export function applyTransfers(deltas, logs) {
  for (const log of logs || []) {
    const { from, to, value } = decodeTransfer(log);
    if (value === 0n) continue;
    if (from && from !== ZERO_ADDRESS) deltas[from] = (deltas[from] || 0n) - value;
    if (to && to !== ZERO_ADDRESS) deltas[to] = (deltas[to] || 0n) + value;
  }
  return deltas;
}

/** Addresses left holding a positive balance. */
export function countHolders(balances) {
  let n = 0;
  for (const k in balances) {
    if (k === ZERO_ADDRESS) continue;
    if (BigInt(balances[k]) > 0n) n++;
  }
  return n;
}

export function sumTransferLogs(logs) {
  // Transfer's only non-indexed parameter is `value`, so it is the whole data word.
  return (logs || []).reduce((acc, log) => acc + hexToBigInt(log.data), 0n);
}

/** BigInt base units → a JS number in whole tokens. */
export function toNumber(units, decimals) {
  const d = BigInt(10) ** BigInt(decimals);
  const whole = units / d;
  const frac = units % d;
  return Number(whole) + Number(frac) / Number(d);
}

/** RPC errors that mean "ask for fewer blocks", rather than a real failure. */
export function isRangeTooLarge(err) {
  const m = String((err && err.message) || err).toLowerCase();
  return m.includes('range') || m.includes('too large') || m.includes('too many') ||
         m.includes('more than') || m.includes('limit') || m.includes('exceed') ||
         m.includes('response size') || m.includes('-32005');
}

/**
 * Walk [from, to] summing each stream, halving the chunk when the RPC pushes
 * back. Stops early once `maxChunks` is spent so a single run stays inside a
 * Worker's CPU budget; the cursor it returns is where the next run picks up.
 *
 * Returns { cursor, totals, balances, chunksUsed, complete, error? }. `cursor` is the
 * next unscanned block. `totals` holds summed amounts per 'sum' stream;
 * `balances` holds per-address DELTAS for each 'balances' stream, so a caller
 * can add them to a running map across runs.
 */
export async function indexRange(opts) {
  const {
    rpc, streams, from, to,
    chunkSize = 2000,
    minChunkSize = 50,
    maxChunks = 60,
    onProgress,
    // Return what was scanned so far alongside the error, instead of throwing
    // it and discarding the chunks that already succeeded. A long backfill on a
    // rate-limited RPC would otherwise never make progress.
    stopOnError = false,
  } = opts;

  const totals = {};
  const balances = {};
  streams.forEach((s) => {
    if (s.kind === 'balances') balances[s.id] = {};
    else totals[s.id] = 0n;
  });

  let cursor = from;
  let size = chunkSize;
  let chunksUsed = 0;

  while (cursor <= to && chunksUsed < maxChunks) {
    const end = Math.min(cursor + size - 1, to);

    let logsByStream;
    try {
      logsByStream = await Promise.all(streams.map((s) => rpc('eth_getLogs', [{
        address: s.token,
        topics: streamTopics(s),
        fromBlock: '0x' + cursor.toString(16),
        toBlock: '0x' + end.toString(16),
      }])));
    } catch (err) {
      if (isRangeTooLarge(err) && size > minChunkSize) {
        size = Math.max(minChunkSize, Math.floor(size / 2));
        continue;                       // same cursor, smaller bite
      }
      if (stopOnError) return { cursor, totals, balances, chunksUsed, complete: false, error: err };
      throw err;
    }

    streams.forEach((s, i) => {
      if (s.kind === 'balances') applyTransfers(balances[s.id], logsByStream[i]);
      else totals[s.id] += sumTransferLogs(logsByStream[i]);
    });

    cursor = end + 1;
    chunksUsed++;
    if (onProgress) onProgress({ cursor, to, chunksUsed });
  }

  return { cursor, totals, balances, chunksUsed, complete: cursor > to };
}

/** Minimal JSON-RPC client. */
export function makeRpc(url, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  let id = 0;
  return async function rpc(method, params) {
    const res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    if (!res.ok) throw new Error('rpc HTTP ' + res.status);
    const body = await res.json();
    if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
    return body.result;
  };
}
