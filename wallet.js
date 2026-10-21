// wallet.js — SB Wallet: talks to Firebase (accounts, ID numbers, money, fees, requests, cards, messages).
// FAKE money only. Uses the "compat" Firebase scripts loaded in index.html.

(function () {
  // If the Firebase scripts did not load (no internet), tell app.js
  if (typeof firebase === "undefined") {
    window.Wallet = null;
    return;
  }

  // Your Firebase connection details
  var firebaseConfig = {
    apiKey: "AIzaSyD_xa3e_3RF6KHyG_2zWTbUT8XlktIzKeQ",
    authDomain: "sb-wallet-ac9a5.firebaseapp.com",
    projectId: "sb-wallet-ac9a5",
    storageBucket: "sb-wallet-ac9a5.firebasestorage.app",
    messagingSenderId: "288967357102",
    appId: "1:288967357102:web:bad81a02db85f0817d733f"
  };

  firebase.initializeApp(firebaseConfig);
  var auth = firebase.auth();
  var db = firebase.firestore();
  // Faster, steadier connection on phones and in-app browsers
  try { db.settings({ experimentalAutoDetectLongPolling: true }); } catch (e) {}
  // Keep a copy on the phone so data shows up right away next time
  try { db.enablePersistence({ synchronizeTabs: true }).catch(function () {}); } catch (e) {}

  var FV = firebase.firestore.FieldValue;
  function stamp() { return FV.serverTimestamp(); }
  function userRef(uid) { return db.collection("users").doc(uid); }

  // Every new account starts with this much FAKE money
  var STARTING_BALANCE = 100;

  // Every fee is paid to this account (looked up by its username)
  var FEE_OWNER_USERNAME = "mohamed#9729";

  function round2(n) { return Math.round(n * 100) / 100; }
  function fullName(p) { return ((p.firstName || "") + " " + (p.lastName || "")).trim(); }

  // Today's date as 2026-10-12 (used for the spending charts)
  function dayKey() {
    var d = new Date();
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  }
  // Adds numbers to today's chart totals, e.g. { sent: 20, fee: 0.3 }
  function statsPatch(patch, into) {
    Object.keys(patch).forEach(function (k) {
      if (patch[k]) into["stats.d." + dayKey() + "." + k] = FV.increment(patch[k]);
    });
    return into;
  }
  function makeRef() {
    var chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    var out = "";
    for (var i = 0; i < 10; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
  }

  // ---------- ID numbers: 8 digits, the number people type to send you money ----------
  function randomId() {
    return String(10000000 + Math.floor(Math.random() * 90000000));
  }
  function cleanId(text) {
    return String(text || "").replace(/\D/g, "");
  }

  // ---------- Accounts ----------

  // Make a new profile with a fresh ID number
  async function createProfile(user, firstName, lastName) {
    for (var tries = 0; tries < 10; tries++) {
      var id = randomId();
      try {
        await db.runTransaction(async function (tx) {
          var idRef = db.collection("ids").doc(id);
          var taken = await tx.get(idRef);
          if (taken.exists) throw new Error("taken");
          tx.set(idRef, { uid: user.uid });
          tx.set(userRef(user.uid), {
            firstName: firstName,
            lastName: lastName,
            accountId: id,
            balance: STARTING_BALANCE,
            activeCardId: null,
            createdAt: stamp()
          });
        });
        return;
      } catch (err) {
        if (err.message !== "taken") throw err;
      }
    }
    throw new Error("Could not make an ID number. Please try again.");
  }

  async function signUp(firstName, lastName, email, password) {
    var cred = await auth.createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName: firstName });
    await createProfile(cred.user, firstName, lastName);
    return cred.user;
  }

  async function logIn(email, password) {
    var cred = await auth.signInWithEmailAndPassword(email, password);
    return cred.user;
  }

  function logOut() { return auth.signOut(); }
  function watchAuth(callback) { return auth.onAuthStateChanged(callback); }

  // Make sure a profile exists (repairs an account cut off while signing up)
  async function ensureProfile(user) {
    var snap = await userRef(user.uid).get();
    if (!snap.exists) await createProfile(user, user.displayName || "User", "");
  }

  // Accounts made before ID numbers existed get one the first time they open the app
  async function ensureAccountId(uid) {
    for (var tries = 0; tries < 10; tries++) {
      var id = randomId();
      try {
        return await db.runTransaction(async function (tx) {
          var ref = userRef(uid);
          var snap = await tx.get(ref);
          if (!snap.exists || snap.data().accountId) return false;
          var idRef = db.collection("ids").doc(id);
          var taken = await tx.get(idRef);
          if (taken.exists) throw new Error("taken");
          tx.set(idRef, { uid: uid });
          tx.update(ref, { accountId: id });
          return true;
        });
      } catch (err) {
        if (err.message !== "taken") throw err;
      }
    }
    return false;
  }

  // Live updates: runs your function every time the profile or balance changes
  function watchProfile(uid, callback) {
    return userRef(uid).onSnapshot(function (snap) {
      if (snap.exists) callback(snap.data());
    });
  }

  // Find a REAL person by their ID number (null if no account has it)
  async function findUser(text) {
    var id = cleanId(text);
    if (id.length !== 8) return null;
    var idSnap = await db.collection("ids").doc(id).get();
    if (!idSnap.exists) return null;
    return getPerson(idSnap.data().uid);
  }

  // The short public details of one person, by uid (null if gone)
  async function getPerson(uid) {
    var snap = await userRef(uid).get();
    if (!snap.exists) return null;
    var d = snap.data();
    return { uid: uid, firstName: d.firstName || "", lastName: d.lastName || "", accountId: d.accountId || "" };
  }

  // The account that receives every fee (null if it can't be found, which turns fees off)
  async function feeOwner() {
    try {
      var snap = await db.collection("usernames").doc(FEE_OWNER_USERNAME).get();
      return snap.exists ? snap.data().uid : null;
    } catch (e) {
      return null;
    }
  }

  // ---------- PIN (stored as a scrambled "hash", never the PIN itself) ----------
  async function hashPin(uid, pin) {
    var text = uid + ":" + pin;
    if (window.crypto && window.crypto.subtle) {
      var buf = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return ("0" + b.toString(16)).slice(-2);
      }).join("");
    }
    var h = 5381;
    for (var i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return "x" + h;
  }

  async function setPin(uid, pin) {
    await userRef(uid).update({ pinHash: await hashPin(uid, pin) });
  }

  async function checkPin(uid, pin) {
    var snap = await userRef(uid).get();
    if (!snap.exists) return false;
    return snap.data().pinHash === (await hashPin(uid, pin));
  }

  // ---------- Money ----------

  // card: optional { name, last4 } of the card used (shown on the receipt)
  function cardFields(card) {
    return card ? { cardName: card.name, cardLast4: card.last4 } : {};
  }

  async function fund(uid, amount, card) {
    var ref = userRef(uid);
    var txRef = ref.collection("transactions").doc();
    await db.runTransaction(async function (tx) {
      var snap = await tx.get(ref);
      var next = round2((snap.data().balance || 0) + amount);
      tx.update(ref, { balance: next });
      tx.set(txRef, Object.assign({
        type: "fund", title: "Added money", amount: amount, ref: makeRef(), createdAt: stamp()
      }, cardFields(card)));
    });
  }

  // Send money: the amount goes to them, amount + fee comes from you, and the fee goes to the fee owner.
  // ownerUid: the fee owner's uid, or null when fees are off.
  async function sendMoney(senderUid, recipientUid, amount, fee, card, ownerUid) {
    if (senderUid === recipientUid) throw new Error("self");
    fee = round2(fee || 0);
    if (!ownerUid || ownerUid === senderUid) fee = 0;
    var total = round2(amount + fee);

    // Every account whose balance changes (one entry each, even if two roles are the same person)
    var uids = [senderUid, recipientUid];
    if (fee > 0 && uids.indexOf(ownerUid) === -1) uids.push(ownerUid);
    var delta = {};
    delta[senderUid] = round2(-total);
    delta[recipientUid] = round2(amount);
    if (fee > 0) delta[ownerUid] = round2((delta[ownerUid] || 0) + fee);

    var sRef = userRef(senderUid);
    var rRef = userRef(recipientUid);
    var sTx = sRef.collection("transactions").doc();
    var rTx = rRef.collection("transactions").doc();
    var oTx = fee > 0 ? userRef(ownerUid).collection("transactions").doc() : null;
    var feesRef = db.collection("config").doc("fees");
    var ref = makeRef();

    await db.runTransaction(async function (tx) {
      // All reads first, then all writes
      var snaps = {};
      for (var i = 0; i < uids.length; i++) snaps[uids[i]] = await tx.get(userRef(uids[i]));

      if (!snaps[recipientUid].exists) throw new Error("not-found");
      if (!snaps[senderUid].exists) throw new Error("no-sender");
      if (fee > 0 && !snaps[ownerUid].exists) throw new Error("fee-owner-missing");

      var s = snaps[senderUid].data();
      var r = snaps[recipientUid].data();
      if ((s.balance || 0) < total) throw new Error("insufficient");

      var sName = fullName(s);
      var rName = fullName(r);

      var patch = {};
      uids.forEach(function (u) {
        patch[u] = { balance: round2(((snaps[u].data().balance) || 0) + delta[u]) };
      });
      patch[senderUid] = statsPatch({ sent: amount, fee: fee }, patch[senderUid]);
      patch[recipientUid] = statsPatch({ in: amount }, patch[recipientUid]);
      if (fee > 0) {
        patch[ownerUid] = statsPatch({ feesIn: fee }, patch[ownerUid]);
        tx.set(feesRef, { total: FV.increment(fee) }, { merge: true });
      }
      uids.forEach(function (u) { tx.update(userRef(u), patch[u]); });

      tx.set(sTx, Object.assign({
        type: "send", title: "Sent to " + rName, amount: -total, sent: amount, fee: fee,
        counterpartUid: recipientUid, counterpartName: rName, counterpartAccountId: r.accountId || "",
        ref: ref, createdAt: stamp()
      }, cardFields(card)));
      tx.set(rTx, {
        type: "receive", title: "From " + sName, amount: amount,
        counterpartUid: senderUid, counterpartName: sName, counterpartAccountId: s.accountId || "",
        ref: ref, createdAt: stamp()
      });
      if (oTx) {
        tx.set(oTx, { type: "fee", title: "Fee from " + sName, amount: fee, ref: ref, createdAt: stamp() });
      }
    });
    return ref;
  }

  // ---------- Money requests: ask someone to pay you ----------
  // from = the person asking, to = the person who pays. Each is { uid, name, accountId }.
  async function createRequest(from, to, amount, note) {
    var ref = db.collection("requests").doc();
    await ref.set({
      members: [from.uid, to.uid].sort(),
      from: from,
      to: to,
      amount: round2(amount),
      note: note || "",
      status: "pending",
      createdAt: stamp(),
      updatedAt: stamp()
    });
    return ref.id;
  }

  function watchRequests(uid, callback) {
    return db.collection("requests").where("members", "array-contains", uid).onSnapshot(function (snap) {
      callback(snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }));
    });
  }

  // status: "paid", "declined" or "cancelled"
  function setRequestStatus(id, status, extra) {
    return db.collection("requests").doc(id).update(Object.assign({ status: status, updatedAt: stamp() }, extra || {}));
  }

  // ---------- Receipts ----------
  function watchTransactions(uid, callback) {
    return userRef(uid).collection("transactions")
      .orderBy("createdAt", "desc").limit(40)
      .onSnapshot(function (snap) {
        callback(snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }));
      });
  }

  async function deleteTransactions(uid, ids) {
    for (var i = 0; i < ids.length; i += 400) {
      var batch = db.batch();
      ids.slice(i, i + 400).forEach(function (id) {
        batch.delete(userRef(uid).collection("transactions").doc(id));
      });
      await batch.commit();
    }
  }

  async function deleteCollection(colRef) {
    while (true) {
      var snap = await colRef.limit(100).get();
      if (snap.empty) break;
      var batch = db.batch();
      snap.docs.forEach(function (d) { batch.delete(d.ref); });
      await batch.commit();
    }
  }

  function deleteAllTransactions(uid) {
    return deleteCollection(userRef(uid).collection("transactions"));
  }

  // ---------- Cards ----------
  function luhnCheckDigit(body) {
    var sum = 0;
    for (var i = 0; i < body.length; i++) {
      var d = parseInt(body.charAt(body.length - 1 - i), 10);
      if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    return (10 - (sum % 10)) % 10;
  }

  // 16 digits that pass the Luhn check. Starts with 9 so it is never a real bank's card.
  function makeCardNumber() {
    var body = "9";
    for (var i = 0; i < 14; i++) body += Math.floor(Math.random() * 10);
    return body + luhnCheckDigit(body);
  }

  // price: 0 for the normal color, more for the others (taken from your balance)
  async function createCard(uid, name, finish, holder, price) {
    price = round2(price || 0);
    var number = makeCardNumber();
    var exp = new Date();
    exp.setFullYear(exp.getFullYear() + 4);
    var uref = userRef(uid);
    var ref = uref.collection("cards").doc();
    var data = {
      name: name,
      finish: finish,
      brand: Math.random() < 0.5 ? "visa" : "mastercard",
      number: number,
      last4: number.slice(-4),
      expMonth: ("0" + (exp.getMonth() + 1)).slice(-2),
      expYear: String(exp.getFullYear()).slice(-2),
      cvv: String(100 + Math.floor(Math.random() * 900)),
      holder: holder,
      frozen: false,
      createdAt: stamp()
    };
    if (price <= 0) {
      await ref.set(data);
      return ref.id;
    }
    var txRef = uref.collection("transactions").doc();
    await db.runTransaction(async function (tx) {
      var snap = await tx.get(uref);
      var balance = (snap.data().balance || 0);
      if (balance < price) throw new Error("insufficient");
      tx.update(uref, statsPatch({ card: price }, { balance: round2(balance - price) }));
      tx.set(ref, data);
      tx.set(txRef, {
        type: "card", title: "New card: " + name, amount: -price, ref: makeRef(), createdAt: stamp()
      });
    });
    return ref.id;
  }

  function watchCards(uid, callback) {
    return userRef(uid).collection("cards").orderBy("createdAt", "asc").onSnapshot(function (snap) {
      callback(snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }));
    });
  }

  function setCardFrozen(uid, cardId, frozen) {
    return userRef(uid).collection("cards").doc(cardId).update({ frozen: !!frozen });
  }
  function deleteCard(uid, cardId) {
    return userRef(uid).collection("cards").doc(cardId).delete();
  }
  function setActiveCard(uid, cardId) {
    return userRef(uid).update({ activeCardId: cardId || null });
  }

  // ---------- Messages ----------
  function chatId(a, b) { return [a, b].sort().join("_"); }

  // me / other: { uid, name, accountId }
  async function sendMessage(me, other, text) {
    var chatRef = db.collection("chats").doc(chatId(me.uid, other.uid));
    var msgRef = chatRef.collection("messages").doc();
    var names = {}; names[me.uid] = me.name; names[other.uid] = other.name;
    var accountIds = {}; accountIds[me.uid] = me.accountId; accountIds[other.uid] = other.accountId;
    var unread = {}; unread[other.uid] = FV.increment(1);

    var batch = db.batch();
    batch.set(chatRef, {
      members: [me.uid, other.uid].sort(),
      names: names,
      accountIds: accountIds,
      lastMessage: text.slice(0, 80),
      lastFrom: me.uid,
      lastAt: stamp(),
      unread: unread
    }, { merge: true });
    batch.set(msgRef, { from: me.uid, text: text, createdAt: stamp() });
    await batch.commit();
  }

  function watchChats(uid, callback) {
    return db.collection("chats").where("members", "array-contains", uid).onSnapshot(function (snap) {
      callback(snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }));
    });
  }

  // Newest 200 messages, shown oldest-first (so the latest ones are never cut off)
  function watchMessages(id, callback) {
    return db.collection("chats").doc(id).collection("messages")
      .orderBy("createdAt", "desc").limit(200)
      .onSnapshot(function (snap) {
        callback(snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }).reverse());
      });
  }

  function markRead(uid, id) {
    var patch = {};
    patch["unread." + uid] = 0;
    return db.collection("chats").doc(id).update(patch).catch(function () {});
  }

  // ---------- Delete account ----------

  // Checks the password (throws if wrong). Nothing is deleted here.
  async function checkPassword(email, password) {
    var cred = firebase.auth.EmailAuthProvider.credential(email, password);
    await auth.currentUser.reauthenticateWithCredential(cred);
  }

  async function deleteAccount(uid) {
    var user = auth.currentUser;
    var ref = userRef(uid);
    var snap = await ref.get();
    var d = snap.exists ? snap.data() : {};
    await deleteCollection(ref.collection("transactions"));
    await deleteCollection(ref.collection("cards"));
    var ownerSnap = await ownerRef().get(); // if you are the owner, the owner spot opens up again
    if (ownerSnap.exists && ownerSnap.data().uid === uid) await ownerRef().delete();
    if (d.accountId) await db.collection("ids").doc(d.accountId).delete();
    if (d.username) await db.collection("usernames").doc(d.username.toLowerCase()).delete();
    await ref.delete();
    await user.delete();
  }

  // ---------- Owner: the only person who can add money ----------
  function toHex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }
  async function stretch(password, saltHex) {
    if (!(window.crypto && window.crypto.subtle)) throw new Error("no-crypto");
    var enc = new TextEncoder();
    var salt = new Uint8Array(saltHex.match(/.{2}/g).map(function (h) { return parseInt(h, 16); }));
    var key = await window.crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    var bits = await window.crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt, iterations: 150000, hash: "SHA-256" }, key, 256);
    return toHex(bits);
  }
  function randomSalt() {
    var a = new Uint8Array(16);
    window.crypto.getRandomValues(a);
    return toHex(a);
  }
  var ownerRef = function () { return db.collection("config").doc("owner"); };

  function watchOwner(callback) {
    return ownerRef().onSnapshot(function (snap) { callback(snap.exists ? snap.data() : null); });
  }

  // The first person to do this becomes the owner
  async function claimOwner(uid, email, fundPassword) {
    var salt = randomSalt();
    var hash = await stretch(fundPassword, salt);
    await db.runTransaction(async function (tx) {
      var snap = await tx.get(ownerRef());
      if (snap.exists) throw new Error("owner-exists");
      tx.set(ownerRef(), { uid: uid, email: email, salt: salt, hash: hash, createdAt: stamp() });
    });
  }

  async function checkFundPassword(password) {
    var snap = await ownerRef().get();
    if (!snap.exists) return false;
    var d = snap.data();
    return (await stretch(password, d.salt)) === d.hash;
  }

  async function changeFundPassword(oldPassword, newPassword) {
    if (!(await checkFundPassword(oldPassword))) throw new Error("bad-fund-password");
    var salt = randomSalt();
    var hash = await stretch(newPassword, salt);
    await ownerRef().update({ salt: salt, hash: hash });
  }

  // ---------- Errors in plain words ----------
  function friendlyError(err) {
    var byMessage = {
      "insufficient": "You don't have enough money for that.",
      "not-found": "No account has that ID number.",
      "self": "You can't send money to yourself.",
      "no-sender": "Your account wasn't found. Log in again.",
      "fee-owner-missing": "Fees can't be paid right now. Try again later.",
      "owner-exists": "Someone already set up the owner password.",
      "bad-fund-password": "That funding password isn't right.",
      "no-crypto": "This browser can't do secure passwords. Use Safari."
    };
    if (byMessage[err.message]) return byMessage[err.message];

    var map = {
      "auth/email-already-in-use": "That email already has an account. Try logging in.",
      "auth/invalid-email": "That email doesn't look right.",
      "auth/weak-password": "Password needs at least 8 characters.",
      "auth/invalid-credential": "Wrong email or password.",
      "auth/invalid-login-credentials": "Wrong email or password.",
      "auth/user-not-found": "No account with that email.",
      "auth/wrong-password": "Wrong email or password.",
      "auth/missing-password": "Type your password.",
      "auth/user-disabled": "This account has been turned off.",
      "auth/operation-not-allowed": "Sign-up is turned off right now.",
      "auth/too-many-requests": "Too many tries. Wait a minute and try again.",
      "auth/network-request-failed": "No internet. Check your connection.",
      "auth/requires-recent-login": "Please log out, log back in, and try again.",
      "permission-denied": "That isn't allowed for your account.",
      "unavailable": "No connection right now. Try again in a moment.",
      "deadline-exceeded": "That took too long. Try again."
    };
    return map[err.code] || err.message || "Something went wrong. Try again.";
  }

  window.Wallet = {
    signUp: signUp, logIn: logIn, logOut: logOut, watchAuth: watchAuth,
    ensureProfile: ensureProfile, ensureAccountId: ensureAccountId, watchProfile: watchProfile,
    getPerson: getPerson, findUser: findUser, feeOwner: feeOwner,
    setPin: setPin, checkPin: checkPin,
    fund: fund, sendMoney: sendMoney,
    createRequest: createRequest, watchRequests: watchRequests, setRequestStatus: setRequestStatus,
    watchTransactions: watchTransactions, deleteTransactions: deleteTransactions, deleteAllTransactions: deleteAllTransactions,
    createCard: createCard, watchCards: watchCards, setCardFrozen: setCardFrozen, deleteCard: deleteCard, setActiveCard: setActiveCard,
    chatId: chatId, sendMessage: sendMessage, watchChats: watchChats, watchMessages: watchMessages, markRead: markRead,
    checkPassword: checkPassword, deleteAccount: deleteAccount,
    watchOwner: watchOwner, claimOwner: claimOwner, checkFundPassword: checkFundPassword, changeFundPassword: changeFundPassword,
    friendlyError: friendlyError
  };
})();
