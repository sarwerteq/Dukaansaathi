const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db");
const { requireAuth } = require("../auth");

const router = express.Router();
router.use(requireAuth);

router.get("/", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM products WHERE shop_id = ? AND active = 1 ORDER BY name")
    .all(req.user.shopId);
  res.json(rows);
});

router.post("/", (req, res) => {
  const { name, category, unit, price, stockQty, lowStockAlert } = req.body || {};
  if (!name) return res.status(400).json({ error: "Product name is required." });
  const id = uuid();
  db.prepare(
    `INSERT INTO products (id, shop_id, name, category, unit, price, stock_qty, low_stock_alert)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.user.shopId, name, category || null, unit || "pcs", price || 0, stockQty || 0, lowStockAlert ?? 5);
  if (stockQty) {
    db.prepare(
      "INSERT INTO stock_transactions (id, shop_id, product_id, type, qty, note) VALUES (?, ?, ?, 'In', ?, 'Opening stock')"
    ).run(uuid(), req.user.shopId, id, stockQty);
  }
  res.status(201).json(db.prepare("SELECT * FROM products WHERE id = ?").get(id));
});

function getOwnedProduct(req) {
  return db.prepare("SELECT * FROM products WHERE id = ? AND shop_id = ?").get(req.params.id, req.user.shopId);
}

router.put("/:id", (req, res) => {
  const existing = getOwnedProduct(req);
  if (!existing) return res.status(404).json({ error: "Product not found." });
  const b = req.body || {};
  db.prepare(
    `UPDATE products SET name=?, category=?, unit=?, price=?, low_stock_alert=?, active=? WHERE id = ?`
  ).run(
    b.name ?? existing.name,
    b.category ?? existing.category,
    b.unit ?? existing.unit,
    b.price ?? existing.price,
    b.lowStockAlert ?? existing.low_stock_alert,
    b.active === undefined ? existing.active : b.active ? 1 : 0,
    req.params.id
  );
  res.json(db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id));
});

// POST /api/products/:id/adjust-stock  { qty, type: "In"|"Out"|"Adjustment", note }
// qty is always a positive number; type decides whether it adds or removes.
router.post("/:id/adjust-stock", (req, res) => {
  const existing = getOwnedProduct(req);
  if (!existing) return res.status(404).json({ error: "Product not found." });
  const { qty, type, note } = req.body || {};
  const amount = parseFloat(qty);
  if (!amount || amount <= 0 || !["In", "Out", "Adjustment"].includes(type)) {
    return res.status(400).json({ error: "qty (positive number) and a valid type are required." });
  }
  const delta = type === "Out" ? -amount : amount;
  const newQty = Math.max(0, existing.stock_qty + delta);
  const tx = db.transaction(() => {
    db.prepare("UPDATE products SET stock_qty = ? WHERE id = ?").run(newQty, existing.id);
    db.prepare(
      "INSERT INTO stock_transactions (id, shop_id, product_id, type, qty, note) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(uuid(), req.user.shopId, existing.id, type, amount, note || null);
  });
  tx();
  res.json(db.prepare("SELECT * FROM products WHERE id = ?").get(existing.id));
});

router.delete("/:id", (req, res) => {
  const existing = getOwnedProduct(req);
  if (!existing) return res.status(404).json({ error: "Product not found." });
  db.prepare("UPDATE products SET active = 0 WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
