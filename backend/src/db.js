const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const dbFile = process.env.DATABASE_FILE || "./data/dukaansaathi.db";
const dir = path.dirname(dbFile);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(dbFile);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ---------------------------------------------------------------------------
// Multi-tenant schema: every business table carries shop_id, and every
// route scopes its queries by the logged-in user's shop_id (see auth.js).
// One shop's data is never visible to another shop.
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS shops (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  upi_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner', -- owner | staff
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT,
  unit TEXT NOT NULL DEFAULT 'pcs',
  price REAL NOT NULL DEFAULT 0,
  stock_qty REAL NOT NULL DEFAULT 0,
  low_stock_alert REAL NOT NULL DEFAULT 5,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  udhaar_balance REAL NOT NULL DEFAULT 0, -- positive = customer owes the shop
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  invoice_number TEXT NOT NULL,
  customer_id TEXT REFERENCES customers(id), -- null = walk-in / cash customer
  subtotal REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  payment_mode TEXT NOT NULL DEFAULT 'Cash', -- Cash | UPI | Udhaar | Partial
  paid_amount REAL NOT NULL DEFAULT 0,
  due_amount REAL NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id),
  name TEXT NOT NULL,
  qty REAL NOT NULL,
  unit_price REAL NOT NULL,
  line_total REAL NOT NULL
);

-- Running ledger of udhaar given and paid back, per customer.
CREATE TABLE IF NOT EXISTS udhaar_transactions (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  invoice_id TEXT REFERENCES invoices(id),
  type TEXT NOT NULL, -- 'Credit' (udhaar given) | 'Payment' (udhaar repaid)
  amount REAL NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Stock history: every manual adjustment or sale-driven deduction.
CREATE TABLE IF NOT EXISTS stock_transactions (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- 'In' | 'Out' | 'Adjustment' | 'Sale'
  qty REAL NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// Migration: add upi_id to shops created before this column existed.
// Safe to run every time the server starts - fails quietly if it already exists.
try {
  db.exec("ALTER TABLE shops ADD COLUMN upi_id TEXT");
} catch {
  /* column already exists */
}
try {
  db.exec("ALTER TABLE shops ADD COLUMN qr_image_path TEXT");
} catch {
  /* column already exists */
}
try {
  db.exec("ALTER TABLE products ADD COLUMN variant TEXT");
} catch {
  /* column already exists */
}
try {
  db.exec("ALTER TABLE users ADD COLUMN email TEXT");
} catch {
  /* column already exists */
}
try {
  db.exec("ALTER TABLE shops ADD COLUMN logo_path TEXT");
} catch {
  /* column already exists */
}
try {
  db.exec(`CREATE TABLE IF NOT EXISTS otps (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
} catch {
  /* table already exists */
}

module.exports = db;
