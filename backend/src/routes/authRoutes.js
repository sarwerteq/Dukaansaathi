const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { v4: uuid } = require("uuid");
const db = require("../db");
const { signToken, requireAuth } = require("../auth");
const { sendOtpEmail } = require("../mailer");

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

// POST /api/auth/signup  { shopName, ownerName, phone, email, password, address }
router.post("/signup", (req, res) => {
  const { shopName, ownerName, phone, email, password, address } = req.body || {};
  if (!shopName || !ownerName || !phone || !email || !password) {
    return res.status(400).json({ error: "Shop name, owner name, phone, email and password are required." });
  }
  if (!/^\d{10}$/.test(String(phone))) {
    return res.status(400).json({ error: "Phone number must be 10 digits." });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }
  const existing = db
    .prepare("SELECT id FROM users WHERE phone = ? OR email = ?")
    .get(phone, email);
  if (existing) {
    return res.status(409).json({ error: "An account with this phone number or email already exists." });
  }

  const tx = db.transaction(() => {
    const shopId = uuid();
    db.prepare("INSERT INTO shops (id, name, address) VALUES (?, ?, ?)").run(shopId, shopName, address || null);
    const userId = uuid();
    db.prepare(
      "INSERT INTO users (id, shop_id, name, phone, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?, 'owner')"
    ).run(userId, shopId, ownerName, phone, email, bcrypt.hashSync(password, 10));
    return { id: userId, shop_id: shopId, name: ownerName, role: "owner" };
  });

  const user = tx();
  const token = signToken(user);
  setCookie(res, token);
  res.status(201).json({ token, user: { id: user.id, name: user.name, role: user.role }, shop: { id: user.shop_id, name: shopName } });
});

// POST /api/auth/login  { phone, password }  - original password-based login, kept for existing accounts.
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

// POST /api/auth/otp/request  { identifier }  - identifier is a phone number or an email.
// The code is always emailed to the account's registered email address,
// since that is the only delivery method set up on this server.
router.post("/otp/request", async (req, res) => {
  const identifier = (req.body?.identifier || "").trim();
  if (!identifier) return res.status(400).json({ error: "Enter your phone number or email." });
  const user = db.prepare("SELECT * FROM users WHERE phone = ? OR email = ?").get(identifier, identifier);
  if (!user) return res.status(404).json({ error: "No account found with that phone number or email." });
  if (!user.email) {
    return res.status(400).json({ error: "This account has no email on file yet. Log in with your password and add an email in Settings first." });
  }

  const code = String(crypto.randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO otps (id, user_id, code, expires_at) VALUES (?, ?, ?, ?)").run(uuid(), user.id, code, expiresAt);

  try {
    await sendOtpEmail(user.email, code);
  } catch (err) {
    return res.status(500).json({ error: "Could not send the OTP email. " + err.message });
  }
  const masked = user.email.replace(/^(.)(.*)(@.*)$/, (m, a, b, c) => a + "*".repeat(Math.max(b.length, 1)) + c);
  res.json({ ok: true, maskedEmail: masked });
});

// POST /api/auth/otp/verify  { identifier, code }
router.post("/otp/verify", (req, res) => {
  const identifier = (req.body?.identifier || "").trim();
  const code = (req.body?.code || "").trim();
  if (!identifier || !code) return res.status(400).json({ error: "Enter the code sent to your email." });
  const user = db.prepare("SELECT * FROM users WHERE phone = ? OR email = ?").get(identifier, identifier);
  if (!user) return res.status(404).json({ error: "No account found with that phone number or email." });

  const otp = db
    .prepare(
      "SELECT * FROM otps WHERE user_id = ? AND code = ? AND used = 0 ORDER BY created_at DESC LIMIT 1"
    )
    .get(user.id, code);
  if (!otp) return res.status(401).json({ error: "Incorrect code." });
  if (new Date(otp.expires_at) < new Date()) return res.status(401).json({ error: "This code has expired. Request a new one." });

  db.prepare("UPDATE otps SET used = 1 WHERE id = ?").run(otp.id);
  const token = signToken(user);
  setCookie(res, token);
  const shop = db.prepare("SELECT * FROM shops WHERE id = ?").get(user.shop_id);
  res.json({ token, user: { id: user.id, name: user.name, role: user.role }, shop });
});

router.post("/logout", (req, res) => {
  res.clearCookie("ds_token").json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, name, phone, email, role FROM users WHERE id = ?").get(req.user.id);
  const shop = db.prepare("SELECT * FROM shops WHERE id = ?").get(req.user.shopId);
  if (!user || !shop) return res.status(404).json({ error: "Account not found." });
  res.json({ user, shop });
});

module.exports = router;
