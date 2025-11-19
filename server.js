// server.js
// Backend Cloock + PayPal Checkout (LIVE) + HDV multi + synchro coins & skins

const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cors = require("cors");

const app = express();

// -----------------------------------------------------------------------------
// CORS : on OUVRE tout (pour ton index en local ou ailleurs)
// -----------------------------------------------------------------------------
app.use(cors()); // autorise tout par défaut

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());

// -----------------------------------------------------------------------------
// CONFIG PAYPAL (LIVE)
// -----------------------------------------------------------------------------
// Sur Render :
// PAYPAL_CLIENT_ID     = ton client-id LIVE
// PAYPAL_CLIENT_SECRET = ton secret LIVE

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;

const PAYPAL_API_BASE = "https://api-m.paypal.com"; // LIVE

// 3€ => 6000 pièces
const COINS_PER_PURCHASE = 6000;
const COINS_PRICE_EUR = "3.00";

// -----------------------------------------------------------------------------
// "BDD" simple JSON pour les joueurs (coins + skins)
// -----------------------------------------------------------------------------
// Structure players.json :
// {
//   "Pierre": {
//     "coins": 12345,
//     "skins": { "basic": 2, "ember": 1 }
//   },
//   ...
// }

const DB_FILE = path.join(__dirname, "players.json");

function loadPlayersDb() {
  try {
    if (!fs.existsSync(DB_FILE)) return {};
    const raw = fs.readFileSync(DB_FILE, "utf8");
    return JSON.parse(raw || "{}");
  } catch (e) {
    console.error("Erreur lecture DB joueurs:", e);
    return {};
  }
}

function savePlayersDb(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
  } catch (e) {
    console.error("Erreur écriture DB joueurs:", e);
  }
}

// normalise la structure d'un joueur
function ensurePlayer(db, pseudo) {
  if (!db[pseudo]) {
    db[pseudo] = { coins: 0, skins: {} };
  } else {
    if (typeof db[pseudo].coins !== "number") db[pseudo].coins = 0;
    if (!db[pseudo].skins || typeof db[pseudo].skins !== "object") {
      db[pseudo].skins = {};
    }
  }
  return db[pseudo];
}

function sanitizePseudo(p) {
  return (p || "Invité").toString().trim().replace(/[|:]/g, "") || "Invité";
}

// Ajoute des pièces à un joueur, retourne le total
function addCoins(pseudo, amount) {
  const db = loadPlayersDb();
  const p = ensurePlayer(db, pseudo);
  p.coins += amount;
  if (p.coins < 0) p.coins = 0;
  savePlayersDb(db);
  return p.coins;
}

// Tente de retirer des pièces, renvoie { ok, coins }
function spendCoins(pseudo, amount) {
  const db = loadPlayersDb();
  const p = ensurePlayer(db, pseudo);
  if (p.coins < amount) {
    return { ok: false, coins: p.coins };
  }
  p.coins -= amount;
  if (p.coins < 0) p.coins = 0;
  savePlayersDb(db);
  return { ok: true, coins: p.coins };
}

// Ajoute des skins (quantité positive)
function addSkin(pseudo, skinId, qty) {
  const db = loadPlayersDb();
  const p = ensurePlayer(db, pseudo);
  if (!p.skins[skinId]) p.skins[skinId] = 0;
  p.skins[skinId] += qty;
  if (p.skins[skinId] < 0) p.skins[skinId] = 0;
  savePlayersDb(db);
  return p.skins;
}

// Retire des skins si possible, renvoie { ok, skins }
function removeSkin(pseudo, skinId, qty) {
  const db = loadPlayersDb();
  const p = ensurePlayer(db, pseudo);
  const cur = p.skins[skinId] || 0;
  if (cur < qty) {
    return { ok: false, skins: p.skins };
  }
  p.skins[skinId] = cur - qty;
  if (p.skins[skinId] <= 0) delete p.skins[skinId];
  savePlayersDb(db);
  return { ok: true, skins: p.skins };
}

// -----------------------------------------------------------------------------
// BDD simple JSON pour les offres HDV
// -----------------------------------------------------------------------------
// Structure auctions.json :
// [
//   {
//     "id": "timestamp_random",
//     "skinId": "ember",
//     "skinName": "ember",
//     "seller": "Pierre",
//     "quantity": 2,
//     "price": 500,
//     "status": "OPEN" | "SOLD" | "CANCELLED",
//     "createdAt": 123456789,
//     "buyer": "...?",
//     "soldAt": 123,
//     "cancelledAt": 123
//   },
//   ...
// ]

const AUCTION_FILE = path.join(__dirname, "auctions.json");

function loadAuctionsDb() {
  try {
    if (!fs.existsSync(AUCTION_FILE)) return [];
    const raw = fs.readFileSync(AUCTION_FILE, "utf8");
    const data = JSON.parse(raw || "[]");
    if (!Array.isArray(data)) return [];
    return data;
  } catch (e) {
    console.error("Erreur lecture DB HDV:", e);
    return [];
  }
}

function saveAuctionsDb(list) {
  try {
    fs.writeFileSync(AUCTION_FILE, JSON.stringify(list, null, 2), "utf8");
  } catch (e) {
    console.error("Erreur écriture DB HDV:", e);
  }
}

// -----------------------------------------------------------------------------
// PAYPAL : access_token (live)
// -----------------------------------------------------------------------------
async function getAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    console.error("❌ PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET manquants");
    throw new Error("Config PayPal manquante");
  }

  const credentials = Buffer.from(
    PAYPAL_CLIENT_ID + ":" + PAYPAL_CLIENT_SECRET
  ).toString("base64");

  const resp = await axios.post(
    `${PAYPAL_API_BASE}/v1/oauth2/token`,
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  return resp.data.access_token;
}

// -----------------------------------------------------------------------------
// API HEALTH
// -----------------------------------------------------------------------------

// ping pour vérifier le serveur vite fait
app.get("/api/health", (req, res) => {
  const auctions = loadAuctionsDb();
  res.json({
    ok: true,
    paypalClient: PAYPAL_CLIENT_ID ? "ok" : "missing",
    mode: "live",
    hdvOffers: auctions.filter(o => o.status === "OPEN").length,
  });
});

// (optionnel) racine simple
app.get("/", (req, res) => {
  const auctions = loadAuctionsDb();
  res.json({
    ok: true,
    service: "Cloock backend",
    hdvOffers: auctions.filter(o => o.status === "OPEN").length,
  });
});

// -----------------------------------------------------------------------------
// API JOUEUR : coins + inventaire
// -----------------------------------------------------------------------------

// récupérer les coins + skins d'un joueur
app.get("/api/player/:pseudo", (req, res) => {
  const pseudoRaw = req.params.pseudo;
  const pseudo = sanitizePseudo(pseudoRaw);
  const db = loadPlayersDb();
  const p = db[pseudo] || { coins: 0, skins: {} };
  res.json({
    pseudo,
    coins: p.coins || 0,
    skins: p.skins || {},
  });
});

// ajouter des pièces (par exemple pour les clics)
app.post("/api/player/add-coins", (req, res) => {
  const { pseudo: raw, amount, source } = req.body || {};
  const pseudo = sanitizePseudo(raw);
  const amt = parseInt(amount, 10);
  if (!pseudo || isNaN(amt) || amt <= 0) {
    return res.status(400).json({ ok: false, error: "Paramètres invalides" });
  }
  const total = addCoins(pseudo, amt);
  console.log(`➕ coins +${amt} pour ${pseudo} (source=${source || "?"}) => total=${total}`);
  res.json({ ok: true, pseudo, coins: total });
});

// retirer des pièces (shop, HDV, etc.)
app.post("/api/player/spend-coins", (req, res) => {
  const { pseudo: raw, amount, reason } = req.body || {};
  const pseudo = sanitizePseudo(raw);
  const amt = parseInt(amount, 10);
  if (!pseudo || isNaN(amt) || amt <= 0) {
    return res.status(400).json({ ok: false, error: "Paramètres invalides" });
  }
  const result = spendCoins(pseudo, amt);
  if (!result.ok) {
    return res
      .status(400)
      .json({ ok: false, error: "Pas assez de pièces", coins: result.coins });
  }
  console.log(`💸 coins -${amt} pour ${pseudo} (reason=${reason || "?"}) => total=${result.coins}`);
  res.json({ ok: true, pseudo, coins: result.coins });
});

// ajouter des skins (cadeaux, rewards)
app.post("/api/player/add-skin", (req, res) => {
  const { pseudo: raw, skinId, quantity } = req.body || {};
  const pseudo = sanitizePseudo(raw);
  const skin = (skinId || "").toString().trim();
  const qty = parseInt(quantity, 10);
  if (!pseudo || !skin || isNaN(qty) || qty <= 0) {
    return res.status(400).json({ ok: false, error: "Paramètres invalides" });
  }
  const skins = addSkin(pseudo, skin, qty);
  console.log(`🎨 +${qty}x ${skin} pour ${pseudo}`);
  res.json({ ok: true, pseudo, skins });
});

// retirer des skins (si tu veux synchroniser certains cas)
app.post("/api/player/remove-skin", (req, res) => {
  const { pseudo: raw, skinId, quantity } = req.body || {};
  const pseudo = sanitizePseudo(raw);
  const skin = (skinId || "").toString().trim();
  const qty = parseInt(quantity, 10);
  if (!pseudo || !skin || isNaN(qty) || qty <= 0) {
    return res.status(400).json({ ok: false, error: "Paramètres invalides" });
  }
  const result = removeSkin(pseudo, skin, qty);
  if (!result.ok) {
    return res
      .status(400)
      .json({ ok: false, error: "Pas assez d'exemplaires de ce skin" });
  }
  console.log(`🎨 -${qty}x ${skin} pour ${pseudo}`);
  res.json({ ok: true, pseudo, skins: result.skins });
});

// -----------------------------------------------------------------------------
// API HDV MULTI (synchronisé sur fichiers JSON + joueurs)
// -----------------------------------------------------------------------------

// Liste des offres ouvertes
app.get("/api/auction/offers", (req, res) => {
  const all = loadAuctionsDb();
  const openOffers = all
    .filter((o) => o.status === "OPEN")
    .map((o) => ({
      id: o.id,
      skinId: o.skinId,
      skinName: o.skinName || o.skinId,
      seller: o.seller,
      quantity: o.quantity,
      price: o.price,
    }));
  res.json({ ok: true, offers: openOffers });
});

// Créer une offre : vérifie l'inventaire serveur et retire les skins
app.post("/api/auction/create-offer", (req, res) => {
  const { pseudo: raw, skinId, quantity, price } = req.body || {};
  const seller = sanitizePseudo(raw);
  const skin = (skinId || "").toString().trim();
  const qty = parseInt(quantity, 10);
  const pr = parseInt(price, 10);

  if (!seller || !skin || isNaN(qty) || qty <= 0 || isNaN(pr) || pr <= 0) {
    return res.status(400).json({ ok: false, error: "Paramètres invalides" });
  }

  // Vérifie inventaire serveur
  const removeResult = removeSkin(seller, skin, qty);
  if (!removeResult.ok) {
    return res
      .status(400)
      .json({ ok: false, error: "Pas assez d'exemplaires de ce skin" });
  }

  const auctions = loadAuctionsDb();
  const id =
    String(Date.now()) + "_" + Math.random().toString(36).slice(2, 7);

  const offer = {
    id,
    skinId: skin,
    skinName: skin,
    seller,
    quantity: qty,
    price: pr,
    status: "OPEN",
    createdAt: Date.now(),
  };

  auctions.push(offer);
  saveAuctionsDb(auctions);

  console.log(
    `🏦 Nouvelle offre HDV: ${seller} vend ${qty}x ${skin} pour ${pr} coins (id=${id})`
  );

  res.json({
    ok: true,
    offer: {
      id: offer.id,
      skinId: offer.skinId,
      skinName: offer.skinName,
      seller: offer.seller,
      quantity: offer.quantity,
      price: offer.price,
    },
  });
});

// Acheter une offre : vérifie coins serveur + transfert coins & skins
app.post("/api/auction/buy-offer", (req, res) => {
  const { pseudo: raw, offerId } = req.body || {};
  const buyer = sanitizePseudo(raw);
  const id = (offerId || "").toString();

  const auctions = loadAuctionsDb();
  const idx = auctions.findIndex((o) => o.id === id);
  if (idx === -1) {
    return res
      .status(404)
      .json({ ok: false, error: "Offre introuvable ou déjà prise" });
  }

  const offer = auctions[idx];
  if (offer.status !== "OPEN") {
    return res
      .status(404)
      .json({ ok: false, error: "Offre introuvable ou déjà prise" });
  }

  if (offer.seller === buyer) {
    return res
      .status(400)
      .json({ ok: false, error: "Tu ne peux pas acheter ta propre offre" });
  }

  const price = offer.price;
  const qty = offer.quantity;
  const skin = offer.skinId;

  // Vérifie coins côté serveur
  const spendResult = spendCoins(buyer, price);
  if (!spendResult.ok) {
    return res
      .status(400)
      .json({ ok: false, error: "Pas assez de pièces", coins: spendResult.coins });
  }

  // Crédit vendeur
  addCoins(offer.seller, price);

  // Donne les skins à l'acheteur
  const newSkins = addSkin(buyer, skin, qty);

  offer.status = "SOLD";
  offer.buyer = buyer;
  offer.soldAt = Date.now();
  auctions[idx] = offer;
  saveAuctionsDb(auctions);

  console.log(
    `🏦 Achat HDV: ${buyer} a acheté ${qty}x ${skin} à ${offer.seller} pour ${price} coins (id=${id})`
  );

  res.json({
    ok: true,
    offerId: offer.id,
    buyer: buyer,
    coins: spendResult.coins,
    skins: newSkins,
  });
});

// Annuler une offre : rend les skins au vendeur
app.post("/api/auction/cancel-offer", (req, res) => {
  const { pseudo: raw, offerId } = req.body || {};
  const seller = sanitizePseudo(raw);
  const id = (offerId || "").toString();

  const auctions = loadAuctionsDb();
  const idx = auctions.findIndex((o) => o.id === id);
  if (idx === -1) {
    return res
      .status(404)
      .json({ ok: false, error: "Offre introuvable ou déjà fermée" });
  }

  const offer = auctions[idx];
  if (offer.status !== "OPEN") {
    return res
      .status(404)
      .json({ ok: false, error: "Offre introuvable ou déjà fermée" });
  }

  if (offer.seller !== seller) {
    return res
      .status(403)
      .json({ ok: false, error: "Tu ne peux annuler que tes offres" });
  }

  // Rendre les skins au vendeur
  addSkin(seller, offer.skinId, offer.quantity);

  offer.status = "CANCELLED";
  offer.cancelledAt = Date.now();
  auctions[idx] = offer;
  saveAuctionsDb(auctions);

  console.log(
    `🏦 Offre annulée: ${seller} récupère ${offer.quantity}x ${offer.skinId} (id=${id})`
  );

  res.json({ ok: true, offerId: offer.id });
});

// -----------------------------------------------------------------------------
// PAYPAL : create-order & capture-order (LIVE, comme avant)
// -----------------------------------------------------------------------------

// create-order : appelé par le bouton PayPal
app.post("/api/create-order", async (req, res) => {
  try {
    const { pseudo: raw } = req.body || {};
    const pseudo = sanitizePseudo(raw);
    if (!pseudo || typeof pseudo !== "string") {
      return res.status(400).json({ error: "pseudo manquant" });
    }

    const accessToken = await getAccessToken();

    const orderPayload = {
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: "EUR",
            value: COINS_PRICE_EUR,
          },
          custom_id: pseudo,
        },
      ],
      application_context: {
        brand_name: "Cloock",
        shipping_preference: "NO_SHIPPING",
        user_action: "PAY_NOW",
      },
    };

    const resp = await axios.post(
      `${PAYPAL_API_BASE}/v2/checkout/orders`,
      orderPayload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ create-order LIVE OK:", resp.data.id, "pseudo:", pseudo);
    res.json({ id: resp.data.id }); // PayPal attend { id: "..." }
  } catch (err) {
    console.error(
      "❌ Erreur create-order LIVE:",
      err?.response?.data || err.message || err
    );
    res.status(500).json({ error: "Erreur create-order LIVE" });
  }
});

// capture-order : appelé quand le paiement est approuvé
app.post("/api/capture-order", async (req, res) => {
  try {
    const { orderID } = req.body || {};
    if (!orderID) {
      return res.status(400).json({ error: "orderID manquant" });
    }

    const accessToken = await getAccessToken();

    const resp = await axios.post(
      `${PAYPAL_API_BASE}/v2/checkout/orders/${orderID}/capture`,
      {},
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    const captureData = resp.data;
    const pu = captureData.purchase_units?.[0];
    const pseudo = sanitizePseudo(pu?.custom_id || "Inconnu");
    const status = captureData.status;
    let coinsTotal = null;

    if (status === "COMPLETED" && pseudo) {
      coinsTotal = addCoins(pseudo, COINS_PER_PURCHASE);
      console.log(
        `✅ Paiement LIVE OK pour ${pseudo} : +${COINS_PER_PURCHASE} pièces (total = ${coinsTotal})`
      );
    } else {
      console.warn("⚠️ capture LIVE non complétée:", status);
    }

    res.json({ status, pseudo, coins: coinsTotal });
  } catch (err) {
    console.error(
      "❌ Erreur capture-order LIVE:",
      err?.response?.data || err.message || err
    );
    res.status(500).json({ error: "Erreur capture-order LIVE" });
  }
});

// -----------------------------------------------------------------------------
// Lancement serveur
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Serveur Cloock API LIVE (HDV + PayPal) sur port ${PORT}`);
});
