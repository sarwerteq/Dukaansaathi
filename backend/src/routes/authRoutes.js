const express = require("express");
const bcrypt = require("bcryptjs");
const { v4: uuid } = require("uuid");
const db = require("../db");
const { signToken, requireAuth } = require("../auth");

const router = express.Router();
const isProd = process.env.NODE_ENV === "production";

function setCookie(res, token) {
  res.cookie("ds_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

// POST /api/auth/signup  { shopName, ownerName, phone, password }
// Creates a brand-new shop plus its first (owner) login, in one step -
// this is what makes the app multi-shop: every signup gets its own
// isolated shop_id that all their data is scoped under.
router.post("/signup", (req, res) => {
  const { shopName, ownerName, phone, password, address } = req.body || {};
  if (!shopName || !ownerName || !phone || !password) {
    return res.status(400).json({ error: "Shop name, owner name, phone and password are required." });
  }
  if (!/^\d{10}$/.test(String(phone))) {
    return res.status(400).json({ error: "Phone number must be 10 digits." });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }
  const existing = db.prepare("SELECT id FROM users WHERE phone = ?").get(phone);
  if (existing) {
    return res.status(409).json({ error: "An account with this phone number already exists." });
  }

  const tx = db.transaction(() => {
    const shopId = uuid();
    db.prepare("INSERT INTO shops (id, name, address) VALUES (?, ?, ?)").run(shopId, shopName, address || null);
    const userId = uuid();
    db.prepare(
      "INSERT INTO users (id, shop_id, name, phone, password_hash, role) VALUES (?, ?, ?, ?, ?, 'owner')"
    ).run(userId, shopId, ownerName, phone, bcrypt.hashSync(password, 10));
    return { id: userId, shop_id: shopId, name: ownerName, role: "owner" };
  });

  const user = tx();
  const token = signToken(user);
  setCookie(res, token);
  res.status(201).json({ token, user: { id: user.id, name: user.name, role: user.role }, shop: { id: user.shop_id, name: shopName } });
});

// POST /api/auth/login  { phone, password }
router.post("/login", (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: "Phone and password are required." });
  const user = db.prepare("SELECT * FROM users WHERE phone = ?").get(phone);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid phone number or password." });
  }
  const token = signToken(user);
  setCookie(res, token);
  const shop = db.prepare("SELECT * FROM shops WHERE id = ?").get(user.shop_id);
  res.json({ token, user: { id: user.id, name: user.name, role: user.role }, shop });
});

router.post("/logout", (req, res) => {
  res.clearCookie("ds_token").json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, name, phone, role FROM users WHERE id = ?").get(req.user.id);
  const shop = db.prepare("SELECT * FROM shops WHERE id = ?").get(req.user.shopId);
  if (!user || !shop) return res.status(404).json({ error: "Account not found." });
  res.json({ user, shop });
});

module.exports = router;
