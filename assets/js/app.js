/* ==========================================================================
   MARSCOIN — app
   Contract-address copy, live dashboard, tile sparklines.

   Data flow: each source in CONFIG.sources returns the fields it knows about;
   they are merged in order, so a later source overrides an earlier one. Add
   ?debug=1 to the URL to log every raw source response to the console.
   ========================================================================== */

(function () {
  'use strict';

  var CFG = window.MARSCOIN_CONFIG || {};
  var LINKS = CFG.links || {};
  var SRC = CFG.sources || {};
  var DEBUG = /[?&]debug=1\b/.test(location.search);

  var TICKER = CFG.ticker || 'MARSCOIN';
  var REWARD_TICKER = CFG.rewardTicker || 'SPCX';

  var METRICS = ['fees', 'feesTokens', 'distributed', 'distributedUsd', 'holders',
                 'marketCap', 'liquidity', 'volume24h'];

  function log() {
    if (DEBUG && window.console) console.log.apply(console, ['[marscoin]'].concat([].slice.call(arguments)));
  }

  /* ---------------------------------------------------------------------
     Tickers
     The two names live in config.js, so a rename doesn't mean hunting
     through the markup.
     --------------------------------------------------------------------- */

  Array.prototype.forEach.call(document.querySelectorAll('[data-ticker]'), function (node) {
    var which = node.dataset.ticker;
    if (which === 'reward') node.textContent = REWARD_TICKER;
    else if (which === 'reward-$') node.textContent = '$' + REWARD_TICKER;
    else if (which === 'main') node.textContent = TICKER;
    else if (which === 'main-$') node.textContent = '$' + TICKER;
  });

  /* ---------------------------------------------------------------------
     Formatting
     Cents are kept on the money figures — these are running totals, and the
     design shows them to the penny.
     --------------------------------------------------------------------- */

  var nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  var nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function usd(n) { return '$' + nf2.format(n); }
  function amount(n) { return nf2.format(n); }
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
    return addr.length <= 12 ? addr : addr.slice(0, 6) + '…' + addr.slice(-4);
  }

  var caShort = document.getElementById('ca-short');
  if (caShort) caShort.textContent = shorten(address);

  /* With no address and no explicit chart URL there is nowhere to send anyone,
     so the pill goes inert rather than linking to a broken DexScreener page. */
  var chartLink = document.getElementById('link-chart');
  if (chartLink) {
    if (LINKS.chart) {
      chartLink.href = LINKS.chart;
    } else if (address) {
      chartLink.href = 'https://dexscreener.com/' + (CFG.chain || 'base') + '/' + encodeURIComponent(address);
    } else {
      chartLink.removeAttribute('href');
      chartLink.classList.add('is-off');
      chartLink.setAttribute('aria-disabled', 'true');
      chartLink.title = 'Chart link available once the contract address is set';
    }
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
    if (!address && !pool) return Promise.resolve(null);
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

  /* Protocol rewards API — fees collected, $SPCX distributed.
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
     Sparklines
     There is no historical series to fetch — the sources report totals as of
     now. So the line is this browser's own record: every refresh appends the
     figure it just read, and the tile stays blank until enough points exist.
     Nothing is seeded or interpolated, and clearing site data resets it.
     --------------------------------------------------------------------- */

  var SPARK = CFG.sparklines || {};
  var SPARK_ON = SPARK.enabled !== false;
  var MIN_POINTS = Math.max(2, Number(SPARK.minPoints) || 4);
  var MAX_POINTS = Math.max(MIN_POINTS, Number(SPARK.maxPoints) || 60);

  // Keyed by token, so pointing the site at a different contract starts fresh.
  var SPARK_KEY = 'marscoin:spark:' + (address.toLowerCase() || 'unset');

  var sparkNodes = {};
  Array.prototype.forEach.call(document.querySelectorAll('[data-spark]'), function (node) {
    sparkNodes[node.dataset.spark] = node;
  });

  function readHistory() {
    try {
      var raw = window.localStorage.getItem(SPARK_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && parsed.series && typeof parsed.series === 'object') return parsed;
    } catch (e) { log('sparklines', 'history unreadable — starting empty'); }
    return { at: 0, series: {} };
  }

  function writeHistory(hist) {
    try { window.localStorage.setItem(SPARK_KEY, JSON.stringify(hist)); }
    catch (e) { log('sparklines', 'history not saved — storage unavailable'); }
  }

  /* Append this load's figures, but not more often than half the refresh
     interval — otherwise a run of page reloads would pack the line with
     points that are all the same moment. */
  function recordHistory(stats) {
    if (!SPARK_ON) return null;

    var hist = readHistory();
    var now = Date.now();
    var minGap = (Number(CFG.refreshSeconds) || 60) * 500;   // half the interval, in ms

    if (hist.at && now - hist.at < minGap) return hist;

    Object.keys(sparkNodes).forEach(function (key) {
      var v = stats[key];
      if (typeof v !== 'number' || !isFinite(v)) return;
      var series = hist.series[key] = hist.series[key] || [];
      series.push(Math.round(v * 1e4) / 1e4);
      if (series.length > MAX_POINTS) series.splice(0, series.length - MAX_POINTS);
    });

    hist.at = now;
    writeHistory(hist);
    return hist;
  }

  function sparkPaths(values, w, h) {
    var pad = 3;
    var lo = Math.min.apply(null, values);
    var hi = Math.max.apply(null, values);
    var span = hi - lo;
    var stepX = values.length > 1 ? w / (values.length - 1) : 0;

    var pts = values.map(function (v, i) {
      // A flat series has no shape to show — draw it down the middle.
      var t = span > 0 ? (v - lo) / span : 0.5;
      var y = h - pad - t * (h - pad * 2);
      return [i * stepX, y];
    });

    var line = pts.map(function (p, i) {
      return (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2);
    }).join(' ');

    return { line: line, area: line + ' L' + w + ' ' + h + ' L0 ' + h + ' Z' };
  }

  function drawSparklines(hist) {
    if (!SPARK_ON || !hist) return;

    Object.keys(sparkNodes).forEach(function (key) {
      var svg = sparkNodes[key];
      var values = (hist.series && hist.series[key]) || [];

      var tile = svg.closest ? svg.closest('.stat') : null;

      if (values.length < MIN_POINTS) {
        svg.hidden = true;
        if (tile) tile.classList.remove('has-spark');
        return;
      }

      var box = (svg.getAttribute('viewBox') || '0 0 100 30').split(/\s+/);
      var d = sparkPaths(values, Number(box[2]) || 100, Number(box[3]) || 30);

      var line = svg.querySelector('.stat__spark-line');
      var area = svg.querySelector('.stat__spark-area');
      if (line) line.setAttribute('d', d.line);
      if (area) area.setAttribute('d', d.area);
      svg.hidden = false;
      if (tile) tile.classList.add('has-spark');
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
    drawSparklines(recordHistory(stats));
  }

  /* ---------------------------------------------------------------------
     Load
     --------------------------------------------------------------------- */

  var note = document.getElementById('dash-note');

  function baseStats() {
    var s = CFG.stats || {};
    return {
      fees: num(s.totalFeesCollected),
      feesTokens: num(s.totalFeesTokens),
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
      box.style.cssText = 'margin:14px auto 0;max-width:640px;padding:12px 14px;' +
        'border:1px solid rgba(255,255,255,.09);border-radius:12px;background:#0e1017;color:#c3c9d6;' +
        'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;' +
        'text-align:left;white-space:pre-wrap;word-break:break-word;';
      note.parentNode.insertBefore(box, note.nextSibling);
    }
    var head = 'build ' + (CFG.version || 'unknown') +
      '  ·  ' + new Date().toLocaleTimeString() +
      (address ? '' : '  ·  NO CONTRACT ADDRESS SET') + '\n\n';

    box.textContent = head + (sourceLog.map(function (s) {
      return (s.ok ? (s.empty ? '· empty  ' : '✓ ok     ') : '✗ failed ') +
        s.name + (s.ok ? '' : '  — ' + s.error);
    }).join('\n') || 'no sources ran');
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

      // Derive the USD value of distributed $SPCX if nothing supplied one.
      if (stats.distributedUsd === null && rewardPrice !== null && typeof stats.distributed === 'number') {
        stats.distributedUsd = stats.distributed * rewardPrice;
      }

      log('merged', stats);
      paint(stats);

      // Only worth saying something when the data ISN'T live — a timestamp on
      // a working dashboard is noise.
      if (note) {
        note.textContent = live ? '' :
          (address ? 'Live data unavailable — retrying.' : 'Contract address not set — see config.js');
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
