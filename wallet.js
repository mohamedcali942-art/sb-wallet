// wallet.js — SB Wallet: talks to Firebase (accounts, money, cards, messages). FAKE money only.
// Uses the "compat" Firebase scripts loaded in index.html, so it works in Koder's preview too.

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
  var STARTING_BALANCE = 1000;

  function round2(n) { return Math.round(n * 100) / 100; }
  function makeRef() {
    var chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    var out = "";
    for (var i = 0; i < 10; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
  }

  // ---------- Accounts ----------

  // Make a unique username like Mo#4821 and save the profile
  async function createProfile(user, firstName, lastName) {
    var base = firstName.replace(/[^a-zA-Z0-9]/g, "") || "User";

    for (var tries = 0; tries < 10; tries++) {
      var code = String(Math.floor(1000 + Math.random() * 9000));
      var username = base + "#" + code;
      var key = username.toLowerCase();

      try {
        await db.runTransaction(async function (tx) {
          var nameRef = db.collection("usernames").doc(key);
          var taken = await tx.get(nameRef);
          if (taken.exists) throw new Error("taken");

          tx.set(nameRef, { uid: user.uid });
          tx.set(userRef(user.uid), {
            firstName: firstName,
            lastName: lastName,
            username: username,
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
    throw new Error("Could not make a username. Please try again.");
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

  // Live updates: runs your function every time the profile or balance changes
  function watchProfile(uid, callback) {
    return userRef(uid).onSnapshot(function (snap) {
      if (snap.exists) callback(snap.data());
    });
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

  // Find a REAL person by username (null if they don't exist)
  async function findUser(username) {
    var key = String(username || "").trim().toLowerCase();
    if (!key || key.indexOf("/") !== -1 || key.length > 40 || key.indexOf("#") === -1) return null;
    var nameSnap = await db.collection("usernames").doc(key).get();
    if (!nameSnap.exists) return null;
    var uid = nameSnap.data().uid;
    var userSnap = await userRef(uid).get();
    if (!userSnap.exists) return null;
    var d = userSnap.data();
    return { uid: uid, firstName: d.firstName, lastName: d.lastName || "", username: d.username };
  }

  // Send money: takes from you, gives to them, writes a receipt for both
  async function sendMoney(senderUid, recipientUid, amount, card) {
    if (senderUid === recipientUid) throw new Error("self");
    var sRef = userRef(senderUid);
    var rRef = userRef(recipientUid);
    var sTx = sRef.collection("transactions").doc();
    var rTx = rRef.collection("transactions").doc();
    var ref = makeRef();

    await db.runTransaction(async function (tx) {
      var sSnap = await tx.get(sRef);
      var rSnap = await tx.get(rRef);
      if (!rSnap.exists) throw new Error("not-found"); // the person must be real
      if (!sSnap.exists) throw new Error("no-sender");
      var s = sSnap.data();
      var r = rSnap.data();
      if ((s.balance || 0) < amount) throw new Error("insufficient");

      var sName = (s.firstName + " " + (s.lastName || "")).trim();
      var rName = (r.firstName + " " + (r.lastName || "")).trim();

      tx.update(sRef, { balance: round2((s.balance || 0) - amount) });
      tx.update(rRef, { balance: round2((r.balance || 0) + amount) });
      tx.set(sTx, Object.assign({
        type: "send", title: "Sent to " + rName, amount: -amount,
        counterpartUid: recipientUid, counterpartName: rName, counterpartUsername: r.username,
        ref: ref, createdAt: stamp()
      }, cardFields(card)));
      tx.set(rTx, {
        type: "receive", title: "From " + sName, amount: amount,
        counterpartUid: senderUid, counterpartName: sName, counterpartUsername: s.username,
        ref: ref, createdAt: stamp()
      });
    });
    return ref;
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

  async function createCard(uid, name, finish, holder) {
    var number = makeCardNumber();
    var exp = new Date();
    exp.setFullYear(exp.getFullYear() + 4);
    var ref = userRef(uid).collection("cards").doc();
    await ref.set({
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

  // me / other: { uid, name, username }
  async function sendMessage(me, other, text) {
    var chatRef = db.collection("chats").doc(chatId(me.uid, other.uid));
    var msgRef = chatRef.collection("messages").doc();
    var names = {}; names[me.uid] = me.name; names[other.uid] = other.name;
    var usernames = {}; usernames[me.uid] = me.username; usernames[other.uid] = other.username;
    var unread = {}; unread[other.uid] = FV.increment(1);

    var batch = db.batch();
    batch.set(chatRef, {
      members: [me.uid, other.uid].sort(),
      names: names,
      usernames: usernames,
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

  function watchMessages(id, callback) {
    return db.collection("chats").doc(id).collection("messages")
      .orderBy("createdAt", "asc").limit(300)
      .onSnapshot(function (snap) {
        callback(snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }));
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
    await deleteCollection(ref.collection("transactions"));
    await deleteCollection(ref.collection("cards"));
    if (snap.exists && snap.data().username) {
      await db.collection("usernames").doc(snap.data().username.toLowerCase()).delete();
    }
    await ref.delete();
    await user.delete();
  }

  // ---------- Errors in plain words ----------
  function friendlyError(err) {
    var byMessage = {
      "insufficient": "You don't have enough money for that.",
      "not-found": "That person doesn't have an account.",
      "self": "You can't send money to yourself.",
      "no-sender": "Your account wasn't found. Log in again."
    };
    if (byMessage[err.message]) return byMessage[err.message];

    var map = {
      "auth/email-already-in-use": "That email already has an account. Try logging in.",
      "auth/invalid-email": "That email doesn't look right.",
      "auth/weak-password": "Password needs at least 6 characters.",
      "auth/invalid-credential": "Wrong email or password.",
      "auth/user-not-found": "No account with that email.",
      "auth/wrong-password": "Wrong email or password.",
      "auth/too-many-requests": "Too many tries. Wait a minute and try again.",
      "auth/network-request-failed": "No internet. Check your connection.",
      "auth/requires-recent-login": "Please log out, log back in, and try again.",
      "permission-denied": "The database said no. Check your Firestore rules."
    };
    return map[err.code] || err.message || "Something went wrong. Try again.";
  }

  window.Wallet = {
    signUp: signUp, logIn: logIn, logOut: logOut, watchAuth: watchAuth,
    ensureProfile: ensureProfile, watchProfile: watchProfile,
    setPin: setPin, checkPin: checkPin,
    fund: fund, findUser: findUser, sendMoney: sendMoney,
    watchTransactions: watchTransactions, deleteTransactions: deleteTransactions, deleteAllTransactions: deleteAllTransactions,
    createCard: createCard, watchCards: watchCards, setCardFrozen: setCardFrozen, deleteCard: deleteCard, setActiveCard: setActiveCard,
    chatId: chatId, sendMessage: sendMessage, watchChats: watchChats, watchMessages: watchMessages, markRead: markRead,
    checkPassword: checkPassword, deleteAccount: deleteAccount,
    friendlyError: friendlyError
  };
})();
