// chat.js — SB Wallet messages: message a real person by username, see your chats, get alerts.

(function () {
  if (!window.SB || !window.Wallet) return;
  var SB = window.SB;
  var $ = SB.$;
  var Wallet = window.Wallet;

  var chats = [];
  var stopChats = null;
  var baseline = false;
  var prevUnread = {};
  var thread = null;   // { id, other: { uid, firstName, lastName, username } }
  var stopMsgs = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function lastAtMs(chat) {
    return chat.lastAt && chat.lastAt.toDate ? chat.lastAt.toDate().getTime() : Date.now();
  }

  // The other person in a chat
  function otherOf(chat) {
    var uid = SB.state.uid;
    var ou = (chat.members || []).filter(function (m) { return m !== uid; })[0];
    var full = (chat.names && chat.names[ou]) || "Someone";
    var parts = full.split(" ");
    return {
      uid: ou,
      firstName: parts[0],
      lastName: parts.slice(1).join(" "),
      username: (chat.usernames && chat.usernames[ou]) || ""
    };
  }

  function unreadOf(chat) {
    return (chat.unread && chat.unread[SB.state.uid]) || 0;
  }

  // ---------- Chat list ----------
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
      row.appendChild(el("div", "q-av sm " + SB.colorClass(other.firstName), other.firstName.charAt(0).toUpperCase()));

      var info = el("div", "chat-info");
      info.appendChild(el("p", "chat-name", SB.fullName(other)));
      var mine = chat.lastFrom === SB.state.uid;
      info.appendChild(el("p", "chat-last", (mine ? "You: " : "") + (chat.lastMessage || "")));
      row.appendChild(info);

      var side = el("div", "chat-side");
      side.appendChild(el("span", "", SB.timeAgo(lastAtMs(chat))));
      if (unread > 0) side.appendChild(el("span", "unread-dot", String(unread)));
      row.appendChild(side);

      row.addEventListener("click", function () { openThread(other); });
      box.appendChild(row);
    });

    $("chatEmpty").classList.toggle("hidden", sorted.length > 0);
    $("msgBadge").textContent = total;
    $("msgBadge").classList.toggle("hidden", total === 0);
  }

  // ---------- Conversation ----------
  function fitThread() {
    var t = $("thread");
    var vv = window.visualViewport;
    if (!vv) { t.style.height = "100%"; return; }
    t.style.height = vv.height + "px"; // shrinks when the keyboard opens
    t.style.top = vv.offsetTop + "px";
    var list = $("msgList");
    list.scrollTop = list.scrollHeight;
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", function () { if (thread) fitThread(); });
    window.visualViewport.addEventListener("scroll", function () { if (thread) fitThread(); });
  }

  function timeText(m) {
    var d = m.createdAt && m.createdAt.toDate ? m.createdAt.toDate() : new Date();
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  function renderMessages(list) {
    var box = $("msgList");
    box.innerHTML = "";
    if (!list.length) {
      box.appendChild(el("p", "msg-empty", "Say hi to " + (thread ? thread.other.firstName : "them") + " 👋"));
      return;
    }
    list.forEach(function (m) {
      var b = el("div", "bubble " + (m.from === SB.state.uid ? "me" : "them"));
      b.appendChild(document.createTextNode(m.text));
      b.appendChild(el("small", "", timeText(m)));
      box.appendChild(b);
    });
    box.scrollTop = box.scrollHeight;
  }

  function openThread(person) {
    if (!SB.state.uid) return;
    SB.openTab("messages");
    var id = Wallet.chatId(SB.state.uid, person.uid);
    if (stopMsgs) { stopMsgs(); stopMsgs = null; }
    thread = { id: id, other: person };

    $("thName").textContent = SB.fullName(person);
    $("thUser").textContent = person.username;
    $("thAv").textContent = person.firstName.charAt(0).toUpperCase();
    $("thAv").className = "q-av sm " + SB.colorClass(person.firstName);
    $("msgInput").value = "";
    renderMessages([]);

    $("thread").classList.remove("hidden");
    SB.lockScroll();
    fitThread();

    stopMsgs = Wallet.watchMessages(id, function (list) {
      if (!thread || thread.id !== id) return;
      renderMessages(list);
      if (list.length && list[list.length - 1].from !== SB.state.uid) Wallet.markRead(SB.state.uid, id);
    });
    Wallet.markRead(SB.state.uid, id);
  }

  function closeThread() {
    if (stopMsgs) { stopMsgs(); stopMsgs = null; }
    var was = thread;
    thread = null;
    $("msgInput").blur();
    $("thread").classList.add("hidden");
    if (was) SB.unlockScroll();
  }

  $("thBack").addEventListener("click", closeThread);

  // Keep the keyboard open when you tap Send
  $("msgSend").addEventListener("pointerdown", function (e) { e.preventDefault(); });
  $("msgSend").addEventListener("mousedown", function (e) { e.preventDefault(); });

  $("msgForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var text = $("msgInput").value.trim();
    if (!text || !thread || !SB.state.profile) return;
    $("msgInput").value = "";
    var p = SB.state.profile;
    var me = { uid: SB.state.uid, name: SB.fullName(p), username: p.username };
    var other = { uid: thread.other.uid, name: SB.fullName(thread.other), username: thread.other.username };
    Wallet.sendMessage(me, other, text).catch(function (err) { SB.toast(Wallet.friendlyError(err)); });
  });

  // ---------- Start a chat ----------
  function newMessage() {
    SB.flow(async function () {
      if (!SB.state.profileLive) { SB.toast("Still loading your account. One moment."); return; }
      var person = await SB.askPerson("", {
        title: "New message",
        sub: "Type the username of the person you want to message.",
        button: "Message"
      });
      if (!person) return;
      SB.closeSheet();
      setTimeout(function () { openThread(person); }, 290);
    });
  }

  function openWith(username) {
    Wallet.findUser(username).then(function (p) {
      if (!p) SB.toast("No account with that username.");
      else if (p.uid === SB.state.uid) SB.toast("That's you!");
      else openThread(p);
    }, function (e) { SB.toast(Wallet.friendlyError(e)); });
  }

  $("newMsgBtn").addEventListener("click", newMessage);
  $("msgMiniTile").addEventListener("click", newMessage);

  SB.chat = { openWith: openWith, openThread: openThread };

  // ---------- Wiring: live chats + alerts ----------
  SB.on("start", function (user) {
    chats = [];
    baseline = false;
    prevUnread = {};
    renderChats();
    stopChats = Wallet.watchChats(user.uid, function (list) {
      chats = list;
      list.forEach(function (chat) {
        var unread = unreadOf(chat);
        var before = prevUnread[chat.id] || 0;
        prevUnread[chat.id] = unread;
        if (thread && thread.id === chat.id) {
          if (unread > 0) Wallet.markRead(SB.state.uid, chat.id);
          return;
        }
        if (baseline && unread > before) {
          var other = otherOf(chat);
          SB.notify({
            title: SB.fullName(other),
            body: chat.lastMessage || "New message",
            icon: "✉",
            onTap: function () { openThread(other); }
          });
        }
      });
      baseline = true;
      renderChats();
    });
  });

  SB.on("stop", function () {
    if (stopChats) { stopChats(); stopChats = null; }
    closeThread();
    chats = [];
    renderChats();
  });
})();
