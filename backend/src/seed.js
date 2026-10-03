// Run with: npm run seed
// Creates one demo shop + owner login + some demo products and customers,
// so the app can be tested immediately. Safe to run more than once - it
// skips creating the demo shop if that phone number is already registered.
require("dotenv").config();
const { v4: uuid } = require("uuid");
const bcrypt = require("bcryptjs");
const db = require("./db");

function seed() {
  const phone = process.env.DEMO_PHONE || "9999999999";
  const existing = db.prepare("SELECT id FROM users WHERE phone = ?").get(phone);
  if (existing) {
    console.log(`Demo shop already exists. Log in with phone ${phone}.`);
    return;
  }

  const shopName = process.env.DEMO_SHOP_NAME || "Sharma General Store";
  const ownerName = process.env.DEMO_OWNER_NAME || "Rakesh Sharma";
  const password = process.env.DEMO_PASSWORD || "demo1234";

  const shopId = uuid();
  db.prepare("INSERT INTO shops (id, name, address) VALUES (?, ?, ?)").run(shopId, shopName, "Main Market, Bhagalpur");

  const userId = uuid();
  db.prepare(
    "INSERT INTO users (id, shop_id, name, phone, password_hash, role) VALUES (?, ?, ?, ?, ?, 'owner')"
  ).run(userId, shopId, ownerName, phone, bcrypt.hashSync(password, 10));

  const products = [
    ["Tata Salt 1kg", "Grocery", "pcs", 25, 40],
    ["Amul Milk 500ml", "Dairy", "pcs", 28, 30],
    ["Parle-G Biscuit", "Snacks", "pcs", 10, 100],
    ["Rice (Basmati)", "Grocery", "kg", 85, 50],
    ["Sunflower Oil 1L", "Grocery", "pcs", 140, 20],
    ["Surf Excel 1kg", "Household", "pcs", 110, 15],
    ["Colgate Toothpaste", "Personal Care", "pcs", 55, 25],
    ["Maggi Noodles", "Snacks", "pcs", 14, 80],
  ];
  for (const [name, category, unit, price, stock] of products) {
    const id = uuid();
    db.prepare(
      "INSERT INTO products (id, shop_id, name, category, unit, price, stock_qty, low_stock_alert) VALUES (?, ?, ?, ?, ?, ?, ?, 10)"
    ).run(id, shopId, name, category, unit, price, stock);
  }

  const customers = [
    ["Suresh Kumar", "9811122233", 0],
    ["Priya Devi", "9822233344", 0],
    ["Manoj Traders", "9833344455", 0],
  ];
  for (const [name, phoneNum] of customers) {
    db.prepare("INSERT INTO customers (id, shop_id, name, phone) VALUES (?, ?, ?, ?)").run(uuid(), shopId, name, phoneNum);
  }

  console.log("Seed complete.");
  console.log(`Demo login -> phone: ${phone}  password: ${password}`);
}

seed();
