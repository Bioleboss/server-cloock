// server.js
// Backend Cloock + PayPal Checkout (LIVE)

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
// "BDD" simple JSON pour les coins
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

function addCoins(pseudo, amount) {
  const db = loadDb();
  if (!db[pseudo]) db[pseudo] = { coins: 0 };
  db[pseudo].coins += amount;
  saveDb(db);
  return db[pseudo].coins;
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
// API
// -----------------------------------------------------------------------------

// ping pour vérifier le serveur vite fait
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    paypalClient: PAYPAL_CLIENT_ID ? "ok" : "missing",
    mode: "live",
  });
});

// récupérer les coins d'un joueur
app.get("/api/player/:pseudo", (req, res) => {
  const pseudo = req.params.pseudo;
  const db = loadDb();
  const coins = db[pseudo]?.coins || 0;
  res.json({ pseudo, coins });
});

// create-order : appelé par le bouton PayPal
app.post("/api/create-order", async (req, res) => {
  try {
    const { pseudo } = req.body || {};
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
    const pseudo = pu?.custom_id || "Inconnu";
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
  console.log(`🌐 Serveur Cloock API LIVE sur port ${PORT}`);
});
