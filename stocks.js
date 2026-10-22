// stocks.js: the Stocks tab (the list and your holdings) and the full-screen stock page
// (candlestick chart with zoom and scroll-back, stats, your position, the company, your trades, Buy and Sell).
// Prices come from market.js and move four times a second, so the screen moves while you watch.
(function () {
  if (!window.SB || !window.Wallet) return;
  var SB = window.SB;
  var Wallet = window.Wallet;
  var $ = SB.$;

  // Candle lengths from shortest to longest. Zooming picks the shortest length that keeps
  // about 120 candles on screen. Zoomed in you see 5-second candles; zoomed out they join into longer ones.
  var LADDER = [5, 15, 30, 60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400, 172800, 604800]
    .map(function (x) { return x * 1000; });
  var MAX_VISIBLE = 120;
  var MIN_WINDOW = 100 * 1000;                 // zoomed in as far as 20 five-second candles
  var MAX_WINDOW = 360 * 60 * 60 * 1000;       // a market year: 360 market days, 1 real hour each
  // The three buttons set where you start: each shows 120 candles of its length
  var RANGES = {
    "1H": { window: 120 * 5 * 1000 },
    "4H": { window: 120 * 15 * 1000 },
    "All": { window: 120 * 30 * 1000 }
  };
  var SAMPLE_MS = 250;      // how often a forming candle takes a price
  var EASE_MS = 800;        // how slowly the drawn price catches up to the real price
  var PLOT = { W: 360, H: 300, t: 12, b: 24, l: 6, r: 58 };

  var list = [];        // company docs, in the order of Wallet.stockList
  var holdings = {};    // symbol -> { shares, cost }
  var receipts = [];    // your recent transactions (from the app)
  var chg1h = {};       // symbol -> change over the last hour (for the list)
  var openSym = null;   // the stock whose page is open
  var range = "1H";     // which button was pressed last (sets the starting zoom)
  var view = { offset: 0, windowMs: RANGES["1H"].window }; // offset: ms scrolled back; windowMs: time on screen
  var slots = 120;      // how many candle places the chart has
  var geo = null;       // the last chart drawn: candle positions, for the touch readout
  var touching = false; // true while a finger is on the chart (the live redraw waits)
  var pointers = new Map();
  var gesture = null;   // { mode: "cross" | "pan" | "pinch", x0, off0, w0, d0 }
  var tickCount = 0;
  var rowRefs = {};     // symbol -> { px, chg } elements in the list
  var holdRefs = {};    // symbol -> { px, chg } elements in "Your stocks"
  var stopStocks = null, stopHoldings = null, ticker = null, ageTimer = null;
  var closedCache = {}; // locked candles, so they never change once finished
  var cacheReady = false; // only lock candles after the market has finished catching up
  var live = {};        // "symbol|size" -> the candle still forming
  var frameOn = false, lastDraw = 0;

  function money(n) { return SB.money(Math.round(n * 100) / 100); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function round4(x) { return Math.round(x * 10000) / 10000; }
  function findStock(sym) {
    for (var i = 0; i < list.length; i++) if (list[i].id === sym) return list[i];
    return null;
  }
  function pctText(x) { return (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%"; }
  function bigMoney(n) {
    if (n >= 1000000) return "$" + (n / 1000000).toFixed(2) + "M";
    if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "K";
    return money(n);
  }
  function companyValue(s) { return s.price * Wallet.stockShares; }
  function worthOf(s, shares) { return shares > 0.01 ? Wallet.stockSellValue(s, shares) : 0; }
  function ago(ms) {
    var mins = Math.round(ms / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + " min ago";
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + " hr ago";
    return Math.round(hrs / 24) + " days ago";
  }
  // Change from the first open to the last close of a set of candles
  function changeFrom(cs) {
    if (!cs.length || !cs[0].o) return 0;
    return (cs[cs.length - 1].c - cs[0].o) / cs[0].o;
  }
  // "5 seconds", "2 minutes", "3 market days" (one market day is one real hour)
  function fmtSize(ms) {
    if (ms < 60000) return ms / 1000 + " seconds";
    if (ms < 3600000) { var m = ms / 60000; return m + (m === 1 ? " minute" : " minutes"); }
    var d = ms / 3600000;
    return d + (d === 1 ? " market day" : " market days");
  }
  function fmtTime(t, size) {
    var d = new Date(t);
    if (size < 60000) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
    if (size < 86400000) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return d.toLocaleString("en-US", { month: "short", day: "numeric" });
  }
  function fmtStamp(t) {
    return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
  }
  // The candle length that fits the current zoom
  function pickSize(windowMs) {
    for (var i = 0; i < LADDER.length; i++) if (windowMs / LADDER[i] <= MAX_VISIBLE) return LADDER[i];
    return LADDER[LADDER.length - 1];
  }
  function clampView(s) {
    view.windowMs = clamp(view.windowMs, MIN_WINDOW, MAX_WINDOW);
    var maxOffset = Math.max(0, Date.now() - s.startAt - view.windowMs / 2);
    view.offset = clamp(view.offset, 0, maxOffset);
  }

  // ---------- Candles ----------
  // One candle over [start, end]: prices sampled along the way, so high and low are real
  function sampleCandle(s, start, end, size) {
    var first = Math.max(start, s.startAt);
    var step = Math.max(SAMPLE_MS, size / 48);
    var vals = [];
    for (var t = first; t < end; t += step) vals.push(Wallet.priceAtTime(s, t));
    var last = Wallet.priceAtTime(s, end);
    vals.push(last);
    return {
      t: Math.round(first),
      o: round4(vals[0]),
      h: round4(Math.max.apply(null, vals)),
      l: round4(Math.min.apply(null, vals)),
      c: round4(last)
    };
  }
  // The candle still forming. Its close eases toward the real price, so it drifts up and down
  // slowly instead of jumping. When its time is up it locks in with the price the chart showed.
  function liveCandle(s, size, start, now) {
    var key = s.id + "|" + size;
    var target = Wallet.priceNow(s);
    var st = live[key];
    var prevClose = null;
    if (st && st.start !== start) {
      if (st.start === start - size) {
        closedCache[s.id + "|" + size + "|" + st.start] = { t: st.start, o: st.o, h: st.h, l: st.l, c: st.c };
        prevClose = st.c;
      }
      st = null;
    }
    if (!st) {
      var o = round4(prevClose !== null ? prevClose : Wallet.priceAtTime(s, start));
      st = live[key] = { start: start, o: o, h: o, l: o, c: o, t: now };
    }
    var dt = Math.max(0, now - st.t);
    st.t = now;
    st.c += (target - st.c) * (1 - Math.exp(-dt / EASE_MS));
    st.h = Math.max(st.h, st.c);
    st.l = Math.min(st.l, st.c);
    return { t: start, o: st.o, h: round4(st.h), l: round4(st.l), c: round4(st.c) };
  }
  // The candles on screen, oldest first. They line up to the clock. Finished candles are locked.
  function windowCandles(s) {
    var now = Date.now();
    var size = pickSize(view.windowMs);
    var liveStart = Math.floor(now / size) * size;
    var top = Math.floor((now - view.offset) / size) * size;
    var count = Math.max(1, Math.ceil(view.windowMs / size));
    slots = count;
    var out = [];
    for (var k = count - 1; k >= 0; k--) {
      var start = top - k * size;
      if (start + size <= s.startAt) continue;   // before the company existed
      if (start > now) continue;
      if (start === liveStart) { out.push(liveCandle(s, size, start, now)); continue; }
      var key = s.id + "|" + size + "|" + start;
      var c = closedCache[key];
      if (!c) {
        c = sampleCandle(s, start, start + size, size);
        if (cacheReady) closedCache[key] = c;
      }
      out.push(c);
    }
    return { cs: out, size: size };
  }
  // How much the price has moved over the last hour (for the list)
  function change1h(s) {
    var now = Date.now();
    var then = Math.max(s.startAt, now - 60 * 60 * 1000);
    var was = Wallet.priceAtTime(s, then);
    return was ? (Wallet.priceNow(s) - was) / was : 0;
  }

  // ---------- The list ----------
  // Rows are built once and then only their text changes, so taps never get lost
  function buildList() {
    var box = $("stkList");
    box.innerHTML = "";
    rowRefs = {};
    list.forEach(function (s) {
      var b = el("button", "stk-row");
      b.type = "button";
      var left = el("div", "stk-left");
      left.appendChild(el("p", "stk-name", s.name));
      left.appendChild(el("p", "stk-sym", s.id + " · company " + bigMoney(companyValue(s))));
      var right = el("div", "stk-right");
      var px = el("p", "stk-px", "");
      var chg = el("p", "stk-chg", "");
      right.appendChild(px);
      right.appendChild(chg);
      b.appendChild(left);
      b.appendChild(right);
      b.addEventListener("click", function () { openStock(s.id); });
      box.appendChild(b);
      rowRefs[s.id] = { px: px, chg: chg };
      chg1h[s.id] = change1h(s);
    });
    updateList();
  }
  function updateList() {
    list.forEach(function (s) {
      var r = rowRefs[s.id];
      if (!r) return;
      var ch = chg1h[s.id] || 0;
      r.px.textContent = money(s.price);
      r.chg.textContent = pctText(ch);
      r.chg.className = "stk-chg " + (ch >= 0 ? "up" : "down");
    });
  }

  function buildHoldings() {
    var box = $("stkHoldings");
    box.innerHTML = "";
    holdRefs = {};
    var rows = list.filter(function (s) { return holdings[s.id] && holdings[s.id].shares > 0.01; });
    box.classList.toggle("hidden", rows.length === 0);
    if (!rows.length) return;
    box.appendChild(el("p", "sec-title", "Your stocks"));
    rows.forEach(function (s) {
      var b = el("button", "stk-row");
      b.type = "button";
      var left = el("div", "stk-left");
      left.appendChild(el("p", "stk-name", s.name));
      left.appendChild(el("p", "stk-sym", holdings[s.id].shares.toFixed(2) + " shares"));
      var right = el("div", "stk-right");
      var px = el("p", "stk-px", "");
      var chg = el("p", "stk-chg", "");
      right.appendChild(px);
      right.appendChild(chg);
      b.appendChild(left);
      b.appendChild(right);
      b.addEventListener("click", function () { openStock(s.id); });
      box.appendChild(b);
      holdRefs[s.id] = { px: px, chg: chg };
    });
    updateHoldings();
  }
  function updateHoldings() {
    list.forEach(function (s) {
      var h = holdings[s.id];
      var r = holdRefs[s.id];
      if (!h || !(h.shares > 0.01) || !r) return;
      var now = worthOf(s, h.shares);
      var profit = now - (h.cost || 0);
      r.px.textContent = money(now);
      r.chg.textContent = (profit >= 0 ? "+" : "-") + money(Math.abs(profit));
      r.chg.className = "stk-chg " + (profit >= 0 ? "up" : "down");
    });
  }

  // ---------- The candlestick chart ----------
  // Green candle: it closed higher than it opened. Red: it closed lower.
  // Candles always fill the same width (slots), so zooming changes how much time each one covers.
  function buildChart(cs, live, n, size) {
    var W = PLOT.W, H = PLOT.H, P = PLOT;
    var plotW = W - P.l - P.r, plotH = H - P.t - P.b;
    var slot = plotW / n, bw = Math.max(1.6, Math.min(slot * 0.66, 16));
    var hi = 1, lo = 0;
    if (cs.length) {
      hi = Math.max.apply(null, cs.map(function (c) { return c.h; }));
      lo = Math.min.apply(null, cs.map(function (c) { return c.l; }));
    }
    var pad = (hi - lo) * 0.08 || hi * 0.005;
    hi += pad; lo -= pad;
    function Y(v) { return P.t + (1 - (v - lo) / (hi - lo)) * plotH; }

    var first = n - cs.length, shapes = "", xs = [];
    cs.forEach(function (c, i) {
      var cx = P.l + slot * (first + i + 0.5);
      var col = c.c >= c.o ? "#3DF0B0" : "#FF6B7A";
      var yH = Y(c.h), yL = Y(c.l), yO = Y(c.o), yC = Y(c.c);
      var top = Math.min(yO, yC), bh = Math.max(1.2, Math.abs(yC - yO));
      shapes += '<line x1="' + cx.toFixed(1) + '" x2="' + cx.toFixed(1) + '" y1="' + yH.toFixed(1) +
        '" y2="' + yL.toFixed(1) + '" stroke="' + col + '" stroke-width="1"/>' +
        '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + bh.toFixed(1) + '" rx="0.5" fill="' + col + '"/>';
      xs.push({ x: cx, y: yC, i: i });
    });

    var grid = [0, 1 / 3, 2 / 3, 1].map(function (f) {
      var v = hi - f * (hi - lo);
      var y = Y(v).toFixed(1);
      return '<line class="sp-grid" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + y + '" y2="' + y + '"/>' +
        '<text class="sp-axis" x="' + (W - P.r + 6) + '" y="' + (Number(y) + 3.5) + '">$' + v.toFixed(2) + '</text>';
    }).join("");

    var times = "";
    if (cs.length) {
      [0, Math.floor((cs.length - 1) / 2), cs.length - 1].forEach(function (idx, k) {
        var x = xs[idx].x;
        var anchor = k === 0 ? "start" : (k === 2 ? "end" : "middle");
        times += '<text class="sp-axis" text-anchor="' + anchor + '" x="' + x.toFixed(1) +
          '" y="' + (H - 6) + '">' + fmtTime(cs[idx].t, size) + '</text>';
      });
    }

    var pulse = "";
    if (live && xs.length) {
      var last = xs[xs.length - 1];
      pulse = '<circle class="sp-pulse" cx="' + last.x.toFixed(1) + '" cy="' + last.y.toFixed(1) + '" r="8" fill="#fff"/>' +
        '<circle cx="' + last.x.toFixed(1) + '" cy="' + last.y.toFixed(1) + '" r="3.5" fill="#fff"/>';
    }

    var svg = '<svg class="sp-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Candlestick chart">' +
      grid + shapes + times + pulse +
      '<line class="sp-cross" x1="0" x2="0" y1="' + P.t + '" y2="' + (H - P.b) + '" visibility="hidden"/>' +
      '<circle class="sp-crossdot" r="4.5" fill="#fff" cx="0" cy="0" visibility="hidden"/>' +
      '</svg>';
    return { html: svg, xs: xs, cs: cs, W: W };
  }

  // ---------- Touch readout (one candle at a time) ----------
  function setReadout(text) { $("stkReadout").textContent = text; }
  var HINT = "Drag to scroll back in time. Pinch to zoom. Touch a candle to see it.";
  function showCross(clientX) {
    var svg = $("stkChart").querySelector("svg");
    if (!svg || !geo || !geo.xs.length) return;
    var rect = svg.getBoundingClientRect();
    var x = ((clientX - rect.left) / rect.width) * geo.W;
    var best = geo.xs[0], bd = Infinity;
    geo.xs.forEach(function (p) { var d = Math.abs(p.x - x); if (d < bd) { bd = d; best = p; } });
    var cross = svg.querySelector(".sp-cross"), dot = svg.querySelector(".sp-crossdot");
    cross.setAttribute("x1", best.x); cross.setAttribute("x2", best.x); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", best.x); dot.setAttribute("cy", best.y); dot.setAttribute("visibility", "visible");
    var c = geo.cs[best.i];
    setReadout(fmtStamp(c.t) + " · open " + money(c.o) + " · high " + money(c.h) +
      " · low " + money(c.l) + " · close " + money(c.c));
  }
  function hideCross() {
    var svg = $("stkChart").querySelector("svg");
    if (svg) {
      svg.querySelector(".sp-cross").setAttribute("visibility", "hidden");
      svg.querySelector(".sp-crossdot").setAttribute("visibility", "hidden");
    }
    setReadout(HINT);
  }

  // ---------- The stock page ----------
  // forceChart: redraw the chart even while a finger is on it (after a pan, zoom or range change)
  // forceTrades: rebuild the trades list (done less often, so taps on it are not lost)
  // chartOnly: only the chart and the numbers above it (used for the smooth animation)
  function renderStockPage(forceChart, forceTrades, chartOnly) {
    if (!openSym || $("vStock").classList.contains("hidden")) return;
    var s = findStock(openSym);
    if (!s) return;
    clampView(s);
    var built = windowCandles(s);
    var cs = built.cs;
    var ch = changeFrom(cs);
    var up = ch >= 0;

    $("stkName").textContent = s.name;
    $("stkSym").textContent = s.id;
    $("stkPrice").textContent = money(s.price);
    var chg = $("stkChange");
    chg.className = "sp-change " + (up ? "up" : "down");
    chg.innerHTML = "";
    chg.appendChild(document.createTextNode(pctText(ch)));
    chg.appendChild(el("span", "", "· " + (view.offset ? "scrolled back" : "1 candle = " + fmtSize(built.size))));

    if (!touching || forceChart) {
      geo = buildChart(cs, view.offset === 0, slots, built.size);
      $("stkChart").innerHTML = geo.html;
    }
    latest.style.display = view.offset > 0 ? "block" : "none";
    document.querySelectorAll("#stkRange button").forEach(function (b) {
      b.classList.toggle("active", b.dataset.range === range);
    });

    var hiVal = cs.length ? Math.max.apply(null, cs.map(function (c) { return c.h; })) : s.price;
    var loVal = cs.length ? Math.min.apply(null, cs.map(function (c) { return c.l; })) : s.price;
    $("stkOpen").textContent = money(cs.length ? cs[0].o : s.price);
    $("stkHigh").textContent = money(hiVal);
    $("stkLow").textContent = money(loVal);
    if (chartOnly) return;

    // Your position
    var h = holdings[s.id];
    var owned = h && h.shares > 0.01;
    var pos = $("stkPos");
    pos.innerHTML = "";
    if (!owned) {
      pos.appendChild(el("p", "none", "You don't own any yet. Buy some to start your position."));
    } else {
      var now = worthOf(s, h.shares);
      var profit = now - (h.cost || 0);
      [
        ["Shares you own", h.shares.toFixed(2)],
        ["Average cost", money((h.cost || 0) / h.shares)],
        ["You paid", money(h.cost || 0)],
        ["Worth if you sold now", money(now)]
      ].forEach(function (r) {
        var row = el("div", "sp-card-row");
        row.appendChild(el("span", "", r[0]));
        row.appendChild(el("span", "", r[1]));
        pos.appendChild(row);
      });
      var total = el("div", "sp-card-row total");
      total.appendChild(el("span", "", "Profit or loss"));
      var amt = el("span", "", (profit >= 0 ? "+" : "-") + money(Math.abs(profit)));
      amt.style.color = profit >= 0 ? "#3DF0B0" : "#FF6B7A";
      total.appendChild(amt);
      pos.appendChild(total);
    }
    $("stkSell").disabled = !owned;

    // The whole company
    var co = $("stkCompany");
    co.innerHTML = "";
    var held = s.held || 0;
    var shares = Wallet.stockShares;
    var mine = owned ? h.shares : 0;
    var with3k = Wallet.stockBuyShares(s, 3000);
    var after3k = Wallet.priceNow(Object.assign({}, s, { held: held + with3k }));
    var moveFor3k = (after3k / s.price - 1) * 100;
    [
      ["Company value", bigMoney(companyValue(s))],
      ["Shares in the company", shares.toLocaleString("en-US")],
      ["Held by players", Math.round(held).toLocaleString("en-US")],
      ["Still available to buy", Math.round(shares - held).toLocaleString("en-US")],
      ["Your share of the company", (mine / shares * 100).toFixed(2) + "%"],
      ["A $3,000 buy would move the price about", "+" + moveFor3k.toFixed(2) + "%"]
    ].forEach(function (r) {
      var row = el("div", "sp-card-row");
      row.appendChild(el("span", "", r[0]));
      row.appendChild(el("span", "", r[1]));
      co.appendChild(row);
    });

    if (forceTrades) renderTrades(s);
    updateAge();
  }

  function renderTrades(s) {
    var box = $("stkTrades");
    box.innerHTML = "";
    var mineTx = receipts.filter(function (t) {
      return t.symbol === s.id && (t.type === "stock_buy" || t.type === "stock_sell");
    }).slice(0, 12);
    if (!mineTx.length) {
      box.appendChild(el("p", "none", "No trades in " + s.name + " yet."));
      return;
    }
    mineTx.forEach(function (t) {
      var b = el("button", "sp-trade");
      b.type = "button";
      var left = el("div", "");
      left.appendChild(el("p", "t", t.title || "Trade"));
      var when = t.createdAt && t.createdAt.toDate ? t.createdAt.toDate() : null;
      left.appendChild(el("p", "d", when ? when.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Just now"));
      b.appendChild(left);
      b.appendChild(el("p", "a", (t.amount >= 0 ? "+" : "-") + money(Math.abs(t.amount))));
      b.addEventListener("click", function () { SB.openReceipt(t); });
      box.appendChild(b);
    });
  }

  // "Last trade 5 min ago" under the chart
  function updateAge() {
    var s = findStock(openSym);
    if (!s) { $("stkUpdated").textContent = ""; return; }
    var note = "The price moves a little all the time, and more when people buy or sell.";
    $("stkUpdated").textContent = (s.lastTrade ? "Last trade " + ago(Date.now() - s.lastTrade) + ". " : "No trades yet. ") + note;
  }

  function openStock(sym) {
    openSym = sym;
    view = { offset: 0, windowMs: RANGES[range].window };
    touching = false;
    renderStockPage(true, true);
    SB.showView("vStock");
  }

  // ---------- The chart animation: redraws about 30 times a second ----------
  function frame(ts) {
    if (!frameOn) return;
    if (openSym && !touching && !$("vStock").classList.contains("hidden") && ts - lastDraw >= 33) {
      lastDraw = ts;
      renderStockPage(false, false, true);
    }
    requestAnimationFrame(frame);
  }

  // ---------- Live prices (four times a second) ----------
  function tick() {
    if (!list.length) return;
    tickCount++;
    list.forEach(function (s) { s.price = Math.round(Wallet.priceNow(s) * 10000) / 10000; });
    if (tickCount % 4 === 0) list.forEach(function (s) { chg1h[s.id] = change1h(s); });
    updateList();
    updateHoldings();
    renderStockPage(false, tickCount % 20 === 0);
  }

  // ---------- Range buttons ----------
  document.querySelectorAll("#stkRange button").forEach(function (b) {
    b.addEventListener("click", function () {
      range = b.dataset.range;
      view = { offset: 0, windowMs: RANGES[range].window };
      touching = false;
      renderStockPage(true, false);
    });
  });

  // ---------- Chart gestures: drag to scroll back, pinch or wheel to zoom, touch to read ----------
  var card = $("stkChartCard");
  card.style.position = "relative";
  var latest = el("button", "sp-latest", "Latest ›");
  latest.type = "button";
  latest.id = "stkLatest";
  latest.style.cssText = "position:absolute;right:10px;top:8px;z-index:2;border:0;border-radius:999px;" +
    "padding:5px 11px;font-size:12px;font-weight:700;color:#fff;background:rgba(91,155,255,.4);display:none;";
  latest.addEventListener("click", function () {
    view.offset = 0;
    touching = false;
    renderStockPage(true, false);
  });
  card.appendChild(latest);

  function pointerDist() {
    var a = Array.from(pointers.values());
    return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1;
  }
  // How many screen pixels the plot is wide
  function plotPx() {
    var svg = $("stkChart").querySelector("svg");
    var w = svg ? svg.getBoundingClientRect().width : PLOT.W;
    return (w / PLOT.W) * (PLOT.W - PLOT.l - PLOT.r);
  }

  card.addEventListener("pointerdown", function (e) {
    card.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      gesture = { mode: "cross", x0: e.clientX, off0: view.offset };
      touching = true;
      showCross(e.clientX);
    } else if (pointers.size === 2) {
      gesture = { mode: "pinch", d0: pointerDist(), w0: view.windowMs };
      touching = true;
      hideCross();
    }
  });

  card.addEventListener("pointermove", function (e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    var s = findStock(openSym);
    if (!s || !gesture) return;
    if (gesture.mode === "pinch" && pointers.size === 2) {
      view.windowMs = clamp(gesture.w0 * gesture.d0 / pointerDist(), MIN_WINDOW, MAX_WINDOW);
      renderStockPage(true, false);
      return;
    }
    if (pointers.size !== 1) return;
    var dx = e.clientX - gesture.x0;
    if (gesture.mode === "cross" && Math.abs(dx) > 6) {
      gesture.mode = "pan";
      hideCross();
    }
    if (gesture.mode === "pan") {
      view.offset = gesture.off0 + dx * (view.windowMs / plotPx());
      renderStockPage(true, false);
    } else if (gesture.mode === "cross") {
      showCross(e.clientX);
    }
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      gesture = null;
      touching = false;
      hideCross();
    } else if (pointers.size === 1) {
      var rest = Array.from(pointers.values())[0];
      gesture = { mode: "pan", x0: rest.x, off0: view.offset };
    }
  }
  card.addEventListener("pointerup", endPointer);
  card.addEventListener("pointercancel", endPointer);
  card.addEventListener("pointerleave", function (e) {
    if (e.pointerType === "mouse") endPointer(e);
  });

  // Mouse wheel or trackpad: sideways scrolls back in time, up and down zooms
  card.addEventListener("wheel", function (e) {
    e.preventDefault();
    if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
      view.windowMs = clamp(view.windowMs * (e.deltaY > 0 ? 1.12 : 0.89), MIN_WINDOW, MAX_WINDOW);
    } else {
      view.offset -= Math.sign(e.deltaX) * view.windowMs * 0.05;
    }
    renderStockPage(true, false);
  }, { passive: false });

  // ---------- Buy and Sell ----------
  $("stkBuy").addEventListener("click", function () {
    var s = findStock(openSym);
    if (!s) return;
    SB.flow(async function () {
      var balance = SB.state.profile ? SB.state.profile.balance : 0;
      var amount = await SB.askAmount({
        title: "Buy " + s.name,
        sub: "Price now " + money(s.price) + ". Buying pushes the price up. Your balance: " + money(balance),
        max: balance,
        balance: balance,
        fee: true,
        button: "Buy Shares"
      });
      if (amount === null) return;
      var fee = SB.feeFor(amount);
      if (!(await SB.pinGate("Buying " + money(amount) + " of " + s.name + " + " + money(fee) + " fee"))) return;
      await SB.runBusy(
        "Buying…",
        function () { return Wallet.buyStock(SB.state.uid, s.id, amount, fee, SB.state.feeOwner); },
        "You bought " + s.name + "!",
        null,
        ["Checking the price…", "Buying " + s.name + "…", "Almost there…"]
      );
    });
  });

  $("stkSell").addEventListener("click", function () {
    var s = findStock(openSym);
    if (!s) return;
    var h = holdings[s.id];
    if (!h || !(h.shares > 0.01)) { SB.toast("You don't own any " + s.name + " yet."); return; }
    SB.flow(async function () {
      var maxValue = Math.floor(worthOf(s, h.shares) * 100) / 100;
      var amount = await SB.askAmount({
        title: "Sell " + s.name,
        sub: "Selling pushes the price down. You can sell up to " + money(maxValue) +
          ". The fee comes out of what you get.",
        max: maxValue,
        fee: false,
        button: "Sell Shares"
      });
      if (amount === null) return;
      var fee = SB.feeFor(amount);
      if (!(await SB.pinGate("Selling " + s.name + " for " + money(amount)))) return;
      await SB.runBusy(
        "Selling…",
        function () { return Wallet.sellStock(SB.state.uid, s.id, amount, fee, SB.state.feeOwner); },
        "You sold " + s.name + "! You get " + money(amount - fee) + ".",
        null,
        ["Checking the price…", "Selling " + s.name + "…", "Almost there…"]
      );
    });
  });

  // ---------- Live updates ----------
  function stopWatch() {
    if (stopStocks) { stopStocks(); stopStocks = null; }
    if (stopHoldings) { stopHoldings(); stopHoldings = null; }
    if (ticker) { clearInterval(ticker); ticker = null; }
    if (ageTimer) { clearInterval(ageTimer); ageTimer = null; }
    frameOn = false;
    cacheReady = false;
    closedCache = {};
    live = {};
    list = [];
    holdings = {};
    receipts = [];
    chg1h = {};
    rowRefs = {};
    holdRefs = {};
    $("stkList").innerHTML = "";
    $("stkHoldings").innerHTML = "";
  }

  function startWatch() {
    stopWatch();
    if (!SB.state.uid) return;
    stopStocks = Wallet.watchStocks(function (docs) {
      list = docs;
      buildList();
      buildHoldings();
      renderStockPage(true, true);
    });
    stopHoldings = Wallet.watchHoldings(SB.state.uid, function (map) {
      holdings = map;
      buildHoldings();
      renderStockPage(true, true);
    });
    // Money from the old stock market goes back first, then make sure the companies exist
    // (this also draws any hours you missed, so the chart catches up)
    Wallet.refundOldHoldings(SB.state.uid)
      .catch(function (e) { console.error(e); })
      .then(function () { return Wallet.ensureStocks(); })
      .catch(function (e) { console.error(e); })
      .then(function () { cacheReady = true; });
    ticker = setInterval(tick, Wallet.stockTickMs);
    ageTimer = setInterval(updateAge, 15000);
    if (!frameOn) { frameOn = true; requestAnimationFrame(frame); }
  }

  SB.on("receipts", function (rows) { receipts = rows || []; renderStockPage(false, true); });
  SB.on("start", function () { startWatch(); });
  SB.on("stop", function () { stopWatch(); });
})();
