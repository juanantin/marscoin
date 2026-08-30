/* ==========================================================================
   STONKEX STRATEGY — app
   Contract-address copy, live dashboard.

   Data flow: each source in CONFIG.sources returns the fields it knows about;
   they are merged in order, so a later source overrides an earlier one. Add
   ?debug=1 to the URL to log every raw source response to the console.
   ========================================================================== */

(function () {
  'use strict';

  var CFG = window.STONKEX_CONFIG || {};
  var LINKS = CFG.links || {};
  var SRC = CFG.sources || {};
  var DEBUG = /[?&]debug=1\b/.test(location.search);

  var METRICS = ['fees', 'feesTokens', 'distributed', 'distributedUsd', 'holders',
                 'marketCap', 'liquidity', 'volume24h'];

  function log() {
    if (DEBUG && window.console) console.log.apply(console, ['[stonkex]'].concat([].slice.call(arguments)));
  }

  /* ---------------------------------------------------------------------
     Formatting
     --------------------------------------------------------------------- */

  // Whole numbers throughout — cents on a market cap are noise.
  var nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

  function usd(n) { return '$' + nf0.format(Math.round(n)); }
  function amount(n) { return nf0.format(Math.round(n)); }
  function count(n) { return nf0.format(Math.round(n)); }

  var FORMATTERS = {
    fees: usd,
    feesTokens: amount,
    distributed: amount,
    distributedUsd: amount,
    holders: count,
    marketCap: usd,
    liquidity: usd,
    volume24h: usd,
  };

  /* ---------------------------------------------------------------------
     Small helpers
     --------------------------------------------------------------------- */

  function num(v) {
    if (typeof v === 'string') v = v.replace(/,/g, '').trim();
    var n = typeof v === 'number' ? v : parseFloat(v);
    return typeof n === 'number' && isFinite(n) ? n : null;
  }

  // Read a dot-path ('data.stats.fees', 'pairs.0.priceUsd') out of an object.
  function pick(obj, path) {
    var parts = String(path).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  // First path in the list that resolves to a usable number.
  function firstNumber(obj, paths) {
    var list = typeof paths === 'string' ? [paths] : (paths || []);
    for (var i = 0; i < list.length; i++) {
      var n = num(pick(obj, list[i]));
      if (n !== null) return n;
    }
    return null;
  }

  function fetchJson(url, headers) {
    var h = { accept: 'application/json' };
    if (headers) Object.keys(headers).forEach(function (k) { h[k] = headers[k]; });
    // no-store: a polling dashboard must not be served a cached total
    return fetch(url, { headers: h, cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /* ---------------------------------------------------------------------
     Contract address + links
     --------------------------------------------------------------------- */

  var address = String(CFG.contractAddress || '').trim();

  function shorten(addr) {
    if (!addr) return '—';
    return addr.length <= 12 ? addr : addr.slice(0, 4) + '…' + addr.slice(-4);
  }

  var caShort = document.getElementById('ca-short');
  if (caShort) caShort.textContent = shorten(address);

  var chartLink = document.getElementById('link-chart');
  if (chartLink) {
    chartLink.href = LINKS.chart ||
      ('https://dexscreener.com/' + (CFG.chain || 'base') + '/' + encodeURIComponent(address));
  }

  var xLink = document.getElementById('link-x');
  if (xLink && LINKS.x) xLink.href = LINKS.x;

  /* Copy-to-clipboard, with a fallback for non-secure contexts. */
  var copyBtn = document.getElementById('copy-ca');
  var toast = document.getElementById('copy-toast');
  var toastText = document.getElementById('toast-text');
  var toastTimer = null;

  function flashToast(message, isError) {
    if (!toast) return;
    toastText.textContent = message;
    toast.classList.toggle('is-error', !!isError);
    toast.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('is-on'); }, 1800);
  }

  function legacyCopy(text) {
    var el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(el);
    el.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(el);
    return ok;
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      if (!address) { flashToast('NO ADDRESS SET', true); return; }

      function fallback() {
        var ok = legacyCopy(address);
        flashToast(ok ? 'COPIED!' : 'COPY FAILED', !ok);
      }

      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(address).then(function () { flashToast('COPIED!'); }, fallback);
      } else {
        fallback();
      }
    });
  }

  /* ---------------------------------------------------------------------
     Sources
     Each returns a partial stats object (or {}), and never rejects.
     --------------------------------------------------------------------- */

  /* Every source's outcome for the current load, so ?debug=1 can show which
     one came back empty rather than leaving you to guess at a row of dashes. */
  var sourceLog = [];

  function softly(name, promise) {
    return promise.then(
      function (v) {
        log(name, 'ok', v);
        sourceLog.push({ name: name, ok: true, empty: v === null || v === undefined, value: v });
        return v;
      },
      function (e) {
        var msg = (e && e.message) || 'failed';
        log(name, 'failed', msg);
        sourceLog.push({ name: name, ok: false, error: msg });
        return null;
      }
    );
  }

  /* Pick the deepest-liquidity pair for a token on the configured chain. */
  function bestPair(pairs, chain) {
    return (pairs || [])
      .filter(function (p) { return !chain || p.chainId === chain; })
      .sort(function (a, b) {
        return ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0);
      })[0] || null;
  }

  var DEX = 'https://api.dexscreener.com/latest/dex/';

  /* Look a pair up by its own address. More dependable than the token search
     when a token trades against something other than the usual quotes — the
     search can come back empty while the pool is right there. */
  function dexByPair(pairAddress) {
    if (!pairAddress) return Promise.resolve(null);
    return softly('dexscreener:pair:' + pairAddress,
      fetchJson(DEX + 'pairs/' + encodeURIComponent(CFG.chain || 'base') + '/' + encodeURIComponent(pairAddress))
        .then(function (d) { return (d && d.pair) || bestPair(d && d.pairs, CFG.chain); }));
  }

  function dexByToken(addr) {
    if (!addr) return Promise.resolve(null);
    return softly('dexscreener:token:' + addr,
      fetchJson(DEX + 'tokens/' + encodeURIComponent(addr))
        .then(function (d) { return bestPair(d && d.pairs, CFG.chain); }));
  }

  /* Known pool first, token search as the fallback. */
  function dexPair(addr, pairAddress) {
    var cfg = SRC.dexscreener || {};
    if (cfg.enabled === false) return Promise.resolve(null);
    return dexByPair(pairAddress).then(function (pair) {
      return pair || dexByToken(addr);
    });
  }

  /* Market cap, liquidity, 24h volume. */
  function sourceDexScreener() {
    var pool = (SRC.dexscreener || {}).pairAddress || (CFG.contracts || {}).pool;
    return dexPair(address, pool).then(function (pair) {
      if (!pair) return null;
      var out = {};
      var mc = num(pair.marketCap);
      if (mc === null) mc = num(pair.fdv);
      if (mc !== null) out.marketCap = mc;
      if (pair.liquidity && num(pair.liquidity.usd) !== null) out.liquidity = num(pair.liquidity.usd);
      if (pair.volume && num(pair.volume.h24) !== null) out.volume24h = num(pair.volume.h24);
      return out;
    });
  }

  /* Holder count — DexScreener doesn't report it, and no single explorer is
     reliable for a token this new, so try several and take the first real
     answer. A launched token with liquidity cannot have zero holders, so a
     zero means the explorer hasn't indexed it: treat it as no answer and move
     on rather than printing it. */
  function positive(n) {
    return (typeof n === 'number' && isFinite(n) && n > 0) ? n : null;
  }

  var HOLDER_PROVIDERS = {

    // Free, no key. Ships the field under different names across versions, and
    // on a fresh token it sometimes only appears on the counters route.
    blockscout: function (cfg) {
      var base = (cfg.blockscoutBase || 'https://base.blockscout.com').replace(/\/+$/, '');
      var token = base + '/api/v2/tokens/' + encodeURIComponent(address);
      return softly('holders:blockscout', fetchJson(token).then(function (d) {
        return positive(firstNumber(d, ['holders_count', 'holders']));
      })).then(function (n) {
        if (n) return n;
        return softly('holders:blockscout:counters', fetchJson(token + '/counters').then(function (d) {
          return positive(firstNumber(d, ['token_holders_count', 'holders_count', 'holders']));
        }));
      });
    },

    // GeckoTerminal's token info route. Free, no key, CORS-enabled. Reports a
    // holder count for tokens it has indexed; not every token has one.
    geckoterminal: function (cfg) {
      var base = (cfg.geckoterminalBase || 'https://api.geckoterminal.com/api/v2').replace(/\/+$/, '');
      return softly('holders:geckoterminal',
        fetchJson(base + '/networks/' + (CFG.chain || 'base') + '/tokens/' +
          encodeURIComponent(address) + '/info').then(function (d) {
            return positive(firstNumber(d, [
              'data.attributes.holders.count',
              'data.attributes.holders',
              'data.attributes.holder_count',
            ]));
          }));
    },

    // Etherscan V2 multichain. The tokenholdercount action needs a paid plan.
    etherscan: function (cfg) {
      if (!cfg.etherscanApiKey) { log('holders:etherscan', 'skipped — no API key'); return Promise.resolve(null); }
      return softly('holders:etherscan', fetchJson('https://api.etherscan.io/v2/api?chainid=' +
        (CFG.chainId || 8453) + '&module=token&action=tokenholdercount&contractaddress=' +
        encodeURIComponent(address) + '&apikey=' + encodeURIComponent(cfg.etherscanApiKey)).then(function (d) {
          if (String(d && d.status) !== '1') throw new Error((d && (d.result || d.message)) || 'bad response');
          return positive(num(d.result));
        }));
    },

    // Moralis. Free tier, key required, sent as a header.
    moralis: function (cfg) {
      if (!cfg.moralisApiKey) { log('holders:moralis', 'skipped — no API key'); return Promise.resolve(null); }
      return softly('holders:moralis', fetchJson('https://deep-index.moralis.io/api/v2.2/erc20/' +
        encodeURIComponent(address) + '/holders?chain=' + (CFG.chain || 'base'),
        { 'X-API-Key': cfg.moralisApiKey }).then(function (d) {
          return positive(firstNumber(d, ['totalHolders', 'total_holders', 'total']));
        }));
    },
  };

  function sourceHolders() {
    var cfg = SRC.holders || {};
    if (cfg.enabled === false || cfg.mode === 'none' || !address) return Promise.resolve(null);

    var order = cfg.providers || ['blockscout', 'geckoterminal', 'etherscan', 'moralis'];

    // Sequential on purpose: stop at the first provider with a real answer
    // instead of hammering all four on every refresh.
    return order.reduce(function (chain, name) {
      return chain.then(function (found) {
        if (found) return found;
        var fn = HOLDER_PROVIDERS[name];
        if (!fn) { log('holders', 'unknown provider ' + name); return null; }
        return fn(cfg);
      });
    }, Promise.resolve(null)).then(function (n) {
      return n ? { holders: n } : null;
    });
  }

  /* Project rewards API — fees collected, $STONKEX distributed.
     Takes one URL or several; each is read through the same field map and the
     first to yield a number for a metric wins. */
  function sourceRewards() {
    var cfg = SRC.rewards || {};
    if (cfg.enabled === false || !cfg.url) return Promise.resolve(null);

    var urls = (typeof cfg.url === 'string' ? [cfg.url] : cfg.url) || [];

    return Promise.all(urls.map(function (url) {
      return softly('rewards:' + url, fetchJson(url).then(function (d) { return readRewards(cfg, d); }));
    })).then(function (parts) {
      var merged = null;
      parts.forEach(function (part) {
        if (!part) return;
        merged = merged || {};
        Object.keys(part).forEach(function (k) {
          if (merged[k] === undefined) merged[k] = part[k];   // first source wins
        });
      });
      return merged;
    });
  }

  function readRewards(cfg, d) {
    var fields = cfg.fields || {};
    var out = {};

    var map = {
      totalFeesCollected: 'fees',
      totalFeesTokens: 'feesTokens',
      totalDistributed: 'distributed',
      totalDistributedUsd: 'distributedUsd',
      holders: 'holders',
      marketCap: 'marketCap',
      liquidity: 'liquidity',
      volume24h: 'volume24h',
    };

    Object.keys(map).forEach(function (from) {
      var n = firstNumber(d, fields[from]);
      if (n !== null) out[map[from]] = n;
    });

    if (out.distributedUsd === undefined) {
      log('rewards', 'no USD figure for distributed — deriving from rewardTokenAddress price');
    }
    return out;
  }

  /* Price the reward token, to turn distributed tokens into USD. */
  function sourceRewardPrice() {
    if (!CFG.rewardTokenAddress) return Promise.resolve(null);
    return dexPair(CFG.rewardTokenAddress, (CFG.contracts || {}).rewardPool).then(function (pair) {
      var price = pair ? num(pair.priceUsd) : null;
      return price === null ? null : { _rewardPrice: price };
    });
  }

  /* ---------------------------------------------------------------------
     Values (with a count-up on change)
     --------------------------------------------------------------------- */

  var valueNodes = {};
  Array.prototype.forEach.call(document.querySelectorAll('[data-value]'), function (node) {
    valueNodes[node.dataset.value] = node;
  });

  var shown = {};
  var timers = {};
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function setValue(key, target) {
    var node = valueNodes[key];
    if (!node) return;

    if (typeof target !== 'number' || !isFinite(target)) {
      node.textContent = '—';                       // no source for this one yet
      node.classList.add('is-empty');
      return;
    }
    node.classList.remove('is-empty');

    var fmt = FORMATTERS[key] || amount;
    var from = typeof shown[key] === 'number' ? shown[key] : 0;
    shown[key] = target;

    if (reduceMotion || from === target) {
      node.textContent = fmt(target);
      return;
    }

    cancelAnimationFrame(timers[key]);
    var start = performance.now();
    var dur = 900;

    (function step(now) {
      var p = Math.min((now - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      node.textContent = fmt(from + (target - from) * eased);
      if (p < 1) timers[key] = requestAnimationFrame(step);
    })(start);
  }

  var painted = false;
  var chips = Array.prototype.slice.call(document.querySelectorAll('[data-chip-for]'));

  function paint(stats) {
    painted = true;
    METRICS.forEach(function (key) { setValue(key, stats[key]); });
    // Each chip hides itself when the figure it exists to show is missing.
    chips.forEach(function (chip) {
      chip.hidden = typeof stats[chip.dataset.chipFor] !== 'number';
    });
  }

  /* ---------------------------------------------------------------------
     Load
     --------------------------------------------------------------------- */

  var note = document.getElementById('dash-note');

  function baseStats() {
    var s = CFG.stats || {};
    return {
      fees: num(s.totalFeesCollected),
      distributed: num(s.totalDistributed),
      distributedUsd: num(s.totalDistributedUsd),
      holders: num(s.holders),
      marketCap: num(s.marketCap),
      liquidity: num(s.liquidity),
      volume24h: num(s.volume24h),
    };
  }

  /* ?debug=1 — one line per source, so an empty tile is traceable to the
     request that produced it. "Failed to fetch" almost always means CORS or a
     blocked host; "HTTP 404" means the address or route is wrong; "ok, empty"
     means the request succeeded but the source has nothing for this token. */
  function renderDebug() {
    if (!DEBUG || !note) return;
    var box = document.getElementById('dash-debug');
    if (!box) {
      box = document.createElement('pre');
      box.id = 'dash-debug';
      box.style.cssText = 'margin:14px auto 0;max-width:640px;padding:12px 14px;border:1px solid #e6ebf3;' +
        'border-radius:12px;background:#fbfcfe;color:#3d4655;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;' +
        'text-align:left;white-space:pre-wrap;word-break:break-word;';
      note.parentNode.insertBefore(box, note.nextSibling);
    }
    var head = 'build ' + (CFG.version || 'unknown') +
      '  ·  ' + new Date().toLocaleTimeString() + '\n\n';

    box.textContent = head + sourceLog.map(function (s) {
      return (s.ok ? (s.empty ? '· empty  ' : '✓ ok     ') : '✗ failed ') +
        s.name + (s.ok ? '' : '  — ' + s.error);
    }).join('\n') || 'no sources ran';
  }

  function load() {
    sourceLog = [];
    // Order matters: later sources override earlier ones.
    return Promise.all([
      sourceDexScreener(),
      sourceHolders(),
      sourceRewardPrice(),
      sourceRewards(),
    ]).then(function (results) {
      var stats = baseStats();
      var live = 0;
      var rewardPrice = null;

      results.forEach(function (part) {
        if (!part) return;
        if (part._rewardPrice) { rewardPrice = part._rewardPrice; return; }
        var got = false;
        Object.keys(part).forEach(function (k) {
          if (typeof part[k] === 'number' && isFinite(part[k])) { stats[k] = part[k]; got = true; }
        });
        if (got) live++;
      });

      // Derive the USD value of distributed $STONKEX if nothing supplied one.
      if (stats.distributedUsd === null && rewardPrice !== null && typeof stats.distributed === 'number') {
        stats.distributedUsd = stats.distributed * rewardPrice;
      }

      log('merged', stats);
      paint(stats);

      // Only worth saying something when the data ISN'T live — a timestamp on
      // a working dashboard is noise.
      if (note) {
        note.textContent = live ? '' : 'Live data unavailable — retrying.';
        note.hidden = !!live;
      }
      renderDebug();
    });
  }

  /* ---------------------------------------------------------------------
     Boot
     Tiles blink a "…" placeholder until the first load resolves. If the
     network is slow or dead, fall back rather than blinking forever.
     --------------------------------------------------------------------- */

  var fallbackTimer = setTimeout(function () {
    if (!painted) paint(baseStats());
  }, 6000);

  load()['catch'](function (e) { log('load failed', e && e.message); })
    .then(function () {
      clearTimeout(fallbackTimer);
      if (!painted) paint(baseStats());
    });

  var every = Number(CFG.refreshSeconds) || 0;
  if (every > 0) setInterval(function () { load()['catch'](function () {}); }, every * 1000);
})();
