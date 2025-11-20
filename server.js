// server.js
// Cloock — Backend LIVE : PayPal + Inventaire + Coins + HDV Multi

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import axios from "axios";

// ============ SETUP ============

const app = express();
app.use(cors());
app.use(express.json());

const DATA_FILE = path.join("./players.json");

// Charge la DB JSON
function loadDb() {
  try {
    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

// Sauvegarde la DB
function saveDb(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
}

// Petit helper
function clean(p) {
  return (p || "Invité").toString().trim().replace(/[|:]/g, "") || "Invité";
}

// ========== CONSTANTES ==========
const COINS_PER_EURO = 3000; // 1€ → 3000 coins

// CONFIG PAYPAL LIVE
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_API_BASE = "https://api-m.paypal.com"; // LIVE

// Token PayPal
async function getAccessToken() {
  const creds = Buffer.from(
    PAYPAL_CLIENT_ID + ":" + PAYPAL_CLIENT_SECRET
  ).toString("base64");

  const resp = await axios.post(
    PAYPAL_API_BASE + "/v1/oauth2/token",
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: "Basic " + creds,
        "Content-Type": "application/x-www-form-urlencoded",
      }
    }
  );

  return resp.data.access_token;
}

// =============== BACKEND PLAYER ===============

// coins + inventaire (set de skins)
function getPlayer(pseudo) {
  const db = loadDb();
  if (!db[pseudo]) {
    db[pseudo] = {
      coins: 0,
      inventory: [],
      history: []
    };
    saveDb(db);
  }
  return db[pseudo];
}

function setPlayer(pseudo, data) {
  const db = loadDb();
  db[pseudo] = data;
  saveDb(db);
}

// + coins
function addCoins(pseudo, amount) {
  const p = getPlayer(pseudo);
  p.coins += amount;
  setPlayer(pseudo, p);
  return p.coins;
}

// Ajouter historique
function addHistory(pseudo, type, message) {
  const p = getPlayer(pseudo);
  p.history.push({
    type,
    message,
    ts: Date.now()
  });
  setPlayer(pseudo, p);
}

// Donner skin
function giveSkin(pseudo, skinId, qty = 1) {
  const p = getPlayer(pseudo);
  if (!p.inventory) p.inventory = [];
  for (let i = 0; i < qty; i++) p.inventory.push(skinId);
  setPlayer(pseudo, p);
}

// ================ API JOUEUR ================

// Sync joueur complet
app.post("/api/sync", (req, res) => {
  const pseudo = clean(req.body.pseudo);
  const p = getPlayer(pseudo);
  res.json({
    ok: true,
    player: {
      coins: p.coins,
      inventory: p.inventory,
      history: p.history
    }
  });
});

// ================ PAYPAL ================

// Create Order
app.post("/api/create-order", async (req, res) => {
  try {
    const pseudo = clean(req.body.pseudo);
    let amount = parseFloat(req.body.amount || "1");
    if (isNaN(amount) || amount < 1) amount = 1;
    const amountStr = amount.toFixed(2);

    const access = await getAccessToken();

    const payload = {
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: "EUR",
            value: amountStr
          },
          custom_id: pseudo
        }
      ],
      application_context: {
        brand_name: "Cloock",
        shipping_preference: "NO_SHIPPING",
        user_action: "PAY_NOW"
      }
    };

    const resp = await axios.post(
      PAYPAL_API_BASE + "/v2/checkout/orders",
      payload,
      { headers: { Authorization: "Bearer " + access } }
    );

    res.json({ id: resp.data.id });

  } catch (e) {
    console.error("create-order ERROR:", e.response?.data || e);
    res.status(500).json({ error: "Erreur PayPal create-order" });
  }
});

// Capture Order
app.post("/api/capture-order", async (req, res) => {
  try {
    const { orderID } = req.body;
    const access = await getAccessToken();

    const resp = await axios.post(
      PAYPAL_API_BASE + `/v2/checkout/orders/${orderID}/capture`,
      {},
      { headers: { Authorization: "Bearer " + access } }
    );

    const data = resp.data;
    const pu = data.purchase_units?.[0];
    const pseudo = clean(pu?.custom_id);
    const status = data.status;

    if (status !== "COMPLETED") {
      return res.json({ status });
    }

    const amountStr = pu?.payments?.captures?.[0]?.amount?.value || "0";
    const amount = parseFloat(amountStr) || 0;

    const coinsToAdd = Math.round(amount * COINS_PER_EURO);
    const totalCoins = addCoins(pseudo, coinsToAdd);

    addHistory(pseudo, "PAYPAL", `Achat PayPal ${amountStr}€ → +${coinsToAdd} coins`);

    res.json({
      status: "COMPLETED",
      pseudo,
      coinsAdded: coinsToAdd,
      coinsTotal: totalCoins
    });

  } catch (e) {
    console.error("capture-order ERROR:", e.response?.data || e);
    res.status(500).json({ error: "Erreur PayPal capture-order" });
  }
});

// ================ HDV MULTI-JOUEURS ================

let offers = []; // en mémoire

app.get("/api/auction/offers", (req, res) => {
  res.json({ ok: true, offers });
});

app.post("/api/auction/create", (req, res) => {
  const pseudo = clean(req.body.pseudo);
  const skinId = req.body.skinId;
  const qty = parseInt(req.body.quantity || "1");
  const price = parseInt(req.body.price || "1");

  if (!skinId || qty < 1 || price < 1) {
    return res.json({ ok: false, error: "Params invalides" });
  }

  const inv = getPlayer(pseudo).inventory;
  const count = inv.filter(x => x === skinId).length;

  if (count < qty) {
    return res.json({ ok: false, error: "Pas assez de skins" });
  }

  // retirer du joueur
  const newInv = [...inv];
  for (let i = 0; i < qty; i++) {
    const idx = newInv.indexOf(skinId);
    if (idx >= 0) newInv.splice(idx, 1);
  }
  const p = getPlayer(pseudo);
  p.inventory = newInv;
  setPlayer(pseudo, p);

  const offer = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    seller: pseudo,
    skinId,
    quantity: qty,
    price,
    status: "OPEN"
  };
  offers.push(offer);

  addHistory(pseudo, "HDV", `Mise en vente ${qty}× ${skinId} pour ${price} coins`);
  res.json({ ok: true });
});

app.post("/api/auction/buy", (req, res) => {
  const pseudo = clean(req.body.pseudo);
  const id = req.body.offerId;

  const off = offers.find(o => o.id === id);
  if (!off || off.status !== "OPEN") {
    return res.json({ ok: false, error: "Offer INVALID" });
  }

  const buyer = getPlayer(pseudo);
  if (buyer.coins < off.price) {
    return res.json({ ok: false, error: "Coins insuffisants" });
  }

  buyer.coins -= off.price;
  giveSkin(pseudo, off.skinId, off.quantity);
  addHistory(pseudo, "HDV", `Achat ${off.quantity}× ${off.skinId} pour ${off.price} coins`);

  // payer le vendeur
  addCoins(off.seller, off.price);
  addHistory(off.seller, "HDV", `Vendu ${off.quantity}× ${off.skinId} pour ${off.price} coins`);

  off.status = "SOLD";
  off.buyer = pseudo;

  res.json({ ok: true });
});

app.post("/api/auction/cancel", (req, res) => {
  const pseudo = clean(req.body.pseudo);
  const id = req.body.offerId;

  const off = offers.find(o => o.id === id);
  if (!off || off.status !== "OPEN") {
    return res.json({ ok: false, error: "Offer INVALID" });
  }

  if (off.seller !== pseudo) {
    return res.json({ ok: false, error: "Not owner" });
  }

  giveSkin(pseudo, off.skinId, off.quantity);
  off.status = "CANCELLED";

  addHistory(pseudo, "HDV", `Annulation de vente ${off.quantity}× ${off.skinId}`);

  res.json({ ok: true });
});

// ================ HEALTHCHECK ================

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    paypalClient: PAYPAL_CLIENT_ID ? "ok" : "missing",
    mode: "live",
    offers: offers.length
  });
});

// ================ START ================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🌐 Cloock API LIVE running on", PORT);
});
