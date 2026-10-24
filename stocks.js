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
// Word lists for generated headlines. Placeholders: {n} company, {city}, {product}, {partner}, {amt} (millions), {k} (small number).
var WORLD = {
  cities: ["Nairobi", "Lagos", "Lisbon", "Denver", "Toronto", "Osaka", "Berlin", "Lima", "Austin", "Cairo", "Seoul", "Madrid", "Accra", "Sydney", "Oslo"],
  products: ["Pulse", "Nimbus", "Atlas Pro", "Orbit", "Cascade", "Vantage X", "Lumen", "Terra", "Ember", "Quartz", "Helix", "Drift"],
  partners: ["Brightwell Group", "Halden Partners", "Kestrel Holdings", "Oakridge Capital", "Marlow and Co", "Tessera Labs", "Northgate Trust", "Ravenna Systems", "Fenwick Logistics", "Calder Industries"],
  upVerbs: ["beats expectations this quarter", "wins a contract worth ${amt} million", "opens a new plant in {city}", "signs a deal with {partner}", "launches {product}", "raises its profit forecast", "is upgraded by analysts", "secures ${amt} million in new funding", "cuts costs by {k} percent", "gets approval to sell {product} in {city}"],
  downVerbs: ["misses sales targets this quarter", "faces a ${amt} million lawsuit", "recalls {k} thousand units of {product}", "loses a contract with {partner}", "delays the launch of {product}", "closes a plant in {city}", "is downgraded by analysts", "reports a loss in {city}", "is hit by supply delays in {city}", "sees demand slow in {city}"],
  bizVerbs: ["opens a research lab in {city}", "invested ${amt} million in a new {product} line", "is working on {product}, which it expects to finish next year", "plans to expand into {city} within {k} months", "hired {k} new engineers for its {city} office", "signed a supply deal with {partner}", "is testing {product} with customers in {city}", "appointed a new head of research", "agreed to buy a smaller rival for ${amt} million", "began a {k}-year plan to cut waste across its factories", "is building a new warehouse in {city} worth ${amt} million", "is looking for partners to help launch {product} abroad"],
  bizBody: ["{n} confirmed the news in a statement. The company said the work is part of a longer plan and will share more when there is something concrete to report.", "Investors in the {s} sector are watching closely, since moves like this can change how a company grows over the next few years.", "Analysts said it is too early to judge the effect on profit, but they called the move sensible and in line with the company's goals.", "The news did not change the share price much on the day. Traders said they will watch the next results for signs of how the plan is going."]
};
// Fills the {keys} in a string. Keys we don't know are left alone, so later steps can fill them.
function fillIn(str, vals) {
  return str.replace(/\{(\w+)\}/g, function (m, k) { return vals[k] !== undefined ? String(vals[k]) : m; });
}
function pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
// Each company belongs to a category. Used for grouping and the headline filters.
var SECTOR_OF = {
  NVLB: "Technology", LMSW: "Technology", PLXM: "Technology",
  BFEN: "Energy", SLRP: "Energy",
  KLPF: "Food", NWFD: "Food", VRDN: "Food",
  HRBR: "Health", MDRX: "Health",
  VNTG: "Finance", SMMT: "Finance",
  TDAL: "Travel", ATLS: "Travel",
  CRSR: "Retail", BLMS: "Retail",
  ZNTH: "Industry", IRNB: "Industry", PCMN: "Industry", CDRA: "Industry",
  SKYL: "Property"
};
(function () {
  if (!window.Wallet || !window.SB) return;
  var db = firebase.firestore();
  var FV = firebase.firestore.FieldValue;

  var STEP = 60 * 60 * 1000; // one market day = one real hour (never shown to players)
  var YEAR_DAYS = 360;       // a market year, for reference only
  var TOTAL = 100000;        // shares in each company
  var SPREAD = 0.02;         // you buy 2% above the price and sell 2% below it
  var MAX_MOVE = 0.05;       // one market day can move a company at most 5% either way
  var NEWS_CHANCE = 0.08;   // chance of a news shock on any market day
  // Stories for news shocks. Fictional companies and fictional news. {n} is the company name, {p} the move in percent.
  var STORIES = {
    up: [
      { t: "{n} wins a big new contract", b: "{n} has signed a multi-year deal worth more than analysts had expected. The company said the contract starts next quarter and will bring steady income for years. Investors reacted quickly and pushed the share price up {p}%." },
      { t: "{n} beats expectations this quarter", b: "Profit at {n} came in above what analysts predicted, helped by strong sales and lower costs. Management raised its outlook for the rest of the year. The stock rose {p}% as investors bought in." },
      { t: "{n} opens a new factory", b: "{n} is opening a production site that will double its output within two years. Hiring starts this month, with several hundred jobs planned. Shares climbed {p}% on the news." },
      { t: "Analysts raise their view on {n}", b: "Three major research firms upgraded {n} this morning, calling its growth underpriced. Their new targets sit well above the current share price. The stock gained {p}%." },
      { t: "{n} launches a product people love", b: "A new product from {n} sold out in its first week, and early reviews have been unusually strong. The company is already working on a second version. The share price is up {p}%." },
      { t: "{n} signs a partnership deal", b: "{n} has agreed to a partnership that opens two new markets for its services. The companies will share costs for the first year. Shares moved up {p}% in active trading." },
      { t: "{n} cuts costs and lifts margins", b: "{n} announced a plan to cut running costs by a tenth, which should lift profit margins. Staff were told the changes will come in gradually. The share price rose {p}%." },
      { t: "{n} raises new money at a higher value", b: "{n} raised funds from long-term investors at a higher valuation than its last round. The cash will go into research and new sites. Shares rose {p}%." },
      { t: "Regulators approve {n}'s expansion", b: "Regulators approved {n}'s plan to expand into a new region. The company expects to start operating there in the spring. The share price is up {p}%." },
      { t: "Strong demand lifts {n}", b: "Orders for {n}'s products have come in faster than expected, and its warehouses are running at full capacity. Management said it will add a second shift. Shares gained {p}%." },
      { t: "{n} names a new chief executive", b: "{n} appointed a chief executive with a strong record of growing companies like it. The board said the change will bring sharper focus on profit. Shares rose {p}%." },
      { t: "{n} pays a bigger dividend", b: "{n} will pay shareholders a larger dividend this year after a strong run of cash flow. The board said it expects to keep increasing payouts. The share price is up {p}%." }
    ],
    down: [
      { t: "{n} hit by supply delays", b: "Shipments from {n}'s main supplier were held up for two weeks, leaving some customers waiting. The company expects to catch up by the end of the quarter. The share price fell {p}%." },
      { t: "{n} misses its sales target", b: "Sales at {n} came in below what the company had forecast, mainly in its biggest market. Management said it is reviewing prices and marketing. Shares dropped {p}%." },
      { t: "{n} faces a lawsuit", b: "A customer group has filed a lawsuit against {n}, claiming the company misled buyers. {n} said it believes the claim has no merit and will defend itself. Shares slipped {p}%." },
      { t: "A rival launch takes customers from {n}", b: "A competitor launched a cheaper version of {n}'s best-selling product this week. Analysts expect some customers to switch in the short term. The share price fell {p}%." },
      { t: "{n} loses a key contract", b: "{n} will no longer supply a major client after its contract ended without renewal. The company said it is already talking to other buyers. Shares fell {p}%." },
      { t: "Cost overruns weigh on {n}", b: "Building costs at one of {n}'s projects have risen well above the original budget. The company is looking for ways to close the gap. The stock dropped {p}%." },
      { t: "{n} recalls a product batch", b: "{n} has recalled a batch of products after a quality check found a fault. The company said no one was hurt and the fix is already under way. Shares fell {p}%." },
      { t: "Regulators open a probe into {n}", b: "Regulators have opened a review into {n}'s pricing. The company said it will cooperate fully. Investors sold shares, and the price fell {p}%." },
      { t: "{n} delays its next launch", b: "{n} has pushed back its next product by several months to fix a problem found in testing. Shares dropped {p}% as investors lowered their expectations." },
      { t: "Credit rating cut for {n}", b: "A major rating agency lowered its view of {n}'s debt, saying borrowing costs could rise. The company said its cash position remains strong. Shares fell {p}%." },
      { t: "Key executive leaves {n}", b: "The head of sales at {n} has stepped down with immediate effect. A replacement has not been named yet. Shares fell {p}% on the uncertainty." },
      { t: "Weak demand hits {n}", b: "Fewer customers than expected bought {n}'s products this quarter, and the company warned the slowdown may last a few months. Shares fell {p}%." }
    ]
  };
  // A second paragraph for each story, so an article has more to say
  var EXTRA = {
    up: [
      "Other companies in the {s} sector also gained as investors looked for signs of a stronger season ahead.",
      "Market watchers say the news could bring more buyers over the coming weeks, especially long-term investors looking for steady growth.",
      "The company has not said yet how much this will add to profit. Analysts plan to update their forecasts after the next report.",
      "Traders described the move as orderly, with buying spread across the day rather than in one burst."
    ],
    down: [
      "Other companies in the {s} sector also slipped as investors moved money to safer places for a while.",
      "Some analysts think the drop may be short-lived if the company responds quickly, while others want to see results first.",
      "The company has not said how long the problem will last. Analysts will update their forecasts after the next report.",
      "Traders said selling came in steadily through the day, with no sign of panic."
    ]
  };
  var SEED = [
    { id: "NVLB", name: "Nova Labs",      p0: 10, c: 0.00005, drift: 0.0005,  vol: 0.008 }, // steady, slight upward lean
    { id: "BFEN", name: "Bluefin Energy", p0: 25, c: 0.00005, drift: 0.0002,  vol: 0.012 },
    { id: "ZNTH", name: "Zenith Motors",  p0: 40, c: 0.00008, drift: 0.0008,  vol: 0.015 }, // strongest lean, bumpier
    { id: "KLPF", name: "Kelp Foods",     p0: 8,  c: 0.00012, drift: -0.0006, vol: 0.025 }, // bumpy and leaning down
    { id: "TDAL", name: "Tidal Air",      p0: 15, c: 0.0001,  drift: -0.0003, vol: 0.02  },
    { id: "HRBR", name: "Harbor Health",    p0: 32, c: 0.00006, drift: 0.0004,  vol: 0.010 },
    { id: "IRNB", name: "Ironbridge Logistics", p0: 18, c: 0.00008, drift: 0.0001, vol: 0.014 },
    { id: "SLRP", name: "Solaris Power",    p0: 22, c: 0.00007, drift: 0.0006,  vol: 0.013 },
    { id: "CRSR", name: "Crescent Retail",  p0: 12, c: 0.0001,  drift: -0.0002, vol: 0.018 },
    { id: "NWFD", name: "Northwind Foods",  p0: 9,  c: 0.00012, drift: 0.0002,  vol: 0.016 },
    { id: "VNTG", name: "Vantage Bank",     p0: 50, c: 0.00005, drift: 0.0003,  vol: 0.009 },
    { id: "PCMN", name: "Pinecrest Mining", p0: 6,  c: 0.00015, drift: -0.0004, vol: 0.03  },
    { id: "LMSW", name: "Lumen Software",   p0: 28, c: 0.00007, drift: 0.0007,  vol: 0.017 },
    { id: "ATLS", name: "Atlas Airways",    p0: 14, c: 0.00009, drift: -0.0001, vol: 0.022 },
    { id: "CDRA", name: "Cedar Auto",       p0: 36, c: 0.00006, drift: 0.0001,  vol: 0.012 },
    { id: "PLXM", name: "Pluxa Mobile",     p0: 34, c: 0.00007, drift: 0.0005,  vol: 0.016 },
    { id: "VRDN", name: "Verdant Farms",    p0: 11, c: 0.0001,  drift: 0.0001,  vol: 0.017 },
    { id: "MDRX", name: "Meridian Pharma",  p0: 44, c: 0.00006, drift: 0.0003,  vol: 0.011 },
    { id: "SKYL", name: "Skyline Homes",    p0: 20, c: 0.00008, drift: -0.0001, vol: 0.015 },
    { id: "SMMT", name: "Summit Capital",   p0: 27, c: 0.00006, drift: 0.0002,  vol: 0.010 },
    { id: "BLMS", name: "Blue Mesa Retail", p0: 16, c: 0.0001,  drift: -0.0002, vol: 0.020 }
  ];
  // The phases a company can be in. Each one has its own lean and how long it lasts (in market days).
  var PHASES = {
    good:     { drift: 0.0035,  min: 3, max: 12 },
    steady:   { drift: 0.0012,  min: 4, max: 14 },
    bad:      { drift: -0.0010, min: 3, max: 10 },
    comeback: { drift: 0.0040,  min: 3, max: 8 },  // bounce back after a big fall
    crash:    { drift: -0.0040, min: 2, max: 4 }
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
    if (r < 0.35) return "good";
    if (r < 0.72) return "steady";
    if (r < 0.96) return "bad";
    return "crash";
  }
  // One market day's move for a company. `st` is its phase, `ratio` is its value vs the start price.
  // One market day's move for a company. `st` is its phase, `ratio` is its value vs the start price,
  // `bonus` is the extra growth from money invested in it. Returns the move and any headline.
  function stepDay(seed, st, d, ratio, bonus) {
    if (isFlatDay(d)) return { mood: 0, st: st, news: null };
    var phase = st.phase, left = st.left;
    if (left <= 0) {
      phase = pickPhase(ratio);
      left = randInt(PHASES[phase].min, PHASES[phase].max);
    }
    var m = PHASES[phase].drift + seed.drift + (bonus || 0) + seed.vol * 0.35 * gauss();
    var news = null;
    if (Math.random() < NEWS_CHANCE) {
      var size = 0.02 + Math.random() * 0.02;
      var good = Math.random() < 0.5;
      m += good ? size : -size;
      var pct = (size * 100).toFixed(1);
      var sector = (SECTOR_OF[seed.id] || "market").toLowerCase();
      var extras = good ? EXTRA.up : EXTRA.down;
      var extra = extras[randInt(0, extras.length - 1)];
      var title, body;
      if (Math.random() < 0.5) {
        var pool = good ? STORIES.up : STORIES.down;
        var story = pool[randInt(0, pool.length - 1)];
        title = story.t;
        body = [story.b, extra].join("\n\n");
      } else {
        var vals = { city: pickOne(WORLD.cities), product: pickOne(WORLD.products), partner: pickOne(WORLD.partners), amt: 5 + randInt(0, 294), k: 2 + randInt(0, 8) };
        title = "{n} " + fillIn(pickOne(good ? WORLD.upVerbs : WORLD.downVerbs), vals);
        body = ["{n} confirmed the news in a statement. Shares moved {p}% as investors reacted to it.", extra].join("\n\n");
      }
      news = {
        text: title.split("{n}").join(seed.name),
        body: body.split("{n}").join(seed.name).split("{p}").join(pct).split("{s}").join(sector),
        m: round4(good ? size : -size)
      };
    }
    m = Math.max(-MAX_MOVE, Math.min(MAX_MOVE, m));
    return { mood: round4(m), st: { phase: phase, left: left - 1 }, news: news };
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

  // Money put into a company helps it grow: more held, a little faster growth (capped)
  function growthBonus(held, price) {
    var value = Math.max(0, held) * price;
    return Math.min(0.001, 0.0003 * Math.log(1 + value / 20000));
  }

  // Creates any missing company, moves older companies onto this version of the market,
  // and draws any market days that haven't been drawn yet
  async function ensureMarket() {
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
          var first = stepDay(seed, { phase: "steady", left: 0 }, today, 1, 0);
          var moods = {};
          moods[today] = first.mood;
          tx.set(ref, {
            name: seed.name, p0: seed.p0, c: seed.c, drift: seed.drift, vol: seed.vol,
            held: held0, startDay: today, startAt: now, moods: moods,
            phase: first.st.phase, phaseLeft: first.st.left,
            heldLog: [{ t: now, held: held0 }],
            lastTrade: snap.exists ? (snap.data().lastTrade || 0) : 0,
            news: first.news ? [{ t: first.news.text, b: first.news.body, m: first.news.m, at: today * STEP }] : [],
            v: 3
          });
          return;
        }
        var d = snap.data();
        if ((d.v || 0) < 3) {
          // Moving to the new market: today's price becomes the new start, so growth begins from here.
          // Your shares, cost and trade history stay exactly as they are.
          tx.set(ref, {
            name: d.name, p0: round4(baseAt(d, now)), c: d.c, drift: d.drift, vol: d.vol,
            held: d.held || 0, startDay: today, startAt: now, moods: {},
            phase: d.phase || "steady", phaseLeft: d.phaseLeft || 0,
            heldLog: d.heldLog || [{ t: now, held: d.held || 0 }],
            lastTrade: d.lastTrade || 0, news: [], v: 3
          });
          return;
        }
        var last = (d.startDay || today) - 1;
        Object.keys(d.moods || {}).forEach(function (k) { last = Math.max(last, Number(k)); });
        var updates = {};
        var st = { phase: d.phase || "steady", left: d.phaseLeft || 0 };
        var ratio = ratioAt(d, last);
        var bonus = growthBonus(d.held || 0, baseAt(d, now));
        var newNews = [];
        for (var x = last + 1; x <= today; x++) {
          var r = stepDay(seed, st, x, ratio, bonus);
          st = r.st;
          updates["moods." + x] = r.mood;
          ratio *= 1 + r.mood;
          if (r.news) newNews.push({ t: r.news.text, b: r.news.body, m: r.news.m, at: x * STEP });
        }
        if (Object.keys(updates).length) {
          updates.phase = st.phase;
          updates.phaseLeft = st.left;
          if (newNews.length) updates.news = (d.news || []).concat(newNews).slice(-20);
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

  // For the bank: every share you hold (with what is locked as collateral)
  function watchHoldingsAll(uid, callback) {
    return userRef(uid).collection("holdings").onSnapshot(function (snap) {
      var map = {};
      snap.docs.forEach(function (d) { if (d.data().v === 2) map[d.id] = d.data(); });
      callback(map);
    }, function (err) { console.error(err); });
  }
  // For the bank: every stock's market record, by symbol
  function watchMarketAll(callback) {
    return db.collection("market").onSnapshot(function (snap) {
      var map = {};
      snap.docs.forEach(function (d) { map[d.id] = Object.assign({ id: d.id }, d.data()); });
      callback(map);
    }, function (err) { console.error(err); });
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
      if (u.bank && u.bank.loan) throw new Error("Your card is locked while you owe a loan. Pay it off first.");
      if ((u.balance || 0) < total) throw new Error("You don't have enough money for that.");

      var now = Date.now();
      var s = Object.assign({ id: symbol }, sSnap.data());
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
      tx.set(hRef, { v: 2, shares: round4((h.shares || 0) + shares), cost: round2((h.cost || 0) + total), pledged: round4(h.pledged || 0) });
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
      if (!hSnap.exists || hSnap.data().v !== 2 || !(hSnap.data().shares - (hSnap.data().pledged || 0) > 0)) throw new Error("You don't own any free shares of this stock.");

      var u = uSnap.data();
      var now = Date.now();
      var s = Object.assign({ id: symbol }, sSnap.data());
      var h = hSnap.data();
      var n = sellSharesFor(s, amount, now);
      var free = Math.max(0, h.shares - (h.pledged || 0));
      if (n === null || n > free + 0.000001) throw new Error("You don't have that many free shares to sell. Some are locked as collateral.");
      n = Math.min(n, free);
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
      tx.set(hRef, { v: 2, shares: round4(newShares), cost: costLeft, pledged: round4(h.pledged || 0) });
      tx.update(sRef, { held: round4(newHeld), heldLog: log, lastTrade: now });
      tx.set(txRef, {
        type: "stock_sell", title: "Sold " + s.name, amount: receive, fee: fee,
        symbol: symbol, shares: round4(n), pricePer: round4(amount / n), ref: ref, createdAt: stamp()
      });
    });
    return ref;
  }

  // Sell exact shares, or every share you own (pass Infinity). The price is read inside the
  // transaction, so you get the price at the moment you confirm, and "all" leaves nothing behind.
  async function sellShares(uid, symbol, wantShares, feeFn, ownerUid) {
    var feeOn = !!ownerUid && ownerUid !== uid;
    var uRef = userRef(uid);
    var sRef = marketRef(symbol);
    var hRef = uRef.collection("holdings").doc(symbol);
    var oRef = feeOn ? userRef(ownerUid) : null;
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
      if (!hSnap.exists || hSnap.data().v !== 2 || !(hSnap.data().shares - (hSnap.data().pledged || 0) > 0)) throw new Error("You don't own any free shares of this stock.");

      var u = uSnap.data();
      var now = Date.now();
      var s = Object.assign({ id: symbol }, sSnap.data());
      var h = hSnap.data();
      var n = Math.min(wantShares, Math.max(0, h.shares - (h.pledged || 0)));
      if (!(n > 0)) throw new Error("Enter how many shares to sell.");
      var value = round2(grossSellValue(s, s.held || 0, n, now) * (1 - SPREAD));
      var fee = feeOn && feeFn ? round2(feeFn(value)) : 0;
      if (fee > 0 && !(oSnap && oSnap.exists)) throw new Error("The fee account isn't set up yet.");
      var receive = round2(value - fee);
      var newHeld = Math.max(0, (s.held || 0) - n);
      var newShares = Math.max(0, h.shares - n);
      var costLeft = round2(h.cost * (newShares / h.shares));
      var log = trimLog((s.heldLog || []).concat([{ t: now, held: round4(newHeld) }]));

      tx.update(uRef, { balance: round2((u.balance || 0) + receive) });
      if (oRef && fee > 0) {
        tx.update(oRef, { balance: round2((oSnap.data().balance || 0) + fee) });
        tx.set(feesRef, { total: FV.increment(fee) }, { merge: true });
        tx.set(oTx, { type: "fee", title: "Stock fee from " + fullName(u), amount: fee, ref: ref, createdAt: stamp() });
      }
      tx.set(hRef, { v: 2, shares: round4(newShares), cost: costLeft, pledged: round4(h.pledged || 0) });
      tx.update(sRef, { held: round4(newHeld), heldLog: log, lastTrade: now });
      tx.set(txRef, {
        type: "stock_sell", title: "Sold " + s.name, amount: receive, fee: fee,
        symbol: symbol, shares: round4(n), pricePer: round4(value / n), ref: ref, createdAt: stamp()
      });
    });
    return ref;
  }

  Object.assign(window.Wallet, {
    watchHoldingsAll: function (uid, cb) { return watchHoldingsAll(uid, cb); },
    watchMarketAll: function (cb) { return watchMarketAll(cb); },
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
    sellStock: sellStock,
    sellShares: sellShares
  });
})();

// ---------- The Stocks tab (the list, the stock page, buying and selling) ----------
// stocks.js: the Stocks tab (the list and your holdings) and the full-screen stock page
// (candlestick chart with zoom and scroll-back, stats, your position, the company, your trades, Buy and Sell).
// Prices come from market.js and move four times a second, so the screen moves while you watch.
(function () {
  if (!window.SB || !window.Wallet) return;
  var SB = window.SB;
  var Wallet = window.Wallet;
  var $ = SB.$;

  // Register first, so the list can still load even if a later setup step fails
  SB.on("receipts", function (rows) { receipts = rows || []; renderStockPage(false, true); });
  SB.on("start", function () { startWatch(); });
  SB.on("stop", function () { stopWatch(); });

  // Candle lengths from shortest to longest. Zooming picks the shortest length that keeps
  // at most 30 candles on screen. Zoomed in you see 5-second candles; zoomed out they merge into longer ones,
  // so the screen always shows a few big, solid candles instead of many thin ones.
  var LADDER = [5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400, 172800, 604800]
    .map(function (x) { return x * 1000; });
  var MAX_VISIBLE = 30;
  var MIN_WINDOW = 60 * 1000;                  // zoomed in as far as 12 five-second candles
  var MAX_WINDOW = 360 * 60 * 60 * 1000;       // a market year: 360 market days, 1 real hour each
  // The three buttons set where you start, zoomed in: each shows 30 candles of its length
  var RANGES = {
    "1H": { window: 30 * 5 * 1000 },
    "4H": { window: 30 * 15 * 1000 },
    "All": { window: 30 * 30 * 1000 }
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
  var slots = 30;       // how many candle places the chart has
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

  // ---------- The list: Apple-style rows (name, a small line, and a price with a change chip) ----------
  var SPARK_N = 40;
  function injectListStyles() {
    var css = "#stkList,#stkHoldings{display:flex;flex-direction:column;}" +
      ".stk-row.ap-row{display:flex;align-items:center;gap:12px;width:100%;box-sizing:border-box;margin:0 0 10px;" +
      "padding:14px;border:1px solid rgba(255,255,255,.06);border-radius:18px;background:#050505;color:#F8F8F8;box-shadow:none;text-align:left;}" +
      ".stk-row.ap-row:active{transform:scale(.985);}" +
      ".ap-left{flex:1;min-width:0;}" +
      ".ap-name{margin:0;font-size:16px;font-weight:700;color:#F8F8F8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}" +
      ".ap-sym{margin:3px 0 0;font-size:12px;color:#9A9A9A;}" +
      ".ap-spark{width:72px;height:30px;flex:none;}" +
      ".ap-right{flex:none;min-width:96px;text-align:right;}" +
      ".ap-px{margin:0;font-size:16px;font-weight:700;color:#F8F8F8;}" +
      ".ap-chip{display:inline-block;margin-top:6px;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:800;}" +
      ".ap-chip.up{background:#C1E8FF;color:#0F0F0F;}" +
      ".ap-chip.down{background:#FF453A;color:#FFFFFF;}";
    var st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);
  }
  // A small line for the last hour: green if it ended higher, red if lower
  function sparkD(s) {
    var now = Date.now(), span = 60 * 60 * 1000, pts = [];
    for (var i = 0; i < SPARK_N; i++) {
      var t = Math.max(s.startAt, now - span + (span * i) / (SPARK_N - 1));
      pts.push(Wallet.priceAtTime(s, t));
    }
    var lo = Math.min.apply(null, pts), hi = Math.max.apply(null, pts), r = hi - lo || 1;
    var d = pts.map(function (v, i) {
      var x = (i / (SPARK_N - 1)) * 72, y = 28 - ((v - lo) / r) * 26;
      return (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
    }).join(" ");
    return { d: d, up: pts[SPARK_N - 1] >= pts[0] };
  }
  function makeRow(name, sub, withSpark) {
    var b = el("button", "stk-row ap-row");
    b.type = "button";
    var left = el("div", "ap-left");
    left.appendChild(el("p", "ap-name", name));
    left.appendChild(el("p", "ap-sym", sub));
    b.appendChild(left);
    var path = null;
    if (withSpark) {
      var NS = "http://www.w3.org/2000/svg";
      var svg = document.createElementNS(NS, "svg");
      svg.setAttribute("class", "ap-spark");
      svg.setAttribute("viewBox", "0 0 72 30");
      path = document.createElementNS(NS, "path");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke-width", "2");
      path.setAttribute("stroke-linejoin", "round");
      path.setAttribute("stroke-linecap", "round");
      svg.appendChild(path);
      b.appendChild(svg);
    }
    var right = el("div", "ap-right");
    var px = el("p", "ap-px", "");
    var chip = el("span", "ap-chip", "");
    right.appendChild(px);
    right.appendChild(chip);
    b.appendChild(right);
    return { b: b, px: px, chip: chip, path: path };
  }
  function setChip(chip, value, text) {
    chip.textContent = text;
    chip.className = "ap-chip " + (value >= 0 ? "up" : "down");
  }
  function sectorName(id) { return SECTOR_OF[id] || "Other"; }
  function buildList() {
    var box = $("stkList");
    box.innerHTML = "";
    rowRefs = {};
    try {
      var sorted = list.slice().sort(function (a, b) {
        var sa = sectorName(a.id), sb = sectorName(b.id);
        return sa === sb ? 0 : (sa < sb ? -1 : 1);
      });
      var lastSector = "";
      sorted.forEach(function (s) {
        var sec = sectorName(s.id);
        if (sec !== lastSector) {
          lastSector = sec;
          box.appendChild(el("p", "sec-title sector-h", sec));
        }
        var r = makeRow(s.name, s.id, true);
        r.b.addEventListener("click", function () { openStock(s.id); });
        box.appendChild(r.b);
        rowRefs[s.id] = r;
        chg1h[s.id] = change1h(s);
      });
      updateList(true);
    } catch (e) {
      console.error(e);
      box.textContent = "Stocks could not load: " + (e && e.message ? e.message : e);
    }
  }
  function updateList(withSparks) {
    list.forEach(function (s) {
      var r = rowRefs[s.id];
      if (!r) return;
      var ch = chg1h[s.id] || 0;
      r.px.textContent = money(s.price);
      setChip(r.chip, ch, pctText(ch));
      if (withSparks && r.path) {
        var sp = sparkD(s);
        r.path.setAttribute("d", sp.d);
        r.path.setAttribute("stroke", sp.up ? "#34C759" : "#FF453A");
      }
    });
  }

  // One asset as a card: name, value, shares, and your gain or loss. Tap it to open its stock page.
  function assetCard(s, h, hidden) {
    var value = h.shares * s.price;
    var gain = value - (h.cost || 0);
    var pct = h.cost > 0 ? (gain / h.cost) * 100 : 0;
    var card = el("button", "as-card" + (gain < 0 ? " down" : ""));
    card.type = "button";
    var top = el("div", "as-top");
    top.appendChild(el("span", "as-name", s.name));
    top.appendChild(el("span", "as-value", hidden ? "••••" : money(value)));
    var bot = el("div", "as-bot");
    bot.appendChild(el("span", "as-shares", h.shares.toFixed(2) + " shares"));
    bot.appendChild(el("span", "as-gain", hidden ? "••••" :
      (gain >= 0 ? "+" : "") + money(gain) + " (" + (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%)"));
    card.appendChild(top);
    card.appendChild(bot);
    card.addEventListener("click", function () { openStock(s.id); });
    return card;
  }

  // Home shows your two biggest-first holdings as a stack. "See all" opens every holding.
  function buildHomeAssets() {
    var box = $("homeAssets");
    if (!box) return;
    var hidden = SB.isMoneyHidden();
    var rows = list.filter(function (s) { return holdings[s.id] && holdings[s.id].shares > 0.01; });
    var total = 0;
    rows.forEach(function (s) { total += holdings[s.id].shares * s.price; });
    $("assetsEmpty").classList.toggle("hidden", rows.length > 0);
    $("assetsTotal").textContent = rows.length ? (hidden ? "••••••" : money(total)) : "";
    $("assetsSeeAll").textContent = rows.length > 2 ? "See all (" + rows.length + ")" : "See all";
    $("assetsSeeAll").classList.toggle("hidden", rows.length === 0);
    box.innerHTML = "";
    rows.slice(0, 2).forEach(function (s, i) {
      var card = assetCard(s, holdings[s.id], hidden);
      card.style.zIndex = String(i + 1);
      box.appendChild(card);
    });
    $("assetsSheetTotal").textContent = hidden ? "••••••" :
      money(total) + " in " + rows.length + (rows.length === 1 ? " company" : " companies");
    var all = $("assetsAll");
    all.innerHTML = "";
    rows.forEach(function (s) { all.appendChild(assetCard(s, holdings[s.id], hidden)); });
  }
  $("assetsSeeAll").addEventListener("click", function () { SB.showView("vAssets"); });
  SB.on("tick", buildHomeAssets);
  SB.on("eye", buildHomeAssets);

  function buildHoldings() {
    buildHomeAssets();
    var box = $("stkHoldings");
    box.innerHTML = "";
    holdRefs = {};
    var rows = list.filter(function (s) { return holdings[s.id] && holdings[s.id].shares > 0.01; });
    box.classList.toggle("hidden", rows.length === 0);
    if (!rows.length) return;
    box.appendChild(el("p", "sec-title", "Your stocks"));
    rows.forEach(function (s) {
      var r = makeRow(s.name, holdings[s.id].shares.toFixed(2) + " shares", false);
      r.b.addEventListener("click", function () { openStock(s.id); });
      box.appendChild(r.b);
      holdRefs[s.id] = r;
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
      setChip(r.chip, profit, (profit >= 0 ? "+" : "-") + money(Math.abs(profit)));
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
      var col = c.c >= c.o ? "#34C759" : "#FF453A";
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
    var wasOff = dot.getAttribute("visibility") !== "visible";
    cross.setAttribute("x1", best.x); cross.setAttribute("x2", best.x); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", best.x); dot.setAttribute("cy", best.y); dot.setAttribute("visibility", "visible");
    if (wasOff && dot.animate) {
      dot.animate([{ transform: "scale(0.3)" }, { transform: "scale(1)" }],
        { duration: 260, easing: "cubic-bezier(0.32, 0.72, 0, 1)" });
    }
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

  // ---------- Headlines: market news and business news, by category, with a trend picture and an article page ----------
  var hlFilter = "all";
  var hlChipsBuilt = false;
  function storyText(n) {
    if (n.b) return n.b;
    return "The share price moved " + ((n.m >= 0 ? "+" : "") + (n.m * 100).toFixed(1)) + "% on this news.";
  }
  // A small picture that suggests the direction. up = true rises, false falls, null stays flat (business news).
  function trendChart(up, seedNum, big) {
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 100 40");
    var kind = up === null ? "neutral" : (up ? "up" : "down");
    svg.setAttribute("class", "trend " + (big ? "big " : "") + kind);
    var pts = [];
    for (var i = 0; i < 11; i++) {
      var wig = Math.sin(seedNum / 977 + i * 1.9) * 2.6;
      var drift = up === null ? 0 : (up ? -1 : 1) * i * 1.5;
      var y = 20 + drift + wig * (up === null ? 0.5 : 1);
      pts.push([i * 10, Math.max(3, Math.min(37, y))]);
    }
    var path = document.createElementNS(NS, "path");
    path.setAttribute("d", pts.map(function (p, k) { return (k ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(" "));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke-width", "2.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    var last = pts[pts.length - 1];
    var dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", last[0]);
    dot.setAttribute("cy", last[1]);
    dot.setAttribute("r", "3");
    svg.appendChild(dot);
    return svg;
  }
  // Headlines come out in batches. Each batch is 3 to 5 different companies, and their stories
  // arrive one by one across a 15 to 40 minute window. The next batch starts when that window ends,
  // so newer stories always sit at the top. Everything counts from a fixed date, so every device agrees.
  var BIZ_EPOCH = Date.UTC(2026, 0, 1);
  var bizBatches = [];
  var bizStarted = false;
  var bizDone = 0;
  var bizReleased = [];
  var bizLastPrice = {};
  function seeded(n) {
    var a = (n ^ 0x9E3779B9) >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function pickSeeded(arr, r) { return arr[Math.floor(r() * arr.length)]; }
  // Batch j: a window of 15 to 40 minutes, 3 to 5 release times inside it
  function bizBatchAt(j) {
    while (bizBatches.length <= j) {
      var k = bizBatches.length;
      var r = seeded(k * 31 + 5);
      var W = (15 + Math.floor(r() * 26)) * 60 * 1000;
      var n = 3 + Math.floor(r() * 3);
      var start = k ? bizBatches[k - 1].end : BIZ_EPOCH;
      var times = [];
      for (var i = 0; i < n; i++) {
        times.push(start + Math.round(W * (i + 0.5 + (r() - 0.5) * 0.6) / n));
      }
      times.sort(function (a, b) { return a - b; });
      bizBatches.push({ start: start, end: start + W, n: n, seed: k, times: times });
    }
    return bizBatches[j];
  }
  // Company activity: investments, projects, hires, partners
  function bizStory(k, co, at) {
    var r = seeded(k + 1);
    var vals = {
      n: co.name, s: sectorName(co.id).toLowerCase(),
      city: pickSeeded(WORLD.cities, r), product: pickSeeded(WORLD.products, r),
      partner: pickSeeded(WORLD.partners, r), amt: 5 + Math.floor(r() * 295), k: 2 + Math.floor(r() * 8)
    };
    var title = co.name + " " + fillIn(pickSeeded(WORLD.bizVerbs, r), vals);
    // Two different paragraphs: the second pick always skips the first
    var bodies = WORLD.bizBody;
    var a = Math.floor(r() * bodies.length);
    var b = (a + 1 + Math.floor(r() * (bodies.length - 1))) % bodies.length;
    var body = fillIn(bodies[a], vals) + "\n\n" + fillIn(bodies[b], vals);
    return { t: title, b: body, m: 0, at: at, biz: true };
  }
  // The next price move for this company that is due by time t and not yet shown
  function nextPriceNews(co, t) {
    var last = bizLastPrice[co.id] || 0, pick = null;
    (co.news || []).forEach(function (n) {
      if (n.at > last && n.at <= t && (!pick || n.at < pick.at)) pick = n;
    });
    if (pick) bizLastPrice[co.id] = pick.at;
    return pick;
  }
  function bizProcessBatch(j, companies) {
    var b = bizBatchAt(j), r = seeded(b.seed * 97 + 13), pool = companies.slice(), out = [];
    for (var i = 0; i < b.n && pool.length; i++) {
      var co = pool.splice(Math.floor(r() * pool.length), 1)[0];
      var t = b.times[i];
      var price = nextPriceNews(co, t);
      var n = price ? { t: price.t, b: price.b, m: price.m, at: t } : bizStory(b.seed * 8 + i, co, t);
      out.push({ n: n, s: co });
    }
    return out;
  }
  function bizFeed() {
    var now = Date.now();
    var companies = list.slice().sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    if (!companies.length) return [];
    if (!bizStarted) {
      // Start two days back, so the first load stays quick
      bizStarted = true;
      var j = 0;
      while (bizBatchAt(j + 1).start < now - 2 * 864e5) j++;
      bizDone = j;
    }
    while (bizBatchAt(bizDone).start <= now) {
      bizReleased = bizReleased.concat(bizProcessBatch(bizDone, companies));
      bizDone++;
    }
    bizReleased = bizReleased.slice(-120);
    return bizReleased.filter(function (x) { return x.n.at <= now; }).slice(-40).reverse();
  }
  function openStory(x) {
    var n = x.n, up = n.m >= 0, biz = !!n.biz;
    $("storyCo").textContent = x.s.name + " · " + x.s.id + " · " + sectorName(x.s.id);
    $("storyWhen").textContent = ago(Date.now() - n.at);
    $("storyTitle").textContent = n.t;
    var mv = $("storyMove");
    if (biz) {
      mv.textContent = "Company news";
      mv.className = "story-move-big neutral";
    } else {
      mv.textContent = (up ? "+" : "") + (n.m * 100).toFixed(1) + "% that day";
      mv.className = "story-move-big " + (up ? "up" : "down");
    }
    var art = $("storyArt");
    if (art) { art.innerHTML = ""; art.appendChild(artSvg(n.at, sectorName(x.s.id), true)); }
    var ch = $("storyChart");
    ch.innerHTML = "";
    ch.appendChild(trendChart(biz ? null : up, n.at / 1000, true));
    var body = $("storyBody");
    body.innerHTML = "";
    storyText(n).split(/\n\n+/).forEach(function (para) {
      body.appendChild(el("p", "story-p", para));
    });
    $("storyChartBtn").onclick = function () { openStock(x.s.id); };
    SB.showView("vStory");
  }
  function buildHlChips() {
    var box = $("hlFilters");
    if (!box || hlChipsBuilt || !list.length) return;
    hlChipsBuilt = true;
    var names = ["All"];
    list.forEach(function (s) {
      var n = sectorName(s.id);
      if (names.indexOf(n) === -1) names.push(n);
    });
    names.forEach(function (n) {
      var b = el("button", "hl-chip" + (n === "All" ? " active" : ""), n);
      b.type = "button";
      b.addEventListener("click", function () {
        hlFilter = n === "All" ? "all" : n;
        box.querySelectorAll(".hl-chip").forEach(function (o) { o.classList.toggle("active", o === b); });
        renderHeadlines();
      });
      box.appendChild(b);
    });
  }

  var HL_SEEN_KEY = "sb_hl_seen";
  function hlSeenAt() { try { return Number(localStorage.getItem(HL_SEEN_KEY)) || 0; } catch (e) { return 0; } }
  function setHlSeen(t) { try { localStorage.setItem(HL_SEEN_KEY, String(t)); } catch (e) { /* private window: fine */ } }
  // Made-up publishers, so the feed never copies a real outlet
  var PUBS = ["Harbor Daily", "Meridian Wire", "The Market Ledger", "Civic Business Post", "Northline News", "Crown Street Times", "Ridgeway Desk", "Blue Mesa Report"];
  function pubFor(at) { return PUBS[Math.floor(seeded(Math.floor(at / 60000))() * PUBS.length)]; }
  // Colours for the drawn pictures: background, shape, line
  var ART_PAL = {
    Technology: ["#0A2F66", "#5483B3", "#C1E8FF"],
    Energy: ["#0B3D2E", "#34C759", "#D8F5C2"],
    Food: ["#3A2A12", "#E0A23B", "#FFE7B3"],
    Health: ["#0E2F3A", "#3FB6C9", "#D7F4FA"],
    Finance: ["#14213D", "#7DA0CA", "#E5ECF6"],
    Travel: ["#2C1C47", "#8E7CC3", "#E9E2FA"],
    Retail: ["#3B1B2B", "#E86A8C", "#FBD9E3"],
    Industry: ["#262A33", "#8A8F98", "#E6E8EC"],
    Property: ["#1F3A2E", "#6BBF8C", "#DDF3E4"],
    Other: ["#1E1F23", "#5483B3", "#C1E8FF"]
  };
  // A drawn picture for a story: shapes and a rising line in the category's colours
  function artSvg(at, sector, big) {
    var NS = "http://www.w3.org/2000/svg";
    var pal = ART_PAL[sector] || ART_PAL.Other;
    var r = seeded(Math.floor(at / 1000) % 100000 + 1);
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 160 120");
    svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
    svg.setAttribute("class", "hl-pic" + (big ? " big" : ""));
    function add(tag, attrs) {
      var e = document.createElementNS(NS, tag);
      Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
      svg.appendChild(e);
    }
    add("rect", { x: 0, y: 0, width: 160, height: 120, fill: pal[0] });
    add("circle", { cx: (40 + r() * 80).toFixed(1), cy: (20 + r() * 50).toFixed(1), r: (36 + r() * 30).toFixed(1), fill: pal[1], opacity: 0.55 });
    add("circle", { cx: (100 + r() * 40).toFixed(1), cy: (70 + r() * 40).toFixed(1), r: (20 + r() * 20).toFixed(1), fill: pal[2], opacity: 0.3 });
    var pts = [], y = 84 + r() * 16;
    for (var i = 0; i < 8; i++) {
      y += (r() - 0.42) * 9;
      pts.push((i * 160 / 7).toFixed(1) + "," + Math.max(18, Math.min(108, y)).toFixed(1));
    }
    add("polyline", { points: pts.join(" "), fill: "none", stroke: pal[2], "stroke-width": 3, "stroke-linecap": "round", "stroke-linejoin": "round" });
    return svg;
  }
  function moveChip(x) {
    var biz = !!x.n.biz, up = x.n.m >= 0;
    var kind = biz ? "neutral" : (up ? "up" : "down");
    return el("span", "hl-move " + kind, biz ? "News" : (up ? "+" : "") + (x.n.m * 100).toFixed(1) + "%");
  }
  function storyCard(x) {
    var card = el("button", "hl-card");
    card.type = "button";
    var text = el("div", "hl-text");
    text.appendChild(el("span", "hl-cat", sectorName(x.s.id)));
    text.appendChild(el("p", "hl-h2", x.n.t));
    var meta = el("div", "hl-meta");
    meta.appendChild(el("span", "", pubFor(x.n.at) + " · " + ago(Date.now() - x.n.at)));
    meta.appendChild(moveChip(x));
    text.appendChild(meta);
    card.appendChild(text);
    var thumb = el("div", "hl-thumb");
    thumb.appendChild(artSvg(x.n.at, sectorName(x.s.id), false));
    card.appendChild(thumb);
    card.addEventListener("click", function () { openStory(x); });
    return card;
  }
  function leadCard(x) {
    var card = el("button", "hl-hero");
    card.type = "button";
    var art = el("div", "hl-art");
    art.appendChild(artSvg(x.n.at, sectorName(x.s.id), true));
    card.appendChild(art);
    var body = el("div", "hl-body");
    body.appendChild(el("p", "hl-pub", pubFor(x.n.at) + " · " + sectorName(x.s.id)));
    body.appendChild(el("p", "hl-h1", x.n.t));
    body.appendChild(el("p", "hl-sum", storyText(x.n)));
    var meta = el("div", "hl-meta");
    meta.appendChild(el("span", "", ago(Date.now() - x.n.at)));
    meta.appendChild(moveChip(x));
    body.appendChild(meta);
    card.appendChild(body);
    card.addEventListener("click", function () { openStory(x); });
    return card;
  }
  function renderHeadlines() {
    var box = $("headlinesList");
    if (!box) return;
    buildHlChips();
    var all = [];
    bizFeed().forEach(function (x) { all.push(x); });
    all.sort(function (a, b) { return b.n.at - a.n.at; });
    // The banner counts stories that arrived since the reader last tapped it
    var seen = hlSeenAt();
    if (!seen) { seen = Date.now(); setHlSeen(seen); }
    var fresh = all.filter(function (x) { return x.n.at > seen; }).length;
    var ban = $("hlBanner");
    if (ban) {
      ban.classList.toggle("hidden", fresh === 0);
      ban.textContent = "+" + (fresh > 9 ? "9+" : String(fresh)) + (fresh === 1 ? " new story" : " new stories") + " · tap to read";
    }
    var items = all.filter(function (x) {
      return hlFilter === "all" || sectorName(x.s.id) === hlFilter;
    }).slice(0, 80);
    var key = hlFilter + "|" + items.map(function (x) { return x.s.id + x.n.at; }).join("|");
    $("headlinesEmpty").classList.toggle("hidden", items.length > 0);
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.innerHTML = "";
    items.forEach(function (x, i) {
      box.appendChild(i === 0 && hlFilter === "all" ? leadCard(x) : storyCard(x));
    });
  }
  var hlBannerEl = $("hlBanner");
  if (hlBannerEl) hlBannerEl.addEventListener("click", function () {
    setHlSeen(Date.now());
    renderHeadlines();
    var top = $("tab-headlines");
    if (top && top.scrollIntoView) top.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  SB.on("tab", function (name) { if (name === "headlines") renderHeadlines(); });
  SB.on("tick", function () {
    var t = $("tab-headlines");
    if (t && t.classList.contains("active")) renderHeadlines();
  });

  // The latest headlines for this company (newest first)
  function renderNews(s) {
    var box = $("stkNews");
    if (!box) return;
    var items = (s.news || []).slice().reverse().slice(0, 4);
    var key = items.map(function (n) { return n.at + n.t; }).join("|");
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.innerHTML = "";
    if (!items.length) {
      box.appendChild(el("p", "muted small", "No news for this company yet."));
      return;
    }
    items.forEach(function (n) {
      var row = el("div", "news-row");
      row.appendChild(el("span", "news-dot " + (n.m >= 0 ? "up" : "down")));
      var txt = el("div", "");
      txt.appendChild(el("p", "news-text", n.t));
      txt.appendChild(el("p", "news-when", ago(Date.now() - n.at)));
      row.appendChild(txt);
      box.appendChild(row);
    });
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
    renderNews(s);
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
      amt.style.color = profit >= 0 ? "#34C759" : "#FF453A";
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
    updateList(tickCount % 8 === 0);
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
      placeRangePill(true);
    });
  });

  // ---------- Chart gestures: drag to scroll back, pinch or wheel to zoom, touch to read ----------
  var card = $("stkChartCard");
  card.style.position = "relative";
  var latest = el("button", "sp-latest", "Latest ›");
  latest.type = "button";
  latest.id = "stkLatest";
  latest.style.cssText = "position:absolute;right:10px;top:8px;z-index:2;border:0;border-radius:999px;" +
    "padding:5px 11px;font-size:12px;font-weight:700;color:#fff;background:#5483B3;display:none;";
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

  var lastTap = null;
  var zoomFrame = null;
  function stopZoom() {
    if (zoomFrame) { cancelAnimationFrame(zoomFrame); zoomFrame = null; }
  }
  // Where your finger is across the plot, from 0 (left edge) to 1 (right edge)
  function plotFraction(clientX) {
    var svg = $("stkChart").querySelector("svg");
    if (!svg || !geo) return 0.5;
    var rect = svg.getBoundingClientRect();
    var x = ((clientX - rect.left) / rect.width) * geo.W;
    return clamp((x - PLOT.l) / (PLOT.W - PLOT.l - PLOT.r), 0, 1);
  }
  // Zooms in around the finger. Keeps the time under the finger in the same place.
  // Double-tapping again when already zoomed in goes back to the normal range.
  function zoomAtFinger(clientX) {
    if (!findStock(openSym)) return;
    var f = plotFraction(clientX);
    var from = view.windowMs;
    var to = from > MIN_WINDOW * 1.5 ? Math.max(MIN_WINDOW, from / 2.5) : RANGES[range].window;
    to = clamp(to, MIN_WINDOW, MAX_WINDOW);
    var anchorT = (Date.now() - view.offset) - from * (1 - f);
    var t0 = performance.now(), dur = 340;
    stopZoom();
    function step(now) {
      var p = clamp((now - t0) / dur, 0, 1);
      var e = 1 - Math.pow(1 - p, 3);
      var w = Math.exp(Math.log(from) + (Math.log(to) - Math.log(from)) * e);
      var right = anchorT + w * (1 - f);
      view.windowMs = w;
      view.offset = Math.max(0, Date.now() - right);
      renderStockPage(true, false);
      zoomFrame = p < 1 ? requestAnimationFrame(step) : null;
    }
    zoomFrame = requestAnimationFrame(step);
  }

  card.addEventListener("pointerdown", function (e) {
    stopZoom();
    card.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      var nowT = Date.now();
      if (lastTap && nowT - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        lastTap = null;
        pointers.delete(e.pointerId);
        gesture = null;
        touching = false;
        hideCross();
        zoomAtFinger(e.clientX);
        return;
      }
      lastTap = { t: nowT, x: e.clientX, y: e.clientY };
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

  card.addEventListener("touchmove", function (e) { e.preventDefault(); }, { passive: false });
  ["gesturestart", "gesturechange", "gestureend"].forEach(function (name) {
    document.addEventListener(name, function (e) { e.preventDefault(); }, { passive: false });
  });

  // ---------- The hour buttons (1H, 4H, All) with a sliding highlight ----------
  var rangePill = el("span", "sp-pill");
  $("stkRange").insertBefore(rangePill, $("stkRange").firstChild);
  var rangeReady = false;
  function placeRangePill(animate) {
    var b = $("stkRange").querySelector("button.active");
    if (SB.placePill(rangePill, b, animate && rangeReady)) rangeReady = true;
  }
  SB.on("view", function (name) { if (name === "vStock") placeRangePill(false); });

  // ---------- Buy and Sell: one trade screen for both ----------
  // Buy: you type dollars. Sell: you type shares. Slide the bar all the way to confirm.
  var trade = { mode: "buy", text: "0", all: false };
  var trTicker = null;
  var trThumb = $("trThumb"), trTrack = $("trSlide"), trFill = $("trFill");
  var trDrag = null, trPos = 0;
  var TR_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"];

  function trR2(n) { return Math.round(n * 100) / 100; }
  function trStock() { return findStock(openSym); }
  function trOwned() { var s = trStock(); var h = s && holdings[s.id]; return h ? h.shares || 0 : 0; }
  function trBalance() { return SB.state.profile ? SB.state.profile.balance || 0 : 0; }
  function trValue() { return parseFloat(trade.text) || 0; }

  // The biggest buy you can afford, fee included
  function trMaxBuy() {
    var b = trBalance();
    var v = trR2(b / 1.015);
    while (v > 0 && trR2(v + SB.feeFor(v)) > b + 0.000001) v = trR2(v - 0.01);
    return Math.max(0, v);
  }

  // What the trade means right now
  function trNumbers() {
    var s = trStock(), v = trValue();
    var out = { ok: false, enough: false, shares: 0, n: 0, money: 0, fee: 0, total: 0 };
    if (!s || v <= 0) return out;
    if (trade.mode === "buy") {
      var fee = SB.feeFor(v);
      out.shares = Wallet.stockBuyShares(s, v);
      out.money = v;
      out.fee = fee;
      out.total = trR2(v + fee);
      out.ok = out.shares > 0;
      out.enough = out.ok && out.total <= trBalance() + 0.000001;
    } else {
      var owned = trOwned();
      var n = trade.all ? owned : Math.min(v, owned);
      var value = n > 0 ? Wallet.stockSellValue(s, n) : 0;
      var f = SB.feeFor(value);
      out.n = n;
      out.shares = n;
      out.money = value;
      out.fee = f;
      out.total = trR2(value - f);
      out.ok = n > 0;
      out.enough = out.ok && v <= owned + 0.000001;
    }
    return out;
  }

  function renderTrade() {
    var s = trStock();
    if (!s) return;
    var buy = trade.mode === "buy";
    var n = trNumbers();
    var tag = $("trTag");
    tag.textContent = buy ? "Buy" : "Sell";
    tag.className = "tr-tag " + (buy ? "buy" : "sell");
    $("trName").textContent = s.name;
    $("trSym").textContent = s.id;
    $("trPrice").textContent = money(s.price) + " a share";
    $("trBig").textContent = buy ? "$" + trade.text : (trade.all ? "All" : trade.text);
    $("trUnit").textContent = buy ? "" : (trade.all ? "of your " + trOwned().toFixed(2) + " shares" : "shares");
    $("trLblShares").textContent = buy ? "You get" : "You sell";
    $("trShares").textContent = n.shares > 0 ? n.shares.toFixed(2) + " sh" : "0.00 sh";
    $("trFee").textContent = money(n.fee);
    $("trLblTotal").textContent = buy ? "Total" : "You get";
    $("trTotal").textContent = money(n.total);
    $("trNote").textContent = buy
      ? (n.ok ? "Buying pushes the price up a little." : "")
      : "You own " + trOwned().toFixed(2) + " shares.";
    trTrack.classList.toggle("sell", !buy);
    trTrack.classList.toggle("off", !n.enough);
    $("trSlideText").textContent = !n.ok ? "Type an amount"
      : !n.enough ? (buy ? "Not enough money" : "Not enough shares")
      : (buy ? "Slide to buy" : "Slide to sell");
  }

  function setTrade(text, all) {
    trade.text = text;
    trade.all = !!all;
    renderTrade();
  }

  function buildTradeChips() {
    var box = $("trChips");
    box.innerHTML = "";
    var items;
    if (trade.mode === "buy") {
      items = [
        ["$25", function () { setTrade("25"); }],
        ["$100", function () { setTrade("100"); }],
        ["$500", function () { setTrade("500"); }],
        ["Max", function () { setTrade(String(trMaxBuy())); }]
      ];
    } else {
      items = [
        ["25%", function () { setTrade(String(Math.floor(trOwned() * 0.25 * 100) / 100)); }],
        ["50%", function () { setTrade(String(Math.floor(trOwned() * 0.5 * 100) / 100)); }],
        ["75%", function () { setTrade(String(Math.floor(trOwned() * 0.75 * 100) / 100)); }],
        ["All", function () { setTrade(trOwned().toFixed(4), true); }]
      ];
    }
    items.forEach(function (it) {
      var b = el("button", "tr-chip", it[0]);
      b.type = "button";
      b.addEventListener("click", it[1]);
      box.appendChild(b);
    });
  }

  function trPress(k) {
    var t = trade.all ? "0" : trade.text;
    if (k === "⌫") {
      t = t.length > 1 ? t.slice(0, -1) : "0";
    } else if (k === ".") {
      if (t.indexOf(".") === -1) t += ".";
    } else if (t.indexOf(".") !== -1) {
      if (t.split(".")[1].length < 2) t += k;
    } else if (t.length < 7) {
      t = t === "0" ? k : t + k;
    }
    trade.all = false;
    trade.text = t;
    renderTrade();
  }

  function buildTradePad() {
    var pad = $("trPad");
    pad.innerHTML = "";
    TR_KEYS.forEach(function (k) {
      var b = el("button", "tr-key" + (k === "⌫" ? " alt" : ""), k);
      b.type = "button";
      b.addEventListener("click", function () { trPress(k); });
      pad.appendChild(b);
    });
  }
  buildTradePad();

  // The slide bar
  function trRange() { return Math.max(1, trTrack.clientWidth - trThumb.offsetWidth - 8); }
  function trSetPos(px, animate) {
    trPos = px;
    var t = animate ? "" : "none";
    trThumb.style.transition = t;
    trFill.style.transition = t;
    trThumb.style.transform = "translateX(" + px + "px)";
    trFill.style.width = px > 0 ? (px + trThumb.offsetWidth + 4) + "px" : "0px";
  }
  trThumb.addEventListener("pointerdown", function (e) {
    if (trTrack.classList.contains("off")) return;
    trDrag = e.clientX - trPos;
    trThumb.setPointerCapture(e.pointerId);
    trSetPos(trPos, false);
  });
  trThumb.addEventListener("pointermove", function (e) {
    if (trDrag === null) return;
    trSetPos(Math.max(0, Math.min(trRange(), e.clientX - trDrag)), false);
  });
  function trRelease() {
    if (trDrag === null) return;
    trDrag = null;
    if (trPos >= trRange() * 0.92) {
      trSetPos(trRange(), true);
      setTimeout(confirmTrade, 180);
    } else {
      trSetPos(0, true);
    }
  }
  trThumb.addEventListener("pointerup", trRelease);
  trThumb.addEventListener("pointercancel", trRelease);

  function confirmTrade() {
    var s = trStock(), n = trNumbers();
    if (!s || !n.enough) { trSetPos(0, true); return; }
    var buy = trade.mode === "buy";
    SB.flow(async function () {
      if (buy) {
        if (!(await SB.pinGate("Buying " + money(n.money) + " of " + s.name + " + " + money(n.fee) + " fee"))) { trSetPos(0, true); return; }
        await SB.runBusy(
          "Buying…",
          function () { return Wallet.buyStock(SB.state.uid, s.id, n.money, n.fee, SB.state.feeOwner); },
          "You bought " + s.name + "!",
          null,
          ["Checking the price…", "Buying " + s.name + "…", "Almost there…"]
        );
      } else {
        var owned = trOwned();
        var all = trade.all || n.n >= owned - 0.00001;
        var count = all ? owned : n.n;
        if (!(await SB.pinGate("Selling " + (all ? "all " : "") + count.toFixed(2) + " shares of " + s.name))) { trSetPos(0, true); return; }
        await SB.runBusy(
          "Selling…",
          function () { return Wallet.sellShares(SB.state.uid, s.id, all ? Infinity : n.n, SB.feeFor, SB.state.feeOwner); },
          "You sold " + (all ? "all your " : "") + count.toFixed(2) + " shares of " + s.name + ".",
          null,
          ["Checking the price…", "Selling " + s.name + "…", "Almost there…"]
        );
      }
    });
  }

  function startTradeTicker() {
    stopTradeTicker();
    trTicker = setInterval(renderTrade, 400);
  }
  function stopTradeTicker() {
    if (trTicker) { clearInterval(trTicker); trTicker = null; }
  }
  SB.on("view", function (name) { if (name === "vTrade") startTradeTicker(); else stopTradeTicker(); });
  SB.on("sheetClosed", stopTradeTicker);

  function openTrade(mode) {
    var s = trStock();
    if (!s) return;
    if (mode === "sell" && !(trOwned() > 0.01)) { SB.toast("You don't own any " + s.name + " yet."); return; }
    trade.mode = mode;
    trade.text = "0";
    trade.all = false;
    trSetPos(0, false);
    buildTradeChips();
    renderTrade();
    SB.showView("vTrade");
  }
  $("stkBuy").addEventListener("click", function () { openTrade("buy"); });
  $("stkSell").addEventListener("click", function () { openTrade("sell"); });
  $("trBack").addEventListener("click", function () { SB.showView("vStock"); });

  try {
    injectListStyles();
  } catch (e) {
    console.error(e);
    $("stkList").textContent = "Stocks setup error: " + (e && e.message ? e.message : e);
  }

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

})();
