// screens.js — SB Wallet screens: Scan (your QR code + camera reader), Analytics (donut, 7-day bars,
// per-card breakdown) and the History cards. Loaded last; attaches to window.SB.

(function () {
  if (!window.SB || !window.Wallet) return;
  var SB = window.SB;
  var $ = SB.$;
  var R = window.SBRules;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function svgIcon(d, size) {
    var NS = "http://www.w3.org/2000/svg";
    var s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("width", size || 14);
    s.setAttribute("height", size || 14);
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    s.innerHTML = d;
    return s;
  }
  var CLOCK = '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>';
  var CAL = '<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>';

  function dateOfRec(t) {
    if (t.createdAt && t.createdAt.toDate) return t.createdAt.toDate();
    if (t.createdMs) return new Date(t.createdMs);
    return new Date();
  }
  function money(n) { return SB.money(Math.round(n * 100) / 100); }

  // ---------- History card ----------
  var TYPE_WORD = { send: "Sent", receive: "Received", fee: "Fee", card: "Card", fund: "Added" };
  var TYPE_CLASS = { send: "t-sent", receive: "t-recv", fee: "t-fee", card: "t-card", fund: "t-recv" };

  // One receipt as a rounded card: colored header tab, time and date, title, amount chips, total footer
  SB.buildHistoryCard = function (t) {
    var d = dateOfRec(t);
    var kind = t.type || "send";
    var out = t.amount < 0;
    var card = el("button", "hcard");
    card.type = "button";

    var head = el("div", "hc-head " + (TYPE_CLASS[kind] || "t-sent"));
    head.appendChild(el("span", "hc-type", TYPE_WORD[kind] || "Payment"));
    var when = el("span", "hc-when");
    when.appendChild(svgIcon(CLOCK, 13));
    when.appendChild(el("span", "", d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })));
    var date = el("span", "hc-when");
    date.appendChild(svgIcon(CAL, 13));
    date.appendChild(el("span", "", d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })));
    head.appendChild(when);
    head.appendChild(date);
    card.appendChild(head);

    var body = el("div", "hc-body");
    body.appendChild(el("p", "hc-title", t.title || "Transaction"));
    var chips = el("div", "hc-chips");
    chips.appendChild(el("span", "hc-chip", (out ? "-" : "+") + SB.money(Math.abs(t.amount))));
    if (kind === "send" && t.fee > 0) chips.appendChild(el("span", "hc-chip soft", "Fee " + SB.money(t.fee)));
    if (t.cardName) chips.appendChild(el("span", "hc-chip soft", t.cardName));
    body.appendChild(chips);
    card.appendChild(body);

    var foot = el("div", "hc-foot");
    var total = kind === "send" ? (t.sent || 0) + (t.fee || 0) : Math.abs(t.amount);
    foot.appendChild(el("span", "", out ? "Total out" : "Total in"));
    foot.appendChild(el("b", "", SB.money(total)));
    card.appendChild(foot);

    card.addEventListener("click", function () { SB.openReceipt(t); });
    return card;
  };

  // ---------- Scan: your code, and a camera reader ----------
  var stream = null;
  var rafId = null;

  function renderMyCode() {
    var p = SB.state.profile;
    var id = p ? SB.cleanId(p.accountId) : "";
    var box = $("qrBox");
    box.innerHTML = "";
    $("myIdText").textContent = id ? SB.prettyId(id) : "—";
    if (!id) return;
    if (typeof window.qrcode === "function") {
      try {
        var qr = window.qrcode(0, "M");
        qr.addData(id);
        qr.make();
        box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2 });
        var svg = box.querySelector("svg");
        if (svg) { svg.setAttribute("class", "qr-svg"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Your ID number as a code"); }
        return;
      } catch (e) { /* fall through to the text note */ }
    }
    box.appendChild(el("p", "muted small", "The code needs internet. Your ID number is below."));
  }

  function setScanButton(on) { $("scanStart").textContent = on ? "Stop camera" : "Open camera"; }

  function stopScan() {
    cancelAnimationFrame(rafId);
    rafId = null;
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    var v = $("scanVideo");
    v.srcObject = null;
    setScanButton(false);
  }

  function scanLoop() {
    if (!stream) return;
    var v = $("scanVideo");
    var c = $("scanCanvas");
    if (v.readyState === v.HAVE_ENOUGH_DATA && v.videoWidth) {
      var w = v.videoWidth, h = v.videoHeight;
      c.width = w;
      c.height = h;
      var g = c.getContext("2d");
      g.drawImage(v, 0, 0, w, h);
      var img = g.getImageData(0, 0, w, h);
      var code = window.jsQR ? window.jsQR(img.data, w, h) : null;
      if (code && code.data) {
        var id = SB.cleanId(code.data);
        var mine = SB.state.profile ? SB.cleanId(SB.state.profile.accountId) : "";
        if (id.length === 8 && id === mine) {
          $("scanMsg").textContent = "That's your own code. Show it to someone else.";
        } else if (id.length === 8) {
          stopScan();
          $("scanMsg").textContent = "Found an ID number.";
          SB.startSend(id);
          return;
        } else {
          $("scanMsg").textContent = "That code isn't an SB Wallet ID number.";
        }
      }
    }
    rafId = requestAnimationFrame(scanLoop);
  }

  async function startScan() {
    var msg = $("scanMsg");
    if (!window.jsQR) { msg.textContent = "The code reader didn't load. Check your internet, or give your ID number instead."; return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      msg.textContent = "This browser can't open the camera. Give your ID number instead.";
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    } catch (e) {
      stream = null;
      msg.textContent = e && e.name === "NotAllowedError"
        ? "Camera access is blocked. Allow the camera in your settings, or give your ID number instead."
        : "No camera found. Give your ID number instead.";
      return;
    }
    var v = $("scanVideo");
    v.srcObject = stream;
    try { await v.play(); } catch (e) {}
    setScanButton(true);
    msg.textContent = "Point the camera at a code.";
    scanLoop();
  }

  $("scanStart").addEventListener("click", function () {
    if (stream) stopScan(); else startScan();
  });
  $("scanCopy").addEventListener("click", function () { SB.copyMyId(); });

  // ---------- Analytics ----------
  // Uses the saved per-day totals (they stay after receipts are cleaned up)
  function dayStats() {
    var p = SB.state.profile;
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
    // background ring
    var base = document.createElementNS(NS, "circle");
    base.setAttribute("cx", "50"); base.setAttribute("cy", "50"); base.setAttribute("r", "40");
    base.setAttribute("style", "stroke:#DCE8F7;opacity:.5");
    base.setAttribute("stroke-width", "15");
    base.setAttribute("fill", "none");
    svg.appendChild(base);
    if (total <= 0) return;
    var parts = [
      { v: sent, color: "#1E3A66" },
      { v: recv, color: "#7FB8F0" },
      { v: fees, color: "#3B82F6" }
    ];
    var offset = 0;
    parts.forEach(function (p) {
      if (p.v <= 0) return;
      var len = (p.v / total) * C;
      var c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", "50"); c.setAttribute("cy", "50"); c.setAttribute("r", "40");
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
    if (!SB.state.uid) return;
    var stats = dayStats();
    var month = R.todayKey().slice(0, 7);
    var sent = 0, recv = 0, fees = 0;
    Object.keys(stats).forEach(function (day) {
      if (day.indexOf(month) !== 0) return;
      var d = stats[day] || {};
      sent += d.sent || 0;
      recv += d.in || 0;
      fees += (d.fee || 0) + (d.feesIn || 0);
    });
    sent = Math.round(sent * 100) / 100;
    recv = Math.round(recv * 100) / 100;
    fees = Math.round(fees * 100) / 100;

    $("donutTotal").textContent = SB.money(Math.round(sent));
    renderDonut(sent, recv, fees);

    var legend = $("legend");
    legend.innerHTML = "";
    [["Sent", sent, "#1E3A66"], ["Received", recv, "#7FB8F0"], ["Fees", fees, "#3B82F6"]].forEach(function (row) {
      var line = el("div", "");
      line.appendChild(el("i", ""));
      line.lastChild.style.background = row[2];
      line.appendChild(el("span", "", money(row[1])));
      line.insertBefore(el("b", "", row[0]), line.lastChild);
      legend.appendChild(line);
    });

    // Last 7 days: sent (navy) and received (light blue)
    var days = [];
    for (var i = 6; i >= 0; i--) days.push(keyDaysAgo(i));
    var max = 1;
    days.forEach(function (k) { var d = stats[k] || {}; max = Math.max(max, d.sent || 0, d.in || 0); });
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

    // Per card: this month's sends, from the card's own totals
    var box = $("cardBreakdown");
    box.innerHTML = "";
    var list = SB.cardsList ? SB.cardsList() : [];
    if (!list.length) box.appendChild(el("p", "muted small", "No cards yet."));
    var top = 1;
    list.forEach(function (c) { top = Math.max(top, c.spendMonth === month ? (c.spentMonth || 0) : 0); });
    list.forEach(function (c) {
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

  SB.on("profile", function () { renderMyCode(); renderAnalytics(); });
  SB.on("cards", renderAnalytics);
  SB.on("receipts", renderAnalytics);
  SB.on("tick", renderAnalytics);
  SB.on("tab", function (name) {
    if (name !== "scan") stopScan();
    if (name === "scan") renderMyCode();
    if (name === "analytics") renderAnalytics();
  });
  SB.on("view", function () { /* sheets open over tabs; the camera keeps its place */ });
  SB.on("stop", function () {
    stopScan();
    $("qrBox").innerHTML = "";
    $("myIdText").textContent = "—";
  });
})();
