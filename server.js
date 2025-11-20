// server.js
// Cloock backend : PayPal LIVE + coins + inventaire + HDV + échange en ligne

const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cors = require("cors");

const app = express();

// CORS large
app.use(cors());
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
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_API_BASE = "https://api-m.paypal.com"; // LIVE

// 1 € = 3000 pièces
const COINS_PER_EURO = 3000;

// -----------------------------------------------------------------------------
// "BDD" JSON pour coins + inventaire + historique
// -----------------------------------------------------------------------------
const DB_FILE = path.join(__dirname, "players.json");

function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) return {};
    const raw = fs.readFileSync(DB_FILE, "utf8");
    return JSON.parse(raw || "{}");
  } catch (e) {
    console.error("Erreur lecture DB:", e);
    return {};
  }
}

function saveDb(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
  } catch (e) {
    console.error("Erreur écriture DB:", e);
  }
}

function sanitizePseudo(p) {
  return (p || "Invité").toString().trim().replace(/[|:]/g, "") || "Invité";
}

function ensurePlayer(db, pseudo) {
  const name = sanitizePseudo(pseudo);
  if (!db[name]) {
    db[name] = {
      coins: 0,
      // 1 skin basique par défaut
      inventory: ["basic"],
      history: []
    };
  }
  const p = db[name];
  if (!Array.isArray(p.inventory)) p.inventory = [];
  if (!Array.isArray(p.history)) p.history = [];
  if (typeof p.coins !== "number") p.coins = 0;
  return { player: p, name };
}

function addHistoryEntry(player, type, message) {
  player.history.push({ type, message, ts: Date.now() });
  if (player.history.length > 200) {
    player.history.shift();
  }
}

function countInventory(player, skinId) {
  if (!Array.isArray(player.inventory)) return 0;
  return player.inventory.filter((id) => id === skinId).length;
}

function removeSkins(player, skinId, qty) {
  if (!Array.isArray(player.inventory)) player.inventory = [];
  let remaining = qty;
  player.inventory = player.inventory.filter((id) => {
    if (id === skinId && remaining > 0) {
      remaining--;
      return false;
    }
    return true;
  });
}

function addSkins(player, skinId, qty) {
  if (!Array.isArray(player.inventory)) player.inventory = [];
  for (let i = 0; i < qty; i++) {
    player.inventory.push(skinId);
  }
}

// coins via PayPal
function addCoinsToPlayer(db, pseudo, amount, label) {
  const { player, name } = ensurePlayer(db, pseudo);
  player.coins = (player.coins || 0) + amount;
  if (label) {
    addHistoryEntry(
      player,
      "PAYPAL",
      `${label} : +${amount} pièces (total = ${player.coins})`
    );
  }
  return { totalCoins: player.coins, name };
}

// -----------------------------------------------------------------------------
// PAYPAL : access_token LIVE
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
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  return resp.data.access_token;
}

// -----------------------------------------------------------------------------
// HDV : en mémoire (non persistant, c'est OK pour le moment)
// -----------------------------------------------------------------------------
let auctionOffers = [];

// -----------------------------------------------------------------------------
// API
// -----------------------------------------------------------------------------

// Healthcheck
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    paypalClient: PAYPAL_CLIENT_ID ? "ok" : "missing",
    mode: "live",
    hdvOffers: auctionOffers.length
  });
});

// Récupérer les infos d'un joueur (debug)
app.get("/api/player/:pseudo", (req, res) => {
  const db = loadDb();
  const { player, name } = ensurePlayer(db, req.params.pseudo);
  res.json({
    pseudo: name,
    coins: player.coins,
    inventory: player.inventory,
    history: player.history
  });
});

// SYNC global : coins + inventaire + historique
app.post("/api/sync", (req, res) => {
  try {
    const { pseudo } = req.body || {};
    if (!pseudo) {
      return res.status(400).json({ ok: false, error: "pseudo manquant" });
    }
    const db = loadDb();
    const { player, name } = ensurePlayer(db, pseudo);
    res.json({
      ok: true,
      player: {
        pseudo: name,
        coins: player.coins,
        inventory: player.inventory || [],
        history: player.history || []
      }
    });
  } catch (e) {
    console.error("Erreur /api/sync:", e);
    res.status(500).json({ ok: false, error: "Erreur interne sync" });
  }
});

// -----------------------------------------------------------------------------
// ECHANGE EN LIGNE
// -----------------------------------------------------------------------------
app.post("/api/exchange/send", (req, res) => {
  try {
    let { from, to, skinId, quantity } = req.body || {};
    if (!from || !to || !skinId) {
      return res
        .status(400)
        .json({ ok: false, error: "from, to ou skinId manquant" });
    }
    const q = parseInt(quantity, 10) || 0;
    if (q <= 0) {
      return res.status(400).json({ ok: false, error: "Quantité invalide" });
    }

    const db = loadDb();
    const fromInfo = ensurePlayer(db, from);
    const toInfo = ensurePlayer(db, to);
    const fromPlayer = fromInfo.player;
    const toPlayer = toInfo.player;
    const fromName = fromInfo.name;
    const toName = toInfo.name;

    const have = countInventory(fromPlayer, skinId);
    if (have < q) {
      return res
        .status(400)
        .json({ ok: false, error: "Inventaire insuffisant" });
    }

    removeSkins(fromPlayer, skinId, q);
    addSkins(toPlayer, skinId, q);

    addHistoryEntry(
      fromPlayer,
      "ECHANGE",
      `Tu envoies ${q}× ${skinId} à ${toName}`
    );
    addHistoryEntry(
      toPlayer,
      "ECHANGE",
      `${fromName} t'envoie ${q}× ${skinId}`
    );

    saveDb(db);

    res.json({ ok: true });
  } catch (e) {
    console.error("Erreur /api/exchange/send:", e);
    res.status(500).json({ ok: false, error: "Erreur interne échange" });
  }
});

// -----------------------------------------------------------------------------
// HDV : offres
// -----------------------------------------------------------------------------

// Liste des offres ouvertes
app.get("/api/auction/offers", (req, res) => {
  const openOffers = auctionOffers
    .filter((o) => o.status === "OPEN")
    .map((o) => ({
      id: o.id,
      skinId: o.skinId,
      skinName: o.skinName,
      seller: o.seller,
      quantity: o.quantity,
      price: o.price
    }));
  res.json({ ok: true, offers: openOffers });
});

// Créer une offre HDV
app.post("/api/auction/create", (req, res) => {
  try {
    const { pseudo, skinId, quantity, price } = req.body || {};
    if (!pseudo || !skinId) {
      return res
        .status(400)
        .json({ ok: false, error: "pseudo ou skinId manquant" });
    }
    const qty = parseInt(quantity, 10);
    const pr = parseInt(price, 10);
    if (!qty || qty <= 0 || !pr || pr <= 0) {
      return res
        .status(400)
        .json({ ok: false, error: "Quantité ou prix invalide" });
    }

    const db = loadDb();
    const { player: seller, name: sellerName } = ensurePlayer(db, pseudo);
    const have = countInventory(seller, skinId);
    if (have < qty) {
      return res
        .status(400)
        .json({ ok: false, error: "Pas assez de copies de ce skin" });
    }

    removeSkins(seller, skinId, qty);
    addHistoryEntry(
      seller,
      "HDV",
      `Mise en vente ${qty}× ${skinId} pour ${pr} pièces`
    );
    saveDb(db);

    const id =
      String(Date.now()) + "_" + Math.random().toString(36).slice(2, 7);
    const offer = {
      id,
      skinId,
      skinName: skinId,
      seller: sellerName,
      quantity: qty,
      price: pr,
      status: "OPEN",
      createdAt: Date.now()
    };
    auctionOffers.push(offer);

    res.json({
      ok: true,
      offer: {
        id: offer.id,
        skinId: offer.skinId,
        skinName: offer.skinName,
        seller: offer.seller,
        quantity: offer.quantity,
        price: offer.price
      }
    });
  } catch (e) {
    console.error("Erreur /api/auction/create:", e);
    res.status(500).json({ ok: false, error: "Erreur interne HDV" });
  }
});

// Acheter une offre HDV
app.post("/api/auction/buy", (req, res) => {
  try {
    const { pseudo, offerId } = req.body || {};
    if (!pseudo || !offerId) {
      return res
        .status(400)
        .json({ ok: false, error: "pseudo ou offerId manquant" });
    }

    const db = loadDb();
    const buyerInfo = ensurePlayer(db, pseudo);
    const buyer = buyerInfo.player;
    const buyerName = buyerInfo.name;

    const offer = auctionOffers.find((o) => o.id === offerId);
    if (!offer || offer.status !== "OPEN") {
      return res
        .status(404)
        .json({ ok: false, error: "Offre introuvable ou fermée" });
    }

    if (offer.seller === buyerName) {
      return res
        .status(400)
        .json({ ok: false, error: "Tu ne peux pas acheter ta propre offre" });
    }

    if ((buyer.coins || 0) < offer.price) {
      return res.status(400).json({ ok: false, error: "Pas assez de pièces" });
    }

    const sellerInfo = ensurePlayer(db, offer.seller);
    const seller = sellerInfo.player;
    const sellerName = sellerInfo.name;

    buyer.coins -= offer.price;
    seller.coins = (seller.coins || 0) + offer.price;

    addSkins(buyer, offer.skinId, offer.quantity);

    addHistoryEntry(
      buyer,
      "HDV",
      `Achat ${offer.quantity}× ${offer.skinId} pour ${offer.price} pièces (vendeur: ${sellerName})`
    );
    addHistoryEntry(
      seller,
      "HDV",
      `Vente ${offer.quantity}× ${offer.skinId} pour ${offer.price} pièces (acheteur: ${buyerName})`
    );

    offer.status = "SOLD";
    offer.buyer = buyerName;
    offer.soldAt = Date.now();

    saveDb(db);

    res.json({ ok: true, offerId: offer.id });
  } catch (e) {
    console.error("Erreur /api/auction/buy:", e);
    res.status(500).json({ ok: false, error: "Erreur interne HDV" });
  }
});

// Annuler une offre HDV
app.post("/api/auction/cancel", (req, res) => {
  try {
    const { pseudo, offerId } = req.body || {};
    if (!pseudo || !offerId) {
      return res
        .status(400)
        .json({ ok: false, error: "pseudo ou offerId manquant" });
    }

    const db = loadDb();
    const { player: seller, name: sellerName } = ensurePlayer(db, pseudo);

    const offer = auctionOffers.find((o) => o.id === offerId);
    if (!offer || offer.status !== "OPEN") {
      return res
        .status(404)
        .json({ ok: false, error: "Offre introuvable ou fermée" });
    }

    if (offer.seller !== sellerName) {
      return res
        .status(403)
        .json({ ok: false, error: "Tu ne peux annuler que tes offres" });
    }

    offer.status = "CANCELLED";
    offer.cancelledAt = Date.now();

    addSkins(seller, offer.skinId, offer.quantity);
    addHistoryEntry(
      seller,
      "HDV",
      `Annulation de vente ${offer.quantity}× ${offer.skinId}`
    );

    saveDb(db);

    res.json({ ok: true, offerId: offer.id });
  } catch (e) {
    console.error("Erreur /api/auction/cancel:", e);
    res.status(500).json({ ok: false, error: "Erreur interne HDV" });
  }
});

// -----------------------------------------------------------------------------
// PAYPAL : create-order & capture-order (LIVE)
// -----------------------------------------------------------------------------

// create-order : avec montant dynamique
app.post("/api/create-order", async (req, res) => {
  try {
    const { pseudo, amount } = req.body || {};
    if (!pseudo) {
      return res.status(400).json({ error: "pseudo manquant" });
    }
    let val = parseFloat(amount || "3.00");
    if (isNaN(val) || val < 1) val = 1;
    const valueStr = val.toFixed(2);

    const accessToken = await getAccessToken();

    const orderPayload = {
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: "EUR",
            value: valueStr
          },
          custom_id: sanitizePseudo(pseudo)
        }
      ],
      application_context: {
        brand_name: "Cloock",
        shipping_preference: "NO_SHIPPING",
        user_action: "PAY_NOW"
      }
    };

    const resp = await axios.post(
      `${PAYPAL_API_BASE}/v2/checkout/orders`,
      orderPayload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(
      "✅ create-order LIVE OK:",
      resp.data.id,
      "pseudo:",
      pseudo,
      "montant:",
      valueStr
    );
    res.json({ id: resp.data.id });
  } catch (err) {
    console.error(
      "❌ Erreur create-order LIVE:",
      err?.response?.data || err.message || err
    );
    res.status(500).json({ error: "Erreur create-order LIVE" });
  }
});

// capture-order : crédite les pièces en fonction du montant payé
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
          "Content-Type": "application/json"
        }
      }
    );

    const captureData = resp.data;
    const status = captureData.status;
    const pu = captureData.purchase_units?.[0];
    const pseudoFromOrder = pu?.custom_id || "Inconnu";
    const paidStr = pu?.amount?.value || "0.00";
    const paidVal = parseFloat(paidStr) || 0;
    const coinsToAdd = Math.round(paidVal * COINS_PER_EURO);

    let coinsTotal = null;
    if (status === "COMPLETED" && coinsToAdd > 0) {
      const db = loadDb();
      const resCoins = addCoinsToPlayer(
        db,
        pseudoFromOrder,
        coinsToAdd,
        `Paiement PayPal ${paidVal}€`
      );
      coinsTotal = resCoins.totalCoins;
      saveDb(db);
      console.log(
        `✅ Paiement LIVE OK pour ${resCoins.name} : +${coinsToAdd} pièces (total = ${coinsTotal})`
      );
    } else {
      console.warn("⚠️ capture LIVE non complétée ou 0€ payé:", status);
    }

    res.json({
      status,
      pseudo: sanitizePseudo(pseudoFromOrder),
      coins: coinsTotal,
      coinsAdded: coinsToAdd
    });
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
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🌐 Serveur Cloock API LIVE sur port ${PORT}`);
});
