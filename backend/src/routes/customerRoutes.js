const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db");
const { requireAuth } = require("../auth");

const router = express.Router();
router.use(requireAuth);

router.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM customers WHERE shop_id = ? ORDER BY name").all(req.user.shopId);
  res.json(rows);
});

router.post("/", (req, res) => {
  const { name, phone, address } = req.body || {};
  if (!name) return res.status(400).json({ error: "Customer name is required." });
  const id = uuid();
  db.prepare("INSERT INTO customers (id, shop_id, name, phone, address) VALUES (?, ?, ?, ?, ?)").run(
    id,
    req.user.shopId,
    name,
    phone || null,
    address || null
  );
  res.status(201).json(db.prepare("SELECT * FROM customers WHERE id = ?").get(id));
});

function getOwnedCustomer(req) {
  return db.prepare("SELECT * FROM customers WHERE id = ? AND shop_id = ?").get(req.params.id, req.user.shopId);
}

router.get("/:id", (req, res) => {
  const customer = getOwnedCustomer(req);
  if (!customer) return res.status(404).json({ error: "Customer not found." });
  const ledger = db
    .prepare("SELECT * FROM udhaar_transactions WHERE customer_id = ? ORDER BY created_at DESC")
    .all(customer.id);
  const invoices = db
    .prepare("SELECT * FROM invoices WHERE customer_id = ? ORDER BY created_at DESC")
    .all(customer.id);
  res.json({ customer, ledger, invoices });
});

router.put("/:id", (req, res) => {
  const existing = getOwnedCustomer(req);
  if (!existing) return res.status(404).json({ error: "Customer not found." });
  const b = req.body || {};
  db.prepare("UPDATE customers SET name=?, phone=?, address=? WHERE id = ?").run(
    b.name ?? existing.name,
    b.phone ?? existing.phone,
    b.address ?? existing.address,
    req.params.id
  );
  res.json(db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id));
});

// POST /api/customers/:id/udhaar-payment  { amount, note }
// Records money the customer pays back against their outstanding udhaar.
router.post("/:id/udhaar-payment", (req, res) => {
  const existing = getOwnedCustomer(req);
  if (!existing) return res.status(404).json({ error: "Customer not found." });
  const amount = parseFloat(req.body?.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: "A positive amount is required." });

  const tx = db.transaction(() => {
    const newBalance = existing.udhaar_balance - amount;
    db.prepare("UPDATE customers SET udhaar_balance = ? WHERE id = ?").run(newBalance, existing.id);
    db.prepare(
      "INSERT INTO udhaar_transactions (id, shop_id, customer_id, type, amount, note) VALUES (?, ?, ?, 'Payment', ?, ?)"
    ).run(uuid(), req.user.shopId, existing.id, amount, req.body?.note || null);
    return newBalance;
  });
  const newBalance = tx();
  res.json({ ...db.prepare("SELECT * FROM customers WHERE id = ?").get(existing.id), udhaar_balance: newBalance });
});

module.exports = router;
