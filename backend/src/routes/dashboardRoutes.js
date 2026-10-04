const express = require("express");
const db = require("../db");
const { requireAuth } = require("../auth");

const router = express.Router();
router.use(requireAuth);

router.get("/weekly", (req, res) => {
  const rows = db
    .prepare(
      `SELECT date(created_at) AS day, COALESCE(SUM(total),0) AS total
       FROM invoices WHERE shop_id = ? AND created_at >= datetime('now','-6 days')
       GROUP BY date(created_at)`
    )
    .all(req.user.shopId);
  const byDay = {};
  rows.forEach((r) => (byDay[r.day] = r.total));
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ label: d.toLocaleDateString("en-IN", { weekday: "short" }), total: byDay[key] || 0 });
  }

  const paymentModes = db
    .prepare(
      `SELECT payment_mode, COALESCE(SUM(total),0) AS total FROM invoices
       WHERE shop_id = ? AND date(created_at) = date('now') GROUP BY payment_mode`
    )
    .all(req.user.shopId);

  res.json({ days, paymentModes });
});
router.get("/summary", (req, res) => {
  const shopId = req.user.shopId;

  const todaySales = db
    .prepare("SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS count FROM invoices WHERE shop_id = ? AND date(created_at) = date('now')")
    .get(shopId);

  const todayCollected = db
    .prepare("SELECT COALESCE(SUM(paid_amount),0) AS total FROM invoices WHERE shop_id = ? AND date(created_at) = date('now')")
    .get(shopId);

  const totalUdhaarOutstanding = db
    .prepare("SELECT COALESCE(SUM(udhaar_balance),0) AS total FROM customers WHERE shop_id = ?")
    .get(shopId);

  const lowStock = db
    .prepare("SELECT id, name, stock_qty, low_stock_alert FROM products WHERE shop_id = ? AND active = 1 AND stock_qty <= low_stock_alert ORDER BY stock_qty")
    .all(shopId);

  const topCustomersByUdhaar = db
    .prepare("SELECT id, name, phone, udhaar_balance FROM customers WHERE shop_id = ? AND udhaar_balance > 0 ORDER BY udhaar_balance DESC LIMIT 10")
    .all(shopId);

  res.json({
    todaySalesTotal: todaySales.total,
    todayInvoiceCount: todaySales.count,
    todayCollected: todayCollected.total,
    totalUdhaarOutstanding: totalUdhaarOutstanding.total,
    lowStock,
    topCustomersByUdhaar,
  });
});

module.exports = router;
