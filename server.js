// server.js
// Cloock backend simplifié : HDV multi + stubs PayPal

import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// In-memory store (Render relancera le process parfois, donc pas persistant)
let auctionOffers = [];

// Petit helper pour sécuriser les pseudos
function sanitizePseudo(p) {
  return (p || "Invité").toString().trim().replace(/[|:]/g, "") || "Invité";
}

// Healthcheck
app.get("/", (req, res) => {
  res.json({ ok: true, service: "Cloock backend", hdvOffers: auctionOffers.length });
});

// ============ HDV MULTI ============

// Liste des offres ouvertes
app.get("/api/auction/offers", (req, res) => {
  const openOffers = auctionOffers
    .filter(o => o.status === "OPEN")
    .map(o => ({
      id: o.id,
      skinId: o.skinId,
      skinName: o.skinName,
      seller: o.seller,
      quantity: o.quantity,
      price: o.price
    }));
  res.json({ ok: true, offers: openOffers });
});

// Créer une offre
app.post("/api/auction/create-offer", (req, res) => {
  const { pseudo, skinId, quantity, price } = req.body || {};
  const seller = sanitizePseudo(pseudo);
  const skin = (skinId || "").toString().trim();
  const qty = parseInt(quantity, 10);
  const pr = parseInt(price, 10);

  if (!seller || !skin || isNaN(qty) || qty <= 0 || isNaN(pr) || pr <= 0) {
    return res.status(400).json({ ok: false, error: "Paramètres invalides" });
  }

  const id = String(Date.now()) + "_" + Math.random().toString(36).slice(2, 7);

  const offer = {
    id,
    skinId: skin,
    skinName: skin, // le client affiche un joli nom
    seller,
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
});

// Acheter une offre
app.post("/api/auction/buy-offer", (req, res) => {
  const { pseudo, offerId } = req.body || {};
  const buyer = sanitizePseudo(pseudo);
  const id = (offerId || "").toString();

  const offer = auctionOffers.find(o => o.id === id);

  if (!offer || offer.status !== "OPEN") {
    return res.status(404).json({ ok: false, error: "Offre introuvable ou déjà prise" });
  }

  if (offer.seller === buyer) {
    return res.status(400).json({ ok: false, error: "Tu ne peux pas acheter ta propre offre" });
  }

  // Ici tu pourrais check les coins côté serveur si tu les synchronises un jour
  offer.status = "SOLD";
  offer.buyer = buyer;
  offer.soldAt = Date.now();

  res.json({ ok: true, offerId: offer.id });
});

// Annuler une offre
app.post("/api/auction/cancel-offer", (req, res) => {
  const { pseudo, offerId } = req.body || {};
  const seller = sanitizePseudo(pseudo);
  const id = (offerId || "").toString();

  const offer = auctionOffers.find(o => o.id === id);

  if (!offer || offer.status !== "OPEN") {
    return res.status(404).json({ ok: false, error: "Offre introuvable ou déjà fermée" });
  }

  if (offer.seller !== seller) {
    return res.status(403).json({ ok: false, error: "Tu ne peux annuler que tes offres" });
  }

  offer.status = "CANCELLED";
  offer.cancelledAt = Date.now();

  res.json({ ok: true, offerId: offer.id });
});

// ============ STUBS PAYPAL ============
// Remplace ça par ta vraie intégration PayPal si tu as déjà un code fonctionnel.

app.post("/api/create-order", (req, res) => {
  // Ici normalement tu appelles PayPal Orders API.
  // Stub très simple :
  const fakeOrderId = "ORDER-" + Date.now();
  res.json({ id: fakeOrderId });
});

app.post("/api/capture-order", (req, res) => {
  const { orderID } = req.body || {};
  // Normalement tu appelles PayPal pour capturer.
  // Stub : on dit que c'est toujours COMPLETED.
  res.json({
    status: "COMPLETED",
    orderID: orderID || null,
    pseudo: null
  });
});

// ============ START SERVER ============

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Cloock backend listening on port", PORT);
});
