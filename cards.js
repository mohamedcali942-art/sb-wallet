// cards.js — SB Wallet cards: make several cards, pick the one you use, flip it, reveal it, freeze it.
// All cards share your one wallet balance. The card you pick is shown on your receipts.

(function () {
  if (!window.SB || !window.Wallet) return;
  var SB = window.SB;
  var $ = SB.$;
  var Wallet = window.Wallet;

  var MAX_CARDS = 5;
  var FINISHES = [
    { id: "ocean", label: "Ocean Blue", premium: false },
    { id: "forest", label: "Forest Green", premium: false },
    { id: "bronze", label: "Sunset Bronze", premium: false },
    { id: "holo", label: "Holographic Blue", premium: true },
    { id: "silver", label: "Metallic Silver", premium: true },
    { id: "obsidian", label: "Obsidian Black", premium: true }
  ];

  var cards = [];
  var stopCards = null;
  var selFinish = "ocean";
  var current = null;      // the card open in the card sheet
  var cardRoot = null;     // its element
  var revealed = false;
  var viewing = false;
  var timerId = null;

  function finishLabel(id) {
    for (var i = 0; i < FINISHES.length; i++) if (FINISHES[i].id === id) return FINISHES[i].label;
    return "SB Card";
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

  // opts: { mini, badge }
  function cardEl(card, opts) {
    opts = opts || {};
    var root = el("div", "bank-card" + (opts.mini ? " mini" : "") + (card.frozen ? " frozen" : ""));
    var inner = el("div", "bc-inner");

    var front = el("div", "bc-face bc-front fin-" + card.finish);
    var top = el("div", "bc-top");
    top.appendChild(el("span", "bc-name", card.name));
    top.appendChild(brandEl(card.brand));
    var num = el("p", "bc-num", maskedNumber(card));
    var bot = el("div", "bc-bot");
    bot.appendChild(el("span", "bc-holder", card.holder || ""));
    bot.appendChild(el("span", "bc-exp", card.expMonth + "/" + card.expYear));
    front.appendChild(top);
    front.appendChild(num);
    front.appendChild(bot);
    front.appendChild(el("div", "bc-frozen", "FROZEN ❄"));
    if (opts.badge) front.appendChild(el("span", "bc-badge", "IN USE"));
    inner.appendChild(front);

    if (!opts.mini) {
      var back = el("div", "bc-face bc-back");
      back.appendChild(el("div", "bc-strip"));
      var sig = el("div", "bc-sig");
      sig.appendChild(document.createElement("i"));
      sig.appendChild(el("span", "bc-cvv", card.cvv));
      back.appendChild(sig);
      back.appendChild(el("p", "bc-note", "SB Wallet fake card. Not real money."));
      inner.appendChild(back);
    }

    root.appendChild(inner);
    root._num = num;
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
    add.appendChild(el("span", "", "Issue SB Card"));
    add.addEventListener("click", openNew);
    row.appendChild(add);

    $("cardsCount").textContent = cards.length ? cards.length + " of " + MAX_CARDS : "";

    // The big wallet card wears the colors of the card you use
    $("walletCard").className = "wallet-card fin-" + (active ? active.finish : "ocean");

    if (viewing && current) refreshOpen();
  }

  // ---------- Make a new card ----------
  function previewCard() {
    var nick = $("cardNick").value.trim();
    var p = SB.state.profile;
    return {
      name: nick || finishLabel(selFinish),
      finish: selFinish,
      brand: "mastercard",
      number: "9000000000000000",
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
  }

  function buildPickers() {
    var free = $("finFree");
    var prem = $("finPrem");
    free.innerHTML = "";
    prem.innerHTML = "";
    FINISHES.forEach(function (f) {
      var b = el("button", "fin-dot fin-" + f.id + (f.id === selFinish ? " sel" : ""));
      b.type = "button";
      b.setAttribute("aria-label", f.label);
      if (f.premium) b.appendChild(el("span", "star", "★"));
      b.addEventListener("click", function () {
        selFinish = f.id;
        buildPickers();
        renderPreview();
      });
      (f.premium ? prem : free).appendChild(b);
    });
  }

  function openNew() {
    if (cards.length >= MAX_CARDS) { SB.toast("You can have up to " + MAX_CARDS + " cards."); return; }
    selFinish = "ocean";
    $("cardNick").value = "";
    buildPickers();
    renderPreview();
    SB.showView("vCardNew");
  }

  $("cardNick").addEventListener("input", renderPreview);

  $("issueBtn").addEventListener("click", function () {
    SB.flow(async function () {
      if (!SB.state.profileLive) { SB.toast("Still loading your account. One moment."); return; }
      var name = $("cardNick").value.trim() || finishLabel(selFinish);
      var holder = SB.fullName(SB.state.profile).toUpperCase();
      var firstCard = cards.length === 0 || !SB.activeCard();
      var id = await Wallet.createCard(SB.state.uid, name, selFinish, holder);
      if (firstCard) await Wallet.setActiveCard(SB.state.uid, id);
      SB.chime();
      SB.closeSheet();
      SB.toast("Card issued!");
    });
  });

  // ---------- Look at one card ----------
  function clearTimer() {
    clearTimeout(timerId);
    timerId = null;
    var t = $("cvTimer");
    t.classList.remove("run");
  }

  // Runs your function after 10 seconds, with a line shrinking across the top
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
    cardRoot.addEventListener("click", toggleFlip);
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

  function toggleFlip() {
    if (!cardRoot) return;
    var flipped = cardRoot.classList.toggle("flipped");
    if (flipped) startTimer(function () { cardRoot.classList.remove("flipped"); });
    else clearTimer();
  }

  $("cvFlip").addEventListener("click", toggleFlip);

  $("cvReveal").addEventListener("click", async function () {
    if (!current || !cardRoot) return;
    if (revealed) { clearTimer(); maskNumber(); return; }
    revealed = true;
    cardRoot._num.textContent = fullNumber(current);
    updateButtons();
    var ok = await SB.copyText(current.number);
    SB.toast(ok ? "Card number copied!" : "Number shown for 10 seconds");
    startTimer(maskNumber);
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
  SB.on("view", function (name) { viewing = name === "vCard"; });
  SB.on("sheetClosed", function () { viewing = false; clearTimer(); });
  SB.on("profile", renderCards);

  SB.on("start", function (user) {
    cards = [];
    renderCards();
    stopCards = Wallet.watchCards(user.uid, function (list) {
      cards = list;
      renderCards();
    });
  });

  SB.on("stop", function () {
    if (stopCards) { stopCards(); stopCards = null; }
    cards = [];
    current = null;
    clearTimer();
  });
})();
