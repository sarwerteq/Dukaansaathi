const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db");
const { requireAuth } = require("../auth");

const router = express.Router();
router.use(requireAuth);

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

// POST /api/invoices
// body: { customerId?, items: [{ productId, qty, unitPrice? }], discount?,
//          paymentMode: "Cash"|"UPI"|"Udhaar"|"Partial", paidAmount? }
// Stock is deducted and the customer's udhaar ledger is updated inside the
// same transaction, so a bill is never half-applied.
router.post("/", (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.items) || !b.items.length) {
    return res.status(400).json({ error: "At least one item is required." });
  }
  if (!["Cash", "UPI", "Udhaar", "Partial"].includes(b.paymentMode)) {
    return res.status(400).json({ error: "paymentMode must be Cash, UPI, Udhaar or Partial." });
  }
  if ((b.paymentMode === "Udhaar" || b.paymentMode === "Partial") && !b.customerId) {
    return res.status(400).json({ error: "A customer is required for Udhaar or Partial payment." });
  }

  let customer = null;
  if (b.customerId) {
    customer = db.prepare("SELECT * FROM customers WHERE id = ? AND shop_id = ?").get(b.customerId, req.user.shopId);
    if (!customer) return res.status(400).json({ error: "Customer not found." });
  }

  // Resolve each line item against the shop's own product catalog so
  // prices/stock can never be spoofed from the browser.
  const resolvedItems = [];
  for (const line of b.items) {
    const product = db
      .prepare("SELECT * FROM products WHERE id = ? AND shop_id = ?")
      .get(line.productId, req.user.shopId);
    if (!product) return res.status(400).json({ error: `Product not found: ${line.productId}` });
    const qty = parseFloat(line.qty);
    if (!qty || qty <= 0) return res.status(400).json({ error: `Invalid quantity for ${product.name}.` });
    if (product.stock_qty < qty) {
      return res.status(400).json({ error: `Not enough stock for ${product.name} (have ${product.stock_qty}).` });
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
    const invoiceNumber = nextInvoiceNumber(req.user.shopId);
    db.prepare(
      `INSERT INTO invoices
        (id, shop_id, invoice_number, customer_id, subtotal, discount, total, payment_mode, paid_amount, due_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(invoiceId, req.user.shopId, invoiceNumber, customer?.id || null, subtotal, discount, total, b.paymentMode, paidAmount, dueAmount);

    for (const item of resolvedItems) {
      db.prepare(
        `INSERT INTO invoice_items (id, invoice_id, product_id, name, qty, unit_price, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(uuid(), invoiceId, item.product.id, item.product.name, item.qty, item.unitPrice, item.lineTotal);

      db.prepare("UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?").run(item.qty, item.product.id);
      db.prepare(
        "INSERT INTO stock_transactions (id, shop_id, product_id, type, qty, note) VALUES (?, ?, ?, 'Sale', ?, ?)"
      ).run(uuid(), req.user.shopId, item.product.id, item.qty, `Sold on ${invoiceNumber}`);
    }

    if (dueAmount > 0 && customer) {
      db.prepare("UPDATE customers SET udhaar_balance = udhaar_balance + ? WHERE id = ?").run(dueAmount, customer.id);
      db.prepare(
        `INSERT INTO udhaar_transactions (id, shop_id, customer_id, invoice_id, type, amount, note)
         VALUES (?, ?, ?, ?, 'Credit', ?, ?)`
      ).run(uuid(), req.user.shopId, customer.id, invoiceId, dueAmount, `Udhaar from ${invoiceNumber}`);
    }

    return invoiceId;
  });

  const invoiceId = tx();
  res.status(201).json(fullInvoice(invoiceId));
});

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = router;
