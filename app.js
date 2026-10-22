// app.js — SB Wallet core: sign up / log in, sheets, Fund, Send, receipts, notifications, deleting.
// cards.js and chat.js plug into the "SB" helper object made here.

(function () {
  function $(id) { return document.getElementById(id); }

  // ---------- Show problems on screen (so we can see what went wrong) ----------
  function splashVisible() { return !$("splash").classList.contains("hidden"); }
  function showProblem(text) { if (splashVisible()) $("splashMsg").textContent = text; }
  window.addEventListener("error", function (e) { showProblem("Problem: " + (e.message || "unknown")); });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    showProblem("Problem: " + ((r && (r.message || r.code)) || "unknown"));
  });

  if (!window.Wallet) {
    showProblem("Couldn't load. Check your internet, then reload.");
    return;
  }
  var Wallet = window.Wallet;

  var loaded = false;
  setTimeout(function () {
    if (!loaded) showProblem("Still loading… check your internet, then reload.");
  }, 7000);

  // ---------- Settings you can change ----------
  var MAX_FUND = 5000;               // most you can add at once
  var FEE_RATE = 0.015;              // fee when you send money: 1.5% ...
  var FEE_MIN = 0.25;                // ... but at least this much ...
  var FEE_MAX = 5;                   // ... and at most this much
  var BUSY_MIN_MS = 3000;            // how long the "sending" animation plays (3 seconds)
  var RECEIPT_LIFETIME_HOURS = 24;   // receipts delete themselves after this many hours
  var LIFE_MS = RECEIPT_LIFETIME_HOURS * 3600 * 1000;
  $("lifeHours").textContent = RECEIPT_LIFETIME_HOURS;

  // ---------- Shared helpers (also used by cards.js and chat.js) ----------
  var SB = window.SB = { $: $, state: { uid: null, user: null, profile: null, profileLive: false } };

  // ===== FEATURE SWITCHES =====
  // Part 1 is ON. Part 2 is built too, but switched OFF until we turn it on together.
  // To turn a feature on later, change false to true on that line.
  SB.features = Object.assign({
    fees: true,          // fee when you send money (paid to the fee owner)
    requireCard: true,   // you must make a card before you can use the wallet
    owner: false,        // only the owner can add money, with a second password
    charts: true         // analytics: donut + bar charts
  }, window.__SB_FLAGS || {});
  var listeners = {};
  SB.on = function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); };
  SB.emit = function (name, data) { (listeners[name] || []).forEach(function (fn) { try { fn(data); } catch (e) { console.error(e); } }); };

  var toastTimer;
  function toast(message) {
    var el = $("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2200);
  }
  function money(n) { return n.toLocaleString("en-US", { style: "currency", currency: "USD" }); }
  // Shows the balance with the cents in faded text, like "$186,486" + ".28"
  function renderBal(n) {
    var s = money(n);
    var box = $("balance");
    var i = s.lastIndexOf(".");
    box.textContent = "";
    if (i === -1) { box.textContent = s; return; }
    box.appendChild(document.createTextNode(s.slice(0, i)));
    var c = document.createElement("span");
    c.className = "cents";
    c.textContent = s.slice(i);
    box.appendChild(c);
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function fullName(p) { return (p.firstName + " " + (p.lastName || "")).trim(); }
  function colorClass(text) { return "c" + (((text || "A").charCodeAt(0) % 3) + 1); }
  function timeAgo(ms) {
    var s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return "now";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  }
  function greetingText() {
    var h = new Date().getHours();
    if (h < 12) return "Good morning!";
    if (h < 18) return "Good afternoon!";
    return "Good evening!";
  }
  function remember(flag) { try { localStorage.setItem("sbw_returning", flag ? "1" : ""); } catch (e) {} }
  function isReturning() { try { return !!localStorage.getItem("sbw_returning"); } catch (e) { return false; } }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch (e2) { return false; }
    }
  }

  // A button that needs two taps (first tap arms it, second tap does it)
  function twoStep(btn, armedText, action) {
    var timer;
    function reset() {
      clearTimeout(timer);
      btn.classList.remove("armed");
      if (btn.dataset.normal) btn.textContent = btn.dataset.normal;
    }
    btn.addEventListener("click", function () {
      if (!btn.classList.contains("armed")) {
        btn.dataset.normal = btn.dataset.normal || btn.textContent;
        btn.classList.add("armed");
        btn.textContent = armedText;
        clearTimeout(timer);
        timer = setTimeout(reset, 3000);
      } else {
        reset();
        action();
      }
    });
    btn._reset = reset;
  }

  function feeFor(amount) {
    if (!SB.features.fees || !(amount > 0)) return 0;
    if (!SB.state.feeOwner || SB.state.feeOwner === SB.state.uid) return 0; // no fee owner found, or you are the fee owner
    return Math.round(Math.min(Math.max(amount * FEE_RATE, FEE_MIN), FEE_MAX) * 100) / 100;
  }
  SB.feeFor = feeFor;

  SB.toast = toast; SB.money = money; SB.sleep = sleep; SB.fullName = fullName;
  SB.colorClass = colorClass; SB.copyText = copyText; SB.twoStep = twoStep; SB.timeAgo = timeAgo;
  // "48213907" is shown as "4821 3907"
  function prettyId(id) { return String(id || "").replace(/(\d{4})(?=\d)/g, "$1 ").trim(); }
  SB.prettyId = prettyId;

  // ---------- Sounds ----------
  var audioCtx;
  function ctx() {
    if (!audioCtx) {
      var A = window.AudioContext || window.webkitAudioContext;
      if (A) audioCtx = new A();
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }
  function beep(freq, dur, vol, delay) {
    var c = ctx();
    if (!c) return;
    var t = c.currentTime + (delay || 0);
    var o = c.createOscillator();
    var g = c.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  function tick() { beep(1900, 0.04, 0.05, 0); }
  function chime() { beep(660, 0.25, 0.12, 0); beep(880, 0.25, 0.12, 0.12); beep(1320, 0.45, 0.12, 0.24); }
  function ding() { beep(988, 0.14, 0.1, 0); beep(1319, 0.22, 0.1, 0.11); }
  SB.tick = tick; SB.chime = chime;
  // Phones only allow sound after a tap, so unlock it on the first tap
  document.addEventListener("touchstart", function () { ctx(); }, { once: true, passive: true });
  document.addEventListener("mousedown", function () { ctx(); }, { once: true });

  // ---------- Press effect (iPhone does not always show :active) ----------
  function pressDown(e) {
    var b = e.target && e.target.closest ? e.target.closest("button") : null;
    if (b && !b.disabled) b.classList.add("pressed");
  }
  function pressUp() {
    setTimeout(function () {
      document.querySelectorAll("button.pressed").forEach(function (b) { b.classList.remove("pressed"); });
    }, 90);
  }
  document.addEventListener("touchstart", pressDown, { passive: true });
  document.addEventListener("touchend", pressUp, { passive: true });
  document.addEventListener("touchcancel", pressUp, { passive: true });
  document.addEventListener("mousedown", pressDown);
  document.addEventListener("mouseup", pressUp);

  // ---------- Balance count-up ----------
  var shownBalance = 0;
  var latestBalance = 0;
  var holdBalance = false;
  var balanceFrame;
  function animateBalance(to) {
    cancelAnimationFrame(balanceFrame);
    $("balance").classList.remove("loading-text");
    var from = shownBalance;
    var start = performance.now();
    var duration = 1100;
    function step(now) {
      var t = Math.min((now - start) / duration, 1);
      var eased = 1 - Math.pow(1 - t, 4); // starts fast, slows at the end
      shownBalance = from + (to - from) * eased;
      renderBal(shownBalance);
      if (t < 1) balanceFrame = requestAnimationFrame(step);
      else shownBalance = to;
    }
    balanceFrame = requestAnimationFrame(step);
  }
  function setBalanceNow(n) {
    cancelAnimationFrame(balanceFrame);
    shownBalance = n;
    $("balance").classList.remove("loading-text");
    renderBal(n);
  }

  // Things not built yet
  document.querySelectorAll("[data-soon]").forEach(function (el) {
    el.addEventListener("click", function () { toast("Coming soon!"); });
  });

  // ---------- Screens ----------
  function showOnly(which) {
    $("auth").classList.toggle("hidden", which !== "auth");
    $("app").classList.toggle("hidden", which !== "app");
  }
  function hideSplash() {
    var splash = $("splash");
    splash.classList.add("leaving");
    setTimeout(function () { splash.classList.add("hidden"); }, 450);
  }
  function switchTab(name) {
    document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
    document.querySelectorAll(".tabbtn").forEach(function (b) { b.classList.remove("active"); });
    $("tab-" + name).classList.add("active");
    document.querySelector('.tabbtn[data-tab="' + name + '"]').classList.add("active");
    window.scrollTo(0, 0);
    SB.emit("tab", name);
  }
  SB.openTab = switchTab;
  document.querySelectorAll(".tabbtn").forEach(function (btn) {
    btn.addEventListener("click", function () { switchTab(btn.dataset.tab); });
  });

  // ---------- Sign up / Log in form (strict: nothing can be missing or wrong) ----------
  var mode = isReturning() ? "login" : "signup";
  var busy = false;
  var touched = {};
  var FIELDS = ["firstName", "lastName", "email", "password", "password2"];

  var EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}$/;
  var NAME_RE = /^\p{L}[\p{L}' \-]{0,29}$/u;

  function cleanName(s) {
    s = s.trim().replace(/\s+/g, " ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function problems() {
    var list = [];
    var first = $("firstName").value.trim();
    var last = $("lastName").value.trim();
    var email = $("email").value.trim();
    var pw = $("password").value;
    var pw2 = $("password2").value;

    if (mode === "signup") {
      if (!first) list.push({ field: "firstName", text: "Type your first name." });
      else if (!NAME_RE.test(first)) list.push({ field: "firstName", text: "First name can only have letters." });
      if (!last) list.push({ field: "lastName", text: "Type your last name." });
      else if (!NAME_RE.test(last)) list.push({ field: "lastName", text: "Last name can only have letters." });
    }
    if (!email) list.push({ field: "email", text: "Type your email." });
    else if (!EMAIL_RE.test(email)) list.push({ field: "email", text: "Your email isn't complete. It should look like name@gmail.com" });

    if (!pw) {
      list.push({ field: "password", text: "Type your password." });
    } else if (mode === "signup") {
      if (pw.length < 8) list.push({ field: "password", text: "Password needs at least 8 characters." });
      else if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) list.push({ field: "password", text: "Password needs at least one letter and one number." });
      else if (!pw2) list.push({ field: "password2", text: "Type your password again to be sure." });
      else if (pw !== pw2) list.push({ field: "password2", text: "The two passwords don't match." });
    }
    return list;
  }

  function validate() {
    var list = problems();
    FIELDS.forEach(function (id) { $(id).classList.remove("bad"); });
    var shown = null;
    list.forEach(function (p) {
      if (touched[p.field]) {
        $(p.field).classList.add("bad");
        if (!shown) shown = p;
      }
    });
    $("authHint").textContent = shown ? shown.text : list.length ? "Fill in everything to continue." : "Looks good ✓";
    $("authBtn").disabled = busy || list.length > 0;
    return list.length === 0;
  }

  function clearForm() {
    FIELDS.forEach(function (id) { $(id).value = ""; });
    $("password").type = "password";
    $("password2").type = "password";
    $("showPw").classList.remove("on");
  }

  function setMode(next) {
    mode = next;
    var signup = mode === "signup";
    touched = {};
    $("tabSignup").classList.toggle("active", signup);
    $("tabLogin").classList.toggle("active", !signup);
    $("nameRow").classList.toggle("hidden", !signup);
    $("password2").classList.toggle("hidden", !signup);
    $("authTitle").textContent = signup ? "Welcome to SB Wallet" : "Welcome back";
    $("authSub").textContent = signup ? "Make your account. Password: 8+ characters with a letter and a number." : "Log in to see your balance.";
    $("authBtn").textContent = signup ? "Create account" : "Log in";
    $("password").autocomplete = signup ? "new-password" : "current-password";
    $("authError").textContent = "";
    validate();
  }

  $("tabSignup").addEventListener("click", function () { setMode("signup"); });
  $("tabLogin").addEventListener("click", function () { setMode("login"); });

  FIELDS.forEach(function (id) {
    $(id).addEventListener("input", function () { touched[id] = true; $("authError").textContent = ""; validate(); });
    $(id).addEventListener("change", function () { touched[id] = true; validate(); });
    $(id).addEventListener("blur", function () { touched[id] = true; validate(); });
  });

  // iPhone autofill sometimes skips the usual events, so check once in a while
  setInterval(function () {
    if (!$("auth").classList.contains("hidden") && !busy) validate();
  }, 800);

  $("showPw").addEventListener("click", function () {
    var show = $("password").type === "password";
    $("password").type = show ? "text" : "password";
    $("password2").type = show ? "text" : "password";
    $("showPw").classList.toggle("on", show);
  });

  $("authForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    if (busy) return;
    FIELDS.forEach(function (id) { touched[id] = true; });
    if (!validate()) return;

    var email = $("email").value.trim().toLowerCase();
    var password = $("password").value;
    var firstName = cleanName($("firstName").value);
    var lastName = cleanName($("lastName").value);
    var message = "";
    var ok = false;

    busy = true;
    $("authBtn").disabled = true;
    $("authBtn").textContent = "One moment…";

    try {
      var user;
      if (mode === "signup") {
        user = await Wallet.signUp(firstName, lastName, email, password);
      } else {
        user = await Wallet.logIn(email, password);
        Wallet.ensureProfile(user).catch(function () {}); // in the background, so we don't wait
      }
      busy = false;
      ok = true;
      remember(true);
      clearForm(); // erase the email and password boxes once used
      startApp(user);
    } catch (err) {
      busy = false;
      if (err.code === "auth/email-already-in-use") {
        mode = "login"; // that email has an account, so switch to Log in
        message = "That email already has an account. Type your password and log in.";
      } else {
        message = Wallet.friendlyError(err);
      }
    } finally {
      setMode(mode);
      if (!ok) $("authError").textContent = message;
    }
  });

  // ---------- Notifications (banner on every tab + bell list) ----------
  var notifs = [];
  var bannerTimer = null;
  var bannerAction = null;

  function updateBell() {
    var fresh = notifs.filter(function (n) { return n.fresh; }).length;
    $("bellBadge").textContent = fresh;
    $("bellBadge").classList.toggle("hidden", fresh === 0);
  }
  function hideBanner() { $("banner").classList.remove("show"); clearTimeout(bannerTimer); }
  function showBanner(n) {
    $("bannerTitle").textContent = n.title;
    $("bannerBody").textContent = n.body || "";
    $("bannerIc").textContent = n.icon || "SB";
    bannerAction = n.onTap || null;
    $("banner").classList.add("show");
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hideBanner, 4500);
  }
  // n: { title, body, icon, onTap }
  function notify(n) {
    n.when = Date.now();
    n.fresh = true;
    notifs.unshift(n);
    if (notifs.length > 30) notifs.pop();
    updateBell();
    showBanner(n);
    ding();
  }
  SB.notify = notify;

  $("banner").addEventListener("click", function () {
    var act = bannerAction;
    hideBanner();
    if (act) act();
  });
  var swipeY = null;
  $("banner").addEventListener("touchstart", function (e) { swipeY = e.touches[0].clientY; }, { passive: true });
  $("banner").addEventListener("touchend", function (e) {
    if (swipeY !== null && e.changedTouches[0].clientY - swipeY < -15) hideBanner();
    swipeY = null;
  }, { passive: true });

  function openNotifs() {
    var box = $("notifList");
    box.innerHTML = "";
    notifs.forEach(function (n) {
      var row = document.createElement("button");
      row.type = "button";
      row.className = "notif-row" + (n.fresh ? " fresh" : "");
      var ic = document.createElement("div");
      ic.className = "b-ic";
      ic.textContent = n.icon || "SB";
      var txt = document.createElement("div");
      txt.className = "b-txt";
      var t1 = document.createElement("p");
      t1.className = "b-title";
      t1.textContent = n.title;
      var t2 = document.createElement("p");
      t2.className = "b-body";
      t2.textContent = n.body || "";
      txt.appendChild(t1);
      txt.appendChild(t2);
      var when = document.createElement("span");
      when.className = "notif-when";
      when.textContent = timeAgo(n.when);
      row.appendChild(ic);
      row.appendChild(txt);
      row.appendChild(when);
      row.addEventListener("click", function () { closeSheet(); if (n.onTap) setTimeout(n.onTap, 280); });
      box.appendChild(row);
    });
    $("notifEmpty").classList.toggle("hidden", notifs.length > 0);
    showView("vNotifs");
    notifs.forEach(function (n) { n.fresh = false; });
    updateBell();
  }
  $("bellBtn").addEventListener("click", openNotifs);

  // ---------- Receipts ----------
  var txns = [];
  var filter = "all";
  var cleaning = false;

  function dateOf(t) {
    if (t.createdAt && t.createdAt.toDate) return t.createdAt.toDate();
    if (t.createdMs) return new Date(t.createdMs);
    return new Date();
  }
  function whenText(t) {
    return dateOf(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function refOf(t) { return t.ref || String(t.id || "").slice(0, 10).toUpperCase() || "—"; }
  function expired(t) { return Date.now() - dateOf(t).getTime() > LIFE_MS; }
  function paidWith(t) { return t.cardName ? t.cardName + " •• " + t.cardLast4 : "SB Wallet balance"; }

  function txnRow(t) {
    var neg = t.amount < 0;
    var row = document.createElement("button");
    row.type = "button";
    row.className = "txn" + (neg ? " neg" : "");

    var ic = document.createElement("div");
    ic.className = "txn-ic";
    ic.textContent = neg ? "↗" : t.type === "receive" ? "↙" : "+";

    var info = document.createElement("div");
    info.className = "txn-info";
    var title = document.createElement("p");
    title.className = "txn-title";
    title.textContent = t.title || "Transaction";
    var when = document.createElement("p");
    when.className = "txn-when";
    when.textContent = whenText(t);
    info.appendChild(title);
    info.appendChild(when);

    var amt = document.createElement("p");
    amt.className = "txn-amt";
    amt.textContent = (neg ? "-" : "+") + money(Math.abs(t.amount));

    row.appendChild(ic);
    row.appendChild(info);
    row.appendChild(amt);
    row.addEventListener("click", function () { openReceipt(t); });
    return row;
  }

  function renderTxns() {
    var list = txns.filter(function (t) { return !expired(t); });

    var home = $("homeTxns");
    home.innerHTML = "";
    if (!list.length) {
      var p = document.createElement("p");
      p.className = "muted";
      p.textContent = "Nothing yet. Your sent and received money will show up here.";
      home.appendChild(p);
    } else {
      list.slice(0, 3).forEach(function (t) { home.appendChild(txnRow(t)); });
    }

    var shown = list.filter(function (t) {
      if (filter === "sent") return t.amount < 0 && t.type !== "fee";
      if (filter === "received") return t.amount > 0 && t.type !== "fee";
      if (filter === "fees") return t.type === "fee" || (t.type === "send" && t.fee > 0);
      return true;
    });
    var box = $("txnList");
    box.innerHTML = "";
    shown.forEach(function (t) {
      box.appendChild(SB.buildHistoryCard ? SB.buildHistoryCard(t) : txnRow(t));
    });
    $("txnEmpty").classList.toggle("hidden", shown.length > 0);

    // Today's money in, for the hero pill
    var today = SBRules.todayKey();
    var inToday = list.reduce(function (sum, t) {
      return (t.amount > 0 && keyOfDate(dateOf(t)) === today) ? sum + t.amount : sum;
    }, 0);
    $("todayPill").textContent = "In today: " + money(Math.round(inToday * 100) / 100);

    SB.emit("receipts", list);
  }

  function keyOfDate(d) {
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  }
  SB.keyOfDate = keyOfDate;

  document.querySelectorAll(".pill").forEach(function (p) {
    p.addEventListener("click", function () {
      document.querySelectorAll(".pill").forEach(function (x) { x.classList.remove("active"); });
      p.classList.add("active");
      filter = p.dataset.filter || "all";
      renderTxns();
    });
  });

  // Receipts older than the lifetime delete themselves (when the app is open)
  function cleanOldReceipts(list) {
    if (cleaning || !SB.state.uid) return;
    var ids = list.filter(function (t) { return t.createdAt && t.createdAt.toDate && expired(t); }).map(function (t) { return t.id; });
    if (!ids.length) return;
    cleaning = true;
    Wallet.deleteTransactions(SB.state.uid, ids).catch(function () {}).then(function () { cleaning = false; });
  }

  twoStep($("delAllBtn"), "Tap again to delete all", function () {
    Wallet.deleteAllTransactions(SB.state.uid).then(
      function () { toast("All receipts deleted"); },
      function (e) { toast(Wallet.friendlyError(e)); }
    );
  });

  // ---------- Bottom sheet ----------
  var amountResolve = null;
  var pinResolve = null;
  var personResolve = null;
  var funding = false; // true while a Fund / Send / card step is in progress

  var VIEWS = ["vSearch", "vAmount", "vPin", "vBusy", "vReceipt", "vCardNew", "vCard", "vCards", "vNotifs", "vDelete", "vFundPw", "vOwner", "vReport", "vScan"];
  var HIGH = ["vSearch", "vDelete", "vCardNew", "vFundPw", "vOwner", "vReport"]; // these have typing, so they sit high (keyboard won't cover them)

  var sheetToken = 0;
  var lockY = 0;
  var locked = false;
  function lockScroll() {
    if (locked) return;
    locked = true;
    lockY = window.scrollY || 0;
    document.body.style.top = (-lockY) + "px";
    document.body.classList.add("sheet-open");
  }
  function unlockScroll() {
    if (!locked) return;
    locked = false;
    document.body.classList.remove("sheet-open");
    document.body.style.top = "";
    window.scrollTo(0, lockY);
  }
  SB.lockScroll = lockScroll; SB.unlockScroll = unlockScroll;

  function showView(name) {
    sheetToken++;
    lockScroll();
    VIEWS.forEach(function (v) { $(v).classList.toggle("hidden", v !== name); });
    $("sheetClose").classList.toggle("hidden", name === "vBusy");
    $("sheet").classList.toggle("high", HIGH.indexOf(name) !== -1);
    $("sheet").classList.remove("hidden", "leaving");
    $("sheetBack").classList.remove("hidden", "leaving");
    SB.emit("view", name);
  }

  function cancelPending() {
    var a = amountResolve; amountResolve = null;
    var p = pinResolve; pinResolve = null;
    var q = personResolve; personResolve = null;
    var f = fundPwResolve; fundPwResolve = null;
    if (a) a(null);
    if (p) p(null);
    if (q) q(null);
    if (f) f(false); // owner-password sheet closed: stop the Fund step so the app is never left stuck
  }

  function closeSheet() {
    cancelPending();
    $("userInput").blur();
    $("delPassword").blur();
    var s = $("sheet");
    var token = sheetToken;
    s.classList.add("leaving");
    $("sheetBack").classList.add("leaving");
    setTimeout(function () {
      if (token !== sheetToken) return; // a new sheet opened meanwhile
      s.classList.add("hidden");
      s.classList.remove("leaving");
      $("sheetBack").classList.remove("leaving");
      $("sheetBack").classList.add("hidden");
      unlockScroll();
      SB.emit("sheetClosed");
    }, 400);
  }
  SB.showView = showView; SB.closeSheet = closeSheet;

  $("sheetClose").addEventListener("click", closeSheet);
  $("rcClose").addEventListener("click", closeSheet);

  // Escape closes the sheet (but not while money is being sent)
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if ($("sheet").classList.contains("hidden")) return;
    if (!$("vBusy").classList.contains("hidden")) return;
    closeSheet();
  });

  // ---------- Keypad ----------
  function buildPad(container, withDot, onKey) {
    container.innerHTML = "";
    var keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", withDot ? "." : "", "0", "⌫"];
    keys.forEach(function (k) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "key" + (k === "" ? " blank" : "");
      b.textContent = k;
      if (k) {
        b.addEventListener("click", function () { tick(); onKey(k); });
      } else {
        b.disabled = true;
      }
      container.appendChild(b);
    });
  }

  // --- Amount screen ---
  var amtStr = "";
  var amountMax = MAX_FUND;
  var amountBaseSub = "";
  var amountOverMsg = "";
  var amountFee = false;   // true on the Send screen: show the fee
  var amountBalance = 0;

  function fmtAmt(s) {
    if (!s) return "$0";
    var parts = s.split(".");
    var out = "$" + Number(parts[0] || "0").toLocaleString("en-US");
    if (parts.length > 1) out += "." + parts[1];
    return out;
  }
  function amtValue() { return Math.round((parseFloat(amtStr) || 0) * 100) / 100; }

  function renderAmount() {
    $("amountText").textContent = fmtAmt(amtStr);
    var v = amtValue();
    var fee = amountFee ? feeFor(v) : 0;
    var over = amountFee ? (v + fee > amountBalance) : (v > amountMax);
    var msg = amountFee
      ? (fee > 0 ? "You need " + money(v + fee) + " (amount + fee). You have " + money(amountBalance) + "." : "You only have " + money(amountBalance) + ".")
      : amountOverMsg;
    $("amountSub").textContent = over ? msg : amountBaseSub;
    $("amountSub").classList.toggle("bad", over);
    if (amountFee && SB.features.fees) {
      $("feeLine").innerHTML = v > 0 ? "Fee <b>" + money(fee) + "</b> · You pay <b>" + money(v + fee) + "</b>" : "Fee: 1.5% (at least $0.25)";
    } else {
      $("feeLine").textContent = "";
    }
    $("confirmFund").disabled = !(v > 0 && !over);
  }

  function onAmountKey(k) {
    if (k === "⌫") {
      amtStr = amtStr.slice(0, -1);
    } else if (k === ".") {
      if (amtStr.indexOf(".") === -1) amtStr = (amtStr || "0") + ".";
    } else {
      var dot = amtStr.indexOf(".");
      if (dot > -1) {
        if (amtStr.length - dot - 1 >= 2) return; // only 2 decimals
      } else if (amtStr.length >= 6) {
        return; // keep numbers a sensible size
      }
      amtStr = amtStr === "0" ? k : amtStr + k;
    }
    renderAmount();
  }

  // opts: { title, sub, max, over, button, who }
  function askAmount(opts) {
    return new Promise(function (resolve) {
      amtStr = "";
      amountMax = opts.max;
      amountFee = !!opts.fee;
      amountBalance = opts.balance || 0;
      amountBaseSub = opts.sub;
      amountOverMsg = opts.over;
      $("amountTitle").textContent = opts.title;
      $("confirmFund").textContent = opts.button;

      var who = $("amountWho");
      if (opts.who) {
        who.classList.remove("hidden");
        $("whoAv").textContent = opts.who.firstName.charAt(0).toUpperCase();
        $("whoAv").className = "q-av sm " + colorClass(opts.who.firstName);
        $("whoName").textContent = fullName(opts.who);
        $("whoUser").textContent = prettyId(opts.who.accountId);
      } else {
        who.classList.add("hidden");
      }

      renderAmount();
      amountResolve = resolve;
      showView("vAmount");
    });
  }

  $("confirmFund").addEventListener("click", function () {
    var v = amtValue();
    var okAmt = amountFee ? (v > 0 && v + feeFor(v) <= amountBalance) : (v > 0 && v <= amountMax);
    if (amountResolve && okAmt) {
      var r = amountResolve;
      amountResolve = null;
      r(v);
    }
  });

  // --- PIN screen ---
  var pinBuf = "";
  var pinLocked = false;

  function renderDots() {
    var dots = $("pinDots").children;
    for (var i = 0; i < dots.length; i++) {
      dots[i].classList.remove("bad");
      dots[i].classList.toggle("on", i < pinBuf.length);
    }
  }

  function onPinKey(k) {
    if (!pinResolve || pinLocked) return;
    if (k === "⌫") pinBuf = pinBuf.slice(0, -1);
    else if (pinBuf.length < 4) pinBuf += k;
    renderDots();
    if (pinBuf.length === 4) {
      var v = pinBuf;
      var r = pinResolve;
      pinResolve = null;
      setTimeout(function () { r(v); }, 150);
    }
  }

  // isError = true: 4 red dots shake, then clear so you can try again
  function collectPin(title, sub, isError) {
    return new Promise(function (resolve) {
      pinBuf = "";
      var dotsBox = $("pinDots");
      dotsBox.classList.remove("shake");
      $("pinTitle").textContent = title;
      $("pinSub").textContent = sub || "";
      $("pinSub").classList.toggle("bad", !!isError);
      renderDots();
      pinResolve = resolve;
      showView("vPin");

      if (isError) {
        pinLocked = true;
        for (var i = 0; i < dotsBox.children.length; i++) dotsBox.children[i].classList.add("on", "bad");
        void dotsBox.offsetWidth; // restart the shake
        dotsBox.classList.add("shake");
        setTimeout(function () {
          dotsBox.classList.remove("shake");
          renderDots();
          pinLocked = false;
        }, 550);
      } else {
        pinLocked = false;
      }
    });
  }

  buildPad($("padAmount"), true, onAmountKey);
  buildPad($("padPin"), false, onPinKey);

  // ---------- Shared steps ----------
  var pinReady = false;

  async function createPinFlow() {
    var note = "Pick 4 numbers you will remember.";
    var bad = false;
    while (true) {
      var a = await collectPin("Create your PIN", note, bad);
      if (a === null) return false;
      var b = await collectPin("Confirm your PIN", "Type the same 4 numbers again.", false);
      if (b === null) return false;
      if (a === b) {
        await Wallet.setPin(SB.state.uid, a);
        pinReady = true;
        toast("PIN saved!");
        return true;
      }
      note = "Those didn't match. Try again.";
      bad = true;
    }
  }

  async function needPin() {
    if (!SB.state.profileLive) {
      toast("Still loading your account. One moment.");
      return false;
    }
    if (pinReady || (SB.state.profile && SB.state.profile.pinHash)) return true;
    return await createPinFlow();
  }

  // Ask for the PIN until it is right. Returns false if you close the sheet.
  async function pinGate(sub) {
    var wrong = false;
    while (true) {
      var pin = await collectPin("Enter 4-digit PIN", wrong ? "Wrong PIN. Try again." : sub, wrong);
      if (pin === null) return false;
      if (await Wallet.checkPin(SB.state.uid, pin)) return true;
      wrong = true;
    }
  }

  // Run one step at a time. Any error shows as a message.
  async function flow(fn) {
    if (funding || !SB.state.uid) return;
    funding = true;
    try {
      await fn();
    } catch (err) {
      holdBalance = false;
      closeSheet();
      toast(Wallet.friendlyError(err));
    } finally {
      funding = false;
    }
  }

  var afterDone = null;

  // Spinner for at least 3 seconds (with little steps), then green check + chime, then a Done button
  async function runBusy(workingText, task, successText, doneFn, steps) {
    holdBalance = true;
    afterDone = doneFn || null;
    var status = $("statusIcon");
    status.className = "status spin";
    $("busyText").textContent = workingText;
    $("doneBtn").classList.add("hidden");
    var stepList = steps || ["Checking everything…", workingText, "Almost there…"];
    $("busyStep").textContent = stepList[0];
    showView("vBusy");

    var began = Date.now();
    var ticker = setInterval(function () {
      var i = Math.min(stepList.length - 1, Math.floor((Date.now() - began) / (BUSY_MIN_MS / stepList.length)));
      $("busyStep").textContent = stepList[i];
    }, 250);

    try {
      await task();
      var wait = BUSY_MIN_MS - (Date.now() - began);
      if (wait > 0) await sleep(wait);
    } finally {
      clearInterval(ticker);
    }

    status.className = "status ok";
    $("busyText").textContent = successText;
    $("busyStep").textContent = "";
    $("doneBtn").classList.remove("hidden");
    chime();
  }

  $("doneBtn").addEventListener("click", function () {
    var fn = afterDone;
    afterDone = null;
    holdBalance = false;
    closeSheet();
    if (fn) fn();
    else animateBalance(latestBalance); // count to the new balance
  });

  SB.needPin = needPin; SB.pinGate = pinGate; SB.flow = flow; SB.runBusy = runBusy;

  // The card being used (cards.js decides which), or nothing
  function cardInfo() {
    var c = SB.activeCard ? SB.activeCard() : null;
    return c ? c : null;
  }

  // One helper for "is this card locked?" (manual freeze, or a daily card with unpaid days)
  SB.isCardLocked = function (card) {
    return SBRules.isCardLocked(card, SBRules.todayKey());
  };
  SB.isOwnerAccount = function () {
    return !!SB.state.feeOwner && SB.state.feeOwner === SB.state.uid;
  };
  SB.cleanId = function (text) { return String(text || "").replace(/\D/g, ""); };

  // Money a card has sent today, from the receipts on screen (receipts carry cardId)
  var loadedReceipts = [];
  SB.on("receipts", function (list) { loadedReceipts = list; SB.emit("spend"); });
  SB.spentToday = function (cardId) {
    var today = SBRules.todayKey();
    return loadedReceipts.reduce(function (sum, t) {
      if (t.cardId !== cardId || !(t.amount < 0) || t.type === "fee") return sum;
      return keyOfDate(dateOf(t)) === today ? sum + Math.abs(t.amount) : sum;
    }, 0);
  };
  // True if this payment fits under the card's daily limit (0 = no limit)
  function underLimit(card, amount) {
    if (!card || !card.limit) return true;
    if (SB.spentToday(card.id) + amount > card.limit + 0.001) {
      closeSheet();
      toast("That's over this card's daily limit of " + money(card.limit) + ".");
      return false;
    }
    return true;
  }

  // Checks the card rules. Returns { card } (card can be null) or null if something blocks you.
  function needCard() {
    var c = cardInfo();
    if (SB.features.requireCard) {
      if (!SB.state.profileLive || !SB.cards || !SB.cards.ready()) {
        toast("Still loading your account. One moment.");
        return null;
      }
      if (SB.cards.count() === 0) {
        toast("Make your first card first.");
        SB.cards.openNew(true);
        return null;
      }
      if (!c) {
        toast("Pick a card to use first.");
        return null;
      }
    }
    if (c && SB.isCardLocked(c)) {
      if (c.frozen) toast("Your card " + c.name + " is frozen. Unfreeze it first.");
      else toast("Your card " + c.name + " is locked: " + SBRules.lockReason(c, SBRules.todayKey()) + ". Pay it first.");
      return null;
    }
    return { card: c ? { id: c.id, name: c.name, last4: c.last4, limit: c.limit || 0, lockTo: c.lockTo || null } : null };
  }
  SB.needCard = needCard;

  // ---------- Owner: the only person who can add money ----------
  SB.state.owner = null;
  SB.state.ownerLoaded = false;
  var fundPwResolve = null;

  function askFundPassword() {
    return new Promise(function (resolve) {
      $("fundPwInput").value = "";
      $("fundPwError").textContent = "";
      $("fundPwBtn").disabled = false;
      fundPwResolve = resolve;
      showView("vFundPw");
      $("fundPwInput").focus({ preventScroll: true });
    });
  }

  async function submitFundPassword() {
    var pw = $("fundPwInput").value;
    if (!pw) { $("fundPwError").textContent = "Type the funding password."; return; }
    $("fundPwBtn").disabled = true;
    $("fundPwError").textContent = "";
    var ok = false;
    try {
      ok = await Wallet.checkFundPassword(pw);
    } catch (e) {
      $("fundPwError").textContent = Wallet.friendlyError(e);
      $("fundPwBtn").disabled = false;
      return;
    }
    if (!fundPwResolve) return;
    if (ok) {
      $("fundPwInput").blur();
      var r = fundPwResolve;
      fundPwResolve = null;
      r(true);
    } else {
      $("fundPwError").textContent = "That funding password isn't right.";
      $("fundPwBtn").disabled = false;
      var box = $("fundPwInput");
      box.classList.remove("bad");
      void box.offsetWidth;
      box.classList.add("bad");
    }
  }
  $("fundPwBtn").addEventListener("click", submitFundPassword);
  $("fundPwInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); submitFundPassword(); }
  });
  $("fundPwInput").addEventListener("input", function () { $("fundPwInput").classList.remove("bad"); $("fundPwError").textContent = ""; });

  // ---------- Fund ----------
  function startFund() {
    var owner = SB.features.owner;
    if (owner) {
      // Only the owner can add money
      if (!SB.state.ownerLoaded) { toast("Still loading… one moment."); return; }
      if (!SB.state.owner) { toast("Adding money isn't set up yet. The owner needs to set the funding password."); return; }
      if (SB.state.owner.uid !== SB.state.uid) { toast("Only the SB Wallet owner can add money."); return; }
    }
    var gate = needCard();
    if (!gate) return;
    var card = gate.card;

    flow(async function () {
      if (!owner && !(await needPin())) return;

      var amount = await askAmount({
        title: "Add money",
        sub: "Fake money. Up to " + money(MAX_FUND) + " each time.",
        max: MAX_FUND,
        over: "The most you can add is " + money(MAX_FUND) + ".",
        button: owner ? "Continue" : "Confirm Funding"
      });
      if (amount === null) return;

      if (owner) {
        if (!(await askFundPassword())) return;
      } else if (!(await pinGate("Adding " + money(amount)))) {
        return;
      }

      await runBusy("Adding money…", function () { return Wallet.fund(SB.state.uid, amount, card); }, money(amount) + " added!", null,
        [owner ? "Checking the owner password…" : "Checking your PIN…", "Adding money…", "Almost there…"]);
    });
  }

  // ---------- Send ----------
  var foundPerson = null;

  // opts: { title, sub, button }
  function askPerson(prefill, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      foundPerson = null;
      $("searchTitle").textContent = opts.title || "Send money";
      $("searchSub").textContent = opts.sub || "Type the 8-digit ID number of someone with an SB Wallet account.";
      $("findBtn").dataset.next = opts.button || "Continue";
      $("userInput").value = prefill || "";
      $("searchError").textContent = "";
      $("foundCard").classList.add("hidden");
      $("findBtn").textContent = "Find";
      $("findBtn").disabled = false;
      personResolve = resolve;
      updateSaveBtn();
      showView("vSearch");
      if (prefill) findPerson(true);
      else $("userInput").focus({ preventScroll: true });
    });
  }
  SB.askPerson = askPerson;

  // ---------- Contacts: people you chose to save (users/{uid}/contacts) ----------
  var contacts = [];
  var contactIds = {};
  var stopContacts = null;

  function contactFromPerson(p) {
    return { uid: p.uid, firstName: p.firstName || "", lastName: p.lastName || "", accountId: p.accountId || "" };
  }
  function isSaved(uid) { return !!contactIds[uid]; }

  function saveContactFor(p) {
    if (!SB.state.uid || !p || isSaved(p.uid)) return;
    Wallet.saveContact(SB.state.uid, contactFromPerson(p)).then(function () {
      toast(p.firstName + " is in your contacts");
    }, function (e) { toast(Wallet.friendlyError(e)); });
  }

  function removeContact(c) {
    Wallet.removeContact(SB.state.uid, c.uid).then(function () {
      toast("Removed from your contacts");
    }, function (e) { toast(Wallet.friendlyError(e)); });
  }

  // Tapping a contact fills the ID box and goes on as if the ID had been typed
  function useContact(c) {
    if (!personResolve) return;
    $("userInput").value = c.accountId;
    findPerson(true);
  }

  function renderContacts() {
    var box = $("contactList");
    box.innerHTML = "";
    contacts.forEach(function (c) {
      var row = document.createElement("div");
      row.className = "contact-row";

      var go = document.createElement("button");
      go.type = "button";
      go.className = "contact-go";
      var av = document.createElement("span");
      av.className = "q-av sm " + colorClass(c.firstName);
      av.textContent = (c.firstName || "?").charAt(0).toUpperCase();
      var info = document.createElement("span");
      info.className = "contact-info";
      var nm = document.createElement("span");
      nm.className = "contact-name";
      nm.textContent = fullName(c);
      var idTxt = document.createElement("span");
      idTxt.className = "contact-id";
      idTxt.textContent = prettyId(c.accountId);
      info.appendChild(nm);
      info.appendChild(idTxt);
      go.appendChild(av);
      go.appendChild(info);
      go.addEventListener("click", function () { useContact(c); });

      var rm = document.createElement("button");
      rm.type = "button";
      rm.className = "contact-rm";
      rm.textContent = "Remove";
      rm.setAttribute("aria-label", "Remove " + fullName(c) + " from your contacts");
      rm.addEventListener("click", function () { removeContact(c); });

      row.appendChild(go);
      row.appendChild(rm);
      box.appendChild(row);
    });
    $("contactEmpty").classList.toggle("hidden", contacts.length > 0);
  }

  // The Save contact button under a person found in the Send or Request sheet
  function updateSaveBtn() {
    var btn = $("saveContactBtn");
    var show = !!foundPerson && !!personResolve;
    btn.classList.toggle("hidden", !show);
    var saved = show && isSaved(foundPerson.uid);
    btn.textContent = saved ? "In your contacts ✓" : "Save contact";
    btn.disabled = saved;
  }

  // The Save contact button on a receipt, when the other person is known
  function updateRcSave() {
    var t = openTxn;
    var btn = $("rcSaveBtn");
    var can = !!(t && t.counterpartUid && t.counterpartUid !== SB.state.uid);
    btn.classList.toggle("hidden", !can);
    if (!can) return;
    var saved = isSaved(t.counterpartUid);
    btn.textContent = saved ? "In your contacts ✓" : "Save contact";
    btn.disabled = saved;
  }

  $("saveContactBtn").addEventListener("click", function () {
    if (foundPerson) saveContactFor(foundPerson);
  });
  $("rcSaveBtn").addEventListener("click", function () {
    var t = openTxn;
    if (!t || !t.counterpartUid) return;
    var parts = (t.counterpartName || "").trim().split(" ");
    saveContactFor({
      uid: t.counterpartUid,
      firstName: parts[0] || "Someone",
      lastName: parts.slice(1).join(" "),
      accountId: t.counterpartAccountId || ""
    });
  });

  function startContactsWatch(user) {
    contacts = [];
    contactIds = {};
    stopContacts = Wallet.watchContacts(user.uid, function (list) {
      contacts = list.slice().sort(function (a, b) { return fullName(a).localeCompare(fullName(b)); });
      contactIds = {};
      contacts.forEach(function (c) { contactIds[c.uid] = true; });
      renderContacts();
      updateSaveBtn();
      updateRcSave();
    });
  }

  function stopContactsWatch() {
    if (stopContacts) { stopContacts(); stopContacts = null; }
    contacts = [];
    contactIds = {};
    renderContacts();
  }

  async function findPerson(autoContinue) {
    var text = $("userInput").value.trim();
    var err = $("searchError");
    err.textContent = "";
    $("foundCard").classList.add("hidden");

    if (!text) { err.textContent = "Type an ID number first."; return; }
    if (text.replace(/\D/g, "").length !== 8) { err.textContent = "ID numbers have 8 digits, like 4821 3907."; return; }

    $("findBtn").disabled = true;
    $("findBtn").textContent = "Looking…";
    try {
      var person = await Wallet.findUser(text);
      if (!personResolve) return; // sheet was closed
      if (!person) {
        err.textContent = "No SB Wallet account has that ID number.";
      } else if (person.uid === SB.state.uid) {
        err.textContent = "That's your own ID number! Type someone else's.";
      } else {
        foundPerson = person;
        $("foundAv").textContent = person.firstName.charAt(0).toUpperCase();
        $("foundAv").className = "q-av sm " + colorClass(person.firstName);
        $("foundName").textContent = fullName(person);
        $("foundUser").textContent = prettyId(person.accountId);
        $("foundCard").classList.remove("hidden");
        $("findBtn").textContent = $("findBtn").dataset.next || "Continue";
        $("findBtn").disabled = false;
        updateSaveBtn();
        if (autoContinue) pickPerson();
        return;
      }
    } catch (e) {
      err.textContent = Wallet.friendlyError(e);
    }
    $("findBtn").textContent = "Find";
    $("findBtn").disabled = false;
  }

  function pickPerson() {
    if (!foundPerson || !personResolve) return;
    $("userInput").blur();
    var r = personResolve;
    personResolve = null;
    r(foundPerson);
  }

  $("findBtn").addEventListener("click", function () {
    if (foundPerson) pickPerson();
    else findPerson(false);
  });
  $("userInput").addEventListener("input", function () {
    foundPerson = null;
    $("foundCard").classList.add("hidden");
    $("searchError").textContent = "";
    $("findBtn").textContent = "Find";
    $("findBtn").disabled = false;
    updateSaveBtn();
  });
  $("userInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); $("findBtn").click(); }
  });

  function startSend(prefill) {
    var gate = needCard();
    if (!gate) return;
    var card = gate.card;
    flow(async function () {
      if (!(await needPin())) return;

      var person = await askPerson(prefill, { title: "Send money", button: "Continue" });
      if (!person) return;
      if (card && card.lockTo && person.accountId !== card.lockTo) {
        closeSheet();
        toast(card.name + " can only pay ID " + prettyId(card.lockTo) + ".");
        return;
      }

      var balance = latestBalance;
      var amount = await askAmount({
        title: "Send money",
        sub: "Your balance: " + money(balance),
        max: balance,
        balance: balance,
        fee: true,
        button: "Send Money",
        who: person
      });
      if (amount === null) return;

      var fee = feeFor(amount);
      if (!underLimit(card, amount)) return;
      if (!(await pinGate("Sending " + money(amount) + " + " + money(fee) + " fee"))) return;

      await runBusy(
        "Sending…",
        function () { return Wallet.sendMoney(SB.state.uid, person.uid, amount, fee, card, SB.state.feeOwner); },
        money(amount) + " sent to " + person.firstName + "!",
        null,
        ["Checking " + person.firstName + "'s account…", "Sending " + money(amount) + "…", "Almost there…"]
      );
    });
  }

  // ---------- Money requests (ask someone to pay you) ----------
  var requests = [];
  var stopRequests = null;
  var seenRequests = {};
  var requestsBaseline = false;

  function firstOf(name) { return (name || "").split(" ")[0] || "Someone"; }
  function meRef() {
    var p = SB.state.profile;
    return { uid: SB.state.uid, name: fullName(p), accountId: p.accountId || "" };
  }
  function personRef(p) {
    return { uid: p.uid, name: fullName(p), accountId: p.accountId || "" };
  }
  function requestTime(r) {
    return r.createdAt && r.createdAt.toDate ? r.createdAt.toDate().getTime() : Date.now();
  }
  function statusWord(r) {
    var words = { pending: "Waiting", paid: "Paid", declined: "Declined", cancelled: "Cancelled" };
    return words[r.status] || "";
  }
  function reqButton(text, cls, onTap) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = text;
    b.addEventListener("click", onTap);
    return b;
  }

  function requestRow(r) {
    var mine = r.from.uid === SB.state.uid; // true when you are the one asking
    var other = mine ? r.to : r.from;
    var name = firstOf(other.name);

    var row = document.createElement("div");
    row.className = "req-row";
    var av = document.createElement("div");
    av.className = "q-av sm " + colorClass(name);
    av.textContent = name.charAt(0).toUpperCase();
    var info = document.createElement("div");
    info.className = "req-info";
    var title = document.createElement("p");
    title.className = "req-title";
    title.textContent = mine ? "You asked " + name + " for " + money(r.amount) : name + " asks you for " + money(r.amount);
    var sub = document.createElement("p");
    sub.className = "req-sub";
    sub.textContent = statusWord(r) + (r.note ? " · " + r.note : "");
    info.appendChild(title);
    info.appendChild(sub);
    row.appendChild(av);
    row.appendChild(info);

    if (r.status === "pending") {
      var btns = document.createElement("div");
      btns.className = "req-btns";
      if (mine) {
        btns.appendChild(reqButton("Cancel", "req-no", function () { setRequestState(r, "cancelled"); }));
      } else {
        btns.appendChild(reqButton("Pay", "req-pay", function () { payRequest(r); }));
        btns.appendChild(reqButton("Decline", "req-no", function () { setRequestState(r, "declined"); }));
      }
      row.appendChild(btns);
    }
    return row;
  }

  function renderRequests() {
    var box = $("reqList");
    box.innerHTML = "";
    var list = requests.slice().sort(function (a, b) {
      var pa = a.status === "pending" ? 0 : 1;
      var pb = b.status === "pending" ? 0 : 1;
      return (pa - pb) || (requestTime(b) - requestTime(a));
    });
    list.slice(0, 30).forEach(function (r) { box.appendChild(requestRow(r)); });
    $("reqEmpty").classList.toggle("hidden", list.length > 0);
  }

  function setRequestState(r, status) {
    Wallet.setRequestStatus(r.id, status).then(function () {
      toast(status === "declined" ? "Request declined" : "Request cancelled");
    }, function (e) { toast(Wallet.friendlyError(e)); });
  }

  // Ask someone for money
  function startRequest() {
    flow(async function () {
      if (!SB.state.profileLive) { toast("Still loading your account. One moment."); return; }
      var person = await askPerson("", {
        title: "Request money",
        sub: "Type the 8-digit ID number of the person who should pay you.",
        button: "Continue"
      });
      if (!person) return;
      var amount = await askAmount({
        title: "Request money",
        sub: "Ask " + firstOf(fullName(person)) + " for up to " + money(MAX_FUND) + ".",
        max: MAX_FUND,
        over: "The most you can ask for is " + money(MAX_FUND) + ".",
        button: "Send Request",
        who: person
      });
      if (amount === null) return;
      await Wallet.createRequest(meRef(), personRef(person), amount, "");
      closeSheet();
      toast("Request sent to " + firstOf(fullName(person)) + " ✓");
    });
  }

  // Pay a request you received (same steps as Send: card, PIN, fee)
  function payRequest(r) {
    var gate = needCard();
    if (!gate) return;
    var card = gate.card;
    var who = firstOf(r.from.name);
    flow(async function () {
      if (!(await needPin())) return;
      var fee = feeFor(r.amount);
      if (card && card.lockTo && r.from.accountId !== card.lockTo) {
        closeSheet();
        toast(card.name + " can only pay ID " + prettyId(card.lockTo) + ".");
        return;
      }
      if (!underLimit(card, r.amount)) return;
      if (!(await pinGate("Paying " + money(r.amount) + " + " + money(fee) + " fee to " + who))) return;
      await runBusy(
        "Sending…",
        async function () {
          var ref = await Wallet.sendMoney(SB.state.uid, r.from.uid, r.amount, fee, card, SB.state.feeOwner);
          await Wallet.setRequestStatus(r.id, "paid", { paidRef: ref });
        },
        money(r.amount) + " sent to " + who + "!",
        null,
        ["Checking " + who + "'s account…", "Sending " + money(r.amount) + "…", "Almost there…"]
      );
    });
  }

  function startRequestsWatch(user) {
    requests = [];
    seenRequests = {};
    requestsBaseline = false;
    renderRequests();
    stopRequests = Wallet.watchRequests(user.uid, function (list) {
      requests = list;
      renderRequests();
      list.forEach(function (r) {
        if (seenRequests[r.id]) return;
        seenRequests[r.id] = true;
        if (requestsBaseline && r.to.uid === SB.state.uid && r.status === "pending") {
          notify({
            title: firstOf(r.from.name) + " asked for money",
            body: money(r.amount) + (r.note ? " · " + r.note : ""),
            icon: "?",
            onTap: function () { switchTab("home"); }
          });
        }
      });
      requestsBaseline = true;
    });
  }

  $("requestTile").addEventListener("click", startRequest);

  // ---------- Receipt ----------
  var openTxn = null;

  function openReceipt(t) {
    if (funding) return;
    openTxn = t;
    var neg = t.amount < 0;
    $("rcIc").textContent = neg ? "↗" : t.type === "receive" ? "↙" : "+";
    $("rcIc").classList.toggle("neg", neg);
    $("rcAmt").textContent = (neg ? "-" : "+") + money(Math.abs(t.amount));
    $("rcTitle").textContent = t.title || "Transaction";
    $("rcDate").textContent = dateOf(t).toLocaleString("en-US", {
      month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"
    });
    $("rcRef").textContent = refOf(t);
    $("rcPaid").textContent = paidWith(t);
    $("rcCardRow").classList.toggle("hidden", !t.cardName);
    if (t.cardName) $("rcCard").textContent = t.cardName + " •• " + t.cardLast4;
    $("rcReportBtn").classList.toggle("hidden", !t.id);
    var hasFee = t.type === "send" && t.fee > 0;
    $("rcSentRow").classList.toggle("hidden", !hasFee);
    $("rcFeeRow").classList.toggle("hidden", !hasFee);
    if (hasFee) {
      $("rcSent").textContent = money(t.sent);
      $("rcFee").textContent = money(t.fee);
    }

    var hasPerson = !!t.counterpartUid;
    $("rcPersonRow").classList.toggle("hidden", !hasPerson);
    $("rcMsgBtn").classList.toggle("hidden", !hasPerson);
    updateRcSave();
    if (hasPerson) {
      $("rcPersonLabel").textContent = neg ? "To" : "From";
      $("rcPerson").textContent = (t.counterpartName || "") + (t.counterpartAccountId ? " (ID " + prettyId(t.counterpartAccountId) + ")" : "");
    }
    $("rcDelBtn")._reset();
    showView("vReceipt");
  }

  twoStep($("rcDelBtn"), "Tap again to delete", function () {
    var t = openTxn;
    if (!t) return;
    closeSheet();
    Wallet.deleteTransactions(SB.state.uid, [t.id]).then(
      function () { toast("Receipt deleted"); },
      function (e) { toast(Wallet.friendlyError(e)); }
    );
  });

  $("rcMsgBtn").addEventListener("click", function () {
    var t = openTxn;
    if (!t || !t.counterpartUid || !SB.chat) return;
    closeSheet();
    setTimeout(function () { SB.chat.openWith(t.counterpartUid); }, 280);
  });

  // Report a receipt you don't recognize (writes to the disputes collection)
  $("rcReportBtn").addEventListener("click", function () {
    if (!openTxn) return;
    $("reportNote").value = "";
    $("reportError").textContent = "";
    showView("vReport");
    $("reportNote").focus({ preventScroll: true });
  });
  $("reportSend").addEventListener("click", function () {
    var t = openTxn;
    var note = $("reportNote").value.trim();
    if (!t) return;
    if (!note) { $("reportError").textContent = "Tell us what looks wrong."; return; }
    $("reportSend").disabled = true;
    Wallet.createDispute(SB.state.uid, t.id, note).then(function () {
      $("reportSend").disabled = false;
      closeSheet();
      toast("Thanks. We've got your report.");
    }, function (e) {
      $("reportSend").disabled = false;
      $("reportError").textContent = Wallet.friendlyError(e);
    });
  });

  // Used by screens.js (History cards, Scan)
  SB.openReceipt = openReceipt;
  SB.startSend = function (prefill) { startSend(prefill); };

  // ---------- Buttons that start things ----------
  $("fundTile").addEventListener("click", startFund);
  $("sendTile").addEventListener("click", function () { startSend(); });
  $("homeFreezeAll").addEventListener("click", function () { $("freezeAllBtn").click(); });

  async function copyMyId() {
    var id = (SB.state.profile && SB.state.profile.accountId) || "";
    if (!id) { toast("Still loading. One moment."); return; }
    var ok = await copyText(id);
    toast(ok ? "ID number copied!" : "Couldn't copy. Read your ID number out to them.");
  }
  $("accCopy").addEventListener("click", copyMyId);
  SB.copyMyId = copyMyId;

  // ---------- Delete account ----------
  $("deleteAccBtn").addEventListener("click", function () {
    if (funding) return;
    $("delPassword").value = "";
    $("delError").textContent = "";
    $("delBtn").disabled = false;
    showView("vDelete");
  });

  $("delBtn").addEventListener("click", function () {
    var password = $("delPassword").value;
    if (!password) { $("delError").textContent = "Type your password."; return; }
    var user = SB.state.user;
    var uid = SB.state.uid;

    flow(async function () {
      $("delBtn").disabled = true;
      $("delError").textContent = "";
      try {
        await Wallet.checkPassword(user.email, password); // wrong password stops here, nothing deleted
      } catch (e) {
        $("delError").textContent = "That password isn't right.";
        $("delBtn").disabled = false;
        return;
      }
      $("delPassword").blur();

      if (SB.state.profileLive && (pinReady || (SB.state.profile && SB.state.profile.pinHash))) {
        if (!(await pinGate("Confirm deleting your account"))) return;
      }

      try {
        await runBusy("Deleting your account…", async function () {
          stopWatching();
          remember(false); // after this, the app opens on Sign up
          try {
            await Wallet.deleteAccount(uid);
          } catch (e3) {
            remember(true);
            throw e3;
          }
          try { localStorage.removeItem(cacheKey(uid)); } catch (e2) {}
        }, "Account deleted.", function () { setMode("signup"); });
      } catch (err) {
        startApp(user); // something failed, so bring the app back
        throw err;
      }
    });
  });


  // ---------- Owner tools ----------
  var accTaps = 0;
  var accTapTimer = null;
  $("accTitle").addEventListener("click", function () {
    accTaps++;
    clearTimeout(accTapTimer);
    accTapTimer = setTimeout(function () { accTaps = 0; }, 1500);
    if (accTaps >= 5) {
      accTaps = 0;
      try { localStorage.setItem("sbw_owner_ui", "1"); } catch (e) {}
      renderOwner();
      toast("Owner tools shown");
    }
  });

  function renderOwner() {
    if (!SB.features.owner) { $("ownerCard").classList.add("hidden"); return; }
    var owner = SB.state.owner;
    var mine = !!(owner && owner.uid === SB.state.uid);
    var revealed = false;
    try { revealed = !!localStorage.getItem("sbw_owner_ui"); } catch (e) {}
    var show = mine || (!owner && revealed && SB.state.ownerLoaded);
    $("ownerCard").classList.toggle("hidden", !show);
    if (!show) return;
    if (mine) {
      $("ownerStatus").textContent = "You are the owner. Only you can add money, and only with your funding password.";
      $("ownerBtn").textContent = "Change funding password";
    } else {
      $("ownerStatus").textContent = "No owner yet. The first person to set a funding password becomes the owner.";
      $("ownerBtn").textContent = "Set funding password";
    }
  }
  SB.on("owner", renderOwner);

  $("ownerBtn").addEventListener("click", function () {
    var mine = !!(SB.state.owner && SB.state.owner.uid === SB.state.uid);
    $("ownerTitle").textContent = mine ? "Change funding password" : "Set funding password";
    $("ownerOld").classList.toggle("hidden", !mine);
    ["ownerOld", "ownerPw1", "ownerPw2"].forEach(function (id) { $(id).value = ""; });
    $("ownerError").textContent = "";
    $("ownerSave").disabled = false;
    showView("vOwner");
  });

  $("ownerSave").addEventListener("click", async function () {
    var mine = !!(SB.state.owner && SB.state.owner.uid === SB.state.uid);
    var p1 = $("ownerPw1").value;
    var p2 = $("ownerPw2").value;
    var err = $("ownerError");
    err.textContent = "";
    if (mine && !$("ownerOld").value) { err.textContent = "Type your current funding password."; return; }
    if (p1.length < 10) { err.textContent = "Use at least 10 characters."; return; }
    if (!/[A-Za-z]/.test(p1) || !/[0-9]/.test(p1)) { err.textContent = "Use letters and numbers."; return; }
    if (p1 !== p2) { err.textContent = "The two passwords don't match."; return; }
    $("ownerSave").disabled = true;
    try {
      if (mine) await Wallet.changeFundPassword($("ownerOld").value, p1);
      else await Wallet.claimOwner(SB.state.uid, SB.state.user.email, p1);
      closeSheet();
      toast(mine ? "Funding password changed" : "You are now the owner");
    } catch (e) {
      err.textContent = Wallet.friendlyError(e);
      $("ownerSave").disabled = false;
    }
  });

  // ---------- Switch-dependent look ----------
  document.body.classList.toggle("no-charts", !SB.features.charts);

  // ---------- Small links that jump to tabs ----------
  $("viewAllTx").addEventListener("click", function () { switchTab("history"); });

  // ---------- The app ----------
  var stopOwner = null;
  var stopProfile = null;
  var stopTxns = null;

  function stopWatching() {
    if (stopProfile) { stopProfile(); stopProfile = null; }
    if (stopTxns) { stopTxns(); stopTxns = null; }
    if (stopOwner) { stopOwner(); stopOwner = null; }
    if (stopRequests) { stopRequests(); stopRequests = null; }
    stopContactsWatch();
    requests = [];
    renderRequests();
    SB.state.owner = null;
    SB.state.ownerLoaded = false;
    SB.emit("stop");
  }

  // Saved copy on this phone, so the screen is full right away
  function cacheKey(uid) { return "sbw_cache_" + uid; }
  function readCache(uid) {
    try { return JSON.parse(localStorage.getItem(cacheKey(uid)) || "null"); } catch (e) { return null; }
  }
  function writeCache(uid, patch) {
    try {
      var c = readCache(uid) || {};
      Object.keys(patch).forEach(function (k) { c[k] = patch[k]; });
      localStorage.setItem(cacheKey(uid), JSON.stringify(c));
    } catch (e) {}
  }

  function applyProfile(profile) {
    var full = fullName(profile);
    $("accName").textContent = full;
    $("accUser").textContent = prettyId(profile.accountId);
    latestBalance = profile.balance;
  }

  function startApp(user) {
    stopWatching();
    SB.state.user = user;
    SB.state.uid = user.uid;
    SB.state.profile = null;
    SB.state.profileLive = false;
    pinReady = false;
    holdBalance = false;
    shownBalance = 0;
    latestBalance = 0;
    notifs = [];
    updateBell();
    $("accEmail").textContent = user.email || "—";

    var cached = readCache(user.uid);
    txns = cached && cached.txns ? cached.txns : [];
    renderTxns();

    if (cached && cached.profile) {
      applyProfile(cached.profile);
      setBalanceNow(cached.profile.balance);
    } else {
      ["accName", "accUser"].forEach(function (id) { $(id).textContent = "…"; });
      $("balance").classList.add("loading-text");
      $("balance").textContent = "Loading…";
    }

    showOnly("app");
    switchTab("home");

    stopProfile = Wallet.watchProfile(user.uid, function (profile) {
      SB.state.profileLive = true;
      SB.state.profile = profile;
      applyProfile(profile);
      if (!profile.accountId) Wallet.ensureAccountId(user.uid).catch(function () {}); // gives older accounts an ID number
      writeCache(user.uid, {
        profile: { firstName: profile.firstName, lastName: profile.lastName || "", accountId: profile.accountId || "", balance: profile.balance }
      });
      $("balance").classList.remove("loading-text");
      if (!holdBalance && profile.balance !== shownBalance) animateBalance(profile.balance);
      SB.emit("profile", profile);
    });

    var seen = {};
    var baseline = false;
    stopTxns = Wallet.watchTransactions(user.uid, function (list) {
      txns = list;
      if (!baseline) {
        list.forEach(function (t) { seen[t.id] = true; });
        baseline = true;
      } else {
        list.forEach(function (t) {
          if (seen[t.id]) return;
          seen[t.id] = true;
          // Alerts for every money-in and money-out event (card payments included)
          if (t.type === "receive" || t.type === "fee") {
            notify({
              title: t.type === "fee" ? "Money in" : "Money received",
              body: "+" + money(t.amount) + (t.type === "fee" ? " · " + (t.title || "fee") : " from " + (t.counterpartName || "someone")),
              icon: "$",
              onTap: function () { switchTab("history"); }
            });
          } else if (t.type === "send" || t.type === "card") {
            notify({
              title: t.type === "card" ? "Card payment" : "Money sent",
              body: "-" + money(Math.abs(t.amount)) + " · " + (t.title || ""),
              icon: "↗",
              onTap: function () { switchTab("history"); }
            });
          }
        });
      }
      writeCache(user.uid, {
        txns: list.slice(0, 40).map(function (t) {
          return {
            id: t.id, type: t.type, title: t.title, amount: t.amount, ref: t.ref,
            counterpartName: t.counterpartName, counterpartUsername: t.counterpartUsername,
            cardName: t.cardName, cardLast4: t.cardLast4, createdMs: dateOf(t).getTime()
          };
        })
      });
      renderTxns();
      cleanOldReceipts(list);
    });

    stopOwner = Wallet.watchOwner(function (owner) {
      SB.state.owner = owner;
      SB.state.ownerLoaded = true;
      SB.emit("owner", owner);
    });

    startRequestsWatch(user);
    startContactsWatch(user);
    SB.state.feeOwner = null;
    Wallet.feeOwner().then(function (uid) {
      SB.state.feeOwner = uid;
      runSettle(true); // unpaid card days are counted as soon as we know the owner
    });

    SB.emit("start", user);
  }

  $("logoutBtn").addEventListener("click", async function () {
    stopWatching();
    clearForm();
    await Wallet.logOut();
  });

  // ---------- Card debt: settle unpaid days on open, on sign-in, and when the date changes ----------
  var settledDay = "";
  function runSettle(force) {
    if (!SB.state.uid || !SB.state.feeOwner) return;
    var day = SBRules.todayKey();
    if (!force && day === settledDay) return;
    settledDay = day;
    Wallet.settleCards(SB.state.uid, SB.state.feeOwner).catch(function () {});
  }

  // ---------- Face ID for card numbers (WebAuthn: register once, then unlock) ----------
  var FACE_KEY = "sbw_face_on";
  var CRED_KEY = "sbw_face_cred";
  function readLS(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function writeLS(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function toB64(buf) {
    var a = new Uint8Array(buf), s = "";
    for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s);
  }
  function fromB64(str) {
    var s = atob(str), a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }
  function randBytes(n) { var a = new Uint8Array(n); window.crypto.getRandomValues(a); return a; }

  SB.faceOn = function () { return readLS(FACE_KEY) === "1"; };
  // "ok" (passed), "no" (not matched or cancelled), "unavailable" (use the PIN instead)
  SB.verifyFace = async function () {
    try {
      var id = readLS(CRED_KEY);
      if (!window.PublicKeyCredential || !navigator.credentials || !id) return "unavailable";
      var got = await navigator.credentials.get({
        publicKey: { challenge: randBytes(32), allowCredentials: [{ type: "public-key", id: fromB64(id) }], userVerification: "required", timeout: 60000 }
      });
      return got ? "ok" : "no";
    } catch (e) {
      return e && e.name === "NotAllowedError" ? "no" : "unavailable";
    }
  };
  // Registers this device once. Returns true if it worked.
  async function enableFace() {
    try {
      if (!window.PublicKeyCredential || !navigator.credentials) return false;
      var made = await navigator.credentials.create({
        publicKey: {
          challenge: randBytes(32),
          rp: { name: "SB Wallet" },
          user: { id: new TextEncoder().encode(SB.state.uid).slice(0, 64), name: SB.state.user.email || "sb-wallet", displayName: "SB Wallet" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
          authenticatorSelection: { userVerification: "required" },
          timeout: 60000
        }
      });
      if (!made) return false;
      writeLS(CRED_KEY, toB64(made.rawId));
      writeLS(FACE_KEY, "1");
      return true;
    } catch (e) {
      return false;
    }
  }
  function renderFaceToggle() {
    var on = SB.faceOn();
    $("faceToggle").classList.toggle("on", on);
    $("faceToggle").setAttribute("aria-pressed", on ? "true" : "false");
  }
  $("faceToggle").addEventListener("click", async function () {
    if (SB.faceOn()) {
      writeLS(FACE_KEY, null);
      renderFaceToggle();
      toast("Card numbers use the PIN again");
      return;
    }
    if (!(await needPin())) return;
    if (!(await pinGate("Turn on Face ID for card numbers"))) return;
    var ok = await enableFace();
    renderFaceToggle();
    toast(ok ? "Face ID is on for card numbers" : "This device can't set up Face ID here. The PIN will be used.");
  });
  SB.on("start", renderFaceToggle);

  // ---------- Logo pictures + floating money ----------
  // Show your logo picture on the splash, cut the "SB" mark out of it for the login page,
  // and use it as the home screen icon.
  function setupLogo() {
    var assets = window.SB_ASSETS;
    if (!assets || !assets.splash) return; // no picture file: the simple drawn logo stays
    var img = $("splashLogo");
    img.onload = function () {
      img.hidden = false;
      $("splashFallback").style.display = "none";
      try {
        var W = img.naturalWidth, H = img.naturalHeight;
        // the mark is the top-middle part of the picture
        var sx = W * 0.2, sw = W * 0.6, sy = 0, sh = H * 0.75;
        var c = document.createElement("canvas");
        c.width = 260; c.height = Math.round(260 * sh / sw);
        c.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
        $("markImg").src = c.toDataURL("image/png");
        $("markImg").hidden = false;
        $("markFallback").style.display = "none";
        // the same mark in the brand row at the top of Home
        $("brandImg").src = $("markImg").src;
        $("brandImg").hidden = false;
        $("brandFallback").style.display = "none";

        // home screen icon: the mark on a dark background
        var ic = document.createElement("canvas");
        ic.width = 180; ic.height = 180;
        var g = ic.getContext("2d");
        var bg = g.createLinearGradient(0, 0, 180, 180);
        bg.addColorStop(0, "#0E2236"); bg.addColorStop(1, "#04080E");
        g.fillStyle = bg; g.fillRect(0, 0, 180, 180);
        var mw = 124, mh = Math.round(124 * sh / sw);
        g.drawImage(img, sx, sy, sw, sh, (180 - mw) / 2, (180 - mh) / 2, mw, mh);
        $("touchIcon").href = ic.toDataURL("image/png");
      } catch (e) {}
    };
    img.src = assets.splash;
  }

  // Little coins, bills and dollar signs that drift slowly in the background
  function moneyIcon(kind) {
    var NSV = "http://www.w3.org/2000/svg";
    var s = document.createElementNS(NSV, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "1.4");
    s.setAttribute("stroke-linecap", "round");
    var html;
    if (kind === "coin") {
      html = '<circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="12" r="6.6" opacity=".55"/><text x="12" y="16.2" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor" stroke="none" font-family="Futura, Avenir Next, sans-serif">$</text>';
    } else if (kind === "bill") {
      html = '<rect x="1.5" y="5.5" width="21" height="13" rx="2.4"/><circle cx="12" cy="12" r="3"/><path d="M5 9h.01M19 15h.01" stroke-width="2.2"/>';
    } else {
      html = '<text x="12" y="19" text-anchor="middle" font-size="22" font-weight="700" fill="currentColor" stroke="none" font-family="Futura, Avenir Next, sans-serif">$</text>';
    }
    s.innerHTML = html;
    return s;
  }

  function makeMoneyBg(box, cols, rows, faint) {
    var kinds = ["coin", "bill", "dollar", "coin", "dollar", "bill"];
    var colors = ["#35E8D2", "#5B9BFF", "#3DF0B0", "#7CC4FF"];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var d = document.createElement("div");
        d.className = "m";
        var size = 1.5 + Math.random() * 2.1;
        d.style.left = ((c + 0.15 + Math.random() * 0.7) / cols * 100) + "%";
        d.style.top = ((r + 0.15 + Math.random() * 0.7) / rows * 100) + "%";
        d.style.setProperty("--s", size.toFixed(2) + "rem");
        d.style.setProperty("--o", (faint ? 0.05 + Math.random() * 0.05 : 0.08 + Math.random() * 0.1).toFixed(2));
        d.style.setProperty("--c", colors[Math.floor(Math.random() * colors.length)]);
        d.style.setProperty("--d", (7 + Math.random() * 7).toFixed(1) + "s");
        d.style.setProperty("--delay", (-Math.random() * 6 + (faint ? 0 : 0.2 * (r + c) * 0.5)).toFixed(2) + "s");
        d.style.setProperty("--r0", (-10 + Math.random() * 8).toFixed(0) + "deg");
        d.style.setProperty("--r1", (2 + Math.random() * 10).toFixed(0) + "deg");
        d.appendChild(moneyIcon(kinds[(r * cols + c) % kinds.length]));
        box.appendChild(d);
      }
    }
  }
  makeMoneyBg($("splashMoney"), 4, 7, false);
  makeMoneyBg($("authMoney"), 4, 6, true);
  setupLogo();

  // Once a minute: drop receipts that are too old, and refresh the "5m / 2h" times
  setInterval(function () {
    if (!SB.state.uid) return;
    runSettle(false); // only does work when the date has changed
    renderTxns();
    cleanOldReceipts(txns);
    SB.emit("tick");
  }, 60000);

  // ---------- Start: splash, then login or home ----------
  var SPLASH_MS = 3300;        // how long the logo screen shows (in milliseconds)
  var splashStart = Date.now();
  var splashSkip = function () {};
  var splashDelay = new Promise(function (resolve) {
    var t = setTimeout(resolve, SPLASH_MS);
    // tap the screen to skip (after the first second)
    splashSkip = function () {
      if (Date.now() - splashStart > 1000) { clearTimeout(t); resolve(); }
    };
  });
  $("splash").addEventListener("click", function () { splashSkip(); });
  var firstCheck = true;

  Wallet.watchAuth(async function (user) {
    if (busy) return; // in the middle of signing up or logging in
    loaded = true;

    if (firstCheck) {
      await splashDelay;
      firstCheck = false;
      hideSplash();
    }

    if (user) {
      remember(true);
      startApp(user);
      Wallet.ensureProfile(user).catch(function () { /* will retry next time */ });
    } else {
      stopWatching();
      SB.state.uid = null;
      SB.state.user = null;
      clearForm();
      setMode(isReturning() ? "login" : "signup");
      showOnly("auth");
    }
  });
})();
