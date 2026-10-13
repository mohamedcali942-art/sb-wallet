// cards.js — SB Wallet cards: make several cards, pick the one you use, flip it, reveal it, freeze it.
// All cards share your one wallet balance. The card you pick is shown on your receipts.
// You must make a card before you can add or send money. The blue card is free, other colors cost money.

(function () {
  if (!window.SB || !window.Wallet) return;
  var SB = window.SB;
  var $ = SB.$;
  var Wallet = window.Wallet;

  var MAX_CARDS = 5;
  // Dollars for every color except the free one. Colors are all free until the "paidColors" switch is turned on.
  var COLOR_PRICE = SB.features.paidColors ? 10 : 0;

  var FINISHES = [
    { id: "ocean", short: "Ocean", label: "Ocean Blue", price: 0 },
    { id: "forest", short: "Forest", label: "Forest", price: COLOR_PRICE },
    { id: "bronze", short: "Bronze", label: "Bronze", price: COLOR_PRICE },
    { id: "rose", short: "Rose", label: "Rose Gold", price: COLOR_PRICE },
    { id: "ruby", short: "Ruby", label: "Ruby", price: COLOR_PRICE },
    { id: "midnight", short: "Midnight", label: "Midnight", price: COLOR_PRICE },
    { id: "gold", short: "Gold", label: "Royal Gold", price: COLOR_PRICE },
    { id: "silver", short: "Silver", label: "Silver", price: COLOR_PRICE },
    { id: "obsidian", short: "Obsidian", label: "Obsidian", price: COLOR_PRICE },
    { id: "holo", short: "Holo", label: "Holographic", price: COLOR_PRICE },
    { id: "aurora", short: "Aurora", label: "Aurora", price: COLOR_PRICE }
  ];

  var cards = [];
  var cardsReady = false;
  var onboarded = false;
  var stopCards = null;
  var selFinish = "ocean";
  var current = null;      // the card open in the card sheet
  var cardRoot = null;     // its element
  var revealed = false;
  var viewing = false;
  var timerId = null;
  var autoPicking = false;

  function finishById(id) {
    for (var i = 0; i < FINISHES.length; i++) if (FINISHES[i].id === id) return FINISHES[i];
    return FINISHES[0];
  }

  // The card you use (shown on receipts), or nothing
  SB.activeCard = function () {
    var p = SB.state.profile;
    if (!p || !p.activeCardId) return null;
    for (var i = 0; i < cards.length; i++) if (cards[i].id === p.activeCardId) return cards[i];
    return null;
  };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function brandEl(brand) {
    if (brand === "visa") return el("span", "bc-brand", "VISA");
    var mc = el("span", "mc");
    mc.appendChild(document.createElement("i"));
    mc.appendChild(document.createElement("i"));
    return mc;
  }

  function maskedNumber(card) { return "•••• •••• •••• " + card.last4; }
  function fullNumber(card) { return card.number.replace(/(.{4})/g, "$1 ").trim(); }

  // Make the card lean and glow where your finger is
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

  // The front shows NO numbers. The numbers live on the back.
  // opts: { mini, badge }
  function cardEl(card, opts) {
    opts = opts || {};
    var root = el("div", "bank-card" + (opts.mini ? " mini" : "") + (card.frozen ? " frozen" : ""));
    var tilt = el("div", "bc-tilt");
    var inner = el("div", "bc-inner");

    var front = el("div", "bc-face bc-front fin-" + card.finish);
    front.appendChild(el("div", "bc-glare"));
    var top = el("div", "bc-top");
    top.appendChild(el("span", "bc-name", card.name));
    top.appendChild(brandEl(card.brand));
    var mid = el("div", "bc-mid");
    mid.appendChild(el("div", "bc-chip"));
    var bot = el("div", "bc-bot");
    bot.appendChild(el("span", "bc-holder", card.holder || ""));
    bot.appendChild(opts.badge ? el("span", "bc-badge", "IN USE") : el("span", "bc-sb", "SB"));
    front.appendChild(top);
    front.appendChild(mid);
    front.appendChild(bot);
    front.appendChild(el("div", "bc-frozen", "FROZEN ❄"));
    inner.appendChild(front);

    if (!opts.mini) {
      var back = el("div", "bc-face bc-back");
      back.appendChild(el("div", "bc-strip"));
      var bk = el("div", "bc-bk");
      var num = el("p", "bc-num", card.number.indexOf("•") !== -1 ? card.number : maskedNumber(card));
      bk.appendChild(num);
      var row = el("div", "bc-row");
      var d1 = el("div", "");
      d1.appendChild(el("span", "bc-lab", "VALID THRU"));
      d1.appendChild(el("span", "bc-val", card.expMonth + "/" + card.expYear));
      var d2 = el("div", "");
      d2.appendChild(el("span", "bc-lab", "CVV"));
      d2.appendChild(el("span", "bc-cvv", card.cvv));
      row.appendChild(d1);
      row.appendChild(d2);
      bk.appendChild(row);
      back.appendChild(bk);
      back.appendChild(el("p", "bc-note", "SB Wallet fake card. Not real money."));
      inner.appendChild(back);
      root._num = num;
      attachTilt(root);
    }

    tilt.appendChild(inner);
    root.appendChild(tilt);
    return root;
  }

  // ---------- Home: the row of cards ----------
  function renderCards() {
    var row = $("cardsRow");
    row.innerHTML = "";
    var active = SB.activeCard();

    cards.forEach(function (c) {
      var b = el("button", "card-btn");
      b.type = "button";
      b.appendChild(cardEl(c, { mini: true, badge: !!(active && active.id === c.id) }));
      b.addEventListener("click", function () { openCard(c); });
      row.appendChild(b);
    });

    var add = el("button", "new-card-tile");
    add.type = "button";
    add.appendChild(el("b", "", "+"));
    add.appendChild(el("span", "", "New card"));
    add.addEventListener("click", function () { openNew(false); });
    row.appendChild(add);

    $("cardsCount").textContent = cards.length ? cards.length + " of " + MAX_CARDS : "";
    $("issueBanner").classList.toggle("show", SB.features.requireCard && cardsReady && cards.length === 0);

    // The big wallet card wears the colors of the card you use
    $("walletCard").className = "wallet-card fin-" + (active ? active.finish : (SB.features.requireCard ? "none" : "ocean"));

    if (viewing && current) refreshOpen();
  }

  // ---------- Make a new card ----------
  function previewCard() {
    var nick = $("cardNick").value.trim();
    var p = SB.state.profile;
    var f = finishById(selFinish);
    return {
      name: nick || f.label,
      finish: selFinish,
      brand: "mastercard",
      number: "•••• •••• •••• ••••",
      last4: "••••",
      expMonth: "12",
      expYear: "30",
      cvv: "•••",
      holder: p ? SB.fullName(p).toUpperCase() : "",
      frozen: false
    };
  }

  function renderPreview() {
    var box = $("newPreview");
    box.innerHTML = "";
    box.appendChild(cardEl(previewCard()));
    var f = finishById(selFinish);
    $("priceNote").textContent = f.price > 0 ? SB.money(f.price) + " from your balance" : "Free";
    $("issueBtn").textContent = f.price > 0 ? "Issue for " + SB.money(f.price) : "Issue Card Now";
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
    if (cards.length >= MAX_CARDS) { SB.toast("You can have up to " + MAX_CARDS + " cards."); return; }
    selFinish = "ocean";
    $("cardNick").value = "";
    $("newTitle").textContent = first ? "Make your first card" : "New SB Card";
    buildPicker();
    renderPreview();
    SB.showView("vCardNew");
  }

  $("cardNick").addEventListener("input", renderPreview);

  $("issueBtn").addEventListener("click", function () {
    SB.flow(async function () {
      if (!SB.state.profileLive) { SB.toast("Still loading your account. One moment."); return; }
      var f = finishById(selFinish);
      var name = $("cardNick").value.trim() || f.label;
      var holder = SB.fullName(SB.state.profile).toUpperCase();
      var firstCard = cards.length === 0 || !SB.activeCard();
      var uid = SB.state.uid;

      if (f.price <= 0) {
        var id = await Wallet.createCard(uid, name, selFinish, holder, 0);
        if (firstCard) await Wallet.setActiveCard(uid, id);
        SB.chime();
        SB.closeSheet();
        SB.toast("Card issued!");
        return;
      }

      if ((SB.state.profile.balance || 0) < f.price) {
        SB.toast("You need " + SB.money(f.price) + " for this color.");
        return;
      }
      if (!(await SB.needPin())) return;
      if (!(await SB.pinGate("Paying " + SB.money(f.price) + " for " + name))) return;

      await SB.runBusy("Making your card…", async function () {
        var newId = await Wallet.createCard(uid, name, selFinish, holder, f.price);
        if (firstCard) await Wallet.setActiveCard(uid, newId);
      }, name + " is ready!", null, ["Checking your balance…", "Making your card…", "Almost there…"]);
    });
  });

  // ---------- Look at one card ----------
  function clearTimer() {
    clearTimeout(timerId);
    timerId = null;
    $("cvTimer").classList.remove("run");
  }

  // Runs your function after 10 seconds, with a line shrinking across the bottom
  function startTimer(done) {
    clearTimer();
    var t = $("cvTimer");
    void t.offsetWidth;
    t.classList.add("run");
    timerId = setTimeout(function () { clearTimer(); done(); }, 10000);
  }

  function maskNumber() {
    revealed = false;
    if (cardRoot && current) cardRoot._num.textContent = maskedNumber(current);
    updateButtons();
  }

  function updateButtons() {
    if (!current) return;
    var active = SB.activeCard();
    var isActive = !!(active && active.id === current.id);
    $("cvUse").textContent = isActive ? "✓ Using this card" : "Use this card";
    $("cvUse").disabled = isActive;
    $("cvUse").classList.toggle("used-btn", isActive);
    $("cvFreeze").textContent = current.frozen ? "Unfreeze" : "Freeze";
    $("cvFreeze").classList.toggle("on", !!current.frozen);
    $("cvReveal").classList.toggle("on", revealed);
    $("cvDelete")._reset();
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
    updateButtons();
    SB.showView("vCard");
  }

  // A card changed online (frozen, in use...) while its sheet is open
  function refreshOpen() {
    var found = null;
    cards.forEach(function (c) { if (current && c.id === current.id) found = c; });
    if (!found) return;
    current = found;
    if (cardRoot) cardRoot.classList.toggle("frozen", !!current.frozen);
    updateButtons();
  }

  function setFlipped(flipped) {
    if (!cardRoot) return;
    cardRoot.classList.toggle("flipped", flipped);
    if (flipped) startTimer(function () { cardRoot.classList.remove("flipped"); if (revealed) maskNumber(); });
    else clearTimer();
  }

  $("cvFlip").addEventListener("click", function () {
    if (!cardRoot) return;
    var flipped = !cardRoot.classList.contains("flipped");
    setFlipped(flipped);
    if (!flipped && revealed) maskNumber();
  });

  // Tap the card itself to flip it too
  $("cvCard").addEventListener("click", function () { $("cvFlip").click(); });

  $("cvReveal").addEventListener("click", async function () {
    if (!current || !cardRoot) return;
    if (revealed) { clearTimer(); maskNumber(); setFlipped(false); return; }
    revealed = true;
    cardRoot._num.textContent = fullNumber(current);
    updateButtons();
    setFlipped(true); // the numbers are on the back, so show the back
    var ok = await SB.copyText(current.number);
    SB.toast(ok ? "Card number copied!" : "Number shown for 10 seconds");
  });

  $("cvUse").addEventListener("click", function () {
    if (!current) return;
    var c = current;
    Wallet.setActiveCard(SB.state.uid, c.id).then(
      function () { SB.toast("Now using " + c.name); },
      function (e) { SB.toast(Wallet.friendlyError(e)); }
    );
  });

  $("cvFreeze").addEventListener("click", function () {
    if (!current) return;
    var c = current;
    SB.flow(async function () {
      if (!(await SB.needPin())) return;
      if (!(await SB.pinGate((c.frozen ? "Unfreezing " : "Freezing ") + c.name))) return;
      await Wallet.setCardFrozen(SB.state.uid, c.id, !c.frozen);
      c.frozen = !c.frozen;
      openCard(c); // back to the card
      SB.toast(c.frozen ? "Card frozen ❄" : "Card unfrozen");
    });
  });

  SB.twoStep($("cvDelete"), "Tap again to delete", function () {
    if (!current) return;
    var c = current;
    SB.flow(async function () {
      if (!(await SB.needPin())) return;
      if (!(await SB.pinGate("Deleting " + c.name))) return;
      await Wallet.deleteCard(SB.state.uid, c.id);
      var active = SB.activeCard();
      if (active && active.id === c.id) await Wallet.setActiveCard(SB.state.uid, null);
      SB.closeSheet();
      SB.toast("Card deleted");
    });
  });

  // ---------- Wiring ----------
  SB.cards = {
    openNew: openNew,
    count: function () { return cards.length; },
    ready: function () { return cardsReady; }
  };

  SB.on("view", function (name) { viewing = name === "vCard"; });
  SB.on("sheetClosed", function () { viewing = false; clearTimer(); });
  SB.on("profile", renderCards);

  // If you have cards but none is picked, pick the first one
  function autoPick() {
    if (autoPicking || !cardsReady || !SB.state.profileLive || !cards.length || SB.activeCard()) return;
    autoPicking = true;
    Wallet.setActiveCard(SB.state.uid, cards[0].id).catch(function () {}).then(function () { autoPicking = false; });
  }

  SB.on("start", function (user) {
    cards = [];
    cardsReady = false;
    onboarded = false;
    renderCards();
    stopCards = Wallet.watchCards(user.uid, function (list) {
      cards = list;
      cardsReady = true;
      renderCards();
      autoPick();
      // A brand-new account makes its first card right away
      if (SB.features.requireCard && !onboarded && list.length === 0) {
        onboarded = true;
        setTimeout(function () {
          var sheetOpen = !$("sheet").classList.contains("hidden");
          if (!sheetOpen && cards.length === 0 && SB.state.uid) openNew(true);
        }, 900);
      }
    });
  });

  SB.on("stop", function () {
    if (stopCards) { stopCards(); stopCards = null; }
    cards = [];
    cardsReady = false;
    current = null;
    clearTimer();
  });
})();
