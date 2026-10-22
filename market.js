// market.js: the stock market engine.
//
// The market runs on its own hidden calendar:
//  - 1 real hour = 1 market day. Prices take one step each market day.
//  - A market year = 360 market days (15 real days). The app never shows the calendar.
//  - Every 6th and 7th market day is flat, like a weekend.
//
// How prices work:
//  1. DAILY STEP: each company moves once per market day. The move is random, but each company
//     moves through phases (good streaks, steady stretches, bad stretches, crashes, comebacks).
//     Phases last a random number of days, so no two stretches repeat. Random news can hit too.
//     Every step is drawn once and saved, so everyone sees the same result.
//  2. GENTLE HOURS: during a market day the value glides smoothly to the next step.
//  3. PLAYERS: the more shares players hold, the higher the price goes (a curve).
//  4. CATCH-UP: missed market days are drawn when someone opens the app.
//
// price = base(time) x (1 + curve x shares held by players)
//
// This file replaces the old stock code in wallet.js (it loads after wallet.js).
(function () {
  if (!window.Wallet || !window.SB) return;
  var db = firebase.firestore();
  var FV = firebase.firestore.FieldValue;

  var STEP = 60 * 60 * 1000; // one market day = one real hour (never shown to players)
  var YEAR_DAYS = 360;       // a market year, for reference only
  var TOTAL = 100000;        // shares in each company
  var SPREAD = 0.02;         // you buy 2% above the price and sell 2% below it
  var MAX_MOVE = 0.05;       // one market day can move a company at most 5% either way
  var NEWS_CHANCE = 0.015;   // chance of a news shock on any market day
  var SEED = [
    { id: "NVLB", name: "Nova Labs",      p0: 10, c: 0.00005, drift: 0.0005,  vol: 0.008 }, // steady, slight upward lean
    { id: "BFEN", name: "Bluefin Energy", p0: 25, c: 0.00005, drift: 0.0002,  vol: 0.012 },
    { id: "ZNTH", name: "Zenith Motors",  p0: 40, c: 0.00008, drift: 0.0008,  vol: 0.015 }, // strongest lean, bumpier
    { id: "KLPF", name: "Kelp Foods",     p0: 8,  c: 0.00012, drift: -0.0006, vol: 0.025 }, // bumpy and leaning down
    { id: "TDAL", name: "Tidal Air",      p0: 15, c: 0.0001,  drift: -0.0003, vol: 0.02  }
  ];
  // The phases a company can be in. Each one has its own lean and how long it lasts (in market days).
  var PHASES = {
    good:     { drift: 0.0025,  min: 3, max: 12 },
    steady:   { drift: 0.0002,  min: 4, max: 14 },
    bad:      { drift: -0.0025, min: 3, max: 10 },
    comeback: { drift: 0.0035,  min: 3, max: 8 },  // bounce back after a big fall
    crash:    { drift: -0.008,  min: 2, max: 4 }
  };

  function round4(n) { return Math.round(n * 10000) / 10000; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function userRef(uid) { return db.collection("users").doc(uid); }
  function marketRef(sym) { return db.collection("market").doc(sym); }
  function stamp() { return FV.serverTimestamp(); }
  function fullName(p) { return ((p.firstName || "") + " " + (p.lastName || "")).trim(); }
  function newRef() { return "ST" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(); }

  function dayIndex(t) { return Math.floor(t / STEP); }
  // Every 6th and 7th market day is flat. (Market day 0 is the first hour since 1970.)
  function isFlatDay(d) { var k = d % 7; return k === 5 || k === 6; }

  function gauss() {
    var u = 1 - Math.random(), v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }

  function pickPhase(ratio) {
    // A company that has fallen a lot has a chance to bounce back
    if (ratio < 0.9 && Math.random() < 0.35) return "comeback";
    var r = Math.random();
    if (r < 0.3) return "good";
    if (r < 0.55) return "steady";
    if (r < 0.9) return "bad";
    return "crash";
  }
  // One market day's move for a company. `st` is its phase, `ratio` is its value vs the start price.
  function stepDay(seed, st, d, ratio) {
    if (isFlatDay(d)) return { mood: 0, st: st };
    var phase = st.phase, left = st.left;
    if (left <= 0) {
      phase = pickPhase(ratio);
      left = randInt(PHASES[phase].min, PHASES[phase].max);
    }
    var m = PHASES[phase].drift + seed.drift + seed.vol * 0.35 * gauss();
    if (Math.random() < NEWS_CHANCE) {
      var size = 0.02 + Math.random() * 0.02;
      m += Math.random() < 0.5 ? -size : size;
    }
    m = Math.max(-MAX_MOVE, Math.min(MAX_MOVE, m));
    return { mood: round4(m), st: { phase: phase, left: left - 1 } };
  }

  function moodOf(s, d) {
    var v = s.moods ? s.moods[d] : undefined;
    return typeof v === "number" ? v : 0;
  }

  // The company's base value at a moment: the start price, moved by each market day's step
  function baseAt(s, t) {
    var d = dayIndex(t);
    var f = (t - d * STEP) / STEP;
    if (d < s.startDay) return s.p0;
    var value = s.p0;
    for (var x = s.startDay; x < d; x++) value *= 1 + moodOf(s, x);
    return value * (1 + moodOf(s, d) * f);
  }
  // How many shares players held at a moment (from the saved log)
  function heldAt(s, t) {
    var log = s.heldLog || [];
    var lo = 0, hi = log.length - 1, found = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (log[mid].t <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found < 0 ? 0 : log[found].held;
  }
  // Keep the newest 2000 trades, plus one older entry so prices from before the cut stay the same
  function trimLog(all) {
    var cut = all.length - 2000;
    return cut > 0 ? [all[cut - 1]].concat(all.slice(cut)) : all;
  }
  function priceAt(s, t) { return baseAt(s, t) * (1 + s.c * heldAt(s, t)); }
  // Live "tick" wiggle: small up and down moves every half second. Everyone sees the same wiggle
  // (it comes from the clock), and it's only a little, so the real price still moves by the hour.
  var JITTER = 0.0008; // about 0.08%: enough to see it move
  var WIGGLE_MS = 250;  // a new random nudge every quarter second, blended smoothly
  function wiggle(id, n) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 100000;
    var x = Math.sin(n * 12.9898 + h * 78.233) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1; // between -1 and 1
  }
  // Blend between two nudges so the price drifts up and down instead of jumping
  function smoothWiggle(id, t) {
    var k = t / WIGGLE_MS, n0 = Math.floor(k), f = k - n0;
    var u = f * f * (3 - 2 * f);
    return wiggle(id, n0) * (1 - u) + wiggle(id, n0 + 1) * u;
  }
  function displayPrice(s, t) {
    return priceAt(s, t) * (1 + JITTER * smoothWiggle(s.id, t));
  }
  function priceNow(s) { return displayPrice(s, Date.now()); }

  // Value of owning `n` shares when `held` are already out there, at time t (spread not included)
  function grossSellValue(s, held, n, t) {
    var base = baseAt(s, t) * (1 + JITTER * smoothWiggle(s.id, t)), steps = 200, step = n / steps, total = 0;
    for (var i = 0; i < steps; i++) {
      var h = held - (i + 0.5) * step;
      total += step * base * (1 + s.c * h);
    }
    return total;
  }
  // Shares you get for paying `dollars` (spread included)
  function buySharesFor(s, dollars, t) {
    var eff = dollars / (1 + SPREAD), steps = 200, base = baseAt(s, t), held = s.held || 0, shares = 0;
    var slice = eff / steps;
    for (var i = 0; i < steps; i++) {
      var price = base * (1 + s.c * (held + shares));
      shares += slice / price;
    }
    return shares;
  }
  // Shares you must sell to bring in `dollars` (spread included). null if you don't hold enough.
  function sellSharesFor(s, dollars, t) {
    var target = dollars / (1 - SPREAD), held = s.held || 0;
    if (grossSellValue(s, held, held, t) < target) return null;
    var lo = 0, hi = held;
    for (var i = 0; i < 60; i++) {
      var mid = (lo + hi) / 2;
      if (grossSellValue(s, held, mid, t) < target) lo = mid; else hi = mid;
    }
    return hi;
  }

  // Candlesticks for a chart: `n` candles across the range. Each candle has open, high, low, close.
  function candles(s, rangeMs, n) {
    var now = Date.now();
    var start = rangeMs === Infinity ? s.startAt : Math.max(s.startAt, now - rangeMs);
    var span = Math.max(1000, now - start);
    var bucket = span / n, out = [], SAMPLES = 8;
    for (var i = 0; i < n; i++) {
      var a = start + i * bucket;
      var vals = [];
      for (var j = 0; j <= SAMPLES; j++) {
        var t = Math.min(now, a + bucket * j / SAMPLES);
        vals.push(displayPrice(s, t));
      }
      out.push({
        t: Math.round(a),
        o: round4(vals[0]),
        h: round4(Math.max.apply(null, vals)),
        l: round4(Math.min.apply(null, vals)),
        c: round4(vals[vals.length - 1])
      });
    }
    out[n - 1].c = round4(priceNow(s));
    out[n - 1].h = Math.max(out[n - 1].h, out[n - 1].c);
    out[n - 1].l = Math.min(out[n - 1].l, out[n - 1].c);
    return out;
  }

  // Candles of a fixed length (sizeMs), n of them, the last one ending at endT (default: now).
  // Candles from before the company started are left out.
  function candlesAt(s, sizeMs, n, endT) {
    var now = Date.now();
    var end = endT === undefined ? now : Math.min(endT, now);
    var out = [], SAMPLES = 8;
    for (var i = 0; i < n; i++) {
      var a = end - (n - i) * sizeMs;
      var b = a + sizeMs;
      if (b <= s.startAt) continue;
      var vals = [];
      for (var j = 0; j <= SAMPLES; j++) {
        var t = Math.max(s.startAt, Math.min(now, a + sizeMs * j / SAMPLES));
        vals.push(displayPrice(s, t));
      }
      out.push({
        t: Math.round(Math.max(a, s.startAt)),
        o: round4(vals[0]),
        h: round4(Math.max.apply(null, vals)),
        l: round4(Math.min.apply(null, vals)),
        c: round4(vals[vals.length - 1])
      });
    }
    return out;
  }

  // The price line for a chart: sampled points from the start of the range to now
  function chartSeries(s, rangeMs, n) {
    var now = Date.now();
    var start = rangeMs === Infinity ? s.startAt : Math.max(s.startAt, now - rangeMs);
    var pts = [];
    for (var i = 0; i < n; i++) {
      var t = start + (now - start) * i / (n - 1);
      pts.push({ t: Math.round(t), p: round4(priceAt(s, t)) });
    }
    pts[n - 1] = { t: now, p: round4(priceNow(s)) };
    return pts;
  }

  // The company's value relative to its start, at the end of day `last`
  function ratioAt(d, last) {
    var v = 1;
    for (var x = d.startDay; x <= last; x++) {
      var m = d.moods && typeof d.moods[x] === "number" ? d.moods[x] : 0;
      v *= 1 + m;
    }
    return v;
  }

  // Creates any missing company, and draws any market days that haven't been drawn yet
  async function ensureMarket() {
    var nowAll = Date.now();
    var todayAll = dayIndex(nowAll);
    for (var i = 0; i < SEED.length; i++) {
      var seed = SEED[i];
      var ref = marketRef(seed.id);
      await db.runTransaction(async function (tx) {
        var snap = await tx.get(ref);
        var now = Date.now();
        var today = dayIndex(now);
        if (!snap.exists || !snap.data().moods) {
          // New company, or an old one from before this market: start it fresh from today
          var held0 = snap.exists ? (snap.data().held || 0) : 0;
          var first = stepDay(seed, { phase: "steady", left: 0 }, today, 1);
          var moods = {};
          moods[today] = first.mood;
          tx.set(ref, {
            name: seed.name, p0: seed.p0, c: seed.c, drift: seed.drift, vol: seed.vol,
            held: held0, startDay: today, startAt: now, moods: moods,
            phase: first.st.phase, phaseLeft: first.st.left,
            heldLog: [{ t: now, held: held0 }],
            lastTrade: snap.exists ? (snap.data().lastTrade || 0) : 0
          });
          return;
        }
        var d = snap.data(), last = -Infinity;
        Object.keys(d.moods).forEach(function (k) { last = Math.max(last, Number(k)); });
        var updates = {};
        var st = { phase: d.phase || "steady", left: d.phaseLeft || 0 };
        var ratio = ratioAt(d, last);
        for (var x = last + 1; x <= today; x++) {
          var r = stepDay(seed, st, x, ratio);
          st = r.st;
          updates["moods." + x] = r.mood;
          ratio *= 1 + r.mood;
        }
        if (Object.keys(updates).length) {
          updates.phase = st.phase;
          updates.phaseLeft = st.left;
          tx.update(ref, updates);
        }
      });
    }
  }

  // Each company, with its live price
  function watchMarket(callback) {
    return db.collection("market").onSnapshot(function (snap) {
      var docs = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      docs.sort(function (a, b) {
        return SEED.findIndex(function (s) { return s.id === a.id; }) -
               SEED.findIndex(function (s) { return s.id === b.id; });
      });
      docs.forEach(function (s) { s.price = round4(priceNow(s)); });
      callback(docs);
    }, function (err) { console.error(err); });
  }

  // Your shares. Only the new-style holdings count (version 2).
  function watchHoldings(uid, callback) {
    return userRef(uid).collection("holdings").onSnapshot(function (snap) {
      var map = {};
      snap.docs.forEach(function (d) { if (d.data().v === 2) map[d.id] = d.data(); });
      callback(map);
    }, function (err) { console.error(err); });
  }

  // Old positions from before this market: money goes back at what you paid, once.
  async function refundOldHoldings(uid) {
    var snap = await userRef(uid).collection("holdings").get();
    var old = snap.docs.filter(function (d) { return d.data().v !== 2; });
    for (var i = 0; i < old.length; i++) {
      var hRef = old[i].ref;
      await db.runTransaction(async function (tx) {
        var hSnap = await tx.get(hRef);
        if (!hSnap.exists || hSnap.data().v === 2) return;
        var uSnap = await tx.get(userRef(uid));
        var cost = round2(hSnap.data().cost || 0);
        tx.update(userRef(uid), { balance: round2((uSnap.data().balance || 0) + cost) });
        tx.delete(hRef);
        tx.set(userRef(uid).collection("transactions").doc(), {
          type: "stock_refund", title: "Stock market reset: money back", amount: cost, createdAt: stamp()
        });
      });
    }
  }

  // Buy: you pay `amount` (the fee is on top). Your shares follow the price curve.
  async function buyStock(uid, symbol, amount, fee, ownerUid) {
    amount = round2(amount);
    fee = round2(fee || 0);
    if (!ownerUid || ownerUid === uid) fee = 0;
    var total = round2(amount + fee);
    var uRef = userRef(uid);
    var sRef = marketRef(symbol);
    var hRef = uRef.collection("holdings").doc(symbol);
    var oRef = fee > 0 ? userRef(ownerUid) : null;
    var txRef = uRef.collection("transactions").doc();
    var oTx = oRef ? oRef.collection("transactions").doc() : null;
    var feesRef = db.collection("config").doc("fees");
    var ref = newRef();

    await db.runTransaction(async function (tx) {
      var uSnap = await tx.get(uRef);
      var sSnap = await tx.get(sRef);
      var hSnap = await tx.get(hRef);
      var oSnap = oRef ? await tx.get(oRef) : null;
      if (!uSnap.exists) throw new Error("Your account wasn't found.");
      if (!sSnap.exists || !sSnap.data().moods) throw new Error("That stock isn't available right now.");
      if (fee > 0 && !oSnap.exists) throw new Error("The fee account isn't set up yet.");
      var u = uSnap.data();
      if ((u.balance || 0) < total) throw new Error("You don't have enough money for that.");

      var now = Date.now();
      var s = sSnap.data();
      var shares = buySharesFor(s, amount, now);
      if (!(shares > 0)) throw new Error("That's too small to buy.");
      if ((s.held || 0) + shares > TOTAL + 0.000001) throw new Error("There aren't enough shares left to buy that much right now.");
      var h = hSnap.exists && hSnap.data().v === 2 ? hSnap.data() : { shares: 0, cost: 0 };
      var newHeld = (s.held || 0) + shares;
      var log = trimLog((s.heldLog || []).concat([{ t: now, held: round4(newHeld) }]));

      tx.update(uRef, { balance: round2((u.balance || 0) - total) });
      if (oRef) {
        tx.update(oRef, { balance: round2((oSnap.data().balance || 0) + fee) });
        tx.set(feesRef, { total: FV.increment(fee) }, { merge: true });
        tx.set(oTx, { type: "fee", title: "Stock fee from " + fullName(u), amount: fee, ref: ref, createdAt: stamp() });
      }
      tx.set(hRef, { v: 2, shares: round4((h.shares || 0) + shares), cost: round2((h.cost || 0) + total) });
      tx.update(sRef, { held: round4(newHeld), heldLog: log, lastTrade: now });
      tx.set(txRef, {
        type: "stock_buy", title: "Bought " + s.name, amount: -total, fee: fee,
        symbol: symbol, shares: round4(shares), pricePer: round4(amount / shares), ref: ref, createdAt: stamp()
      });
    });
    return ref;
  }

  // Sell: `amount` is what the sale brings in before the fee. The fee comes out of it.
  async function sellStock(uid, symbol, amount, fee, ownerUid) {
    amount = round2(amount);
    fee = round2(fee || 0);
    if (!ownerUid || ownerUid === uid) fee = 0;
    var receive = round2(amount - fee);
    var uRef = userRef(uid);
    var sRef = marketRef(symbol);
    var hRef = uRef.collection("holdings").doc(symbol);
    var oRef = fee > 0 ? userRef(ownerUid) : null;
    var txRef = uRef.collection("transactions").doc();
    var oTx = oRef ? oRef.collection("transactions").doc() : null;
    var feesRef = db.collection("config").doc("fees");
    var ref = newRef();

    await db.runTransaction(async function (tx) {
      var uSnap = await tx.get(uRef);
      var sSnap = await tx.get(sRef);
      var hSnap = await tx.get(hRef);
      var oSnap = oRef ? await tx.get(oRef) : null;
      if (!uSnap.exists) throw new Error("Your account wasn't found.");
      if (!sSnap.exists || !sSnap.data().moods) throw new Error("That stock isn't available right now.");
      if (fee > 0 && !oSnap.exists) throw new Error("The fee account isn't set up yet.");
      if (!hSnap.exists || hSnap.data().v !== 2 || !(hSnap.data().shares > 0)) throw new Error("You don't own any of this stock.");

      var u = uSnap.data();
      var now = Date.now();
      var s = sSnap.data();
      var h = hSnap.data();
      var n = sellSharesFor(s, amount, now);
      if (n === null || n > h.shares + 0.000001) throw new Error("You don't have that many shares to sell.");
      n = Math.min(n, h.shares);
      var newHeld = Math.max(0, (s.held || 0) - n);
      var newShares = Math.max(0, h.shares - n);
      var costLeft = round2(h.cost * (newShares / h.shares));
      var log = trimLog((s.heldLog || []).concat([{ t: now, held: round4(newHeld) }]));

      tx.update(uRef, { balance: round2((u.balance || 0) + receive) });
      if (oRef) {
        tx.update(oRef, { balance: round2((oSnap.data().balance || 0) + fee) });
        tx.set(feesRef, { total: FV.increment(fee) }, { merge: true });
        tx.set(oTx, { type: "fee", title: "Stock fee from " + fullName(u), amount: fee, ref: ref, createdAt: stamp() });
      }
      tx.set(hRef, { v: 2, shares: round4(newShares), cost: costLeft });
      tx.update(sRef, { held: round4(newHeld), heldLog: log, lastTrade: now });
      tx.set(txRef, {
        type: "stock_sell", title: "Sold " + s.name, amount: receive, fee: fee,
        symbol: symbol, shares: round4(n), pricePer: round4(amount / n), ref: ref, createdAt: stamp()
      });
    });
    return ref;
  }

  Object.assign(window.Wallet, {
    stockList: SEED,
    stockShares: TOTAL,
    stockTickMs: 250,
    stockBuyPrice: function (p) { return p * (1 + SPREAD); },
    stockSellPrice: function (p) { return p * (1 - SPREAD); },
    priceNow: priceNow,
    chartSeries: chartSeries,
    candles: candles,
    candlesAt: candlesAt,
    priceAtTime: function (s, t) { return displayPrice(s, t); },
    stockBuyShares: function (s, dollars) { return buySharesFor(s, dollars, Date.now()); },
    stockSellValue: function (s, shares) {
      return shares > 0 ? grossSellValue(s, s.held || 0, shares, Date.now()) * (1 - SPREAD) : 0;
    },
    ensureStocks: ensureMarket,
    tickStocks: async function () {},
    watchStocks: watchMarket,
    watchHoldings: watchHoldings,
    refundOldHoldings: refundOldHoldings,
    buyStock: buyStock,
    sellStock: sellStock
  });
})();
