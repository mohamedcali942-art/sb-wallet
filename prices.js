// The share price formula, shared by the stock market and the bank.
// These lines are copied exactly from stocks.js. If one changes, change both.
(function () {
  var STEP = 60 * 60 * 1000; // one market day = one real hour (never shown to players)
  var TOTAL = 100000;        // shares in each company
  var SPREAD = 0.02;         // you buy 2% above the price and sell 2% below it
  function dayIndex(t) { return Math.floor(t / STEP); }
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

  window.MarketPrice = {
    STEP: STEP, TOTAL: TOTAL, SPREAD: SPREAD,
    dayIndex: dayIndex, moodOf: moodOf, baseAt: baseAt, heldAt: heldAt, trimLog: trimLog,
    priceAt: priceAt, displayPrice: displayPrice, priceNow: priceNow,
    grossSellValue: grossSellValue, buySharesFor: buySharesFor, sellSharesFor: sellSharesFor
  };
})();
