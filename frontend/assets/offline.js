// Offline-first storage and sync for DukaanSaathi.
// Uses the browser's IndexedDB directly (no library) so it works in a
// PWA/installed Android context with zero extra dependencies.
//
// Data isolation: every record is namespaced by shop_id, and every read
// filters by the CURRENT logged-in shop's id, so switching accounts on
// the same device never shows one shop's cached data to another.

const DB_NAME = "dukaansaathi_offline";
const DB_VERSION = 3;
let dbPromise = null;

function openOfflineDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("session")) db.createObjectStore("session");
      if (!db.objectStoreNames.contains("products")) db.createObjectStore("products", { keyPath: "id" });
      if (!db.objectStoreNames.contains("customers")) db.createObjectStore("customers", { keyPath: "id" });
      if (!db.objectStoreNames.contains("pendingBills")) db.createObjectStore("pendingBills", { keyPath: "clientTransactionId" });
      if (!db.objectStoreNames.contains("syncQueue")) db.createObjectStore("syncQueue", { keyPath: "clientTransactionId" });
      // Append-only audit log of every local stock/udhaar change made
      // while offline. Separate from the mutated products/customers rows
      // above (which only hold the latest total) - this is the durable,
      // per-change record the offline spec asked for.
      if (!db.objectStoreNames.contains("localLedger")) db.createObjectStore("localLedger", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return openOfflineDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const store = t.objectStore(storeName);
        const result = fn(store);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
      })
  );
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ------------------------------------------------------------- session --
// Caches {user, shop} after every successful /auth/me or login, so a
// previously-logged-in shopkeeper can keep using the app (billing
// included) with the phone fully offline, without weakening auth: this
// never stores the password, only the already-issued session's user/shop
// info, the same data the server would hand back anyway.
async function cacheSession(user, shop) {
  await tx("session", "readwrite", (store) => store.put({ user, shop }, "current"));
}
async function getCachedSession() {
  const db = await openOfflineDb();
  return new Promise((resolve) => {
    const req = db.transaction("session", "readonly").objectStore("session").get("current");
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}
async function clearCachedSession() {
  await tx("session", "readwrite", (store) => store.delete("current"));
}

// -------------------------------------------------------- reference data --
async function cacheProducts(shopId, products) {
  await tx("products", "readwrite", (store) => {
    products.forEach((p) => store.put({ ...p, shop_id: shopId }));
  });
}
async function cacheCustomers(shopId, customers) {
  await tx("customers", "readwrite", (store) => {
    customers.forEach((c) => store.put({ ...c, shop_id: shopId }));
  });
}
async function getCachedProducts(shopId) {
  const db = await openOfflineDb();
  return new Promise((resolve) => {
    const req = db.transaction("products", "readonly").objectStore("products").getAll();
    req.onsuccess = () => resolve((req.result || []).filter((p) => p.shop_id === shopId));
    req.onerror = () => resolve([]);
  });
}
async function getCachedCustomers(shopId) {
  const db = await openOfflineDb();
  return new Promise((resolve) => {
    const req = db.transaction("customers", "readonly").objectStore("customers").getAll();
    req.onsuccess = () => resolve((req.result || []).filter((c) => c.shop_id === shopId));
    req.onerror = () => resolve([]);
  });
}

// Applies a bill's effect to the LOCAL cached copies only (stock down,
// udhaar up), so the next offline bill in the same session sees correct
// numbers. The server re-validates everything again at sync time - this
// local adjustment is only for a sane offline UI, never trusted as final.
async function appendLedgerEntry(entry) {
  await tx("localLedger", "readwrite", (store) => store.put({ id: uuid(), createdAt: new Date().toISOString(), ...entry }));
}
async function getLocalLedger(shopId) {
  const db = await openOfflineDb();
  return new Promise((resolve) => {
    const req = db.transaction("localLedger", "readonly").objectStore("localLedger").getAll();
    req.onsuccess = () => resolve((req.result || []).filter((e) => e.shopId === shopId));
    req.onerror = () => resolve([]);
  });
}

async function applyLocalBillEffects(shopId, bill, clientTransactionId) {
  const products = await getCachedProducts(shopId);
  await tx("products", "readwrite", (store) => {
    bill.items.forEach((item) => {
      const p = products.find((x) => x.id === item.productId);
      if (p) store.put({ ...p, stock_qty: Math.max(0, p.stock_qty - item.qty) });
    });
  });
  for (const item of bill.items) {
    await appendLedgerEntry({
      shopId,
      entityType: "stock",
      relatedClientTransactionId: clientTransactionId,
      productId: item.productId,
      qtyChange: -item.qty,
      note: "Offline sale",
    });
  }
  if (bill.customerId && (bill.paymentMode === "Udhaar" || bill.paymentMode === "Partial")) {
    const customers = await getCachedCustomers(shopId);
    const c = customers.find((x) => x.id === bill.customerId);
    if (c) {
      // Mirrors the server's own total/paid calculation closely enough
      // for a local receipt preview; the server computes the real total.
      await tx("customers", "readwrite", (store) => store.put({ ...c, udhaar_balance: (c.udhaar_balance || 0) + (bill._dueAmount || 0) }));
      await appendLedgerEntry({
        shopId,
        entityType: "udhaar",
        relatedClientTransactionId: clientTransactionId,
        customerId: bill.customerId,
        amountChange: bill._dueAmount || 0,
        note: "Offline bill udhaar",
      });
    }
  }
}

// ------------------------------------------------------------ pending bills --
async function queueOfflineBill(shopId, billPayload, localInvoicePreview) {
  const clientTransactionId = uuid();
  const record = {
    clientTransactionId,
    shopId,
    payload: billPayload,
    status: "PENDING_SYNC",
    createdOfflineAt: new Date().toISOString(),
    syncError: null,
    localInvoicePreview, // what the receipt screen shows until it's synced
  };
  await tx("pendingBills", "readwrite", (store) => store.put(record));
  await applyLocalBillEffects(shopId, { ...billPayload, _dueAmount: localInvoicePreview.invoice.due_amount }, clientTransactionId);
  return record;
}

async function getPendingBills(shopId) {
  const db = await openOfflineDb();
  return new Promise((resolve) => {
    const req = db.transaction("pendingBills", "readonly").objectStore("pendingBills").getAll();
    req.onsuccess = () => resolve((req.result || []).filter((b) => b.shopId === shopId));
    req.onerror = () => resolve([]);
  });
}
async function countPendingBills(shopId) {
  const bills = await getPendingBills(shopId);
  return bills.filter((b) => b.status === "PENDING_SYNC").length;
}
async function updateBillStatus(clientTransactionId, status, extra) {
  await tx("pendingBills", "readwrite", (store) => {
    const req = store.get(clientTransactionId);
    req.onsuccess = () => {
      const record = req.result;
      if (!record) return;
      store.put({ ...record, status, ...extra });
    };
  });
}
// Only call this for bills that are fully SYNCED - never for conflicts
// or errors, so a bill is never silently lost.
async function removeSyncedBill(clientTransactionId) {
  await tx("pendingBills", "readwrite", (store) => store.delete(clientTransactionId));
}

// ---------------------------------------------------------------- sync --
let syncInFlight = false;
async function syncPendingBills(shopId) {
  if (syncInFlight) return { synced: 0, conflicts: 0, errors: 0 };
  syncInFlight = true;
  try {
    const bills = (await getPendingBills(shopId)).filter((b) => b.status === "PENDING_SYNC");
    if (!bills.length) return { synced: 0, conflicts: 0, errors: 0 };

    const res = await fetch("/api/invoices/sync", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bills: bills.map((b) => ({ clientTransactionId: b.clientTransactionId, ...b.payload })),
      }),
    });
    if (!res.ok) {
      // Network reached the server but it rejected the whole batch
      // (e.g. not logged in). Leave every bill untouched - nothing lost.
      return { synced: 0, conflicts: 0, errors: bills.length };
    }
    const { results } = await res.json();
    let synced = 0,
      conflicts = 0,
      errors = 0;
    for (const r of results) {
      if (r.status === "synced") {
        await removeSyncedBill(r.clientTransactionId);
        synced++;
      } else if (r.status === "conflict") {
        await updateBillStatus(r.clientTransactionId, "SYNC_CONFLICT", { syncError: r.error });
        conflicts++;
      } else {
        // Leave as PENDING_SYNC so it is retried next time, but remember
        // the last error for display.
        await updateBillStatus(r.clientTransactionId, "PENDING_SYNC", { syncError: r.error });
        errors++;
      }
    }
    return { synced, conflicts, errors };
  } catch (err) {
    // Offline again mid-sync, or some other network failure: every bill
    // simply stays PENDING_SYNC, ready to retry. Nothing is deleted.
    return { synced: 0, conflicts: 0, errors: 0, networkError: true };
  } finally {
    syncInFlight = false;
  }
}

// -------------------------------------------------------- network status --
function isOnline() {
  return navigator.onLine;
}

async function queueOfflineOperation(shopId, entityType, payload) {
  const clientTransactionId = uuid();
  const record = {
    clientTransactionId,
    shopId,
    entityType,
    payload,
    status: "PENDING",
    retryCount: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
    syncedAt: null,
  };
  await tx("syncQueue", "readwrite", (store) => store.put(record));
  return record;
}

async function getQueuedOperations(shopId) {
  const db = await openOfflineDb();
  return new Promise((resolve) => {
    const req = db.transaction("syncQueue", "readonly").objectStore("syncQueue").getAll();
    req.onsuccess = () => resolve((req.result || []).filter((o) => o.shopId === shopId));
    req.onerror = () => resolve([]);
  });
}
async function countQueuedOperations(shopId) {
  const ops = await getQueuedOperations(shopId);
  return ops.filter((o) => o.status === "PENDING" || o.status === "FAILED").length;
}
async function removeQueuedOperation(clientTransactionId) {
  await tx("syncQueue", "readwrite", (store) => store.delete(clientTransactionId));
}
async function markQueuedOperation(clientTransactionId, status, extra) {
  await tx("syncQueue", "readwrite", (store) => {
    const req = store.get(clientTransactionId);
    req.onsuccess = () => {
      const record = req.result;
      if (!record) return;
      store.put({ ...record, status, ...extra });
    };
  });
}

let queueSyncInFlight = false;
async function syncQueuedOperations(shopId) {
  if (queueSyncInFlight) return { synced: 0, conflicts: 0, errors: 0 };
  queueSyncInFlight = true;
  try {
    const ops = (await getQueuedOperations(shopId)).filter((o) => o.status === "PENDING" || o.status === "FAILED");
    if (!ops.length) return { synced: 0, conflicts: 0, errors: 0 };

    const res = await fetch("/api/sync/push", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operations: ops.map((o) => ({ clientTransactionId: o.clientTransactionId, entityType: o.entityType, payload: o.payload })),
      }),
    });
    if (!res.ok) {
      for (const o of ops) {
        await markQueuedOperation(o.clientTransactionId, "FAILED", { retryCount: (o.retryCount || 0) + 1, lastError: `Server rejected sync (${res.status})` });
      }
      return { synced: 0, conflicts: 0, errors: ops.length };
    }
    const { results } = await res.json();
    let synced = 0,
      conflicts = 0,
      errors = 0;
    for (const r of results) {
      if (r.status === "synced") {
        await removeQueuedOperation(r.clientTransactionId);
        synced++;
      } else if (r.status === "conflict") {
        await markQueuedOperation(r.clientTransactionId, "CONFLICT", { lastError: r.error });
        conflicts++;
      } else {
        const existing = ops.find((o) => o.clientTransactionId === r.clientTransactionId);
        await markQueuedOperation(r.clientTransactionId, "FAILED", {
          retryCount: ((existing && existing.retryCount) || 0) + 1,
          lastError: r.error,
        });
        errors++;
      }
    }
    return { synced, conflicts, errors };
  } catch (err) {
    return { synced: 0, conflicts: 0, errors: 0, networkError: true };
  } finally {
    queueSyncInFlight = false;
  }
}

const DukaanOffline = {
  cacheSession,
  getCachedSession,
  clearCachedSession,
  cacheProducts,
  cacheCustomers,
  getCachedProducts,
  getCachedCustomers,
  queueOfflineBill,
  getLocalLedger,
  getPendingBills,
  countPendingBills,
  syncPendingBills,
  queueOfflineOperation,
  getQueuedOperations,
  countQueuedOperations,
  syncQueuedOperations,
  isOnline,
};
      
