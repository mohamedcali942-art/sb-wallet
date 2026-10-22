// cards.js — SB Wallet cards: plans (daily or forever), colors, limits, lock-to, single-use, reissue,
// freeze (one or all), pay today's fee, and the card sheets. Attaches to window.SB.

(function () {
  if (!window.SB || !window.Wallet) return;
  var SB = window.SB;
  var $ = SB.$;
  var Wallet = window.Wallet;
  var R = Wallet.rules;

  var MAX_CARDS = 5;

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

  var cards = [];
  var cardsReady = false;
  var stopCards = null;
  var selFinish = "plain";
  var selPlan = "daily";
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
  function today() { return R.todayKey(); }
  function isOwner() { return SB.isOwnerAccount(); }
  function planPrice(plan) {
    if (isOwner()) return 0;
    return plan === "daily" ? Wallet.prices.daily : Wallet.prices.forever;
  }
  function colorPrice(finish) {
    if (isOwner() || finish === "plain") return 0;
    return Wallet.prices.color;
  }

  // The card you use (shown on receipts), or nothing
  SB.activeCard = function () {
    var p = SB.state.profile;
    if (!p || !p.activeCardId) return null;
    for (var i = 0; i < cards.length; i++) if (cards[i].id === p.activeCardId) return cards[i];
    return null;
  };
  SB.cardsList = function () { return cards.slice(); };
  SB.cardById = function (id) {
    for (var i = 0; i < cards.length; i++) if (cards[i].id === id) return cards[i];
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

  // The little "tap to pay" waves, drawn in the card's top-right corner
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

    var front = el("div", "bc-face bc-front fin-" + (card.finish || "plain"));
    front.appendChild(el("div", "bc-glare"));
    var top = el("div", "bc-top");
    top.appendChild(el("span", "bc-name", card.name));
    top.appendChild(brandEl(card.brand));
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

  // Short status words for a card: what is blocking it, or in use / ready
  function statusOf(c) {
    var why = R.lockReason(c, today());
    if (why) return why;
    var active = SB.activeCard();
    if (active && active.id === c.id) return "In use";
    return "Ready";
  }

  // ---------- Home: the list card of your cards ----------
  function renderHomeList() {
    var list = $("cardList");
    list.innerHTML = "";
    cards.forEach(function (c) {
      var b = el("button", "card-row");
      b.type = "button";
      b.appendChild(el("span", "q-av sm " + SB.colorClass(c.name), (c.name || "C").charAt(0).toUpperCase()));
      var info = el("span", "card-row-info");
      info.appendChild(el("span", "card-row-name", c.name));
      info.appendChild(el("span", "card-row-sub", "•••• " + c.last4 + " · " + statusOf(c)));
      b.appendChild(info);
      b.appendChild(el("span", "card-row-go", "›"));
      b.addEventListener("click", function () { openCard(c); });
      list.appendChild(b);
    });
    var empty = $("cardListEmpty");
    if (empty) empty.classList.toggle("hidden", cards.length > 0 || !cardsReady);
    $("cardsCount").textContent = cards.length ? cards.length + " of " + MAX_CARDS : "";
    var pill = $("heroCards");
    if (pill) pill.textContent = cards.length + (cards.length === 1 ? " card" : " cards");
    // The first-card step covers the app until you have one
    var gate = $("firstGate");
    if (gate) gate.classList.toggle("hidden", !(SB.features.requireCard && cardsReady && cards.length === 0 && SB.state.uid));
  }

  // Full list in the cards sheet
  function renderSheetList() {
    var box = $("cardsSheetList");
    if (!box) return;
    box.innerHTML = "";
    var active = SB.activeCard();
    cards.forEach(function (c) {
      var b = el("button", "card-btn");
      b.type = "button";
      b.appendChild(cardEl(c, { mini: true, badge: !!(active && active.id === c.id) }));
      b.appendChild(el("span", "card-btn-sub", statusOf(c)));
      b.addEventListener("click", function () { openCard(c); });
      box.appendChild(b);
    });
    var anyFrozen = cards.some(function (c) { return c.frozen; });
    $("freezeAllBtn").textContent = anyFrozen ? "Unfreeze all cards" : "Freeze all cards";
    $("freezeAllBtn").disabled = cards.length === 0;
    $("newCardFromSheet").disabled = cards.length >= MAX_CARDS;
  }

  // Banners for each daily card that is locked, with a tap-to-pay action
  function renderLockBanners() {
    var box = $("lockBanners");
    if (!box) return;
    box.innerHTML = "";
    cards.forEach(function (c) {
      if (!SB.isCardLocked(c) || c.frozen) return;
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

  function renderAll() {
    renderHomeList();
    renderSheetList();
    renderLockBanners();
    if (viewing && current) refreshOpen();
    SB.emit("cards", cards);
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

  function newCardTotal() { return planPrice(selPlan) + colorPrice(selFinish); }

  function renderPreview() {
    var box = $("newPreview");
    box.innerHTML = "";
    box.appendChild(cardEl(previewCard()));
    var total = newCardTotal();
    $("priceNote").textContent = total > 0 ? SB.money(total) + " from your balance" : "Free";
    $("issueBtn").textContent = total > 0 ? "Issue for " + SB.money(total) : "Issue Card Now";
    var planNote = $("planNote");
    if (planNote) {
      planNote.textContent = isOwner() ? "Owner cards are free and always forever."
        : selPlan === "daily" ? "Pay " + SB.money(Wallet.prices.daily) + " each day. Miss a day and the card locks until you pay."
        : "Pay " + SB.money(Wallet.prices.forever) + " once. It never locks for unpaid days.";
    }
  }

  function buildPlanPicker() {
    var grid = $("planGrid");
    grid.innerHTML = "";
    [
      { id: "daily", title: "Daily", sub: SB.money(Wallet.prices.daily) + " a day" },
      { id: "forever", title: "Forever", sub: SB.money(Wallet.prices.forever) + " once" }
    ].forEach(function (p) {
      var b = el("button", "plan-opt" + (p.id === selPlan ? " sel" : ""));
      b.type = "button";
      b.appendChild(el("b", "", p.title));
      b.appendChild(el("span", "", isOwner() ? "Free" : p.sub));
      b.addEventListener("click", function () { selPlan = p.id; buildPlanPicker(); renderPreview(); });
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
    if (cards.length >= MAX_CARDS) { SB.toast("You can have up to " + MAX_CARDS + " cards."); return; }
    selFinish = "plain";
    selPlan = "daily";
    $("cardNick").value = "";
    $("newTitle").textContent = first ? "Make your first card" : "New SB Card";
    buildPlanPicker();
    buildPicker();
    renderPreview();
    SB.showView("vCardNew");
  }

  $("cardNick").addEventListener("input", renderPreview);

  $("issueBtn").addEventListener("click", function () {
    SB.flow(async function () {
      if (!SB.state.profileLive) { SB.toast("Still loading your account. One moment."); return; }
      if (cards.length >= MAX_CARDS) { SB.toast("You can have up to " + MAX_CARDS + " cards."); return; }
      var total = newCardTotal();
      var name = $("cardNick").value.trim() || finishById(selFinish).label;
      var holder = SB.fullName(SB.state.profile).toUpperCase();
      var plan = selPlan;
      var finish = selFinish;
      var firstCard = cards.length === 0 || !SB.activeCard();
      var uid = SB.state.uid;
      var ownerUid = SB.state.feeOwner;

      if (total <= 0) {
        var id = await Wallet.createCard(uid, name, holder, plan, ownerUid, finish);
        if (firstCard) await Wallet.setActiveCard(uid, id);
        SB.chime();
        SB.closeSheet();
        SB.toast("Card issued!");
        return;
      }

      if ((SB.state.profile.balance || 0) < total) {
        SB.toast("You need " + SB.money(total) + " for this card.");
        return;
      }
      if (!(await SB.needPin())) return;
      if (!(await SB.pinGate("Paying " + SB.money(total) + " for " + name))) return;

      await SB.runBusy("Making your card…", async function () {
        var newId = await Wallet.createCard(uid, name, holder, plan, ownerUid, finish);
        if (firstCard) await Wallet.setActiveCard(uid, newId);
      }, name + " is ready!", null, ["Checking your balance…", "Making your card…", "Almost there…"]);
    });
  });

  // ===== PART B (card sheet, actions, wiring) follows in _cards_b.js =====
  // ---------- Pay today's fee (daily cards) ----------
  // Pays unpaid days plus today's fee, which unlocks the card. Does nothing if you can't afford it.
  function payCard(c) {
    var card = SB.cardById(c.id) || c;
    var due = R.payDue(card, today());
    if (due <= 0) { SB.toast("Nothing to pay on " + card.name + "."); return; }
    if ((SB.state.profile.balance || 0) < due) {
      SB.toast("You need " + SB.money(due) + " to pay this.");
      return;
    }
    SB.flow(async function () {
      if (!(await SB.needPin())) return;
      if (!(await SB.pinGate("Paying " + SB.money(due) + " for " + card.name))) return;
      await SB.runBusy("Paying…", function () {
        return Wallet.payCardToday(SB.state.uid, SB.state.feeOwner, card.id);
      }, card.name + " is unlocked!", null, ["Checking your balance…", "Paying the card fee…", "Almost there…"]);
    });
  }
  SB.payCard = payCard;

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
    var c = current;
    var active = SB.activeCard();
    var isActive = !!(active && active.id === c.id);
    $("cvUse").textContent = isActive ? "✓ Using this card" : "Use this card";
    $("cvUse").disabled = isActive;
    $("cvUse").classList.toggle("used-btn", isActive);
    $("cvFreeze").textContent = c.frozen ? "Unfreeze" : "Freeze";
    $("cvFreeze").classList.toggle("on", !!c.frozen);
    $("cvReveal").classList.toggle("on", revealed);

    // Status line: what is blocking the card, if anything
    var why = R.lockReason(c, today());
    $("cvStatus").textContent = why ? why : (isActive ? "This is the card you are using." : "Ready to use.");
    $("cvStatus").classList.toggle("bad", !!why);

    // Pay box: only for daily cards that are locked by debt or today's fee
    var payable = c.plan === "daily" && !c.frozen && SB.isCardLocked(c);
    $("cvPayBox").classList.toggle("hidden", !payable);
    if (payable) $("cvPayText").textContent = "Pay " + SB.money(R.payDue(c, today())) + " to unlock";

    $("cvSingle").textContent = c.singleUse ? "Single-use: on" : "Single-use: off";
    $("cvSingle").classList.toggle("on", !!c.singleUse);
    $("cvLimitNow").textContent = "Limit " + (c.limit ? SB.money(c.limit) + " a day" : "none")
      + " · spent today " + SB.money(SB.spentToday ? SB.spentToday(c.id) : 0);
    $("cvLockNow").textContent = c.lockTo ? "Only pays ID " + SB.prettyId(c.lockTo) : "Pays anyone";
    $("cvReissueNow").textContent = c.reissued ? "Reissued " + c.reissued + (c.reissued === 1 ? " time" : " times") : "Not reissued yet";
    buildCardColors();
    $("cvDelete")._reset();
  }

  // The colors row: tap a color you own to switch to it, tap one you don't own to buy it
  function buildCardColors() {
    var box = $("cvColors");
    box.innerHTML = "";
    if (!current) return;
    FINISHES.forEach(function (f) {
      var owned = Wallet.ownsFinish(current, f.id);
      var b = el("button", "fin-opt" + (current.finish === f.id ? " sel" : "") + (owned ? "" : " locked"));
      b.type = "button";
      b.setAttribute("aria-label", f.label + (owned ? "" : ", buy for " + SB.money(colorPrice(f.id))));
      b.appendChild(el("span", "fin-dot fin-" + f.id));
      b.appendChild(el("span", "", owned ? f.short : SB.money(colorPrice(f.id)) ));
      b.addEventListener("click", function () { changeColor(f); });
      box.appendChild(b);
    });
  }

  function changeColor(f) {
    var c = current;
    if (!c) return;
    if (Wallet.ownsFinish(c, f.id)) {
      if (c.finish === f.id) return;
      Wallet.setCardFinish(SB.state.uid, c.id, f.id).then(function () {
        SB.toast(f.label + " color on");
      }, function (e) { SB.toast(Wallet.friendlyError(e)); });
      return;
    }
    var price = colorPrice(f.id);
    if ((SB.state.profile.balance || 0) < price) { SB.toast("You need " + SB.money(price) + " for this color."); return; }
    SB.flow(async function () {
      if (!(await SB.needPin())) return;
      if (!(await SB.pinGate("Buying " + f.label + " for " + SB.money(price)))) return;
      await SB.runBusy("Adding the color…", function () {
        return Wallet.buyColor(SB.state.uid, SB.state.feeOwner, c.id, f.id);
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
    SB.showView("vCard");
  }

  // The card changed online (frozen, in use, paid...) while its sheet is open
  function refreshOpen() {
    var found = SB.cardById(current.id);
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

  // Reveal numbers. With "Require Face ID" on, the device asks first (PIN if the device can't).
  async function allowReveal() {
    if (!SB.faceOn || !SB.faceOn()) return true;
    var result = await SB.verifyFace();
    if (result === "ok") return true;
    if (result === "unavailable") return SB.pinGate("Showing card numbers");
    SB.toast("Face ID didn't match. Numbers stay hidden.");
    return false;
  }

  $("cvReveal").addEventListener("click", async function () {
    if (!current || !cardRoot) return;
    if (revealed) { clearTimer(); maskNumber(); setFlipped(false); return; }
    if (!(await allowReveal())) return;
    if (!current || !cardRoot) return;
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

  $("cvPay").addEventListener("click", function () { if (current) payCard(current); });

  $("cvFreeze").addEventListener("click", function () {
    if (!current) return;
    var c = current;
    if (c.freezeReason === "used") { SB.toast("This card was used once. Reissue it to use it again."); return; }
    SB.flow(async function () {
      if (!(await SB.needPin())) return;
      if (!(await SB.pinGate((c.frozen ? "Unfreezing " : "Freezing ") + c.name))) return;
      await Wallet.setCardFrozen(SB.state.uid, c.id, !c.frozen);
      SB.toast(c.frozen ? "Card unfrozen" : "Card frozen ❄");
    });
  });

  // Freeze every card at once, or unfreeze them all
  $("freezeAllBtn").addEventListener("click", function () {
    var anyFrozen = cards.some(function (c) { return c.frozen; });
    SB.flow(async function () {
      if (!(await SB.needPin())) return;
      if (!(await SB.pinGate(anyFrozen ? "Unfreezing all cards" : "Freezing all cards"))) return;
      await Wallet.freezeAllCards(SB.state.uid, !anyFrozen);
      SB.toast(anyFrozen ? "All cards unfrozen" : "All cards frozen ❄");
    });
  });

  $("cvLimitBtn").addEventListener("click", function () {
    if (!current) return;
    var v = parseFloat($("cvLimitInput").value);
    if (isNaN(v) || v < 0) v = 0;
    Wallet.setCardLimit(SB.state.uid, current.id, v).then(
      function () { SB.toast(v > 0 ? "Daily limit set to " + SB.money(v) : "No daily limit"); },
      function (e) { SB.toast(Wallet.friendlyError(e)); }
    );
  });

  $("cvLockBtn").addEventListener("click", function () {
    if (!current) return;
    var id = SB.cleanId($("cvLockInput").value);
    if ($("cvLockInput").value.trim() && id.length !== 8) { SB.toast("Type an 8-digit ID number, or leave it empty."); return; }
    Wallet.setLockTo(SB.state.uid, current.id, id || null).then(
      function () { SB.toast(id ? "This card now only pays " + SB.prettyId(id) : "This card pays anyone"); },
      function (e) { SB.toast(Wallet.friendlyError(e)); }
    );
  });

  $("cvRenameBtn").addEventListener("click", function () {
    if (!current) return;
    var name = $("cvRename").value.trim();
    if (!name) { SB.toast("Type a new name first."); return; }
    Wallet.renameCard(SB.state.uid, current.id, name.slice(0, 20)).then(function () {
      $("cvRename").value = "";
      SB.toast("Card renamed");
    }, function (e) { SB.toast(Wallet.friendlyError(e)); });
  });

  $("cvSingle").addEventListener("click", function () {
    if (!current) return;
    var on = !current.singleUse;
    Wallet.setSingleUse(SB.state.uid, current.id, on).then(
      function () { SB.toast(on ? "Single-use on: the card freezes after one payment" : "Single-use off"); },
      function (e) { SB.toast(Wallet.friendlyError(e)); }
    );
  });

  $("cvReissue").addEventListener("click", function () {
    if (!current) return;
    var c = current;
    SB.flow(async function () {
      if (!(await SB.needPin())) return;
      if (!(await SB.pinGate("New number for " + c.name))) return;
      await Wallet.reissueCard(SB.state.uid, c.id);
      SB.toast("New card number and CVV made");
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

  // ---------- Sheets that list cards ----------
  function openCardsSheet() {
    renderSheetList();
    SB.showView("vCards");
  }
  $("seeAllCards").addEventListener("click", openCardsSheet);
  $("newCardFromSheet").addEventListener("click", function () { openNew(false); });
  $("firstGateBtn").addEventListener("click", function () { openNew(true); });

  // ---------- Wiring ----------
  SB.cards = {
    openNew: openNew,
    openList: openCardsSheet,
    count: function () { return cards.length; },
    ready: function () { return cardsReady; }
  };

  SB.on("view", function (name) { viewing = name === "vCard"; });
  SB.on("sheetClosed", function () { viewing = false; clearTimer(); });
  SB.on("profile", renderAll);
  SB.on("spend", function () { if (viewing && current) updateButtons(); });
  SB.on("tick", function () { renderAll(); });

  // If you have cards but none is picked, pick the first one
  function autoPick() {
    if (autoPicking || !cardsReady || !SB.state.profileLive || !cards.length || SB.activeCard()) return;
    autoPicking = true;
    Wallet.setActiveCard(SB.state.uid, cards[0].id).catch(function () {}).then(function () { autoPicking = false; });
  }

  SB.on("start", function (user) {
    cards = [];
    cardsReady = false;
    renderAll();
    stopCards = Wallet.watchCards(user.uid, function (list) {
      cards = list;
      cardsReady = true;
      renderAll();
      autoPick();
    });
  });

  SB.on("stop", function () {
    if (stopCards) { stopCards(); stopCards = null; }
    cards = [];
    cardsReady = false;
    current = null;
    clearTimer();
    renderAll();
  });
})();
