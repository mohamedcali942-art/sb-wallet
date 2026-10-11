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
  var RECEIPT_LIFETIME_HOURS = 24;   // receipts delete themselves after this many hours
  var LIFE_MS = RECEIPT_LIFETIME_HOURS * 3600 * 1000;
  $("lifeHours").textContent = RECEIPT_LIFETIME_HOURS;

  // ---------- Shared helpers (also used by cards.js and chat.js) ----------
  var SB = window.SB = { $: $, state: { uid: null, user: null, profile: null, profileLive: false } };
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

  SB.toast = toast; SB.money = money; SB.sleep = sleep; SB.fullName = fullName;
  SB.colorClass = colorClass; SB.copyText = copyText; SB.twoStep = twoStep; SB.timeAgo = timeAgo;

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
      $("balance").textContent = money(shownBalance);
      if (t < 1) balanceFrame = requestAnimationFrame(step);
      else shownBalance = to;
    }
    balanceFrame = requestAnimationFrame(step);
  }
  function setBalanceNow(n) {
    cancelAnimationFrame(balanceFrame);
    shownBalance = n;
    $("balance").classList.remove("loading-text");
    $("balance").textContent = money(n);
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
    $("showPw").textContent = "Show";
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
    $("showPw").textContent = show ? "Hide" : "Show";
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

  function quickItem(letter, label, dashed, onTap) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "q-item";
    var av = document.createElement("span");
    av.className = "q-av " + (dashed ? "dashed" : colorClass(letter));
    av.textContent = letter;
    var name = document.createElement("span");
    name.textContent = label;
    b.appendChild(av);
    b.appendChild(name);
    b.addEventListener("click", onTap);
    return b;
  }

  function renderQuick(list) {
    var row = $("quickRow");
    row.innerHTML = "";
    row.appendChild(quickItem("+", "Add New", true, function () { startSend(); }));
    var seen = {};
    var count = 0;
    list.forEach(function (t) {
      var u = t.counterpartUsername;
      if (t.type === "send" && u && !seen[u] && count < 5) {
        seen[u] = true;
        count++;
        var first = (t.counterpartName || u).split(" ")[0];
        row.appendChild(quickItem(first.charAt(0).toUpperCase(), first, false, function () { startSend(u); }));
      }
    });
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
      if (filter === "income") return t.amount > 0;
      if (filter === "expenses") return t.amount < 0;
      return true;
    });
    var box = $("txnList");
    box.innerHTML = "";
    shown.forEach(function (t) { box.appendChild(txnRow(t)); });
    $("txnEmpty").classList.toggle("hidden", shown.length > 0);

    var now = new Date();
    var spent = 0;
    list.forEach(function (t) {
      var d = dateOf(t);
      if (t.amount < 0 && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) spent += Math.abs(t.amount);
    });
    $("spentAmt").textContent = money(spent);

    renderQuick(list);
  }

  document.querySelectorAll(".pill").forEach(function (p) {
    p.addEventListener("click", function () {
      document.querySelectorAll(".pill").forEach(function (x) { x.classList.remove("active"); });
      p.classList.add("active");
      filter = p.textContent.trim().toLowerCase();
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

  var VIEWS = ["vSearch", "vAmount", "vPin", "vBusy", "vReceipt", "vCardNew", "vCard", "vNotifs", "vDelete"];
  var HIGH = ["vSearch", "vDelete", "vCardNew"]; // these have typing, so they sit high (keyboard won't cover them)

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
    $("sheetBack").classList.remove("hidden");
    SB.emit("view", name);
  }

  function cancelPending() {
    var a = amountResolve; amountResolve = null;
    var p = pinResolve; pinResolve = null;
    var q = personResolve; personResolve = null;
    if (a) a(null);
    if (p) p(null);
    if (q) q(null);
  }

  function closeSheet() {
    cancelPending();
    $("userInput").blur();
    $("delPassword").blur();
    var s = $("sheet");
    var token = sheetToken;
    s.classList.add("leaving");
    setTimeout(function () {
      if (token !== sheetToken) return; // a new sheet opened meanwhile
      s.classList.add("hidden");
      s.classList.remove("leaving");
      $("sheetBack").classList.add("hidden");
      unlockScroll();
      SB.emit("sheetClosed");
    }, 250);
  }
  SB.showView = showView; SB.closeSheet = closeSheet;

  $("sheetClose").addEventListener("click", closeSheet);
  $("rcClose").addEventListener("click", closeSheet);

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
    var over = v > amountMax;
    $("amountSub").textContent = over ? amountOverMsg : amountBaseSub;
    $("amountSub").classList.toggle("bad", over);
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
        $("whoUser").textContent = opts.who.username;
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
    if (amountResolve && v > 0 && v <= amountMax) {
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

  // Spinner, then green check + chime, then a Done button
  async function runBusy(workingText, task, successText, doneFn) {
    holdBalance = true;
    afterDone = doneFn || null;
    var status = $("statusIcon");
    status.className = "status spin";
    $("busyText").textContent = workingText;
    $("doneBtn").classList.add("hidden");
    showView("vBusy");

    var began = Date.now();
    await task();
    var wait = 1500 - (Date.now() - began);
    if (wait > 0) await sleep(wait);

    status.className = "status ok";
    $("busyText").textContent = successText;
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
    return c ? { name: c.name, last4: c.last4, frozen: !!c.frozen } : null;
  }
  function cardFrozenBlock() {
    var c = cardInfo();
    if (c && c.frozen) {
      toast("Your card " + c.name + " is frozen. Unfreeze it first.");
      return true;
    }
    return false;
  }

  // ---------- Fund ----------
  function startFund() {
    if (cardFrozenBlock()) return;
    flow(async function () {
      if (!(await needPin())) return;

      var amount = await askAmount({
        title: "Add money",
        sub: "Fake money. Up to " + money(MAX_FUND) + " each time.",
        max: MAX_FUND,
        over: "The most you can add is " + money(MAX_FUND) + ".",
        button: "Confirm Funding"
      });
      if (amount === null) return;

      if (!(await pinGate("Adding " + money(amount)))) return;

      var card = cardInfo();
      await runBusy("Adding money…", function () { return Wallet.fund(SB.state.uid, amount, card); }, money(amount) + " added!");
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
      $("searchSub").textContent = opts.sub || "Type the username of someone with an SB Wallet account.";
      $("findBtn").dataset.next = opts.button || "Continue";
      $("userInput").value = prefill || "";
      $("searchError").textContent = "";
      $("foundCard").classList.add("hidden");
      $("findBtn").textContent = "Find";
      $("findBtn").disabled = false;
      personResolve = resolve;
      showView("vSearch");
      if (prefill) findPerson(true);
      else $("userInput").focus({ preventScroll: true });
    });
  }
  SB.askPerson = askPerson;

  async function findPerson(autoContinue) {
    var text = $("userInput").value.trim();
    var err = $("searchError");
    err.textContent = "";
    $("foundCard").classList.add("hidden");

    if (!text) { err.textContent = "Type a username first."; return; }
    if (text.indexOf("#") === -1) { err.textContent = "Usernames have a # and numbers, like Sarah#4821."; return; }

    $("findBtn").disabled = true;
    $("findBtn").textContent = "Looking…";
    try {
      var person = await Wallet.findUser(text);
      if (!personResolve) return; // sheet was closed
      if (!person) {
        err.textContent = "No SB Wallet account has that username.";
      } else if (person.uid === SB.state.uid) {
        err.textContent = "That's you! Type someone else's username.";
      } else {
        foundPerson = person;
        $("foundAv").textContent = person.firstName.charAt(0).toUpperCase();
        $("foundAv").className = "q-av sm " + colorClass(person.firstName);
        $("foundName").textContent = fullName(person);
        $("foundUser").textContent = person.username;
        $("foundCard").classList.remove("hidden");
        $("findBtn").textContent = $("findBtn").dataset.next || "Continue";
        $("findBtn").disabled = false;
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
  });
  $("userInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); $("findBtn").click(); }
  });

  function startSend(prefill) {
    if (cardFrozenBlock()) return;
    flow(async function () {
      if (!(await needPin())) return;

      var person = await askPerson(prefill, { title: "Send money", button: "Continue" });
      if (!person) return;

      var balance = latestBalance;
      var amount = await askAmount({
        title: "Send money",
        sub: "Your balance: " + money(balance),
        max: balance,
        over: "You only have " + money(balance) + ".",
        button: "Send Money",
        who: person
      });
      if (amount === null) return;

      if (!(await pinGate("Sending " + money(amount) + " to " + person.firstName))) return;

      var card = cardInfo();
      await runBusy(
        "Sending…",
        function () { return Wallet.sendMoney(SB.state.uid, person.uid, amount, card); },
        money(amount) + " sent to " + person.firstName + "!"
      );
    });
  }

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

    var hasPerson = !!t.counterpartUsername;
    $("rcPersonRow").classList.toggle("hidden", !hasPerson);
    $("rcMsgBtn").classList.toggle("hidden", !hasPerson);
    if (hasPerson) {
      $("rcPersonLabel").textContent = neg ? "To" : "From";
      $("rcPerson").textContent = (t.counterpartName || "") + " (" + t.counterpartUsername + ")";
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
    if (!t || !t.counterpartUsername || !SB.chat) return;
    closeSheet();
    setTimeout(function () { SB.chat.openWith(t.counterpartUsername); }, 280);
  });

  // ---------- Buttons that start things ----------
  $("fundBtn").addEventListener("click", startFund);
  $("fundTile").addEventListener("click", startFund);
  $("sendTile").addEventListener("click", function () { startSend(); });
  $("sendBigTile").addEventListener("click", function () { startSend(); });
  $("searchBtn").addEventListener("click", function () { startSend(); });

  $("copyBtn").addEventListener("click", async function () {
    var ok = await copyText($("username").textContent);
    toast(ok ? "Username copied!" : "Couldn't copy. Tell your friend the username.");
  });

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

  // ---------- The app ----------
  var stopProfile = null;
  var stopTxns = null;

  function stopWatching() {
    if (stopProfile) { stopProfile(); stopProfile = null; }
    if (stopTxns) { stopTxns(); stopTxns = null; }
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
    $("helloName").textContent = profile.firstName;
    $("avatar").textContent = profile.firstName.charAt(0).toUpperCase();
    $("cardName").textContent = full;
    $("cardUser").textContent = profile.username;
    $("username").textContent = profile.username;
    $("accName").textContent = full;
    $("accUser").textContent = profile.username;
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
    $("greeting").textContent = greetingText();
    $("accEmail").textContent = user.email || "—";

    var cached = readCache(user.uid);
    txns = cached && cached.txns ? cached.txns : [];
    renderTxns();

    if (cached && cached.profile) {
      applyProfile(cached.profile);
      setBalanceNow(cached.profile.balance);
    } else {
      ["helloName", "cardName", "cardUser", "username", "accName", "accUser"].forEach(function (id) { $(id).textContent = "…"; });
      $("avatar").textContent = "…";
      $("balance").classList.add("loading-text");
      $("balance").textContent = "Loading…";
    }

    showOnly("app");
    switchTab("home");

    stopProfile = Wallet.watchProfile(user.uid, function (profile) {
      SB.state.profileLive = true;
      SB.state.profile = profile;
      applyProfile(profile);
      writeCache(user.uid, {
        profile: { firstName: profile.firstName, lastName: profile.lastName || "", username: profile.username, balance: profile.balance }
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
          if (t.type === "receive") {
            notify({
              title: "Money received",
              body: "+" + money(t.amount) + " from " + (t.counterpartName || "someone"),
              icon: "$",
              onTap: function () { switchTab("activity"); }
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

    SB.emit("start", user);
  }

  $("logoutBtn").addEventListener("click", async function () {
    stopWatching();
    clearForm();
    await Wallet.logOut();
  });

  // ---------- Start: splash, then login or home ----------
  var splashDelay = new Promise(function (resolve) { setTimeout(resolve, 1400); });
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
