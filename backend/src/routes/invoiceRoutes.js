const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db");
const { requireAuth } = require("../auth");

const router = express.Router();
router.use(requireAuth);

const ORDER_SYNC_STATUSES = ["synced", "PENDING_SYNC", "SYNC_CONFLICT"]; // kept for reference

function nextInvoiceNumber(shopId) {
  const count = db.prepare("SELECT COUNT(*) AS c FROM invoices WHERE shop_id = ?").get(shopId).c + 1;
  const year = new Date().getFullYear();
  return `INV-${year}-${String(count).padStart(4, "0")}`;
}

function fullInvoice(id) {
  const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
  if (!invoice) return null;
  const items = db.prepare("SELECT * FROM invoice_items WHERE invoice_id = ?").all(id);
  const customer = invoice.customer_id
    ? db.prepare("SELECT * FROM customers WHERE id = ?").get(invoice.customer_id)
    : null;
  return { invoice, items, customer };
}

// GET /api/invoices?date=today  - list this shop's invoices, newest first.
router.get("/", (req, res) => {
  let rows;
  if (req.query.date === "today") {
    rows = db
      .prepare("SELECT * FROM invoices WHERE shop_id = ? AND date(created_at) = date('now') ORDER BY created_at DESC")
      .all(req.user.shopId);
  } else {
    rows = db
      .prepare("SELECT * FROM invoices WHERE shop_id = ? ORDER BY created_at DESC LIMIT 200")
      .all(req.user.shopId);
  }
  res.json(rows.map((r) => fullInvoice(r.id)));
});

router.get("/:id", (req, res) => {
  const data = fullInvoice(req.params.id);
  if (!data || data.invoice.shop_id !== req.user.shopId) {
    return res.status(404).json({ error: "Invoice not found." });
  }
  res.json(data);
});

// Shared creation logic used by both the normal (online) POST / and the
// offline POST /sync endpoint. Returns either:
//   { ok: true, data: <fullInvoice> }
//   { ok: false, status: 400|409, error: "...", conflict?: true }
// Idempotency: if clientTransactionId is given and an invoice already
// exists for this shop with that id, the existing invoice is returned
// instead of creating a second one - this is what lets sync be retried
// safely without producing duplicate bills.
function createInvoice(shopId, b) {
  if (b.clientTransactionId) {
    const existing = db
      .prepare("SELECT id FROM invoices WHERE shop_id = ? AND client_transaction_id = ?")
      .get(shopId, b.clientTransactionId);
    if (existing) {
      return { ok: true, data: fullInvoice(existing.id), alreadySynced: true };
    }
  }

  if (!Array.isArray(b.items) || !b.items.length) {
    return { ok: false, status: 400, error: "At least one item is required." };
  }
  if (!["Cash", "UPI", "Udhaar", "Partial"].includes(b.paymentMode)) {
    return { ok: false, status: 400, error: "paymentMode must be Cash, UPI, Udhaar or Partial." };
  }
  if ((b.paymentMode === "Udhaar" || b.paymentMode === "Partial") && !b.customerId) {
    return { ok: false, status: 400, error: "A customer is required for Udhaar or Partial payment." };
  }

  let customer = null;
  if (b.customerId) {
    customer = db.prepare("SELECT * FROM customers WHERE id = ? AND shop_id = ?").get(b.customerId, shopId);
    if (!customer) return { ok: false, status: 400, error: "Customer not found." };
  }

  const resolvedItems = [];
  for (const line of b.items) {
    const product = db.prepare("SELECT * FROM products WHERE id = ? AND shop_id = ?").get(line.productId, shopId);
    if (!product) return { ok: false, status: 400, error: `Product not found: ${line.productId}` };
    const qty = parseFloat(line.qty);
    if (!qty || qty <= 0) return { ok: false, status: 400, error: `Invalid quantity for ${product.name}.` };
    if (product.stock_qty < qty) {
      // This is the stock-conflict case called out in the offline spec:
      // the server is the source of truth, so if stock has moved since
      // the bill was created offline, we reject with a distinct status
      // (409 + conflict:true) instead of a generic 400, so the client
      // can tell "needs fixing" apart from "bad input".
      return {
        ok: false,
        status: 409,
        conflict: true,
        error: `Not enough stock for ${product.name} (have ${product.stock_qty}, need ${qty}).`,
      };
    }
    const unitPrice = line.unitPrice != null ? parseFloat(line.unitPrice) : product.price;
    resolvedItems.push({ product, qty, unitPrice, lineTotal: round2(qty * unitPrice) });
  }

  const subtotal = round2(resolvedItems.reduce((s, i) => s + i.lineTotal, 0));
  const discount = round2(parseFloat(b.discount) || 0);
  const total = round2(Math.max(0, subtotal - discount));

  let paidAmount, dueAmount;
  if (b.paymentMode === "Cash" || b.paymentMode === "UPI") {
    paidAmount = total;
    dueAmount = 0;
  } else if (b.paymentMode === "Udhaar") {
    paidAmount = 0;
    dueAmount = total;
  } else {
    paidAmount = round2(Math.min(total, parseFloat(b.paidAmount) || 0));
    dueAmount = round2(total - paidAmount);
  }

  const tx = db.transaction(() => {
    const invoiceId = uuid();
    const invoiceNumber = nextInvoiceNumber(shopId);
    const isOffline = !!b.clientTransactionId;
    db.prepare(
      `INSERT INTO invoices
        (id, shop_id, invoice_number, customer_id, subtotal, discount, total, payment_mode, paid_amount, due_amount,
         client_transaction_id, sync_status, created_offline_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?)`
    ).run(
      invoiceId,
      shopId,
      invoiceNumber,
      customer?.id || null,
      subtotal,
      discount,
      total,
      b.paymentMode,
      paidAmount,
      dueAmount,
      b.clientTransactionId || null,
      isOffline ? b.createdOfflineAt || new Date().toISOString() : null,
      new Date().toISOString()
    );

    for (const item of resolvedItems) {
      db.prepare(
        `INSERT INTO invoice_items (id, invoice_id, product_id, name, qty, unit_price, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(uuid(), invoiceId, item.product.id, item.product.name, item.qty, item.unitPrice, item.lineTotal);

      db.prepare("UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?").run(item.qty, item.product.id);
      db.prepare(
        "INSERT INTO stock_transactions (id, shop_id, product_id, type, qty, note) VALUES (?, ?, ?, 'Sale', ?, ?)"
      ).run(uuid(), shopId, item.product.id, item.qty, `Sold on ${invoiceNumber}`);
    }

    if (dueAmount > 0 && customer) {
      db.prepare("UPDATE customers SET udhaar_balance = udhaar_balance + ? WHERE id = ?").run(dueAmount, customer.id);
      db.prepare(
        `INSERT INTO udhaar_transactions (id, shop_id, customer_id, invoice_id, type, amount, note)
         VALUES (?, ?, ?, ?, 'Credit', ?, ?)`
      ).run(uuid(), shopId, customer.id, invoiceId, dueAmount, `Udhaar from ${invoiceNumber}`);
    }

    return invoiceId;
  });

  const invoiceId = tx();
  return { ok: true, data: fullInvoice(invoiceId) };
}

// POST /api/invoices  - normal online path, unchanged behaviour for
// existing callers (clientTransactionId is optional and simply ignored
// if not sent, so this is fully backward compatible).
router.post("/", (req, res) => {
  const result = createInvoice(req.user.shopId, req.body || {});
  if (!result.ok) return res.status(result.status).json({ error: result.error, conflict: !!result.conflict });
  res.status(201).json(result.data);
});

// POST /api/invoices/sync
// body: { bills: [ { clientTransactionId, items, customerId, discount,
//                     paymentMode, paidAmount, createdOfflineAt }, ... ] }
// Processes each offline bill independently so one bad/conflicting bill
// never blocks the others. Always scoped to req.user.shopId, so a shop
// can only ever sync its own bills.
router.post("/sync", (req, res) => {
  const bills = Array.isArray(req.body?.bills) ? req.body.bills : [];
  if (!bills.length) return res.status(400).json({ error: "bills must be a non-empty array." });

  const results = bills.map((bill) => {
    if (!bill.clientTransactionId) {
      return { clientTransactionId: bill.clientTransactionId || null, status: "error", error: "Missing clientTransactionId." };
    }
    try {
      const result = createInvoice(req.user.shopId, bill);
      if (result.ok) {
        return {
          clientTransactionId: bill.clientTransactionId,
          status: "synced",
          invoice: result.data.invoice,
          alreadySynced: !!result.alreadySynced,
        };
      }
      if (result.conflict) {
        // Record the conflict against nothing yet (no row was created) -
        // the client is responsible for keeping this bill locally with
        // SYNC_CONFLICT status until the shopkeeper resolves it.
        return { clientTransactionId: bill.clientTransactionId, status: "conflict", error: result.error };
      }
      return { clientTransactionId: bill.clientTransactionId, status: "error", error: result.error };
    } catch (err) {
      return { clientTransactionId: bill.clientTransactionId, status: "error", error: err.message };
    }
  });

  res.json({ results });
});

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = router;
