const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuid } = require("uuid");
const db = require("../db");
const { requireAuth } = require("../auth");

const router = express.Router();
router.use(requireAuth);

const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = ALLOWED_TYPES.has(file.mimetype) ? "." + file.mimetype.split("/")[1].replace("jpeg", "jpg") : "";
      cb(null, `${uuid()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_TYPES.has(file.mimetype)) return cb(new Error("Only JPG, PNG or WEBP images are allowed."));
    cb(null, true);
  },
});

// PUT /api/shop  { name, address, upiId }
router.put("/", (req, res) => {
  const existing = db.prepare("SELECT * FROM shops WHERE id = ?").get(req.user.shopId);
  if (!existing) return res.status(404).json({ error: "Shop not found." });
  const { name, address, upiId } = req.body || {};
  db.prepare("UPDATE shops SET name = ?, address = ?, upi_id = ? WHERE id = ?").run(
    name ?? existing.name,
    address ?? existing.address,
    upiId ?? existing.upi_id,
    req.user.shopId
  );
  res.json(db.prepare("SELECT * FROM shops WHERE id = ?").get(req.user.shopId));
});

// POST /api/shop/qr  (multipart/form-data, field name "qr")
// Uploads a static payment QR code image for shops that want to show a
// fixed QR (e.g. one printed/given by their bank) instead of, or alongside,
// the auto-generated UPI-amount QR built from upiId.
router.post("/qr", (req, res) => {
  upload.single("qr")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No image file received." });
    db.prepare("UPDATE shops SET qr_image_path = ? WHERE id = ?").run(`/uploads/${req.file.filename}`, req.user.shopId);
    res.status(201).json(db.prepare("SELECT * FROM shops WHERE id = ?").get(req.user.shopId));
  });
});

// POST /api/shop/logo  (multipart/form-data, field name "logo")
router.post("/logo", (req, res) => {
  upload.single("logo")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No image file received." });
    db.prepare("UPDATE shops SET logo_path = ? WHERE id = ?").run(`/uploads/${req.file.filename}`, req.user.shopId);
    res.status(201).json(db.prepare("SELECT * FROM shops WHERE id = ?").get(req.user.shopId));
  });
});

module.exports = router;
