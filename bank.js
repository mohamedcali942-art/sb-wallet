// SB Bank, stage one: one card with four levels, weekly fees, savings, loans and the credit score.
// The bank lives on your account record, so it follows you across devices and stays in step with your balance.
(function () {
  var DAY = 864e5, HOUR = 36e5, WEEK = 7 * DAY;
  var MP = window.MarketPrice; // the share price formula (prices.js), so shares are valued the way the market prices them
  var GIFT = 100, SCORE_START = 100, SCORE_DAY_CAP = 60, SAVE_MIN = 50;
  var SHARES_FEE = 0.03, SHARES_PENALTY = 0.5; // loans backed by shares: 3% fee up front, 50% penalty if late
  var SHARES_LTV = 0.91; // usage limit: a shares loan can be up to 91% of what the shares are worth
  var LEVELS = {
    regular: { name: "Regular", weekly: 0,     min: 0,   cut: 0,     save: 0 },
    silver:  { name: "Silver",  weekly: 5000,  min: 500, cut: 0.005, save: 0.25 },
    gold:    { name: "Gold",    weekly: 10000, min: 650, cut: 0.01,  save: 0.5 },
    premium: { name: "Premium", weekly: 15000, min: 750, cut: 0.015, save: 0.75 }
  };
  var ORDER = ["regular", "silver", "gold", "premium"];
  var TERMS = {
    short:    { label: "3 days",  days: 3,  hourly: 0.004 },
    standard: { label: "7 days",  days: 7,  hourly: 0.0025 },
    long:     { label: "14 days", days: 14, hourly: 0.0015 }
  };

  // ---------- Small helpers ----------
  function $(id) { return document.getElementById(id); }
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function svgEl(tag, attrs, parent) {
    var e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(e);
    return e;
  }
  function addStops(grad, colors) {
    colors.forEach(function (c, i) { svgEl("stop", { offset: String(i / (colors.length - 1)), "stop-color": c }, grad); });
  }
  function money(n) { return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function pct(n) { return n.toFixed(1) + "%"; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function round4(n) { return Math.round(n * 10000) / 10000; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
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
  function dayKeyOf(t) { var d = new Date(t); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function fmtDate(t) { return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
  function dur(ms) {
    if (ms <= 0) return "now";
    var d = Math.floor(ms / DAY), hh = Math.floor((ms % DAY) / HOUR), mm = Math.floor((ms % HOUR) / 60000);
    return d > 0 ? d + "d " + hh + "h" : hh + "h " + pad(mm) + "m";
  }
  function leftText(ms) {
    if (ms <= 0) return "Overdue";
    var hh = Math.floor(ms / HOUR), mm = Math.floor((ms % HOUR) / 60000), ss = Math.floor((ms % 60000) / 1000);
    return hh + "h " + pad(mm) + "m " + pad(ss) + "s";
  }
  function cardDigits() { var el = $("accUser"); return (el ? el.textContent : "").replace(/\D/g, ""); }
  function holderName() {
    var el = $("accName");
    var t = el ? el.textContent.trim() : "";
    return t && t !== "—" ? t : "CARD HOLDER";
  }

  // ---------- The record ----------
  function blank() {
    return { issued: false, name: "", issuedAt: 0, level: null, weekFeeAt: 0, everHeld: {},
             score: SCORE_START, ageCredited: 0, scoreDay: "", scoreToday: 0, savingsDay: "",
             flagUntil: 0, lastBorrowAt: 0, loan: null, savings: [], nextId: 1, history: [] };
  }
  function logTo(nb, type, text, amount, now) {
    nb.history.unshift({ type: type, text: text, amount: amount || 0, at: now });
    nb.history = nb.history.slice(0, 40);
  }

  // ---------- Credit score ----------
  function clampScore(v) { return Math.max(100, Math.min(850, Math.round(v))); }
  // Points that come from good behaviour are capped per day, so the top takes at least 1 to 2 weeks
  function addScore(nb, pts, now) {
    var today = dayKeyOf(now);
    if (nb.scoreDay !== today) { nb.scoreDay = today; nb.scoreToday = 0; }
    var add = Math.min(pts, SCORE_DAY_CAP - nb.scoreToday);
    if (add <= 0) return;
    nb.score = clampScore(nb.score + add);
    nb.scoreToday += add;
  }
  function takeScore(nb, pts) { nb.score = clampScore(nb.score - pts); }
  function bandLimit(s) { return s < 300 ? 100 : s < 500 ? 300 : s < 650 ? 800 : s < 750 ? 1500 : 3000; }
  function bandFee(s) { return s < 300 ? 0.05 : s < 500 ? 0.04 : s < 650 ? 0.03 : s < 750 ? 0.02 : 0.01; }
  function bandRate(s) { return s < 300 ? 0.1 : s < 500 ? 1 : s < 650 ? 2 : s < 750 ? 3.5 : 5; }
  function bandName(s) { return s < 300 ? "Building" : s < 500 ? "Fair" : s < 650 ? "Good" : s < 750 ? "Very good" : "Excellent"; }
  function penaltyPct(s) { return s < 300 ? 1 : s < 650 ? 0.75 : 0.5; }
  function flagged(nb, now) { return (nb.flagUntil || 0) > now; }
  function loanFeePct(nb, now) {
    var lvl = nb.level ? LEVELS[nb.level] : null;
    var f = bandFee(nb.score) - (lvl ? lvl.cut : 0) + (flagged(nb, now) ? 0.02 : 0);
    return Math.max(0.0025, f);
  }

  // ---------- Savings ----------
  function accRate(nb, acc, now) {
    if (flagged(nb, now)) return 0.1;
    var wobble = (seeded(Math.floor(now / (6 * HOUR)) + 1)() - 0.5) * 0.8;
    var days = (now - acc.startedAt) / DAY;
    var lvl = nb.level ? LEVELS[nb.level] : null;
    return Math.max(0.1, Math.min(6.5, bandRate(nb.score) + wobble + Math.min(1, days * 0.1) + (lvl ? lvl.save : 0)));
  }
  function balAt(nb, acc, now) {
    var hrs = (now - acc.at) / HOUR;
    return hrs > 0 ? acc.bal * Math.pow(1 + accRate(nb, acc, now) / 100 / 8760, hrs) : acc.bal;
  }
  function settleAll(nb, now) {
    nb.savings.forEach(function (a) { a.bal = round2(balAt(nb, a, now)); a.at = now; });
  }
  function savingsTotal(nb) { return nb.savings.reduce(function (s, a) { return s + a.bal; }, 0); }

  // ---------- Loans ----------
  function owedAt(L, t) {
    var hrs = (t - L.startedAt) / HOUR;
    return L.amount * (1 + L.feePct) + L.amount * L.hourly * hrs;
  }

  // ---------- Money moves: the card balance first, then savings. Returns false if it can't cover it. ----------
  function collect(c, nb, amount, now) {
    var fromCard = Math.min(c.balance, amount);
    c.balance = round2(c.balance - fromCard);
    var rest = round2(amount - fromCard);
    if (rest <= 0) return true;
    settleAll(nb, now);
    if (savingsTotal(nb) < rest) return false;
    nb.savings.forEach(function (a) {
      if (rest <= 0) return;
      var t = Math.min(a.bal, rest);
      a.bal = round2(a.bal - t);
      rest = round2(rest - t);
    });
    return true;
  }
  // Takes as much of `amount` as the card and savings can cover. Returns how much was taken.
  function collectUpTo(c, nb, amount, now) {
    var fromCard = Math.min(c.balance, amount);
    c.balance = round2(c.balance - fromCard);
    var rest = round2(amount - fromCard);
    if (rest <= 0) return amount;
    settleAll(nb, now);
    var got = 0;
    nb.savings.forEach(function (a) {
      if (rest <= 0) return;
      var t = Math.min(a.bal, rest);
      a.bal = round2(a.bal - t);
      rest = round2(rest - t);
      got = round2(got + t);
    });
    return round2(fromCard + got);
  }
  // The card closes: everything in the card and savings is taken, the score drops, and rates suffer for 30 days
  function closeCard(c, nb, now, why) {
    var taken = round2(c.balance + savingsTotal(nb));
    c.balance = 0;
    nb.savings.forEach(function (a) { a.bal = 0; a.at = now; });
    nb.level = null;
    nb.weekFeeAt = 0;
    nb.flagUntil = now + 30 * DAY;
    takeScore(nb, 100);
    logTo(nb, "closed", "Card closed: " + why + ". Everything was taken from your card and savings.", taken, now);
  }

  // Sells just enough pledged shares to cover what is still owed on a loan, at the live price.
  // The shares leave the holder's record and the market, and the cash goes to the debt.
  function seizeForDebt(c, nb, env, now) {
    var L = nb.loan;
    var remaining = L.stillOwed;
    Object.keys(L.collateral || {}).forEach(function (sym) {
      var pledged = L.collateral[sym];
      var s = env.market[sym], h = env.holdings[sym];
      if (remaining <= 0 || !s || !s.moods || !h || !(pledged > 0)) return;
      var want = MP.sellSharesFor(s, remaining, now);
      var n = round4(Math.min(pledged, want === null ? pledged : want));
      if (!(n > 0)) return;
      var value = round2(MP.grossSellValue(s, s.held || 0, n, now) * (1 - MP.SPREAD));
      var had = h.shares;
      h.shares = round4(Math.max(0, h.shares - n));
      h.pledged = round4(Math.max(0, (h.pledged || 0) - n));
      h.cost = had > 0 ? round2((h.cost || 0) * (h.shares / had)) : 0;
      L.collateral[sym] = round4(pledged - n);
      if (L.collateral[sym] <= 0) delete L.collateral[sym];
      s.held = round4(Math.max(0, (s.held || 0) - n));
      s.heldLog = MP.trimLog((s.heldLog || []).concat([{ t: now, held: s.held }]));
      s.lastTrade = now;
      remaining = round2(remaining - value);
      logTo(nb, "default", "Sold " + n + " " + sym + " shares to cover your loan. " + money(value) + " went to the debt.", value, now);
    });
    if (remaining <= 0) {
      if (remaining < 0) c.balance = round2(c.balance - remaining); // any extra goes back to the card
      nb.loan = null;
      logTo(nb, "default", "Loan covered by selling your pledged shares.", 0, now);
    } else if (Object.keys(L.collateral || {}).length === 0) {
      nb.loan = null;
      closeCard(c, nb, now, "shares sold and the loan still not covered");
    } else {
      L.stillOwed = remaining;
    }
  }

  // Runs on its own: takes weekly fees, overdue loans and share sales, and grows the score.
  // env (optional) holds the holdings and market records for shares. Returns null if nothing changed.
  function processAll(cur, now, env) {
    if (!cur.bank || !cur.bank.issued) return null;
    var before = JSON.stringify([cur.bank, cur.balance, env ? env.holdings : null, env ? env.market : null]);
    var nb = clone(cur.bank);
    var c = { balance: cur.balance };

    // Account age: +1 a week, up to +40 in total
    var weeks = Math.min(40, Math.floor((now - nb.issuedAt) / WEEK));
    while (nb.ageCredited < weeks) { addScore(nb, 1, now); nb.ageCredited++; }

    // Savings of $50 or more: +2 a day
    if (savingsTotal(nb) >= SAVE_MIN && nb.savingsDay !== dayKeyOf(now)) {
      addScore(nb, 2, now);
      nb.savingsDay = dayKeyOf(now);
    }

    // Overdue loan: the card pays what it can. A loan backed by shares keeps the rest as "still owed";
    // any other loan closes the card if it isn't covered.
    if (nb.loan && !nb.loan.inDefault && now >= nb.loan.dueAt) {
      var L = nb.loan;
      var due = round2(owedAt(L, L.dueAt) + L.amount * L.penaltyPct);
      takeScore(nb, 60);
      var got = collectUpTo(c, nb, due, now);
      var rest = round2(due - got);
      if (rest <= 0) {
        nb.loan = null;
        logTo(nb, "default", "Loan overdue. " + money(due) + " was taken to cover it.", due, now);
      } else if (L.collateral && Object.keys(L.collateral).length) {
        L.inDefault = true;
        L.stillOwed = rest;
        logTo(nb, "default", "Loan overdue. " + money(got) + " was taken. " + money(rest) + " is still owed, so pledged shares will be sold to cover it.", got, now);
      } else {
        nb.loan = null;
        closeCard(c, nb, now, "loan overdue and not covered");
      }
    }

    // Debt still owed on a shares loan: sell only what is needed, at the live price
    if (nb.loan && nb.loan.inDefault && env) seizeForDebt(c, nb, env, now);

    // Weekly card fees, catching up on any missed weeks
    while (nb.level && nb.level !== "regular" && now >= nb.weekFeeAt) {
      var fee = LEVELS[nb.level].weekly;
      var due2 = nb.weekFeeAt;
      if (collect(c, nb, fee, now)) {
        nb.weekFeeAt += WEEK;
        logTo(nb, "fee", LEVELS[nb.level].name + " weekly fee paid.", fee, due2);
      } else {
        closeCard(c, nb, now, "weekly fee not covered");
      }
    }

    var after = JSON.stringify([nb, c.balance, env ? env.holdings : null, env ? env.market : null]);
    if (after === before) return null;
    return { balance: round2(c.balance), bank: nb };
  }

  // Every action goes through here: bring the record up to date, then apply the change.
  // fn(c, nb, now, env) changes the card (c), the bank record (nb) and the share records in env.
  function mutateWith(fn) {
    return function (cur, env) {
      var now = Date.now();
      var base = processAll(cur, now, env) || cur;
      var c = { balance: base.balance };
      var nb = clone(base.bank || blank());
      fn(c, nb, now, env);
      return { balance: round2(c.balance), bank: nb };
    };
  }

  function issueAction(name) {
    return mutateWith(function (c, nb, now) {
      if (nb.issued) throw new Error("Your card is already issued.");
      nb.issued = true;
      nb.name = name;
      nb.issuedAt = now;
      nb.ageCredited = 0;
      nb.level = "regular";
      nb.everHeld = {};
      nb.score = SCORE_START;
      c.balance = round2(c.balance + GIFT);
      logTo(nb, "card", "SB Card issued. One-time $100 gift added.", GIFT, now);
    });
  }
  function getNormalCardAction() {
    return mutateWith(function (c, nb, now) {
      if (!nb.issued || nb.level) throw new Error("You already have a card.");
      nb.level = "regular";
      logTo(nb, "card", "Normal card issued. No fee.", 0, now);
    });
  }
  function buyLevelAction(key) {
    return mutateWith(function (c, nb, now) {
      if (!nb.issued) throw new Error("Issue your card first.");
      var L = LEVELS[key];
      if (nb.level === key) throw new Error("You already have the " + L.name + " card.");
      if (nb.score < L.min) throw new Error("You need a score of " + L.min + " for the " + L.name + " card.");
      var price = round2(L.weekly * (nb.everHeld[key] ? 0.9 : 1));
      if (c.balance < price) throw new Error("Your card needs " + money(price) + " for the first week.");
      c.balance = round2(c.balance - price);
      nb.level = key;
      nb.weekFeeAt = now + WEEK;
      nb.everHeld[key] = true;
      logTo(nb, "card", L.name + " card bought. First week paid.", price, now);
    });
  }
  function downgradeAction() {
    return mutateWith(function (c, nb, now) {
      if (!nb.level || nb.level === "regular") throw new Error("You already have the normal card.");
      nb.level = "regular";
      nb.weekFeeAt = 0;
      logTo(nb, "card", "Switched to the normal card. No more weekly fee.", 0, now);
    });
  }
  function borrowAction(a, termKey) {
    return mutateWith(function (c, nb, now) {
      if (!nb.issued || !nb.level) throw new Error("Your card is closed. Get a normal card first.");
      if (nb.loan) throw new Error("You already have a loan open.");
      var wait = nb.lastBorrowAt + 12 * HOUR - now;
      if (wait > 0) throw new Error("You can borrow again in " + dur(wait) + ".");
      var lim = bandLimit(nb.score);
      if (!(a > 0 && a <= lim)) throw new Error("Your limit is " + money(lim) + ".");
      var T = TERMS[termKey];
      nb.loan = { amount: a, feePct: loanFeePct(nb, now), hourly: T.hourly, termKey: termKey,
                  startedAt: now, dueAt: now + T.days * DAY, penaltyPct: penaltyPct(nb.score) };
      c.balance = round2(c.balance + a);
      nb.lastBorrowAt = now;
      logTo(nb, "loan", "Borrowed " + money(a) + " for " + T.label + ".", a, now);
    });
  }
  // Borrow above your limit by pledging shares. The shares must be worth 150% of the loan or more.
  function borrowSharesAction(sym, shares, a, termKey) {
    return mutateWith(function (c, nb, now, env) {
      if (!nb.issued || !nb.level) throw new Error("Your card is closed. Get a normal card first.");
      if (nb.loan) throw new Error("You already have a loan open.");
      var wait = nb.lastBorrowAt + 12 * HOUR - now;
      if (wait > 0) throw new Error("You can borrow again in " + dur(wait) + ".");
      var lim = bandLimit(nb.score);
      if (!(a > lim)) throw new Error("Shares back loans above your limit of " + money(lim) + ".");
      var s = env.market[sym], h = env.holdings[sym];
      if (!s || !s.moods || !h) throw new Error("You don't hold any of that stock.");
      if (!(shares > 0) || shares > round4(h.shares - (h.pledged || 0)) + 0.000001) throw new Error("You don't have that many free shares.");
      var value = round2(MP.grossSellValue(s, s.held || 0, shares, now) * (1 - MP.SPREAD));
      if (a > value * SHARES_LTV) throw new Error("Those shares are worth " + money(value) + ". You can borrow up to 91% of that, so the most is " + money(Math.floor(value * SHARES_LTV * 100) / 100) + ".");
      var T = TERMS[termKey];
      var col = {};
      col[sym] = round4(shares);
      nb.loan = { amount: a, feePct: SHARES_FEE, hourly: T.hourly, termKey: termKey,
                  startedAt: now, dueAt: now + T.days * DAY, penaltyPct: SHARES_PENALTY, collateral: col };
      h.pledged = round4((h.pledged || 0) + shares);
      c.balance = round2(c.balance + a);
      nb.lastBorrowAt = now;
      logTo(nb, "loan", "Borrowed " + money(a) + " against " + round4(shares) + " " + sym + " shares for " + T.label + ".", a, now);
    });
  }
  // Unlocks the pledged shares when a loan is paid off
  function releaseCollateral(L, env) {
    Object.keys(L.collateral || {}).forEach(function (sym) {
      var h = env.holdings[sym];
      if (h) h.pledged = round4(Math.max(0, (h.pledged || 0) - L.collateral[sym]));
    });
    L.collateral = {};
  }
  function repayAction() {
    return mutateWith(function (c, nb, now, env) {
      var L = nb.loan;
      if (!L) throw new Error("No loan is open.");
      var owed = round2(L.inDefault ? L.stillOwed : owedAt(L, now));
      if (c.balance < owed) throw new Error("Your card needs " + money(owed) + " to pay this off. Move money in from savings first.");
      c.balance = round2(c.balance - owed);
      var held = now - L.startedAt;
      if (!L.inDefault) {
        if (held >= 7 * DAY) addScore(nb, 40, now);
        else if (held >= 12 * HOUR) addScore(nb, 25, now);
      }
      releaseCollateral(L, env);
      nb.loan = null;
      logTo(nb, "paid", held >= 12 * HOUR || L.inDefault ? "Loan paid back." : "Loan paid back early. No score change.", owed, now);
    });
  }
  function openSavingsAction(name) {
    return mutateWith(function (c, nb, now) {
      if (!nb.issued) throw new Error("Issue your card first.");
      nb.savings.push({ id: nb.nextId++, name: name, bal: 0, at: now, startedAt: now });
      logTo(nb, "save", "Opened savings account " + name, 0, now);
    });
  }
  function moveAction(id, amt, into) {
    return mutateWith(function (c, nb, now) {
      settleAll(nb, now);
      var acc = nb.savings.filter(function (a) { return a.id === id; })[0];
      if (!acc) throw new Error("That savings account is gone.");
      if (into) {
        if (!(amt > 0 && c.balance >= amt)) throw new Error("Not enough on your card.");
        c.balance = round2(c.balance - amt);
        acc.bal = round2(acc.bal + amt);
        logTo(nb, "save", "Moved " + money(amt) + " to " + acc.name, amt, now);
      } else {
        if (!(amt > 0 && acc.bal >= amt)) throw new Error("Not enough in " + acc.name + ".");
        acc.bal = round2(acc.bal - amt);
        c.balance = round2(c.balance + amt);
        logTo(nb, "save", "Moved " + money(amt) + " from " + acc.name + " to your card", amt, now);
      }
    });
  }

  // ---------- The card, drawn in four looks ----------
  var SKIN = {
    regular: { bg: ["#F7F9FC", "#C9D3E2"], logo: ["#1F3A63", "#3B6FB0"], edge: ["#FFFFFF", "#9FB2CC", "#FFFFFF"], chip: ["#F2F5FA", "#9AA8BD"],
               ribA: "#2B5C98", ribB: "#1B3F6E", ribO: 0.9, text: "#1B2A44", tag: "#1B2A44", ring: ["#B9C4D6", "#DDE4EF"], noise: 0, sheen: false, edgeW: [1.6, 1] },
    silver:  { bg: ["#EDF1F6", "#7F8B9C"], logo: ["#FFFFFF", "#9AA6B8"], edge: ["#FFFFFF", "#7F8B9C", "#FFFFFF"], chip: ["#F8FAFC", "#8F9BAD"],
               ribA: "#3C4656", ribB: "#262D3A", ribO: 0.9, text: "#0F1724", tag: "#2A3445", ring: ["#C9D2DF", "#E6ECF4"], noise: 0.22, sheen: false, edgeW: [2, 1.2] },
    gold:    { bg: ["#F7E9BE", "#A87E3A"], logo: ["#FFF4D1", "#8C6A2E"], edge: ["#8C6A2E", "#FFF1C4", "#B8924A"], chip: ["#FFF4D1", "#B8924A"],
               ribA: "#5B4424", ribB: "#3B2B14", ribO: 0.92, text: "#2A1E0A", tag: "#3B2B14", ring: ["#E8D3A2", "#B8924A"], noise: 0.25, sheen: true, edgeW: [2.2, 1.4] },
    premium: { bg: ["#2C2C30", "#050506"], logo: ["#F7E9BE", "#8C6A2E"], edge: ["#8C6A2E", "#F4E2B0", "#C9A45C"], chip: ["#F4E2B0", "#A9823F"],
               ribA: "#15151A", ribB: "#0A0A0C", ribO: 0.95, text: "#E8D3A2", tag: "#CBB27A", ring: ["#C9A45C", "#E8D3A2"], noise: 0.3, sheen: true, edgeW: [2.2, 1.4] }
  };
  var gradN = 0;
  function cardEl(levelKey, name, last4, year, closed) {
    var s = SKIN[levelKey] || SKIN.regular;
    var uid = "bc" + (++gradN);
    var c = h("div", "bcard bcard-" + levelKey + (closed ? " bcard-closed" : ""));
    var svg = svgEl("svg", { viewBox: "0 0 400 252", class: "bcard-art", "aria-hidden": "true" });
    var defs = svgEl("defs", {}, svg);
    var gBg = svgEl("linearGradient", { id: uid + "b", x1: "0", y1: "0", x2: "1", y2: "1" }, defs);
    var gLogo = svgEl("linearGradient", { id: uid + "l", x1: "0", y1: "0", x2: "1", y2: "1" }, defs);
    var gEdge = svgEl("linearGradient", { id: uid + "e", x1: "0", y1: "0", x2: "1", y2: "0" }, defs);
    var gChip = svgEl("linearGradient", { id: uid + "c", x1: "0", y1: "0", x2: "1", y2: "1" }, defs);
    addStops(gBg, s.bg); addStops(gLogo, s.logo); addStops(gEdge, s.edge); addStops(gChip, s.chip);
    var filt = svgEl("filter", { id: uid + "n", x: "0", y: "0", width: "100%", height: "100%" }, defs);
    svgEl("feTurbulence", { type: "fractalNoise", baseFrequency: "0.9", numOctaves: "2", stitchTiles: "stitch", result: "t" }, filt);
    svgEl("feColorMatrix", { type: "saturate", values: "0", in: "t" }, filt);
    svgEl("rect", { x: 0, y: 0, width: 400, height: 252, fill: "url(#" + uid + "b)" }, svg);
    if (s.noise) svgEl("rect", { x: 0, y: 0, width: 400, height: 252, filter: "url(#" + uid + "n)", opacity: s.noise, "mix-blend-mode": "overlay" }, svg);
    var ribA = "M150 252 C190 176 232 128 300 100 L420 58 L420 178 C356 196 312 236 270 252 Z";
    var ribB = "M236 252 C262 212 296 186 360 168 L420 154 L420 232 L392 252 Z";
    svgEl("path", { d: ribA, fill: s.ribA, opacity: s.ribO }, svg);
    svgEl("path", { d: ribB, fill: s.ribB, opacity: 0.95 }, svg);
    svgEl("path", { d: "M150 252 C190 176 232 128 300 100 L420 58", fill: "none", stroke: "url(#" + uid + "e)", "stroke-width": s.edgeW[0], "stroke-linecap": "round" }, svg);
    svgEl("path", { d: "M236 252 C262 212 296 186 360 168 L420 154", fill: "none", stroke: "url(#" + uid + "e)", "stroke-width": s.edgeW[1], opacity: 0.8, "stroke-linecap": "round" }, svg);
    var logo = svgEl("text", { x: 24, y: 64, "font-size": 52, "font-weight": 900, "font-style": "italic", "font-family": "Arial Black, Arial, sans-serif", fill: "url(#" + uid + "l)" }, svg);
    logo.textContent = "SB";
    var tag = svgEl("text", { x: 376, y: 46, "text-anchor": "end", "font-size": 13, "letter-spacing": 5, "font-family": "Arial, sans-serif", fill: s.tag }, svg);
    tag.textContent = "SB CARD";
    svgEl("rect", { x: 24, y: 112, width: 52, height: 40, rx: 8, fill: "url(#" + uid + "c)" }, svg);
    svgEl("path", { d: "M24 132 H76 M50 112 V152", stroke: "rgba(0,0,0,0.35)", "stroke-width": 1.2, fill: "none" }, svg);
    svgEl("circle", { cx: 326, cy: 196, r: 24, fill: s.ring[0], "fill-opacity": 0.85 }, svg);
    svgEl("circle", { cx: 354, cy: 196, r: 24, fill: s.ring[1], "fill-opacity": 0.6 }, svg);
    c.appendChild(svg);
    if (s.sheen) c.appendChild(h("div", "bcard-sheen"));
    c.appendChild(h("div", "bcard-num", "••••  ••••  ••••  " + (last4 || "0000")));
    var foot = h("div", "bcard-foot");
    foot.appendChild(h("small", "", "MEMBER SINCE " + year));
    foot.appendChild(h("b", "", (name || "CARD HOLDER").toUpperCase()));
    c.appendChild(foot);
    c.style.color = s.text;
    return c;
  }

  // ---------- Live state ----------
  var uid = null, unsub = null, live = null, lastJson = "", flash = "";
  var holdingsLive = null, marketLive = null, hUnsub = null, mUnsub = null;
  function bank() { return live && live.bank ? live.bank : blank(); }
  function balance() { return live ? live.balance : 0; }

  function run(mut, after) {
    if (!uid || !window.Wallet) return;
    Wallet.bankTxWithStocks(uid, [], mut).then(function () { if (after) after(); }).catch(function (err) {
      flash = err && err.message ? err.message : "Something went wrong. Try again.";
      render();
    });
  }
  function maintain() {
    if (!uid || !window.Wallet) return;
    Wallet.bankTxWithStocks(uid, [], function (cur, env) { return processAll(cur, Date.now(), env); }).catch(function () { /* try again next time */ });
  }
  function link() {
    var u = window.SB && SB.uid ? SB.uid() : null;
    if (!u || u === uid || !window.Wallet) return;
    uid = u;
    if (unsub) unsub();
    unsub = Wallet.watchBank(uid, function (d) {
      live = d;
      var j = JSON.stringify(d);
      if (j !== lastJson) { lastJson = j; render(); }
    });
    if (hUnsub) hUnsub();
    hUnsub = Wallet.watchHoldingsAll(uid, function (m) { holdingsLive = m; });
    if (mUnsub) mUnsub();
    mUnsub = Wallet.watchMarketAll(function (m) { marketLive = m; });
    maintain();
  }
  setInterval(link, 1000);
  setInterval(maintain, 30000);

  // ---------- Sections ----------
  function section(title, sub) {
    var s = h("div", "list-card bank-sec");
    var head = h("div", "list-head");
    head.appendChild(h("p", "card-title", title));
    if (sub) head.appendChild(h("span", "bank-sub", sub));
    s.appendChild(head);
    return s;
  }
  function row(label, val) {
    var r = h("div", "bank-row");
    r.appendChild(h("span", "", label));
    r.appendChild(h("b", "", val));
    return r;
  }
  function field(label, value) {
    var wrap = h("label", "bank-field");
    wrap.appendChild(h("span", "bank-flabel", label));
    var input = h("input");
    input.type = "text";
    input.autocomplete = "off";
    if (value !== undefined) input.value = value;
    wrap.appendChild(input);
    return { wrap: wrap, input: input };
  }

  function noticeBlock(b, now) {
    var box = h("div");
    if (b.loan) {
      var lk = h("div", "bank-notice");
      lk.appendChild(h("b", "", "Card locked"));
      lk.appendChild(h("span", "", "You owe a loan, so you can't send, buy stocks or make payments until it's paid. Sell shares or move savings to your card, then pay it off."));
      box.appendChild(lk);
    }
    if (b.issued && !b.level) {
      var c = h("div", "bank-notice");
      c.appendChild(h("b", "", "Your card is closed"));
      c.appendChild(h("span", "", "A weekly fee could not be covered. Your score fell, and savings earn less and borrowing costs more for 30 days. Get a normal card to keep banking."));
      box.appendChild(c);
    }
    if (b.loan && b.loan.dueAt - now < DAY && b.loan.dueAt > now) {
      var n = h("div", "bank-notice");
      n.appendChild(h("b", "", "Final notice"));
      n.appendChild(h("span", "", "Your loan is due in " + leftText(b.loan.dueAt - now) + ". Pay it back, or the amount owed plus the penalty is taken from your card and savings."));
      box.appendChild(n);
    }
    return box;
  }

  function levelPicker(b) {
    var box = h("div", "bank-levels");
    box.appendChild(h("p", "bank-kick", "Card levels"));
    ORDER.forEach(function (key) {
      var L = LEVELS[key];
      var r = h("div", "bank-level" + (b.level === key ? " current" : ""));
      var txt = h("div");
      txt.appendChild(h("b", "", L.name + (L.weekly ? " · " + money(L.weekly) + " a week" : " · Free")));
      var facts = [L.min ? "Score " + L.min + "+" : "Anyone"];
      if (L.cut) facts.push("loan fee −" + (L.cut * 100).toFixed(1) + "%");
      if (L.save) facts.push("savings +" + L.save.toFixed(2) + "%");
      txt.appendChild(h("small", "bank-when", facts.join(" · ")));
      r.appendChild(txt);
      var btn;
      if (b.level === key) {
        btn = h("span", "bank-now", "Current");
      } else if (key === "regular") {
        btn = h("button", "chip", "Use normal card");
        btn.type = "button";
        btn.addEventListener("click", openDowngrade);
      } else if (b.score < L.min) {
        btn = h("span", "bank-lock", "Locked");
      } else {
        var price = round2(L.weekly * (b.everHeld && b.everHeld[key] ? 0.9 : 1));
        btn = h("button", "chip on", (b.everHeld && b.everHeld[key] ? "Rebuy " : "Buy ") + money(price));
        btn.type = "button";
        btn.addEventListener("click", function () { openLevel(key); });
      }
      r.appendChild(btn);
      box.appendChild(r);
    });
    return box;
  }

  function cardBlock(b) {
    var s = section("Your card", b.issued ? (b.level ? LEVELS[b.level].name : "Closed") : "Not issued");
    if (!b.issued) {
      s.appendChild(h("p", "muted small", "Issue your SB Card to get a one-time $100 gift, and to open savings and loans."));
      s.appendChild(cardEl("regular", "CARD HOLDER", "0000", new Date().getFullYear(), false));
      var go = h("button", "primary wide", "Issue my card");
      go.type = "button";
      go.addEventListener("click", openAgreement);
      s.appendChild(go);
      return s;
    }
    var last4 = cardDigits().slice(-4) || "0000";
    s.appendChild(cardEl(b.level || "regular", b.name, last4, new Date(b.issuedAt).getFullYear(), !b.level));
    s.appendChild(row("Card balance", money(balance())));
    if (b.level && b.level !== "regular") {
      s.appendChild(row("Weekly fee", money(LEVELS[b.level].weekly)));
      var t = h("div", "bank-timer");
      t.appendChild(h("span", "", "Next fee in"));
      var tl = h("b", "", dur(b.weekFeeAt - Date.now()));
      tl.id = "bankFeeLeft";
      t.appendChild(tl);
      s.appendChild(t);
    }
    if (!b.level) {
      var n = h("button", "primary wide", "Get a normal card (free)");
      n.type = "button";
      n.addEventListener("click", function () { run(getNormalCardAction()); });
      s.appendChild(n);
    }
    s.appendChild(levelPicker(b));
    return s;
  }

  function savingsBlock(b, now) {
    var best = b.savings.length ? Math.max.apply(null, b.savings.map(function (a) { return accRate(b, a, now); })) : bandRate(b.score);
    var s = section("Savings", "Best " + pct(best));
    if (!b.issued) { s.appendChild(h("p", "muted small", "Issue your card first to open savings.")); return s; }
    s.appendChild(h("p", "muted small", "Rates change every 6 hours. The longer money stays, and the better your card and score, the more it earns."));
    if (flagged(b, now)) s.appendChild(h("p", "bank-flash", "Rates are low for " + dur(b.flagUntil - now) + " after your card was closed."));
    if (!b.savings.length) s.appendChild(h("p", "muted small", "No savings accounts yet."));
    b.savings.forEach(function (acc) {
      var box = h("div", "bank-acc");
      var top = h("div", "bank-acc-top");
      var left = h("div");
      left.appendChild(h("b", "", acc.name));
      left.appendChild(h("small", "bank-when", "Earns " + pct(accRate(b, acc, now)) + " a year"));
      top.appendChild(left);
      var bal = h("b", "bank-acc-bal", money(balAt(b, acc, now)));
      bal.setAttribute("data-acc", String(acc.id));
      top.appendChild(bal);
      box.appendChild(top);
      var btns = h("div", "bank-btns");
      var add = h("button", "chip on", "Add money");
      add.type = "button";
      add.addEventListener("click", function () { openMove(acc.id, true); });
      var take = h("button", "chip", "Take out");
      take.type = "button";
      take.addEventListener("click", function () { openMove(acc.id, false); });
      btns.appendChild(add);
      btns.appendChild(take);
      box.appendChild(btns);
      s.appendChild(box);
    });
    if (b.level) {
      var form = h("div", "bank-add");
      var inp = h("input");
      inp.type = "text";
      inp.maxLength = 24;
      inp.placeholder = "Name a new savings account";
      var open = h("button", "chip on", "Open");
      open.type = "button";
      open.addEventListener("click", function () {
        var name = inp.value.trim();
        if (name) run(openSavingsAction(name));
      });
      form.appendChild(inp);
      form.appendChild(open);
      s.appendChild(form);
    }
    return s;
  }

  function borrowBlock(b, now) {
    var s = section("Borrow", "Score " + b.score);
    if (!b.issued) { s.appendChild(h("p", "muted small", "Issue your card to see what you can borrow.")); return s; }
    var score = h("div", "bank-score");
    score.appendChild(h("b", "", String(b.score)));
    score.appendChild(h("span", "bank-band", bandName(b.score)));
    s.appendChild(score);
    var bar = h("div", "bank-bar");
    var fill = h("i");
    fill.style.width = Math.round((b.score - 100) / 7.5) + "%";
    bar.appendChild(fill);
    s.appendChild(bar);
    s.appendChild(h("p", "muted small", "You can borrow up to " + money(bandLimit(b.score)) + ". Fee " + pct(loanFeePct(b, now) * 100) + " a loan, before any interest."));
    if (flash) s.appendChild(h("p", "bank-flash", flash));
    if (b.loan) {
      var L = b.loan;
      var l = h("div", "bank-loan");
      l.appendChild(h("p", "bank-kick", "Loan open · " + TERMS[L.termKey].label));
      l.appendChild(h("p", "bank-big", money(L.amount)));
      var owed = h("p", "bank-line");
      owed.appendChild(document.createTextNode("Owed now "));
      var ow = h("b", "", money(L.inDefault ? L.stillOwed : owedAt(L, now)));
      ow.id = "bankOwed";
      owed.appendChild(ow);
      l.appendChild(owed);
      var left = h("p", "bank-line");
      left.appendChild(document.createTextNode("Time left "));
      var lf = h("b", "", leftText(L.dueAt - now));
      lf.id = "bankLeft";
      left.appendChild(lf);
      l.appendChild(left);
      var symbolsHeld = Object.keys(L.collateral || {});
      if (symbolsHeld.length) {
        l.appendChild(h("p", "muted small", "Secured by " + symbolsHeld.map(function (k) { return round4(L.collateral[k]) + " " + k + " shares"; }).join(", ") + ". They stay locked until this is paid back."));
      }
      if (L.inDefault) {
        l.appendChild(h("p", "bank-flash", "Still owed " + money(L.stillOwed) + ". Your pledged shares are being sold to cover it."));
      }
      l.appendChild(h("p", "muted small", "You can pay any time. Repaying within 12 hours adds nothing to your score."));
      var pay = h("button", "primary wide", "Pay back now");
      pay.type = "button";
      pay.addEventListener("click", function () { run(repayAction()); });
      l.appendChild(pay);
      s.appendChild(l);
    } else {
      var wait = b.lastBorrowAt + 12 * HOUR - now;
      if (wait > 0) s.appendChild(h("p", "muted small", "You can borrow again in " + dur(wait) + ". This keeps loans real."));
      var btn = h("button", "primary wide", "Borrow");
      btn.type = "button";
      btn.disabled = wait > 0 || !b.level;
      btn.addEventListener("click", openBorrow);
      s.appendChild(btn);
      var sub = h("div", "bank-sub");
      sub.style.marginTop = "14px";
      sub.appendChild(h("p", "bank-kick", "Against your shares"));
      sub.appendChild(h("p", "muted small", "Borrow above your limit by pledging shares. Usage limit: 91% of what the shares are worth. The shares stay locked until you pay back."));
      var sbtn = h("button", "wide", "Borrow against shares");
      sbtn.type = "button";
      sbtn.disabled = wait > 0 || !b.level;
      sbtn.addEventListener("click", openCollateral);
      sub.appendChild(sbtn);
      s.appendChild(sub);
    }
    var more = h("details", "bank-rules");
    more.appendChild(h("summary", "", "How your score works"));
    [
      "Starts at 100 and can reach 850.",
      "Repaid loans kept 12 hours or more: +25. Kept 7 days or more: +40.",
      "Account age: +1 a week, up to +40.",
      "Savings of $50 or more: +2 a day.",
      "The score can rise by at most 60 a day, so the top takes at least 1 to 2 weeks.",
      "Late or overdue loans: −60. A card that closes: −100.",
      "Quick repayments under 12 hours, and borrowing in a loop, add nothing."
    ].forEach(function (t) { more.appendChild(h("p", "", "• " + t)); });
    s.appendChild(more);
    return s;
  }

  function statementBlock(b) {
    var s = section("Statement");
    if (!b.history.length) {
      s.appendChild(h("p", "muted small", "Nothing yet. Your card, savings and loans show up here."));
      return s;
    }
    b.history.slice(0, 8).forEach(function (e) {
      var r = h("div", "bank-row");
      var left = h("div");
      left.appendChild(h("span", "", e.text));
      left.appendChild(h("small", "bank-when", fmtDate(e.at)));
      r.appendChild(left);
      if (e.amount) r.appendChild(h("b", "", money(e.amount)));
      s.appendChild(r);
    });
    return s;
  }

  function render() {
    var box = $("bankBody");
    if (!box) return;
    var b = bank(), now = Date.now();
    box.innerHTML = "";
    box.appendChild(noticeBlock(b, now));
    box.appendChild(cardBlock(b));
    box.appendChild(savingsBlock(b, now));
    box.appendChild(borrowBlock(b, now));
    box.appendChild(statementBlock(b));
    box.appendChild(h("p", "bank-fine", "SB Bank is a practice bank. All money here is fake and is for fun."));
    flash = "";
    renderPromo();
  }

  // Live numbers: fee countdown, loan owed and countdown, savings balances
  function tick() {
    if (!live || !live.bank) return;
    var b = bank(), now = Date.now();
    var f = $("bankFeeLeft");
    if (f && b.level) f.textContent = dur(b.weekFeeAt - now);
    if (b.loan) {
      var o = $("bankOwed"), l = $("bankLeft");
      if (o) o.textContent = money(owedAt(b.loan, now));
      if (l) l.textContent = leftText(b.loan.dueAt - now);
      if (now >= b.loan.dueAt) maintain();
    }
    b.savings.forEach(function (acc) {
      var el = document.querySelector('[data-acc="' + acc.id + '"]');
      if (el) el.textContent = money(balAt(b, acc, now));
    });
  }
  setInterval(tick, 1000);

  // Home: until the card is issued, a line tells people where to go
  function renderPromo() {
    var p = $("bankPromo");
    if (!p) return;
    p.innerHTML = "";
    if (!live || bank().issued) { p.classList.add("hidden"); return; }
    p.classList.remove("hidden");
    p.appendChild(h("p", "bank-kick", "Next step"));
    p.appendChild(h("p", "bank-h2", "Go to SB Bank and issue your card"));
    p.appendChild(h("p", "muted small", "Your card comes with a one-time $100 gift."));
    var btn = h("button", "primary wide", "Open SB Bank");
    btn.type = "button";
    btn.addEventListener("click", function () {
      var t = document.querySelector('.tabbtn[data-tab="bank"]');
      if (t) t.click();
    });
    p.appendChild(btn);
  }

  // ---------- Full pages that slide in over Home ----------
  function openPage(title, build) {
    flash = "";
    $("bankPageTitle").textContent = title;
    var body = $("bankPageBody");
    body.innerHTML = "";
    build(body);
    var p = $("bankPage");
    p.classList.remove("hidden", "leaving");
    p.scrollTop = 0;
  }
  function closePage() {
    var p = $("bankPage");
    p.classList.add("leaving");
    setTimeout(function () { p.classList.add("hidden"); p.classList.remove("leaving"); }, 380);
  }
  function pageError(body) {
    var e = h("p", "bank-flash", "");
    e.id = "bankPageErr";
    body.appendChild(e);
    return e;
  }
  function showPageError(msg) {
    var e = $("bankPageErr");
    if (e) e.textContent = msg;
  }
  // Runs a change from a page: close on success, show the message on failure
  function runFromPage(mut, shareSymbols) {
    if (!uid || !window.Wallet) return;
    Wallet.bankTxWithStocks(uid, shareSymbols || [], mut).then(closePage).catch(function (err) {
      showPageError(err && err.message ? err.message : "Something went wrong. Try again.");
    });
  }

  var CLAUSES = [
    ["Your card", "SB Bank issues one SB Card per account. A one-time gift of $100 is added to your card when it is issued. It is given once and never again."],
    ["Card levels", "Regular is free. Silver, Gold and Premium cost a weekly fee of $5,000, $10,000 and $15,000, and you need the matching credit score to buy them. Fees come from your card first, then from savings."],
    ["If a fee isn't covered", "If the weekly fee can't be covered from your card and savings, the card closes. Everything on the card and in savings is taken, your score falls, and rates stay low for 30 days."],
    ["Loans", "Borrowing costs a fee when you take the loan, plus interest for every hour it is open. You can pay back any time. You can't borrow again for 12 hours after a loan."],
    ["Credit score", "Your score starts at 100 and grows slowly through good repayments, account age and savings. Late or overdue loans lower it."],
    ["Overdue loans", "If a loan is not paid by its due time, the amount owed plus a penalty is taken from your card and savings. The penalty is 100% for a low score, 75% for a middle score and 50% for a high score. You get one final notice 24 hours before the due time."],
    ["Savings", "Savings earn interest that changes every 6 hours. Your score, your card level and the time money stays all raise the rate."]
  ];

  function openAgreement() {
    openPage("Cardholder agreement", function (body) {
      var doc = h("div", "bank-doc");
      var head = h("div", "bank-doc-head");
      var logo = h("div", "bank-doc-logo");
      logo.appendChild(h("b", "", "SB"));
      logo.appendChild(h("span", "", "SB Bank"));
      head.appendChild(logo);
      head.appendChild(h("p", "muted small", "Reference SBB-" + (cardDigits().slice(-6) || "000000")));
      doc.appendChild(head);
      doc.appendChild(h("h3", "bank-doc-title", "Cardholder agreement"));
      CLAUSES.forEach(function (c, i) {
        var p = h("div", "bank-clause");
        p.appendChild(h("b", "", (i + 1) + ". " + c[0]));
        p.appendChild(h("p", "", c[1]));
        doc.appendChild(p);
      });
      body.appendChild(doc);
      var form = h("div", "bank-form");
      var first = field("First name");
      var last = field("Last name");
      var idf = field("Account ID", cardDigits() || "Not set yet");
      idf.input.readOnly = true;
      var agree = h("label", "bank-check");
      var cb = h("input");
      cb.type = "checkbox";
      agree.appendChild(cb);
      agree.appendChild(h("span", "", "I have read and agree to the cardholder agreement."));
      var go = h("button", "primary wide", "Open my card");
      go.type = "button";
      go.disabled = true;
      function check() { go.disabled = !(first.input.value.trim() && last.input.value.trim() && cb.checked); }
      first.input.addEventListener("input", check);
      last.input.addEventListener("input", check);
      cb.addEventListener("change", check);
      go.addEventListener("click", function () {
        runFromPage(issueAction((first.input.value.trim() + " " + last.input.value.trim()).trim()));
      });
      form.appendChild(first.wrap);
      form.appendChild(last.wrap);
      form.appendChild(idf.wrap);
      form.appendChild(agree);
      form.appendChild(go);
      form.appendChild(pageError(body));
      body.appendChild(form);
    });
  }

  function openLevel(key) {
    var L = LEVELS[key];
    openPage("The " + L.name + " card", function (body) {
      var b = bank();
      var price = round2(L.weekly * (b.everHeld && b.everHeld[key] ? 0.9 : 1));
      var doc = h("div", "bank-doc");
      doc.appendChild(row("First week", money(price)));
      doc.appendChild(row("Then every week", money(L.weekly)));
      doc.appendChild(h("p", "bank-clause-line", "If a weekly fee can't be covered from your card and savings, your card closes. Everything is taken, your score falls, and rates stay low for 30 days."));
      doc.appendChild(h("p", "muted small", "The fee comes out automatically at the same time each week. A countdown on your card shows the next one."));
      body.appendChild(doc);
      var agree = h("label", "bank-check");
      var cb = h("input");
      cb.type = "checkbox";
      agree.appendChild(cb);
      agree.appendChild(h("span", "", "I understand the weekly fee and what happens if it isn't paid."));
      body.appendChild(agree);
      var go = h("button", "primary wide", "Buy the " + L.name + " card");
      go.type = "button";
      go.disabled = true;
      cb.addEventListener("change", function () { go.disabled = !cb.checked; });
      go.addEventListener("click", function () { runFromPage(buyLevelAction(key)); });
      body.appendChild(go);
      body.appendChild(pageError(body));
    });
  }

  function openDowngrade() {
    openPage("Use the normal card", function (body) {
      var doc = h("div", "bank-doc");
      doc.appendChild(h("p", "", "Your card goes back to the normal card. The weekly fee stops, and you can buy a higher card again later at a small discount."));
      body.appendChild(doc);
      var go = h("button", "primary wide", "Switch to the normal card");
      go.type = "button";
      go.addEventListener("click", function () { runFromPage(downgradeAction()); });
      body.appendChild(go);
      body.appendChild(pageError(body));
    });
  }

  function openBorrow() {
    var b = bank();
    if (!b.issued || b.loan) return;
    var limit = bandLimit(b.score);
    openPage("Borrow", function (body) {
      var doc = h("div", "bank-doc");
      doc.appendChild(h("p", "muted small", "Your limit is " + money(limit) + ". One loan at a time."));
      var amt = field("Amount");
      amt.input.type = "number";
      amt.input.min = "1";
      amt.input.max = String(limit);
      amt.input.inputMode = "decimal";
      amt.input.value = "100";
      doc.appendChild(amt.wrap);
      doc.appendChild(h("p", "bank-flabel", "How long?"));
      var termKey = "standard";
      var termRow = h("div", "bank-chips");
      var termBtns = {};
      Object.keys(TERMS).forEach(function (k) {
        var tb = h("button", "chip", TERMS[k].label);
        tb.type = "button";
        termBtns[k] = tb;
        tb.addEventListener("click", function () {
          termKey = k;
          Object.keys(termBtns).forEach(function (x) { termBtns[x].classList.toggle("on", x === k); });
          update();
        });
        termRow.appendChild(tb);
      });
      termBtns.standard.classList.add("on");
      doc.appendChild(termRow);
      var chips = h("div", "bank-chips");
      [100, 200, limit].forEach(function (v) {
        var c = h("button", "chip", "$" + v);
        c.type = "button";
        c.addEventListener("click", function () { amt.input.value = String(v); update(); });
        chips.appendChild(c);
      });
      doc.appendChild(chips);
      var sum = h("div", "bank-sum");
      doc.appendChild(sum);
      var agree = h("label", "bank-check");
      var cb = h("input");
      cb.type = "checkbox";
      agree.appendChild(cb);
      agree.appendChild(h("span", "", "I agree to the loan terms, the fee, the interest and the penalty."));
      doc.appendChild(agree);
      var go = h("button", "primary wide", "Confirm loan");
      go.type = "button";
      doc.appendChild(go);
      body.appendChild(doc);
      body.appendChild(pageError(body));

      function update() {
        var a = Number(amt.input.value) || 0;
        var valid = a > 0 && a <= limit;
        var T = TERMS[termKey], now = Date.now(), fee = loanFeePct(b, now), pen = penaltyPct(b.score);
        sum.innerHTML = "";
        if (valid) {
          var due = new Date(now + T.days * DAY);
          var keptOwed = a * (1 + fee) + a * T.hourly * T.days * 24;
          sum.appendChild(row("You receive", money(a)));
          sum.appendChild(row("Fee (" + (fee * 100).toFixed(2) + "%)", money(a * fee)));
          sum.appendChild(row("Pay back straight away", money(a * (1 + fee))));
          sum.appendChild(row("Owed if kept to " + due.toLocaleDateString("en-US", { month: "short", day: "numeric" }), money(keptOwed)));
          sum.appendChild(row("Penalty if late", money(a * pen) + " (" + Math.round(pen * 100) + "%)"));
        } else {
          sum.appendChild(h("p", "muted small", "Enter an amount from $1 to " + money(limit) + "."));
        }
        go.disabled = !(valid && cb.checked);
      }
      amt.input.addEventListener("input", update);
      cb.addEventListener("change", update);
      go.addEventListener("click", function () {
        runFromPage(borrowAction(Number(amt.input.value) || 0, termKey));
      });
      update();
    });
  }

  // Borrow above your limit by pledging shares as collateral
  function openCollateral() {
    var b = bank();
    if (!b.issued || b.loan || !b.level) return;
    var limit = bandLimit(b.score);
    openPage("Borrow against shares", function (body) {
      var doc = h("div", "bank-doc");
      body.appendChild(doc);
      doc.appendChild(h("p", "muted small", "Pledge shares to borrow above your limit of " + money(limit) + ". You can borrow up to 91% of what your shares are worth. They stay locked until you pay it back."));
      var owned = Object.keys(holdingsLive || {}).filter(function (k) {
        var x = holdingsLive[k];
        return marketLive && marketLive[k] && x.shares - (x.pledged || 0) > 0.000001;
      });
      if (!owned.length) {
        doc.appendChild(h("p", "muted small", "You don't have any free shares to pledge. Buy some on the stocks page first."));
        return;
      }
      var sym = owned[0];
      doc.appendChild(h("p", "bank-flabel", "Which shares?"));
      var symRow = h("div", "bank-chips");
      var symBtns = {};
      owned.forEach(function (k) {
        var sb = h("button", "chip", marketLive[k].name || k);
        sb.type = "button";
        symBtns[k] = sb;
        sb.addEventListener("click", function () {
          sym = k;
          Object.keys(symBtns).forEach(function (x) { symBtns[x].classList.toggle("on", x === k); });
          update();
        });
        symRow.appendChild(sb);
      });
      symBtns[sym].classList.add("on");
      doc.appendChild(symRow);

      var shares = field("Shares to pledge");
      shares.input.type = "number";
      shares.input.min = "0";
      shares.input.inputMode = "decimal";
      doc.appendChild(shares.wrap);
      var amt = field("Amount to borrow");
      amt.input.type = "number";
      amt.input.min = "1";
      amt.input.inputMode = "decimal";
      amt.input.value = String(limit + 100);
      doc.appendChild(amt.wrap);

      doc.appendChild(h("p", "bank-flabel", "How long?"));
      var termKey = "standard";
      var termRow = h("div", "bank-chips");
      var termBtns = {};
      Object.keys(TERMS).forEach(function (k) {
        var tb = h("button", "chip", TERMS[k].label);
        tb.type = "button";
        termBtns[k] = tb;
        tb.addEventListener("click", function () {
          termKey = k;
          Object.keys(termBtns).forEach(function (x) { termBtns[x].classList.toggle("on", x === k); });
          update();
        });
        termRow.appendChild(tb);
      });
      termBtns.standard.classList.add("on");
      doc.appendChild(termRow);

      var sum = h("div", "bank-sum");
      doc.appendChild(sum);
      var agree = h("label", "bank-check");
      var cb = h("input");
      cb.type = "checkbox";
      agree.appendChild(cb);
      agree.appendChild(h("span", "", "I agree that my shares stay locked, and that they can be sold to cover this loan if it isn't paid on time."));
      doc.appendChild(agree);
      var go = h("button", "primary wide", "Confirm loan");
      go.type = "button";
      doc.appendChild(go);
      body.appendChild(pageError(body));

      function update() {
        var m = marketLive[sym], x = holdingsLive[sym];
        var free = x ? round4(x.shares - (x.pledged || 0)) : 0;
        var n = Number(shares.input.value) || 0, a = Number(amt.input.value) || 0, now = Date.now();
        var T = TERMS[termKey];
        var worth = n > 0 && n <= free + 0.000001 ? round2(MP.grossSellValue(m, m.held || 0, n, now) * (1 - MP.SPREAD)) : 0;
        var most = Math.floor(worth * SHARES_LTV * 100) / 100;
        sum.innerHTML = "";
        sum.appendChild(row("You have free", free + " shares"));
        sum.appendChild(row("Those shares are worth", worth > 0 ? money(worth) : "-"));
        sum.appendChild(row("Most you can borrow", money(most)));
        if (a > 0 && worth > 0) {
          sum.appendChild(row("You receive", money(a)));
          sum.appendChild(row("Fee (" + (SHARES_FEE * 100).toFixed(0) + "%)", money(a * SHARES_FEE)));
          sum.appendChild(row("Owed if kept to the end", money(a * (1 + SHARES_FEE) + a * T.hourly * T.days * 24)));
          sum.appendChild(row("Penalty if late", money(a * SHARES_PENALTY) + " (" + Math.round(SHARES_PENALTY * 100) + "%)"));
        }
        var msg = "";
        if (n > free + 0.000001) msg = "You only have " + free + " free shares of this stock.";
        else if (!(a > limit)) msg = "Borrow more than " + money(limit) + " to use shares. Smaller loans use the normal borrow.";
        else if (worth > 0 && a > most) msg = "Your shares can back up to 91% of their value.";
        if (msg) sum.appendChild(h("p", "muted small", msg));
        go.disabled = !(worth > 0 && a > limit && a <= most && cb.checked);
      }
      shares.input.addEventListener("input", update);
      amt.input.addEventListener("input", update);
      cb.addEventListener("change", update);
      go.addEventListener("click", function () {
        runFromPage(borrowSharesAction(sym, Number(shares.input.value) || 0, Number(amt.input.value) || 0, termKey), [sym]);
      });
      update();
    });
  }

  // Move money between the card and a savings account
  function openMove(id, into) {
    var b = bank();
    var acc = b.savings.filter(function (a) { return a.id === id; })[0];
    if (!acc) return;
    var now = Date.now();
    var avail = into ? balance() : balAt(b, acc, now);
    openPage(into ? "Add money to " + acc.name : "Take out of " + acc.name, function (body) {
      var doc = h("div", "bank-doc");
      doc.appendChild(row(into ? "Card balance" : "In " + acc.name, money(avail)));
      var amt = field("Amount");
      amt.input.type = "number";
      amt.input.min = "1";
      amt.input.inputMode = "decimal";
      doc.appendChild(amt.wrap);
      body.appendChild(doc);
      var go = h("button", "primary wide", into ? "Move to savings" : "Move to card");
      go.type = "button";
      go.disabled = true;
      amt.input.addEventListener("input", function () {
        var a = Number(amt.input.value) || 0;
        go.disabled = !(a > 0 && a <= avail);
      });
      go.addEventListener("click", function () {
        runFromPage(moveAction(id, Number(amt.input.value) || 0, into));
      });
      body.appendChild(go);
      body.appendChild(pageError(body));
    });
  }

  $("bankPageBack").addEventListener("click", closePage);
  if (window.SB && SB.on) SB.on("tab", function (name) {
    if (name === "bank") render();
    if (name === "home") renderPromo();
  });
  link();
  render();
})();
