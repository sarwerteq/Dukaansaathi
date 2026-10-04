const express = require("express");
const db = require("../db");
const { requireAuth } = require("../auth");

const router = express.Router();
router.use(requireAuth);

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

module.exports = router;
