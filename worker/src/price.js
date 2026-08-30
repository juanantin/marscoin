/* USD price of a token from DexScreener's deepest Base pair. Never throws —
   a missing price means a null figure on the site, not a failed run. */
export async function tokenPriceUsd(url, address, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  try {
    const res = await f(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const d = await res.json();
    const best = ((d && d.pairs) || [])
      .filter((p) => p.chainId === 'base' &&
        String((p.baseToken && p.baseToken.address) || '').toLowerCase() === address.toLowerCase())
      .sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0];
    const price = parseFloat(best && best.priceUsd);
    return isFinite(price) && price > 0 ? price : null;
  } catch (e) {
    return null;
  }
}
