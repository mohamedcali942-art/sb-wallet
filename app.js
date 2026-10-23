// app.js: all of SB Wallet's screens and buttons. Sign-in, Home (balance, cards, requests, messages,
// receipts), sending, asking for money, adding money, the card pages, messages, analytics, the
// account page and owner tools. Loads after wallet.js and before stocks.js, and sets up window.SB.

(function () {
  if (!window.Wallet) {
    var m = document.getElementById("splashMsg");
    if (m) m.textContent = "Couldn't reach the internet. Check your connection and reload.";
    return;
  }
  var Wallet = window.Wallet;
  var R = Wallet.rules;
  var MAX_CARDS = 5;

  function $(id) { return document.getElementById(id); }

  // ---------- Small helpers ----------
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function money(n) {
    var v = Math.abs(Number(n) || 0);
    var s = "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (Number(n) < 0 && v > 0 ? "-" : "") + s;
  }
  function fullName(p) { return (((p && p.firstName) || "") + " " + ((p && p.lastName) || "")).trim(); }
  function cleanId(text) { return String(text || "").replace(/\D/g, ""); }
  function prettyId(id) {
    var s = String(id || "");
    return s.length === 8 ? s.slice(0, 4) + " " + s.slice(4) : s;
  }
  function colorClass(name) {
    var code = String(name || "A").toUpperCase().charCodeAt(0) || 65;
    return "c" + ((code % 6) + 1);
  }
  function timeAgo(ms) {
    var m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return "now";
    if (m < 60) return m + "m";
    var h = Math.round(m / 60);
    if (h < 24) return h + "h";
    return Math.round(h / 24) + "d";
  }
  function today() { return R.todayKey(); }
  function isOwnerAccount() { return !!state.uid && state.feeOwner === state.uid; }
  // The fee on a payment: 1.5%, at least $0.25, at most $5. Free for the owner.
  function feeFor(amount) {
    if (!amount || amount <= 0) return 0;
    if (isOwnerAccount()) return 0;
    return round2(Math.min(5, Math.max(0.25, amount * 0.015)));
  }
  function me() {
    var p = state.profile || {};
    return { uid: state.uid, name: fullName(p), accountId: p.accountId || "" };
  }
  function lockScroll() { document.body.style.overflow = "hidden"; }
  function unlockScroll() { document.body.style.overflow = ""; }

  // ---------- Shared state and events ----------
  var state = {
    uid: null,
    email: "",
    profile: null,
    profileLive: false,
    feeOwner: null,
    receipts: [],
    contacts: []
  };
  var events = {};
  function on(name, fn) { (events[name] = events[name] || []).push(fn); }
  function emit(name, arg) {
    (events[name] || []).forEach(function (fn) {
      try { fn(arg); } catch (e) { console.error(name, e); }
    });
  }

  // Moves a sliding highlight onto a button. Returns false if the button isn't on screen yet.
  function placePill(pill, btn, animate) {
    if (!pill || !btn || !btn.offsetWidth) return false;
    if (!animate) pill.style.transition = "none";
    pill.style.width = btn.offsetWidth + "px";
    pill.style.transform = "translateX(" + btn.offsetLeft + "px)";
    if (!animate) {
      void pill.offsetWidth;
      pill.style.transition = "";
    }
    return true;
  }

  // ---------- Messages on the screen ----------
  var toastTimer = null;
  function toast(text) {
    var t = $("toast");
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }

  var bannerTimer = null;
  function hideBanner() { $("banner").classList.remove("show"); }
  // A notice that drops in at the top. onTap runs if it is pressed.
  function notify(opts) {
    $("bannerIc").textContent = opts.icon || "SB";
    $("bannerTitle").textContent = opts.title || "";
    $("bannerBody").textContent = opts.body || "";
    $("banner").onclick = function () {
      hideBanner();
      if (opts.onTap) opts.onTap();
    };
    $("banner").classList.add("show");
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hideBanner, 4500);
  }

  function chime() {
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) {}
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      var ta = el("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (err) {}
      ta.remove();
      return ok;
    }
  }

  // Runs an action and shows any error as a message
  function flow(fn) {
    Promise.resolve().then(fn).catch(function (e) {
      console.error(e);
      toast(Wallet.friendlyError(e));
    });
  }

  // A two-tap button: the first tap asks "Tap again", the second runs fn
  function twoStep(btn, armedText, fn) {
    var normal = btn.textContent;
    var timer = null;
    function reset() {
      clearTimeout(timer);
      btn.textContent = normal;
      btn.dataset.armed = "";
    }
    btn._reset = reset;
    btn.addEventListener("click", function () {
      if (btn.dataset.armed === "1") {
        reset();
        fn();
        return;
      }
      btn.dataset.armed = "1";
      btn.textContent = armedText;
      timer = setTimeout(reset, 3000);
    });
  }

  // ---------- Sheets (the panels that slide up) ----------
  // A question waiting for an answer (an amount or a PIN). Closing the sheet cancels it.
  var pending = null;
  var VIEWS = ["vStory", "vContacts", "vSearch", "vAmount", "vPin", "vFundPw", "vOwner", "vStock", "vBusy", "vReceipt",
    "vReport", "vCardNew", "vCards", "vCard", "vNotifs", "vDelete", "vTrade", "vHistory", "vAssets"];

  function showView(name) {
    VIEWS.forEach(function (v) {
      var n = $(v);
      if (n) n.classList.toggle("hidden", v !== name);
    });
    $("sheet").classList.toggle("full", name === "vStock" || name === "vTrade");
    $("sheet").classList.toggle("paypage", name === "vAmount" || name === "vPin" || name === "vReceipt" || name === "vContacts" || name === "vStory");
    // Showing something again while the sheet is sliding down: stop the slide
    clearTimeout(closeTimer);
    $("sheet").classList.remove("closing");
    $("sheet").classList.remove("hidden");
    $("sheetBack").classList.remove("hidden");
    lockScroll();
    emit("view", name);
  }

  // Closing slides the sheet down (Apple style) and hides it once the slide is done.
  var closeTimer = null;
  function closeSheet() {
    var p = pending;
    pending = null;
    payCtx = null;
    if (p) p.cancel();
    if (!$("vCard").classList.contains("hidden")) clearTimer();
    var sh = $("sheet");
    unlockScroll();
    if (!sh.classList.contains("hidden") && !sh.classList.contains("closing")) {
      sh.classList.add("closing");
      $("sheetBack").classList.add("hidden");
      clearTimeout(closeTimer);
      closeTimer = setTimeout(function () {
        sh.classList.add("hidden");
        sh.classList.remove("closing", "full", "paypage");
      }, 420);
    }
    emit("sheetClosed");
  }
  $("sheetClose").addEventListener("click", closeSheet);
  document.querySelectorAll(".pay-back").forEach(function (b) { b.addEventListener("click", closeSheet); });

  // The dimmed background takes touches. A tap outside a sheet closes it (nothing is paid until the PIN is entered).
  var tapStart = null;
  document.addEventListener("pointerdown", function (e) {
    tapStart = { x: e.clientX, y: e.clientY };
  }, true);
  document.addEventListener("pointerup", function (e) {
    var start = tapStart;
    tapStart = null;
    if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) return;
    var sh = $("sheet");
    if (sh.classList.contains("hidden") || sh.classList.contains("closing") || sh.classList.contains("full")) return;
    if (!$("vBusy").classList.contains("hidden")) return; // never close while a payment is working
    if (sh.contains(e.target)) return;
    closeSheet();
  }, true);
  $("sheetBack").addEventListener("click", closeSheet);

  // The payment details carried from the amount page to the PIN page
  var payCtx = null;

  // Asks for a dollar amount on the keypad. Resolves with the amount, or null if you close it.
  // opts: title, sub, button, fee (true = the fee is added and checked against balance),
  //       balance, limit (for amounts without a fee), who (a person to show at the top), note
  function askAmount(opts) {
    return new Promise(function (resolve) {
      var digits = "";
      var balance = Number(opts.balance) || 0;
      var limit = opts.limit || 5000;
      var confirm = $("confirmFund");

      $("amountTitle").textContent = opts.title || "Amount";
      $("amountSub").textContent = opts.sub || "";
      $("amountBal").textContent = "Your balance " + money(balance);
      var who = opts.who;
      $("amountWho").classList.toggle("hidden", !who);
      if (who) {
        $("whoAv").textContent = (who.firstName || "?").charAt(0).toUpperCase();
        $("whoAv").className = "q-av sm " + colorClass(who.firstName);
        $("whoName").textContent = fullName(who);
        $("whoUser").textContent = prettyId(who.accountId);
      }
      confirm.textContent = opts.button || "Confirm";

      function value() { return parseFloat(digits || "0") || 0; }

      function update() {
        var amt = round2(value());
        var fee = opts.fee ? feeFor(amt) : 0;
        var total = round2(amt + fee);
        var over = opts.fee ? total > balance : amt > limit;
        var line = "";
        if (over) {
          line = opts.fee ? "That's more than your balance with the fee." : "That's over the limit of " + money(limit) + ".";
        } else if (opts.fee && amt > 0) {
          line = "Fee " + money(fee) + ". Total " + money(total) + ".";
        } else if (!opts.fee) {
          line = opts.note || "";
        }
        $("amountText").textContent = money(amt);
        $("feeLine").textContent = line;
        $("feeLine").classList.toggle("bad", over);
        confirm.disabled = amt <= 0 || over;
      }

      var pad = $("padAmount");
      pad.innerHTML = "";
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"].forEach(function (k) {
        var b = el("button", "", k);
        b.type = "button";
        b.addEventListener("click", function () {
          if (k === "⌫") {
            digits = digits.slice(0, -1);
          } else if (k === ".") {
            if (digits.indexOf(".") === -1) digits = (digits || "0") + ".";
          } else {
            if (digits.indexOf(".") !== -1 && digits.split(".")[1].length >= 2) return;
            if (digits.length >= 7) return;
            digits = digits === "0" ? k : digits + k;
          }
          update();
        });
        pad.appendChild(b);
      });

      pending = { cancel: function () { resolve(null); } };
      confirm.onclick = function () {
        var amt = round2(value());
        if (confirm.disabled || amt <= 0) return;
        pending = null;
        var fee0 = opts.fee ? feeFor(amt) : 0;
        payCtx = { who: who ? fullName(who) : "", amt: amt, fee: fee0, total: round2(amt + fee0), bal: balance };
        resolve(amt);
      };
      update();
      showView("vAmount");
    });
  }

  // Shows the 4-digit keypad. Resolves with the 4 digits, or null if you close it.
  function enterPin(title, sub) {
    return new Promise(function (resolve) {
      var digits = "";
      $("pinTitle").textContent = title;
      $("pinSub").textContent = sub || "";
      var ctx = payCtx;
      payCtx = null;
      $("paySum").classList.toggle("hidden", !ctx);
      if (ctx) {
        $("psBal").textContent = money(ctx.bal);
        $("psTo").textContent = ctx.who || "-";
        $("psAmt").textContent = money(ctx.amt);
        $("psFee").textContent = money(ctx.fee);
        $("psTot").textContent = money(ctx.total);
      }

      function paint() {
        var dots = $("pinDots").children;
        for (var i = 0; i < dots.length; i++) dots[i].classList.toggle("on", i < digits.length);
      }

      var pad = $("padPin");
      pad.innerHTML = "";
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].forEach(function (k) {
        if (k === "") {
          pad.appendChild(el("span"));
          return;
        }
        var b = el("button", "", k);
        b.type = "button";
        b.addEventListener("click", function () {
          if (k === "⌫") {
            digits = digits.slice(0, -1);
          } else if (digits.length < 4) {
            digits += k;
          }
          paint();
          if (digits.length === 4) {
            var done = digits;
            pending = null;
            setTimeout(function () { resolve(done); }, 120);
          }
        });
        pad.appendChild(b);
      });

      paint();
      pending = { cancel: function () { resolve(null); } };
      showView("vPin");
    });
  }

  // Makes sure you have a PIN. If not, asks you to make one (twice).
  async function needPin() {
    if (!state.profile) return false;
    if (state.profile.pinHash) return true;
    var first = await enterPin("Make a 4-digit PIN", "You use this PIN to confirm payments.");
    if (!first) return false;
    var second = await enterPin("Type your PIN again", "");
    if (!second) return false;
    if (first !== second) {
      toast("Those PINs didn't match. Try again.");
      return needPin();
    }
    await Wallet.setPin(state.uid, first);
    toast("PIN saved");
    return true;
  }

  // Asks for your PIN before a payment. Returns true only if the PIN is right.
  async function pinGate(label) {
    if (!(await needPin())) return false;
    for (;;) {
      var pin = await enterPin("Enter your PIN", label || "");
      if (pin === null) return false;
      if (await Wallet.checkPin(state.uid, pin)) return true;
      toast("That PIN isn't right.");
    }
  }

  // Shows a "working" screen, then a "done" screen. Errors close it and show a message.
  // steps: short lines that change while it works.
  function runBusy(working, task, success, done, steps) {
    var list = steps || [];
    var i = 0;
    var icon = $("statusIcon");
    var btn = $("doneBtn");
    icon.className = "status spin";
    $("busyText").textContent = working || "Working…";
    $("busyStep").textContent = list[0] || "";
    btn.classList.add("hidden");
    showView("vBusy");
    var timer = setInterval(function () {
      if (list.length) {
        i = (i + 1) % list.length;
        $("busyStep").textContent = list[i];
      }
    }, 1100);
    return Promise.resolve().then(task).then(function () {
      clearInterval(timer);
      icon.className = "status done";
      $("busyText").textContent = success || "Done!";
      $("busyStep").textContent = "";
      btn.textContent = "Done";
      btn.classList.remove("hidden");
      btn.onclick = function () {
        closeSheet();
        if (done) done();
      };
      chime();
    }, function (e) {
      clearInterval(timer);
      closeSheet();
      toast(Wallet.friendlyError(e));
    });
  }

  // ---------- Tabs ----------
  function showTab(name) {
    document.querySelectorAll(".tab").forEach(function (s) {
      s.classList.toggle("active", s.id === "tab-" + name);
    });
    document.querySelectorAll(".tabbtn").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tab === name);
    });
    window.scrollTo(0, 0);
    if (name === "analytics") renderAnalytics();
    placeTabPill(true);
    emit("tab", name);
  }
  document.querySelectorAll(".tabbtn").forEach(function (b) {
    b.addEventListener("click", function () { showTab(b.dataset.tab); });
  });

  // The highlight behind the active tab slides from one tab to the next
  var tabbar = document.querySelector(".tabbar");
  var tabPill = el("span", "tabpill");
  tabbar.insertBefore(tabPill, tabbar.firstChild);
  var tabPillReady = false;
  function placeTabPill(animate) {
    var b = tabbar.querySelector(".tabbtn.active");
    if (placePill(tabPill, b, animate && tabPillReady)) tabPillReady = true;
  }
  window.addEventListener("resize", function () { placeTabPill(false); });

  // ---------- Sign up and log in ----------
  var mode = "signup";
  var signingUp = false;

  function setMode(m) {
    mode = m;
    $("tabSignup").classList.toggle("active", m === "signup");
    $("tabLogin").classList.toggle("active", m === "login");
    $("nameRow").classList.toggle("hidden", m !== "signup");
    $("password2").classList.toggle("hidden", m !== "signup");
    $("authTitle").textContent = m === "signup" ? "Welcome to SB Wallet" : "Welcome back";
    $("authSub").textContent = m === "signup" ? "Make your account to get started." : "Log in to see your wallet.";
    $("authBtn").textContent = m === "signup" ? "Create account" : "Log in";
    $("authError").textContent = "";
    checkAuthForm();
  }

  function checkAuthForm() {
    var email = $("email").value.trim();
    var pw = $("password").value;
    var ok = /^\S+@\S+\.\S+$/.test(email) && pw.length > 0;
    var hint = "";
    if (mode === "signup") {
      var pw2 = $("password2").value;
      ok = ok && $("firstName").value.trim().length > 0 && pw.length >= 8 && pw === pw2;
      if (pw.length > 0 && pw.length < 8) hint = "Password needs at least 8 characters.";
      else if (pw2.length > 0 && pw !== pw2) hint = "Those passwords don't match yet.";
    }
    $("authHint").textContent = hint;
    $("authBtn").disabled = !ok;
  }

  ["firstName", "lastName", "email", "password", "password2"].forEach(function (id) {
    $(id).addEventListener("input", checkAuthForm);
  });
  $("tabSignup").addEventListener("click", function () { setMode("signup"); });
  $("tabLogin").addEventListener("click", function () { setMode("login"); });
  $("showPw").addEventListener("click", function () {
    var p = $("password");
    var show = p.type === "password";
    p.type = show ? "text" : "password";
    $("showPw").setAttribute("aria-label", show ? "Hide password" : "Show password");
  });

  $("authForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    if ($("authBtn").disabled) return;
    var email = $("email").value.trim();
    var pw = $("password").value;
    $("authBtn").disabled = true;
    $("authError").textContent = "";
    try {
      if (mode === "signup") {
        signingUp = true;
        var user = await Wallet.signUp($("firstName").value.trim(), $("lastName").value.trim(), email, pw);
        signingUp = false;
        await startApp(user);
      } else {
        // The sign-in watcher at the bottom opens the app
        await Wallet.logIn(email, pw);
      }
    } catch (err) {
      signingUp = false;
      $("authError").textContent = Wallet.friendlyError(err);
    } finally {
      checkAuthForm();
    }
  });

  // ---------- Opening and closing the app ----------
  var unsubs = [];
  var ticker = null;
  var cards = [];
  var cardsReady = false;
  var requests = [];
  var chats = [];
  var chatBaseline = false;
  var prevUnread = {};
  var ownerExists = false;

  function showApp() {
    $("splash").classList.add("hidden");
    $("auth").classList.add("hidden");
    $("app").classList.remove("hidden");
    showTab("home");
  }

  async function startApp(user) {
    if (!user || state.uid === user.uid) return;
    state.uid = user.uid;
    state.email = user.email || "";
    state.profileLive = false;
    chatBaseline = false;
    prevUnread = {};
    try {
      await Wallet.ensureProfile(user);
      await Wallet.ensureAccountId(user.uid);
      state.feeOwner = await Wallet.feeOwner();
    } catch (e) {
      console.error(e);
      toast(Wallet.friendlyError(e));
    }

    unsubs.push(Wallet.watchProfile(user.uid, function (p) {
      state.profile = p;
      state.profileLive = true;
      renderAll();
      emit("profile", p);
    }));
    unsubs.push(Wallet.watchTransactions(user.uid, function (rows) {
      state.receipts = rows;
      renderReceipts();
      renderAnalytics();
      emit("receipts", rows);
    }));
    unsubs.push(Wallet.watchContacts(user.uid, function (list) {
      state.contacts = list;
      renderContacts();
    }));
    unsubs.push(Wallet.watchCards(user.uid, function (list) {
      cards = list;
      cardsReady = true;
      renderAll();
      autoPick();
    }));
    unsubs.push(Wallet.watchChats(user.uid, onChats));
    unsubs.push(Wallet.watchRequests(user.uid, function (list) {
      requests = list;
      renderRequests();
      renderBell();
    }));
    unsubs.push(Wallet.watchOwner(function (d) {
      ownerExists = !!d;
      renderOwnerCard();
    }));

    showApp();
    emit("start", { uid: user.uid, email: state.email });
    Wallet.settleCards(state.uid, state.feeOwner).catch(function (e) { console.error(e); });
    ticker = setInterval(function () {
      emit("tick");
      renderChats();
    }, 5000);
  }

  function stopApp() {
    unsubs.forEach(function (f) { try { f(); } catch (e) {} });
    unsubs = [];
    if (ticker) { clearInterval(ticker); ticker = null; }
    closeThread();
    emit("stop");
    closeSheet();
    clearTimer();
    state.uid = null;
    state.email = "";
    state.profile = null;
    state.profileLive = false;
    state.receipts = [];
    state.contacts = [];
    cards = [];
    cardsReady = false;
    requests = [];
    chats = [];
    current = null;
    ownerExists = false;
    $("app").classList.add("hidden");
    $("splash").classList.add("hidden");
    $("auth").classList.remove("hidden");
  }

  // The eye button hides money amounts. It's remembered on this device.
  var hideMoney = false;
  try { hideMoney = localStorage.getItem("sb_hide_money") === "1"; } catch (e) {}
  $("eyeBtn").addEventListener("click", function () {
    hideMoney = !hideMoney;
    try { localStorage.setItem("sb_hide_money", hideMoney ? "1" : "0"); } catch (e) {}
    renderProfile();
    emit("eye", hideMoney);
  });

  // ---------- Your balance and account ----------
  function renderAll() {
    renderProfile();
    renderHomeCards();
    renderSheetList();
    renderLockBanners();
    renderOwnerCard();
    renderRequests();
    renderChats();
    renderBell();
    renderAnalytics();
    refreshOpenCard();
  }

  function renderProfile() {
    var p = state.profile || {};
    $("balance").textContent = hideMoney ? "••••••" : money(p.balance || 0);
    var d = (p.stats && p.stats.d && p.stats.d[today()]) || {};
    $("todayPill").textContent = "In today: " + (hideMoney ? "••••" : money(d.in || 0));
    $("eyeBtn").classList.toggle("off", hideMoney);
    $("eyeBtn").setAttribute("aria-label", hideMoney ? "Show money" : "Hide money");
    $("accName").textContent = fullName(p) || "—";
    $("accUser").textContent = prettyId(p.accountId) || "—";
    $("accEmail").textContent = state.email || "—";
  }

  $("accCopy").addEventListener("click", async function () {
    var ok = await copyText(cleanId(state.profile && state.profile.accountId));
    toast(ok ? "ID number copied" : "Couldn't copy. Type it instead.");
  });

  $("logoutBtn").addEventListener("click", function () { Wallet.logOut(); });

  $("deleteAccBtn").addEventListener("click", function () {
    $("delPassword").value = "";
    $("delError").textContent = "";
    showView("vDelete");
  });

  $("delBtn").addEventListener("click", function () {
    var pw = $("delPassword").value;
    if (!pw) {
      $("delError").textContent = "Type your password.";
      return;
    }
    var btn = $("delBtn");
    btn.disabled = true;
    flow(async function () {
      try {
        await Wallet.checkPassword(state.email, pw);
        await Wallet.deleteAccount(state.uid);
      } finally {
        btn.disabled = false;
      }
      closeSheet();
      toast("Your account is gone.");
    });
  });

  // ---------- Receipts ----------
  var TYPE_WORD = {
    send: "Sent", receive: "Received", fee: "Fee", card: "Card", fund: "Added",
    stock_buy: "Bought", stock_sell: "Sold", stock_refund: "Refund"
  };
  var TYPE_CLASS = {
    send: "t-sent", stock_buy: "t-sent", receive: "t-recv", fund: "t-recv",
    stock_sell: "t-recv", stock_refund: "t-recv", fee: "t-fee", card: "t-card"
  };
  function dateOf(t) { return t.createdAt && t.createdAt.toDate ? t.createdAt.toDate() : new Date(); }

  // One receipt as a card: colored top, title, amount, and the total
  function receiptCard(t) {
    var kind = t.type || "send";
    var out = t.amount < 0;
    var d = dateOf(t);
    var card = el("button", "hcard");
    card.type = "button";

    var head = el("div", "hc-head " + (TYPE_CLASS[kind] || "t-sent"));
    head.appendChild(el("span", "", TYPE_WORD[kind] || "Payment"));
    head.appendChild(el("span", "hc-when",
      d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " · " +
      d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })));
    card.appendChild(head);

    var body = el("div", "hc-body");
    body.appendChild(el("p", "hc-title", t.title || "Transaction"));
    var chips = el("div", "hc-chips");
    chips.appendChild(el("span", "hc-chip", (out ? "-" : "+") + money(Math.abs(t.amount))));
    if (kind === "send" && t.fee > 0) chips.appendChild(el("span", "hc-chip soft", "Fee " + money(t.fee)));
    if (t.cardName) chips.appendChild(el("span", "hc-chip soft", t.cardName));
    body.appendChild(chips);
    card.appendChild(body);

    var foot = el("div", "hc-foot");
    var total = kind === "send" ? (t.sent || 0) + (t.fee || 0) : Math.abs(t.amount);
    foot.appendChild(el("span", "", out ? "Total out" : "Total in"));
    foot.appendChild(el("b", "", money(total)));
    card.appendChild(foot);

    card.addEventListener("click", function () { openReceipt(t); });
    return card;
  }

  var txnFilter = "all";
  function passesFilter(t) {
    var kind = t.type || "";
    if (txnFilter === "sent") return kind === "send";
    if (txnFilter === "received") return kind === "receive" || kind === "fund";
    if (txnFilter === "fees") return kind === "fee";
    return true;
  }

  function renderReceipts() {
    var rows = state.receipts || [];
    var home = $("homeTxns");
    home.innerHTML = "";
    if (!rows.length) home.appendChild(el("p", "muted", "Nothing yet. Your sent and received money will show up here."));
    rows.slice(0, 3).forEach(function (t) { home.appendChild(receiptCard(t)); });

    var list = $("txnList");
    list.innerHTML = "";
    var shown = rows.filter(passesFilter);
    shown.forEach(function (t) { list.appendChild(receiptCard(t)); });
    $("txnEmpty").classList.toggle("hidden", shown.length > 0);
  }

  document.querySelectorAll(".pill[data-filter]").forEach(function (b) {
    b.addEventListener("click", function () {
      txnFilter = b.dataset.filter;
      document.querySelectorAll(".pill[data-filter]").forEach(function (x) { x.classList.toggle("active", x === b); });
      renderReceipts();
    });
  });
  $("viewAllTx").addEventListener("click", function () { showView("vHistory"); });

  twoStep($("delAllBtn"), "Tap again to delete all", function () {
    flow(async function () {
      await Wallet.deleteAllTransactions(state.uid);
      toast("History cleared");
    });
  });

  // The receipt sheet
  var openedReceipt = null;
  var reportTarget = null;

  // The other person on a receipt, in the shape the message and contact code uses
  function personFromTx(t) {
    var parts = (t.counterpartName || "").split(" ");
    return {
      uid: t.counterpartUid,
      firstName: parts[0] || "",
      lastName: parts.slice(1).join(" "),
      accountId: t.counterpartAccountId || ""
    };
  }

  function openReceipt(t) {
    openedReceipt = t;
    var send = t.type === "send";
    var out = t.amount < 0;
    $("rcIc").textContent = out ? "−" : "+";
    $("rcAmt").textContent = (out ? "-" : "+") + money(Math.abs(t.amount));
    $("rcTitle").textContent = t.title || "Transaction";
    $("rcDate").textContent = dateOf(t).toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"
    });
    $("rcPersonRow").classList.toggle("hidden", !t.counterpartName);
    $("rcPersonLabel").textContent = send ? "To" : "From";
    $("rcPerson").textContent = t.counterpartName || "";
    $("rcSentRow").classList.toggle("hidden", !send);
    $("rcSent").textContent = money(t.sent || 0);
    $("rcFeeRow").classList.toggle("hidden", !(send && t.fee > 0));
    $("rcFee").textContent = money(t.fee || 0);
    $("rcCardRow").classList.toggle("hidden", !t.cardName);
    $("rcCard").textContent = t.cardName ? t.cardName + " •• " + (t.cardLast4 || "") : "";
    $("rcRef").textContent = t.ref || "—";
    var canTalk = !!t.counterpartUid && (t.type === "send" || t.type === "receive");
    $("rcMsgBtn").classList.toggle("hidden", !canTalk);
    $("rcSaveBtn").classList.toggle("hidden", !canTalk || isSaved(t.counterpartUid));
    showView("vReceipt");
  }

  $("rcClose").addEventListener("click", closeSheet);

  $("rcMsgBtn").addEventListener("click", function () {
    if (!openedReceipt || !openedReceipt.counterpartUid) return;
    var p = personFromTx(openedReceipt);
    closeSheet();
    openThread(p);
  });

  $("rcSaveBtn").addEventListener("click", function () {
    if (!openedReceipt || !openedReceipt.counterpartUid) return;
    var p = personFromTx(openedReceipt);
    Wallet.saveContact(state.uid, p).then(function () {
      toast(fullName(p) + " is saved");
      $("rcSaveBtn").classList.add("hidden");
    }, function (e) { toast(Wallet.friendlyError(e)); });
  });

  $("rcReportBtn").addEventListener("click", function () {
    reportTarget = openedReceipt;
    $("reportNote").value = "";
    $("reportError").textContent = "";
    showView("vReport");
  });
  $("reportSend").addEventListener("click", function () {
    var note = $("reportNote").value.trim();
    if (!note) {
      $("reportError").textContent = "Type what looks wrong.";
      return;
    }
    Wallet.createDispute(state.uid, reportTarget ? reportTarget.id : "", note).then(function () {
      closeSheet();
      toast("Thanks. We got your report.");
    }, function (e) {
      $("reportError").textContent = Wallet.friendlyError(e);
    });
  });

  twoStep($("rcDelBtn"), "Tap again to delete", function () {
    if (!openedReceipt) return;
    var id = openedReceipt.id;
    flow(async function () {
      await Wallet.deleteTransactions(state.uid, [id]);
      closeSheet();
      toast("Receipt deleted");
    });
  });

  // ---------- Contacts (people you saved) ----------
  function isSaved(uid) {
    return state.contacts.some(function (c) { return c.uid === uid; });
  }

  function renderContacts() {
    var box = $("contactList");
    box.innerHTML = "";
    state.contacts.slice(0, 3).forEach(function (c) {
      var b = el("button", "contact-row");
      b.type = "button";
      var av = el("div", "q-av sm " + colorClass(c.firstName), (c.firstName || "?").charAt(0).toUpperCase());
      var txt = el("div", "");
      txt.appendChild(el("p", "chat-name", fullName(c)));
      txt.appendChild(el("p", "muted small", prettyId(c.accountId)));
      b.appendChild(av);
      b.appendChild(txt);
      b.addEventListener("click", function () {
        $("userInput").value = c.accountId || "";
        showFound(c);
      });
      box.appendChild(b);
    });
    $("contactEmpty").classList.toggle("hidden", state.contacts.length > 0);
    renderContactsPage();
  }

  // ---------- The Contacts page: search, A-Z list, tap to send, remove ----------
  function renderContactsPage() {
    var box = $("ctList");
    if (!box) return;
    var q = ($("ctSearch").value || "").trim().toLowerCase();
    var digits = q.replace(/\D/g, "");
    var rows = state.contacts.slice().sort(function (a, b) {
      return fullName(a).localeCompare(fullName(b));
    }).filter(function (c) {
      if (!q) return true;
      return fullName(c).toLowerCase().indexOf(q) !== -1 ||
        (digits && String(c.accountId || "").indexOf(digits) !== -1);
    });
    box.innerHTML = "";
    var lastLetter = "";
    rows.forEach(function (c) {
      var letter = (fullName(c).charAt(0) || "#").toUpperCase();
      if (letter !== lastLetter) {
        lastLetter = letter;
        box.appendChild(el("p", "ct-letter", letter));
      }
      var row = el("div", "ct-row");
      var main = el("button", "ct-main");
      main.type = "button";
      main.appendChild(el("div", "q-av sm " + colorClass(c.firstName), (c.firstName || "?").charAt(0).toUpperCase()));
      var txt = el("div", "ct-text");
      txt.appendChild(el("p", "ct-name", fullName(c)));
      txt.appendChild(el("p", "ct-id", prettyId(c.accountId)));
      main.appendChild(txt);
      main.appendChild(el("span", "ct-send", "Send"));
      main.addEventListener("click", function () {
        showView("vSearch");
        $("userInput").value = c.accountId || "";
        showFound(c);
      });
      var rm = el("button", "ct-remove", "Remove");
      rm.type = "button";
      rm.addEventListener("click", async function () {
        try {
          await Wallet.removeContact(state.uid, c.uid);
          toast("Contact removed");
        } catch (e) {
          toast("Couldn't remove that. Try again.");
        }
      });
      row.appendChild(main);
      row.appendChild(rm);
      box.appendChild(row);
    });
    $("ctEmpty").classList.toggle("hidden", state.contacts.length > 0);
    $("ctCount").textContent = state.contacts.length ? String(state.contacts.length) : "";
  }
  $("ctSearch").addEventListener("input", renderContactsPage);
  $("ctAdd").addEventListener("click", function () { showView("vSearch"); });
  $("ctOpen").addEventListener("click", function () { renderContactsPage(); showView("vContacts"); });
  $("ctSeeAll").addEventListener("click", function () { renderContactsPage(); showView("vContacts"); });

  var found = null;
  // Which action the search is for: "send", "request" or "message"
  var searchMode = "send";

  function clearFound() {
    found = null;
    $("foundCard").classList.add("hidden");
    $("saveContactBtn").classList.add("hidden");
    $("findBtn").textContent = "Find";
  }

  function showFound(p) {
    found = p;
    $("foundAv").textContent = (p.firstName || "?").charAt(0).toUpperCase();
    $("foundAv").className = "q-av sm " + colorClass(p.firstName);
    $("foundName").textContent = fullName(p);
    $("foundUser").textContent = prettyId(p.accountId);
    $("foundCard").classList.remove("hidden");
    $("saveContactBtn").classList.toggle("hidden", isSaved(p.uid));
    $("findBtn").textContent = searchMode === "message" ? "Message" : "Next";
    $("searchError").textContent = "";
  }

  $("saveContactBtn").addEventListener("click", function () {
    if (!found) return;
    var p = found;
    Wallet.saveContact(state.uid, p).then(function () {
      toast(fullName(p) + " is saved");
      $("saveContactBtn").classList.add("hidden");
    }, function (e) {
      toast(Wallet.friendlyError(e));
    });
  });

  // Opens the search sheet for one action: "send", "request" or "message"
  function openSearch(mode) {
    if (!state.profileLive) {
      toast("Still loading your account. One moment.");
      return;
    }
    searchMode = mode;
    var titles = {
      send: ["Send money", "Type the 8-digit ID number of someone with an SB Wallet account."],
      request: ["Ask for money", "Type the 8-digit ID number of the person you want money from."],
      message: ["New message", "Type the 8-digit ID number of the person you want to message."]
    };
    $("searchTitle").textContent = titles[mode][0];
    $("searchSub").textContent = titles[mode][1];
    clearFound();
    $("userInput").value = "";
    $("searchError").textContent = "";
    renderContacts();
    showView("vSearch");
  }

  $("sendTile").addEventListener("click", function () { openSearch("send"); });
  $("requestTile").addEventListener("click", function () { openSearch("request"); });
  $("newMsgBtn").addEventListener("click", function () { openSearch("message"); });

  $("userInput").addEventListener("input", function () {
    if (found) clearFound();
  });

  $("findBtn").addEventListener("click", function () {
    if (found) {
      if (searchMode === "send") askSendAmount(found);
      else if (searchMode === "request") askRequestAmount(found);
      else {
        var p = found;
        closeSheet();
        openThread(p);
      }
      return;
    }
    var text = $("userInput").value;
    if (cleanId(text).length !== 8) {
      $("searchError").textContent = "Type the 8-digit ID number.";
      return;
    }
    var btn = $("findBtn");
    btn.disabled = true;
    Wallet.findUser(text).then(function (p) {
      if (!p) $("searchError").textContent = "No account has that ID number.";
      else if (p.uid === state.uid) $("searchError").textContent = "That's you!";
      else showFound(p);
    }, function (e) {
      $("searchError").textContent = Wallet.friendlyError(e);
    }).then(function () {
      btn.disabled = false;
    });
  });

  // ---------- Sending money ----------
  function askSendAmount(p) {
    var balance = (state.profile && state.profile.balance) || 0;
    askAmount({
      title: "Send to " + fullName(p),
      sub: "You pay the amount plus a fee of 1.5% (at least $0.25, at most $5).",
      balance: balance,
      fee: true,
      who: p,
      button: "Send"
    }).then(function (amount) {
      if (amount === null) return;
      var fee = feeFor(amount);
      flow(async function () {
        if (!(await pinGate("Sending " + money(amount) + " to " + fullName(p) + ", plus " + money(fee) + " fee"))) return;
        await runBusy("Sending…", function () {
          return Wallet.sendMoney(state.uid, p.uid, amount, fee, activeCard(), state.feeOwner);
        }, "Sent " + money(amount) + " to " + fullName(p) + "!", null,
        ["Checking your balance…", "Sending…", "Almost there…"]);
      });
    });
  }

  // ---------- Asking for money ----------
  function askRequestAmount(p) {
    askAmount({
      title: "Ask " + fullName(p) + " for money",
      sub: "They can pay or say no. No money moves until they pay.",
      limit: 5000,
      who: p,
      button: "Send request"
    }).then(function (amount) {
      if (amount === null) return;
      flow(async function () {
        await Wallet.createRequest(me(), { uid: p.uid, name: fullName(p), accountId: p.accountId || "" }, amount, "");
        closeSheet();
        toast("Request sent to " + fullName(p));
      });
    });
  }

  // The requests waiting for you (to pay) and the ones you sent (to cancel)
  function renderRequests() {
    var box = $("reqList");
    box.innerHTML = "";
    var open = requests.filter(function (r) { return r.status === "pending"; });
    open.forEach(function (r) {
      var incoming = r.to && r.to.uid === state.uid;
      var row = el("div", "chat-row");
      var info = el("div", "chat-info");
      var who = incoming ? (r.from && r.from.name) : (r.to && r.to.name);
      info.appendChild(el("p", "chat-name", incoming ? who + " asks you for " + money(r.amount) : "You asked " + who + " for " + money(r.amount)));
      info.appendChild(el("p", "chat-last", incoming ? "Pay it, or say no." : "Waiting for them."));
      row.appendChild(info);
      var side = el("div", "chat-side");
      if (incoming) {
        var pay = el("button", "chip on", "Pay");
        pay.type = "button";
        pay.addEventListener("click", function () { payRequest(r); });
        var no = el("button", "chip", "No");
        no.type = "button";
        no.addEventListener("click", function () { setRequest(r, "declined", "Request declined"); });
        side.appendChild(pay);
        side.appendChild(no);
      } else {
        var cancel = el("button", "chip", "Cancel");
        cancel.type = "button";
        cancel.addEventListener("click", function () { setRequest(r, "cancelled", "Request cancelled"); });
        side.appendChild(cancel);
      }
      row.appendChild(side);
      box.appendChild(row);
    });
    $("reqEmpty").classList.toggle("hidden", open.length > 0);
  }

  function setRequest(r, status, message) {
    flow(async function () {
      await Wallet.setRequestStatus(r.id, status);
      toast(message);
    });
  }

  function payRequest(r) {
    var amount = r.amount;
    var fee = feeFor(amount);
    flow(async function () {
      if (!(await pinGate("Paying " + money(amount) + " to " + r.from.name + ", plus " + money(fee) + " fee"))) return;
      await runBusy("Paying…", async function () {
        await Wallet.sendMoney(state.uid, r.from.uid, amount, fee, activeCard(), state.feeOwner);
        await Wallet.setRequestStatus(r.id, "paid");
      }, "Paid " + money(amount) + "!", null, ["Checking your balance…", "Paying…", "Almost there…"]);
    });
  }

  // ---------- Adding money (owner only: needs the funding password) ----------
  if ($("fundTile")) $("fundTile").addEventListener("click", function () {
    if (!state.profileLive) {
      toast("Still loading your account. One moment.");
      return;
    }
    $("fundPwInput").value = "";
    $("fundPwError").textContent = "";
    showView("vFundPw");
  });

  $("fundPwBtn").addEventListener("click", function () {
    var pw = $("fundPwInput").value;
    if (!pw) {
      $("fundPwError").textContent = "Type the funding password.";
      return;
    }
    var btn = $("fundPwBtn");
    btn.disabled = true;
    Wallet.checkFundPassword(pw).then(function (ok) {
      if (!ok) {
        $("fundPwError").textContent = "That funding password isn't right.";
        return;
      }
      askAmount({
        title: "Add money",
        sub: "Fake money. Up to $5,000 each time.",
        limit: 5000,
        button: "Confirm Funding"
      }).then(function (amount) {
        if (amount === null) return;
        flow(async function () {
          if (!(await pinGate("Adding " + money(amount)))) return;
          await runBusy("Adding money…", function () {
            return Wallet.fund(state.uid, amount, activeCard());
          }, money(amount) + " added!", null, ["Checking…", "Adding money…", "Almost there…"]);
        });
      });
    }, function (e) {
      $("fundPwError").textContent = Wallet.friendlyError(e);
    }).then(function () {
      btn.disabled = false;
    });
  });

  // ---------- Messages: the chat list and the conversation ----------
  function otherOf(chat) {
    var ou = (chat.members || []).filter(function (m) { return m !== state.uid; })[0];
    var full = (chat.names && chat.names[ou]) || "Someone";
    var parts = full.split(" ");
    return {
      uid: ou,
      firstName: parts[0],
      lastName: parts.slice(1).join(" "),
      accountId: (chat.accountIds && chat.accountIds[ou]) || ""
    };
  }
  function unreadOf(chat) { return (chat.unread && chat.unread[state.uid]) || 0; }
  function lastAtMs(chat) { return chat.lastAt && chat.lastAt.toDate ? chat.lastAt.toDate().getTime() : Date.now(); }

  function onChats(list) {
    chats = list;
    list.forEach(function (chat) {
      var unread = unreadOf(chat);
      var before = prevUnread[chat.id] || 0;
      prevUnread[chat.id] = unread;
      if (thread && thread.id === chat.id) {
        if (unread > 0) Wallet.markRead(state.uid, chat.id);
        return;
      }
      if (chatBaseline && unread > before) {
        var other = otherOf(chat);
        notify({
          title: fullName(other),
          body: chat.lastMessage || "New message",
          icon: "✉",
          onTap: function () { openThread(other); }
        });
      }
    });
    chatBaseline = true;
    renderChats();
    renderBell();
  }

  function renderChats() {
    var box = $("chatList");
    box.innerHTML = "";
    var sorted = chats.slice().sort(function (a, b) { return lastAtMs(b) - lastAtMs(a); });
    var total = 0;
    sorted.forEach(function (chat) {
      var other = otherOf(chat);
      var unread = unreadOf(chat);
      total += unread;
      var row = el("button", "chat-row");
      row.type = "button";
      row.appendChild(el("div", "q-av sm " + colorClass(other.firstName), (other.firstName || "?").charAt(0).toUpperCase()));
      var info = el("div", "chat-info");
      info.appendChild(el("p", "chat-name", fullName(other)));
      var mine = chat.lastFrom === state.uid;
      info.appendChild(el("p", "chat-last", (mine ? "You: " : "") + (chat.lastMessage || "")));
      row.appendChild(info);
      var side = el("div", "chat-side");
      side.appendChild(el("span", "", timeAgo(lastAtMs(chat))));
      if (unread > 0) side.appendChild(el("span", "unread-dot", String(unread)));
      row.appendChild(side);
      row.addEventListener("click", function () { openThread(other); });
      box.appendChild(row);
    });
    $("chatEmpty").classList.toggle("hidden", sorted.length > 0);
    $("msgBadge").textContent = total;
    $("msgBadge").classList.toggle("hidden", total === 0);
  }

  var thread = null;
  var threadStop = null;
  var msgNodes = {};
  var firstPaint = true;

  function timeText(m) {
    var d = m.createdAt && m.createdAt.toDate ? m.createdAt.toDate() : new Date();
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  function renderMessages(list) {
    var box = $("msgList");
    if (!list.length) {
      if (!Object.keys(msgNodes).length) {
        box.innerHTML = "";
        box.appendChild(el("p", "msg-empty", "Say hi to " + (thread ? thread.other.firstName : "them") + " 👋"));
      }
      return;
    }
    var empty = box.querySelector(".msg-empty");
    if (empty) empty.remove();
    var added = false;
    list.forEach(function (m) {
      if (msgNodes[m.id]) return;
      var b = el("div", "bubble " + (m.from === state.uid ? "me" : "them") + (firstPaint ? "" : " pop"));
      b.appendChild(document.createTextNode(m.text));
      b.appendChild(el("small", "", timeText(m)));
      b.addEventListener("animationend", function () { b.classList.remove("pop"); });
      box.appendChild(b);
      msgNodes[m.id] = b;
      added = true;
    });
    if (added) box.scrollTop = box.scrollHeight;
  }

  // The message screen shrinks when the keyboard opens
  function fitThread() {
    var t = $("thread");
    var vv = window.visualViewport;
    if (!vv) {
      t.style.height = "100%";
      return;
    }
    t.style.height = vv.height + "px";
    t.style.top = vv.offsetTop + "px";
    var list = $("msgList");
    list.scrollTop = list.scrollHeight;
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", function () { if (thread) fitThread(); });
    window.visualViewport.addEventListener("scroll", function () { if (thread) fitThread(); });
  }

  function openThread(person) {
    if (!state.uid || !person || person.uid === state.uid) return;
    closeSheet();
    var id = Wallet.chatId(state.uid, person.uid);
    if (threadStop) { threadStop(); threadStop = null; }
    thread = { id: id, other: person };
    msgNodes = {};
    firstPaint = true;
    $("msgList").innerHTML = "";
    $("thName").textContent = fullName(person);
    $("thUser").textContent = prettyId(person.accountId);
    $("thAv").textContent = (person.firstName || "?").charAt(0).toUpperCase();
    $("thAv").className = "q-av sm " + colorClass(person.firstName);
    $("msgInput").value = "";
    renderMessages([]);
    $("thread").classList.remove("hidden", "leaving");
    lockScroll();
    fitThread();

    threadStop = Wallet.watchMessages(id, function (list) {
      if (!thread || thread.id !== id) return;
      renderMessages(list);
      firstPaint = false;
      if (list.length && list[list.length - 1].from !== state.uid) Wallet.markRead(state.uid, id);
    });
    Wallet.markRead(state.uid, id);
  }

  function closeThread() {
    if (threadStop) { threadStop(); threadStop = null; }
    var was = thread;
    thread = null;
    $("msgInput").blur();
    var t = $("thread");
    if (!was) {
      t.classList.add("hidden");
      return;
    }
    t.classList.add("leaving");
    setTimeout(function () {
      if (thread) return;
      t.classList.add("hidden");
      t.classList.remove("leaving");
      unlockScroll();
    }, 400);
  }

  $("thBack").addEventListener("click", closeThread);

  // Keep the keyboard open when you tap Send
  $("msgSend").addEventListener("pointerdown", function (e) { e.preventDefault(); });
  $("msgSend").addEventListener("mousedown", function (e) { e.preventDefault(); });

  $("msgForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var text = $("msgInput").value.trim();
    if (!text || !thread || !state.profile) return;
    $("msgInput").value = "";
    var other = { uid: thread.other.uid, name: fullName(thread.other), accountId: thread.other.accountId || "" };
    Wallet.sendMessage(me(), other, text).catch(function (err) {
      if (!$("msgInput").value) $("msgInput").value = text;
      toast(Wallet.friendlyError(err));
    });
  });

  // ---------- The bell: new messages and requests waiting for you ----------
  function renderBell() {
    var unread = 0;
    chats.forEach(function (c) { unread += unreadOf(c); });
    var incoming = requests.filter(function (r) { return r.status === "pending" && r.to && r.to.uid === state.uid; });
    var n = unread + incoming.length;
    $("bellBadge").textContent = n;
    $("bellBadge").classList.toggle("hidden", n === 0);
  }

  $("bellBtn").addEventListener("click", function () {
    renderNotifs();
    showView("vNotifs");
  });

  function renderNotifs() {
    var box = $("notifList");
    box.innerHTML = "";
    var count = 0;
    requests.forEach(function (r) {
      if (r.status !== "pending" || !r.to || r.to.uid !== state.uid) return;
      count++;
      var b = el("button", "chat-row");
      b.type = "button";
      var info = el("div", "chat-info");
      info.appendChild(el("p", "chat-name", (r.from ? r.from.name : "Someone") + " asks you for " + money(r.amount)));
      info.appendChild(el("p", "chat-last", "Open Home to pay or say no."));
      b.appendChild(info);
      b.addEventListener("click", function () {
        closeSheet();
        showTab("home");
      });
      box.appendChild(b);
    });
    chats.forEach(function (c) {
      if (unreadOf(c) <= 0) return;
      count++;
      var other = otherOf(c);
      var b = el("button", "chat-row");
      b.type = "button";
      var info = el("div", "chat-info");
      info.appendChild(el("p", "chat-name", fullName(other)));
      info.appendChild(el("p", "chat-last", c.lastMessage || "New message"));
      b.appendChild(info);
      b.addEventListener("click", function () { openThread(other); });
      box.appendChild(b);
    });
    $("notifEmpty").classList.toggle("hidden", count > 0);
  }

  // ---------- Cards: the card list, making a card, and the card page ----------
  // 16 colors in total: Plain (free) plus 15 others. Each non-plain color costs $2 per card.
  var FINISHES = [
    { id: "plain", short: "Plain", label: "Plain graphite" },
    { id: "ocean", short: "Ocean", label: "Ocean Blue" },
    { id: "forest", short: "Forest", label: "Forest" },
    { id: "bronze", short: "Bronze", label: "Bronze" },
    { id: "rose", short: "Rose", label: "Rose Gold" },
    { id: "ruby", short: "Ruby", label: "Ruby" },
    { id: "midnight", short: "Midnight", label: "Midnight" },
    { id: "gold", short: "Gold", label: "Royal Gold" },
    { id: "silver", short: "Silver", label: "Silver" },
    { id: "obsidian", short: "Obsidian", label: "Obsidian" },
    { id: "holo", short: "Holo", label: "Holographic" },
    { id: "aurora", short: "Aurora", label: "Aurora" },
    { id: "sunset", short: "Sunset", label: "Sunset" },
    { id: "violet", short: "Violet", label: "Violet" },
    { id: "mint", short: "Mint", label: "Mint" },
    { id: "sky", short: "Sky", label: "Sky" }
  ];

  var current = null;      // the card open in the card page
  var cardRoot = null;     // its element
  var revealed = false;
  var timerId = null;
  var selFinish = "plain";
  var selPlan = "daily";
  var autoPicking = false;

  function finishById(id) {
    for (var i = 0; i < FINISHES.length; i++) if (FINISHES[i].id === id) return FINISHES[i];
    return FINISHES[0];
  }
  function isOwnerUser() { return isOwnerAccount(); }
  function planPrice(plan) {
    if (isOwnerUser()) return 0;
    return plan === "daily" ? Wallet.prices.daily : Wallet.prices.forever;
  }
  function colorPrice(finish) {
    if (isOwnerUser() || finish === "plain") return 0;
    return Wallet.prices.color;
  }
  function activeCard() {
    var p = state.profile;
    if (!p || !p.activeCardId) return null;
    for (var i = 0; i < cards.length; i++) if (cards[i].id === p.activeCardId) return cards[i];
    return null;
  }
  function cardById(id) {
    for (var i = 0; i < cards.length; i++) if (cards[i].id === id) return cards[i];
    return null;
  }
  function isCardLocked(c) { return R.isCardLocked(c, today()); }
  function spentToday(c) {
    return c.spendDay === today() ? (c.spentDay || 0) : 0;
  }

  function brandEl(brand) {
    if (brand === "visa") return el("span", "bc-brand", "VISA");
    var mc = el("span", "mc");
    mc.appendChild(document.createElement("i"));
    mc.appendChild(document.createElement("i"));
    return mc;
  }

  // The little "tap to pay" waves in a card's corner
  function contactlessEl() {
    var NS = "http://www.w3.org/2000/svg";
    var s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("class", "bc-cl");
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round");
    s.innerHTML = '<path d="M8.5 9.5a4 4 0 0 1 0 5"/><path d="M11.5 7a7.5 7.5 0 0 1 0 10"/><path d="M14.5 4.5a11 11 0 0 1 0 15"/>';
    var wrap = el("span", "bc-cl-wrap");
    wrap.appendChild(s);
    return wrap;
  }

  function maskedNumber(card) { return "•••• •••• •••• " + (card.last4 || "••••"); }
  function fullNumber(card) { return String(card.number).replace(/(.{4})/g, "$1 ").trim(); }

  // The card leans and glows where your finger is
  function attachTilt(root) {
    function move(cx, cy) {
      var r = root.getBoundingClientRect();
      var x = Math.min(1, Math.max(0, (cx - r.left) / r.width));
      var y = Math.min(1, Math.max(0, (cy - r.top) / r.height));
      root.style.setProperty("--rx", ((0.5 - y) * 18).toFixed(1) + "deg");
      root.style.setProperty("--ry", ((x - 0.5) * 24).toFixed(1) + "deg");
      root.style.setProperty("--gx", (x * 100).toFixed(0) + "%");
      root.style.setProperty("--gy", (y * 100).toFixed(0) + "%");
      root.classList.add("touching");
    }
    function end() {
      root.classList.remove("touching");
      root.style.setProperty("--rx", "0deg");
      root.style.setProperty("--ry", "0deg");
    }
    root.addEventListener("touchstart", function (e) { move(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
    root.addEventListener("touchmove", function (e) { move(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
    root.addEventListener("touchend", end, { passive: true });
    root.addEventListener("touchcancel", end, { passive: true });
    root.addEventListener("mousemove", function (e) { move(e.clientX, e.clientY); });
    root.addEventListener("mouseleave", end);
  }

  // The front shows no numbers. The numbers live on the back.
  // opts: mini (small picture), badge (shows "IN USE")
  function cardEl(card, opts) {
    opts = opts || {};
    var root = el("div", "bank-card" + (opts.mini ? " mini" : "") + (card.frozen ? " frozen" : ""));
    var tilt = el("div", "bc-tilt");
    var inner = el("div", "bc-inner");

    var front = el("div", "bc-face bc-front fin-" + (card.finish || "plain"));
    front.appendChild(el("div", "bc-glare"));
    var top = el("div", "bc-top");
    top.appendChild(el("span", "bc-name", card.name || ""));
    top.appendChild(brandEl(card.brand || "visa"));
    var mid = el("div", "bc-mid");
    mid.appendChild(el("div", "bc-chip"));
    mid.appendChild(contactlessEl());
    var bot = el("div", "bc-bot");
    bot.appendChild(el("span", "bc-holder", card.holder || ""));
    bot.appendChild(opts.badge ? el("span", "bc-badge", "IN USE") : el("span", "bc-sb", "SB"));
    front.appendChild(top);
    front.appendChild(mid);
    front.appendChild(bot);
    front.appendChild(el("div", "bc-frozen", card.freezeReason === "used" ? "USED ONCE" : "FROZEN ❄"));
    inner.appendChild(front);

    if (!opts.mini) {
      var back = el("div", "bc-face bc-back");
      back.appendChild(el("div", "bc-strip"));
      var bk = el("div", "bc-bk");
      var num = el("p", "bc-num", card.number && String(card.number).indexOf("•") === -1 ? maskedNumber(card) : (card.number || maskedNumber(card)));
      bk.appendChild(num);
      var row = el("div", "bc-row");
      var d1 = el("div", "");
      d1.appendChild(el("span", "bc-lab", "VALID THRU"));
      d1.appendChild(el("span", "bc-val", (card.expMonth || "--") + "/" + (card.expYear || "--")));
      var d2 = el("div", "");
      d2.appendChild(el("span", "bc-lab", "CVV"));
      var cvv = el("span", "bc-cvv", "•••");
      d2.appendChild(cvv);
      row.appendChild(d1);
      row.appendChild(d2);
      bk.appendChild(row);
      back.appendChild(bk);
      back.appendChild(el("p", "bc-note", "SB Wallet fake card. Not real money."));
      inner.appendChild(back);
      root._num = num;
      root._cvv = cvv;
      attachTilt(root);
    }

    tilt.appendChild(inner);
    root.appendChild(tilt);
    return root;
  }

  // One status word per card: Locked (used once), Frozen, Unpaid day, In use, or Ready
  function cardStatus(c) {
    if (c.frozen && c.freezeReason === "used") return { text: "Locked", cls: "st-locked" };
    if (c.frozen) return { text: "Frozen", cls: "st-frozen" };
    if (isCardLocked(c)) return { text: "Unpaid day", cls: "st-unpaid" };
    var a = activeCard();
    if (a && a.id === c.id) return { text: "In use", cls: "st-use" };
    return { text: "Ready", cls: "st-ready" };
  }

  function reissuedText(c) {
    var d = c.reissuedAt && c.reissuedAt.toDate ? c.reissuedAt.toDate() : null;
    if (!d) return "";
    return "Last new number: " + d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  // A small card face for Home
  function homeTile(c) {
    var st = cardStatus(c);
    var b = el("button", "home-tile" + (c.frozen ? " frozen" : ""));
    b.type = "button";
    b.setAttribute("aria-label", c.name + ", ending " + c.last4 + ", " + st.text);
    var face = el("span", "ht-face fin-" + (c.finish || "plain"));
    var top = el("span", "ht-top");
    top.appendChild(el("span", "ht-name", c.name));
    top.appendChild(brandEl(c.brand || "visa"));
    var bot = el("span", "ht-bot");
    bot.appendChild(el("span", "ht-last", "•••• " + c.last4));
    bot.appendChild(el("span", "ht-status " + st.cls, st.text));
    face.appendChild(top);
    face.appendChild(bot);
    b.appendChild(face);
    b.addEventListener("click", function () { openCard(c); });
    return b;
  }

  function renderHomeCards() {
    var list = $("cardList");
    list.innerHTML = "";
    cards.forEach(function (c) { list.appendChild(homeTile(c)); });
    if (cards.length < MAX_CARDS && cardsReady) {
      var add = el("button", "home-add");
      add.type = "button";
      add.appendChild(el("span", "home-add-plus", "+"));
      add.appendChild(el("span", "", "New card"));
      add.addEventListener("click", function () { openNew(false); });
      list.appendChild(add);
    }
    $("cardListEmpty").classList.toggle("hidden", cards.length > 0 || !cardsReady);
    $("cardsCount").textContent = cards.length ? cards.length + " of " + MAX_CARDS : "";
    $("heroCards").textContent = cards.length + (cards.length === 1 ? " card" : " cards");
    $("firstGate").classList.toggle("hidden", !(SB.features.requireCard && cardsReady && cards.length === 0 && state.uid));
  }

  // Banners for each daily card that is locked, with a Pay button
  function renderLockBanners() {
    var box = $("lockBanners");
    box.innerHTML = "";
    cards.forEach(function (c) {
      if (!isCardLocked(c) || c.frozen) return;
      var row = el("div", "lock-banner");
      var txt = el("div", "lock-txt");
      txt.appendChild(el("b", "", c.name + " is locked"));
      txt.appendChild(el("span", "", R.lockReason(c, today())));
      var btn = el("button", "lock-pay", "Pay");
      btn.type = "button";
      btn.addEventListener("click", function () { payCard(c); });
      row.appendChild(txt);
      row.appendChild(btn);
      box.appendChild(row);
    });
  }

  function renderSheetList() {
    var box = $("cardsSheetList");
    box.innerHTML = "";
    var a = activeCard();
    cards.forEach(function (c) {
      var b = el("button", "card-btn");
      b.type = "button";
      b.appendChild(cardEl(c, { mini: true, badge: !!(a && a.id === c.id) }));
      b.appendChild(el("span", "card-btn-sub", cardStatus(c).text));
      b.addEventListener("click", function () { openCard(c); });
      box.appendChild(b);
    });
    var anyFrozen = cards.some(function (c) { return c.frozen; });
    $("freezeAllBtn").textContent = anyFrozen ? "Unfreeze all cards" : "Freeze all cards";
    $("freezeAllBtn").disabled = cards.length === 0;
    $("newCardFromSheet").disabled = cards.length >= MAX_CARDS;
  }

  function freezeAllFlow() {
    var anyFrozen = cards.some(function (c) { return c.frozen; });
    flow(async function () {
      if (!(await pinGate(anyFrozen ? "Unfreezing all cards" : "Freezing all cards"))) return;
      await Wallet.freezeAllCards(state.uid, !anyFrozen);
      toast(anyFrozen ? "All cards unfrozen" : "All cards frozen ❄");
    });
  }
  $("homeFreezeAll").addEventListener("click", freezeAllFlow);
  $("freezeAllBtn").addEventListener("click", freezeAllFlow);

  function openCardsSheet() {
    renderSheetList();
    showView("vCards");
  }
  $("seeAllCards").addEventListener("click", openCardsSheet);
  $("newCardFromSheet").addEventListener("click", function () { openNew(false); });
  $("firstGateBtn").addEventListener("click", function () { openNew(true); });

  // ---------- Making a new card ----------
  function previewCard() {
    var nick = $("cardNick").value.trim();
    var p = state.profile;
    var f = finishById(selFinish);
    return {
      name: nick || f.label,
      finish: selFinish,
      brand: "mastercard",
      number: "•••• •••• •••• ••••",
      last4: "••••",
      expMonth: "12",
      expYear: "30",
      holder: p ? fullName(p).toUpperCase() : "",
      frozen: false
    };
  }

  function newCardTotal() { return planPrice(selPlan) + colorPrice(selFinish); }

  function renderPreview() {
    var box = $("newPreview");
    box.innerHTML = "";
    box.appendChild(cardEl(previewCard(), { mini: true }));
    var total = newCardTotal();
    $("priceNote").textContent = total > 0 ? money(total) + " from your balance" : "Free";
    $("issueBtn").textContent = total > 0 ? "Issue for " + money(total) : "Issue Card Now";
    $("planNote").textContent = isOwnerUser() ? "Owner cards are free and always forever."
      : selPlan === "daily" ? "Pay " + money(Wallet.prices.daily) + " each day. Miss a day and the card locks until you pay."
      : "Pay " + money(Wallet.prices.forever) + " once. It never locks for unpaid days.";
  }

  function buildPlanPicker() {
    var grid = $("planGrid");
    grid.innerHTML = "";
    [
      { id: "daily", title: "Daily", sub: money(Wallet.prices.daily) + " a day" },
      { id: "forever", title: "Forever", sub: money(Wallet.prices.forever) + " once" }
    ].forEach(function (p) {
      var b = el("button", "plan-opt" + (p.id === selPlan ? " sel" : ""));
      b.type = "button";
      b.appendChild(el("b", "", p.title));
      b.appendChild(el("span", "", isOwnerUser() ? "Free" : p.sub));
      b.addEventListener("click", function () {
        selPlan = p.id;
        buildPlanPicker();
        renderPreview();
      });
      grid.appendChild(b);
    });
  }

  function buildPicker() {
    var grid = $("finGrid");
    grid.innerHTML = "";
    FINISHES.forEach(function (f) {
      var b = el("button", "fin-opt" + (f.id === selFinish ? " sel" : ""));
      b.type = "button";
      b.setAttribute("aria-label", f.label);
      b.appendChild(el("span", "fin-dot fin-" + f.id));
      b.appendChild(el("span", "", f.short));
      b.addEventListener("click", function () {
        selFinish = f.id;
        buildPicker();
        renderPreview();
      });
      grid.appendChild(b);
    });
  }

  function openNew(first) {
    if (cards.length >= MAX_CARDS) {
      toast("You can have up to " + MAX_CARDS + " cards.");
      return;
    }
    selFinish = "plain";
    selPlan = "daily";
    $("cardNick").value = "";
    $("newTitle").textContent = first ? "Make your first card" : "New SB Card";
    buildPlanPicker();
    buildPicker();
    renderPreview();
    showView("vCardNew");
  }

  $("cardNick").addEventListener("input", renderPreview);

  $("issueBtn").addEventListener("click", function () {
    flow(async function () {
      if (!state.profileLive) {
        toast("Still loading your account. One moment.");
        return;
      }
      if (cards.length >= MAX_CARDS) {
        toast("You can have up to " + MAX_CARDS + " cards.");
        return;
      }
      var total = newCardTotal();
      var name = $("cardNick").value.trim() || finishById(selFinish).label;
      var holder = fullName(state.profile).toUpperCase();
      var plan = selPlan;
      var finish = selFinish;
      var firstCard = cards.length === 0 || !activeCard();
      var uid = state.uid;
      var ownerUid = state.feeOwner;

      if (total <= 0) {
        var id = await Wallet.createCard(uid, name, holder, plan, ownerUid, finish);
        if (firstCard) await Wallet.setActiveCard(uid, id);
        chime();
        closeSheet();
        toast("Card issued!");
        return;
      }

      if ((state.profile.balance || 0) < total) {
        toast("You need " + money(total) + " for this card.");
        return;
      }
      if (!(await pinGate("Paying " + money(total) + " for " + name))) return;
      await runBusy("Making your card…", async function () {
        var newId = await Wallet.createCard(uid, name, holder, plan, ownerUid, finish);
        if (firstCard) await Wallet.setActiveCard(uid, newId);
      }, name + " is ready!", null, ["Checking your balance…", "Making your card…", "Almost there…"]);
    });
  });

  // The first card you have becomes the one you use
  function autoPick() {
    if (autoPicking || !cardsReady || !state.profileLive || !cards.length || activeCard()) return;
    autoPicking = true;
    Wallet.setActiveCard(state.uid, cards[0].id).catch(function () {}).then(function () { autoPicking = false; });
  }

  // ---------- The card page ----------
  function clearTimer() {
    clearTimeout(timerId);
    timerId = null;
    $("cvTimer").classList.remove("run");
  }

  // Runs done() after 10 seconds, with a line shrinking across the bottom
  function startTimer(done) {
    clearTimer();
    var t = $("cvTimer");
    void t.offsetWidth;
    t.classList.add("run");
    timerId = setTimeout(function () {
      clearTimer();
      done();
    }, 10000);
  }

  function maskNumber() {
    revealed = false;
    if (cardRoot && current) {
      cardRoot._num.textContent = maskedNumber(current);
      cardRoot._cvv.textContent = "•••";
    }
    updateButtons();
  }

  function setFlipped(flipped) {
    if (!cardRoot) return;
    cardRoot.classList.toggle("flipped", flipped);
    if (flipped) {
      startTimer(function () {
        cardRoot.classList.remove("flipped");
        if (revealed) maskNumber();
      });
    } else {
      clearTimer();
    }
  }

  function updateButtons() {
    if (!current) return;
    var c = current;
    var a = activeCard();
    var isActive = !!(a && a.id === c.id);
    $("cvUse").textContent = isActive ? "✓ Using this card" : "Use this card";
    $("cvUse").disabled = isActive;
    $("cvUse").classList.toggle("used-btn", isActive);
    $("cvReveal").textContent = revealed ? "Hide number" : "Show number";
    $("cvReveal").classList.toggle("on", revealed);
    $("cvFreeze").textContent = c.frozen ? "Unfreeze card" : "Freeze card";
    $("cvFreeze").classList.toggle("on", !!c.frozen);

    var why = R.lockReason(c, today());
    $("cvStatus").textContent = why || (isActive ? "This is the card you are using." : "Ready to use.");
    $("cvStatus").classList.toggle("bad", !!why);

    var payable = c.plan === "daily" && !c.frozen && isCardLocked(c);
    $("cvPayBox").classList.toggle("hidden", !payable);
    if (payable) $("cvPayText").textContent = "Pay " + money(R.payDue(c, today())) + " to unlock";

    $("cvSingle").classList.toggle("on", !!c.singleUse);
    $("cvSingle").setAttribute("aria-checked", c.singleUse ? "true" : "false");

    $("cvLimitNow").textContent = "Spent today: " + money(spentToday(c));
    $("cvLockNow").textContent = c.lockTo ? "Now: only ID " + prettyId(c.lockTo) : "Now: anyone";
    var re = reissuedText(c);
    $("cvReissueNow").textContent = re;
    $("cvReissueNow").classList.toggle("hidden", !re);
    buildCardColors();
  }

  // The colors row: owned colors show a check, the one in use is ringed. Tap to switch or buy.
  function buildCardColors() {
    var box = $("cvColors");
    box.innerHTML = "";
    if (!current) return;
    FINISHES.forEach(function (f) {
      var owned = Wallet.ownsFinish(current, f.id);
      var selected = current.finish === f.id;
      var b = el("button", "fin-opt" + (selected ? " sel" : "") + (owned ? "" : " locked"));
      b.type = "button";
      var word = selected ? "In use" : owned ? "Owned" : (isOwnerUser() ? "Free" : money(Wallet.prices.color));
      b.setAttribute("aria-label", f.label + ": " + (selected ? "in use" : owned ? "owned" : "costs " + word));
      var sw = el("span", "fin-swatch");
      sw.appendChild(el("span", "fin-dot fin-" + f.id));
      if (owned) sw.appendChild(el("span", "fin-check", "✓"));
      b.appendChild(sw);
      b.appendChild(el("span", "fin-name", f.short));
      b.appendChild(el("span", "fin-price" + (word === "Free" ? " free" : selected ? " now" : ""), word));
      b.addEventListener("click", function () { changeColor(f); });
      box.appendChild(b);
    });
  }

  function changeColor(f) {
    var c = current;
    if (!c) return;
    if (Wallet.ownsFinish(c, f.id)) {
      if (c.finish === f.id) return;
      Wallet.setCardFinish(state.uid, c.id, f.id).then(function () {
        toast(f.label + " color on");
      }, function (e) { toast(Wallet.friendlyError(e)); });
      return;
    }
    var price = colorPrice(f.id);
    if ((state.profile.balance || 0) < price) {
      toast("You need " + money(price) + " for this color.");
      return;
    }
    flow(async function () {
      if (!(await pinGate("Buying " + f.label + " for " + money(price)))) return;
      await runBusy("Adding the color…", function () {
        return Wallet.buyColor(state.uid, state.feeOwner, c.id, f.id);
      }, f.label + " is on!", null, ["Checking your balance…", "Painting your card…", "Almost there…"]);
    });
  }

  function openCard(card) {
    current = card;
    revealed = false;
    clearTimer();
    $("cvName").textContent = card.name;
    var box = $("cvCard");
    box.innerHTML = "";
    cardRoot = cardEl(card);
    box.appendChild(cardRoot);
    $("cvLimitInput").value = card.limit ? card.limit : "";
    $("cvRename").value = "";
    $("cvLockInput").value = "";
    updateButtons();
    showView("vCard");
  }

  // The card changed online (frozen, in use, paid...) while its page is open
  function refreshOpenCard() {
    if (!current || $("vCard").classList.contains("hidden")) return;
    var found = cardById(current.id);
    if (!found) return;
    current = found;
    if (cardRoot) cardRoot.classList.toggle("frozen", !!current.frozen);
    updateButtons();
  }

  $("cvFlip").addEventListener("click", function () {
    if (!cardRoot) return;
    var flipped = !cardRoot.classList.contains("flipped");
    setFlipped(flipped);
    if (!flipped && revealed) maskNumber();
  });

  // Tap the card itself to flip it too
  $("cvCard").addEventListener("click", function () { $("cvFlip").click(); });

  $("cvReveal").addEventListener("click", function () {
    if (!current || !cardRoot) return;
    if (revealed) {
      clearTimer();
      maskNumber();
      setFlipped(false);
      return;
    }
    revealed = true;
    cardRoot._num.textContent = fullNumber(current);
    cardRoot._cvv.textContent = current.cvv;
    updateButtons();
    setFlipped(true);
    copyText(current.number).then(function (ok) {
      toast(ok ? "Card number copied!" : "Number shown for 10 seconds");
    });
  });

  $("cvUse").addEventListener("click", function () {
    if (!current) return;
    var c = current;
    Wallet.setActiveCard(state.uid, c.id).then(function () {
      toast("Now using " + c.name);
    }, function (e) { toast(Wallet.friendlyError(e)); });
  });

  function payCard(c) {
    var card = cardById(c.id) || c;
    var due = R.payDue(card, today());
    if (due <= 0) {
      toast("Nothing to pay on " + card.name + ".");
      return;
    }
    if ((state.profile.balance || 0) < due) {
      toast("You need " + money(due) + " to pay this.");
      return;
    }
    flow(async function () {
      if (!(await pinGate("Paying " + money(due) + " for " + card.name))) return;
      await runBusy("Paying…", function () {
        return Wallet.payCardToday(state.uid, state.feeOwner, card.id);
      }, card.name + " is unlocked!", null, ["Checking your balance…", "Paying the card fee…", "Almost there…"]);
    });
  }
  $("cvPay").addEventListener("click", function () { if (current) payCard(current); });

  $("cvFreeze").addEventListener("click", function () {
    if (!current) return;
    var c = current;
    if (c.freezeReason === "used") {
      toast("This card was used once. Reissue it to use it again.");
      return;
    }
    flow(async function () {
      if (!(await pinGate((c.frozen ? "Unfreezing " : "Freezing ") + c.name))) return;
      await Wallet.setCardFrozen(state.uid, c.id, !c.frozen);
      toast(c.frozen ? "Card unfrozen" : "Card frozen ❄");
    });
  });

  $("cvLimitBtn").addEventListener("click", function () {
    if (!current) return;
    var v = parseFloat($("cvLimitInput").value);
    if (isNaN(v) || v < 0) v = 0;
    Wallet.setCardLimit(state.uid, current.id, v).then(function () {
      toast(v > 0 ? "Daily limit set to " + money(v) : "No daily limit");
    }, function (e) { toast(Wallet.friendlyError(e)); });
  });

  $("cvLockBtn").addEventListener("click", function () {
    if (!current) return;
    var id = cleanId($("cvLockInput").value);
    if ($("cvLockInput").value.trim() && id.length !== 8) {
      toast("Type an 8-digit ID number, or leave it empty.");
      return;
    }
    Wallet.setLockTo(state.uid, current.id, id || null).then(function () {
      toast(id ? "This card now only pays " + prettyId(id) : "This card pays anyone");
    }, function (e) { toast(Wallet.friendlyError(e)); });
  });

  $("cvRenameBtn").addEventListener("click", function () {
    if (!current) return;
    var name = $("cvRename").value.trim();
    if (!name) {
      toast("Type a new name first.");
      return;
    }
    Wallet.renameCard(state.uid, current.id, name.slice(0, 20)).then(function () {
      $("cvRename").value = "";
      toast("Card renamed");
    }, function (e) { toast(Wallet.friendlyError(e)); });
  });

  $("cvSingle").addEventListener("click", function () {
    if (!current) return;
    var on = !current.singleUse;
    Wallet.setSingleUse(state.uid, current.id, on).then(function () {
      toast(on ? "Single-use on: the card freezes after one payment" : "Single-use off");
    }, function (e) { toast(Wallet.friendlyError(e)); });
  });

  $("cvReissue").addEventListener("click", function () {
    if (!current) return;
    var c = current;
    flow(async function () {
      if (!(await pinGate("New number for " + c.name))) return;
      await Wallet.reissueCard(state.uid, c.id);
      toast("New card number and CVV made");
    });
  });

  twoStep($("cvDelete"), "Tap again to delete", function () {
    if (!current) return;
    var c = current;
    flow(async function () {
      if (!(await pinGate("Deleting " + c.name))) return;
      await Wallet.deleteCard(state.uid, c.id);
      var a = activeCard();
      if (a && a.id === c.id) await Wallet.setActiveCard(state.uid, null);
      closeSheet();
      toast("Card deleted");
    });
  });

  // ---------- Owner tools (the owner's funding password) ----------
  function renderOwnerCard() {
    $("ownerCard").classList.toggle("hidden", !isOwnerUser());
    $("ownerStatus").textContent = ownerExists
      ? "Your funding password is set. You use it to add money."
      : "Set a funding password. You need it to add money.";
    $("ownerBtn").textContent = ownerExists ? "Change funding password" : "Set funding password";
  }

  $("ownerBtn").addEventListener("click", function () {
    $("ownerTitle").textContent = ownerExists ? "Change funding password" : "Set funding password";
    $("ownerSub").textContent = "This is a second password just for adding money. Make it long and keep it secret.";
    $("ownerOld").classList.toggle("hidden", !ownerExists);
    $("ownerOld").value = "";
    $("ownerPw1").value = "";
    $("ownerPw2").value = "";
    $("ownerError").textContent = "";
    showView("vOwner");
  });

  $("ownerSave").addEventListener("click", function () {
    var pw1 = $("ownerPw1").value;
    var pw2 = $("ownerPw2").value;
    if (pw1.length < 10) {
      $("ownerError").textContent = "Make it at least 10 characters.";
      return;
    }
    if (pw1 !== pw2) {
      $("ownerError").textContent = "Those don't match.";
      return;
    }
    var btn = $("ownerSave");
    btn.disabled = true;
    var job = ownerExists
      ? Wallet.changeFundPassword($("ownerOld").value, pw1)
      : Wallet.claimOwner(state.uid, state.email, pw1);
    job.then(function () {
      closeSheet();
      toast("Funding password saved");
    }, function (e) {
      $("ownerError").textContent = Wallet.friendlyError(e);
    }).then(function () {
      btn.disabled = false;
    });
  });

  // ---------- Analytics ----------
  function dayStats() {
    var p = state.profile;
    return (p && p.stats && p.stats.d) || {};
  }
  function keyDaysAgo(n) {
    var d = new Date();
    d.setDate(d.getDate() - n);
    return R.keyOf(d);
  }

  function renderDonut(sent, recv, fees) {
    var svg = $("donutSvg");
    svg.innerHTML = "";
    var NS = "http://www.w3.org/2000/svg";
    var total = sent + recv + fees;
    var C = 2 * Math.PI * 40;
    var base = document.createElementNS(NS, "circle");
    base.setAttribute("cx", "50");
    base.setAttribute("cy", "50");
    base.setAttribute("r", "40");
    base.setAttribute("style", "stroke:#DCE8F7;opacity:.5");
    base.setAttribute("stroke-width", "15");
    base.setAttribute("fill", "none");
    svg.appendChild(base);
    if (total <= 0) return;
    var parts = [
      { v: sent, color: "#5483B3" },
      { v: recv, color: "#C1E8FF" },
      { v: fees, color: "#C1E8FF" }
    ];
    var offset = 0;
    parts.forEach(function (p) {
      if (p.v <= 0) return;
      var len = (p.v / total) * C;
      var c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", "50");
      c.setAttribute("cy", "50");
      c.setAttribute("r", "40");
      c.setAttribute("stroke", p.color);
      c.setAttribute("stroke-width", "15");
      c.setAttribute("fill", "none");
      c.setAttribute("stroke-dasharray", len.toFixed(2) + " " + (C - len).toFixed(2));
      c.setAttribute("stroke-dashoffset", (-offset).toFixed(2));
      svg.appendChild(c);
      offset += len;
    });
  }

  function renderAnalytics() {
    if (!state.uid || !$("tab-analytics")) return;
    var stats = dayStats();
    var month = today().slice(0, 7);
    var sent = 0, recv = 0, fees = 0;
    Object.keys(stats).forEach(function (day) {
      if (day.indexOf(month) !== 0) return;
      var d = stats[day] || {};
      sent += d.sent || 0;
      recv += d.in || 0;
      fees += (d.fee || 0) + (d.feesIn || 0);
    });
    sent = round2(sent);
    recv = round2(recv);
    fees = round2(fees);

    var whole = "$" + Math.round(sent).toLocaleString("en-US");
    $("donutTotal").textContent = whole;
    $("donutMid").classList.toggle("long", whole.length > 8);
    renderDonut(sent, recv, fees);

    var legend = $("legend");
    legend.innerHTML = "";
    [["Sent", sent, "#5483B3"], ["Received", recv, "#C1E8FF"], ["Fees", fees, "#C1E8FF"]].forEach(function (row) {
      var line = el("div", "");
      line.appendChild(el("i", ""));
      line.lastChild.style.background = row[2];
      line.appendChild(el("span", "", money(row[1])));
      line.insertBefore(el("b", "", row[0]), line.lastChild);
      legend.appendChild(line);
    });

    var days = [];
    for (var i = 6; i >= 0; i--) days.push(keyDaysAgo(i));
    var max = 1;
    days.forEach(function (k) {
      var d = stats[k] || {};
      max = Math.max(max, d.sent || 0, d.in || 0);
    });
    var bars = $("bars");
    bars.innerHTML = "";
    days.forEach(function (k, idx) {
      var d = stats[k] || {};
      var col = el("div", "bar-col");
      var pair = el("div", "bar-pair");
      var out = el("div", "bar out");
      var inn = el("div", "bar in");
      out.style.height = Math.max(2, ((d.sent || 0) / max) * 100) + "%";
      inn.style.height = Math.max(2, ((d.in || 0) / max) * 100) + "%";
      pair.appendChild(out);
      pair.appendChild(inn);
      col.appendChild(pair);
      var letter = new Date(k + "T00:00:00").toLocaleDateString("en-US", { weekday: "short" }).charAt(0);
      col.appendChild(el("span", "bar-lab" + (idx === 6 ? " today" : ""), letter));
      bars.appendChild(col);
    });

    var box = $("cardBreakdown");
    box.innerHTML = "";
    if (!cards.length) box.appendChild(el("p", "muted small", "No cards yet."));
    var top = 1;
    cards.forEach(function (c) {
      top = Math.max(top, c.spendMonth === month ? (c.spentMonth || 0) : 0);
    });
    cards.forEach(function (c) {
      var spent = c.spendMonth === month ? (c.spentMonth || 0) : 0;
      var row = el("div", "crow");
      var head = el("div", "crow-head");
      head.appendChild(el("span", "", c.name + " •• " + c.last4));
      head.appendChild(el("b", "", money(spent)));
      var track = el("div", "crow-track");
      var fill = el("i", "");
      fill.style.width = Math.round((spent / top) * 100) + "%";
      track.appendChild(fill);
      row.appendChild(head);
      row.appendChild(track);
      box.appendChild(row);
    });
  }

  // ---------- Starting up ----------
  // Shared with stocks.js (and anything added later)
  window.SB = {
    $: $,
    money: money,
    fullName: fullName,
    cleanId: cleanId,
    prettyId: prettyId,
    colorClass: colorClass,
    timeAgo: timeAgo,
    state: state,
    features: { requireCard: false },
    feeFor: feeFor,
    isOwnerAccount: isOwnerAccount,
    isCardLocked: isCardLocked,
    on: on,
    emit: emit,
    flow: flow,
    toast: toast,
    showView: showView,
    closeSheet: closeSheet,
    askAmount: askAmount,
    enterPin: enterPin,
    needPin: needPin,
    pinGate: pinGate,
    runBusy: runBusy,
    notify: notify,
    copyText: copyText,
    twoStep: twoStep,
    openTab: showTab,
    openReceipt: openReceipt,
    openThread: openThread,
    chime: chime,
    lockScroll: lockScroll,
    unlockScroll: unlockScroll,
    activeCard: activeCard,
    uid: function () { return state.uid; },
    placePill: placePill,
    isMoneyHidden: function () { return hideMoney; },
    cardsList: function () { return cards.slice(); },
    cardById: cardById,
    spentToday: spentToday,
    faceOn: function () { return false; },
    verifyFace: async function () { return "unavailable"; }
  };

  // The logo on the splash screen is hidden in the HTML until the script runs
  $("splashLogo").hidden = false;
  setMode("signup");

  Wallet.watchAuth(function (user) {
    if (signingUp) return; // sign-up opens the app itself, once the profile exists
    if (user) {
      startApp(user);
    } else {
      stopApp();
    }
  });
})();
