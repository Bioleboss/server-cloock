// server.js
// Backend Cloock + PayPal Checkout (LIVE ready version)

const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors()); // autorise les requêtes depuis ton jeu web

// -----------------------------------------------------------------------------
// CONFIG PAYPAL
// -----------------------------------------------------------------------------
// ⚠️ Mets ici tes vraies clés PayPal LIVE
const PAYPAL_CLIENT_ID = "AVLfw6qT49fViHsi5N4_FcFZPJsgoUv000X9GG0dxTb8FXWFTb_BZDsJ7563fNv-KqniwwzplUfr2mC-";
const PAYPAL_CLIENT_SECRET = "EHDWirybXftybUe5--GTL0GlX54myv30Vjz04036Ek4iZHowOUlONYFyxHVwTo654YLS-i0_r7vNyRbt";
const PAYPAL_MODE = "live"; // "sandbox" pour test, "live" pour production

const PAYPAL_API_BASE =
  PAYPAL_MODE === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

// 3€ => 6000 pièces
const COINS_PER_PURCHASE = 6000;
const COINS_PRICE_EUR = "3.00";

// -----------------------------------------------------------------------------
// "BDD" simple : fichier JSON local
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
// PAYPAL HELPER : récupérer un access_token
// -----------------------------------------------------------------------------

async function getAccessToken() {
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

// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, mode: PAYPAL_MODE });
});

// Récupérer les pièces d'un pseudo
app.get("/api/player/:pseudo", (req, res) => {
  const pseudo = req.params.pseudo;
  const db = loadDb();
  const coins = db[pseudo]?.coins || 0;
  res.json({ pseudo, coins });
});

/*
  1️⃣ create-order
  Le front envoie le pseudo du joueur.
  On crée une commande PayPal avec custom_id = pseudo.
*/
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

    res.json({ id: resp.data.id });
  } catch (err) {
    console.error("Erreur create-order:", err?.response?.data || err.message);
    res.status(500).json({ error: "Erreur create-order" });
  }
});

/*
  2️⃣ capture-order
  Appelé par le front après que l'utilisateur ait approuvé le paiement.
  On capture, on lit custom_id (pseudo), et on crédite 6000 pièces.
*/
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
        `✅ Paiement OK pour ${pseudo} : +${COINS_PER_PURCHASE} pièces (total = ${coinsTotal})`
      );
    }

    res.json({ status, pseudo, coins: coinsTotal });
  } catch (err) {
    console.error("Erreur capture-order:", err?.response?.data || err.message);
    res.status(500).json({ error: "Erreur capture-order" });
  }
});

// -----------------------------------------------------------------------------
// Lancement serveur
// -----------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Serveur Cloock API actif sur http://localhost:${PORT}`);
});
