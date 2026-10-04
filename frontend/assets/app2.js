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

function pageSettings() {
  return `
    <h2>Shop Settings</h2>
    <div class="card">
      <label>Shop Name</label><input id="st_name" value="${escHtml(S.shop.name)}">
      <label>Address</label><input id="st_addr" value="${escHtml(S.shop.address || "")}">
      <label>UPI ID (for payment QR)</label><input id="st_upi" value="${escHtml(S.shop.upi_id || "")}" placeholder="yourname@upi">
      <p id="st_err" class="err"></p>
      <button class="btn" onclick="saveSettings()">Save Settings</button>
    </div>`;
}

async function saveSettings() {
  $("#st_err").textContent = "";
  try {
    const shop = await api.put("/shop", {
      name: $("#st_name").value.trim(),
      address: $("#st_addr").value.trim() || null,
      upiId: $("#st_upi").value.trim() || null,
    });
    S.shop = shop;
    goTo("dashboard");
  } catch (err) {
    $("#st_err").textContent = err.message;
  }
}

async function bootData() {
  const [products, customers] = await Promise.all([api.get("/products"), api.get("/customers")]);
  S.products = products;
  S.customers = customers;
}

async function render() {
  const hash = (location.hash || "#login").slice(1);

  if (!isLoggedIn() && !(await tryRestoreSession())) {
    if (hash === "signup") renderShell(pageSignup());
    else renderShell(pageLogin());
    return;
  }

  await bootData();

  if (hash === "billing") renderShell(pageBilling());
  else if (hash === "stock") renderShell(pageStock());
  else if (hash === "customers") renderShell(pageCustomers());
  else if (hash === "reports") renderShell(await pageReports());
  else if (hash === "settings") renderShell(pageSettings());
  else renderShell(await pageDashboard());

  if (hash === "billing") renderBillTotals();
}

window.addEventListener("hashchange", () => {
  window.scrollTo(0, 0);
  render();
});
document.addEventListener("DOMContentLoaded", render);
