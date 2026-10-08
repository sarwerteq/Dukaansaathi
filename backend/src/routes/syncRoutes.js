const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db");
const { requireAuth } = require("../auth");

const router = express.Router();
router.use(requireAuth);

// Generic duplicate-prevention log shared by every offline-capable
// operation that is NOT an invoice (invoices have their own
// client_transaction_id column on the invoices table already, from
// Feature #1, and keep using POST /api/invoices/sync unchanged).
// Any client_transaction_id seen before for this shop is treated as
// already processed - this is what makes retried syncs, double taps on
// "Sync Now", and app-restart-mid-sync all safe.
function alreadyProcessed(shopId, clientTransactionId) {
  return !!db
    .prepare("SELECT id FROM sync_log WHERE shop_id = ? AND client_transaction_id = ?")
    .get(shopId, clientTransactionId);
}
function markProcessed(shopId, clientTransactionId, entityType) {
  db.prepare("INSERT INTO sync_log (id, shop_id, client_transaction_id, entity_type) VALUES (?, ?, ?, ?)").run(
    uuid(),
    shopId,
    clientTransactionId,
    entityType
  );
}

// Applies one udhaar payment. Mirrors POST /customers/:id/udhaar-payment
// in customerRoutes.js exactly, but callable from the sync batch too.
function applyUdhaarPayment(shopId, payload) {
  const customer = db.prepare("SELECT * FROM customers WHERE id = ? AND shop_id = ?").get(payload.customerId, shopId);
  if (!customer) return { ok: false, error: "Customer not found." };
  const amount = parseFloat(payload.amount);
  if (!amount || amount <= 0) return { ok: false, error: "A positive amount is required." };

  const tx = db.transaction(() => {
    const newBalance = customer.udhaar_balance - amount;
    db.prepare("UPDATE customers SET udhaar_balance = ? WHERE id = ?").run(newBalance, customer.id);
    db.prepare(
      "INSERT INTO udhaar_transactions (id, shop_id, customer_id, type, amount, note) VALUES (?, ?, ?, 'Payment', ?, ?)"
    ).run(uuid(), shopId, customer.id, amount, payload.note || "Udhaar payment (synced from offline)");
  });
  tx();
  return { ok: true };
}

// Applies one stock adjustment. Unlike the always-succeeds online version
// in productRoutes.js (which clamps at 0), the offline-sync path treats a
// would-go-negative "Out" adjustment as a CONFLICT instead of silently
// clamping - per the spec, offline stock changes must never silently
// overwrite/corrupt the server's current stock number.
function applyStockAdjustment(shopId, payload) {
  const product = db.prepare("SELECT * FROM products WHERE id = ? AND shop_id = ?").get(payload.productId, shopId);
  if (!product) return { ok: false, error: "Product not found." };
  const amount = parseFloat(payload.qty);
  if (!amount || amount <= 0 || !["In", "Out", "Adjustment"].includes(payload.type)) {
    return { ok: false, error: "Invalid stock adjustment." };
  }
  if (payload.type === "Out" && product.stock_qty < amount) {
    return {
      ok: false,
      conflict: true,
      error: `Stock has changed since this was recorded offline (have ${product.stock_qty}, tried to remove ${amount}).`,
    };
  }
  const delta = payload.type === "Out" ? -amount : amount;
  const tx = db.transaction(() => {
    db.prepare("UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?").run(delta, product.id);
    db.prepare(
      "INSERT INTO stock_transactions (id, shop_id, product_id, type, qty, note) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(uuid(), shopId, product.id, payload.type, amount, (payload.note || "") + " (synced from offline)");
  });
  tx();
  return { ok: true };
}

// POST /api/sync/push
// body: { operations: [ { clientTransactionId, entityType, payload }, ... ] }
// entityType is "udhaar_payment" or "stock_adjustment" (invoices keep
// using POST /api/invoices/sync, unchanged from Feature #1).
router.post("/push", (req, res) => {
  const operations = Array.isArray(req.body?.operations) ? req.body.operations : [];
  if (!operations.length) return res.status(400).json({ error: "operations must be a non-empty array." });

  const shopId = req.user.shopId;
  const results = operations.map((op) => {
    if (!op.clientTransactionId || !op.entityType) {
      return { clientTransactionId: op.clientTransactionId || null, status: "error", error: "Missing clientTransactionId or entityType." };
    }
    if (alreadyProcessed(shopId, op.clientTransactionId)) {
      return { clientTransactionId: op.clientTransactionId, status: "synced", duplicate: true };
    }
    try {
      let result;
      if (op.entityType === "udhaar_payment") {
        result = applyUdhaarPayment(shopId, op.payload || {});
      } else if (op.entityType === "stock_adjustment") {
        result = applyStockAdjustment(shopId, op.payload || {});
      } else {
        return { clientTransactionId: op.clientTransactionId, status: "error", error: `Unknown entityType: ${op.entityType}` };
      }
      if (result.ok) {
        markProcessed(shopId, op.clientTransactionId, op.entityType);
        return { clientTransactionId: op.clientTransactionId, status: "synced" };
      }
      if (result.conflict) {
        return { clientTransactionId: op.clientTransactionId, status: "conflict", error: result.error };
      }
      return { clientTransactionId: op.clientTransactionId, status: "error", error: result.error };
    } catch (err) {
      return { clientTransactionId: op.clientTransactionId, status: "error", error: err.message };
    }
  });

  res.json({ results });
});

// GET /api/sync/status - a lightweight snapshot of this shop's server
// state. NOT a true incremental-pull endpoint (that is explicitly
// deferred - see the chat summary) - just enough for the UI to show
// "last known server activity" and confirm the connection actually
// reaches an authenticated, correctly-scoped backend.
router.get("/status", (req, res) => {
  const shopId = req.user.shopId;
  const invoiceStats = db
    .prepare("SELECT COUNT(*) AS count, MAX(created_at) AS lastAt FROM invoices WHERE shop_id = ?")
    .get(shopId);
  const productCount = db.prepare("SELECT COUNT(*) AS c FROM products WHERE shop_id = ? AND active = 1").get(shopId).c;
  const customerCount = db.prepare("SELECT COUNT(*) AS c FROM customers WHERE shop_id = ?").get(shopId).c;
  res.json({
    serverTime: new Date().toISOString(),
    totalInvoices: invoiceStats.count,
    lastInvoiceAt: invoiceStats.lastAt,
    totalProducts: productCount,
    totalCustomers: customerCount,
  });
});

module.exports = router;
