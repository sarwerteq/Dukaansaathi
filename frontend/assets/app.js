const $ = (s) => document.querySelector(s);

const S = {
  user: null,
  shop: null,
  products: [],
  customers: [],
  billItems: [],
};

function isLoggedIn() {
  return !!S.user;
}

function goTo(hash) {
  if (location.hash === "#" + hash) {
    render();
  } else {
    location.hash = hash;
  }
}

async function tryRestoreSession() {
  try {
    const { user, shop } = await api.get("/auth/me");
    S.user = user;
    S.shop = shop;
    return true;
  } catch {
    return false;
  }
}

function headerNav() {
  if (!isLoggedIn()) return "";
  return `
    <nav>
      <a href="#dashboard">Dashboard</a>
      <a href="#billing">New Bill</a>
      <a href="#stock">Stock</a>
      <a href="#customers">Udhaar</a>
      <a href="#reports">Reports</a>
      <a href="#" onclick="logout();return false;">Logout</a>
    </nav>`;
}

function renderShell(bodyHtml) {
  $("#header").innerHTML = `<b>${isLoggedIn() ? escHtml(S.shop.name) : "DukaanSaathi"}</b>${headerNav()}`;
  $("#app").innerHTML = bodyHtml;
}

function pageLogin() {
  return `
    <div class="card">
      <h2>DukaanSaathi</h2>
      <p class="muted">Billing, Stock &amp; Udhaar for your shop</p>
      <label>Phone Number</label><input id="l_phone" type="tel" maxlength="10">
      <label>Password</label><input id="l_pass" type="password">
      <p id="l_err" class="err"></p>
      <button class="btn" onclick="doLogin()">Log In</button>
      <p class="muted">New shop? <a href="#signup">Create an account</a></p>
    </div>`;
}

async function doLogin() {
  $("#l_err").textContent = "";
  try {
    const { user, shop } = await api.post("/auth/login", { phone: $("#l_phone").value.trim(), password: $("#l_pass").value });
    S.user = user;
    S.shop = shop;
    await bootData();
    goTo("dashboard");
  } catch (err) {
    $("#l_err").textContent = err.message;
    renderShell(pageLogin());
  }
}

function pageSignup() {
  return `
    <div class="card">
      <h2>Create Your Shop</h2>
      <label>Shop Name</label><input id="s_shop">
      <label>Owner Name</label><input id="s_owner">
      <label>Phone Number</label><input id="s_phone" type="tel" maxlength="10">
      <label>Password</label><input id="s_pass" type="password">
      <label>Shop Address (optional)</label><input id="s_addr">
      <p id="s_err" class="err"></p>
      <button class="btn" onclick="doSignup()">Create Account</button>
      <p class="muted">Already have an account? <a href="#login">Log in</a></p>
    </div>`;
}

async function doSignup() {
  $("#s_err").textContent = "";
  try {
    const { user, shop } = await api.post("/auth/signup", {
      shopName: $("#s_shop").value.trim(),
      ownerName: $("#s_owner").value.trim(),
      phone: $("#s_phone").value.trim(),
      password: $("#s_pass").value,
      address: $("#s_addr").value.trim() || null,
    });
    S.user = user;
    S.shop = shop;
    await bootData();
    goTo("dashboard");
  } catch (err) {
    $("#s_err").textContent = err.message;
    renderShell(pageSignup());
  }
}

async function logout() {
  await api.post("/auth/logout");
  S.user = null;
  S.shop = null;
  goTo("login");
}

async function pageDashboard() {
  const summary = await api.get("/dashboard/summary");
  return `
    <h2>Today</h2>
    <div class="stat"><span>Sales Today</span><b>${money(summary.todaySalesTotal)}</b></div>
    <div class="stat"><span>Bills Today</span><b>${summary.todayInvoiceCount}</b></div>
    <div class="stat"><span>Collected Today</span><b>${money(summary.todayCollected)}</b></div>
    <div class="stat"><span>Total Udhaar Outstanding</span><b>${money(summary.totalUdhaarOutstanding)}</b></div>

    <a class="btn" href="#billing">+ New Bill</a>

    ${summary.lowStock.length ? `
      <h3>Low Stock</h3>
      <div class="card">${summary.lowStock.map((p) => `<div>${escHtml(p.name)} — <span class="pill low">${p.stock_qty} left</span></div>`).join("")}</div>
    ` : ""}

    ${summary.topCustomersByUdhaar.length ? `
      <h3>Customers With Udhaar Due</h3>
      <div class="card">${summary.topCustomersByUdhaar.map((c) => `<div>${escHtml(c.name)} — <span class="pill due">${money(c.udhaar_balance)}</span></div>`).join("")}</div>
    ` : ""}
  `;
}

function pageBilling() {
  return `
    <h2>New Bill</h2>
    <div class="card">
      <label>Customer (optional for cash sale)</label>
      <select id="b_customer"><option value="">Walk-in / Cash customer</option>
        ${S.customers.map((c) => `<option value="${c.id}">${escHtml(c.name)}${c.phone ? " - " + c.phone : ""}</option>`).join("")}
      </select>
    </div>

    <div class="card">
      <h3>Items</h3>
      <div id="bill_items">${renderBillItems()}</div>
      <label>Add product</label>
      <select id="b_add_product" onchange="addBillItem(this.value); this.value=''">
        <option value="">Select a product...</option>
        ${S.products.map((p) => `<option value="${p.id}">${escHtml(p.name)} (${money(p.price)}/${escHtml(p.unit)}, stock ${p.stock_qty})</option>`).join("")}
      </select>
    </div>

    <div class="card">
      <label>Discount (₹)</label><input id="b_discount" type="number" min="0" value="0" oninput="renderBillTotals()">
      <div id="bill_totals"></div>
    </div>

    <div class="card">
      <label>Payment Mode</label>
      <select id="b_mode" onchange="renderBillTotals()">
        <option>Cash</option><option>UPI</option><option>Udhaar</option><option>Partial</option>
      </select>
      <div id="b_partial_wrap" style="display:none">
        <label>Amount Paid Now (₹)</label><input id="b_paid" type="number" min="0" value="0">
      </div>
    </div>

    <p id="b_err" class="err"></p>
    <button class="btn" onclick="submitBill()">Save Bill</button>
  `;
}

function renderBillItems() {
  if (!S.billItems.length) return `<p class="muted">No items added yet.</p>`;
  return S.billItems
    .map(
      (it, i) => `
      <div class="item-row">
        <div>${escHtml(it.name)}</div>
        <input type="number" min="0.01" step="0.01" value="${it.qty}" onchange="updateBillQty(${i}, this.value)">
        <div>${money(it.price * it.qty)}</div>
        <button class="btn sm bad" onclick="removeBillItem(${i})">✕</button>
      </div>`
    )
    .join("");
}

function addBillItem(productId) {
  if (!productId) return;
  const product = S.products.find((p) => p.id === productId);
  if (!product) return;
  const existing = S.billItems.find((i) => i.productId === productId);
  if (existing) existing.qty += 1;
  else S.billItems.push({ productId, name: product.name, price: product.price, qty: 1 });
  rerenderBilling();
}
function updateBillQty(index, value) {
  const qty = parseFloat(value);
  S.billItems[index].qty = qty > 0 ? qty : 1;
  rerenderBilling();
}
function removeBillItem(index) {
  S.billItems.splice(index, 1);
  rerenderBilling();
}
function rerenderBilling() {
  $("#bill_items").innerHTML = renderBillItems();
  renderBillTotals();
}

function billSubtotal() {
  return S.billItems.reduce((s, i) => s + i.price * i.qty, 0);
}
function renderBillTotals() {
  const mode = $("#b_mode")?.value || "Cash";
  $("#b_partial_wrap").style.display = mode === "Partial" ? "block" : "none";
  const subtotal = billSubtotal();
  const discount = parseFloat($("#b_discount")?.value) || 0;
  const total = Math.max(0, subtotal - discount);
  $("#bill_totals").innerHTML = `
    <table>
      <tr><td>Subtotal</td><td>${money(subtotal)}</td></tr>
      <tr><td>Discount</td><td>-${money(discount)}</td></tr>
      <tr class="tot"><td>Total</td><td>${money(total)}</td></tr>
    </table>`;
}

async function submitBill() {
  $("#b_err").textContent = "";
  if (!S.billItems.length) {
    $("#b_err").textContent = "Add at least one item.";
    return;
  }
  const mode = $("#b_mode").value;
  const customerId = $("#b_customer").value || null;
  if ((mode === "Udhaar" || mode === "Partial") && !customerId) {
    $("#b_err").textContent = "Select a customer for Udhaar or Partial payment.";
    return;
  }
  try {
    const result = await api.post("/invoices", {
      customerId,
      items: S.billItems.map((i) => ({ productId: i.productId, qty: i.qty, unitPrice: i.price })),
      discount: parseFloat($("#b_discount").value) || 0,
      paymentMode: mode,
      paidAmount: mode === "Partial" ? parseFloat($("#b_paid").value) || 0 : undefined,
    });
    S.billItems = [];
    await bootData();
    showInvoiceResult(result);
  } catch (err) {
    $("#b_err").textContent = err.message;
  }
}

function showInvoiceResult(data) {
  const { invoice, items, customer } = data;
  $("#app").innerHTML = `
    <h2>Bill Saved</h2>
    <div class="card">
      <h3>${escHtml(S.shop.name)}</h3>
      <p>Invoice ${invoice.invoice_number} · ${new Date(invoice.created_at).toLocaleString()}</p>
      ${customer ? `<p>Customer: ${escHtml(customer.name)}${customer.phone ? " - " + escHtml(customer.phone) : ""}</p>` : ""}
      <table>
        ${items.map((i) => `<tr><td>${escHtml(i.name)} x ${i.qty}</td><td>${money(i.line_total)}</td></tr>`).join("")}
        <tr><td>Subtotal</td><td>${money(invoice.subtotal)}</td></tr>
        <tr><td>Discount</td><td>-${money(invoice.discount)}</td></tr>
        <tr class="tot"><td>Total</td><td>${money(invoice.total)}</td></tr>
        <tr><td>Paid</td><td>${money(invoice.paid_amount)}</td></tr>
        <tr><td>Due (Udhaar)</td><td>${money(invoice.due_amount)}</td></tr>
      </table>
    </div>
    <button class="btn o" onclick="window.print()">Print / Save as PDF</button>
    <a class="btn" href="#" onclick="goTo('billing');return false;">New Bill</a>
  `;
}

function pageStock() {
  return `
    <h2>Stock</h2>
    <a class="btn" href="#" onclick="showAddProduct();return false;">+ Add Product</a>
    <div id="stock_list">${renderStockList()}</div>
  `;
}
function renderStockList() {
  if (!S.products.length) return `<p class="muted">No products yet.</p>`;
  return S.products
    .map(
      (p) => `
      <div class="card">
        <b>${escHtml(p.name)}</b> ${p.category ? `<span class="muted">(${escHtml(p.category)})</span>` : ""}<br>
        ${money(p.price)} / ${escHtml(p.unit)} · Stock: <span class="pill ${p.stock_qty <= p.low_stock_alert ? "low" : ""}">${p.stock_qty}</span>
        <div class="row">
          <button class="btn sm" onclick="adjustStock('${p.id}','In')">+ Stock In</button>
          <button class="btn sm o" onclick="adjustStock('${p.id}','Out')">- Stock Out</button>
        </div>
      </div>`
    )
    .join("");
}

function showAddProduct() {
  $("#app").innerHTML = `
    <h2>Add Product</h2>
    <div class="card">
      <label>Name</label><input id="p_name">
      <label>Category</label><input id="p_cat">
      <div class="row">
        <div><label>Unit</label><input id="p_unit" value="pcs"></div>
        <div><label>Price (₹)</label><input id="p_price" type="number" min="0"></div>
      </div>
      <div class="row">
        <div><label>Opening Stock</label><input id="p_stock" type="number" min="0" value="0"></div>
        <div><label>Low Stock Alert</label><input id="p_low" type="number" min="0" value="5"></div>
      </div>
      <p id="p_err" class="err"></p>
      <button class="btn" onclick="saveProduct()">Save Product</button>
    </div>`;
}

async function saveProduct() {
  $("#p_err").textContent = "";
  const name = $("#p_name").value.trim();
  if (!name) {
    $("#p_err").textContent = "Product name is required.";
    return;
  }
  try {
    await api.post("/products", {
      name,
      category: $("#p_cat").value.trim() || null,
      unit: $("#p_unit").value.trim() || "pcs",
      price: parseFloat($("#p_price").value) || 0,
      stockQty: parseFloat($("#p_stock").value) || 0,
      lowStockAlert: parseFloat($("#p_low").value) || 5,
    });
    await bootData();
    goTo("stock");
  } catch (err) {
    $("#p_err").textContent = err.message;
  }
}

async function adjustStock(productId, type) {
  const qty = prompt(type === "In" ? "How many units are you adding?" : "How many units are you removing?");
  const amount = parseFloat(qty);
  if (!amount || amount <= 0) return;
  try {
    await api.post(`/products/${productId}/adjust-stock`, { qty: amount, type, note: type === "In" ? "Restock" : "Manual removal" });
    await bootData();
    render();
  } catch (err) {
    alert(err.message);
  }
}

function pageCustomers() {
  return `
    <h2>Customers &amp; Udhaar</h2>
    <a class="btn" href="#" onclick="showAddCustomer();return false;">+ Add Customer</a>
    <div>${S.customers
      .map(
        (c) => `
      <div class="card">
        <b>${escHtml(c.name)}</b> ${c.phone ? `<span class="muted">${escHtml(c.phone)}</span>` : ""}<br>
        Udhaar Due: <span class="pill ${c.udhaar_balance > 0 ? "due" : ""}">${money(c.udhaar_balance)}</span>
        <div class="row">
          <button class="btn sm" onclick="viewCustomer('${c.id}')">View Ledger</button>
          ${c.udhaar_balance > 0 ? `<button class="btn sm acc" onclick="recordPayment('${c.id}')">Record Payment</button>` : ""}
        </div>
      </div>`
      )
      .join("")}</div>
  `;
}

function showAddCustomer() {
  $("#app").innerHTML = `
    <h2>Add Customer</h2>
    <div class="card">
      <label>Name</label><input id="c_name">
      <label>Phone</label><input id="c_phone" type="tel">
      <label>Address</label><input id="c_addr">
      <p id="c_err" class="err"></p>
      <button class="btn" onclick="saveCustomer()">Save Customer</button>
    </div>`;
}

async function saveCustomer() {
  $("#c_err").textContent = "";
  const name = $("#c_name").value.trim();
  if (!name) {
    $("#c_err").textContent = "Customer name is required.";
    return;
  }
  try {
    await api.post("/customers", { name, phone: $("#c_phone").value.trim() || null, address: $("#c_addr").value.trim() || null });
    await bootData();
    goTo("customers");
  } catch (err) {
    $("#c_err").textContent = err.message;
  }
}

async function viewCustomer(id) {
  const data = await api.get(`/customers/${id}`);
  const { customer, ledger, invoices } = data;
  $("#app").innerHTML = `
    <h2>${escHtml(customer.name)}</h2>
    <div class="card">
      ${customer.phone ? `<p>${escHtml(customer.phone)}</p>` : ""}
      <p>Udhaar Due: <b>${money(customer.udhaar_balance)}</b></p>
      ${customer.udhaar_balance > 0 ? `<button class="btn acc" onclick="recordPayment('${customer.id}')">Record Payment</button>` : ""}
    </div>
    <h3>Ledger</h3>
    <div class="card">
      <table>
        ${ledger
          .map((l) => `<tr><td>${new Date(l.created_at).toLocaleDateString()} - ${escHtml(l.type)}${l.note ? " (" + escHtml(l.note) + ")" : ""}</td><td>${l.type === "Credit" ? "+" : "-"}${money(l.amount)}</td></tr>`)
          .join("") || `<tr><td colspan="2" class="muted">No transactions yet.</td></tr>`}
      </table>
    </div>
    <h3>Bills</h3>
    <div class="card">
      ${invoices.map((i) => `<div>${i.invoice_number} - ${money(i.total)} (${i.payment_mode})</div>`).join("") || `<p class="muted">No bills yet.</p>`}
    </div>
    <a class="btn o" href="#" onclick="goTo('customers');return false;">Back</a>
  `;
}

async function recordPayment(customerId) {
  const amount = prompt("How much is the customer paying back now (₹)?");
  const val = parseFloat(amount);
  if (!val || val <= 0) return;
  try {
    await api.post(`/customers/${customerId}/udhaar-payment`, { amount: val, note: "Udhaar payment" });
    await bootData();
    viewCustomer(customerId);
  } catch (err) {
    alert(err.message);
  }
}

async function pageReports() {
  const todayInvoices = await api.get("/invoices?date=today");
  const totalToday = todayInvoices.reduce((s, d) => s + d.invoice.total, 0);
  return `
    <h2>Today's Bills</h2>
    <div class="stat"><span>Total</span><b>${money(totalToday)}</b></div>
    <div class="card">
      <table>
        <tr><th>Invoice</th><th>Customer</th><th>Total</th></tr>
        ${todayInvoices
          .map((d) => `<tr><td>${d.invoice.invoice_number}</td><td>${escHtml(d.customer?.name || "Walk-in")}</td><td>${money(d.invoice.total)}</td></tr>`)
          .join("") || `<tr><td colspan="3" class="muted">No bills today yet.</td></tr>`}
      </table>
    </div>
  `;
}

async function bootData() {
  const [products, customers] = await Promise.all([api.get("/products"), api.get("/customers")]);
  S.products = products;
  S.customers = customers;
}

async function render() {
  const hash = (location.hash || "#login").slice(1);

  if (!isLoggedIn() && !(await tryRestoreSession())) {
    if (hash === "signup") {
      renderShell(pageSignup());
    } else {
      renderShell(pageLogin());
    }
    return;
  }

  await bootData();

  if (hash === "billing") renderShell(pageBilling());
  else if (hash === "stock") renderShell(pageStock());
  else if (hash === "customers") renderShell(pageCustomers());
  else if (hash === "reports") renderShell(await pageReports());
  else renderShell(await pageDashboard());

  if (hash === "billing") renderBillTotals();
}

window.addEventListener("hashchange", () => {
  window.scrollTo(0, 0);
  render();
});
document.addEventListener("DOMContentLoaded", render);
