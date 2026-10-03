# DukaanSaathi — Billing, Stock & Udhaar for Your Shop

Full-stack source code: a multi-shop billing, inventory and customer-credit
(udhaar) tracker, inspired by the look and purpose of
https://dukansathi90.lovable.app (I could only see that site's title/
description, not its actual screens, so the design here is my own — not a
pixel-for-pixel copy).

```
dukaansaathi/
  backend/     Node.js + Express API, SQLite database, multi-shop auth
  frontend/    Plain HTML/CSS/JS app (no build step)
  docker-compose.yml
```

## What this is — honestly

A working full-stack app, not a mockup: real signup/login per shop, a real
database, and stock/money numbers that are always recalculated on the
server (never trusted from the browser). It was **not tested against a
running server** in the environment this was built in (no internet
access there) — only syntax-checked. Treat this as a first build to test
end-to-end yourself, the same as the Jashn Bottle project.

## 1. Core features

- **Multi-shop**: every signup creates its own shop; all data (products,
  customers, bills) is scoped to that shop and invisible to others.
- **Billing**: pick products, auto-calculates subtotal/discount/total,
  supports Cash / UPI / Udhaar / Partial payment.
- **Stock**: add products, track quantity, Stock In/Out adjustments, low-
  stock warnings on the dashboard.
- **Udhaar (customer credit)**: every Udhaar or Partial bill adds to a
  customer's running balance; "Record Payment" reduces it; full ledger
  per customer.
- **Dashboard**: today's sales, today's collections, total udhaar
  outstanding, low-stock list, top customers by udhaar due.
- **Reports**: today's bill list.

## 2. Local setup

```bash
cd backend
cp .env.example .env
npm install
npm run seed      # creates a demo shop + login + sample products/customers
npm start
```

Open **http://localhost:4000**. The seed script prints the demo login
(phone + password) in the terminal.

## 3. Project structure

```
backend/src/
  db.js            SQLite schema — every table has shop_id for isolation
  auth.js          JWT signing + requireAuth middleware (reads shopId)
  seed.js          Demo shop, products, customers
  server.js        Express app, mounts routes, serves the frontend
  routes/
    authRoutes.js       signup, login, logout, me
    productRoutes.js    stock CRUD + adjust-stock (In/Out/Adjustment)
    customerRoutes.js   customers + udhaar ledger + record payment
    invoiceRoutes.js    create bill (deducts stock, updates udhaar)
    dashboardRoutes.js  summary numbers for the dashboard
frontend/
  index.html
  assets/
    api.js         fetch() wrapper
    app.js         Login/Signup, Dashboard, Billing, Stock, Customers, Reports
```

## 4. Database

SQLite, single file (`backend/data/dukaansaathi.db`) — zero external
services needed. Tables: `shops`, `users`, `products`, `customers`,
`invoices`, `invoice_items`, `udhaar_transactions`, `stock_transactions`.

## 5. Deploying

Same approach as the Jashn Bottle project:

**Docker:**
```bash
docker compose up -d --build
```

**Render / any Node host:** set env vars from `.env.example`, root
directory `backend`, build `npm install`, start
`npm run seed && npm start` (the `&&` re-seeds on every restart, which
matters on free tiers with no persistent disk — remove it once you're on
a plan with a disk, so you don't reset data on every deploy).

## 6. Known gaps / next steps

- No password reset / forgotten-password flow.
- No OTP-based phone verification — anyone who knows the phone+password
  combination can log in, same as any basic username/password app.
- No PDF invoice generation — "Print / Save as PDF" uses the browser's
  print dialog.
- No staff accounts yet (schema has a `role` column ready for it, but
  signup only ever creates an `owner`).
- The actual visual design of the site this was modeled after was not
  visible to me (it's a client-rendered app my tools can't see into), so
  the UI here is a new, simpler design — not a copy of the original.
- No image/logo upload for the shop yet.
