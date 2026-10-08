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
      <label>UPI ID (for auto-amount QR)</label><input id="st_upi" value="${escHtml(S.shop.upi_id || "")}" placeholder="yourname@upi">
      <p class="muted">With a UPI ID, each bill shows a QR already filled with the exact total.</p>
      <p id="st_err" class="err"></p>
      <button class="btn" onclick="saveSettings()">Save Settings</button>
    </div>
    <div class="card">
      <label>Shop Profile Image</label>
      <input type="file" accept="image/*" onchange="uploadLogo(this)">
      ${S.shop.logo_path ? `<img src="${S.shop.logo_path}" alt="Shop logo" style="width:120px;border-radius:10px;display:block;margin-top:8px">` : `<p class="muted">No shop image yet.</p>`}
      <p id="logo_err" class="err"></p>
    </div>
    <div class="card">
      <label>Or upload your own QR code image</label>
      <input type="file" accept="image/*" onchange="uploadQr(this)">
      <p class="muted">Use this if you'd rather show a fixed QR (e.g. one from your bank). It will NOT auto-fill the amount — the customer must type it in themselves.</p>
      ${S.shop.qr_image_path ? `<img src="${S.shop.qr_image_path}" alt="Your QR code" style="width:200px;max-width:100%">` : `<p class="muted">No QR uploaded yet.</p>`}
      <p id="qr_err" class="err"></p>
    </div>`;
}
async function uploadLogo(input) {
  $("#logo_err").textContent = "";
  const file = input.files[0];
  if (!file) return;
  if (!/^image\//.test(file.type) || file.size > 5 * 1024 * 1024) {
    $("#logo_err").textContent = "Please choose an image under 5 MB.";
    return;
  }
  const form = new FormData();
  form.append("logo", file);
  try {
    const res = await fetch("/api/shop/logo", { method: "POST", credentials: "include", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Upload failed.");
    S.shop = data;
    goTo("settings");
  } catch (err) {
    $("#logo_err").textContent = err.message;
  }
}
async function uploadQr(input) {
  $("#qr_err").textContent = "";
  const file = input.files[0];
  if (!file) return;
  if (!/^image\//.test(file.type) || file.size > 5 * 1024 * 1024) {
    $("#qr_err").textContent = "Please choose an image under 5 MB.";
    return;
  }
  const form = new FormData();
  form.append("qr", file);
  try {
    const res = await fetch("/api/shop/qr", { method: "POST", credentials: "include", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Upload failed.");
    S.shop = data;
    goTo("settings");
  } catch (err) {
    $("#qr_err").textContent = err.message;
  }
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
  try {
    const [products, customers] = await Promise.all([api.get("/products"), api.get("/customers")]);
    S.products = products;
    S.customers = customers;
    if (S.shop?.id) {
      DukaanOffline.cacheProducts(S.shop.id, products);
      DukaanOffline.cacheCustomers(S.shop.id, customers);
    }
  } catch (err) {
    // Offline (or server unreachable): fall back to the last cached copy
    // instead of failing the page. If there's nothing cached yet (first
    // ever load with no internet), the lists are simply empty.
    if (S.shop?.id) {
      S.products = await DukaanOffline.getCachedProducts(S.shop.id);
      S.customers = await DukaanOffline.getCachedCustomers(S.shop.id);
    } else {
      throw err;
    }
  }
}

const PROTECTED_HASHES = ["dashboard", "billing", "stock", "customers", "reports", "settings"];

async function render() {
  const hash = (location.hash || "#home").slice(1);

  if (!isLoggedIn()) await tryRestoreSession();

  if (hash === "login") {
    renderShell(pageLogin());
    return;
  }
  if (hash === "signup") {
    renderShell(pageSignup());
    return;
  }
  if (PROTECTED_HASHES.includes(hash)) {
    if (!isLoggedIn()) {
      renderShell(pageLogin());
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
    return;
  }

  renderShell(pageHome());
}

async function updateNetStatus() {
  const el = $("#net_status");
  if (!el) return;
  const online = DukaanOffline.isOnline();
  const pending = S.shop?.id ? await DukaanOffline.countPendingBills(S.shop.id) : 0;
  el.textContent = (online ? "ONLINE" : "OFFLINE – Billing available") + (pending ? ` · ${pending} bill${pending > 1 ? "s" : ""} waiting to sync` : "");
  el.style.background = online ? "#e3f6e8" : "#fff3d6";
}

async function trySync() {
  if (!DukaanOffline.isOnline() || !S.shop?.id) return;
  await DukaanOffline.syncPendingBills(S.shop.id);
  await updateNetStatus();
}

window.addEventListener("online", trySync);
window.addEventListener("offline", updateNetStatus);
window.addEventListener("hashchange", () => {
  window.scrollTo(0, 0);
  render();
  updateNetStatus();
});
document.addEventListener("DOMContentLoaded", () => {
  render();
  updateNetStatus();
  trySync();
});
