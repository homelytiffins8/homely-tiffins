import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

// ─────────────────────────────────────────────
// SUPABASE CLIENT
// ─────────────────────────────────────────────
const SUPABASE_URL = "https://ktwaesobvvqzzhadrdoa.supabase.co";
const SUPABASE_KEY = "sb_publishable_dwkOUIJJ4oU2xIR0l6kDHg_zw9rHkIQ";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─────────────────────────────────────────────
// STORAGE HELPERS (Supabase-backed, cross-device)
// ─────────────────────────────────────────────
const KEYS = {
  menu: "ht_menu",
  // ── RETIRED (migrated to their own tables; nothing reads or writes
  // these anymore — kept only so old rows can be identified/cleaned):
  //   ht_orders_today, ht_orders_history  → `orders` table
  //   ht_customers                        → `customers` table
  //   ht_credit_ledger                    → `credit_ledger` table
  //   ht_contact_messages                 → `contact_messages` table
  //   ht_poll_responses                   → `poll_responses` table
  lastDate: "ht_last_open_date",
  kitchenOpen: "ht_kitchen_open", // boolean — owner controls if accepting orders
  poll: "ht_poll",                // owner-defined customer poll config { id, active, question, options[] }
  planConfig: "ht_plan_config",   // daily thali-plan config: sabjis/rice/salad/raita/sweet + plan prices
  contactInfo: "ht_contact_info", // owner-published contact channels { phone, whatsapp, email }
  promoCodes: "ht_promo_codes",           // owner-defined promo/discount codes (array)
  referralConfig: "ht_referral_config",   // referral programme settings { enabled, referredDiscount, referrerReward }
};

// ─────────────────────────────────────────────
// OWNER SESSION PERSISTENCE
// Now backed by real Supabase Auth (supabase.auth.signInWithPassword),
// instead of a plain localStorage flag anyone could set by hand.
// The Supabase client itself persists the session (in localStorage,
// but as a real signed JWT session token — not a boolean we invented),
// and auto-refreshes it, so we just ask it for the current session
// instead of maintaining our own expiry logic.
// ─────────────────────────────────────────────
async function getOwnerSession() {
  try {
    const { data } = await supabase.auth.getSession();
    return !!data?.session;
  } catch {
    return false;
  }
}

async function clearOwnerSession() {
  try {
    await supabase.auth.signOut();
  } catch {}
}

// ─────────────────────────────────────────────
// PROMO CODE + REFERRAL HELPERS
// ─────────────────────────────────────────────
function defaultReferralConfig() {
  return { enabled: true, referredDiscount: 30, referrerReward: 50, minOrder: 0 };
}

// Referral code derived from phone: HT + last 8 digits. Deterministic,
// so any customer's code is recoverable from their phone. Every past
// customer therefore already has a working referral code.
// Widened from 5 to 8 digits (was HT##### — collision-prone: two
// customers whose phone numbers happened to share the same last 5
// digits got the exact same code, and lookups used .find(), which
// silently matched the wrong customer and could misattribute referral
// rewards). 8 digits makes accidental collisions effectively impossible
// for a society-sized customer base while still being a short, shareable
// code.
function getReferralCode(phone) {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length < 8) return "";
  return "HT" + digits.slice(-8);
}
function phoneMatchesReferralCode(phone, code) {
  return getReferralCode(phone) === (code || "").toUpperCase().trim();
}

// Try to resolve an entered promo/referral code against:
//   1. Active promo codes (flat / percent)
//   2. Referral pattern HT######## matching an existing customer (with >=1 past order)
// Returns { ok, discount, kind: "promo"|"referral", promoCode?, referrerPhone?, referrerName?, error? }
// Rules:
//   - Empty code => ok:true, discount:0, kind:"none"
//   - Promo code (case-insensitive) wins if it matches an active entry
//   - Referral: cannot self-refer; new customer must NOT have ordered before
//   - Min-order enforced if the code / config specifies it
function resolvePromoOrReferral({ codeText, promoCodes = [], referralConfig, customers = [], phone, cartTotal }) {
  const raw = (codeText || "").trim();
  if (!raw) return { ok: true, discount: 0, kind: "none" };
  const upper = raw.toUpperCase();

  // 1) Promo code match
  const promo = (promoCodes || []).find(p =>
    p && p.active !== false && (p.code || "").toUpperCase() === upper
  );
  if (promo) {
    if (promo.minOrder && cartTotal < promo.minOrder) {
      return { ok: false, error: `Minimum order ₹${promo.minOrder} required for this code` };
    }
    let discount = 0;
    if (promo.type === "percent") {
      const pct = Math.max(0, Math.min(100, Number(promo.value) || 0));
      discount = Math.round((cartTotal * pct) / 100);
    } else {
      discount = Math.max(0, Math.round(Number(promo.value) || 0));
    }
    discount = Math.min(discount, cartTotal);
    return { ok: true, discount, kind: "promo", promoCode: promo.code, description: promo.description };
  }

  // 2) Referral code match (HT########)
  const rc = referralConfig && referralConfig.enabled !== false ? referralConfig : null;
  if (rc && /^HT\d{8}$/i.test(upper)) {
    // Find referrer by matching last-8 of phone
    const referrer = (customers || []).find(c => getReferralCode(c.phone) === upper && (c.totalOrders || 0) >= 1);
    if (!referrer) return { ok: false, error: "Referral code not recognised" };
    // Prevent self-referral
    if (phone && phoneMatchesReferralCode(phone, upper)) {
      return { ok: false, error: "You can't use your own referral code" };
    }
    // Referred user must be new (no prior orders)
    const existing = (customers || []).find(c => c.phone === phone);
    if (existing && (existing.totalOrders || 0) >= 1) {
      return { ok: false, error: "Referral codes are only for new customers" };
    }
    if (rc.minOrder && cartTotal < rc.minOrder) {
      return { ok: false, error: `Minimum order ₹${rc.minOrder} required to use a referral code` };
    }
    const discount = Math.min(Math.max(0, Number(rc.referredDiscount) || 0), cartTotal);
    return {
      ok: true, discount, kind: "referral",
      referrerPhone: referrer.phone, referrerName: referrer.name,
      description: `Referred by ${referrer.name}`,
    };
  }

  return { ok: false, error: "Invalid or inactive code" };
}

// ─────────────────────────────────────────────
// THALI PLANS (Homely Gold / Standard / Mini)
// Structural rules are fixed; only the day's sabjis, rice, salad,
// raita and sweet (and prices) are owner-editable via the "Plans" tab.
// ─────────────────────────────────────────────
const BREAD_CHOICES = [
  { id: "chapati4", label: "4 Ghee Chapati" },
  { id: "paratha3", label: "3 Ghee Paratha" },
];
function defaultPlanConfig() {
  return {
    date: todayStr(),
    sabjis: [
      { id: genId(), name: "", premium: false },
      { id: genId(), name: "", premium: false },
      { id: genId(), name: "", premium: true },
    ],
    rice: "",
    salad: "",
    raita: "",
    sweet: "",
    // gold = Medium price (base). goldLargeSurcharge = flat ₹ added on top for Large.
    prices: { gold: 199, goldLargeSurcharge: 76, standard: 120, mini: 80, raita: 30, salad: 20, sweet: 30 },
    // Per-variant on/off (owner can hide a plan if stocked out for the day).
    // Homely Gold has independent Medium/Large toggles so one size can be
    // sold out while the other stays available.
    enabled: { goldMedium: true, goldLarge: true, standard: true, mini: true, raita: true, salad: true, sweet: true },
    // Optional photo per variant, stored as a resized/compressed base64 JPEG
    // data URL. Empty string means "no photo".
    photos: { gold: "", standard: "", mini: "" },
  };
}

// Fill in missing fields on a loaded planConfig so older records don't crash.
// (No-op if the config is already well-formed.)
function normalisePlanConfig(cfg) {
  if (!cfg) return cfg;
  const d = defaultPlanConfig();
  const oldEnabled = cfg.enabled || {};
  return {
    ...cfg,
    enabled: {
      ...d.enabled,
      ...oldEnabled,
      // Migrate legacy single "gold" toggle (pre size-split) → Medium keeps
      // whatever the old toggle was set to; Large defaults on unless the
      // config already specifies it explicitly.
      goldMedium: oldEnabled.goldMedium !== undefined ? oldEnabled.goldMedium : (oldEnabled.gold !== undefined ? oldEnabled.gold : true),
      goldLarge:  oldEnabled.goldLarge  !== undefined ? oldEnabled.goldLarge  : true,
    },
    photos:  { ...d.photos,  ...(cfg.photos  || {}) },
    prices:  { ...d.prices,  ...(cfg.prices  || {}) },
  };
}

// Resize + compress a File to a base64 JPEG data URL suitable for Supabase.
// 1400px wide at 0.85 quality gives crisp full-screen previews on the customer
// side while keeping each photo roughly 200–400 KB — three photos still leave
// the planConfig blob well under Supabase's 5 MB per-key limit.
function resizeAndCompressImage(file, maxWidth = 1400, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const w = Math.max(1, Math.round(img.width  * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("Could not load image"));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

// Cap stored poll responses so the payload stays small for realtime sync.
const MAX_POLL_RESPONSES = 3000;

// Broadcasts a storage failure so the UI can tell the user their change
// may not have actually been saved, instead of silently pretending it
// worked. Listened for by <SaveErrorBanner/> mounted at the app root.
function notifyStorageError(action, key, err) {
  console.error(`[storage] ${action} failed for "${key}":`, err);
  try {
    window.dispatchEvent(new CustomEvent("ht-storage-error", { detail: { action, key } }));
  } catch {}
}

async function load(key) {
  try {
    const { data, error } = await supabase.from("app_data").select("value").eq("key", key).maybeSingle();
    if (error) { notifyStorageError("load", key, error); return null; }
    if (!data) return null;
    return data.value;
  } catch (err) { notifyStorageError("load", key, err); return null; }
}
async function save(key, val) {
  try {
    const { error } = await supabase.from("app_data").upsert({ key, value: val, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) notifyStorageError("save", key, error);
  } catch (err) { notifyStorageError("save", key, err); }
}
// Small banner shown when a save/load to Supabase fails, so the person
// isn't left thinking a change went through when it didn't. Auto-hides
// after a few seconds; stacks a count if multiple failures happen close
// together.
// ─────────────────────────────────────────────
// PWA INSTALL BUTTON
// Chrome only auto-shows its own "Add to Home Screen" prompt after an
// engagement heuristic is met, which can take multiple visits. Capturing
// `beforeinstallprompt` ourselves lets us offer an explicit, always-visible
// "Install App" button instead of waiting on that. Hides itself once the
// app is installed or already running standalone.
// ─────────────────────────────────────────────
function InstallAppButton() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const isStandalone =
      window.matchMedia?.("(display-mode: standalone)")?.matches ||
      window.navigator.standalone === true; // iOS Safari
    if (isStandalone) return;

    const onBeforeInstallPrompt = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setVisible(true);
    };
    const onAppInstalled = () => {
      setVisible(false);
      setDeferredPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    // Whether accepted or dismissed, this specific prompt can't be reused.
    setDeferredPrompt(null);
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <button
      onClick={handleInstall}
      style={{
        position: "fixed",
        bottom: 18,
        right: 18,
        zIndex: 9999,
        background: "#E0731A",
        color: "#fff",
        border: "none",
        borderRadius: 999,
        padding: "10px 18px",
        fontFamily: "Nunito, sans-serif",
        fontWeight: 700,
        fontSize: 14,
        boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      ⬇️ Install App
    </button>
  );
}

function SaveErrorBanner() {
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef(null);

  useEffect(() => {
    const onError = () => {
      setVisible(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setVisible(false), 6000);
    };
    window.addEventListener("ht-storage-error", onError);
    return () => {
      window.removeEventListener("ht-storage-error", onError);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  if (!visible) return null;
  return (
    <div style={{
      position: "fixed", top: 12, left: "50%", transform: "translateX(-50%)",
      zIndex: 9999, background: "#B94A3B", color: "#fff", fontSize: 13, fontWeight: 600,
      padding: "10px 18px", borderRadius: 10, boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
      display: "flex", alignItems: "center", gap: 8, maxWidth: "90vw", textAlign: "center",
    }}>
      ⚠️ Connection issue — your last change may not have saved. Please check and try again.
    </div>
  );
}

// ─────────────────────────────────────────────
// STAGE 3 — DUAL-WRITE TO THE NEW `orders` TABLE
// ─────────────────────────────────────────────
// The app still reads/writes its actual working data from the
// app_data blob (KEYS.todayOrders / KEYS.ordersHistory), same as
// before. This mirrors every order write to the new relational
// `orders` table too, so we can verify for a while that the two
// stay in sync before ever switching reads over. If this fails, we
// deliberately do NOT surface an error banner to the owner/customer —
// the real save already succeeded via app_data, so failure here must
// never look like the order itself failed.
const ORDER_KNOWN_FIELDS = new Set([
  "id", "phone", "customerName", "tower", "flat", "address", "items", "total",
  "status", "paymentMode", "promoCode", "referralCode", "notes", "date",
  "createdAt", "preparingAt", "readyAt", "dispatchedAt", "deliveredAt",
]);
function orderToRow(o) {
  // Anything not mapped to a real column (rating object, promoLabel,
  // referrer tracking fields, and any future field) is preserved in
  // `extra` rather than silently dropped — see schema note.
  const extra = {};
  for (const k in o) {
    if (!ORDER_KNOWN_FIELDS.has(k)) extra[k] = o[k];
  }
  return {
    id: o.id,
    phone: o.phone || "",
    customer_name: o.customerName || null,
    tower: o.tower || null,
    flat: o.flat || null,
    address: o.address || null,
    items: o.items || [],
    total: o.total ?? 0,
    status: o.status || "pending",
    payment_mode: o.paymentMode || null,
    promo_code: o.promoCode || null,
    referral_code: o.referralCode || null,
    notes: o.notes || null,
    date: o.date || todayStr(), // never let a null date make an order invisible to the today/history queries
    created_at: o.createdAt || new Date().toISOString(),
    preparing_at: o.preparingAt || null,
    ready_at: o.readyAt || null,
    dispatched_at: o.dispatchedAt || null,
    delivered_at: o.deliveredAt || null,
    extra,
  };
}
// Inverse of orderToRow — reconstructs the app's order object shape from
// a table row, so read paths get back exactly what write paths saved.
function rowToOrder(row) {
  return {
    ...(row.extra || {}),
    id: row.id,
    phone: row.phone,
    customerName: row.customer_name,
    tower: row.tower,
    flat: row.flat,
    address: row.address,
    items: row.items || [],
    total: row.total,
    status: row.status,
    paymentMode: row.payment_mode,
    promoCode: row.promo_code,
    referralCode: row.referral_code,
    notes: row.notes,
    date: row.date,
    createdAt: row.created_at,
    preparingAt: row.preparing_at,
    readyAt: row.ready_at,
    dispatchedAt: row.dispatched_at,
    deliveredAt: row.delivered_at,
  };
}
// Writes orders to the `orders` table — the single source of truth.
// (Was previously a "dual-write" alongside an app_data blob copy during
// the migration; that fallback has been removed.)
async function writeOrders(orders) {
  if (!orders || orders.length === 0) return;
  try {
    const rows = orders.map(orderToRow);
    const { error } = await supabase.from("orders").upsert(rows, { onConflict: "id" });
    if (error) notifyStorageError("save", "orders", error);
  } catch (err) {
    notifyStorageError("save", "orders", err);
  }
}

// ─────────────────────────────────────────────
// ORDERS: read from the `orders` table
// ─────────────────────────────────────────────
async function loadTodayOrdersFromTable(today) {
  try {
    const { data, error } = await supabase.from("orders").select("*").eq("date", today);
    if (error) { notifyStorageError("load", "orders(today)", error); return null; }
    return (data || []).map(rowToOrder);
  } catch (err) { notifyStorageError("load", "orders(today)", err); return null; }
}
async function loadHistoryOrdersFromTable(excludeDate) {
  try {
    let q = supabase.from("orders").select("*").order("created_at", { ascending: false }).limit(5000);
    if (excludeDate) q = q.neq("date", excludeDate);
    const { data, error } = await q;
    if (error) { notifyStorageError("load", "orders(history)", error); return null; }
    return (data || []).map(rowToOrder);
  } catch (err) { notifyStorageError("load", "orders(history)", err); return null; }
}
// Customer-facing read path: the `orders` table has no anon SELECT policy
// (owner_full_access_orders only grants the authenticated/owner role), so
// customers can't read it directly — a plain select("*") silently returns
// nothing for them. This RPC (SECURITY DEFINER, granted to anon) returns
// only the rows matching a given phone number, which is what the customer
// tracking UI and the "rate your last order" prompt actually need.
async function loadOrdersByPhoneFromTable(phone) {
  if (!phone) return [];
  try {
    const { data, error } = await supabase.rpc("get_orders_by_phone", { p_phone: phone });
    if (error) { notifyStorageError("load", "orders(by phone)", error); return null; }
    return (data || []).map(rowToOrder);
  } catch (err) { notifyStorageError("load", "orders(by phone)", err); return null; }
}

// ─────────────────────────────────────────────
// CUSTOMERS: the `customers` table is the single source of truth.
// Writes happen server-side inside the place_order RPC.
// ─────────────────────────────────────────────
function customerToRow(c) {
  return {
    phone: c.phone,
    name: c.name || null,
    tower: c.tower || null,
    flat: c.flat || null,
    total_orders: c.totalOrders || 0,
    total_spent: c.totalSpent || 0,
    first_order_date: c.firstOrderDate || null,
    last_order_date: c.lastOrderDate || null,
    referral_code: getReferralCode(c.phone) || null,
    updated_at: new Date().toISOString(),
  };
}
// Inverse of customerToRow — reconstructs the app's customer object shape.
function rowToCustomer(row) {
  return {
    phone: row.phone,
    name: row.name,
    tower: row.tower,
    flat: row.flat,
    totalOrders: row.total_orders,
    totalSpent: row.total_spent,
    firstOrderDate: row.first_order_date,
    lastOrderDate: row.last_order_date,
  };
}
async function loadCustomersFromTable() {
  try {
    const { data, error } = await supabase.from("customers").select("*");
    if (error) { notifyStorageError("load", "customers", error); return null; }
    return (data || []).map(rowToCustomer);
  } catch (err) { notifyStorageError("load", "customers", err); return null; }
}

// ─────────────────────────────────────────────
// STAGE 7 — CONTACT MESSAGES & POLL RESPONSES
// Lower-stakes tables (not linked to money/orders), so migrated
// directly to full read+write on the table rather than a separate
// dual-write phase — same underlying pattern as before, just combined.
// app_data is NOT touched for these two anymore going forward.
// ─────────────────────────────────────────────
const CONTACT_MSG_KNOWN_FIELDS = new Set(["id", "name", "phone", "message", "ts", "read"]);
function contactMessageToRow(m) {
  const extra = {};
  for (const k in m) if (!CONTACT_MSG_KNOWN_FIELDS.has(k)) extra[k] = m[k];
  return {
    id: m.id,
    phone: m.phone || null,
    name: m.name || null,
    message: m.message || "",
    created_at: m.ts ? new Date(m.ts).toISOString() : new Date().toISOString(),
    read: !!m.read,
    extra,
  };
}
function rowToContactMessage(row) {
  return {
    ...(row.extra || {}),
    id: row.id,
    phone: row.phone,
    name: row.name,
    message: row.message,
    ts: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    read: row.read,
  };
}
async function loadContactMessagesFromTable() {
  try {
    const { data, error } = await supabase.from("contact_messages").select("*").order("created_at", { ascending: false }).limit(500);
    if (error) { notifyStorageError("load", "contact_messages", error); return null; }
    return (data || []).map(rowToContactMessage);
  } catch (err) { notifyStorageError("load", "contact_messages", err); return null; }
}
async function saveContactMessagesToTable(list) {
  try {
    const rows = list.map(contactMessageToRow);
    const { error } = await supabase.from("contact_messages").upsert(rows, { onConflict: "id" });
    if (error) notifyStorageError("save", "contact_messages", error);
  } catch (err) { notifyStorageError("save", "contact_messages", err); }
}
async function deleteContactMessageFromTable(id) {
  try {
    const { error } = await supabase.from("contact_messages").delete().eq("id", id);
    if (error) notifyStorageError("delete", "contact_messages", error);
  } catch (err) { notifyStorageError("delete", "contact_messages", err); }
}

const POLL_RESPONSE_KNOWN_FIELDS = new Set(["id", "pollId", "choice"]);
function pollResponseToRow(r) {
  const extra = {};
  for (const k in r) if (!POLL_RESPONSE_KNOWN_FIELDS.has(k)) extra[k] = r[k];
  return {
    id: r.id,
    poll_id: r.pollId || "unknown",
    phone: r.phone || null,
    answer: r.choice || "",
    created_at: r.at || new Date().toISOString(),
    extra,
  };
}
function rowToPollResponse(row) {
  return {
    ...(row.extra || {}),
    id: row.id,
    pollId: row.poll_id,
    choice: row.answer,
    at: row.created_at,
  };
}
async function loadPollResponsesFromTable() {
  try {
    const { data, error } = await supabase.from("poll_responses").select("*").order("created_at", { ascending: false }).limit(MAX_POLL_RESPONSES);
    if (error) { notifyStorageError("load", "poll_responses", error); return null; }
    return (data || []).map(rowToPollResponse);
  } catch (err) { notifyStorageError("load", "poll_responses", err); return null; }
}
async function savePollResponseToTable(response) {
  try {
    const { error } = await supabase.from("poll_responses").upsert([pollResponseToRow(response)], { onConflict: "id" });
    if (error) notifyStorageError("save", "poll_responses", error);
  } catch (err) { notifyStorageError("save", "poll_responses", err); }
}
async function clearPollResponsesTable() {
  try {
    const { error } = await supabase.from("poll_responses").delete().neq("id", "");
    if (error) notifyStorageError("delete", "poll_responses", error);
  } catch (err) { notifyStorageError("delete", "poll_responses", err); }
}

// ─────────────────────────────────────────────
// STAGE 10 — CREDIT LEDGER
// Owner-only feature (no customer-facing writes), so this goes
// straight to the real table — no RPC needed, same as
// contact_messages/poll_responses. One row per ledger entry; the
// customer's name/tower/flat are looked up from the `customers` table
// rather than duplicated on every entry.
// ─────────────────────────────────────────────
const CREDIT_ENTRY_KNOWN_FIELDS = new Set(["id", "orderId", "date", "type", "amount", "note"]);
function creditEntryToRow(phone, entry) {
  const extra = {};
  for (const k in entry) if (!CREDIT_ENTRY_KNOWN_FIELDS.has(k)) extra[k] = entry[k];
  return {
    id: entry.id,
    phone,
    order_id: entry.orderId || null,
    amount: entry.amount ?? 0,
    type: entry.type || "adjustment",
    note: entry.note || null,
    created_at: entry.date || new Date().toISOString(),
    extra,
  };
}
function rowToCreditEntry(row) {
  return {
    ...(row.extra || {}),
    id: row.id,
    orderId: row.order_id,
    date: row.created_at,
    type: row.type,
    amount: row.amount,
    note: row.note,
  };
}
async function saveCreditEntriesToTable(phone, entries) {
  if (!entries || entries.length === 0) return;
  try {
    const rows = entries.map(e => creditEntryToRow(phone, e));
    const { error } = await supabase.from("credit_ledger").upsert(rows, { onConflict: "id" });
    if (error) notifyStorageError("save", "credit_ledger", error);
  } catch (err) { notifyStorageError("save", "credit_ledger", err); }
}
async function deleteCreditForPhone(phone) {
  try {
    const { error } = await supabase.from("credit_ledger").delete().eq("phone", phone);
    if (error) notifyStorageError("delete", "credit_ledger", error);
  } catch (err) { notifyStorageError("delete", "credit_ledger", err); }
}
async function deleteCreditEntryRow(entryId) {
  try {
    const { error } = await supabase.from("credit_ledger").delete().eq("id", entryId);
    if (error) notifyStorageError("delete", "credit_ledger", error);
  } catch (err) { notifyStorageError("delete", "credit_ledger", err); }
}
async function replaceAllCreditEntries(phone, entries) {
  // Used by reconcile, where the entry set for a phone is fully rebuilt.
  await deleteCreditForPhone(phone);
  await saveCreditEntriesToTable(phone, entries);
}
// Groups flat ledger rows back into the app's { phone, name, tower,
// flat, entries[] } shape, using the customers table for the display
// fields rather than storing them redundantly on every entry.
async function loadCreditFromTable() {
  try {
    const [{ data: rows, error: e1 }, { data: custRows, error: e2 }] = await Promise.all([
      supabase.from("credit_ledger").select("*").order("created_at", { ascending: true }),
      supabase.from("customers").select("phone, name, tower, flat"),
    ]);
    if (e1) { notifyStorageError("load", "credit_ledger", e1); return null; }
    if (e2) { notifyStorageError("load", "credit_ledger(customers)", e2); }
    const custByPhone = new Map((custRows || []).map(c => [c.phone, c]));
    const byPhone = new Map();
    for (const row of rows || []) {
      if (!byPhone.has(row.phone)) {
        const c = custByPhone.get(row.phone);
        byPhone.set(row.phone, { phone: row.phone, name: c?.name || "", tower: c?.tower || "", flat: c?.flat || "", entries: [] });
      }
      byPhone.get(row.phone).entries.push(rowToCreditEntry(row));
    }
    return Array.from(byPhone.values());
  } catch (err) { notifyStorageError("load", "credit_ledger", err); return null; }
}

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
// Returns today's date as YYYY-MM-DD in India Standard Time (UTC+5:30),
// not raw UTC. Raw UTC would roll the date over at 5:30 AM IST instead
// of midnight IST — e.g. at 1:00 AM IST it's still the previous day in
// UTC, which used to leak into menus/orders/analytics/archiving/credit
// reconciliation as "yesterday" during that ~5.5 hour window.
function todayStr() {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().split("T")[0];
}
function weekKey(dateStr) {
  const d = new Date(dateStr); const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const mon = new Date(d.setDate(diff)); return mon.toISOString().split("T")[0];
}
function fmtTime(iso) { return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }); }
function fmtDate(ds) { return new Date(ds).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }
function fmtElapsed(min) {
  if (min < 1) return "just now";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// ─────────────────────────────────────────────
// STATUS PRECEDENCE — anti-regression guard
// ─────────────────────────────────────────────
// Orders only move FORWARD in the workflow. When multiple devices write to
// Supabase concurrently (e.g. customer app on phone + owner dashboard on
// laptop + family member on their phone), a stale local view can otherwise
// overwrite a newer server value and cause statuses to jump BACKWARD. These
// helpers make every write status-precedence-safe.
const STATUS_RANK = {
  pending: 0,
  preparing: 1,
  ready: 2,
  dispatched: 3,
  delivered: 4,
  rejected: 4, // terminal, same rank as delivered
};

// Merge two order arrays by id, keeping the "furthest-along" status per order.
// Never allows a lower-rank status to overwrite a higher-rank one.
// Also preserves ratings: if either side has a rating, the merged order keeps it
// (this prevents a stale write from wiping out a customer's rating).
function mergeOrders(base, incoming) {
  const map = new Map();
  for (const o of base || []) {
    if (o && o.id) map.set(o.id, o);
  }
  for (const o of incoming || []) {
    if (!o || !o.id) continue;
    const existing = map.get(o.id);
    if (!existing) {
      map.set(o.id, o);
    } else {
      const rExisting = STATUS_RANK[existing.status] ?? -1;
      const rIncoming = STATUS_RANK[o.status] ?? -1;
      // Pick the version with the further-along status
      let winner = rIncoming >= rExisting ? o : existing;
      // Preserve rating from either side (ratings are additive, never removed)
      const existingRating = existing.rating;
      const incomingRating = o.rating;
      if (existingRating && incomingRating) {
        // Both have ratings — keep the more recent
        const te = new Date(existingRating.ratedAt).getTime();
        const ti = new Date(incomingRating.ratedAt).getTime();
        winner = { ...winner, rating: ti >= te ? incomingRating : existingRating };
      } else if (existingRating && !winner.rating) {
        winner = { ...winner, rating: existingRating };
      } else if (incomingRating && !winner.rating) {
        winner = { ...winner, rating: incomingRating };
      }
      map.set(o.id, winner);
    }
  }
  return Array.from(map.values());
}

// Tower list N-1 to N-28
const TOWERS = Array.from({ length: 28 }, (_, i) => `N-${i + 1}`);

// Kitchen prep tower groups (used by the floating "Prepare Now" tabs).
// "all" = every preparing order. The three ranges split the society so the
// kitchen can prepare tower-by-tower. The last group runs to 28 so that no
// tower (incl. N-28) is ever left out of a group.
const PREP_GROUPS = [
  { key: "all", label: "All",       short: "All",  min: 1,  max: 28 },
  { key: "g1",  label: "N-1 → 7",   short: "1–7",  min: 1,  max: 7  },
  { key: "g2",  label: "N-8 → 17",  short: "8–17", min: 8,  max: 17 },
  { key: "g3",  label: "N-18 → 28", short: "18–28",min: 18, max: 28 },
];

// Extract the numeric part of a tower string like "N-14" → 14. Returns 0 if none.
function towerNum(t) {
  const m = /(\d+)/.exec(t || "");
  return m ? parseInt(m[1], 10) : 0;
}

// Build the pooled + separate prep lists for a set of preparing orders.
// Orders WITHOUT special instructions are pooled together by item name.
// Orders WITH special instructions are kept separate and never merged.
function computePrep(orders) {
  const pool = {};
  const separate = [];
  orders.forEach(o => {
    const hasNote = o.specialInstructions && o.specialInstructions.trim().length > 0;
    if (hasNote) {
      separate.push({ orderId: o.id, items: o.items, note: o.specialInstructions.trim() });
    } else {
      o.items.forEach(i => { pool[i.name] = (pool[i.name] || 0) + i.qty; });
    }
  });
  const pooled = Object.entries(pool).sort((a, b) => b[1] - a[1]);
  return { pooled, separate };
}

// ─────────────────────────────────────────────
// STAR RATING COMPONENTS
// ─────────────────────────────────────────────
// Small read-only star display (used in owner dashboard order cards + analytics)
function StarDisplay({ value = 0, size = 14, color = "#F4A261" }) {
  const rounded = Math.round(value * 2) / 2; // half-star precision
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 1, verticalAlign: "middle" }}>
      {[1, 2, 3, 4, 5].map(i => {
        const filled = rounded >= i;
        const half = !filled && rounded >= i - 0.5;
        return (
          <span key={i} style={{ fontSize: size, color: filled || half ? color : "#DDD5C8", lineHeight: 1 }}>
            {half ? "◐" : "★"}
          </span>
        );
      })}
    </span>
  );
}

// Tappable 5-star input (used in customer rating form)
function StarInput({ value = 0, onChange, size = 32 }) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {[1, 2, 3, 4, 5].map(i => (
        <button
          key={i}
          type="button"
          onClick={() => onChange(i)}
          style={{
            background: "transparent",
            border: "none",
            padding: 4,
            cursor: "pointer",
            fontSize: size,
            lineHeight: 1,
            color: value >= i ? "#F4A261" : "#DDD5C8",
            transition: "transform 0.1s, color 0.15s",
            transform: value >= i ? "scale(1.05)" : "scale(1)",
          }}
          onMouseEnter={e => e.currentTarget.style.transform = "scale(1.15)"}
          onMouseLeave={e => e.currentTarget.style.transform = value >= i ? "scale(1.05)" : "scale(1)"}
          aria-label={`${i} star${i > 1 ? "s" : ""}`}
        >
          ★
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────
// CSV EXPORT
// ─────────────────────────────────────────────
function exportCSV(rows, filename) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(","), ...rows.map(r => headers.map(h => `"${(r[h] ?? "").toString().replace(/"/g, '""')}"`).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
}
function exportDailyReport(allOrders, dateStr) {
  const day = dateStr || todayStr();
  const rows = allOrders.filter(o => o.date === day).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (!rows.length) { alert(`No orders for ${fmtDate(day)}.`); return; }
  exportCSV(rows.map(o => ({
    "Order ID": o.id.slice(-6).toUpperCase(), "Customer": o.customerName, "Tower": o.tower,
    "Flat": o.flat, "Phone": o.phone, "Items": o.items.map(i => `${i.name}(x${i.qty})`).join(" | "),
    "Total (₹)": o.total, "Status": o.status, "Time": fmtTime(o.createdAt), "Date": o.date,
    "Promo/Referral Code": o.promoCode || o.referralCode || "",
    "Discount (₹)": o.discount || 0,
  })), `HT_Daily_${day}.csv`);
}
function exportOrdersRange(allOrders, fromStr, toStr) {
  const rows = allOrders
    .filter(o => o.date >= fromStr && o.date <= toStr)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (!rows.length) { alert("No orders found in this date range."); return; }
  exportCSV(rows.map(o => ({
    "Order ID": o.id.slice(-6).toUpperCase(), "Customer": o.customerName, "Tower": o.tower,
    "Flat": o.flat, "Phone": o.phone, "Items": o.items.map(i => `${i.name}(x${i.qty})`).join(" | "),
    "Total (₹)": o.total, "Status": o.status, "Time": fmtTime(o.createdAt), "Date": o.date,
    "Promo/Referral Code": o.promoCode || o.referralCode || "",
    "Discount (₹)": o.discount || 0,
  })), `HT_Orders_${fromStr}_to_${toStr}.csv`);
}
function exportCustomerMaster(customers) {
  if (!customers.length) { alert("No customer data yet."); return; }
  exportCSV(customers.map(c => ({ "Name": c.name, "Phone": c.phone, "Tower": c.tower, "Flat": c.flat, "Orders": c.totalOrders, "Spent (₹)": c.totalSpent, "First Order": c.firstOrderDate || "", "Last Order": c.lastOrderDate || "" })), `HT_Customers_${todayStr()}.csv`);
}

// ─────────────────────────────────────────────
// DESIGN TOKENS
// ─────────────────────────────────────────────
const C = {
  saffron: "#E8781A", saffronLight: "#FDF0E4", saffronMid: "#F4A455",
  green: "#2D6A4F", greenLight: "#ECF7F2",
  cream: "#FDFAF6", ink: "#1A1208", inkMid: "#5C4A2A", inkLight: "#A89070",
  white: "#FFFFFF", red: "#C0392B", redLight: "#FDEAEA",
  border: "#E8DDD0", shadow: "0 2px 12px rgba(26,18,8,0.08)", shadowLg: "0 8px 32px rgba(26,18,8,0.12)",
};

// ─────────────────────────────────────────────
// GLOBAL STYLES
// ─────────────────────────────────────────────
const GlobalStyle = () => (
  <style>{`
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: ${C.cream}; font-family: 'Segoe UI', system-ui, sans-serif; }
    .ht-badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; letter-spacing: 0.3px; text-transform: uppercase; }
    .badge-pending { background: #FFF3CD; color: #856404; }
    .badge-preparing { background: ${C.saffronLight}; color: ${C.saffron}; }
    .badge-ready { background: #E3F2FD; color: #0D47A1; }
    .badge-dispatched { background: ${C.greenLight}; color: ${C.green}; }
    .badge-delivered { background: #E8F5E9; color: #2E7D32; }
    .badge-rejected { background: ${C.redLight}; color: ${C.red}; }
    .ht-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; border: none; transition: all 0.18s; letter-spacing: 0.2px; }
    .btn-primary { background: ${C.saffron}; color: ${C.white}; }
    .btn-primary:hover { background: #d4661a; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(232,120,26,0.35); }
    .btn-secondary { background: ${C.white}; color: ${C.ink}; border: 1.5px solid ${C.border}; }
    .btn-secondary:hover { border-color: ${C.saffron}; color: ${C.saffron}; }
    .btn-green { background: ${C.green}; color: ${C.white}; }
    .btn-green:hover { background: #1f4d39; }
    .btn-danger { background: ${C.red}; color: ${C.white}; }
    .btn-danger:hover { background: #a32323; }
    .btn-sm { padding: 6px 14px; font-size: 12px; }
    .btn-lg { padding: 14px 28px; font-size: 16px; border-radius: 10px; }
    .btn-full { width: 100%; }
    .btn-ghost { background: transparent; color: ${C.inkMid}; }
    .btn-ghost:hover { background: ${C.saffronLight}; color: ${C.saffron}; }
    .ht-card { background: ${C.white}; border-radius: 14px; border: 1px solid ${C.border}; box-shadow: ${C.shadow}; }
    .ht-input { width: 100%; padding: 10px 14px; border: 1.5px solid ${C.border}; border-radius: 8px; font-size: 14px; color: ${C.ink}; background: ${C.white}; outline: none; transition: border-color 0.15s; }
    .ht-input:focus { border-color: ${C.saffron}; }
    .ht-select { width: 100%; padding: 10px 14px; border: 1.5px solid ${C.border}; border-radius: 8px; font-size: 14px; color: ${C.ink}; background: ${C.white}; outline: none; transition: border-color 0.15s; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%235C4A2A' d='M1 1l5 5 5-5'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 12px center; padding-right: 36px; cursor: pointer; }
    .ht-select:focus { border-color: ${C.saffron}; }
    .pulse-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; animation: pulse-anim 1.5s infinite; }
    @keyframes pulse-anim { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:0.5; transform:scale(0.8); } }
    .slide-in { animation: slideIn 0.3s ease; }
    @keyframes slideIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
    .modal-backdrop { position: fixed; inset: 0; background: rgba(26,18,8,0.55); z-index: 500; display: flex; align-items: flex-end; justify-content: center; animation: fadeIn 0.2s ease; }
    @keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
    .modal-sheet { background: ${C.white}; border-radius: 20px 20px 0 0; width: 100%; max-width: 520px; padding: 28px 24px 36px; animation: slideUp 0.28s ease; max-height: 92vh; overflow-y: auto; }
    @keyframes slideUp { from { transform: translateY(60px); opacity:0; } to { transform: translateY(0); opacity:1; } }
    .order-track-step { display: flex; align-items: center; gap: 12px; padding: 10px 0; }
    .track-circle { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; }
    .track-line { width: 2px; height: 20px; margin-left: 15px; }
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: ${C.cream}; }
    ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
  `}</style>
);

// ─────────────────────────────────────────────
// CUSTOMER DETAILS POPUP (bottom sheet)
// ─────────────────────────────────────────────
function CustomerDetailsModal({ cart, menuItems, cartTotal, cartCount, specialInstructions, promoCodes = [], referralConfig, customers = [], onConfirm, onClose }) {
  const [form, setForm] = useState({ name: "", phone: "", tower: "", flat: "" });
  const [errors, setErrors] = useState({});
  const [promoText, setPromoText] = useState("");
  // Live-resolved promo/referral result; recomputed whenever inputs change.
  // ok:true + discount==0 (no code entered) is the neutral state.
  const promoResult = resolvePromoOrReferral({
    codeText: promoText,
    promoCodes,
    referralConfig,
    customers,
    phone: form.phone.trim(),
    cartTotal,
  });
  const discount = promoResult.ok ? promoResult.discount : 0;
  const finalTotal = Math.max(0, cartTotal - discount);

  const validate = () => {
    const e = {};
    if (!form.name.trim()) e.name = "Required";
    if (!form.phone.trim() || !/^\d{10}$/.test(form.phone.trim())) e.phone = "Enter a valid 10-digit number";
    if (!form.tower) e.tower = "Select your tower";
    if (!form.flat.trim()) e.flat = "Required";
    // If a code was entered, it must resolve successfully
    if (promoText.trim() && !promoResult.ok) e.promo = promoResult.error || "Invalid code";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleConfirm = () => {
    if (!validate()) return;
    const orderItems = Object.entries(cart).map(([id, qty]) => {
      const item = menuItems.find(i => i.id === id);
      return { id, name: item.name, price: item.price, qty };
    });
    const order = {
      id: genId(),
      customerName: form.name.trim(),
      phone: form.phone.trim(),
      tower: form.tower,
      flat: form.flat.trim(),
      items: orderItems,
      total: finalTotal,
      originalTotal: cartTotal,
      discount,
      specialInstructions: (specialInstructions || "").trim(),
      status: "pending",
      date: todayStr(),
      createdAt: new Date().toISOString(),
    };
    if (promoResult.ok && discount > 0) {
      if (promoResult.kind === "promo") {
        order.promoCode = promoResult.promoCode;
        order.promoLabel = promoResult.description || promoResult.promoCode;
      } else if (promoResult.kind === "referral") {
        order.referralCode = promoText.trim().toUpperCase();
        order.referrerPhone = promoResult.referrerPhone;
        order.referrerName = promoResult.referrerName;
        order.referrerRewardPending = true; // paid out on delivery in handleAdvanceOrder
      }
    }
    onConfirm(order);
  };

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-sheet">
        {/* Handle */}
        <div style={{ width: 40, height: 4, borderRadius: 2, background: C.border, margin: "0 auto 20px" }} />

        <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink, marginBottom: 4 }}>Almost there!</h2>
        <p style={{ fontSize: 13, color: C.inkMid, marginBottom: 20 }}>Tell us where to deliver your order</p>

        {/* Order summary mini */}
        <div style={{ background: C.saffronLight, borderRadius: 10, padding: "10px 14px", marginBottom: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 13, color: C.inkMid }}>{cartCount} item{cartCount > 1 ? "s" : ""} in cart</span>
          <span style={{ fontSize: 16, fontWeight: 800, color: C.saffron }}>₹{cartTotal}</span>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          {/* Name */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Full Name</label>
            <input
              className="ht-input"
              placeholder="Your name"
              value={form.name}
              onChange={e => { setForm(p => ({ ...p, name: e.target.value })); setErrors(p => ({ ...p, name: "" })); }}
              style={errors.name ? { borderColor: C.red } : {}}
            />
            {errors.name && <p style={{ fontSize: 11, color: C.red, marginTop: 3 }}>{errors.name}</p>}
          </div>

          {/* Phone */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Phone Number</label>
            <input
              className="ht-input"
              placeholder="10-digit mobile number"
              type="tel"
              maxLength={10}
              value={form.phone}
              onChange={e => { setForm(p => ({ ...p, phone: e.target.value })); setErrors(p => ({ ...p, phone: "" })); }}
              style={errors.phone ? { borderColor: C.red } : {}}
            />
            {errors.phone && <p style={{ fontSize: 11, color: C.red, marginTop: 3 }}>{errors.phone}</p>}
          </div>

          {/* Tower + Flat */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Tower</label>
              <select
                className="ht-select"
                value={form.tower}
                onChange={e => { setForm(p => ({ ...p, tower: e.target.value })); setErrors(p => ({ ...p, tower: "" })); }}
                style={errors.tower ? { borderColor: C.red } : {}}
              >
                <option value="">Select Tower</option>
                {TOWERS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              {errors.tower && <p style={{ fontSize: 11, color: C.red, marginTop: 3 }}>{errors.tower}</p>}
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Flat No.</label>
              <input
                className="ht-input"
                placeholder="e.g. 402"
                value={form.flat}
                onChange={e => { setForm(p => ({ ...p, flat: e.target.value })); setErrors(p => ({ ...p, flat: "" })); }}
                style={errors.flat ? { borderColor: C.red } : {}}
              />
              {errors.flat && <p style={{ fontSize: 11, color: C.red, marginTop: 3 }}>{errors.flat}</p>}
            </div>
          </div>
        </div>

        {/* Promo / Referral code */}
        <div style={{ marginTop: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>
            Promo or referral code <span style={{ color: C.inkLight, fontWeight: 400 }}>(optional)</span>
          </label>
          <input
            className="ht-input"
            placeholder="e.g. WELCOME10 or HT12345"
            value={promoText}
            onChange={e => { setPromoText(e.target.value.toUpperCase()); setErrors(p => ({ ...p, promo: "" })); }}
            style={{ textTransform: "uppercase", ...(errors.promo ? { borderColor: C.red } : {}) }}
          />
          {promoText.trim() && promoResult.ok && discount > 0 && (
            <p style={{ fontSize: 12, color: "#2E7D32", marginTop: 4, fontWeight: 600 }}>
              ✓ {promoResult.description || "Code applied"} — you save ₹{discount}
            </p>
          )}
          {promoText.trim() && !promoResult.ok && (
            <p style={{ fontSize: 11, color: C.red, marginTop: 3 }}>{promoResult.error || "Invalid code"}</p>
          )}
          {errors.promo && !promoText.trim() && (
            <p style={{ fontSize: 11, color: C.red, marginTop: 3 }}>{errors.promo}</p>
          )}
        </div>

        {/* Price summary with discount */}
        {discount > 0 && (
          <div style={{ marginTop: 14, padding: "10px 14px", background: "#F1F8E9", borderRadius: 10, border: "1px solid #C5E1A5" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.inkMid, marginBottom: 2 }}>
              <span>Subtotal</span><span>₹{cartTotal}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#2E7D32", marginBottom: 4 }}>
              <span>Discount</span><span>−₹{discount}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, fontWeight: 800, color: C.ink }}>
              <span>You pay</span><span>₹{finalTotal}</span>
            </div>
          </div>
        )}

        <button className="ht-btn btn-primary btn-full btn-lg" style={{ marginTop: 24 }} onClick={handleConfirm}>
          ✓ Confirm Order · ₹{finalTotal}
        </button>
        <button className="ht-btn btn-ghost btn-full btn-sm" style={{ marginTop: 8 }} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// CONTACT US MODAL (customer)
// ─────────────────────────────────────────────
function ContactUsModal({ contactInfo, onSubmitMessage, onClose }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");

  // Sanitise a raw phone/whatsapp number into a wa.me / tel: friendly form.
  const digits = (s) => (s || "").replace(/[^0-9]/g, "");
  const waNumber = digits(contactInfo?.whatsapp || contactInfo?.phone || "");
  const telNumber = (contactInfo?.phone || "").trim();
  const emailAddr = (contactInfo?.email || "").trim();

  const hasAny = !!(telNumber || waNumber || emailAddr);

  const handleSend = async () => {
    setErr("");
    if (!name.trim())    { setErr("Please enter your name"); return; }
    if (!message.trim()) { setErr("Please write a message"); return; }
    setSending(true);
    try {
      await onSubmitMessage({ name, phone, message });
      setSent(true);
      setTimeout(() => { setName(""); setPhone(""); setMessage(""); setSent(false); onClose(); }, 1600);
    } catch (e) {
      setErr("Couldn't send. Please try again.");
    } finally {
      setSending(false);
    }
  };

  const ChannelButton = ({ href, icon, label, sub }) => (
    <a
      href={href}
      target={href.startsWith("http") ? "_blank" : undefined}
      rel="noopener noreferrer"
      style={{
        display: "flex", alignItems: "center", gap: 12, padding: "12px 14px",
        background: C.saffronLight, borderRadius: 10, textDecoration: "none",
        marginBottom: 8, color: C.ink,
      }}
    >
      <span style={{ fontSize: 22, width: 32, textAlign: "center" }}>{icon}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>{label}</div>
        <div style={{ fontSize: 12, color: C.inkMid }}>{sub}</div>
      </div>
      <span style={{ color: C.saffron, fontWeight: 700 }}>→</span>
    </a>
  );

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-sheet">
        <div style={{ width: 40, height: 4, borderRadius: 2, background: C.border, margin: "0 auto 20px" }} />
        <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink, marginBottom: 4 }}>Contact Us</h2>
        <p style={{ fontSize: 13, color: C.inkMid, marginBottom: 18 }}>We'd love to hear from you</p>

        {hasAny && (
          <div style={{ marginBottom: 16 }}>
            {telNumber && (
              <ChannelButton href={`tel:${telNumber}`} icon="📞" label="Call us" sub={telNumber} />
            )}
            {waNumber && (
              <ChannelButton href={`https://wa.me/${waNumber.length === 10 ? "91" + waNumber : waNumber}`} icon="💬" label="WhatsApp" sub={contactInfo.whatsapp || contactInfo.phone} />
            )}
            {emailAddr && (
              <ChannelButton href={`mailto:${emailAddr}`} icon="✉️" label="Email" sub={emailAddr} />
            )}
          </div>
        )}

        <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 16, marginBottom: 8 }}>
          <h3 style={{ fontSize: 14, fontWeight: 800, color: C.ink, marginBottom: 4 }}>Send us a message</h3>
          <p style={{ fontSize: 12, color: C.inkMid, marginBottom: 12 }}>Feedback, complaints, or questions — we'll get back to you</p>

          <div style={{ display: "grid", gap: 10, marginBottom: 10 }}>
            <input
              className="ht-input"
              placeholder="Your name"
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={60}
            />
            <input
              className="ht-input"
              placeholder="Phone (optional)"
              value={phone}
              onChange={e => setPhone(e.target.value.replace(/[^0-9+ ]/g, ""))}
              maxLength={20}
              inputMode="tel"
            />
            <textarea
              className="ht-input"
              placeholder="Your message"
              value={message}
              onChange={e => setMessage(e.target.value)}
              rows={4}
              maxLength={600}
              style={{ resize: "vertical", minHeight: 90 }}
            />
          </div>

          {err && <div style={{ background: C.redLight, color: C.red, padding: "8px 10px", borderRadius: 6, fontSize: 12, marginBottom: 10 }}>{err}</div>}

          <button
            className={`ht-btn ${sent ? "btn-green" : "btn-primary"} btn-full btn-lg`}
            onClick={handleSend}
            disabled={sending || sent}
          >
            {sent ? "✓ Message sent!" : sending ? "Sending…" : "Send Message"}
          </button>
        </div>

        <button className="ht-btn btn-ghost btn-full btn-sm" style={{ marginTop: 8 }} onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// PHOTO PREVIEW MODAL (customer) — full-screen lightbox for plan images
// ─────────────────────────────────────────────
function PhotoPreviewModal({ src, label, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.88)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 300, padding: 20, cursor: "zoom-out",
      }}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        style={{
          position: "absolute", top: 16, right: 16, width: 40, height: 40, borderRadius: "50%",
          background: "rgba(255,255,255,0.15)", color: C.white, border: "none",
          fontSize: 22, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
        }}
        aria-label="Close"
      >×</button>
      <div style={{ maxWidth: "95vw", maxHeight: "85vh", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }} onClick={(e) => e.stopPropagation()}>
        <img
          src={src}
          alt={label}
          style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain", borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,0.4)" }}
        />
        {label && <div style={{ color: C.white, fontSize: 14, fontWeight: 700, opacity: 0.9 }}>{label}</div>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// PLAN CHOICE MODAL (customer) — Homely Gold / Mini customization
// ─────────────────────────────────────────────
function PlanChoiceModal({ plan, planConfig, onAdd, onClose }) {
  const sabjis = planConfig.sabjis;
  const nonPremium = sabjis.filter(s => !s.premium).slice(0, 2);
  const isGold = plan === "gold";
  const isStandard = plan === "standard";
  const isMini = plan === "mini";
  const [bread, setBread] = useState(BREAD_CHOICES[0].id);
  const [sabjiSel, setSabjiSel] = useState([]); // Gold: up to 2 sabji ids
  const [sweetOrRaita, setSweetOrRaita] = useState("raita");
  const [miniSabji, setMiniSabji] = useState(nonPremium[0]?.id || "");
  const [standardBase, setStandardBase] = useState("rice"); // "rice" | "chapati"
  const [miniBase, setMiniBase] = useState("chapati"); // "chapati" | "rice"

  // ── Homely Gold flow: two steps ──
  // Step 1 "build": pick bread + sabjis + raita/sweet (no size yet)
  // Step 2 "size":  pick Medium (Disposable Thali) or Large (300ml container)
  // Only offer a size the owner has enabled for today.
  const goldMediumOn = planConfig.enabled?.goldMedium !== false;
  const goldLargeOn = planConfig.enabled?.goldLarge !== false;
  const [goldStep, setGoldStep] = useState("build");
  const [goldSize, setGoldSize] = useState(goldMediumOn ? "medium" : "large");
  const goldLargeSurcharge = planConfig.prices.goldLargeSurcharge || 0;
  const goldPrice = planConfig.prices.gold + (goldSize === "large" ? goldLargeSurcharge : 0);

  const toggleSabji = (id) => {
    setSabjiSel(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length >= 2) return prev;
      return [...prev, id];
    });
  };

  const goldValid = sabjiSel.length === 2;
  const miniValid = !!miniSabji;

  const handleAdd = () => {
    if (isGold) {
      if (!goldValid) return;
      const breadLabel = BREAD_CHOICES.find(b => b.id === bread).label;
      const chosenSabjis = sabjis.filter(s => sabjiSel.includes(s.id));
      const sweetRaitaLabel = sweetOrRaita === "raita" ? planConfig.raita : planConfig.sweet;
      const sizeLabel = goldSize === "large" ? "Large" : "Medium";
      const id = `gold:${goldSize}:${bread}:${sabjiSel.slice().sort().join("+")}:${sweetOrRaita}`;
      const name = `Homely Gold (${sizeLabel}) — ${breadLabel}, ${chosenSabjis.map(s => s.name).join(" + ")}, ${planConfig.rice}, ${sweetRaitaLabel}, ${planConfig.salad}`;
      onAdd(id, name, goldPrice);
    } else if (isStandard) {
      // Standard is fixed except for a rice ↔ 2 extra chapati swap; price is unchanged.
      const id = standardBase === "chapati" ? "plan-standard:chapati" : "plan-standard";
      const name = standardBase === "chapati"
        ? `Homely Standard (2 chapatis extra) — 6 Chapati, ${nonPremium[0].name} + ${nonPremium[1].name}, Standard Salad`
        : `Homely Standard — 4 Chapati, ${nonPremium[0].name} + ${nonPremium[1].name}, Steamed Rice, Standard Salad`;
      onAdd(id, name, planConfig.prices.standard);
    } else if (isMini) {
      if (!miniValid) return;
      const sabji = nonPremium.find(s => s.id === miniSabji);
      const id = miniBase === "rice" ? `mini:${miniSabji}:rice` : `mini:${miniSabji}`;
      const name = miniBase === "rice"
        ? `Homely Mini (Rice) — Steamed Rice, ${sabji.name}, Standard Salad`
        : `Homely Mini — 4 Chapati, ${sabji.name}, Standard Salad`;
      onAdd(id, name, planConfig.prices.mini);
    }
  };

  const title = isGold ? "✨ Homely Gold" : isStandard ? "Homely Standard" : "Homely Mini";
  const subtitle = isStandard
    ? "This is what's included — just confirm"
    : isGold
    ? (goldStep === "build" ? "Step 1 of 2 · Build your tiffin" : "Step 2 of 2 · Choose container size")
    : "Customize your thali";

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-sheet">
        <div style={{ width: 40, height: 4, borderRadius: 2, background: C.border, margin: "0 auto 20px" }} />
        <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink, marginBottom: 4 }}>{title}</h2>
        <p style={{ fontSize: 13, color: C.inkMid, marginBottom: 18 }}>{subtitle}</p>

        {isGold && goldStep === "build" && (
          <>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: C.ink, display: "block", marginBottom: 8 }}>Choose Bread</label>
              {BREAD_CHOICES.map(b => (
                <label key={b.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", fontSize: 14, color: C.ink, cursor: "pointer" }}>
                  <input type="radio" name="bread" checked={bread === b.id} onChange={() => setBread(b.id)} style={{ accentColor: C.saffron, width: 16, height: 16 }} />
                  {b.label}
                </label>
              ))}
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: C.ink, display: "block", marginBottom: 8 }}>
                Choose 2 Sabjis <span style={{ color: sabjiSel.length === 2 ? "#2E7D32" : C.inkLight, fontWeight: 700 }}>({sabjiSel.length}/2 selected)</span>
              </label>
              {sabjis.map(s => {
                const disabled = !sabjiSel.includes(s.id) && sabjiSel.length >= 2;
                return (
                  <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", fontSize: 14, color: C.ink, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1 }}>
                    <input
                      type="checkbox"
                      checked={sabjiSel.includes(s.id)}
                      disabled={disabled}
                      onChange={() => toggleSabji(s.id)}
                      style={{ accentColor: C.saffron, width: 16, height: 16 }}
                    />
                    {s.name} {s.premium && <span style={{ fontSize: 11, color: C.saffron, fontWeight: 700 }}>⭐ Premium</span>}
                  </label>
                );
              })}
              {sabjiSel.length < 2 && (
                <div style={{ fontSize: 12, color: C.red, marginTop: 6, fontWeight: 600 }}>
                  ⚠️ Please choose {2 - sabjiSel.length} more sabji{2 - sabjiSel.length > 1 ? "s" : ""} to continue
                </div>
              )}
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: C.ink, display: "block", marginBottom: 8 }}>Choose Raita or Sweet</label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", fontSize: 14, color: C.ink, cursor: "pointer" }}>
                <input type="radio" name="sr" checked={sweetOrRaita === "raita"} onChange={() => setSweetOrRaita("raita")} style={{ accentColor: C.saffron, width: 16, height: 16 }} />
                {planConfig.raita} (Raita)
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", fontSize: 14, color: C.ink, cursor: "pointer" }}>
                <input type="radio" name="sr" checked={sweetOrRaita === "sweet"} onChange={() => setSweetOrRaita("sweet")} style={{ accentColor: C.saffron, width: 16, height: 16 }} />
                {planConfig.sweet} (Sweet)
              </label>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: C.ink, display: "block", marginBottom: 8 }}>Rice for the Day</label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", fontSize: 14, color: C.ink, cursor: "default" }}>
                <input type="radio" checked readOnly style={{ accentColor: C.saffron, width: 16, height: 16 }} />
                {planConfig.rice}
              </label>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: C.ink, display: "block", marginBottom: 8 }}>Salad for the Day</label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", fontSize: 14, color: C.ink, cursor: "default" }}>
                <input type="radio" checked readOnly style={{ accentColor: C.saffron, width: 16, height: 16 }} />
                {planConfig.salad}
              </label>
            </div>
          </>
        )}

        {isGold && goldStep === "size" && (
          <>
            <div style={{ marginBottom: 16, padding: "10px 12px", background: C.cream, borderRadius: 10, fontSize: 12, color: C.inkMid, lineHeight: 1.5 }}>
              ✓ Your tiffin is built — now pick a container size.
            </div>
            <div style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: C.ink, display: "block", marginBottom: 10 }}>Choose Size</label>
              {goldMediumOn && (
                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 12px", marginBottom: 8, fontSize: 14, color: C.ink, cursor: "pointer", border: `2px solid ${goldSize === "medium" ? C.saffron : C.border}`, borderRadius: 10, background: goldSize === "medium" ? "#FFF6EC" : C.white }}>
                  <input type="radio" name="goldSize" checked={goldSize === "medium"} onChange={() => setGoldSize("medium")} style={{ accentColor: C.saffron, width: 16, height: 16, marginTop: 2 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700 }}>Medium</div>
                    <div style={{ fontSize: 12, color: C.inkMid, marginTop: 2 }}>Served in Disposable Thali</div>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: C.saffron }}>₹{planConfig.prices.gold}</div>
                </label>
              )}
              {goldLargeOn && (
                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 12px", marginBottom: 8, fontSize: 14, color: C.ink, cursor: "pointer", border: `2px solid ${goldSize === "large" ? C.saffron : C.border}`, borderRadius: 10, background: goldSize === "large" ? "#FFF6EC" : C.white }}>
                  <input type="radio" name="goldSize" checked={goldSize === "large"} onChange={() => setGoldSize("large")} style={{ accentColor: C.saffron, width: 16, height: 16, marginTop: 2 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700 }}>Large</div>
                    <div style={{ fontSize: 12, color: C.inkMid, marginTop: 2 }}>300 ml container</div>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: C.saffron }}>₹{planConfig.prices.gold + goldLargeSurcharge}</div>
                </label>
              )}
            </div>
            <button className="ht-btn btn-ghost btn-sm" style={{ marginBottom: 8 }} onClick={() => setGoldStep("build")}>← Edit tiffin</button>
          </>
        )}

        {isStandard && (
          <>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: C.ink, display: "block", marginBottom: 8 }}>Sabjis (Fixed)</label>
              {nonPremium.map(s => (
                <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", fontSize: 14, color: C.ink, cursor: "default" }}>
                  <input type="checkbox" checked readOnly style={{ accentColor: C.saffron, width: 16, height: 16 }} />
                  {s.name}
                </label>
              ))}
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: C.ink, display: "block", marginBottom: 8 }}>Bread</label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", fontSize: 14, color: C.ink, cursor: "default" }}>
                <input type="radio" checked readOnly style={{ accentColor: C.saffron, width: 16, height: 16 }} />
                4 Chapatis
              </label>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: C.ink, display: "block", marginBottom: 8 }}>Rice</label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", marginBottom: 8, fontSize: 14, color: C.ink, cursor: "pointer", border: `2px solid ${standardBase === "rice" ? C.saffron : C.border}`, borderRadius: 10, background: standardBase === "rice" ? "#FFF6EC" : C.white }}>
                <input type="radio" name="standardBase" checked={standardBase === "rice"} onChange={() => setStandardBase("rice")} style={{ accentColor: C.saffron, width: 16, height: 16, marginTop: 2 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700 }}>Steamed rice</div>
                  <div style={{ fontSize: 12, color: C.inkMid, marginTop: 2 }}>Default</div>
                </div>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", fontSize: 14, color: C.ink, cursor: "pointer", border: `2px solid ${standardBase === "chapati" ? C.saffron : C.border}`, borderRadius: 10, background: standardBase === "chapati" ? "#FFF6EC" : C.white }}>
                <input type="radio" name="standardBase" checked={standardBase === "chapati"} onChange={() => setStandardBase("chapati")} style={{ accentColor: C.saffron, width: 16, height: 16, marginTop: 2 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700 }}>2 extra chapatis</div>
                  <div style={{ fontSize: 12, color: C.inkMid, marginTop: 2 }}>Swap rice for chapatis · 6 chapatis total</div>
                </div>
              </label>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: C.ink, display: "block", marginBottom: 8 }}>Salad</label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", fontSize: 14, color: C.ink, cursor: "default" }}>
                <input type="radio" checked readOnly style={{ accentColor: C.saffron, width: 16, height: 16 }} />
                Standard Salad
              </label>
            </div>
          </>
        )}

        {isMini && (
          <>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: C.ink, display: "block", marginBottom: 8 }}>
                Choose 1 Sabji <span style={{ color: miniValid ? "#2E7D32" : C.inkLight, fontWeight: 700 }}>({miniValid ? "1/1 selected" : "0/1 selected"})</span>
              </label>
              {nonPremium.map(s => (
                <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", fontSize: 14, color: C.ink, cursor: "pointer" }}>
                  <input type="radio" name="miniSabji" checked={miniSabji === s.id} onChange={() => setMiniSabji(s.id)} style={{ accentColor: C.saffron, width: 16, height: 16 }} />
                  {s.name}
                </label>
              ))}
              {!miniValid && (
                <div style={{ marginTop: 8, padding: "8px 10px", background: "#FDECEA", color: "#B71C1C", borderRadius: 8, fontSize: 12, fontWeight: 600 }}>
                  ⚠️ Please choose a sabji to continue
                </div>
              )}
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: C.ink, display: "block", marginBottom: 8 }}>Choose your base</label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", marginBottom: 8, fontSize: 14, color: C.ink, cursor: "pointer", border: `2px solid ${miniBase === "chapati" ? C.saffron : C.border}`, borderRadius: 10, background: miniBase === "chapati" ? "#FFF6EC" : C.white }}>
                <input type="radio" name="miniBase" checked={miniBase === "chapati"} onChange={() => setMiniBase("chapati")} style={{ accentColor: C.saffron, width: 16, height: 16, marginTop: 2 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700 }}>4 chapatis</div>
                  <div style={{ fontSize: 12, color: C.inkMid, marginTop: 2 }}>Default</div>
                </div>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", fontSize: 14, color: C.ink, cursor: "pointer", border: `2px solid ${miniBase === "rice" ? C.saffron : C.border}`, borderRadius: 10, background: miniBase === "rice" ? "#FFF6EC" : C.white }}>
                <input type="radio" name="miniBase" checked={miniBase === "rice"} onChange={() => setMiniBase("rice")} style={{ accentColor: C.saffron, width: 16, height: 16, marginTop: 2 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700 }}>Steamed rice</div>
                  <div style={{ fontSize: 12, color: C.inkMid, marginTop: 2 }}>Swap chapatis for rice</div>
                </div>
              </label>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: C.ink, display: "block", marginBottom: 8 }}>Salad</label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", fontSize: 14, color: C.ink, cursor: "default" }}>
                <input type="radio" checked readOnly style={{ accentColor: C.saffron, width: 16, height: 16 }} />
                Standard Salad
              </label>
            </div>
          </>
        )}

        <button
          className="ht-btn btn-primary btn-full btn-lg"
          disabled={isGold ? (goldStep === "build" ? !goldValid : false) : isMini ? !miniValid : false}
          onClick={() => {
            if (isGold && goldStep === "build") {
              if (!goldValid) return;
              setGoldStep("size");
              return;
            }
            handleAdd();
          }}
        >
          {isGold && goldStep === "build" && !goldValid
            ? `Choose ${2 - sabjiSel.length} more sabji${2 - sabjiSel.length > 1 ? "s" : ""} to continue`
            : isGold && goldStep === "build"
            ? "Continue → Choose Size"
            : isMini && !miniValid
            ? "Choose a sabji to continue"
            : `Add to Cart · ₹${isGold ? goldPrice : isStandard ? planConfig.prices.standard : planConfig.prices.mini}`}
        </button>
        <button className="ht-btn btn-ghost btn-full btn-sm" style={{ marginTop: 8 }} onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// INVALID PHONE POPUP (customer)
// ─────────────────────────────────────────────
function InvalidPhoneModal({ onClose }) {
  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-sheet" style={{ paddingBottom: 28 }}>
        <div style={{ textAlign: "center", padding: "8px 0 22px" }}>
          <div style={{ fontSize: 44, marginBottom: 12 }}>📭</div>
          <h3 style={{ fontSize: 17, fontWeight: 800, color: C.ink, marginBottom: 8 }}>No Order for Today</h3>
          <p style={{ fontSize: 13, color: C.inkMid, lineHeight: 1.6 }}>
            We couldn't find any order placed <strong>today</strong> with this number.<br />
            Orders from previous days are not shown here.
          </p>
        </div>
        <button className="ht-btn btn-primary btn-full" onClick={onClose}>Got it</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// ORDER TRACKER (customer view)
// ─────────────────────────────────────────────
function OrderTracker({ status }) {
  if (status === "rejected") {
    return (
      <div style={{ padding: "20px 0", textAlign: "center" }}>
        <div style={{ fontSize: 44, marginBottom: 12 }}>❌</div>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: C.red, marginBottom: 8 }}>Order Rejected</h3>
        <p style={{ fontSize: 13, color: C.inkMid, maxWidth: 280, margin: "0 auto" }}>
          Sorry, we couldn't accept this order. Please contact the owner or place a new order.
        </p>
      </div>
    );
  }

  const steps = [
    { key: "pending", label: "Order Received", icon: "📋" },
    { key: "preparing", label: "Preparing Your Tiffin", icon: "👨‍🍳" },
    { key: "ready", label: "Ready for Dispatch", icon: "📦" },
    { key: "dispatched", label: "Out for Delivery", icon: "🛵" },
    { key: "delivered", label: "Delivered!", icon: "✅" },
  ];
  const idx = steps.findIndex(s => s.key === status);

  return (
    <div style={{ padding: "16px 0" }}>
      {steps.map((step, i) => {
        const done = i < idx; const active = i === idx; const upcoming = i > idx;
        return (
          <div key={step.key}>
            <div className="order-track-step">
              <div className="track-circle" style={{ background: done ? C.green : active ? C.saffron : C.border, color: (done || active) ? C.white : C.inkLight }}>
                {done ? "✓" : step.icon}
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: upcoming ? C.inkLight : C.ink }}>{step.label}</div>
                {active && (
                  <div style={{ fontSize: 12, color: C.saffron, display: "flex", alignItems: "center", gap: 5 }}>
                    <span className="pulse-dot" style={{ background: C.saffron }} /> In progress
                  </div>
                )}
              </div>
            </div>
            {i < steps.length - 1 && <div className="track-line" style={{ background: done ? C.green : C.border }} />}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────
// RATING CARD (customer view)
// ─────────────────────────────────────────────
// Shown on customer home screen when they have a delivered order that hasn't
// been rated yet. Submit is optional — Skip hides for this session, but the
// card reappears on their next visit until they rate it.
function RatingCard({ order, onSubmit, onSkip, submitting }) {
  const [taste, setTaste] = useState(0);
  const [delivery, setDelivery] = useState(0);
  const [feedback, setFeedback] = useState("");
  const [showError, setShowError] = useState(false);

  const handleSubmit = () => {
    if (taste === 0 || delivery === 0) { setShowError(true); return; }
    onSubmit({
      taste,
      delivery,
      feedback: feedback.trim(),
      ratedAt: new Date().toISOString(),
    });
  };

  const itemsSummary = order.items.map(i => `${i.name} ×${i.qty}`).join(", ");
  const orderDate = new Date(order.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

  return (
    <div className="ht-card slide-in" style={{
      padding: 22, marginBottom: 16,
      background: "linear-gradient(135deg, #FFF8E1 0%, #FFECB3 100%)",
      border: "1.5px solid #F4A261",
    }}>
      <div style={{ textAlign: "center", marginBottom: 14 }}>
        <div style={{ fontSize: 32, marginBottom: 6 }}>⭐</div>
        <h3 style={{ fontSize: 17, fontWeight: 800, color: C.ink, marginBottom: 4 }}>How was your last meal?</h3>
        <p style={{ fontSize: 12, color: C.inkMid }}>
          Your order from <strong>{orderDate}</strong> · ₹{order.total}
        </p>
        <p style={{ fontSize: 11, color: C.inkLight, marginTop: 2, lineHeight: 1.3 }}>
          {itemsSummary}
        </p>
      </div>

      {/* Taste */}
      <div style={{ background: C.white, borderRadius: 10, padding: "12px 14px", marginBottom: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>Taste & Quality</div>
            <div style={{ fontSize: 11, color: C.inkLight }}>How was the food?</div>
          </div>
          <StarInput value={taste} onChange={v => { setTaste(v); setShowError(false); }} size={28} />
        </div>
      </div>

      {/* Delivery */}
      <div style={{ background: C.white, borderRadius: 10, padding: "12px 14px", marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>Delivery Time</div>
            <div style={{ fontSize: 11, color: C.inkLight }}>Was it on time?</div>
          </div>
          <StarInput value={delivery} onChange={v => { setDelivery(v); setShowError(false); }} size={28} />
        </div>
      </div>

      {/* Feedback */}
      <div style={{ marginBottom: 14 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 6 }}>
          📝 Tell us more <span style={{ fontWeight: 400, color: C.inkLight }}>(optional)</span>
        </label>
        <textarea
          className="ht-input"
          placeholder="What did you like? What could be better?"
          value={feedback}
          onChange={e => setFeedback(e.target.value.slice(0, 300))}
          rows={3}
          style={{ resize: "vertical", fontFamily: "inherit", lineHeight: 1.4, fontSize: 13 }}
        />
        <div style={{ fontSize: 10, color: C.inkLight, marginTop: 3, textAlign: "right" }}>
          {feedback.length}/300
        </div>
      </div>

      {showError && (
        <p style={{ fontSize: 12, color: C.red, marginBottom: 10, textAlign: "center", fontWeight: 600 }}>
          ⚠️ Please tap stars for both Taste and Delivery
        </p>
      )}

      <button
        className="ht-btn btn-primary btn-full btn-lg"
        onClick={handleSubmit}
        disabled={submitting}
        style={{ marginBottom: 8, opacity: submitting ? 0.6 : 1 }}
      >
        {submitting ? "Submitting…" : "Submit Rating"}
      </button>
      <button
        className="ht-btn btn-ghost btn-full btn-sm"
        onClick={onSkip}
        disabled={submitting}
        style={{ color: C.inkMid }}
      >
        Skip for now
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────
// POLL HELPERS
// ─────────────────────────────────────────────
// A poll is "live" only when the owner has switched it on AND it has a question.
function isPollLive(poll) {
  return !!(poll && poll.active && poll.question && poll.question.trim().length > 0);
}
// Which poll ids has THIS device already responded to / dismissed?
// Stored on-device so a customer isn't nagged repeatedly for the same poll.
function getSeenPolls() {
  try {
    const raw = window.localStorage.getItem("htSeenPolls");
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function markPollSeen(pollId) {
  if (!pollId) return;
  try {
    const seen = getSeenPolls();
    if (!seen.includes(pollId)) {
      seen.push(pollId);
      window.localStorage.setItem("htSeenPolls", JSON.stringify(seen.slice(-50)));
    }
  } catch { /* private mode — ignore */ }
}

// ─────────────────────────────────────────────
// CUSTOMER POLL POPUP (bottom sheet)
// ─────────────────────────────────────────────
// Shown once, right after an order is placed, IF a poll is live and this
// device hasn't already answered/dismissed it. Never shows any results.
function PollModal({ poll, order, onSubmit, onClose }) {
  const [choice, setChoice] = useState("");
  const [feedback, setFeedback] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const options = Array.isArray(poll.options) ? poll.options.filter(o => o && o.trim().length > 0) : [];
  const canSubmit = choice.trim().length > 0 || feedback.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit({
      id: genId(),
      pollId: poll.id,
      pollQuestion: poll.question,
      choice: choice.trim(),
      feedback: feedback.trim(),
      name: order?.customerName || "",
      phone: order?.phone || "",
      tower: order?.tower || "",
      flat: order?.flat || "",
      at: new Date().toISOString(),
    });
    markPollSeen(poll.id);
    setSubmitted(true);
  };

  const handleDismiss = () => {
    markPollSeen(poll.id); // don't re-ask on the next order either
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={submitted ? onClose : undefined}>
      <div className="modal-sheet" onClick={e => e.stopPropagation()}>
        <div style={{ width: 40, height: 4, borderRadius: 2, background: C.border, margin: "0 auto 20px" }} />

        {submitted ? (
          <div style={{ textAlign: "center", padding: "12px 0 4px" }}>
            <div style={{ fontSize: 44, marginBottom: 10 }}>🙏</div>
            <h2 style={{ fontSize: 19, fontWeight: 800, color: C.ink, marginBottom: 6 }}>Thank you!</h2>
            <p style={{ fontSize: 13, color: C.inkMid, marginBottom: 22 }}>Your feedback helps us serve you better.</p>
            <button className="ht-btn btn-primary btn-full btn-lg" onClick={onClose}>Done</button>
          </div>
        ) : (
          <>
            <div style={{ display: "inline-block", background: C.saffronLight, color: C.saffron, fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 20, marginBottom: 12 }}>
              📣 QUICK QUESTION
            </div>
            <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink, marginBottom: 4, lineHeight: 1.35 }}>{poll.question}</h2>
            <p style={{ fontSize: 12, color: C.inkLight, marginBottom: 18 }}>Takes just a few seconds — totally optional.</p>

            {options.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
                {options.map((opt, idx) => {
                  const active = choice === opt;
                  return (
                    <button
                      key={idx}
                      onClick={() => setChoice(active ? "" : opt)}
                      style={{
                        display: "flex", alignItems: "center", gap: 10,
                        textAlign: "left", width: "100%",
                        padding: "12px 14px",
                        borderRadius: 10,
                        border: `2px solid ${active ? C.saffron : C.border}`,
                        background: active ? C.saffronLight : C.white,
                        cursor: "pointer", transition: "all 0.15s",
                      }}
                    >
                      <span style={{
                        width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
                        border: `2px solid ${active ? C.saffron : C.inkLight}`,
                        background: active ? C.saffron : "transparent",
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>
                        {active && <span style={{ color: C.white, fontSize: 11, fontWeight: 900 }}>✓</span>}
                      </span>
                      <span style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>{opt}</span>
                    </button>
                  );
                })}
              </div>
            )}

            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 6 }}>
              Anything else you'd like to tell us? <span style={{ color: C.inkLight, fontWeight: 400 }}>(optional)</span>
            </label>
            <textarea
              className="ht-input"
              value={feedback}
              onChange={e => setFeedback(e.target.value.slice(0, 300))}
              placeholder="Type your feedback here…"
              rows={3}
              style={{ resize: "vertical", marginBottom: 4, fontFamily: "inherit" }}
            />
            <div style={{ fontSize: 11, color: C.inkLight, textAlign: "right", marginBottom: 18 }}>{feedback.length}/300</div>

            <button
              className="ht-btn btn-primary btn-full btn-lg"
              onClick={handleSubmit}
              disabled={!canSubmit}
              style={{ marginBottom: 8, opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? "pointer" : "not-allowed" }}
            >
              Submit Feedback
            </button>
            <button className="ht-btn btn-ghost btn-full btn-sm" onClick={handleDismiss}>
              Maybe later
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
const AUNTY_SRC = "data:image/jpeg;base64,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";
const GOLD_BANNER_SRC = "data:image/jpeg;base64,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";
const REF_SRC = "data:image/png;base64,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";

// CUSTOMER — HOME (brand landing)
// Palette + icons + styles used only by the home screen.
// Logo lives at /public/logo.png (kept out of this file to stay light).
// ─────────────────────────────────────────────
const HC = {
  orange: "#E0731A",
  orangeDeep: "#C4620F",
  strip: "#DA6A15",
  cream: "#F6EFE1",
  card: "#FCF8F0",
  peach: "#F6E6D0",
  brown: "#3B2A1A",
  brownMid: "#6E5B44",
  brownSoft: "#B8A484",
  dash: "#E6C7A2",
  ring: "#4A2C1F",
};

const CartIcon = ({ s = 22, c = "#fff" }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="21" r="1.4" /><circle cx="18" cy="21" r="1.4" />
    <path d="M1 1h3l2.2 12.4a2 2 0 0 0 2 1.6h8.6a2 2 0 0 0 2-1.6L21 6H5.5" />
  </svg>
);
const SearchIcon = ({ s = 22, c = HC.orange }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
  </svg>
);
const PhoneIcon = ({ s = 16, c = HC.brownSoft }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="7" y="2" width="10" height="20" rx="2.5" /><path d="M11 18h2" />
  </svg>
);
const BowlIcon = ({ s = 34 }) => (
  <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
    <path d="M15 6c-1 1.5-1 3 0 4.5M20 4c-1 1.8-1 3.6 0 5.4M25 6c-1 1.5-1 3 0 4.5" stroke={HC.orange} strokeWidth="1.6" strokeLinecap="round" opacity=".7" />
    <path d="M6 16h28c0 7.5-6.3 13.5-14 13.5S6 23.5 6 16Z" fill={HC.orange} />
    <path d="M4 15.5h32" stroke={HC.orangeDeep} strokeWidth="2.4" strokeLinecap="round" />
  </svg>
);
const HeartIcon = ({ s = 14, c = HC.orange, fill = "none" }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill={fill} stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z" />
  </svg>
);
const LeafIcon = ({ s = 26, c = "#fff" }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 20A7 7 0 0 1 4 13c0-5 4-9 15-9 0 8-3 16-8 16Z" /><path d="M8 17c2-4 5-6 9-7" />
  </svg>
);
const SproutIcon = ({ s = 26, c = "#fff" }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20v-8" /><path d="M12 12c0-3 2-5 5-5 0 3-2 5-5 5Z" /><path d="M12 13C12 10 10 8 7 8c0 3 2 5 5 5Z" /><path d="M6 20h12" />
  </svg>
);
const ScooterIcon = ({ s = 28, c = "#fff" }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="18" r="2.4" /><circle cx="18" cy="18" r="2.4" />
    <path d="M8.4 18h7.2M18 16V9h-2.5" /><path d="M4 9h4l2.5 7" /><path d="M8 9l1.5 4" />
  </svg>
);
// Long arrow flanking TIFFINS (points inward toward the word)
const ArrowLong = ({ flip }) => (
  <svg width="54" height="12" viewBox="0 0 54 12" fill="none" style={{ transform: flip ? "scaleX(-1)" : "none" }} aria-hidden>
    <path d="M2 6h42M38 1.5l7 4.5-7 4.5" stroke={HC.orange} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const HomeStyle = () => (
  <style>{`
    .ht2-root { font-family: 'Nunito', 'Segoe UI', system-ui, sans-serif; background: ${HC.cream};
      min-height: 100vh; color: ${HC.brown}; position: relative; overflow-x: hidden; }
    .ht2-strip { height: 7px; background: ${HC.strip}; }
    .ht2-sketch { position: absolute; top: 60px; right: -20px; width: 300px; opacity: .10; pointer-events: none; }
    .ht2-paisley { position: absolute; bottom: 150px; left: -30px; width: 240px; opacity: .09; pointer-events: none; }
    .ht2-hero { max-width: 620px; margin: 0 auto; padding: 40px 20px 8px; text-align: center; position: relative; z-index: 2; }

    .ht2-brand { position: relative; display: inline-block; }
    .ht2-logo { display: block; width: 120px; height: 120px; margin: 0 auto 14px;
      border-radius: 50%; border: 2px solid ${HC.ring}; }
    .ht2-word { font-family: 'Playfair Display', Georgia, serif; font-weight: 700; color: ${HC.brown};
      font-size: 48px; letter-spacing: 6px; line-height: 1; }
    .ht2-sub { font-family: 'Playfair Display', Georgia, serif; font-weight: 600; color: ${HC.orangeDeep};
      font-size: 21px; letter-spacing: 10px; margin-top: 8px; display: flex; align-items: center; justify-content: center; gap: 16px; }
    .ht2-tag { font-family: 'Dancing Script', cursive; font-weight: 700; color: ${HC.orange}; font-size: 32px; margin-top: 12px; }
    .ht2-heart-row { margin: 4px 0 12px; display: flex; justify-content: center; }
    .ht2-lead { color: ${HC.brown}; font-size: 17px; font-weight: 700; }

    .ht2-rating { max-width: 440px; margin: 24px auto 0; text-align: left; }

    .ht2-menu { margin: 26px auto 0; max-width: 440px; background: ${HC.card};
      border: 2px dashed ${HC.dash}; border-radius: 18px; padding: 26px 24px; }
    .ht2-menu.closed { border-color: #E6B3B0; background: #FBF1F0; }
    .ht2-menu h2 { font-family: 'Playfair Display', Georgia, serif; font-size: 24px; color: ${HC.brown}; margin: 8px 0 4px; }
    .ht2-menu .avail { color: ${HC.brownMid}; font-size: 14px; font-weight: 600; }
    .ht2-divider { display: flex; align-items: center; justify-content: center; gap: 8px; margin: 16px 0; color: ${HC.orange}; }
    .ht2-cta { width: 100%; border: none; cursor: pointer; background: ${HC.orange}; color: #fff;
      font-family: inherit; font-weight: 800; font-size: 18px; letter-spacing: .3px; padding: 16px; border-radius: 12px;
      display: flex; align-items: center; justify-content: center; gap: 10px;
      box-shadow: 0 6px 16px rgba(224,115,26,.32); transition: transform .16s, box-shadow .16s, background .16s; }
    .ht2-cta:hover { background: ${HC.orangeDeep}; transform: translateY(-2px); box-shadow: 0 10px 22px rgba(196,98,15,.38); }
    .ht2-cta:active { transform: translateY(0); }

    .ht2-track { margin: 18px auto 0; max-width: 500px; background: ${HC.peach}; border-radius: 18px;
      padding: 18px 20px; display: flex; align-items: flex-start; gap: 14px; text-align: left; }
    .ht2-track-ic { flex-shrink: 0; width: 52px; height: 52px; border-radius: 50%; background: ${HC.card};
      display: flex; align-items: center; justify-content: center; box-shadow: 0 3px 8px rgba(59,42,26,.08); }
    .ht2-track h3 { font-family: 'Playfair Display', Georgia, serif; font-size: 19px; color: ${HC.brown}; margin-bottom: 10px; }
    .ht2-track-input { display: flex; gap: 8px; }
    .ht2-field { flex: 1; display: flex; align-items: center; gap: 8px; background: #fff; border-radius: 10px;
      border: 1.5px solid #EAD8C0; padding: 0 12px; }
    .ht2-field input { flex: 1; border: none; outline: none; background: transparent; padding: 12px 0;
      font-family: inherit; font-size: 15px; color: ${HC.brown}; }
    .ht2-field input::placeholder { color: ${HC.brownSoft}; }
    .ht2-trackbtn { border: none; cursor: pointer; background: ${HC.orange}; color: #fff; font-weight: 800;
      font-family: inherit; font-size: 15px; padding: 0 22px; border-radius: 10px; transition: background .16s; }
    .ht2-trackbtn:hover { background: ${HC.orangeDeep}; }

    .ht2-owner { margin: 26px 0 8px; }
    .ht2-owner a { font-size: 11px; color: ${HC.brownSoft}; text-decoration: none; opacity: .7; }
    .ht2-owner a:hover { opacity: 1; }

    .ht2-wavewrap { margin-top: 26px; line-height: 0; }
    .ht2-footer { background: ${HC.orange}; padding: 8px 20px 30px; }
    .ht2-feat { max-width: 720px; margin: 0 auto; display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; }
    .ht2-feat-item { display: flex; align-items: center; gap: 10px; justify-content: center; }
    .ht2-feat-item .txt { color: #fff; font-size: 13px; font-weight: 800; line-height: 1.2; }
    .ht2-feat-item .txt span { display: block; }

    @media (max-width: 560px) {
      .ht2-word { font-size: 36px; letter-spacing: 4px; }
      .ht2-sub { font-size: 16px; letter-spacing: 6px; gap: 10px; }
      .ht2-sub svg { width: 36px; }
      .ht2-tag { font-size: 27px; }
      .ht2-lead { font-size: 15px; }
      .ht2-logo { width: 96px; height: 96px; }
      .ht2-track { flex-direction: column; align-items: stretch; }
      .ht2-track-ic { display: none; }
      .ht2-feat { grid-template-columns: repeat(2, 1fr); gap: 16px 12px; }
      .ht2-sketch, .ht2-paisley { display: none; }
    }
    @media (prefers-reduced-motion: reduce) { .ht2-cta { transition: none; } }
  `}</style>
);

// ─────────────────────────────────────────────
// CUSTOMER APP
// ─────────────────────────────────────────────
function CustomerApp({ menu, planConfig, contactInfo, orders, ordersHistory = [], kitchenOpen, poll, promoCodes = [], referralConfig, customers = [], onPlaceOrder, onSubmitRating, onSubmitPollResponse, onSubmitContactMessage, onOwnerAccess }) {
  const [step, setStep] = useState("home");
  const [showContact, setShowContact] = useState(false);
  const [isDesktop, setIsDesktop] = useState(typeof window !== "undefined" && window.innerWidth >= 768);
  useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth >= 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const [cart, setCart] = useState({});
  // Metadata for configured Homely Gold / Mini cart lines (id -> { name, price }).
  // Regular menu items and the fixed Standard / Extras lines don't need this —
  // their name/price is derived fresh from menu / planConfig every render.
  const [planCartMeta, setPlanCartMeta] = useState({});
  const [planChoiceModal, setPlanChoiceModal] = useState(null); // "gold" | "standard" | "mini" | null
  const [photoPreview, setPhotoPreview] = useState(null); // { src, label } | null — full-screen image viewer
  const [specialInstructions, setSpecialInstructions] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [showInvalidPhone, setShowInvalidPhone] = useState(false);
  const [activeOrder, setActiveOrder] = useState(null);
  // Ticking clock so "stuck pending order" banners update live without a refresh
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);
  const [lookupPhone, setLookupPhone] = useState("");

  // ── Rating state ──
  // rememberedPhone: read from localStorage on mount; identifies returning customer
  // ratingCardDismissed: session-only flag; goes true on either Submit OR Skip.
  //   Hides the card for the rest of this browser session; reappears on next
  //   page load if there's still an unrated order.
  // ratingSubmitting: shows loading state on submit button
  const [rememberedPhone, setRememberedPhone] = useState("");
  const [ratingCardDismissed, setRatingCardDismissed] = useState(false);
  const [ratingSubmitting, setRatingSubmitting] = useState(false);
  // Rating popup: shown after "Order Now" is tapped, before moving to the order page.
  const [showRatingModal, setShowRatingModal] = useState(false);
  // Poll popup: holds the just-placed order while the poll modal is shown.
  const [pollOrder, setPollOrder] = useState(null);

  // Read remembered phone on mount (no-op if browser storage isn't available)
  useEffect(() => {
    try {
      const p = typeof window !== "undefined" ? window.localStorage.getItem("htLastCustomerPhone") : "";
      if (p) setRememberedPhone(p);
    } catch { /* private mode / storage disabled — silently ignore */ }
  }, []);

  // ── Customer's own orders, fetched by phone via RPC ──
  // The `orders` table has no anon SELECT policy (RLS only allows the owner
  // to read it directly), so the `orders`/`ordersHistory` props — populated
  // via a plain table select — are always empty here. This state is the
  // customer-side substitute: fetched via a phone-scoped RPC, and polled
  // (since realtime postgres_changes is RLS-gated too and won't reach an
  // anonymous client) so status changes like "preparing" → "ready" actually
  // reach the tracking screen without needing a manual page refresh.
  const [myOrders, setMyOrders] = useState([]);
  const refreshMyOrders = useCallback(async (phone) => {
    if (!phone) return;
    const rows = await loadOrdersByPhoneFromTable(phone);
    if (rows) setMyOrders(rows);
  }, []);
  useEffect(() => {
    if (!rememberedPhone) return;
    refreshMyOrders(rememberedPhone);
    const id = setInterval(() => refreshMyOrders(rememberedPhone), 15000);
    const onFocus = () => refreshMyOrders(rememberedPhone);
    window.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onFocus);
    };
  }, [rememberedPhone, refreshMyOrders]);

  // Find the most recent unrated DELIVERED order for the remembered customer.
  // Looks in both todayOrders (in case they had an earlier meal today) and
  // ordersHistory (previous days, up to ~100 days retained).
  const unratedOrder = (() => {
    if (!rememberedPhone || ratingCardDismissed) return null;
    const candidates = [
      ...(orders || []),
      ...(ordersHistory || []),
      ...(myOrders || []),
    ].filter(o =>
      o.phone === rememberedPhone &&
      o.status === "delivered" &&
      !o.rating
    );
    if (!candidates.length) return null;
    // Most recent by creation time
    candidates.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return candidates[0];
  })();

  const handleSubmitRating = async (rating) => {
    if (!unratedOrder) return;
    setRatingSubmitting(true);
    try {
      await onSubmitRating(unratedOrder.id, rating);
      // ── Hide the card immediately on successful submit ──
      // Don't wait for the Supabase realtime broadcast to round-trip back
      // and update local state — that can be slow enough for the customer
      // to see the re-enabled button, think nothing happened, and tap Submit
      // again. Hiding locally makes the UI feel instant and unambiguous.
      setRatingCardDismissed(true);
      setShowRatingModal(false);
      setStep("order");
    } catch (err) {
      // On failure, keep the card visible so the customer can retry.
      // (Idempotency on the backend still prevents duplicate ratings.)
    } finally {
      setRatingSubmitting(false);
    }
  };

  const menuItems = menu?.items?.filter(i => i.available) || [];

  // ── Thali plans (Homely Gold / Standard / Mini) ──
  const plansAvailable = !!(planConfig && planConfig.date === todayStr() &&
    planConfig.sabjis?.filter(s => s.name?.trim()).length === 3 &&
    planConfig.rice && planConfig.salad && planConfig.raita && planConfig.sweet);
  const sabjis = plansAvailable ? planConfig.sabjis : [];

  // Non-premium sabjis (indices 0 and 1). Standard uses BOTH of these fixed;
  // Mini lets the customer choose one of these two. The premium sabji (index 2)
  // is ONLY unlocked through Homely Gold's choice dialog.
  const nonPremiumSabjis = plansAvailable ? sabjis.filter(s => !s.premium).slice(0, 2) : [];

  // Raita / Salad / Sweet of the day — standalone à la carte-style items.
  // Salad-for-the-day is a Gold/Extras-only ingredient; Standard and Mini use
  // a plain "Standard Salad" so nothing in them changes day-to-day.
  const extraItems = plansAvailable ? [
    { id: "extra-raita", key: "raita", name: `${planConfig.raita} (Raita of the Day)`, price: planConfig.prices.raita },
    { id: "extra-salad", key: "salad", name: `${planConfig.salad} (Salad of the Day)`, price: planConfig.prices.salad },
    { id: "extra-sweet", key: "sweet", name: `${planConfig.sweet} (Sweet of the Day)`, price: planConfig.prices.sweet },
  ].filter(x => planConfig.enabled?.[x.key] !== false) : [];

  // All the ways an item can end up in the cart, combined so cart math/order
  // building can treat them uniformly (see CustomerDetailsModal below).
  const allSellableItems = [
    ...menuItems,
    ...extraItems,
    ...Object.entries(planCartMeta).map(([id, m]) => ({ id, name: m.name, price: m.price })),
  ];

  const cartTotal = Object.entries(cart).reduce((sum, [id, qty]) => {
    const item = allSellableItems.find(i => i.id === id); return sum + (item ? item.price * qty : 0);
  }, 0);
  const cartCount = Object.values(cart).reduce((a, b) => a + b, 0);

  const setQty = (id, delta) => setCart(prev => {
    const next = { ...prev, [id]: Math.max(0, (prev[id] || 0) + delta) };
    if (next[id] === 0) delete next[id]; return next;
  });

  // Drop stale metadata for configured plan lines once they leave the cart
  // (e.g. quantity taken to 0), so it doesn't grow unbounded across a session.
  useEffect(() => {
    setPlanCartMeta(prev => {
      const next = {};
      Object.keys(prev).forEach(id => { if (cart[id]) next[id] = prev[id]; });
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [cart]);

  // Called by the choice dialog when the customer confirms a Gold/Mini configuration.
  const addPlanToCart = (id, name, price) => {
    setPlanCartMeta(prev => ({ ...prev, [id]: { name, price } }));
    setCart(prev => ({ ...prev, [id]: (prev[id] || 0) + 1 }));
    setPlanChoiceModal(null);
  };

  const handleConfirmOrder = (order) => {
    setShowModal(false);
    onPlaceOrder(order);
    setActiveOrder(order);
    setStep("track");
    setCart({});
    setPlanCartMeta({});
    setSpecialInstructions("");
    // Remember this customer's phone on the device so we can prompt them for
    // a rating on their next visit. Silently ignored if storage isn't available.
    try {
      if (typeof window !== "undefined" && order.phone) {
        window.localStorage.setItem("htLastCustomerPhone", order.phone);
        setRememberedPhone(order.phone);
      }
    } catch { /* private mode / storage disabled — silently ignore */ }
    // setRememberedPhone above won't re-trigger the fetch effect if this
    // phone was already remembered from an earlier order, so pull the
    // freshly-placed order in explicitly once the place_order RPC (fired by
    // onPlaceOrder, above) has had a moment to land.
    if (order.phone) setTimeout(() => refreshMyOrders(order.phone), 1500);

    // Show the feedback poll once, if it's live and this device hasn't
    // already answered/dismissed it. Small delay so the tracking screen
    // renders first and the popup feels like a natural follow-up.
    if (isPollLive(poll) && !getSeenPolls().includes(poll.id)) {
      setTimeout(() => setPollOrder(order), 550);
    }
  };

  const trackOrder = async () => {
    const trimmed = lookupPhone.trim();
    const rows = await loadOrdersByPhoneFromTable(trimmed);
    const found = (rows || []).find(o => o.date === todayStr());
    if (found) {
      setMyOrders(rows);
      setRememberedPhone(trimmed); // start polling this phone going forward
      setActiveOrder(found);
      setStep("track");
    } else {
      setShowInvalidPhone(true);
    }
  };

  useEffect(() => {
    if (step === "track" && activeOrder) {
      const updated = myOrders.find(o => o.id === activeOrder.id);
      if (updated) setActiveOrder(updated);
    }
  }, [myOrders]);

  const menuAvailable = kitchenOpen && (
    (menu && menu.date === todayStr() && menuItems.length > 0) || plansAvailable
  );

  // If owner closes the kitchen while customer is browsing the menu, send them home
  useEffect(() => {
    if (!kitchenOpen && step === "order") {
      setStep("home");
      setCart({});
      setPlanCartMeta({});
      setSpecialInstructions("");
      setShowModal(false);
    }
  }, [kitchenOpen, step]);

  // ── TRACK VIEW ──
  if (step === "track" && activeOrder) {
    const live = myOrders.find(o => o.id === activeOrder.id) || activeOrder;
    const isRejected = live.status === "rejected";
    const stuckPending = live.status === "pending" &&
      (nowTick - new Date(live.createdAt).getTime()) > 15 * 60 * 1000;
    return (
      <div style={{ minHeight: "100vh", background: C.cream, padding: "24px 16px" }}>
        <div style={{ maxWidth: 480, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 24 }}>
            <div style={{ fontSize: 28, marginBottom: 4 }}>🍱</div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: C.ink }}>Homely Tiffins</h1>
            <p style={{ color: C.inkMid, fontSize: 13 }}>Order #{live.id.slice(-6).toUpperCase()}</p>
          </div>

          <div className="ht-card slide-in" style={{ padding: 24, marginBottom: 16, borderColor: isRejected ? C.red : C.border }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: C.ink }}>Live Order Status</h2>
              <span className={`ht-badge badge-${live.status}`}>{live.status}</span>
            </div>
            <OrderTracker status={live.status} />
          </div>

          {stuckPending && (
            <div className="ht-card slide-in" style={{
              padding: 16, marginBottom: 16,
              background: "#FDECEA", borderColor: "#D32F2F",
            }}>
              <p style={{ fontSize: 13, color: "#B71C1C", fontWeight: 700, lineHeight: 1.5, margin: 0 }}>
                ⚠️ The order is not responded due to some technical error. Please call directly on{" "}
                <a href="tel:8006222000" style={{ color: "#B71C1C", textDecoration: "underline" }}>
                  8006222000
                </a>{" "}
                and place your order.
              </p>
            </div>
          )}

          {!isRejected && (
            <div className="ht-card slide-in" style={{ padding: 20, marginBottom: 16 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: C.ink, marginBottom: 12 }}>Your Order</h3>
              {live.items.map(item => (
                <div key={item.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${C.border}`, fontSize: 14 }}>
                  <span style={{ color: C.inkMid }}>{item.name} × {item.qty}</span>
                  <span style={{ fontWeight: 600, color: C.ink }}>₹{item.price * item.qty}</span>
                </div>
              ))}
              {live.discount > 0 && (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 10, fontSize: 13, color: C.inkMid }}>
                    <span>Subtotal</span>
                    <span>₹{live.originalTotal || (live.total + live.discount)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#2E7D32", fontWeight: 600 }}>
                    <span>{live.promoLabel ? `Promo (${live.promoCode})` : live.referralCode ? `Referral (${live.referralCode})` : "Discount"}</span>
                    <span>−₹{live.discount}</span>
                  </div>
                </>
              )}
              <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 10, fontWeight: 700, fontSize: 15 }}>
                <span>Total</span>
                <span style={{ color: C.saffron }}>₹{live.total}</span>
              </div>
            </div>
          )}

          {!isRejected && (
            <div className="ht-card slide-in" style={{ padding: 20, marginBottom: 16 }}>
              <p style={{ fontSize: 13, color: C.inkMid }}>
                Delivering to <strong style={{ color: C.ink }}>{live.tower}, Flat {live.flat}</strong>
              </p>
            </div>
          )}

          {/* Refer a friend — show customer's own referral code so they can share it */}
          {!isRejected && referralConfig && referralConfig.enabled !== false && getReferralCode(live.phone) && (
            <div className="ht-card slide-in" style={{ padding: 18, marginBottom: 20, background: C.saffronLight, borderColor: C.saffron }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 4 }}>🎁 Share &amp; earn</div>
              <p style={{ fontSize: 12, color: C.inkMid, lineHeight: 1.5, marginBottom: 10 }}>
                Share your code with friends. They save ₹{referralConfig.referredDiscount || 0} on their first order,
                and you get ₹{referralConfig.referrerReward || 0} credit on your next.
              </p>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <code style={{
                  fontSize: 16, fontWeight: 800, letterSpacing: 1,
                  background: C.white, color: C.saffron,
                  padding: "8px 14px", borderRadius: 8, border: `1px dashed ${C.saffron}`,
                  flex: 1, textAlign: "center",
                }}>{getReferralCode(live.phone)}</code>
                <button
                  className="ht-btn btn-primary btn-sm"
                  onClick={() => {
                    const code = getReferralCode(live.phone);
                    const text = `Try Homely Tiffins! Use my referral code ${code} for ₹${referralConfig.referredDiscount || 0} off your first order. https://homelytiffins.com`;
                    if (navigator.share) {
                      navigator.share({ text }).catch(() => {});
                    } else {
                      try { navigator.clipboard.writeText(code); alert("Code copied!"); } catch {}
                    }
                  }}
                >Share</button>
              </div>
            </div>
          )}

          <button className="ht-btn btn-secondary btn-full" onClick={() => { setStep("home"); setActiveOrder(null); }}>
            ← Back to Home
          </button>
        </div>

        {/* Feedback poll — appears once after placing an order, if live */}
        {pollOrder && isPollLive(poll) && (
          <PollModal
            poll={poll}
            order={pollOrder}
            onSubmit={onSubmitPollResponse}
            onClose={() => setPollOrder(null)}
          />
        )}
      </div>
    );
  }

  // ── ORDER / MENU VIEW ──
  if (step === "order") {
    return (
      <div style={{ minHeight: "100vh", background: C.cream, padding: "24px 16px" }}>
        <div style={{ maxWidth: 520, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
            <button className="ht-btn btn-ghost btn-sm" onClick={() => setStep("home")}>← Back</button>
            <h1 style={{ fontSize: 20, fontWeight: 800, color: C.ink }}>Today's Menu</h1>
            <span style={{ marginLeft: "auto", fontSize: 12, color: C.inkLight }}>{fmtDate(todayStr())}</span>
          </div>

          {/* ── MEAL PLANS: Homely Gold / Standard / Mini ── */}
          {plansAvailable && (planConfig.enabled?.goldMedium || planConfig.enabled?.goldLarge || planConfig.enabled?.standard || planConfig.enabled?.mini) && (
            <div style={{ marginBottom: 16 }}>
              <h2 style={{ fontSize: 14, fontWeight: 800, color: C.ink, marginBottom: 10 }}>🍽️ Meal Plans</h2>
              <div className="ht-card slide-in" style={{ padding: 0, marginBottom: 10, overflow: "hidden" }}>
                {(planConfig.enabled?.goldMedium || planConfig.enabled?.goldLarge) && (
                  <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.border}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                      {planConfig.photos?.gold && (
                        <img
                          src={planConfig.photos.gold}
                          alt="Homely Gold"
                          onClick={() => setPhotoPreview({ src: planConfig.photos.gold, label: "Homely Gold" })}
                          style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 10, flexShrink: 0, cursor: "zoom-in" }}
                        />
                      )}
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 15, fontWeight: 800, color: C.ink }}>✨ Homely Gold</div>
                        <div style={{ fontSize: 12, color: C.inkMid, marginTop: 4, lineHeight: 1.5 }}>
                          Choice of 2 sabjis + Choice of breads + Rice for the day + Choice of sides + Salad for the day
                        </div>
                        <div style={{ fontSize: 11, color: C.inkLight, marginTop: 4, fontWeight: 600 }}>
                          {planConfig.enabled?.goldMedium && planConfig.enabled?.goldLarge ? "Available in Medium & Large" : planConfig.enabled?.goldLarge ? "Large only today" : "Medium only today"}
                        </div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 800, color: C.saffron, marginBottom: 6 }}>
                          {planConfig.enabled?.goldMedium
                            ? `₹${planConfig.prices.gold}`
                            : `₹${planConfig.prices.gold + (planConfig.prices.goldLargeSurcharge || 0)}`}
                        </div>
                        <button className="ht-btn btn-primary btn-sm" onClick={() => setPlanChoiceModal("gold")}>+ Add</button>
                      </div>
                    </div>
                  </div>
                )}
                {planConfig.enabled?.standard && (
                  <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.border}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                      {planConfig.photos?.standard && (
                        <img
                          src={planConfig.photos.standard}
                          alt="Homely Standard"
                          onClick={() => setPhotoPreview({ src: planConfig.photos.standard, label: "Homely Standard" })}
                          style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 10, flexShrink: 0, cursor: "zoom-in" }}
                        />
                      )}
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 15, fontWeight: 800, color: C.ink }}>Homely Standard</div>
                        <div style={{ fontSize: 12, color: C.inkMid, marginTop: 4, lineHeight: 1.5 }}>
                          2 standard sabjis (fixed) + 4 chapatis + steamed rice + standard salad
                        </div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 800, color: C.saffron, marginBottom: 6 }}>₹{planConfig.prices.standard}</div>
                        <button className="ht-btn btn-primary btn-sm" onClick={() => setPlanChoiceModal("standard")}>+ Add</button>
                      </div>
                    </div>
                  </div>
                )}
                {planConfig.enabled?.mini && (
                  <div style={{ padding: "16px 20px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                      {planConfig.photos?.mini && (
                        <img
                          src={planConfig.photos.mini}
                          alt="Homely Mini"
                          onClick={() => setPhotoPreview({ src: planConfig.photos.mini, label: "Homely Mini" })}
                          style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 10, flexShrink: 0, cursor: "zoom-in" }}
                        />
                      )}
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 15, fontWeight: 800, color: C.ink }}>Homely Mini</div>
                        <div style={{ fontSize: 12, color: C.inkMid, marginTop: 4, lineHeight: 1.5 }}>
                          Choice of 1 sabji + 4 chapatis + standard salad
                        </div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 800, color: C.saffron, marginBottom: 6 }}>₹{planConfig.prices.mini}</div>
                        <button className="ht-btn btn-primary btn-sm" onClick={() => setPlanChoiceModal("mini")}>+ Add</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Configured Gold / Standard / Mini selections already in the cart */}
              {Object.entries(planCartMeta).length > 0 && (
                <div className="ht-card slide-in" style={{ padding: 20 }}>
                  <h3 style={{ fontSize: 12, fontWeight: 700, color: C.ink, marginBottom: 10 }}>Your Selections</h3>
                  {Object.entries(planCartMeta).filter(([id]) => cart[id]).map(([id, m]) => (
                    <div key={id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                      <div style={{ flex: 1, paddingRight: 10 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{m.name}</div>
                        <div style={{ fontSize: 12, color: C.saffron, fontWeight: 700 }}>₹{m.price}</div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <button className="ht-btn btn-secondary btn-sm" style={{ width: 28, height: 28, padding: 0, borderRadius: "50%", fontSize: 16 }} onClick={() => setQty(id, -1)}>−</button>
                        <span style={{ fontSize: 14, fontWeight: 700, minWidth: 18, textAlign: "center", color: C.ink }}>{cart[id] || 0}</span>
                        <button className="ht-btn btn-primary btn-sm" style={{ width: 28, height: 28, padding: 0, borderRadius: "50%", fontSize: 16 }} onClick={() => setQty(id, 1)}>+</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── TODAY'S EXTRAS: Raita / Salad / Sweet ── */}
          {plansAvailable && extraItems.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <h2 style={{ fontSize: 14, fontWeight: 800, color: C.ink, marginBottom: 10 }}>🥗 Today's Extras</h2>
              <div className="ht-card slide-in" style={{ padding: 20 }}>
                {extraItems.map(item => (
                  <div key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>{item.name}</div>
                      <div style={{ fontSize: 13, color: C.saffron, fontWeight: 700 }}>₹{item.price}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <button className="ht-btn btn-secondary btn-sm" style={{ width: 32, height: 32, padding: 0, borderRadius: "50%", fontSize: 18 }} onClick={() => setQty(item.id, -1)}>−</button>
                      <span style={{ fontSize: 15, fontWeight: 700, minWidth: 22, textAlign: "center", color: C.ink }}>{cart[item.id] || 0}</span>
                      <button className="ht-btn btn-primary btn-sm" style={{ width: 32, height: 32, padding: 0, borderRadius: "50%", fontSize: 18 }} onClick={() => setQty(item.id, 1)}>+</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── À LA CARTE ── */}
          {menuItems.length > 0 && (
            <div style={{ marginBottom: cartCount > 0 ? 16 : 80 }}>
              {plansAvailable && <h2 style={{ fontSize: 14, fontWeight: 800, color: C.ink, marginBottom: 10 }}>🍛 À la carte</h2>}
              <div className="ht-card slide-in" style={{ padding: 20 }}>
                {menuItems.map(item => (
                  <div key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 0", borderBottom: `1px solid ${C.border}` }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>{item.name}</div>
                      <div style={{ fontSize: 13, color: C.saffron, fontWeight: 700 }}>₹{item.price}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <button className="ht-btn btn-secondary btn-sm" style={{ width: 32, height: 32, padding: 0, borderRadius: "50%", fontSize: 18 }} onClick={() => setQty(item.id, -1)}>−</button>
                      <span style={{ fontSize: 15, fontWeight: 700, minWidth: 22, textAlign: "center", color: C.ink }}>{cart[item.id] || 0}</span>
                      <button className="ht-btn btn-primary btn-sm" style={{ width: 32, height: 32, padding: 0, borderRadius: "50%", fontSize: 18 }} onClick={() => setQty(item.id, 1)}>+</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {planChoiceModal && (
            <PlanChoiceModal
              plan={planChoiceModal}
              planConfig={planConfig}
              onAdd={addPlanToCart}
              onClose={() => setPlanChoiceModal(null)}
            />
          )}

          {photoPreview && (
            <PhotoPreviewModal
              src={photoPreview.src}
              label={photoPreview.label}
              onClose={() => setPhotoPreview(null)}
            />
          )}

          {/* Special Instructions — only show after items added */}
          {cartCount > 0 && (
            <div className="ht-card slide-in" style={{ padding: 20, marginBottom: 80 }}>
              <label style={{ fontSize: 13, fontWeight: 700, color: C.ink, display: "block", marginBottom: 8 }}>
                📝 Special Instructions <span style={{ fontWeight: 400, color: C.inkLight, fontSize: 11 }}>(optional)</span>
              </label>
              <textarea
                className="ht-input"
                placeholder="e.g. less spicy, no onion, extra raita..."
                value={specialInstructions}
                onChange={e => setSpecialInstructions(e.target.value.slice(0, 200))}
                rows={3}
                style={{ resize: "vertical", fontFamily: "inherit", lineHeight: 1.4 }}
              />
              <div style={{ fontSize: 10, color: C.inkLight, marginTop: 4, textAlign: "right" }}>
                {specialInstructions.length}/200
              </div>
            </div>
          )}

          {/* Sticky cart bar — opens modal */}
          {cartCount > 0 && (
            <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: C.white, borderTop: `1px solid ${C.border}`, padding: "14px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "0 -4px 20px rgba(0,0,0,0.08)", zIndex: 100 }}>
              <div>
                <div style={{ fontSize: 13, color: C.inkMid }}>{cartCount} item{cartCount > 1 ? "s" : ""}</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: C.ink }}>₹{cartTotal}</div>
              </div>
              <button className="ht-btn btn-primary btn-lg" onClick={() => setShowModal(true)}>
                Proceed to Order →
              </button>
            </div>
          )}
        </div>

        {showModal && (
          <CustomerDetailsModal
            cart={cart}
            menuItems={allSellableItems}
            cartTotal={cartTotal}
            cartCount={cartCount}
            specialInstructions={specialInstructions}
            promoCodes={promoCodes}
            referralConfig={referralConfig}
            customers={customers}
            onConfirm={handleConfirmOrder}
            onClose={() => setShowModal(false)}
          />
        )}
      </div>
    );
  }

  // ── HOME ── (redesigned July 2026)
  // Detect any active order for the remembered phone to show the Track card
  // in either "active" (with progress dots) or "empty" state.
  const trackActiveOrder = rememberedPhone
    ? (myOrders || []).find(o =>
        o.phone === rememberedPhone &&
        (o.status === "pending" || o.status === "preparing" || o.status === "ready" || o.status === "dispatched")
      )
    : null;

  // Testimonials — 10 quotes with daily rotation showing 5 at a time
  const ALL_TESTIMONIALS = [
    { quote: "Bilkul ghar jaisa khana. Na zyada oil, na unnecessary masale.", name: "Priya S.", tower: "N-14" },
    { quote: "Aunty khana bohot mast tha and office ke baad cooking ka tension hi khatam ho gyi.", name: "Rohit M.", tower: "N-7" },
    { quote: "Ghar ke khane ki yaad aa jaati hai. Best homemade tiffin service in Noida.", name: "Anjali K.", tower: "N-22" },
    { quote: "Main pichle 6 mahine se order kar raha hoon and taste and quality bohot aachi hai.", name: "Vikram J.", tower: "N-3" },
    { quote: "Aunty ke haath ka khana sach mein dil jeet leta hai.", name: "Neha P.", tower: "N-19" },
    { quote: "The rotis are always soft, vegetables are cooked perfectly, and the menu changes regularly. It never feels repetitive.", name: "Aditya R.", tower: "N-11" },
    { quote: "After trying several tiffin services in Noida, Homely Tiffins is the only one that actually tastes like home. The food is fresh, less oily, and always arrives on time.", name: "Sneha G.", tower: "N-25" },
    { quote: "Clean packaging, balanced meals, and consistent quality every single day. Worth every rupee.", name: "Karan T.", tower: "N-5" },
    { quote: "ऐसा लगता है जैसे घर से टिफिन आया हो। स्वाद और सफाई बेहतरीन हैं।", name: "Meera D.", tower: "N-17" },
    { quote: "It's more than a tiffin service. It feels like someone at home made the meal specially for you.", name: "Arjun B.", tower: "N-9" },
  ];
  const AVATAR_BGS = ["#8C5A2A", "#5C7C3E", "#C4620F", "#7A5A3D", "#A0522D"];
  const dayOfYear = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  const startIdx = dayOfYear % ALL_TESTIMONIALS.length;
  const shownTestimonials = Array.from({ length: 5 }, (_, i) => ALL_TESTIMONIALS[(startIdx + i) % ALL_TESTIMONIALS.length]);

  return (
    <div style={{ background: HC.cream, minHeight: "100vh", fontFamily: "'Nunito', system-ui, sans-serif", color: HC.brown, overflowX: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700;800&family=Dancing+Script:wght@600;700&family=Nunito:wght@400;600;700;800&display=swap');
        * { box-sizing: border-box; }
        .h5-testimonials::-webkit-scrollbar { display: none; }
        .h5-testimonials { scrollbar-width: none; }
      `}</style>

      {/* ═══════ SECTION 1 — HEADER (logo + wordmark) ═══════ */}
      <div style={{ maxWidth: 420, margin: "0 auto", padding: "18px 14px 0" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          <img
            src="/logo.png"
            alt="Sharma Aunty"
            style={{
              width: 92, height: 92, borderRadius: "50%",
              border: `2.5px solid ${HC.brown}`, objectFit: "cover", flexShrink: 0,
            }}
          />
          <div>
            <div style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontWeight: 800, fontSize: 34, letterSpacing: 5,
              color: HC.brown, lineHeight: 1,
            }}>HOMELY</div>
            <div style={{
              display: "flex", alignItems: "center", gap: 8, marginTop: 4,
              fontFamily: "'Playfair Display', Georgia, serif",
              fontWeight: 700, fontSize: 13, letterSpacing: 6,
              color: HC.orangeDeep,
            }}>
              <ArrowLong />TIFFINS<ArrowLong flip />
            </div>
            <div style={{
              fontFamily: "'Dancing Script', cursive",
              fontWeight: 700, fontSize: 22, color: HC.orange, marginTop: 4, lineHeight: 1,
            }}>Ghar jaisa. Better.</div>
            <div style={{ marginTop: 2 }}><HeartIcon s={11} c={HC.orange} /></div>
          </div>
        </div>
      </div>

      {/* ═══════ SECTION 2 — HERO ═══════ */}
      <div style={{
        maxWidth: isDesktop ? 980 : 420,
        margin: "10px auto 0",
        padding: "0 14px",
        position: "relative",
        display: isDesktop ? "grid" : "block",
        gridTemplateColumns: isDesktop ? "1fr 1fr" : "none",
        gap: isDesktop ? 40 : 0,
        alignItems: "center",
      }}>
        {/* Background tiffin illustration — mobile only */}
        {!isDesktop && (
          <img
            src={REF_SRC}
            alt=""
            aria-hidden
            style={{
              position: "absolute", bottom: 40, right: 10, width: 135, height: "auto",
              zIndex: 0, pointerEvents: "none",
            }}
          />
        )}

        {/* LEFT — text content */}
        <div style={{ position: "relative", zIndex: 1, paddingTop: isDesktop ? 40 : 16, paddingBottom: 20, paddingRight: isDesktop ? 0 : 12 }}>
          <h1 style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontWeight: 800, fontSize: isDesktop ? 38 : 22.8, lineHeight: 1.15,
            color: HC.brown, margin: "0 0 2px", whiteSpace: isDesktop ? "normal" : "nowrap",
          }}>Ghar Jaisa Khana,</h1>
          <h1 style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontWeight: 800, fontSize: isDesktop ? 38 : 22.8, lineHeight: 1.15,
            color: HC.orange, margin: "0 0 14px", whiteSpace: isDesktop ? "normal" : "nowrap",
          }}>Made Fresh Every Day</h1>

          <div style={{ fontSize: isDesktop ? 16 : 13.5, color: HC.brownMid, lineHeight: 1.5, marginBottom: 14 }}>
            Freshly cooked by Sharma Aunty.<br />Delivered hot within your society.
          </div>

          {/* Row 1 — rating pill only */}
          <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              background: "#fff", borderRadius: 999, padding: "5px 10px",
              border: `1px solid ${HC.dash}`,
            }}>
              <StarDisplay value={5} size={13} color={HC.orange} />
              <span style={{ fontSize: 12, fontWeight: 800, color: HC.brown }}>4.9/5</span>
            </div>
          </div>

          {/* Row 2 — avatars + 500+ customers */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center" }}>
              {["P", "R", "A"].map((ch, i) => (
                <div key={i} style={{
                  width: 22, height: 22, borderRadius: "50%",
                  background: ["#8C5A2A", "#5C7C3E", "#C4620F"][i],
                  color: "#fff", fontSize: 10, fontWeight: 800,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  border: "1.5px solid #fff", marginLeft: i === 0 ? 0 : -6,
                  fontFamily: "'Nunito', sans-serif",
                }}>{ch}</div>
              ))}
            </div>
            <div style={{ fontSize: 11.5, color: HC.brownMid, fontWeight: 600 }}>500+ Happy Customers</div>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <button onClick={() => { if (unratedOrder) { setShowRatingModal(true); } else { setStep("order"); } }} disabled={!kitchenOpen || !menuAvailable} style={{
              background: isDesktop ? HC.orange : "transparent",
              color: isDesktop ? "#fff" : HC.orange,
              border: `1.5px solid ${HC.orange}`,
              padding: isDesktop ? "14px 32px" : "10px 22px",
              borderRadius: 10,
              fontFamily: "'Nunito', sans-serif", fontWeight: 800,
              fontSize: isDesktop ? 17 : 15,
              display: "inline-flex", alignItems: "center", gap: 8,
              cursor: (kitchenOpen && menuAvailable) ? "pointer" : "not-allowed",
              opacity: (kitchenOpen && menuAvailable) ? 1 : 0.5,
              boxShadow: isDesktop ? "0 6px 16px rgba(224,115,26,.32)" : "none",
            }}>
              <CartIcon s={16} c={isDesktop ? "#fff" : HC.orange} /> Order Now
            </button>
            <button onClick={() => setShowContact(true)} style={{
              background: "transparent",
              color: HC.brownDark,
              border: `1.5px solid ${HC.brownDark}`,
              padding: isDesktop ? "14px 22px" : "10px 18px",
              borderRadius: 10,
              fontFamily: "'Nunito', sans-serif", fontWeight: 800,
              fontSize: isDesktop ? 15 : 14,
              display: "inline-flex", alignItems: "center", gap: 6,
              cursor: "pointer",
            }}>
              📞 Contact Us
            </button>
          </div>
        </div>

        {/* RIGHT — tiffin image (desktop only) */}
        {isDesktop && (
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", padding: "20px 0" }}>
            <img
              src={REF_SRC}
              alt="Homely Tiffins tiffin"
              style={{ width: "64%", maxWidth: 268, height: "auto", display: "block" }}
            />
          </div>
        )}
      </div>

      {/* Kitchen closed / menu not published banners (only when relevant) */}
      {!kitchenOpen ? (
        <div style={{ maxWidth: 420, margin: "18px auto 0", padding: "0 14px" }}>
          <div style={{
            background: "#FBF1F0", border: "2px dashed #E6B3B0", borderRadius: 18,
            padding: "20px 20px", textAlign: "center",
          }}>
            <div style={{ fontSize: 34 }}>🍴</div>
            <h2 style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 20, color: "#B23A34", margin: "8px 0 4px" }}>Kitchen is Closed</h2>
            <div style={{ fontSize: 13, color: HC.brownMid, fontWeight: 600 }}>We're not accepting orders right now. Please check back later.</div>
          </div>
        </div>
      ) : !menuAvailable ? (
        <div style={{ maxWidth: 420, margin: "18px auto 0", padding: "0 14px" }}>
          <div style={{
            background: HC.card, border: `2px dashed ${HC.dash}`, borderRadius: 18,
            padding: "20px 20px", textAlign: "center",
          }}>
            <div style={{ fontSize: 34 }}>⏳</div>
            <h2 style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 20, color: HC.brown, margin: "8px 0 4px" }}>Menu Not Published Yet</h2>
            <div style={{ fontSize: 13, color: HC.brownMid, fontWeight: 600 }}>Check back soon — today's menu will appear here once it's published.</div>
          </div>
        </div>
      ) : null}

      {/* ═══════ SECTION 8A — TRACK YOUR ORDER ═══════ */}
      <div style={{ maxWidth: 420, margin: "20px auto 0", padding: "0 14px" }}>
        <div
          onClick={() => {
            if (trackActiveOrder) {
              setActiveOrder(trackActiveOrder);
              setStep("track");
            }
          }}
          style={{
            background: "linear-gradient(135deg, #FFF2DE 0%, #FBE4C0 100%)",
            borderRadius: 20, border: `1.5px solid ${HC.orange}`,
            padding: "14px 14px 12px", boxShadow: "0 6px 18px rgba(224, 115, 26, 0.14)",
            display: "flex", alignItems: "center", gap: 12,
            cursor: trackActiveOrder ? "pointer" : "default",
          }}
        >
          <div style={{
            width: 46, height: 46, borderRadius: "50%", background: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
            border: `2px solid ${HC.orange}`, position: "relative",
          }}>
            <span style={{ fontSize: 22, lineHeight: 1 }}>🥡</span>
            <span style={{
              position: "absolute", top: -4, right: -4, fontSize: 14, lineHeight: 1,
              filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.15))",
            }}>❤️</span>
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontFamily: "'Nunito', sans-serif", fontSize: 10, fontWeight: 800,
              color: HC.orange, letterSpacing: 1, textTransform: "uppercase",
            }}>Track Your Order</div>
            {trackActiveOrder ? (
              <>
                <div style={{
                  fontFamily: "'Playfair Display', Georgia, serif",
                  fontWeight: 800, fontSize: 15, color: HC.brown, lineHeight: 1.2, marginTop: 2,
                }}>
                  {trackActiveOrder.status === "pending" &&
                    ((nowTick - new Date(trackActiveOrder.createdAt).getTime()) > 15 * 60 * 1000
                      ? "⚠️ Technical error — call 8006222000"
                      : "Order received, aunty starting soon 🍳")}
                  {trackActiveOrder.status === "preparing" && "Aunty is cooking your tiffin 🍲"}
                  {trackActiveOrder.status === "ready" && "Your tiffin is packed and ready 📦"}
                  {trackActiveOrder.status === "dispatched" && "On its way to you 🛵"}
                </div>
                {/* Progress dots — 5 stages */}
                <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 8 }}>
                  {["pending", "preparing", "ready", "dispatched", "delivered"].map((stg, idx, arr) => {
                    const rank = { pending: 0, preparing: 1, ready: 2, dispatched: 3, delivered: 4 };
                    const currentRank = rank[trackActiveOrder.status];
                    const isReached = idx <= currentRank;
                    const isConnectorFilled = idx < currentRank;
                    return (
                      <span key={stg} style={{ display: "contents" }}>
                        <div style={{
                          width: 8, height: 8, borderRadius: "50%",
                          background: isReached ? HC.orange : "#fff",
                          border: isReached ? "none" : `1.5px solid ${HC.dash}`,
                        }} />
                        {idx < arr.length - 1 && (
                          <div style={{
                            flex: 1, height: 2, borderRadius: 1,
                            background: isConnectorFilled ? HC.orange : HC.dash,
                          }} />
                        )}
                      </span>
                    );
                  })}
                </div>
              </>
            ) : (
              <>
                <div style={{
                  fontFamily: "'Playfair Display', Georgia, serif",
                  fontWeight: 800, fontSize: 15, color: HC.brown, lineHeight: 1.2, marginTop: 2,
                }}>No active orders yet</div>
                <div style={{ fontFamily: "'Nunito', sans-serif", fontSize: 11.5, color: HC.brown, opacity: 0.75, marginTop: 2 }}>
                  Your next tiffin is one tap away →
                </div>
              </>
            )}
          </div>

          {trackActiveOrder && (
            <div style={{ color: HC.orange, fontSize: 20, fontWeight: 800, flexShrink: 0 }}>›</div>
          )}
        </div>
      </div>

      {/* ═══════ SECTION 3B — HOMELY GOLD LAUNCH BANNER ═══════ */}
      <div style={{ maxWidth: 420, margin: "20px auto 0", padding: "0 14px" }}>
        <div style={{
          position: "relative",
          aspectRatio: "3 / 4",
          borderRadius: 20,
          overflow: "hidden",
          boxShadow: "0 6px 20px rgba(59,42,26,0.25)",
        }}>
          <img
            src={GOLD_BANNER_SRC}
            alt="Homely Gold"
            style={{
              position: "absolute", inset: 0,
              width: "100%", height: "100%",
              objectFit: "cover",
              objectPosition: "top",
            }}
          />
          <div style={{
            position: "absolute", inset: 0,
            background: "linear-gradient(to bottom, rgba(59,42,26,0.15) 0%, rgba(59,42,26,0.15) 40%, rgba(59,42,26,0.96) 78%, rgba(59,42,26,0.98) 100%)",
          }} />
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: 16 }}>
            <div style={{
              fontFamily: "'Nunito', sans-serif",
              fontSize: 9,
              letterSpacing: 1.5,
              textTransform: "uppercase",
              color: HC.orange,
              fontWeight: 800,
            }}>
              Introducing
            </div>
            <div style={{
              fontFamily: "'Playfair Display', serif",
              fontSize: 22,
              fontWeight: 800,
              color: "#fff",
              margin: "2px 0 6px",
            }}>
              Homely Gold
            </div>
            <div style={{
              fontFamily: "'Nunito', sans-serif",
              fontSize: 11.5,
              fontWeight: 700,
              color: "#F6EFE1",
              lineHeight: 1.35,
              marginBottom: 10,
            }}>
              Premium homemade meals, crafted for the best and wholesome experience.
            </div>

            <div style={{
              display: "inline-block",
              fontFamily: "'Nunito', sans-serif",
              fontSize: 11,
              fontWeight: 800,
              color: HC.brown,
              background: HC.orange,
              padding: "3px 9px",
              borderRadius: 20,
              marginBottom: 10,
            }}>
              Now starts at ₹{planConfig.prices.gold}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 12 }}>
              {[
                { text: "Premium sabji every day", tag: true },
                { text: "Desi ghee chapatis / parathas" },
                { text: "Special rice" },
                { text: "Sweet and raita — choice of add-ons" },
                { text: "Priority delivery+" },
              ].map((item, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <div style={{
                    width: 14, height: 14, borderRadius: 4, flexShrink: 0,
                    background: "rgba(224,115,26,0.2)",
                    border: `1px solid ${HC.orange}`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <span style={{ color: HC.orange, fontSize: 9, fontWeight: 900, lineHeight: 1 }}>✓</span>
                  </div>
                  <span style={{
                    fontFamily: "'Nunito', sans-serif",
                    fontSize: 12,
                    fontWeight: 700,
                    color: "#F6EFE1",
                  }}>
                    {item.text}
                  </span>
                  {item.tag && (
                    <span style={{
                      background: HC.orange,
                      color: HC.brown,
                      fontSize: 6.5,
                      fontWeight: 800,
                      padding: "2px 6px",
                      borderRadius: 20,
                      textTransform: "uppercase",
                      letterSpacing: 0.3,
                    }}>
                      Gold Only
                    </span>
                  )}
                </div>
              ))}
            </div>

            <button
              onClick={() => setStep("order")}
              style={{
                width: "100%",
                background: HC.orange,
                color: "#fff",
                border: "none",
                borderRadius: 10,
                padding: "10px 0",
                fontFamily: "'Nunito', sans-serif",
                fontSize: 13,
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              Order Now
            </button>
          </div>
        </div>
      </div>

      {/* ═══════ SECTION 4 — WHY CHOOSE HOMELY TIFFINS ═══════ */}
      <div style={{ maxWidth: 420, margin: "28px auto 0", padding: "0 14px" }}>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <div style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontWeight: 800, fontSize: 22, color: HC.brown, lineHeight: 1.2,
          }}>
            Why Choose <span style={{ color: HC.orange }}>Homely Tiffins?</span>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
          {[
            { icon: "🏠", desc: "Home cooked by Sharma Aunty" },
            { icon: "🌿", desc: "Fresh and quality ingredients" },
            { icon: "🍲", desc: "Fresh food with no preservatives" },
            { icon: "🛵", desc: "Delivered hot with care. Daily" },
          ].map((r, i) => (
            <div key={i} style={{
              background: "#fff", borderRadius: 14, padding: "12px 8px 10px",
              border: `1px solid ${HC.dash}`, boxShadow: "0 3px 10px rgba(59, 42, 26, 0.04)",
              display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center",
            }}>
              <div style={{
                width: 44, height: 44, borderRadius: 12, background: HC.cream,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 24, lineHeight: 1,
              }}>{r.icon}</div>
              <div style={{
                fontFamily: "'Nunito', sans-serif",
                fontSize: 9.5, fontWeight: 700, color: HC.brown, lineHeight: 1.25,
              }}>{r.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ═══════ SECTION 5 — MEET SHARMA AUNTY ═══════ */}
      <div style={{ maxWidth: 420, margin: "28px auto 0", padding: "0 14px" }}>
        <div style={{
          background: "#FBF3E3", borderRadius: 22,
          border: `1.5px solid ${HC.brown}`, boxShadow: "0 6px 18px rgba(59, 42, 26, 0.10)",
          overflow: "hidden", display: "grid",
          gridTemplateColumns: "1fr 1fr", gridTemplateRows: "auto auto",
        }}>
          <div style={{ padding: "12px 6px 12px 12px" }}>
            <img
              src={AUNTY_SRC}
              alt="Sharma Aunty in her kitchen"
              style={{
                width: "100%", height: 130, objectFit: "cover", objectPosition: "center 25%",
                display: "block", borderRadius: 14, border: `2px solid ${HC.brown}`,
                boxShadow: "0 3px 10px rgba(59, 42, 26, 0.15)",
              }}
            />
          </div>

          <div style={{
            padding: "18px 16px",
            display: "flex", flexDirection: "column", justifyContent: "center",
          }}>
            <div style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontWeight: 800, fontSize: 20, color: HC.brown, lineHeight: 1.15,
            }}>
              Meet <span style={{ color: HC.orange }}>Sharma Aunty</span>
            </div>
            <div style={{
              fontFamily: "'Dancing Script', cursive",
              fontSize: 16, color: HC.orange, marginTop: 4, lineHeight: 1.2,
            }}>the heart of the kitchen ❤️</div>
            <div style={{ width: 32, height: 2, background: HC.orange, borderRadius: 2, marginTop: 8 }} />
          </div>

          <div style={{
            gridColumn: "1 / -1", padding: "16px 18px 18px",
            borderTop: `1px dashed ${HC.dash}`,
          }}>
            <div style={{
              fontFamily: "'Nunito', sans-serif",
              fontSize: 12, color: HC.brown, lineHeight: 1.6,
            }}>
              For as long as she can remember, Sharma Aunty has found joy in cooking for others.
              What began as preparing meals for family and friends has grown into Homely Tiffins—a
              kitchen built on love, fresh ingredients, and the belief that everyone deserves
              wholesome, homemade food.
            </div>
          </div>
        </div>
      </div>

      {/* ═══════ SECTION 6 — TESTIMONIALS ═══════ */}
      <div style={{ maxWidth: 420, margin: "32px auto 0" }}>
        <div style={{ textAlign: "center", marginBottom: 16, padding: "0 14px" }}>
          <div style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontWeight: 800, fontSize: 22, color: HC.brown, lineHeight: 1.2,
          }}>Loved by our <span style={{ color: HC.orange }}>Neighbours</span></div>
          <div style={{
            fontFamily: "'Dancing Script', cursive",
            fontSize: 16, color: HC.orange, marginTop: 4,
          }}>what the society is saying</div>
        </div>

        <div className="h5-testimonials" style={{
          display: "flex", gap: 12, overflowX: "auto",
          padding: "4px 14px 16px", scrollSnapType: "x mandatory",
          WebkitOverflowScrolling: "touch",
        }}>
          {shownTestimonials.map((t, i) => (
            <div key={i} style={{
              background: "#fff", borderRadius: 18, padding: "16px 16px 14px",
              border: `1px solid ${HC.dash}`, boxShadow: "0 4px 14px rgba(59, 42, 26, 0.06)",
              minWidth: 260, maxWidth: 260, scrollSnapAlign: "start",
              display: "flex", flexDirection: "column", gap: 10, flexShrink: 0,
            }}>
              <div style={{
                fontFamily: "'Playfair Display', Georgia, serif",
                fontSize: 42, color: HC.orange, lineHeight: 0.6, height: 22,
                opacity: 0.4, fontWeight: 800,
              }}>“</div>

              <div style={{
                fontFamily: "'Nunito', sans-serif",
                fontSize: 12, color: HC.brown, lineHeight: 1.5, fontStyle: "italic",
              }}>{t.quote}</div>

              <div style={{ display: "flex", gap: 2 }}>
                <StarDisplay value={5} size={14} color={HC.orange} />
              </div>

              <div style={{ height: 1, background: HC.dash, margin: "2px 0" }} />

              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{
                  width: 30, height: 30, borderRadius: "50%",
                  background: AVATAR_BGS[i % AVATAR_BGS.length],
                  color: "#fff", fontSize: 12, fontWeight: 800,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>{t.name[0]}</div>
                <div>
                  <div style={{
                    fontFamily: "'Nunito', sans-serif",
                    fontSize: 12, fontWeight: 800, color: HC.brown, lineHeight: 1.1,
                  }}>{t.name}</div>
                  <div style={{
                    fontFamily: "'Nunito', sans-serif",
                    fontSize: 10.5, color: HC.brown, opacity: 0.6, marginTop: 1,
                  }}>Tower {t.tower}</div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* 5 scroll hint dots */}
        <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: -4 }}>
          <div style={{ width: 20, height: 4, borderRadius: 2, background: HC.orange }} />
          {[0, 0, 0, 0].map((_, i) => (
            <div key={i} style={{ width: 6, height: 4, borderRadius: 2, background: HC.dash }} />
          ))}
        </div>
      </div>

      {/* ═══════ OWNER LOGIN — discreet footer button ═══════ */}
      <div style={{
        maxWidth: 420, margin: "36px auto 0", padding: "0 14px 30px",
        display: "flex", justifyContent: "center",
      }}>
        <button
          onClick={onOwnerAccess}
          style={{
            background: "transparent", border: `1px solid ${HC.dash}`, borderRadius: 999,
            padding: "8px 18px", fontFamily: "'Nunito', sans-serif",
            fontSize: 11.5, fontWeight: 700, color: HC.brown, opacity: 0.65,
            display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer",
          }}
        >
          <span style={{ fontSize: 12 }}>🔒</span>
          Owner Login
        </button>
      </div>

      {showInvalidPhone && <InvalidPhoneModal onClose={() => setShowInvalidPhone(false)} />}
      {showContact && <ContactUsModal contactInfo={contactInfo} onSubmitMessage={onSubmitContactMessage} onClose={() => setShowContact(false)} />}

      {/* Rating popup — shown after "Order Now" is tapped, before moving to the order page */}
      {showRatingModal && unratedOrder && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) { setShowRatingModal(false); setStep("order"); } }}>
          <div className="modal-sheet">
            <div style={{ width: 40, height: 4, borderRadius: 2, background: C.border, margin: "0 auto 20px" }} />
            <RatingCard
              order={unratedOrder}
              onSubmit={handleSubmitRating}
              onSkip={() => { setRatingCardDismissed(true); setShowRatingModal(false); setStep("order"); }}
              submitting={ratingSubmitting}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// BACKEND — MENU EDITOR
// ─────────────────────────────────────────────
function MenuEditor({ menu, onSave }) {
  const [items, setItems] = useState(menu?.items || [
    { id: "1", name: "Dal Tadka + Rice", price: 80, available: true },
    { id: "2", name: "Rajma Chawal", price: 90, available: true },
    { id: "3", name: "Aloo Sabzi + Roti (2)", price: 70, available: true },
    { id: "4", name: "Paneer Butter Masala + Rice", price: 110, available: true },
    { id: "5", name: "Curd Rice", price: 60, available: true },
    { id: "6", name: "Extra Roti", price: 10, available: true },
  ]);
  const [newName, setNewName] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [saved, setSaved] = useState(false);

  const addItem = () => {
    if (!newName || !newPrice) return;
    setItems(prev => [...prev, { id: genId(), name: newName, price: parseInt(newPrice), available: true }]);
    setNewName(""); setNewPrice("");
  };

  const handleSave = () => { onSave({ date: todayStr(), items }); setSaved(true); setTimeout(() => setSaved(false), 2000); };

  return (
    <div style={{ padding: "20px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink }}>Today's Menu</h2>
          <p style={{ fontSize: 13, color: C.inkMid }}>{fmtDate(todayStr())}</p>
        </div>
        <button className={`ht-btn ${saved ? "btn-green" : "btn-primary"}`} onClick={handleSave}>
          {saved ? "✓ Published!" : "Publish Menu"}
        </button>
      </div>

      <div className="ht-card" style={{ marginBottom: 16 }}>
        {items.map((item, i) => (
          <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 20px", borderBottom: i < items.length - 1 ? `1px solid ${C.border}` : "none", opacity: item.available ? 1 : 0.5 }}>
            <input type="checkbox" checked={item.available} onChange={() => setItems(prev => prev.map(x => x.id === item.id ? { ...x, available: !x.available } : x))} style={{ accentColor: C.saffron, width: 16, height: 16 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>{item.name}</div>
              <div style={{ fontSize: 13, color: C.saffron, fontWeight: 700 }}>₹{item.price}</div>
            </div>
            <button className="ht-btn btn-ghost btn-sm" style={{ color: C.red }} onClick={() => setItems(prev => prev.filter(x => x.id !== item.id))}>✕</button>
          </div>
        ))}
      </div>

      <div className="ht-card" style={{ padding: 20 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 12 }}>+ Add Item</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 100px auto", gap: 8 }}>
          <input className="ht-input" placeholder="Item name" value={newName} onChange={e => setNewName(e.target.value)} />
          <input className="ht-input" placeholder="₹ Price" type="number" value={newPrice} onChange={e => setNewPrice(e.target.value)} />
          <button className="ht-btn btn-primary" onClick={addItem}>Add</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// PLAN MENU EDITOR (owner) — feed just the sabjis + rice/salad/raita/sweet
// for the day, and Homely Gold / Standard / Mini publish themselves
// automatically with the correct choices built in.
// ─────────────────────────────────────────────
function PlanMenuEditor({ planConfig, onSave }) {
  const base = planConfig && planConfig.sabjis && planConfig.sabjis.length === 3
    ? normalisePlanConfig(planConfig)
    : defaultPlanConfig();
  const [sabjis, setSabjis] = useState(base.sabjis.map(s => ({ ...s })));
  const [rice, setRice] = useState(base.rice || "");
  const [salad, setSalad] = useState(base.salad || "");
  const [raita, setRaita] = useState(base.raita || "");
  const [sweet, setSweet] = useState(base.sweet || "");
  const [prices, setPrices] = useState({ ...defaultPlanConfig().prices, ...(base.prices || {}) });
  const [enabled, setEnabled] = useState({ ...defaultPlanConfig().enabled, ...(base.enabled || {}) });
  const [photos, setPhotos] = useState({ ...defaultPlanConfig().photos, ...(base.photos || {}) });
  const [uploading, setUploading] = useState({ gold: false, standard: false, mini: false });
  const [uploadErr, setUploadErr] = useState("");
  const [saved, setSaved] = useState(false);

  const setSabjiName = (i, name) => setSabjis(prev => prev.map((s, idx) => idx === i ? { ...s, name } : s));
  const setPremium = (i) => setSabjis(prev => prev.map((s, idx) => ({ ...s, premium: idx === i })));
  const setPrice = (key, val) => setPrices(prev => ({ ...prev, [key]: val === "" ? "" : parseInt(val) || 0 }));
  const toggleEnabled = (key) => setEnabled(prev => ({ ...prev, [key]: !prev[key] }));

  const handlePhotoUpload = async (key, file) => {
    if (!file) return;
    setUploadErr("");
    if (!file.type.startsWith("image/")) { setUploadErr("Please select an image file"); return; }
    if (file.size > 10 * 1024 * 1024) { setUploadErr("Image too big (max 10 MB)"); return; }
    setUploading(prev => ({ ...prev, [key]: true }));
    try {
      const dataUrl = await resizeAndCompressImage(file);
      setPhotos(prev => ({ ...prev, [key]: dataUrl }));
    } catch (err) {
      setUploadErr("Could not process image");
    } finally {
      setUploading(prev => ({ ...prev, [key]: false }));
    }
  };
  const removePhoto = (key) => setPhotos(prev => ({ ...prev, [key]: "" }));

  const filledSabjis = sabjis.filter(s => s.name.trim()).length;
  const ready = filledSabjis === 3 && rice.trim() && salad.trim() && raita.trim() && sweet.trim();

  const handleSave = () => {
    onSave({
      date: todayStr(),
      sabjis: sabjis.map(s => ({ ...s, name: s.name.trim() })),
      rice: rice.trim(),
      salad: salad.trim(),
      raita: raita.trim(),
      sweet: sweet.trim(),
      prices: {
        gold: prices.gold || 0, goldLargeSurcharge: prices.goldLargeSurcharge || 0,
        standard: prices.standard || 0, mini: prices.mini || 0,
        raita: prices.raita || 0, salad: prices.salad || 0, sweet: prices.sweet || 0,
      },
      enabled: {
        goldMedium: !!enabled.goldMedium, goldLarge: !!enabled.goldLarge,
        standard: !!enabled.standard, mini: !!enabled.mini,
        raita: !!enabled.raita, salad: !!enabled.salad, sweet: !!enabled.sweet,
      },
      photos: { gold: photos.gold || "", standard: photos.standard || "", mini: photos.mini || "" },
    });
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  };

  const isPublishedToday = planConfig && planConfig.date === todayStr();

  // Small reusable toggle switch (used for Gold's two independent size toggles)
  const ToggleSwitch = ({ on, onClick, label }) => (
    <button
      onClick={onClick}
      style={{ position: "relative", width: 46, height: 26, borderRadius: 13, border: "none", background: on ? "#4CAF50" : "#BDBDBD", cursor: "pointer", transition: "background 0.2s", padding: 0, flexShrink: 0 }}
      aria-label={label}
    >
      <span style={{ position: "absolute", top: 3, left: on ? 23 : 3, width: 20, height: 20, borderRadius: "50%", background: C.white, transition: "left 0.2s", boxShadow: "0 2px 4px rgba(0,0,0,0.2)" }} />
    </button>
  );

  // Homely Gold: shares one photo, but Medium/Large have independent
  // availability toggles so one size can sell out while the other stays live.
  const GoldAvailabilityBlock = () => (
    <div style={{ padding: "14px 0", borderBottom: `1px solid ${C.border}` }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.ink, marginBottom: 10 }}>✨ Homely Gold</div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 10 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>Medium</div>
          <div style={{ fontSize: 11, color: C.inkLight }}>{enabled.goldMedium ? "Available for customers" : "Hidden — stocked out"}</div>
        </div>
        <ToggleSwitch on={!!enabled.goldMedium} onClick={() => toggleEnabled("goldMedium")} label="Toggle Homely Gold Medium" />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 10 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>Large</div>
          <div style={{ fontSize: 11, color: C.inkLight }}>{enabled.goldLarge ? "Available for customers" : "Hidden — stocked out"}</div>
        </div>
        <ToggleSwitch on={!!enabled.goldLarge} onClick={() => toggleEnabled("goldLarge")} label="Toggle Homely Gold Large" />
      </div>
      {/* Photo strip — shared between both sizes */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {photos.gold ? (
          <img src={photos.gold} alt="Homely Gold preview" style={{ width: 60, height: 60, objectFit: "cover", borderRadius: 8, border: `1px solid ${C.border}` }} />
        ) : (
          <div style={{ width: 60, height: 60, borderRadius: 8, background: C.cream, border: `1px dashed ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center", color: C.inkLight, fontSize: 20 }}>📷</div>
        )}
        <div style={{ flex: 1, display: "flex", gap: 6 }}>
          <label className="ht-btn btn-secondary btn-sm" style={{ cursor: "pointer" }}>
            {uploading.gold ? "Uploading…" : photos.gold ? "Change" : "Upload photo"}
            <input
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              disabled={uploading.gold}
              onChange={e => { handlePhotoUpload("gold", e.target.files?.[0]); e.target.value = ""; }}
            />
          </label>
          {photos.gold && (
            <button className="ht-btn btn-ghost btn-sm" style={{ color: C.red }} onClick={() => removePhoto("gold")}>Remove</button>
          )}
        </div>
      </div>
    </div>
  );

  // Reusable per-variant availability & photo row
  const VariantAvailabilityRow = ({ vkey, label }) => (
    <div style={{ padding: "14px 0", borderBottom: `1px solid ${C.border}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 10 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{label}</div>
          <div style={{ fontSize: 11, color: C.inkLight }}>{enabled[vkey] ? "Available for customers" : "Hidden — stocked out"}</div>
        </div>
        {/* Toggle switch */}
        <button
          onClick={() => toggleEnabled(vkey)}
          style={{ position: "relative", width: 46, height: 26, borderRadius: 13, border: "none", background: enabled[vkey] ? "#4CAF50" : "#BDBDBD", cursor: "pointer", transition: "background 0.2s", padding: 0, flexShrink: 0 }}
          aria-label={`Toggle ${label}`}
        >
          <span style={{ position: "absolute", top: 3, left: enabled[vkey] ? 23 : 3, width: 20, height: 20, borderRadius: "50%", background: C.white, transition: "left 0.2s", boxShadow: "0 2px 4px rgba(0,0,0,0.2)" }} />
        </button>
      </div>
      {/* Photo strip */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {photos[vkey] ? (
          <img src={photos[vkey]} alt={`${label} preview`} style={{ width: 60, height: 60, objectFit: "cover", borderRadius: 8, border: `1px solid ${C.border}` }} />
        ) : (
          <div style={{ width: 60, height: 60, borderRadius: 8, background: C.cream, border: `1px dashed ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center", color: C.inkLight, fontSize: 20 }}>📷</div>
        )}
        <div style={{ flex: 1, display: "flex", gap: 6 }}>
          <label className="ht-btn btn-secondary btn-sm" style={{ cursor: "pointer" }}>
            {uploading[vkey] ? "Uploading…" : photos[vkey] ? "Change" : "Upload photo"}
            <input
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              disabled={uploading[vkey]}
              onChange={e => { handlePhotoUpload(vkey, e.target.files?.[0]); e.target.value = ""; }}
            />
          </label>
          {photos[vkey] && (
            <button className="ht-btn btn-ghost btn-sm" style={{ color: C.red }} onClick={() => removePhoto(vkey)}>Remove</button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ padding: "20px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink }}>Today's Plans</h2>
          <p style={{ fontSize: 13, color: C.inkMid }}>{fmtDate(todayStr())} · Just fill sabjis + extras below — Gold, Standard &amp; Mini update automatically</p>
        </div>
      </div>

      {!isPublishedToday && (
        <div style={{ background: "#FFF8E1", border: "1px solid #FFE082", borderRadius: 10, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: "#8D6E00", fontWeight: 600 }}>
          ⚠️ Plans not published for today yet — customers won't see Homely Gold/Standard/Mini until you publish.
        </div>
      )}

      {/* Sabjis */}
      <div className="ht-card" style={{ padding: 20, marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 4 }}>🥘 Today's Sabjis (exactly 3)</h3>
        <p style={{ fontSize: 11, color: C.inkLight, marginBottom: 12 }}>
          Gold: choice of any 2 of these 3 (incl. Premium) · Standard: sabjis 1 &amp; 2 fixed (never Premium) · Mini: choice of sabji 1 or 2
        </p>
        {sabjis.map((s, i) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.inkLight, width: 18 }}>{i + 1}.</span>
            <input
              className="ht-input"
              placeholder={i === 2 ? "e.g. Paneer Butter Masala" : "e.g. Dal Tadka"}
              value={s.name}
              onChange={e => setSabjiName(i, e.target.value)}
              style={{ flex: 1 }}
            />
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 700, color: s.premium ? C.saffron : C.inkLight, cursor: "pointer", whiteSpace: "nowrap" }}>
              <input type="radio" name="premiumSabji" checked={s.premium} onChange={() => setPremium(i)} style={{ accentColor: C.saffron }} />
              ⭐ Premium
            </label>
          </div>
        ))}
      </div>

      {/* Rice / Salad / Raita / Sweet */}
      <div className="ht-card" style={{ padding: 20, marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 12 }}>🍚 Today's Extras</h3>
        <div style={{ display: "grid", gap: 10 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Flavoured Rice (Gold)</label>
            <input className="ht-input" placeholder="e.g. Jeera Rice" value={rice} onChange={e => setRice(e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Salad</label>
            <input className="ht-input" placeholder="e.g. Kachumber Salad" value={salad} onChange={e => setSalad(e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Raita</label>
            <input className="ht-input" placeholder="e.g. Boondi Raita" value={raita} onChange={e => setRaita(e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Sweet</label>
            <input className="ht-input" placeholder="e.g. Gulab Jamun" value={sweet} onChange={e => setSweet(e.target.value)} />
          </div>
        </div>
      </div>

      {/* Availability + Photos */}
      <div className="ht-card" style={{ padding: 20, marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 4 }}>🎛️ Plan Availability &amp; Photos</h3>
        <p style={{ fontSize: 11, color: C.inkLight, marginBottom: 12 }}>Turn a plan off if you're out of stock. Photos are optional — customers see them on the plan cards.</p>
        {uploadErr && <div style={{ background: C.redLight, color: C.red, padding: "6px 10px", borderRadius: 6, fontSize: 12, marginBottom: 10 }}>{uploadErr}</div>}
        <GoldAvailabilityBlock />
        <VariantAvailabilityRow vkey="standard" label="Homely Standard" />
        <VariantAvailabilityRow vkey="mini"     label="Homely Mini" />

        {/* Extras (no photo, just toggle) */}
        <div style={{ marginTop: 6, paddingTop: 14, borderTop: `1px dashed ${C.border}` }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.inkMid, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.3 }}>Today's Extras</div>
          {[
            { key: "raita", label: "Raita of the Day" },
            { key: "salad", label: "Salad of the Day" },
            { key: "sweet", label: "Sweet of the Day" },
          ].map(x => (
            <div key={x.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", gap: 10 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{x.label}</div>
                <div style={{ fontSize: 11, color: C.inkLight }}>{enabled[x.key] ? "Available for customers" : "Hidden — stocked out"}</div>
              </div>
              <button
                onClick={() => toggleEnabled(x.key)}
                style={{ position: "relative", width: 46, height: 26, borderRadius: 13, border: "none", background: enabled[x.key] ? "#4CAF50" : "#BDBDBD", cursor: "pointer", transition: "background 0.2s", padding: 0, flexShrink: 0 }}
                aria-label={`Toggle ${x.label}`}
              >
                <span style={{ position: "absolute", top: 3, left: enabled[x.key] ? 23 : 3, width: 20, height: 20, borderRadius: "50%", background: C.white, transition: "left 0.2s", boxShadow: "0 2px 4px rgba(0,0,0,0.2)" }} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Prices */}
      <div className="ht-card" style={{ padding: 20, marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 12 }}>💰 Prices</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Homely Gold (Medium) ₹</label>
            <input className="ht-input" type="number" value={prices.gold} onChange={e => setPrice("gold", e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>+ Large Surcharge ₹</label>
            <input className="ht-input" type="number" value={prices.goldLargeSurcharge} onChange={e => setPrice("goldLargeSurcharge", e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Homely Standard ₹</label>
            <input className="ht-input" type="number" value={prices.standard} onChange={e => setPrice("standard", e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Homely Mini ₹</label>
            <input className="ht-input" type="number" value={prices.mini} onChange={e => setPrice("mini", e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Raita (standalone) ₹</label>
            <input className="ht-input" type="number" value={prices.raita} onChange={e => setPrice("raita", e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Salad (standalone) ₹</label>
            <input className="ht-input" type="number" value={prices.salad} onChange={e => setPrice("salad", e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Sweet (standalone) ₹</label>
            <input className="ht-input" type="number" value={prices.sweet} onChange={e => setPrice("sweet", e.target.value)} />
          </div>
        </div>
      </div>

      <button className={`ht-btn ${saved ? "btn-green" : "btn-primary"} btn-full btn-lg`} onClick={handleSave} disabled={!ready}>
        {saved ? "✓ Published!" : ready ? "Publish Today's Plans" : "Fill all fields to publish"}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────
// CONTACT CENTER (owner) — edit contact channels + read customer messages
// ─────────────────────────────────────────────
function ContactCenter({ contactInfo, messages, onSave, onMarkRead, onDelete }) {
  const [phone, setPhone] = useState(contactInfo?.phone || "");
  const [whatsapp, setWhatsapp] = useState(contactInfo?.whatsapp || "");
  const [email, setEmail] = useState(contactInfo?.email || "");
  const [saved, setSaved] = useState(false);

  // Keep local form fields in sync with any realtime updates while owner isn't editing
  useEffect(() => {
    setPhone(contactInfo?.phone || "");
    setWhatsapp(contactInfo?.whatsapp || "");
    setEmail(contactInfo?.email || "");
  }, [contactInfo?.phone, contactInfo?.whatsapp, contactInfo?.email]);

  const handleSave = () => {
    onSave({ phone, whatsapp, email });
    setSaved(true); setTimeout(() => setSaved(false), 1600);
  };

  const list = (messages || []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));

  return (
    <div style={{ padding: "20px 0" }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink }}>Contact Center</h2>
        <p style={{ fontSize: 13, color: C.inkMid }}>Set the contact channels customers see, and review any messages they've sent you</p>
      </div>

      {/* Contact channel editor */}
      <div className="ht-card" style={{ padding: 20, marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 4 }}>📇 Your Contact Info</h3>
        <p style={{ fontSize: 11, color: C.inkLight, marginBottom: 12 }}>Leave any field blank to hide that channel from customers</p>
        <div style={{ display: "grid", gap: 10 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Phone (tap-to-call)</label>
            <input className="ht-input" placeholder="e.g. +91 98765 43210" value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>WhatsApp number</label>
            <input className="ht-input" placeholder="e.g. 9876543210 (10 digits, or with +91)" value={whatsapp} onChange={e => setWhatsapp(e.target.value)} inputMode="tel" />
            <div style={{ fontSize: 11, color: C.inkLight, marginTop: 4 }}>If left blank but Phone is set, WhatsApp will use the phone number.</div>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Email</label>
            <input className="ht-input" placeholder="e.g. hello@homelytiffins.com" value={email} onChange={e => setEmail(e.target.value)} inputMode="email" />
          </div>
        </div>
        <button className={`ht-btn ${saved ? "btn-green" : "btn-primary"} btn-full`} style={{ marginTop: 12 }} onClick={handleSave}>
          {saved ? "✓ Saved!" : "Save Contact Info"}
        </button>
      </div>

      {/* Messages inbox */}
      <div className="ht-card" style={{ padding: 20 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 4 }}>📥 Customer Messages ({list.length})</h3>
        <p style={{ fontSize: 11, color: C.inkLight, marginBottom: 14 }}>Messages sent through the "Contact Us" form on your homepage</p>

        {list.length === 0 && (
          <div style={{ padding: 24, textAlign: "center", color: C.inkLight, fontSize: 13 }}>
            No messages yet.
          </div>
        )}

        {list.map(m => (
          <div key={m.id} style={{
            padding: 14,
            borderRadius: 10,
            border: `1px solid ${m.read ? C.border : C.saffron}`,
            background: m.read ? C.white : C.saffronLight,
            marginBottom: 10,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 6 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>
                  {m.name || "Anonymous"}
                  {!m.read && <span style={{ marginLeft: 6, fontSize: 10, background: C.saffron, color: C.white, padding: "2px 6px", borderRadius: 4, fontWeight: 800 }}>NEW</span>}
                </div>
                {m.phone && (
                  <div style={{ fontSize: 12, color: C.inkMid, marginTop: 2 }}>
                    📞 <a href={`tel:${m.phone}`} style={{ color: C.inkMid, textDecoration: "none" }}>{m.phone}</a>
                  </div>
                )}
              </div>
              <div style={{ fontSize: 11, color: C.inkLight, textAlign: "right", whiteSpace: "nowrap" }}>
                {new Date(m.ts).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
              </div>
            </div>
            <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.5, whiteSpace: "pre-wrap", marginBottom: 10 }}>{m.message}</div>
            <div style={{ display: "flex", gap: 8 }}>
              {!m.read && (
                <button className="ht-btn btn-secondary btn-sm" onClick={() => onMarkRead(m.id)}>Mark read</button>
              )}
              {m.phone && (
                <a className="ht-btn btn-secondary btn-sm" href={`https://wa.me/${(m.phone || "").replace(/[^0-9]/g, "").length === 10 ? "91" + m.phone.replace(/[^0-9]/g, "") : m.phone.replace(/[^0-9]/g, "")}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>💬 WhatsApp</a>
              )}
              <button className="ht-btn btn-ghost btn-sm" style={{ color: C.red, marginLeft: "auto" }} onClick={() => { if (confirm("Delete this message?")) onDelete(m.id); }}>Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// PROMO CENTER (owner) — manage promo codes + referral programme
// ─────────────────────────────────────────────
function PromoCenter({ promoCodes = [], referralConfig, onSavePromoCodes, onSaveReferralConfig, todayOrders = [], ordersHistory = [] }) {
  const cfg = referralConfig || defaultReferralConfig();
  const [draft, setDraft] = useState({ code: "", type: "flat", value: "", description: "", minOrder: "" });
  const [error, setError] = useState("");

  // Referral programme editor — local copies so typing feels instant
  const [refEnabled, setRefEnabled] = useState(cfg.enabled !== false);
  const [refDiscount, setRefDiscount] = useState(String(cfg.referredDiscount ?? 30));
  const [refReward, setRefReward] = useState(String(cfg.referrerReward ?? 50));
  const [refMinOrder, setRefMinOrder] = useState(String(cfg.minOrder ?? 0));
  const [refSaved, setRefSaved] = useState(false);

  useEffect(() => {
    setRefEnabled(cfg.enabled !== false);
    setRefDiscount(String(cfg.referredDiscount ?? 30));
    setRefReward(String(cfg.referrerReward ?? 50));
    setRefMinOrder(String(cfg.minOrder ?? 0));
  }, [cfg.enabled, cfg.referredDiscount, cfg.referrerReward, cfg.minOrder]);

  // Count referral usage across today's orders + history so owner can see impact
  const allOrders = [...(todayOrders || []), ...(ordersHistory || [])];
  const referralUses = allOrders.filter(o => o.referralCode).length;
  const promoUses = allOrders.filter(o => o.promoCode).length;

  const handleAddCode = () => {
    setError("");
    const code = draft.code.trim().toUpperCase();
    if (!code) return setError("Enter a code");
    if (/^HT\d{8}$/i.test(code)) return setError("HT######## is reserved for referral codes");
    if (promoCodes.some(p => (p.code || "").toUpperCase() === code)) return setError("This code already exists");
    const value = Number(draft.value);
    if (!Number.isFinite(value) || value <= 0) return setError("Enter a valid discount value");
    if (draft.type === "percent" && value > 100) return setError("Percent must be 0–100");
    const minOrder = Number(draft.minOrder) || 0;
    const entry = {
      id: genId(),
      code,
      type: draft.type,
      value,
      description: draft.description.trim(),
      minOrder,
      active: true,
      createdAt: new Date().toISOString(),
    };
    onSavePromoCodes([entry, ...promoCodes]);
    setDraft({ code: "", type: "flat", value: "", description: "", minOrder: "" });
  };

  const handleToggle = (id) => {
    onSavePromoCodes(promoCodes.map(p => p.id === id ? { ...p, active: p.active === false ? true : false } : p));
  };
  const handleDelete = (id) => {
    if (!confirm("Delete this promo code? Past orders that used it are unaffected.")) return;
    onSavePromoCodes(promoCodes.filter(p => p.id !== id));
  };

  const handleSaveReferral = () => {
    const next = {
      enabled: refEnabled,
      referredDiscount: Math.max(0, Number(refDiscount) || 0),
      referrerReward: Math.max(0, Number(refReward) || 0),
      minOrder: Math.max(0, Number(refMinOrder) || 0),
    };
    onSaveReferralConfig(next);
    setRefSaved(true); setTimeout(() => setRefSaved(false), 1600);
  };

  return (
    <div style={{ padding: "20px 0" }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink }}>Promo &amp; Referrals</h2>
        <p style={{ fontSize: 13, color: C.inkMid }}>Create discount codes and manage the refer-a-friend programme</p>
      </div>

      {/* Usage stats */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
        <div className="ht-card" style={{ padding: 14, textAlign: "center" }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: C.saffron }}>{promoUses}</div>
          <div style={{ fontSize: 11, color: C.inkMid, marginTop: 2 }}>Promo redemptions</div>
        </div>
        <div className="ht-card" style={{ padding: 14, textAlign: "center" }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: C.saffron }}>{referralUses}</div>
          <div style={{ fontSize: 11, color: C.inkMid, marginTop: 2 }}>Referral redemptions</div>
        </div>
      </div>

      {/* Add new promo code */}
      <div className="ht-card" style={{ padding: 20, marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 4 }}>➕ Add promo code</h3>
        <p style={{ fontSize: 11, color: C.inkLight, marginBottom: 12 }}>
          Codes are case-insensitive. Customers enter them at checkout.
        </p>
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Code</label>
              <input
                className="ht-input"
                placeholder="e.g. WELCOME10"
                value={draft.code}
                onChange={e => setDraft(p => ({ ...p, code: e.target.value.toUpperCase() }))}
                style={{ textTransform: "uppercase" }}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Discount type</label>
              <select className="ht-select" value={draft.type} onChange={e => setDraft(p => ({ ...p, type: e.target.value }))}>
                <option value="flat">Flat ₹ off</option>
                <option value="percent">% off cart</option>
              </select>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>
                {draft.type === "percent" ? "Percent (0–100)" : "Amount (₹)"}
              </label>
              <input
                className="ht-input"
                type="number"
                inputMode="numeric"
                placeholder={draft.type === "percent" ? "e.g. 10" : "e.g. 50"}
                value={draft.value}
                onChange={e => setDraft(p => ({ ...p, value: e.target.value }))}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Min order ₹ (optional)</label>
              <input
                className="ht-input"
                type="number"
                inputMode="numeric"
                placeholder="0"
                value={draft.minOrder}
                onChange={e => setDraft(p => ({ ...p, minOrder: e.target.value }))}
              />
            </div>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Description (shown to customer)</label>
            <input
              className="ht-input"
              placeholder="e.g. Welcome offer — first order"
              value={draft.description}
              onChange={e => setDraft(p => ({ ...p, description: e.target.value }))}
              maxLength={80}
            />
          </div>
          {error && <p style={{ fontSize: 12, color: C.red }}>{error}</p>}
          <button className="ht-btn btn-primary btn-full" onClick={handleAddCode}>+ Add promo code</button>
        </div>
      </div>

      {/* Existing codes */}
      <div className="ht-card" style={{ padding: 20, marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 12 }}>
          Active codes ({promoCodes.filter(p => p.active !== false).length}/{promoCodes.length})
        </h3>
        {promoCodes.length === 0 && (
          <div style={{ padding: 20, textAlign: "center", color: C.inkLight, fontSize: 13 }}>
            No promo codes yet.
          </div>
        )}
        {promoCodes.map(p => (
          <div key={p.id} style={{
            padding: 12,
            borderRadius: 10,
            border: `1px solid ${p.active === false ? C.border : C.saffron}`,
            background: p.active === false ? "#FAFAFA" : C.white,
            marginBottom: 8,
            opacity: p.active === false ? 0.6 : 1,
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                  <code style={{ fontSize: 14, fontWeight: 800, color: C.saffron, background: C.saffronLight, padding: "2px 8px", borderRadius: 4 }}>{p.code}</code>
                  <span style={{ fontSize: 12, color: C.ink, fontWeight: 700 }}>
                    {p.type === "percent" ? `${p.value}% off` : `₹${p.value} off`}
                  </span>
                  {p.minOrder > 0 && <span style={{ fontSize: 10, color: C.inkLight }}>min ₹{p.minOrder}</span>}
                </div>
                {p.description && <div style={{ fontSize: 11, color: C.inkMid }}>{p.description}</div>}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button className="ht-btn btn-secondary btn-sm" onClick={() => handleToggle(p.id)}>
                  {p.active === false ? "Enable" : "Disable"}
                </button>
                <button className="ht-btn btn-ghost btn-sm" style={{ color: C.red }} onClick={() => handleDelete(p.id)}>Delete</button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Referral programme */}
      <div className="ht-card" style={{ padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>🎁 Referral programme</h3>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.inkMid, cursor: "pointer" }}>
            <input type="checkbox" checked={refEnabled} onChange={e => setRefEnabled(e.target.checked)} />
            <span>Enabled</span>
          </label>
        </div>
        <p style={{ fontSize: 11, color: C.inkLight, marginBottom: 12 }}>
          Each existing customer's referral code is <strong>HT + last 8 digits of their phone</strong> (e.g. HT91234567).
          New customers who enter it at checkout get an instant discount; the referrer gets credit added to their ledger
          once the new customer's order is delivered.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Discount for referred (₹)</label>
            <input className="ht-input" type="number" inputMode="numeric" value={refDiscount} onChange={e => setRefDiscount(e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Reward for referrer (₹)</label>
            <input className="ht-input" type="number" inputMode="numeric" value={refReward} onChange={e => setRefReward(e.target.value)} />
          </div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Minimum order to qualify (₹, 0 = none)</label>
          <input className="ht-input" type="number" inputMode="numeric" value={refMinOrder} onChange={e => setRefMinOrder(e.target.value)} />
        </div>
        <button className={`ht-btn ${refSaved ? "btn-green" : "btn-primary"} btn-full`} onClick={handleSaveReferral}>
          {refSaved ? "✓ Saved!" : "Save referral settings"}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// REJECT CONFIRM MODAL
// ─────────────────────────────────────────────
function RejectModal({ order, onConfirm, onClose }) {
  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-sheet" style={{ maxHeight: "auto" }}>
        <div style={{ textAlign: "center", padding: "8px 0 20px" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
          <h3 style={{ fontSize: 17, fontWeight: 800, color: C.ink, marginBottom: 6 }}>Reject this order?</h3>
          <p style={{ fontSize: 13, color: C.inkMid }}>
            Order from <strong>{order.customerName}</strong> ({order.tower}, Flat {order.flat}) will be marked as rejected.
            The customer will see this on their tracking page.
          </p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <button className="ht-btn btn-secondary btn-full" onClick={onClose}>Cancel</button>
          <button className="ht-btn btn-danger btn-full" onClick={onConfirm}>Yes, Reject</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// ORDER CARD (backend)
// ─────────────────────────────────────────────
const STATUS_FLOW = { pending: "preparing", preparing: "ready", ready: "dispatched", dispatched: "delivered" };
const STATUS_LABEL = { pending: "Accept & Prepare", preparing: "Mark Ready", ready: "Mark Dispatched", dispatched: "Mark Delivered" };

// ─────────────────────────────────────────────
// KOT (Kitchen Order Ticket) printing
// Opens a print-ready window laid out for an 80mm thermal
// printer. It also prints cleanly on a normal A4 printer via
// the browser's print dialog, so no special hardware is required.
// Ticket shows: customer name, delivery address, ordered items,
// and special instructions (only when present).
// ─────────────────────────────────────────────
// Parses the composed cart-item name string (built in PlanChoiceModal) into
// a structured shape so the KOT can print sub-bullets instead of one long line.
// Falls back to a plain title (no sub-bullets) for anything that doesn't match
// a known Homely Gold / Standard / Mini pattern (e.g. a la carte menu items).
function parseKotItem(rawName) {
  const name = String(rawName || "");

  // Homely Gold (Medium|Large) — bread, sabji1 + sabji2, rice, raita/sweet, salad
  let m = name.match(/^Homely Gold \(([^)]+)\) — (.+)$/);
  if (m) {
    const size = m[1];
    const [bread, sabjis, rice, raitaSweet, salad] = m[2].split(", ");
    return {
      title: `Homely Gold — ${size}`,
      sub: [bread, sabjis, raitaSweet, rice, salad].filter(Boolean),
    };
  }

  // Homely Standard [(2 chapatis extra)] — ...
  m = name.match(/^Homely Standard(?: \(([^)]+)\))? — /);
  if (m) {
    const variant = m[1];
    return {
      title: "Homely Standard",
      inline: variant ? "with 2 Extra Chapati" : "with Rice",
    };
  }

  // Homely Mini [(Rice)] — breadOrRice, sabji, salad
  m = name.match(/^Homely Mini(?: \(([^)]+)\))? — (.+)$/);
  if (m) {
    const parts = m[2].split(", ");
    const breadOrRice = parts[0];
    const sabji = parts[1];
    return {
      title: "Homely Mini",
      sub: [sabji, breadOrRice].filter(Boolean),
    };
  }

  // Not a plan item (e.g. a la carte) — print as-is, no sub-bullets.
  return { title: name };
}

function printKOT(order) {
  if (!order) return;

  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const address = `${order.tower} · Flat ${order.flat}`;
  const hasNote = order.specialInstructions && order.specialInstructions.trim().length > 0;

  const itemBlocks = (order.items || [])
    .map(i => {
      const parsed = parseKotItem(i.name);
      const subHtml = (parsed.sub || [])
        .map(line => `<div>${esc(line)}</div>`)
        .join("");
      const inlineHtml = parsed.inline
        ? `<div class="item-inline">(${esc(parsed.inline)})</div>`
        : "";
      return `<div class="item-block">
        <div class="item-head"><span>${esc(i.qty)}× ${esc(parsed.title)}</span></div>
        ${inlineHtml}
        ${subHtml ? `<div class="item-sub">${subHtml}</div>` : ""}
      </div>`;
    })
    .join("");

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>KOT</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    width: 80mm;
    font-family: 'Courier New', Courier, monospace;
    color: #000;
    padding: 6mm 4mm;
    font-weight: 700;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .center { text-align: center; }
  .divider { border-top: 1px dashed #000; margin: 8px 0; }
  .row { font-size: 19px; line-height: 1.55; word-break: break-word; font-weight: 700; }
  .label { font-weight: 700; }
  .item-block { margin-bottom: 12px; }
  .item-head { font-size: 18px; font-weight: 800; word-break: break-word; }
  .item-sub { font-size: 16px; font-weight: 700; padding-left: 14px; margin-top: 3px; line-height: 1.5; }
  .item-sub div::before { content: "› "; }
  .item-inline { font-size: 16px; font-weight: 700; padding-left: 14px; margin-top: 2px; }
  .note { font-size: 16px; font-weight: 700; border: 1.5px solid #000; padding: 5px 6px; margin-top: 6px; line-height: 1.4; }
  .note-label { font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
</style>
</head>
<body>
  <div class="row"><span class="label">Name:</span> ${esc(order.customerName)}</div>
  <div class="row"><span class="label">Deliver to:</span> ${esc(address)}</div>
  <div class="row"><span class="label">Phone:</span> ${esc(order.phone)}</div>
  <div class="divider"></div>
  ${itemBlocks}
  ${hasNote ? `<div class="note"><div class="note-label">Special Instructions</div>${esc(order.specialInstructions.trim())}</div>` : ""}
  <script>
    setTimeout(function () {
      window.focus();
      window.print();
    }, 120);
    window.onafterprint = function () { window.close(); };
  <\/script>
</body>
</html>`;

  const w = window.open("", "_blank", "width=380,height=640");
  if (!w) {
    alert("Please allow pop-ups for this site so the KOT can print.");
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

function OrderCard({ order, onAdvance, onReject, now }) {
  const [showRejectModal, setShowRejectModal] = useState(false);
  const next = STATUS_FLOW[order.status];
  const canReject = order.status === "pending" || order.status === "preparing" || order.status === "ready";
  const hasInstructions = order.specialInstructions && order.specialInstructions.trim().length > 0;
  const isActive = order.status !== "rejected" && order.status !== "delivered";

  // ── Live elapsed-time timer (since order was placed) ──
  const elapsedMs = (now || Date.now()) - new Date(order.createdAt).getTime();
  const elapsedMin = Math.max(0, Math.floor(elapsedMs / 60000));
  // Urgent: order has been in Preparing too long → demand attention
  const isUrgent = order.status === "preparing" && elapsedMin > 20;

  // Card highlight priority: URGENT (red) > has-note (blue) > default
  const cardBg = isUrgent
    ? "#FFEBEE"
    : (hasInstructions && isActive ? "#E3F2FD" : C.white);
  const cardBorder = order.status === "rejected"
    ? "#f5c6c6"
    : isUrgent
      ? "#EF5350"
      : (hasInstructions && isActive ? "#42A5F5" : C.border);

  return (
    <div className="ht-card slide-in" style={{
      padding: 18,
      marginBottom: 12,
      borderColor: cardBorder,
      background: cardBg,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2, flexWrap: "wrap" }}>
            <span style={{ fontSize: 15, fontWeight: 800, color: C.ink }}>{order.customerName}</span>
            <span className={`ht-badge badge-${order.status}`}>{order.status}</span>
            {hasInstructions && <span style={{ fontSize: 11, fontWeight: 700, color: "#0D47A1" }}>📝 NOTE</span>}
          </div>
          <div style={{ fontSize: 12, color: C.inkMid }}>{order.tower} · Flat {order.flat} · {order.phone}</div>
          <div style={{ fontSize: 12, color: C.inkLight }}>
            {fmtTime(order.createdAt)} · #{order.id.slice(-6).toUpperCase()}
            {isActive && (
              <span style={{
                marginLeft: 8,
                fontWeight: 800,
                color: isUrgent ? "#C62828" : C.saffron,
              }}>
                ⏱ {fmtElapsed(elapsedMin)}{isUrgent ? " ⚠️" : ""}
              </span>
            )}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.saffron }}>₹{order.total}</div>
          {(order.promoCode || order.referralCode) && (
            <div style={{
              marginTop: 2, fontSize: 10, fontWeight: 700, color: "#2E7D32",
              background: "#E8F5E9", border: "1px solid #C8E6C9",
              borderRadius: 4, padding: "2px 6px", display: "inline-block",
            }}>
              🏷 {order.promoCode ? `Promo: ${order.promoCode}` : `Referral: ${order.referralCode}`}
            </div>
          )}
        </div>
      </div>

      <div style={{ background: C.cream, borderRadius: 8, padding: "8px 12px", marginBottom: hasInstructions ? 8 : 12 }}>
        <ul style={{ margin: 0, paddingLeft: 18, listStyleType: "disc" }}>
          {order.items.map(i => (
            <li key={i.id} style={{ fontSize: 12, color: C.inkMid, lineHeight: 1.6 }}>{i.name} ×{i.qty}</li>
          ))}
        </ul>
      </div>

      {hasInstructions && (
        <div style={{
          background: "#FFF8E1",
          border: "1px solid #FFE082",
          borderLeft: "3px solid #FF6F00",
          borderRadius: 6,
          padding: "8px 12px",
          marginBottom: 12,
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#E65100", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>
            Special Instructions
          </div>
          <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.4 }}>
            {order.specialInstructions}
          </div>
        </div>
      )}

      {order.status === "rejected" && (
        <p style={{ fontSize: 12, color: C.red, fontWeight: 600 }}>✗ Order rejected</p>
      )}
      {order.status === "delivered" && (
        <div>
          <p style={{ fontSize: 12, color: C.green, fontWeight: 600, marginBottom: order.rating ? 8 : 0 }}>✓ Delivered</p>
          {order.rating && (
            <div style={{
              background: "#FFF8E1", border: "1px solid #FFE082",
              borderLeft: "3px solid #F4A261",
              borderRadius: 6, padding: "8px 12px",
            }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: order.rating.feedback ? 6 : 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: C.inkMid, textTransform: "uppercase", letterSpacing: 0.5 }}>Taste</span>
                  <StarDisplay value={order.rating.taste} size={13} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: C.ink }}>{order.rating.taste}/5</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: C.inkMid, textTransform: "uppercase", letterSpacing: 0.5 }}>Delivery</span>
                  <StarDisplay value={order.rating.delivery} size={13} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: C.ink }}>{order.rating.delivery}/5</span>
                </div>
              </div>
              {order.rating.feedback && (
                <p style={{ fontSize: 12, color: C.ink, lineHeight: 1.4, fontStyle: "italic" }}>
                  "{order.rating.feedback}"
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {(next || canReject) && order.status !== "rejected" && order.status !== "delivered" && (
        <div style={{ display: "flex", gap: 8 }}>
          {next && (
            <button
              className={`ht-btn btn-sm ${order.status === "pending" ? "btn-primary" : "btn-green"}`}
              onClick={() => onAdvance(order.id, next)}
            >
              {STATUS_LABEL[order.status]}
            </button>
          )}
          {(order.status === "preparing" || order.status === "ready" || order.status === "dispatched") && (
            <button className="ht-btn btn-secondary btn-sm" onClick={() => printKOT(order)}>
              🖨 Print KOT
            </button>
          )}
          {canReject && (
            <button className="ht-btn btn-danger btn-sm" onClick={() => setShowRejectModal(true)}>
              ✗ Reject
            </button>
          )}
        </div>
      )}

      {showRejectModal && (
        <RejectModal
          order={order}
          onConfirm={() => { setShowRejectModal(false); onReject(order.id); }}
          onClose={() => setShowRejectModal(false)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// ORDER DASHBOARD (backend)
// ─────────────────────────────────────────────
function OrderDashboard({ todayOrders, onAdvance, onReject }) {
  const [selectedStatus, setSelectedStatus] = useState(null);

  // ── Shared 30-second ticker for live order timers ──
  // One interval drives the elapsed-time display on every OrderCard.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  const counts = {
    pending:    todayOrders.filter(o => o.status === "pending").length,
    preparing:  todayOrders.filter(o => o.status === "preparing").length,
    ready:      todayOrders.filter(o => o.status === "ready").length,
    dispatched: todayOrders.filter(o => o.status === "dispatched").length,
    delivered:  todayOrders.filter(o => o.status === "delivered").length,
    rejected:   todayOrders.filter(o => o.status === "rejected").length,
  };

  const activeCount = counts.pending + counts.preparing + counts.ready + counts.dispatched;

  const STATUS_CONFIG = [
    { key: "pending",    label: "Pending",    emoji: "🕐", badgeCls: "badge-pending",    border: "#856404", bg: "#FFF3CD" },
    { key: "preparing",  label: "Preparing",  emoji: "👨‍🍳", badgeCls: "badge-preparing",  border: C.saffron, bg: C.saffronLight },
    { key: "ready",      label: "Ready",      emoji: "📦", badgeCls: "badge-ready",      border: "#0D47A1", bg: "#E3F2FD" },
    { key: "dispatched", label: "Dispatched", emoji: "🛵", badgeCls: "badge-dispatched", border: C.green,   bg: C.greenLight },
    { key: "delivered",  label: "Delivered",  emoji: "✅", badgeCls: "badge-delivered",  border: "#2E7D32", bg: "#E8F5E9" },
    { key: "rejected",   label: "Rejected",   emoji: "✗",  badgeCls: "badge-rejected",   border: C.red,     bg: C.redLight },
  ];

  // Determine which orders to show for selected status
  const getFilteredOrders = (status) => {
    return todayOrders.filter(o => o.status === status).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  };

  const selectedConfig = STATUS_CONFIG.find(s => s.key === selectedStatus);
  const filteredOrders = selectedStatus ? getFilteredOrders(selectedStatus) : [];

  // ── Kitchen prep summary (Preparing tab only) ──
  // The floating panel now has 4 tabs: All + three tower ranges. For each tab
  // we compute a pooled + separate prep list over just that group's orders.
  const [prepOpen, setPrepOpen] = useState(true);
  const [prepGroup, setPrepGroup] = useState("all");
  // Per-group data: { key, label, short, count, pooled, separate }
  let prepGroupData = [];
  if (selectedStatus === "preparing") {
    prepGroupData = PREP_GROUPS.map(g => {
      const groupOrders = g.key === "all"
        ? filteredOrders
        : filteredOrders.filter(o => {
            const n = towerNum(o.tower);
            return n >= g.min && n <= g.max;
          });
      const { pooled, separate } = computePrep(groupOrders);
      return { ...g, count: groupOrders.length, pooled, separate };
    });
  }
  const activeGroup =
    prepGroupData.find(g => g.key === prepGroup) || prepGroupData[0];

  return (
    <div style={{ padding: "20px 0" }}>
      {/* Top stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, marginBottom: 20 }}>
        {[
          { label: "Today's Orders", val: todayOrders.length, color: C.ink },
          { label: "Active Now",     val: activeCount,         color: C.saffron },
        ].map(s => (
          <div key={s.label} className="ht-card" style={{ padding: "12px 8px", textAlign: "center" }}>
            <div style={{ fontSize: 20, fontWeight: 900, color: s.color }}>{s.val}</div>
            <div style={{ fontSize: 10, color: C.inkMid, fontWeight: 600 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Clickable status pill cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 20 }}>
        {STATUS_CONFIG.map(s => {
          const isActive = selectedStatus === s.key;
          const count = counts[s.key];
          return (
            <button
              key={s.key}
              onClick={() => setSelectedStatus(isActive ? null : s.key)}
              style={{
                background: isActive ? s.bg : C.white,
                border: `2px solid ${isActive ? s.border : C.border}`,
                borderRadius: 12, padding: "12px 8px", cursor: "pointer",
                textAlign: "center", transition: "all 0.15s",
                boxShadow: isActive ? `0 0 0 3px ${s.border}22` : C.shadow,
                transform: isActive ? "translateY(-1px)" : "none",
              }}
            >
              <div style={{ fontSize: 20, marginBottom: 4 }}>{s.emoji}</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: isActive ? s.border : C.ink }}>{count}</div>
              <div style={{ fontSize: 10, fontWeight: 600, color: isActive ? s.border : C.inkMid, lineHeight: 1.3 }}>{s.label}</div>
            </button>
          );
        })}
      </div>

      {/* Order list for selected status */}
      {selectedStatus && (
        <div className="slide-in" style={selectedStatus === "preparing" && filteredOrders.length > 0 ? { paddingBottom: 64 } : undefined}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <h3 style={{ fontSize: 15, fontWeight: 800, color: C.ink }}>
              {selectedConfig.emoji} {selectedConfig.label}
              <span style={{ fontSize: 13, fontWeight: 500, color: C.inkMid, marginLeft: 8 }}>({filteredOrders.length} order{filteredOrders.length !== 1 ? "s" : ""})</span>
            </h3>
            <button className="ht-btn btn-ghost btn-sm" onClick={() => setSelectedStatus(null)} style={{ fontSize: 12 }}>✕ Close</button>
          </div>

          {filteredOrders.length === 0 ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: C.inkMid }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>✨</div>
              <p style={{ fontSize: 13 }}>No {selectedConfig.label.toLowerCase()} orders</p>
            </div>
          ) : (
            filteredOrders.map(o => <OrderCard key={o.id} order={o} onAdvance={onAdvance} onReject={onReject} now={now} />)
          )}

          {/* ── Floating kitchen prep summary (Preparing tab only) ── */}
          {/* Right-anchored panel with 4 tabs: All + three tower ranges. */}
          {selectedStatus === "preparing" && filteredOrders.length > 0 && activeGroup && (
            <div style={{
              position: "fixed",
              bottom: 16,
              right: 16,
              left: 16,
              marginLeft: "auto",
              width: "auto",
              maxWidth: 380,
              zIndex: 50,
            }}>
              <div style={{
                background: C.white,
                borderRadius: 16,
                boxShadow: "0 6px 24px rgba(0,0,0,0.22)",
                border: `2px solid ${C.saffron}`,
                overflow: "hidden",
              }}>
                {/* Header — toggles the whole panel open/closed */}
                <button
                  onClick={() => setPrepOpen(v => !v)}
                  style={{
                    width: "100%",
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "12px 16px",
                    background: C.saffron,
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 800, color: C.white }}>
                    👨‍🍳 Prepare Now ({filteredOrders.length} order{filteredOrders.length !== 1 ? "s" : ""})
                  </span>
                  <span style={{ fontSize: 14, color: C.white, fontWeight: 700 }}>{prepOpen ? "▾" : "▴"}</span>
                </button>

                {prepOpen && (
                  <>
                    {/* Tower-group tabs (right-aligned) */}
                    <div style={{
                      display: "flex",
                      justifyContent: "flex-end",
                      gap: 4,
                      padding: "8px 8px 0",
                      background: C.saffronLight,
                      flexWrap: "wrap",
                    }}>
                      {prepGroupData.map(g => {
                        const isActive = g.key === activeGroup.key;
                        return (
                          <button
                            key={g.key}
                            onClick={() => setPrepGroup(g.key)}
                            title={g.label}
                            style={{
                              flex: "1 1 0",
                              minWidth: 0,
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "center",
                              gap: 1,
                              padding: "6px 4px",
                              borderRadius: "8px 8px 0 0",
                              border: `1.5px solid ${isActive ? C.saffron : C.border}`,
                              borderBottom: isActive ? `1.5px solid ${C.white}` : `1.5px solid ${C.border}`,
                              background: isActive ? C.white : "transparent",
                              cursor: "pointer",
                              marginBottom: -1.5,
                            }}
                          >
                            <span style={{
                              fontSize: 12,
                              fontWeight: 800,
                              color: isActive ? C.saffron : C.inkMid,
                              whiteSpace: "nowrap",
                            }}>{g.short}</span>
                            <span style={{
                              fontSize: 10,
                              fontWeight: 700,
                              color: isActive ? C.saffron : C.inkLight,
                            }}>{g.count}</span>
                          </button>
                        );
                      })}
                    </div>

                    {/* Active tab's compiled list */}
                    <div style={{ padding: "12px 16px 14px", maxHeight: "45vh", overflowY: "auto", borderTop: `1.5px solid ${C.border}` }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: C.inkMid, marginBottom: 8 }}>
                        {activeGroup.label} · {activeGroup.count} order{activeGroup.count !== 1 ? "s" : ""}
                      </div>

                      {activeGroup.pooled.map(([name, qty]) => (
                        <div key={name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: `1px solid ${C.border}` }}>
                          <span style={{ fontSize: 14, color: C.ink, fontWeight: 600 }}>{name}</span>
                          <span style={{ fontSize: 15, color: C.saffron, fontWeight: 900 }}>×{qty}</span>
                        </div>
                      ))}

                      {activeGroup.separate.map(sep => (
                        <div key={sep.orderId} style={{ padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                          {sep.items.map(i => (
                            <div key={i.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                              <span style={{ fontSize: 14, color: C.ink, fontWeight: 600 }}>{i.name}</span>
                              <span style={{ fontSize: 15, color: C.saffron, fontWeight: 900 }}>×{i.qty}</span>
                            </div>
                          ))}
                          <div style={{ fontSize: 11, color: "#E65100", fontWeight: 700, marginTop: 2 }}>
                            📝 {sep.note}
                          </div>
                        </div>
                      ))}

                      {activeGroup.pooled.length === 0 && activeGroup.separate.length === 0 && (
                        <p style={{ fontSize: 12, color: C.inkLight, textAlign: "center", padding: "8px 0" }}>Nothing to prepare here</p>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {!selectedStatus && (
        <div style={{ textAlign: "center", padding: "28px 0", color: C.inkLight }}>
          <p style={{ fontSize: 13 }}>Tap a category above to view orders</p>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// ANALYTICS PANEL
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// SALES DASHBOARD  (Today / Weekly / Monthly)
// ─────────────────────────────────────────────
// Prep time     = preparingAt → readyAt      (actual cooking time)
// Ready wait    = readyAt → dispatchedAt     (time sitting ready before dispatch)
// Delivery time = dispatchedAt → deliveredAt
// All are only computed over orders that HAVE both timestamps — older
// orders placed before a given stage shipped won't have them, and are
// simply excluded from the average rather than breaking it.
function avgDurationMinutes(orders, fromField, toField) {
  const durations = orders
    .filter(o => o[fromField] && o[toField])
    .map(o => (new Date(o[toField]) - new Date(o[fromField])) / 60000)
    .filter(m => m >= 0 && m < 24 * 60); // sanity guard against bad data
  if (!durations.length) return null;
  return durations.reduce((s, m) => s + m, 0) / durations.length;
}
function fmtMinutes(m) {
  if (m == null) return "—";
  if (m < 60) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60), mm = Math.round(m % 60);
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

function SalesDashboardCard({ allOrders }) {
  const [period, setPeriod] = useState("today"); // "today" | "week" | "month"

  const { rangeOrders, label, trend } = (() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (period === "today") {
      const ds = todayStr();
      const orders = allOrders.filter(o => o.date === ds && o.status !== "rejected");
      // Hourly trend for today (orders placed per 3-hr block, 8am–11pm)
      const blocks = [[8,11,"8-11am"],[11,14,"11-2pm"],[14,17,"2-5pm"],[17,20,"5-8pm"],[20,23,"8-11pm"]];
      const trend = blocks.map(([from, to, lbl]) => {
        const cnt = orders.filter(o => {
          const h = new Date(o.createdAt).getHours();
          return h >= from && h < to;
        }).length;
        return { label: lbl, count: cnt, revenue: orders.filter(o => { const h = new Date(o.createdAt).getHours(); return h >= from && h < to; }).reduce((s, o) => s + o.total, 0) };
      });
      return { rangeOrders: orders, label: "Today", trend };
    }
    if (period === "week") {
      const start = getWeekStart();
      const orders = allOrders.filter(o => o.date >= start && o.status !== "rejected");
      const trend = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(start); d.setDate(d.getDate() + i);
        const ds = d.toISOString().split("T")[0];
        if (ds > todayStr()) return null;
        const dayOrders = orders.filter(o => o.date === ds);
        return { label: d.toLocaleDateString("en-IN", { weekday: "short" }), count: dayOrders.length, revenue: dayOrders.reduce((s, o) => s + o.total, 0) };
      }).filter(Boolean);
      return { rangeOrders: orders, label: "This Week", trend };
    }
    // month
    const start = getMonthStart();
    const orders = allOrders.filter(o => o.date >= start && o.status !== "rejected");
    // weekly buckets within the month so far
    const weeks = {};
    orders.forEach(o => {
      const d = new Date(o.date);
      const wk = Math.ceil(d.getDate() / 7);
      weeks[wk] = weeks[wk] || { count: 0, revenue: 0 };
      weeks[wk].count += 1; weeks[wk].revenue += o.total;
    });
    const trend = Object.keys(weeks).sort((a, b) => a - b).map(wk => ({ label: `Week ${wk}`, count: weeks[wk].count, revenue: weeks[wk].revenue }));
    return { rangeOrders: orders, label: "This Month", trend };
  })();

  const deliveredOrRejected = allOrders.filter(o => {
    if (period === "today") return o.date === todayStr();
    if (period === "week") return o.date >= getWeekStart();
    return o.date >= getMonthStart();
  });

  const totalOrders = rangeOrders.length;
  const revenue = rangeOrders.reduce((s, o) => s + o.total, 0);
  const aov = totalOrders ? revenue / totalOrders : 0;
  const rejectedCount = deliveredOrRejected.filter(o => o.status === "rejected").length;

  const itemMap = {};
  rangeOrders.forEach(o => o.items.forEach(i => {
    if (!itemMap[i.name]) itemMap[i.name] = { qty: 0, revenue: 0 };
    itemMap[i.name].qty += i.qty;
    itemMap[i.name].revenue += (i.price || 0) * i.qty;
  }));
  const itemRows = Object.entries(itemMap).sort((a, b) => b[1].qty - a[1].qty);

  const towerMap = {};
  rangeOrders.forEach(o => { towerMap[o.tower] = (towerMap[o.tower] || 0) + 1; });
  const towerRows = Object.entries(towerMap).sort((a, b) => b[1] - a[1]).slice(0, 6);

  const avgPrep = avgDurationMinutes(rangeOrders, "preparingAt", "readyAt");
  const avgReadyWait = avgDurationMinutes(rangeOrders, "readyAt", "dispatchedAt");
  const avgDeliv = avgDurationMinutes(rangeOrders, "dispatchedAt", "deliveredAt");
  const prepSampleSize = rangeOrders.filter(o => o.preparingAt && o.readyAt).length;
  const readyWaitSampleSize = rangeOrders.filter(o => o.readyAt && o.dispatchedAt).length;
  const delivSampleSize = rangeOrders.filter(o => o.dispatchedAt && o.deliveredAt).length;

  const maxTrendVal = Math.max(...trend.map(t => t.revenue), 1);

  return (
    <div>
      {/* Period switcher */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {[["today", "Today"], ["week", "Weekly"], ["month", "Monthly"]].map(([key, lbl]) => (
          <button
            key={key}
            onClick={() => setPeriod(key)}
            className="ht-btn btn-sm"
            style={{
              flex: 1,
              background: period === key ? C.saffron : C.white,
              color: period === key ? C.white : C.inkMid,
              border: `1.5px solid ${period === key ? C.saffron : C.border}`,
            }}
          >
            {lbl}
          </button>
        ))}
      </div>

      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
        <div className="ht-card" style={{ padding: 14 }}>
          <p style={{ fontSize: 11, color: C.inkLight, marginBottom: 4 }}>💰 Revenue ({label})</p>
          <p style={{ fontSize: 22, fontWeight: 800, color: C.green }}>₹{revenue.toLocaleString("en-IN")}</p>
        </div>
        <div className="ht-card" style={{ padding: 14 }}>
          <p style={{ fontSize: 11, color: C.inkLight, marginBottom: 4 }}>📦 Orders</p>
          <p style={{ fontSize: 22, fontWeight: 800, color: C.ink }}>{totalOrders}{rejectedCount ? <span style={{ fontSize: 12, fontWeight: 600, color: C.red }}> ({rejectedCount} rejected)</span> : null}</p>
        </div>
        <div className="ht-card" style={{ padding: 14 }}>
          <p style={{ fontSize: 11, color: C.inkLight, marginBottom: 4 }}>🧾 Avg Order Value</p>
          <p style={{ fontSize: 22, fontWeight: 800, color: C.saffron }}>₹{aov.toFixed(0)}</p>
        </div>
        <div className="ht-card" style={{ padding: 14 }}>
          <p style={{ fontSize: 11, color: C.inkLight, marginBottom: 4 }}>🏢 Towers Served</p>
          <p style={{ fontSize: 22, fontWeight: 800, color: C.ink }}>{Object.keys(towerMap).length}</p>
        </div>
      </div>

      {/* Prep / ready-wait / delivery time */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
        <div className="ht-card" style={{ padding: 14 }}>
          <p style={{ fontSize: 11, color: C.inkLight, marginBottom: 4 }}>👨‍🍳 Avg Prep Time</p>
          <p style={{ fontSize: 20, fontWeight: 800, color: C.ink }}>{fmtMinutes(avgPrep)}</p>
          <p style={{ fontSize: 10, color: C.inkLight, marginTop: 2 }}>{prepSampleSize ? `from ${prepSampleSize} order${prepSampleSize !== 1 ? "s" : ""}` : "no data yet"}</p>
        </div>
        <div className="ht-card" style={{ padding: 14 }}>
          <p style={{ fontSize: 11, color: C.inkLight, marginBottom: 4 }}>📦 Avg Ready Wait</p>
          <p style={{ fontSize: 20, fontWeight: 800, color: C.ink }}>{fmtMinutes(avgReadyWait)}</p>
          <p style={{ fontSize: 10, color: C.inkLight, marginTop: 2 }}>{readyWaitSampleSize ? `from ${readyWaitSampleSize} order${readyWaitSampleSize !== 1 ? "s" : ""}` : "no data yet"}</p>
        </div>
        <div className="ht-card" style={{ padding: 14 }}>
          <p style={{ fontSize: 11, color: C.inkLight, marginBottom: 4 }}>🛵 Avg Delivery Time</p>
          <p style={{ fontSize: 20, fontWeight: 800, color: C.ink }}>{fmtMinutes(avgDeliv)}</p>
          <p style={{ fontSize: 10, color: C.inkLight, marginTop: 2 }}>{delivSampleSize ? `from ${delivSampleSize} order${delivSampleSize !== 1 ? "s" : ""}` : "no data yet"}</p>
        </div>
      </div>

      {/* Trend chart */}
      <div className="ht-card" style={{ padding: 16, marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 12 }}>📈 Revenue Trend</h3>
        {trend.length === 0 ? <p style={{ fontSize: 12, color: C.inkLight }}>No data yet</p> : (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 100 }}>
            {trend.map((t, i) => (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <div style={{ fontSize: 9, color: C.inkLight }}>{t.revenue > 0 ? `₹${t.revenue}` : ""}</div>
                <div style={{ width: "100%", height: Math.max((t.revenue / maxTrendVal) * 60, t.revenue > 0 ? 4 : 1), background: t.revenue > 0 ? C.saffron : C.border, borderRadius: 3 }} />
                <div style={{ fontSize: 9, color: C.inkMid, fontWeight: 600 }}>{t.label}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Item-wise sales */}
      <div className="ht-card" style={{ padding: 16, marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 12 }}>🍽️ Item-wise Sales</h3>
        {itemRows.length === 0 ? <p style={{ fontSize: 12, color: C.inkLight }}>No data yet</p> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `2px solid ${C.border}` }}>
                  <th style={{ padding: "6px 8px", textAlign: "left", color: C.inkMid, fontWeight: 600 }}>Item</th>
                  <th style={{ padding: "6px 8px", textAlign: "right", color: C.inkMid, fontWeight: 600 }}>Qty Sold</th>
                  <th style={{ padding: "6px 8px", textAlign: "right", color: C.inkMid, fontWeight: 600 }}>Revenue</th>
                </tr>
              </thead>
              <tbody>
                {itemRows.map(([name, d], i) => (
                  <tr key={name} style={{ borderBottom: `1px solid ${C.border}`, background: i % 2 === 0 ? C.white : C.cream }}>
                    <td style={{ padding: "6px 8px", color: C.ink, fontWeight: 600 }}>{name}</td>
                    <td style={{ padding: "6px 8px", textAlign: "right", color: C.saffron, fontWeight: 700 }}>{d.qty}×</td>
                    <td style={{ padding: "6px 8px", textAlign: "right", color: C.green, fontWeight: 700 }}>₹{d.revenue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Tower-wise */}
      <div className="ht-card" style={{ padding: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 12 }}>🏢 Tower-wise Orders</h3>
        {towerRows.length === 0 ? <p style={{ fontSize: 12, color: C.inkLight }}>No data yet</p> :
          towerRows.map(([tower, count]) => (
            <div key={tower} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "4px 0" }}>
              <span style={{ color: C.inkMid }}>{tower}</span>
              <span style={{ fontWeight: 700, color: C.green }}>{count} orders</span>
            </div>
          ))}
      </div>
    </div>
  );
}

function AnalyticsPanel({ todayOrders, ordersHistory, customers, onResetAllData }) {
  const [analyticsTab, setAnalyticsTab] = useState("overview"); // "overview" | "sales"
  const EXPORT_PIN = "2018";

  // Combine archived history with today's live orders, de-duplicated by order id.
  const allOrders = (() => {
    const seen = new Set();
    const merged = [];
    [...(ordersHistory || []), ...(todayOrders || [])].forEach(o => {
      if (o && o.id && !seen.has(o.id)) { seen.add(o.id); merged.push(o); }
    });
    return merged;
  })();

  // ── PIN gate for exports ──
  const [pinFor, setPinFor]     = useState(null); // "daily" | "range" | "customers"
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState("");

  // ── Custom date-range modal ──
  const todayS   = todayStr();
  const minDateS = (() => { const d = new Date(); d.setMonth(d.getMonth() - 3); return d.toISOString().split("T")[0]; })();
  const [showRange, setShowRange] = useState(false);
  const [fromDate, setFromDate]   = useState(minDateS);
  const [toDate, setToDate]       = useState(todayS);
  const [rangeError, setRangeError] = useState("");

  // ── Full reset modal ──
  const [showReset, setShowReset] = useState(false);
  const [resetText, setResetText] = useState("");

  const openPin = (which) => { setPinFor(which); setPinInput(""); setPinError(""); };

  const confirmPin = () => {
    if (pinInput !== EXPORT_PIN) { setPinError("Wrong PIN. Try again."); return; }
    const which = pinFor;
    setPinFor(null); setPinInput(""); setPinError("");
    if (which === "daily")     exportDailyReport(allOrders, todayS);
    if (which === "customers") exportCustomerMaster(customers);
    if (which === "range")     { setRangeError(""); setShowRange(true); }
  };

  const confirmRange = () => {
    if (!fromDate || !toDate) { setRangeError("Pick both dates."); return; }
    if (fromDate > toDate)    { setRangeError("‘From’ date must be on or before ‘To’ date."); return; }
    exportOrdersRange(allOrders, fromDate, toDate);
    setShowRange(false);
  };

  const resetReady = resetText.trim().toLowerCase() === "data reset";
  const confirmReset = () => {
    if (!resetReady) return;
    onResetAllData();
    setShowReset(false); setResetText("");
    alert("All data has been reset. The app is now fresh for the new month.");
  };

  const sortedCustomers = [...customers].sort((a, b) => b.totalSpent - a.totalSpent).slice(0, 10);
  const last7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - i);
    const ds = d.toISOString().split("T")[0];
    const dayOrders = allOrders.filter(o => o.date === ds && o.status !== "rejected");
    return { date: d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric" }), count: dayOrders.length, revenue: dayOrders.reduce((s, o) => s + o.total, 0) };
  }).reverse();
  const maxRev = Math.max(...last7.map(d => d.revenue), 1);
  const itemCounts = {}; allOrders.filter(o => o.status !== "rejected").forEach(o => o.items.forEach(i => { itemCounts[i.name] = (itemCounts[i.name] || 0) + i.qty; }));
  const topItems = Object.entries(itemCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const towerMap = {}; allOrders.filter(o => o.status !== "rejected").forEach(o => { towerMap[o.tower] = (towerMap[o.tower] || 0) + 1; });
  const topTowers = Object.entries(towerMap).sort((a, b) => b[1] - a[1]).slice(0, 6);

  // ── Rating aggregates ──
  const ratedOrders = allOrders.filter(o => o.rating && typeof o.rating.taste === "number" && typeof o.rating.delivery === "number");
  const ratingsCount = ratedOrders.length;
  const avgTaste    = ratingsCount ? ratedOrders.reduce((s, o) => s + o.rating.taste, 0) / ratingsCount : 0;
  const avgDelivery = ratingsCount ? ratedOrders.reduce((s, o) => s + o.rating.delivery, 0) / ratingsCount : 0;
  const deliveredCount = allOrders.filter(o => o.status === "delivered").length;
  const responseRate = deliveredCount ? Math.round((ratingsCount / deliveredCount) * 100) : 0;
  // Most recent rated orders, newest first
  const recentReviews = [...ratedOrders]
    .sort((a, b) => new Date(b.rating.ratedAt) - new Date(a.rating.ratedAt))
    .slice(0, 8);

  return (
    <div style={{ padding: "20px 0" }}>
      {/* Sub-tab switcher: Overview vs Sales Dashboard */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {[["overview", "📊 Overview"], ["sales", "📈 Sales Dashboard"]].map(([key, lbl]) => (
          <button
            key={key}
            onClick={() => setAnalyticsTab(key)}
            className="ht-btn"
            style={{
              flex: 1,
              background: analyticsTab === key ? C.ink : C.white,
              color: analyticsTab === key ? C.white : C.inkMid,
              border: `1.5px solid ${analyticsTab === key ? C.ink : C.border}`,
            }}
          >
            {lbl}
          </button>
        ))}
      </div>

      {analyticsTab === "sales" && <SalesDashboardCard allOrders={allOrders} />}

      {analyticsTab === "overview" && <>
      <div className="ht-card" style={{ padding: 20, marginBottom: 20 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: C.ink, marginBottom: 4 }}>📥 Export to Excel</h3>
        <p style={{ fontSize: 11, color: C.inkLight, marginBottom: 14 }}>🔒 PIN-protected. Each download asks for your PIN.</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
          <button className="ht-btn btn-secondary btn-sm" onClick={() => openPin("daily")} style={{ justifyContent: "flex-start" }}>
            📋 Daily Order Summary <span style={{ color: C.inkLight, fontWeight: 500, marginLeft: 4 }}>— all of today's orders</span>
          </button>
          <button className="ht-btn btn-secondary btn-sm" onClick={() => openPin("range")} style={{ justifyContent: "flex-start" }}>
            📅 Custom Date Range <span style={{ color: C.inkLight, fontWeight: 500, marginLeft: 4 }}>— any span, last 3 months</span>
          </button>
          <button className="ht-btn btn-secondary btn-sm" onClick={() => openPin("customers")} style={{ justifyContent: "flex-start" }}>
            👥 Customer Master <span style={{ color: C.inkLight, fontWeight: 500, marginLeft: 4 }}>— all customer details</span>
          </button>
        </div>
        <p style={{ fontSize: 11, color: C.inkLight, marginTop: 10 }}>CSV files open directly in Excel for pivot tables and analysis.</p>
      </div>

      {/* PIN modal */}
      {pinFor && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setPinFor(null); }}>
          <div className="modal-sheet">
            <div style={{ width: 40, height: 4, borderRadius: 2, background: C.border, margin: "0 auto 20px" }} />
            <h3 style={{ fontSize: 17, fontWeight: 800, color: C.ink, marginBottom: 6 }}>🔒 Enter PIN to Download</h3>
            <p style={{ fontSize: 13, color: C.inkMid, marginBottom: 16 }}>This report is protected. Enter your security PIN to continue.</p>
            <input
              className="ht-input"
              type="password"
              inputMode="numeric"
              autoFocus
              placeholder="Enter PIN"
              value={pinInput}
              onChange={e => { setPinInput(e.target.value); setPinError(""); }}
              onKeyDown={e => { if (e.key === "Enter") confirmPin(); }}
              style={{ marginBottom: pinError ? 6 : 16, textAlign: "center", letterSpacing: 4, fontSize: 18 }}
            />
            {pinError && <p style={{ fontSize: 12, color: C.red, marginBottom: 12 }}>{pinError}</p>}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <button className="ht-btn btn-secondary btn-full" onClick={() => setPinFor(null)}>Cancel</button>
              <button className="ht-btn btn-primary btn-full" onClick={confirmPin}>Unlock</button>
            </div>
          </div>
        </div>
      )}

      {/* Date-range modal */}
      {showRange && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowRange(false); }}>
          <div className="modal-sheet">
            <div style={{ width: 40, height: 4, borderRadius: 2, background: C.border, margin: "0 auto 20px" }} />
            <h3 style={{ fontSize: 17, fontWeight: 800, color: C.ink, marginBottom: 6 }}>📅 Custom Date Range</h3>
            <p style={{ fontSize: 13, color: C.inkMid, marginBottom: 16 }}>Pick a start and end date. Available for the last 3 months.</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: rangeError ? 6 : 16 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 5 }}>From</label>
                <input className="ht-input" type="date" min={minDateS} max={todayS} value={fromDate} onChange={e => { setFromDate(e.target.value); setRangeError(""); }} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 5 }}>To</label>
                <input className="ht-input" type="date" min={minDateS} max={todayS} value={toDate} onChange={e => { setToDate(e.target.value); setRangeError(""); }} />
              </div>
            </div>
            {rangeError && <p style={{ fontSize: 12, color: C.red, marginBottom: 12 }}>{rangeError}</p>}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <button className="ht-btn btn-secondary btn-full" onClick={() => setShowRange(false)}>Cancel</button>
              <button className="ht-btn btn-primary btn-full" onClick={confirmRange}>⬇ Download</button>
            </div>
          </div>
        </div>
      )}

      <div className="ht-card" style={{ padding: 20, marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: C.ink, marginBottom: 14 }}>Revenue — Last 7 Days</h3>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 80 }}>
          {last7.map((d, i) => (
            <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div style={{ fontSize: 10, color: C.inkLight }}>₹{d.revenue}</div>
              <div style={{ width: "100%", height: `${Math.max((d.revenue / maxRev) * 60, d.revenue > 0 ? 4 : 0)}px`, background: i === 6 ? C.saffron : C.border, borderRadius: "3px 3px 0 0", minHeight: d.revenue > 0 ? 4 : 0 }} />
              <div style={{ fontSize: 10, color: C.inkMid, textAlign: "center" }}>{d.date}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Customer Ratings section */}
      <div className="ht-card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: C.ink }}>⭐ Customer Ratings</h3>
          <span style={{ fontSize: 11, color: C.inkLight }}>
            {ratingsCount} of {deliveredCount} delivered · {responseRate}% response
          </span>
        </div>

        {ratingsCount === 0 ? (
          <div style={{ textAlign: "center", padding: "20px 0", color: C.inkMid }}>
            <div style={{ fontSize: 28, marginBottom: 6, opacity: 0.5 }}>⭐</div>
            <p style={{ fontSize: 13 }}>No ratings yet — customers will be prompted to rate on their next visit.</p>
          </div>
        ) : (
          <>
            {/* Averages */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
              <div style={{ background: C.cream, borderRadius: 10, padding: "14px 12px", textAlign: "center", border: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.inkMid, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Taste & Quality</div>
                <div style={{ fontSize: 22, fontWeight: 900, color: C.ink, lineHeight: 1, marginBottom: 4 }}>{avgTaste.toFixed(1)}<span style={{ fontSize: 12, color: C.inkLight, fontWeight: 600 }}>/5</span></div>
                <StarDisplay value={avgTaste} size={14} />
              </div>
              <div style={{ background: C.cream, borderRadius: 10, padding: "14px 12px", textAlign: "center", border: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.inkMid, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Delivery Time</div>
                <div style={{ fontSize: 22, fontWeight: 900, color: C.ink, lineHeight: 1, marginBottom: 4 }}>{avgDelivery.toFixed(1)}<span style={{ fontSize: 12, color: C.inkLight, fontWeight: 600 }}>/5</span></div>
                <StarDisplay value={avgDelivery} size={14} />
              </div>
            </div>

            {/* Recent reviews */}
            <div style={{ fontSize: 12, fontWeight: 700, color: C.inkMid, marginBottom: 8 }}>RECENT REVIEWS</div>
            {recentReviews.map(o => (
              <div key={o.id} style={{ borderBottom: `1px solid ${C.border}`, padding: "10px 0" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4, gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>{o.customerName}</div>
                    <div style={{ fontSize: 11, color: C.inkLight }}>{o.tower} · Flat {o.flat} · {new Date(o.rating.ratedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-end", flexShrink: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: C.inkMid }}>
                      <span>Taste</span><StarDisplay value={o.rating.taste} size={11} />
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: C.inkMid }}>
                      <span>Delivery</span><StarDisplay value={o.rating.delivery} size={11} />
                    </div>
                  </div>
                </div>
                {o.rating.feedback && (
                  <p style={{ fontSize: 12, color: C.ink, lineHeight: 1.4, fontStyle: "italic", marginTop: 4 }}>
                    "{o.rating.feedback}"
                  </p>
                )}
              </div>
            ))}
          </>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <div className="ht-card" style={{ padding: 16 }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 12 }}>🔥 Top Items</h3>
          {topItems.length === 0 ? <p style={{ fontSize: 12, color: C.inkLight }}>No data yet</p> :
            topItems.map(([name, qty]) => (
              <div key={name} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "4px 0" }}>
                <span style={{ color: C.inkMid }}>{name}</span>
                <span style={{ fontWeight: 700, color: C.saffron }}>{qty}×</span>
              </div>
            ))}
        </div>
        <div className="ht-card" style={{ padding: 16 }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 12 }}>🏢 Top Towers</h3>
          {topTowers.length === 0 ? <p style={{ fontSize: 12, color: C.inkLight }}>No data yet</p> :
            topTowers.map(([tower, count]) => (
              <div key={tower} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "4px 0" }}>
                <span style={{ color: C.inkMid }}>{tower}</span>
                <span style={{ fontWeight: 700, color: C.green }}>{count} orders</span>
              </div>
            ))}
        </div>
      </div>

      <div className="ht-card" style={{ padding: 20 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: C.ink, marginBottom: 14 }}>🏆 Top Customers</h3>
        {sortedCustomers.length === 0 ? <p style={{ fontSize: 13, color: C.inkLight }}>No customer data yet</p> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: `2px solid ${C.border}` }}>
                  {["Name", "Phone", "Tower/Flat", "Orders", "Spent"].map(h => (
                    <th key={h} style={{ padding: "8px 10px", textAlign: "left", color: C.inkMid, fontWeight: 600, fontSize: 12 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedCustomers.map((c, i) => (
                  <tr key={c.phone} style={{ borderBottom: `1px solid ${C.border}`, background: i % 2 === 0 ? C.white : C.cream }}>
                    <td style={{ padding: "8px 10px", fontWeight: 600, color: C.ink }}>{c.name}</td>
                    <td style={{ padding: "8px 10px", color: C.inkMid }}>{c.phone}</td>
                    <td style={{ padding: "8px 10px", color: C.inkMid }}>{c.tower}/{c.flat}</td>
                    <td style={{ padding: "8px 10px", fontWeight: 700, color: C.saffron }}>{c.totalOrders}</td>
                    <td style={{ padding: "8px 10px", fontWeight: 700, color: C.green }}>₹{c.totalSpent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="ht-card" style={{ padding: 20, marginTop: 20, border: `1.5px solid ${C.red}`, background: C.redLight }}>
        <h3 style={{ fontSize: 15, fontWeight: 800, color: C.red, marginBottom: 6 }}>⚠️ Danger Zone — Monthly Reset</h3>
        <p style={{ fontSize: 12, color: C.inkMid, lineHeight: 1.6, marginBottom: 14 }}>
          Clears <strong>all orders, order history, customers and the credit ledger</strong> so the app starts fresh.
          Your <strong>menu and settings are kept</strong>. Export anything you want to save first — this cannot be undone.
        </p>
        <button className="ht-btn btn-danger btn-sm" onClick={() => { setShowReset(true); setResetText(""); }}>
          🗑 Reset All Data
        </button>
      </div>

      {/* Reset confirmation modal — must type "data reset" */}
      {showReset && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowReset(false); }}>
          <div className="modal-sheet">
            <div style={{ width: 40, height: 4, borderRadius: 2, background: C.border, margin: "0 auto 20px" }} />
            <div style={{ textAlign: "center", marginBottom: 16 }}>
              <div style={{ fontSize: 40, marginBottom: 10 }}>⚠️</div>
              <h3 style={{ fontSize: 18, fontWeight: 800, color: C.red, marginBottom: 8 }}>Reset Everything?</h3>
              <p style={{ fontSize: 13, color: C.inkMid, lineHeight: 1.6 }}>
                This permanently deletes all orders, order history, customers and the credit ledger.
                Your menu and settings stay. <strong>This cannot be undone.</strong>
              </p>
            </div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 5 }}>
              Type <strong>data reset</strong> below to confirm
            </label>
            <input
              className="ht-input"
              autoFocus
              placeholder="data reset"
              value={resetText}
              onChange={e => setResetText(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && resetReady) confirmReset(); }}
              style={{ marginBottom: 16 }}
            />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <button className="ht-btn btn-secondary btn-full" onClick={() => { setShowReset(false); setResetText(""); }}>Cancel</button>
              <button
                className="ht-btn btn-danger btn-full"
                onClick={confirmReset}
                disabled={!resetReady}
                style={{ opacity: resetReady ? 1 : 0.5, cursor: resetReady ? "pointer" : "not-allowed" }}
              >
                Yes, Reset All
              </button>
            </div>
          </div>
        </div>
      )}
      </>}
    </div>
  );
}

// ─────────────────────────────────────────────
// FEEDBACK / POLLS PANEL  (owner-only)
// ─────────────────────────────────────────────
// Owner composes ONE customer poll (question + choices), switches it on/off,
// and reviews results here. Results are NEVER shown in the customer app.
function FeedbackPanel({ poll, pollResponses = [], onSavePoll, onTogglePoll, onClearResponses }) {
  const FEEDBACK_PIN = "2018";
  const [question, setQuestion] = useState(poll?.question || "");
  const [options, setOptions] = useState(
    poll?.options && poll.options.length ? [...poll.options] : ["", ""]
  );
  const [flash, setFlash] = useState("");

  // Clear-responses PIN modal
  const [showClear, setShowClear] = useState(false);
  const [clearPin, setClearPin] = useState("");
  const [clearErr, setClearErr] = useState("");

  const cleanOptions = options.map(o => (o || "").trim()).filter(o => o.length > 0);
  const savedOptions = (poll?.options || []).filter(o => o && o.trim());
  const dirty =
    question.trim() !== (poll?.question || "").trim() ||
    JSON.stringify(cleanOptions) !== JSON.stringify(savedOptions);

  const live = isPollLive(poll);

  const setOpt = (idx, val) => setOptions(prev => prev.map((o, i) => (i === idx ? val : o)));
  const addOpt = () => setOptions(prev => (prev.length >= 6 ? prev : [...prev, ""]));
  const removeOpt = (idx) => setOptions(prev => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));

  const handleSave = () => {
    if (question.trim().length === 0) { setFlash("Add a question first."); return; }
    onSavePoll({ question: question.trim(), options: cleanOptions });
    setFlash("Saved!");
    setTimeout(() => setFlash(""), 2500);
  };

  // ── Results (current poll only) ──
  const currentId = poll?.id || null;
  const forThisPoll = pollResponses.filter(r => currentId && r.pollId === currentId);
  const olderCount = pollResponses.length - forThisPoll.length;
  const totalResp = forThisPoll.length;
  const tally = savedOptions.map(opt => ({
    opt,
    count: forThisPoll.filter(r => r.choice === opt).length,
  }));
  const noChoiceCount = forThisPoll.filter(r => !r.choice || !r.choice.trim()).length;
  const feedbackList = forThisPoll
    .filter(r => r.feedback && r.feedback.trim())
    .sort((a, b) => new Date(b.at) - new Date(a.at));
  const maxCount = Math.max(1, ...tally.map(t => t.count), noChoiceCount);

  const handleExport = () => {
    if (!pollResponses.length) return;
    const rows = [...pollResponses]
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .map(r => ({
        "Date": r.at ? new Date(r.at).toLocaleString("en-IN") : "",
        "Question": r.pollQuestion || "",
        "Choice": r.choice || "",
        "Feedback": r.feedback || "",
        "Name": r.name || "",
        "Phone": r.phone || "",
        "Tower": r.tower || "",
        "Flat": r.flat || "",
      }));
    exportCSV(rows, `HT_Feedback_${todayStr()}.csv`);
  };

  const handleClearConfirm = () => {
    if (clearPin !== FEEDBACK_PIN) { setClearErr("Wrong PIN. Try again."); return; }
    onClearResponses();
    setShowClear(false); setClearPin(""); setClearErr("");
    setFlash("All responses cleared.");
    setTimeout(() => setFlash(""), 2500);
  };

  return (
    <div style={{ padding: "20px 0" }}>
      {/* ── Live status + on/off toggle ── */}
      <div style={{
        background: live ? "#E8F5E9" : "#F5F0E8",
        border: `1px solid ${live ? "#A5D6A7" : C.border}`,
        borderRadius: 14, padding: "14px 16px", marginBottom: 16,
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 20 }}>{live ? "🟢" : "⚪"}</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: live ? "#1B5E20" : C.inkMid }}>
              Poll is {live ? "LIVE" : "OFF"}
            </div>
            <div style={{ fontSize: 11, color: live ? "#2E7D32" : C.inkLight }}>
              {live ? "Shown to customers after they order" : "Customers won't see the poll"}
            </div>
          </div>
        </div>
        <button
          onClick={onTogglePoll}
          style={{
            position: "relative", width: 56, height: 30, borderRadius: 15, border: "none",
            background: poll?.active ? "#4CAF50" : "#BDBDBD", cursor: "pointer", transition: "background 0.2s", padding: 0,
          }}
          aria-label="Toggle poll"
        >
          <span style={{
            position: "absolute", top: 3, left: poll?.active ? 29 : 3, width: 24, height: 24,
            borderRadius: "50%", background: C.white, transition: "left 0.2s", boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
          }} />
        </button>
      </div>

      {poll?.active && !live && (
        <div style={{ background: "#FFF8E1", border: "1px solid #FFE082", borderRadius: 10, padding: "10px 12px", fontSize: 12, color: "#8D6E00", marginBottom: 16 }}>
          ⚠️ The poll is switched on but has no question yet. Add a question and tap <strong>Save Poll</strong> to make it live.
        </div>
      )}

      {/* ── Compose poll ── */}
      <div className="ht-card" style={{ padding: 18, marginBottom: 16 }}>
        <h3 style={{ fontSize: 14, fontWeight: 800, color: C.ink, marginBottom: 4 }}>✏️ Your Poll</h3>
        <p style={{ fontSize: 11, color: C.inkLight, marginBottom: 14 }}>
          Ask customers anything — e.g. a new service you're considering. They pick a choice and can add their own comment.
        </p>

        <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 5 }}>Question</label>
        <textarea
          className="ht-input"
          value={question}
          onChange={e => setQuestion(e.target.value.slice(0, 160))}
          placeholder="e.g. Would you be interested in weekend special thalis?"
          rows={2}
          style={{ resize: "vertical", fontFamily: "inherit", marginBottom: 4 }}
        />
        <div style={{ fontSize: 10, color: C.inkLight, textAlign: "right", marginBottom: 14 }}>{question.length}/160</div>

        <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 5 }}>
          Answer choices <span style={{ color: C.inkLight, fontWeight: 400 }}>(optional — leave blank for feedback-only)</span>
        </label>
        {options.map((opt, idx) => (
          <div key={idx} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
            <input
              className="ht-input"
              value={opt}
              onChange={e => setOpt(idx, e.target.value.slice(0, 80))}
              placeholder={`Choice ${idx + 1}`}
              style={{ flex: 1 }}
            />
            {options.length > 1 && (
              <button
                onClick={() => removeOpt(idx)}
                className="ht-btn btn-ghost btn-sm"
                style={{ color: C.red, padding: "6px 10px" }}
                aria-label="Remove choice"
              >
                ✕
              </button>
            )}
          </div>
        ))}
        {options.length < 6 && (
          <button onClick={addOpt} className="ht-btn btn-secondary btn-sm" style={{ marginTop: 2, marginBottom: 14 }}>
            + Add choice
          </button>
        )}

        {dirty && forThisPoll.length > 0 && (
          <div style={{ background: "#FFF8E1", border: "1px solid #FFE082", borderRadius: 8, padding: "8px 10px", fontSize: 11, color: "#8D6E00", marginBottom: 12 }}>
            Changing the question or choices starts a <strong>fresh poll</strong>. Existing responses stay saved and remain in your CSV export.
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
          <button
            className="ht-btn btn-primary"
            onClick={handleSave}
            disabled={!dirty || question.trim().length === 0}
            style={{ opacity: (!dirty || question.trim().length === 0) ? 0.5 : 1, cursor: (!dirty || question.trim().length === 0) ? "not-allowed" : "pointer" }}
          >
            💾 Save Poll
          </button>
          {flash && <span style={{ fontSize: 12, color: flash.includes("first") ? C.red : C.green, fontWeight: 700 }}>{flash}</span>}
        </div>
      </div>

      {/* ── Results ── */}
      <div className="ht-card" style={{ padding: 18, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <h3 style={{ fontSize: 14, fontWeight: 800, color: C.ink }}>📊 Results</h3>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.saffron }}>{totalResp} response{totalResp !== 1 ? "s" : ""}</span>
        </div>

        {!poll?.question ? (
          <p style={{ fontSize: 12, color: C.inkLight, padding: "16px 0", textAlign: "center" }}>
            No poll yet. Compose one above to start collecting feedback.
          </p>
        ) : (
          <>
            <p style={{ fontSize: 13, color: C.inkMid, fontWeight: 600, margin: "6px 0 14px" }}>“{poll.question}”</p>

            {tally.length > 0 && (
              <div style={{ marginBottom: totalResp > 0 ? 14 : 0 }}>
                {tally.map(t => {
                  const pct = totalResp > 0 ? Math.round((t.count / totalResp) * 100) : 0;
                  return (
                    <div key={t.opt} style={{ marginBottom: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                        <span style={{ color: C.ink, fontWeight: 600 }}>{t.opt}</span>
                        <span style={{ color: C.inkMid, fontWeight: 700 }}>{t.count} · {pct}%</span>
                      </div>
                      <div style={{ height: 8, background: C.saffronLight, borderRadius: 4, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${(t.count / maxCount) * 100}%`, background: C.saffron, borderRadius: 4, transition: "width 0.3s" }} />
                      </div>
                    </div>
                  );
                })}
                {noChoiceCount > 0 && (
                  <div style={{ fontSize: 11, color: C.inkLight, marginTop: 6 }}>
                    + {noChoiceCount} response{noChoiceCount !== 1 ? "s" : ""} with comment only (no choice picked)
                  </div>
                )}
              </div>
            )}

            {totalResp === 0 && (
              <p style={{ fontSize: 12, color: C.inkLight, padding: "8px 0 4px", textAlign: "center" }}>
                No responses yet for this poll.
              </p>
            )}

            {/* Custom feedback comments */}
            {feedbackList.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.inkMid, marginBottom: 8, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
                  💬 Comments ({feedbackList.length})
                </div>
                {feedbackList.map(r => (
                  <div key={r.id} style={{ background: C.cream, borderRadius: 10, padding: "10px 12px", marginBottom: 8 }}>
                    <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.4, marginBottom: 4 }}>{r.feedback}</div>
                    <div style={{ fontSize: 10, color: C.inkLight }}>
                      {r.choice ? <span style={{ color: C.saffron, fontWeight: 700 }}>[{r.choice}] </span> : null}
                      {r.name || "Customer"}{r.tower ? ` · ${r.tower}` : ""}{r.flat ? `/${r.flat}` : ""}
                      {r.at ? ` · ${new Date(r.at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {olderCount > 0 && (
              <p style={{ fontSize: 11, color: C.inkLight, marginTop: 10 }}>
                + {olderCount} response{olderCount !== 1 ? "s" : ""} from earlier poll versions (included in the CSV export).
              </p>
            )}
          </>
        )}
      </div>

      {/* ── Export + clear ── */}
      <div className="ht-card" style={{ padding: 16 }}>
        <button className="ht-btn btn-secondary btn-full" onClick={handleExport} disabled={!pollResponses.length} style={{ marginBottom: 10, opacity: pollResponses.length ? 1 : 0.5 }}>
          ⬇️ Export all responses (CSV)
        </button>
        <button className="ht-btn btn-ghost btn-full btn-sm" onClick={() => { setShowClear(true); setClearPin(""); setClearErr(""); }} disabled={!pollResponses.length} style={{ color: C.red, opacity: pollResponses.length ? 1 : 0.5 }}>
          🗑️ Clear all responses
        </button>
      </div>

      {/* Clear-responses PIN modal */}
      {showClear && (
        <div className="modal-backdrop" onClick={() => setShowClear(false)}>
          <div className="modal-sheet" onClick={e => e.stopPropagation()}>
            <div style={{ width: 40, height: 4, borderRadius: 2, background: C.border, margin: "0 auto 20px" }} />
            <h3 style={{ fontSize: 17, fontWeight: 800, color: C.ink, marginBottom: 6 }}>🗑️ Clear all responses?</h3>
            <p style={{ fontSize: 13, color: C.inkMid, marginBottom: 16 }}>
              This permanently deletes all {pollResponses.length} poll response{pollResponses.length !== 1 ? "s" : ""}. Export first if you want a copy. Enter your PIN to confirm.
            </p>
            <input
              className="ht-input"
              type="password" inputMode="numeric"
              value={clearPin}
              onChange={e => { setClearPin(e.target.value); setClearErr(""); }}
              placeholder="Enter PIN"
              style={{ textAlign: "center", letterSpacing: 8, fontSize: 20, marginBottom: clearErr ? 6 : 16 }}
              autoFocus
            />
            {clearErr && <p style={{ fontSize: 12, color: C.red, marginBottom: 16, textAlign: "center" }}>⚠️ {clearErr}</p>}
            <button className="ht-btn btn-danger btn-full btn-lg" onClick={handleClearConfirm} style={{ marginBottom: 8 }}>Clear responses</button>
            <button className="ht-btn btn-ghost btn-full btn-sm" onClick={() => setShowClear(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
// ─────────────────────────────────────────────
// CREDIT LEDGER  (Khata Book style)
// ─────────────────────────────────────────────
/*
  Data shape per customer in `credit` array:
  { phone, name, tower, flat,
    entries: [{ id, date, type:"debit"|"credit", amount, note, orderDetails? }] }
  Balance = Σdebits − Σcredits  (positive = customer owes you)
  Zero-balance customers are auto-cleared on daily rollover (like orders).
*/

// ── Credit export helpers ──
function exportCreditCSV(credit, period) {
  const getBalance = (entries) => entries.reduce((s, e) => e.type === "debit" ? s + e.amount : s - e.amount, 0);
  const rows = [];
  credit.forEach(c => {
    c.entries.forEach(e => {
      rows.push({
        "Customer": c.name, "Phone": c.phone, "Tower": c.tower, "Flat": c.flat,
        "Date": new Date(e.date).toLocaleDateString("en-IN"),
        "Type": e.type === "debit" ? "Sale (Debit)" : "Payment (Credit)",
        "Amount (₹)": e.amount, "Note": e.note, "Order Details": e.orderDetails || "",
      });
    });
    rows.push({
      "Customer": c.name, "Phone": c.phone, "Tower": c.tower, "Flat": c.flat,
      "Date": "", "Type": "NET BALANCE",
      "Amount (₹)": getBalance(c.entries), "Note": getBalance(c.entries) > 0 ? "To Receive" : getBalance(c.entries) < 0 ? "You Owe" : "Settled",
      "Order Details": "",
    });
  });
  if (!rows.length) { alert("No credit data to export."); return; }
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(","), ...rows.map(r => headers.map(h => `"${(r[h] ?? "").toString().replace(/"/g, '""')}"`).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `HT_Credit_${period}_${todayStr()}.csv`; a.click();
}

function getWeekStart() {
  const d = new Date(); const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff)).toISOString().split("T")[0];
}
function getMonthStart() {
  const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`;
}

function filterCreditByDate(credit, fromDateStr) {
  const from = new Date(fromDateStr);
  return credit.map(c => ({ ...c, entries: c.entries.filter(e => new Date(e.date) >= from) }))
               .filter(c => c.entries.length > 0);
}

function CreditLedger({ credit, todayOrders = [], ordersHistory = [], onAddCredit, onDeleteEntry, onResetCustomer, onDeleteCustomer, onReconcile }) {
  const [selected, setSelected]       = useState(null);
  const [showPayModal, setShowPayModal] = useState(false);
  const [payAmt, setPayAmt]           = useState("");
  const [payNote, setPayNote]         = useState("");
  const [search, setSearch]           = useState("");

  // Manual debit modal
  const [showDebitModal, setShowDebitModal] = useState(false);
  const [debitAmt, setDebitAmt]             = useState("");
  const [debitNote, setDebitNote]           = useState("");

  // PIN-authenticated single-entry delete state
  const [entryToDelete, setEntryToDelete]         = useState(null);
  const [deleteEntryPin, setDeleteEntryPin]       = useState("");
  const [deleteEntryPinError, setDeleteEntryPinError] = useState("");

  // PIN-authenticated reset state
  const [showResetModal, setShowResetModal] = useState(false);
  const [resetPin, setResetPin]             = useState("");
  const [resetPinError, setResetPinError]   = useState("");
  const RESET_PIN = "2018"; // same as dashboard PIN for consistency

  // PIN-authenticated reconcile state
  const [showReconcileModal, setShowReconcileModal] = useState(false);
  const [reconcilePin, setReconcilePin]             = useState("");
  const [reconcilePinError, setReconcilePinError]   = useState("");
  const [reconciling, setReconciling]               = useState(false);

  // Order-detail viewer for a tapped debit entry (item breakdown + promo/discount)
  const [entryToView, setEntryToView] = useState(null);
  const allOrdersByI = (() => {
    const map = new Map();
    [...(ordersHistory || []), ...(todayOrders || [])].forEach(o => { if (o && o.id) map.set(o.id, o); });
    return map;
  })();

  const getBalance = (entries) =>
    entries.reduce((s, e) => e.type === "debit" ? s + e.amount : s - e.amount, 0);

  const totalOwed = credit.reduce((s, c) => {
    const bal = getBalance(c.entries); return bal > 0 ? s + bal : s;
  }, 0);

  const sorted = [...credit]
    .filter(c => {
      if (!search) return true;
      return c.name.toLowerCase().includes(search.toLowerCase()) ||
             c.phone.includes(search) ||
             c.tower.toLowerCase().includes(search.toLowerCase());
    })
    .sort((a, b) => getBalance(b.entries) - getBalance(a.entries));

  const selectedCustomer = credit.find(c => c.phone === selected);

  const handlePayment = () => {
    const amt = parseFloat(payAmt);
    if (!amt || amt <= 0) return;
    onAddCredit(selected, { type: "credit", amount: amt, note: payNote || "Payment received" });
    setPayAmt(""); setPayNote(""); setShowPayModal(false);
  };

  const handleDebit = () => {
    const amt = parseFloat(debitAmt);
    if (!amt || amt <= 0) return;
    onAddCredit(selected, { type: "debit", amount: amt, note: debitNote || "Manual debit" });
    setDebitAmt(""); setDebitNote(""); setShowDebitModal(false);
  };

  const handleDeleteEntryConfirm = () => {
    if (deleteEntryPin !== RESET_PIN) { setDeleteEntryPinError("Wrong PIN. Try again."); return; }
    onDeleteEntry(selected, entryToDelete.id);
    setEntryToDelete(null); setDeleteEntryPin(""); setDeleteEntryPinError("");
  };

  const handleResetConfirm = () => {
    if (resetPin !== RESET_PIN) { setResetPinError("Wrong PIN. Try again."); return; }
    onResetCustomer(selected);
    setShowResetModal(false); setResetPin(""); setResetPinError("");
  };

  // ── Reconcile preview (live) ──
  // Computes what the ledger WOULD look like after reconcile, so the user can
  // see exactly what will change before confirming.
  const reconcilePreview = (() => {
    const today = todayStr();
    const allOrders = [
      ...(todayOrders || []).filter(o => o.date === today),
      ...(ordersHistory || []),
    ];
    const deliveredOrders = allOrders.filter(o => o.status === "delivered");
    const legitDebitsByPhone = new Map(); // phone -> count of delivered orders
    let legitDebitTotal = 0;
    for (const o of deliveredOrders) {
      legitDebitsByPhone.set(o.phone, (legitDebitsByPhone.get(o.phone) || 0) + 1);
      legitDebitTotal += o.total;
    }
    let currentAutoDebitCount = 0;
    let currentAutoDebitTotal = 0;
    let manualCount = 0;
    for (const cust of credit || []) {
      for (const e of cust.entries || []) {
        if (e.note === "Order delivered") {
          currentAutoDebitCount += 1;
          currentAutoDebitTotal += e.amount;
        } else {
          manualCount += 1;
        }
      }
    }
    const duplicatesRemoved = Math.max(0, currentAutoDebitCount - deliveredOrders.length);
    const phantomAmount = Math.max(0, currentAutoDebitTotal - legitDebitTotal);
    // Compute what NET total would become after reconcile
    const currentNetOwed = (credit || []).reduce((s, c) => {
      const bal = getBalance(c.entries); return bal > 0 ? s + bal : s;
    }, 0);
    const newNetOwed = Math.max(0, currentNetOwed - phantomAmount);
    return {
      duplicatesRemoved,
      phantomAmount,
      manualPreserved: manualCount,
      currentNetOwed,
      newNetOwed,
      deliveredCount: deliveredOrders.length,
    };
  })();

  const handleReconcileConfirm = async () => {
    if (reconcilePin !== RESET_PIN) { setReconcilePinError("Wrong PIN. Try again."); return; }
    setReconciling(true);
    try {
      await onReconcile();
      setShowReconcileModal(false);
      setReconcilePin("");
      setReconcilePinError("");
    } catch (err) {
      setReconcilePinError("Something went wrong. Try again.");
    } finally {
      setReconciling(false);
    }
  };

  // ─── INDIVIDUAL CUSTOMER LEDGER ───
  if (selected && selectedCustomer) {
    const entries = [...selectedCustomer.entries].sort((a, b) => new Date(a.date) - new Date(b.date));
    const balance = getBalance(selectedCustomer.entries);
    let running = 0;

    return (
      <div style={{ padding: "0 0 40px" }}>
        {/* Sticky header */}
        <div style={{ background: C.white, borderBottom: `1px solid ${C.border}`, padding: "14px 0 12px", position: "sticky", top: 0, zIndex: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <button className="ht-btn btn-ghost btn-sm" onClick={() => setSelected(null)}>← Back</button>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: C.ink }}>{selectedCustomer.name}</div>
              <div style={{ fontSize: 12, color: C.inkMid }}>{selectedCustomer.tower} · Flat {selectedCustomer.flat} · {selectedCustomer.phone}</div>
            </div>
            {/* Reset (PIN protected) */}
            <button
              className="ht-btn btn-sm"
              onClick={() => { setResetPin(""); setResetPinError(""); setShowResetModal(true); }}
              style={{ background: "#FFF3CD", color: "#856404", border: "1px solid #856404", fontSize: 11 }}
            >
              🔄 Reset
            </button>
            {/* Delete entirely */}
            <button
              className="ht-btn btn-danger btn-sm"
              onClick={() => { if (window.confirm(`Permanently delete ALL ledger data for ${selectedCustomer.name}? This cannot be undone.`)) { onDeleteCustomer(selected); setSelected(null); } }}
              style={{ fontSize: 11 }}
            >
              🗑
            </button>
          </div>

          {/* Balance card */}
          <div style={{
            background: balance > 0 ? C.redLight : balance < 0 ? C.greenLight : C.cream,
            border: `1.5px solid ${balance > 0 ? C.red : balance < 0 ? C.green : C.border}`,
            borderRadius: 12, padding: "14px 18px",
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <div>
              <div style={{ fontSize: 12, color: C.inkMid, fontWeight: 600 }}>
                {balance > 0 ? "Amount to Receive" : balance < 0 ? "You owe customer" : "All Settled ✓"}
              </div>
              <div style={{ fontSize: 26, fontWeight: 900, color: balance > 0 ? C.red : balance < 0 ? C.green : C.inkMid }}>
                ₹{Math.abs(balance).toFixed(0)}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="ht-btn btn-green" onClick={() => setShowPayModal(true)}>
                + Payment Received
              </button>
              <button className="ht-btn btn-danger" onClick={() => setShowDebitModal(true)}>
                + Manual Debit
              </button>
            </div>
          </div>
        </div>

        {/* Ledger table */}
        <div style={{ marginTop: 16 }}>
          {entries.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40, color: C.inkMid }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>📒</div>
              <p>No transactions yet</p>
            </div>
          ) : (
            <div className="ht-card" style={{ overflow: "hidden" }}>
              {/* Column headers */}
              <div style={{ display: "grid", gridTemplateColumns: "72px 1fr 72px 72px 72px 26px", padding: "10px 14px", background: C.cream, borderBottom: `1px solid ${C.border}`, fontSize: 10, fontWeight: 700, color: C.inkMid, textTransform: "uppercase", letterSpacing: "0.3px" }}>
                <span>Date</span><span>Details</span>
                <span style={{ textAlign: "right", color: C.red }}>Debit</span>
                <span style={{ textAlign: "right", color: C.green }}>Credit</span>
                <span style={{ textAlign: "right" }}>Balance</span>
                <span></span>
              </div>

              {entries.map((e, i) => {
                running += e.type === "debit" ? e.amount : -e.amount;
                const isDebit = e.type === "debit";
                const linkedOrder = e.orderId ? allOrdersByI.get(e.orderId) : null;
                const tappable = isDebit && !!linkedOrder;
                return (
                  <div
                    key={e.id}
                    onClick={tappable ? () => setEntryToView({ entry: e, order: linkedOrder }) : undefined}
                    style={{ display: "grid", gridTemplateColumns: "72px 1fr 72px 72px 72px 26px", padding: "11px 14px", borderBottom: i < entries.length - 1 ? `1px solid ${C.border}` : "none", background: isDebit ? "#FFFAF8" : "#F8FFFA", cursor: tappable ? "pointer" : "default" }}
                  >
                    <div style={{ fontSize: 11, color: C.inkLight, paddingTop: 2 }}>
                      {new Date(e.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                    </div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{e.note}{tappable && <span style={{ color: C.inkLight, fontWeight: 500 }}> · tap for details</span>}</div>
                      {e.orderDetails && <div style={{ fontSize: 11, color: C.inkMid, marginTop: 2 }}>{e.orderDetails}</div>}
                    </div>
                    <div style={{ textAlign: "right", fontSize: 13, fontWeight: 700, color: C.red }}>{isDebit ? `₹${e.amount}` : ""}</div>
                    <div style={{ textAlign: "right", fontSize: 13, fontWeight: 700, color: C.green }}>{!isDebit ? `₹${e.amount}` : ""}</div>
                    <div style={{ textAlign: "right", fontSize: 13, fontWeight: 800, color: running > 0 ? C.red : running < 0 ? C.green : C.inkMid }}>
                      ₹{Math.abs(running)}
                    </div>
                    <div style={{ textAlign: "center", paddingTop: 2 }}>
                      <button
                        onClick={(ev) => { ev.stopPropagation(); setDeleteEntryPin(""); setDeleteEntryPinError(""); setEntryToDelete(e); }}
                        style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, color: C.inkLight, padding: 0 }}
                        title="Delete entry"
                      >
                        🗑
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* Balance footer */}
              <div style={{ display: "grid", gridTemplateColumns: "72px 1fr 72px 72px 72px 26px", padding: "12px 14px", background: C.ink }}>
                <div style={{ gridColumn: "1 / 6", fontSize: 13, fontWeight: 700, color: "rgba(255,255,255,0.7)" }}>Net Balance</div>
                <div style={{ textAlign: "right", fontSize: 15, fontWeight: 900, color: balance > 0 ? "#FF8A80" : balance < 0 ? "#B9F6CA" : "rgba(255,255,255,0.5)" }}>
                  {balance > 0 ? `₹${balance} ↑` : balance < 0 ? `₹${Math.abs(balance)} ↓` : "Settled"}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Debit entry order-detail modal */}
        {entryToView && (() => {
          const o = entryToView.order;
          const discount = o.discount || 0;
          const originalTotal = o.originalTotal ?? (o.total + discount);
          const code = o.promoCode || o.referralCode || null;
          return (
            <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setEntryToView(null); }}>
              <div className="modal-sheet">
                <div style={{ width: 40, height: 4, borderRadius: 2, background: C.border, margin: "0 auto 20px" }} />
                <h3 style={{ fontSize: 17, fontWeight: 800, color: C.ink, marginBottom: 4 }}>Order Detail</h3>
                <p style={{ fontSize: 12, color: C.inkLight, marginBottom: 16 }}>
                  #{o.id.slice(-6).toUpperCase()} · {fmtDate(o.date)} {fmtTime(o.createdAt)}
                </p>
                <div style={{ display: "grid", gap: 6, marginBottom: 14 }}>
                  {(o.items || []).map((it, idx) => (
                    <div key={idx} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: C.ink }}>
                      <span>{it.name} × {it.qty}</span>
                      <span>₹{(it.price ?? 0) * it.qty}</span>
                    </div>
                  ))}
                </div>
                <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10, display: "grid", gap: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: C.inkMid }}>
                    <span>Subtotal</span><span>₹{originalTotal}</span>
                  </div>
                  {discount > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: C.green }}>
                      <span>Discount{code ? ` (${code})` : ""}</span><span>−₹{discount}</span>
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, fontWeight: 800, color: C.ink }}>
                    <span>Total Charged</span><span>₹{o.total}</span>
                  </div>
                </div>
                <button className="ht-btn btn-ghost btn-full btn-sm" style={{ marginTop: 20 }} onClick={() => setEntryToView(null)}>Close</button>
              </div>
            </div>
          );
        })()}

        {/* Payment received modal */}
        {showPayModal && (
          <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowPayModal(false); }}>
            <div className="modal-sheet">
              <div style={{ width: 40, height: 4, borderRadius: 2, background: C.border, margin: "0 auto 20px" }} />
              <h3 style={{ fontSize: 17, fontWeight: 800, color: C.ink, marginBottom: 4 }}>Payment Received</h3>
              <p style={{ fontSize: 13, color: C.inkMid, marginBottom: 20 }}>
                From <strong>{selectedCustomer.name}</strong>
                {balance > 0 && <span style={{ color: C.red }}> · Outstanding ₹{balance}</span>}
              </p>
              <div style={{ display: "grid", gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 5 }}>Amount Received (₹)</label>
                  <input className="ht-input" type="number" placeholder="Enter amount" value={payAmt} onChange={e => setPayAmt(e.target.value)} autoFocus />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 5 }}>Payment Mode / Note</label>
                  <input className="ht-input" placeholder="e.g. Cash, UPI, Bank Transfer" value={payNote} onChange={e => setPayNote(e.target.value)} />
                </div>
              </div>
              <button className="ht-btn btn-green btn-full btn-lg" style={{ marginTop: 20 }} onClick={handlePayment}>✓ Record Payment</button>
              <button className="ht-btn btn-ghost btn-full btn-sm" style={{ marginTop: 8 }} onClick={() => setShowPayModal(false)}>Cancel</button>
            </div>
          </div>
        )}

        {/* Manual debit modal */}
        {showDebitModal && (
          <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowDebitModal(false); }}>
            <div className="modal-sheet">
              <div style={{ width: 40, height: 4, borderRadius: 2, background: C.border, margin: "0 auto 20px" }} />
              <h3 style={{ fontSize: 17, fontWeight: 800, color: C.ink, marginBottom: 4 }}>Manual Debit</h3>
              <p style={{ fontSize: 13, color: C.inkMid, marginBottom: 20 }}>
                For <strong>{selectedCustomer.name}</strong> · adds an amount owed (e.g. a correction not tied to an order)
              </p>
              <div style={{ display: "grid", gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 5 }}>Amount (₹)</label>
                  <input className="ht-input" type="number" placeholder="Enter amount" value={debitAmt} onChange={e => setDebitAmt(e.target.value)} autoFocus />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 5 }}>Note</label>
                  <input className="ht-input" placeholder="e.g. Missed charge, correction" value={debitNote} onChange={e => setDebitNote(e.target.value)} />
                </div>
              </div>
              <button className="ht-btn btn-danger btn-full btn-lg" style={{ marginTop: 20 }} onClick={handleDebit}>✓ Add Debit</button>
              <button className="ht-btn btn-ghost btn-full btn-sm" style={{ marginTop: 8 }} onClick={() => setShowDebitModal(false)}>Cancel</button>
            </div>
          </div>
        )}

        {/* PIN-authenticated single-entry delete modal */}
        {entryToDelete && (
          <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) { setEntryToDelete(null); setDeleteEntryPin(""); setDeleteEntryPinError(""); } }}>
            <div className="modal-sheet">
              <div style={{ width: 40, height: 4, borderRadius: 2, background: C.border, margin: "0 auto 20px" }} />
              <div style={{ textAlign: "center", marginBottom: 20 }}>
                <div style={{ fontSize: 36, marginBottom: 10 }}>🔐</div>
                <h3 style={{ fontSize: 17, fontWeight: 800, color: C.ink, marginBottom: 6 }}>Delete Entry</h3>
                <p style={{ fontSize: 13, color: C.inkMid }}>
                  Permanently delete "{entryToDelete.note}" (₹{entryToDelete.amount}) from {selectedCustomer.name}'s ledger. Enter your PIN to confirm.
                </p>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 5 }}>Enter PIN</label>
                <input
                  className="ht-input"
                  type="password"
                  maxLength={6}
                  placeholder="Enter your PIN"
                  value={deleteEntryPin}
                  onChange={e => { setDeleteEntryPin(e.target.value); setDeleteEntryPinError(""); }}
                  style={{ textAlign: "center", letterSpacing: 8, fontSize: 20 }}
                  autoFocus
                />
                {deleteEntryPinError && <p style={{ fontSize: 12, color: C.red, marginTop: 6, textAlign: "center" }}>⚠️ {deleteEntryPinError}</p>}
              </div>
              <button className="ht-btn btn-danger btn-full btn-lg" onClick={handleDeleteEntryConfirm} style={{ marginBottom: 8 }}>
                Delete Entry
              </button>
              <button className="ht-btn btn-ghost btn-full btn-sm" onClick={() => { setEntryToDelete(null); setDeleteEntryPin(""); setDeleteEntryPinError(""); }}>Cancel</button>
            </div>
          </div>
        )}

        {/* PIN-authenticated reset modal */}
        {showResetModal && (
          <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) { setShowResetModal(false); setResetPin(""); setResetPinError(""); } }}>
            <div className="modal-sheet">
              <div style={{ width: 40, height: 4, borderRadius: 2, background: C.border, margin: "0 auto 20px" }} />
              <div style={{ textAlign: "center", marginBottom: 20 }}>
                <div style={{ fontSize: 36, marginBottom: 10 }}>🔐</div>
                <h3 style={{ fontSize: 17, fontWeight: 800, color: C.ink, marginBottom: 6 }}>Confirm Reset</h3>
                <p style={{ fontSize: 13, color: C.inkMid }}>
                  This will clear all ledger entries for <strong>{selectedCustomer.name}</strong> and reset their balance to ₹0. Enter your PIN to confirm.
                </p>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 5 }}>Enter PIN</label>
                <input
                  className="ht-input"
                  type="password"
                  maxLength={6}
                  placeholder="Enter your PIN"
                  value={resetPin}
                  onChange={e => { setResetPin(e.target.value); setResetPinError(""); }}
                  style={{ textAlign: "center", letterSpacing: 8, fontSize: 20 }}
                  autoFocus
                />
                {resetPinError && <p style={{ fontSize: 12, color: C.red, marginTop: 6, textAlign: "center" }}>⚠️ {resetPinError}</p>}
              </div>
              <button className="ht-btn btn-full btn-lg" onClick={handleResetConfirm} style={{ background: "#856404", color: C.white, marginBottom: 8 }}>
                Reset Ledger
              </button>
              <button className="ht-btn btn-ghost btn-full btn-sm" onClick={() => { setShowResetModal(false); setResetPin(""); setResetPinError(""); }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── CUSTOMER LIST VIEW ───
  return (
    <div style={{ padding: "20px 0" }}>
      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
        <div className="ht-card" style={{ padding: "14px 12px", textAlign: "center" }}>
          <div style={{ fontSize: 20, fontWeight: 900, color: C.red }}>₹{totalOwed}</div>
          <div style={{ fontSize: 11, color: C.inkMid, fontWeight: 600 }}>Total to Receive</div>
        </div>
        <div className="ht-card" style={{ padding: "14px 12px", textAlign: "center" }}>
          <div style={{ fontSize: 20, fontWeight: 900, color: C.ink }}>{credit.filter(c => getBalance(c.entries) > 0).length}</div>
          <div style={{ fontSize: 11, color: C.inkMid, fontWeight: 600 }}>Customers Pending</div>
        </div>
      </div>

      {/* Export buttons */}
      <div className="ht-card" style={{ padding: "14px 16px", marginBottom: 14 }}>
        <p style={{ fontSize: 12, fontWeight: 700, color: C.ink, marginBottom: 10 }}>📥 Export as Backup (Excel)</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <button
            className="ht-btn btn-secondary btn-sm btn-full"
            onClick={() => exportCreditCSV(filterCreditByDate(credit, getWeekStart()), "Weekly")}
          >
            📅 This Week
          </button>
          <button
            className="ht-btn btn-secondary btn-sm btn-full"
            onClick={() => exportCreditCSV(filterCreditByDate(credit, getMonthStart()), "Monthly")}
          >
            🗓 This Month
          </button>
        </div>
        <button
          className="ht-btn btn-secondary btn-sm btn-full"
          style={{ marginTop: 8 }}
          onClick={() => exportCreditCSV(credit, "All")}
        >
          📋 Full Ledger (All time)
        </button>
        <p style={{ fontSize: 11, color: C.inkLight, marginTop: 8 }}>
          ⚠️ Download weekly every Sunday as a safe backup. Do not rely on this app alone for credit records.
        </p>
      </div>

      {/* Reconcile Ledger — shown only when duplicates are detected */}
      {reconcilePreview.duplicatesRemoved > 0 && (
        <div className="ht-card" style={{
          padding: "14px 16px", marginBottom: 14,
          background: "#FFF8E1", border: "1.5px solid #FFB74D",
        }}>
          <p style={{ fontSize: 13, fontWeight: 800, color: "#E65100", marginBottom: 6 }}>
            🔧 Duplicate Credit Entries Detected
          </p>
          <p style={{ fontSize: 12, color: C.inkMid, lineHeight: 1.5, marginBottom: 10 }}>
            Found <strong>{reconcilePreview.duplicatesRemoved}</strong> duplicate auto-debit{reconcilePreview.duplicatesRemoved > 1 ? "s" : ""} totalling <strong>₹{reconcilePreview.phantomAmount}</strong> in phantom charges. This inflates your "Total to Receive" figure.
          </p>
          <button
            className="ht-btn btn-sm btn-full"
            style={{ background: "#E65100", color: C.white, fontWeight: 700 }}
            onClick={() => { setReconcilePin(""); setReconcilePinError(""); setShowReconcileModal(true); }}
          >
            🔧 Reconcile Ledger
          </button>
          <p style={{ fontSize: 10, color: C.inkLight, marginTop: 6, textAlign: "center" }}>
            Manual payments are preserved. Uses order history as source of truth.
          </p>
        </div>
      )}

      <input
        className="ht-input"
        placeholder="🔍 Search by name, phone or tower…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ marginBottom: 14 }}
      />

      {sorted.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 0", color: C.inkMid }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>📒</div>
          <p style={{ fontSize: 13 }}>No credit records yet.<br />Auto-created when an order is delivered.</p>
        </div>
      ) : (
        sorted.map(c => {
          const balance = getBalance(c.entries);
          const lastEntry = [...c.entries].sort((a, b) => new Date(b.date) - new Date(a.date))[0];
          return (
            <div
              key={c.phone}
              className="ht-card slide-in"
              onClick={() => setSelected(c.phone)}
              style={{ padding: "16px 18px", marginBottom: 10, cursor: "pointer", transition: "box-shadow 0.15s", borderLeft: `4px solid ${balance > 0 ? C.red : balance < 0 ? C.green : C.border}` }}
              onMouseEnter={e => e.currentTarget.style.boxShadow = `0 4px 16px rgba(26,18,8,0.12)`}
              onMouseLeave={e => e.currentTarget.style.boxShadow = ""}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: C.ink, marginBottom: 2 }}>{c.name}</div>
                  <div style={{ fontSize: 12, color: C.inkMid }}>{c.phone}</div>
                  <div style={{ fontSize: 11, color: C.inkLight }}>{c.tower} · Flat {c.flat}</div>
                  {lastEntry && (
                    <div style={{ fontSize: 11, color: C.inkLight, marginTop: 3 }}>
                      Last: {new Date(lastEntry.date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                    </div>
                  )}
                </div>
                <div style={{ textAlign: "right", minWidth: 90 }}>
                  <div style={{ fontSize: 20, fontWeight: 900, color: balance > 0 ? C.red : balance < 0 ? C.green : C.inkMid }}>
                    ₹{Math.abs(balance)}
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: balance > 0 ? C.red : balance < 0 ? C.green : C.inkMid }}>
                    {balance > 0 ? "to receive" : balance < 0 ? "you owe" : "settled"}
                  </div>
                  <div style={{ fontSize: 11, color: C.inkLight, marginTop: 3 }}>{c.entries.length} entries</div>
                </div>
              </div>
            </div>
          );
        })
      )}

      {/* Reconcile Confirmation Modal (PIN protected) */}
      {showReconcileModal && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !reconciling) { setShowReconcileModal(false); setReconcilePin(""); setReconcilePinError(""); } }}>
          <div className="modal-sheet">
            <div style={{ width: 40, height: 4, borderRadius: 2, background: C.border, margin: "0 auto 20px" }} />
            <div style={{ textAlign: "center", marginBottom: 16 }}>
              <div style={{ fontSize: 36, marginBottom: 10 }}>🔧</div>
              <h3 style={{ fontSize: 17, fontWeight: 800, color: C.ink, marginBottom: 6 }}>Reconcile Credit Ledger</h3>
              <p style={{ fontSize: 12, color: C.inkMid, lineHeight: 1.5 }}>
                Rebuilds auto-debit entries from delivered orders. Fixes any duplicates caused by the old status-regression bug.
              </p>
            </div>

            {/* Preview */}
            <div style={{ background: C.cream, borderRadius: 10, padding: "14px 16px", marginBottom: 16, border: `1px solid ${C.border}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 13 }}>
                <span style={{ color: C.inkMid }}>Duplicate entries to remove</span>
                <span style={{ fontWeight: 800, color: C.red }}>{reconcilePreview.duplicatesRemoved}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 13 }}>
                <span style={{ color: C.inkMid }}>Phantom amount removed</span>
                <span style={{ fontWeight: 800, color: C.red }}>− ₹{reconcilePreview.phantomAmount}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 13 }}>
                <span style={{ color: C.inkMid }}>Manual entries preserved</span>
                <span style={{ fontWeight: 700, color: C.green }}>{reconcilePreview.manualPreserved}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 13 }}>
                <span style={{ color: C.inkMid }}>Delivered orders (source)</span>
                <span style={{ fontWeight: 700, color: C.ink }}>{reconcilePreview.deliveredCount}</span>
              </div>
              <div style={{ height: 1, background: C.border, margin: "8px 0" }} />
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 13 }}>
                <span style={{ color: C.inkMid }}>Current Total to Receive</span>
                <span style={{ fontWeight: 700, color: C.inkMid, textDecoration: "line-through" }}>₹{reconcilePreview.currentNetOwed}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 14 }}>
                <span style={{ color: C.ink, fontWeight: 700 }}>After Reconcile</span>
                <span style={{ fontWeight: 900, color: C.green, fontSize: 16 }}>₹{reconcilePreview.newNetOwed}</span>
              </div>
            </div>

            <p style={{ fontSize: 11, color: C.inkLight, marginBottom: 12, textAlign: "center", lineHeight: 1.4 }}>
              💾 Recommended: export "Full Ledger (All time)" as backup before reconciling.
            </p>

            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 5 }}>Enter PIN to confirm</label>
              <input
                className="ht-input"
                type="password"
                maxLength={6}
                placeholder="Enter your PIN"
                value={reconcilePin}
                onChange={e => { setReconcilePin(e.target.value); setReconcilePinError(""); }}
                style={{ textAlign: "center", letterSpacing: 8, fontSize: 20 }}
                autoFocus
                disabled={reconciling}
              />
              {reconcilePinError && <p style={{ fontSize: 12, color: C.red, marginTop: 6, textAlign: "center" }}>⚠️ {reconcilePinError}</p>}
            </div>

            <button
              className="ht-btn btn-full btn-lg"
              onClick={handleReconcileConfirm}
              disabled={reconciling}
              style={{ background: "#E65100", color: C.white, marginBottom: 8, opacity: reconciling ? 0.6 : 1 }}
            >
              {reconciling ? "Reconciling…" : "🔧 Reconcile Now"}
            </button>
            <button
              className="ht-btn btn-ghost btn-full btn-sm"
              onClick={() => { setShowReconcileModal(false); setReconcilePin(""); setReconcilePinError(""); }}
              disabled={reconciling}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// BACKEND SHELL
// ─────────────────────────────────────────────
function BackendApp({ menu, planConfig, contactInfo, contactMessages, todayOrders, ordersHistory, customers, credit, kitchenOpen, poll, pollResponses, promoCodes, referralConfig, onSaveMenu, onSavePlanConfig, onSaveContactInfo, onMarkContactRead, onDeleteContactMessage, onAdvanceOrder, onRejectOrder, onLogout, onAddCredit, onDeleteCreditEntry, onResetCreditCustomer, onDeleteCreditCustomer, onReconcileCredit, onToggleKitchen, onResetAllData, onSavePoll, onTogglePoll, onClearPollResponses, onSavePromoCodes, onSaveReferralConfig }) {
  const [tab, setTab] = useState("orders");
  const pendingCount = todayOrders.filter(o => o.status === "pending").length;
  const creditAlert = credit.filter(c => c.entries.reduce((s, e) => e.type === "debit" ? s + e.amount : s - e.amount, 0) > 0).length;
  const unreadContactCount = (contactMessages || []).filter(m => !m.read).length;
  const tabs = [
    { id: "orders",   label: "📦 Orders" },
    { id: "menu",     label: "🍽️ Menu" },
    { id: "plans",    label: "🍛 Plans" },
    { id: "credit",   label: "📒 Credit" },
    { id: "analytics",label: "📊 Analytics" },
    { id: "feedback", label: "🗳️ Feedback" },
    { id: "contact",  label: "📞 Contact" + (unreadContactCount > 0 ? ` (${unreadContactCount})` : "") },
    { id: "promo",    label: "🎟️ Promo" },
  ];
  return (
    <div style={{ minHeight: "100vh", background: C.cream }}>
      <div style={{ background: C.ink, padding: "14px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1 style={{ fontSize: 16, fontWeight: 800, color: C.white }}>🍱 Homely Tiffins</h1>
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>Owner Dashboard</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.6)" }}>{fmtDate(todayStr())}</span>
          <button
            className="ht-btn btn-sm"
            onClick={onLogout}
            style={{ background: "rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.8)", border: "1px solid rgba(255,255,255,0.2)", fontSize: 11 }}
          >
            Sign Out
          </button>
        </div>
      </div>

      {/* Kitchen Open/Closed toggle */}
      <div style={{
        background: kitchenOpen ? "#E8F5E9" : "#FFEBEE",
        borderBottom: `1px solid ${kitchenOpen ? "#A5D6A7" : "#FFCDD2"}`,
        padding: "12px 20px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 20 }}>{kitchenOpen ? "🟢" : "🔴"}</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: kitchenOpen ? "#1B5E20" : "#B71C1C" }}>
              Kitchen is {kitchenOpen ? "OPEN" : "CLOSED"}
            </div>
            <div style={{ fontSize: 11, color: kitchenOpen ? "#2E7D32" : "#C62828" }}>
              {kitchenOpen ? "Customers can place orders" : "Customers cannot place orders"}
            </div>
          </div>
        </div>
        <button
          onClick={onToggleKitchen}
          style={{
            position: "relative",
            width: 56, height: 30,
            borderRadius: 15,
            border: "none",
            background: kitchenOpen ? "#4CAF50" : "#BDBDBD",
            cursor: "pointer",
            transition: "background 0.2s",
            padding: 0,
          }}
          aria-label="Toggle kitchen"
        >
          <span style={{
            position: "absolute",
            top: 3, left: kitchenOpen ? 29 : 3,
            width: 24, height: 24,
            borderRadius: "50%",
            background: C.white,
            transition: "left 0.2s",
            boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
          }} />
        </button>
      </div>

      {/* Pending order alert banner */}
      {pendingCount > 0 && (
        <div style={{
          background: `linear-gradient(90deg, ${C.saffron}, #d4661a)`,
          padding: "10px 20px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="pulse-dot" style={{ background: C.white, width: 10, height: 10 }} />
            <span style={{ color: C.white, fontWeight: 700, fontSize: 14 }}>
              🔔 {pendingCount} new order{pendingCount > 1 ? "s" : ""} waiting!
            </span>
          </div>
          <button
            className="ht-btn btn-sm"
            onClick={() => setTab("orders")}
            style={{ background: C.white, color: C.saffron, fontSize: 12, fontWeight: 700 }}
          >
            View Orders
          </button>
        </div>
      )}
      <div style={{ background: C.white, padding: "0 16px", borderBottom: `1px solid ${C.border}`, display: "flex", gap: 4, overflowX: "auto" }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ padding: "14px 14px", border: "none", background: "transparent", fontSize: 13, fontWeight: 600, cursor: "pointer", color: tab === t.id ? C.saffron : C.inkMid, borderBottom: tab === t.id ? `2px solid ${C.saffron}` : "2px solid transparent", transition: "all 0.15s", whiteSpace: "nowrap", position: "relative" }}>
            {t.label}
            {t.id === "credit" && creditAlert > 0 && (
              <span style={{ position: "absolute", top: 8, right: 4, background: C.red, color: C.white, borderRadius: "50%", width: 16, height: 16, fontSize: 9, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {creditAlert}
              </span>
            )}
          </button>
        ))}
      </div>
      <div style={{ maxWidth: 680, margin: "0 auto", padding: "0 16px 40px" }}>
        {tab === "orders"    && <OrderDashboard todayOrders={todayOrders} onAdvance={onAdvanceOrder} onReject={onRejectOrder} />}
        {tab === "menu"      && <MenuEditor menu={menu} onSave={onSaveMenu} />}
        {tab === "plans"     && <PlanMenuEditor planConfig={planConfig} onSave={onSavePlanConfig} />}
        {tab === "contact"   && <ContactCenter contactInfo={contactInfo} messages={contactMessages} onSave={onSaveContactInfo} onMarkRead={onMarkContactRead} onDelete={onDeleteContactMessage} />}
        {tab === "credit"    && <CreditLedger credit={credit} todayOrders={todayOrders} ordersHistory={ordersHistory} onAddCredit={onAddCredit} onDeleteEntry={onDeleteCreditEntry} onResetCustomer={onResetCreditCustomer} onDeleteCustomer={onDeleteCreditCustomer} onReconcile={onReconcileCredit} />}
        {tab === "analytics" && <AnalyticsPanel todayOrders={todayOrders} ordersHistory={ordersHistory} customers={customers} onResetAllData={onResetAllData} />}
        {tab === "feedback"  && <FeedbackPanel poll={poll} pollResponses={pollResponses} onSavePoll={onSavePoll} onTogglePoll={onTogglePoll} onClearResponses={onClearPollResponses} />}
        {tab === "promo"     && <PromoCenter promoCodes={promoCodes} referralConfig={referralConfig} onSavePromoCodes={onSavePromoCodes} onSaveReferralConfig={onSaveReferralConfig} todayOrders={todayOrders} ordersHistory={ordersHistory} />}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// OWNER LOGIN SCREEN
// Authenticates against real Supabase Auth (email + password) instead
// of a hardcoded string that was previously readable by anyone who
// opened the browser's dev tools.
// ─────────────────────────────────────────────
function OwnerLogin({ onSuccess }) {
  const [username, setUsername] = useState(""); // holds the login email
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [shaking, setShaking] = useState(false);
  const [checking, setChecking] = useState(false);

  const handleLogin = async () => {
    setChecking(true);
    setError("");
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: username.trim(),
      password,
    });
    setChecking(false);
    if (!authError) {
      onSuccess();
    } else {
      setError("Incorrect email or password.");
      setShaking(true);
      setTimeout(() => setShaking(false), 500);
    }
  };

  const handleKey = (e) => { if (e.key === "Enter" && !checking) handleLogin(); };

  return (
    <div style={{ minHeight: "100vh", background: C.cream, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <style>{`
        @keyframes shake {
          0%,100% { transform: translateX(0); }
          20%,60% { transform: translateX(-8px); }
          40%,80% { transform: translateX(8px); }
        }
        .shake { animation: shake 0.4s ease; }
      `}</style>

      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <div style={{ fontSize: 48, marginBottom: 10 }}>🍱</div>
        <h1 style={{ fontSize: 26, fontWeight: 900, color: C.ink, marginBottom: 4 }}>Homely Tiffins</h1>
        <p style={{ fontSize: 13, color: C.inkMid }}>Owner Dashboard — Sign In</p>
      </div>

      <div className={`ht-card ${shaking ? "shake" : ""}`} style={{ width: "100%", maxWidth: 380, padding: 32 }}>
        <div style={{ display: "grid", gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 5 }}>Email</label>
            <input
              className="ht-input"
              placeholder="Enter email"
              type="email"
              value={username}
              onChange={e => { setUsername(e.target.value); setError(""); }}
              onKeyDown={handleKey}
              autoComplete="username"
            />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 5 }}>Password</label>
            <div style={{ position: "relative" }}>
              <input
                className="ht-input"
                placeholder="Enter password"
                type={showPass ? "text" : "password"}
                value={password}
                onChange={e => { setPassword(e.target.value); setError(""); }}
                onKeyDown={handleKey}
                autoComplete="current-password"
                style={{ paddingRight: 44 }}
              />
              <button
                onClick={() => setShowPass(p => !p)}
                style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", fontSize: 16, color: C.inkLight }}
              >
                {showPass ? "🙈" : "👁️"}
              </button>
            </div>
          </div>

          {error && (
            <div style={{ background: C.redLight, border: `1px solid ${C.red}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: C.red, fontWeight: 500 }}>
              ⚠️ {error}
            </div>
          )}

          <button className="ht-btn btn-primary btn-full btn-lg" onClick={handleLogin} disabled={checking} style={{ marginTop: 4, opacity: checking ? 0.7 : 1 }}>
            {checking ? "Signing in..." : "Sign In →"}
          </button>
        </div>
      </div>

      <p style={{ fontSize: 12, color: C.inkLight, marginTop: 20 }}>
        Customer ordering? <a href="#" onClick={e => { e.preventDefault(); window.location.hash = ""; }} style={{ color: C.saffron, textDecoration: "none", fontWeight: 600 }}>Go to order page</a>
      </p>
    </div>
  );
}



// ─────────────────────────────────────────────
// NEW ORDER ALERT SOUND (phone-ring via Web Audio)
// ─────────────────────────────────────────────
function useOrderAlert(todayOrders, isOwnerView) {
  const audioCtxRef = useRef(null);
  const ringingRef  = useRef(false);
  const timerRef    = useRef(null);

  const getCtx = () => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed')
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
    return audioCtxRef.current;
  };

  // Realistic phone-ring: two short bursts of a 440/480 Hz dual-tone
  const playRing = () => {
    try {
      const ctx = getCtx();
      const now = ctx.currentTime;
      const vol = 0.6;

      const playBurst = (startAt, dur) => {
        [440, 480].forEach(freq => {
          const osc  = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain); gain.connect(ctx.destination);
          osc.type = 'sine'; osc.frequency.value = freq;
          gain.gain.setValueAtTime(0, startAt);
          gain.gain.linearRampToValueAtTime(vol, startAt + 0.02);
          gain.gain.setValueAtTime(vol, startAt + dur - 0.05);
          gain.gain.linearRampToValueAtTime(0, startAt + dur);
          osc.start(startAt); osc.stop(startAt + dur);
        });
      };

      // Double-ring pattern: ring, pause, ring
      playBurst(now,       0.4);
      playBurst(now + 0.6, 0.4);
    } catch {}
  };

  const startAlarm = () => {
    if (ringingRef.current) return;
    ringingRef.current = true;
    playRing();
    timerRef.current = setInterval(playRing, 3500);
  };

  const stopAlarm = () => {
    if (!ringingRef.current) return;
    ringingRef.current = false;
    clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const hasPending = todayOrders.filter(o => o.status === 'pending').length > 0;

  useEffect(() => {
    if (!isOwnerView) { stopAlarm(); return; }
    if (hasPending) startAlarm(); else stopAlarm();
    return stopAlarm;
  }, [hasPending, isOwnerView]);
}
// ─────────────────────────────────────────────
// ROOT APP
// ─────────────────────────────────────────────
export default function App() {
  // URL-hash based routing: #/owner → owner login / dashboard
  const getRouteFromHash = () => window.location.hash === "#/owner" ? "owner" : "customer";
  const [route, setRoute] = useState(getRouteFromHash);
  const [ownerAuthed, setOwnerAuthed] = useState(false);
  const [ownerAuthChecked, setOwnerAuthChecked] = useState(false);

  // On mount, ask Supabase Auth if there's already a valid owner session
  // (e.g. page reload, tab reopened). Also listen for sign-out events
  // (session expiry, manual sign-out) so ownerAuthed stays in sync.
  useEffect(() => {
    getOwnerSession().then(authed => {
      setOwnerAuthed(authed);
      setOwnerAuthChecked(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setOwnerAuthed(!!session);
    });
    return () => listener?.subscription?.unsubscribe();
  }, []);

  // Register the PWA service worker once on mount. It does not cache any
  // data/API responses (Supabase reads must always hit the network) - it
  // only exists so the app is installable as a home-screen app.
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Installability is a nice-to-have; don't surface errors to users.
      });
    }
  }, []);

  const [menu, setMenu] = useState(null);
  const [planConfig, setPlanConfig] = useState(null); // daily thali plan config (Gold/Standard/Mini)
  const [contactInfo, setContactInfo] = useState({ phone: "", whatsapp: "", email: "" });
  const [contactMessages, setContactMessages] = useState([]);
  const [todayOrders, setTodayOrders] = useState([]);
  const [ordersHistory, setOrdersHistory] = useState([]); // archived past orders (~100 days)
  const [customers, setCustomers] = useState([]);
  const [credit, setCredit] = useState([]);      // permanent credit ledger
  // Always-current mirror of `credit`, so handlers can make idempotency
  // decisions from the latest ledger without pulling `credit` into their
  // dependency arrays (which would recreate them on every ledger change).
  const creditRef = useRef(credit);
  useEffect(() => { creditRef.current = credit; }, [credit]);
  const customersRef = useRef(customers);
  useEffect(() => { customersRef.current = customers; }, [customers]);
  const [kitchenOpen, setKitchenOpen] = useState(true); // owner-controlled
  const [poll, setPoll] = useState(null);               // owner-defined customer poll
  const [pollResponses, setPollResponses] = useState([]); // customer poll submissions (owner-only)
  const [promoCodes, setPromoCodes] = useState([]);       // owner-defined promo codes
  const [referralConfig, setReferralConfig] = useState(defaultReferralConfig());
  const [loaded, setLoaded] = useState(false);

  // Listen to hash changes so back/forward browser nav works
  useEffect(() => {
    const onHash = () => {
      const r = getRouteFromHash();
      setRoute(r);
      if (r === "customer") { clearOwnerSession(); } // auto-logout when navigating away (onAuthStateChange updates ownerAuthed)
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // ── BOOT: load storage + handle daily rollover ──
  useEffect(() => {
    (async () => {
      const today = todayStr();
      const [m, td, cust, lastDate, cred, ko, hist, pl, pr, pc, ci, cm, prm, rcfg] = await Promise.all([
        load(KEYS.menu),
        loadTodayOrdersFromTable(today), // Stage 4: reads from `orders` table now, not app_data
        loadCustomersFromTable(), // Stage 6: reads from `customers` table now, not app_data
        load(KEYS.lastDate),
        loadCreditFromTable(), // Stage 10: reads from `credit_ledger` table now, not app_data
        load(KEYS.kitchenOpen),
        loadHistoryOrdersFromTable(today), // Stage 4: reads from `orders` table now, not app_data
        load(KEYS.poll),
        loadPollResponsesFromTable(), // Stage 7: reads from `poll_responses` table now, not app_data
        load(KEYS.planConfig),
        load(KEYS.contactInfo),
        loadContactMessagesFromTable(), // Stage 7: reads from `contact_messages` table now, not app_data
        load(KEYS.promoCodes),
        load(KEYS.referralConfig),
      ]);

      if (m) setMenu(m);
      if (pc) setPlanConfig(normalisePlanConfig(pc));
      if (ci) setContactInfo({ phone: "", whatsapp: "", email: "", ...ci });
      if (Array.isArray(cm)) setContactMessages(cm);
      if (cust) setCustomers(cust);
      if (cred) setCredit(cred);
      if (ko !== null && ko !== undefined) setKitchenOpen(!!ko);
      if (pl) setPoll(pl);
      if (Array.isArray(pr)) setPollResponses(pr);
      if (Array.isArray(prm)) setPromoCodes(prm);
      if (rcfg) setReferralConfig({ ...defaultReferralConfig(), ...rcfg });

      // td is already filtered to today's date, hist already excludes today
      // (loadTodayOrdersFromTable/loadHistoryOrdersFromTable do this) — the
      // relational table separates "today" vs "history" naturally by date,
      // so unlike the old blob approach, no manual archiving step is needed
      // here anymore. Rows just stop appearing in "today" once their date
      // isn't today, and start appearing in "history" — same underlying data.
      setTodayOrders(td || []);
      setOrdersHistory(hist || []);

      if (lastDate !== today) {
        // Day has changed. Drop settled (zero-balance) credit customers.
        const storedCredit = cred || [];
        const getBalance = (entries) => entries.reduce((s, e) => e.type === "debit" ? s + e.amount : s - e.amount, 0);
        const rolledCredit = storedCredit.filter(c => getBalance(c.entries) !== 0);
        setCredit(rolledCredit);
        const droppedPhones = storedCredit.map(c => c.phone).filter(p => !rolledCredit.some(c => c.phone === p));
        await Promise.all([
          ...droppedPhones.map(p => deleteCreditForPhone(p)),
          save(KEYS.lastDate, today),
        ]);
      }

      setLoaded(true);
    })();
  }, []);

  // ── Apply a single (key, value) update to local state — shared by the
  // realtime subscription handler AND the manual catch-up sync below, so
  // both paths use identical merge/precedence logic. ──
  const applyKeyUpdate = useCallback((changedKey, newVal) => {
    // Only config still lives in app_data. Orders, customers, credit,
    // contact messages and poll responses each have their own table and
    // their own realtime subscription (see below), so nothing
    // transactional is applied from an app_data payload anymore.
    if (changedKey === KEYS.menu)        setMenu(newVal);
    if (changedKey === KEYS.planConfig)  setPlanConfig(normalisePlanConfig(newVal));
    if (changedKey === KEYS.contactInfo)     setContactInfo({ phone: "", whatsapp: "", email: "", ...(newVal || {}) });
    if (changedKey === KEYS.kitchenOpen) setKitchenOpen(!!newVal);
    if (changedKey === KEYS.poll)        setPoll(newVal || null);
    if (changedKey === KEYS.promoCodes) setPromoCodes(Array.isArray(newVal) ? newVal : []);
    if (changedKey === KEYS.referralConfig) setReferralConfig({ ...defaultReferralConfig(), ...(newVal || {}) });
  }, []);

  // ── Manual catch-up sync: re-fetches every key from Supabase and merges
  // it in. Realtime websockets get silently dropped when a mobile tab is
  // backgrounded/screen-locked (and sometimes on laptops after long idle
  // periods) and don't always auto-recover, so any changes made by other
  // devices during that gap would otherwise be missed forever. This is the
  // safety net that backfills them once the app is active again. ──
  const catchUpSync = useCallback(async () => {
    // Config keys still live in app_data, so fetch and apply those.
    const configKeys = [KEYS.menu, KEYS.planConfig, KEYS.contactInfo, KEYS.kitchenOpen,
                        KEYS.poll, KEYS.promoCodes, KEYS.referralConfig];
    const results = await Promise.all(configKeys.map(k => load(k)));
    configKeys.forEach((k, i) => {
      // load() returns null both when a row genuinely doesn't exist yet AND
      // when the fetch itself failed (network blip). Skipping null here
      // means a flaky catch-up request can never wipe out real local data.
      if (results[i] !== null) applyKeyUpdate(k, results[i]);
    });

    // Everything else now lives in its own table — re-read those directly
    // rather than going through the stale app_data blobs.
    const today = todayStr();
    const [tOrders, hOrders, custs, cred, msgs, polls] = await Promise.all([
      loadTodayOrdersFromTable(today),
      loadHistoryOrdersFromTable(today),
      loadCustomersFromTable(),
      loadCreditFromTable(),
      loadContactMessagesFromTable(),
      loadPollResponsesFromTable(),
    ]);
    if (tOrders) setTodayOrders(current => mergeOrders(current, tOrders));
    if (hOrders) setOrdersHistory(current => mergeOrders(current, hOrders));
    if (custs) setCustomers(custs);
    if (cred) setCredit(cred);
    if (msgs) setContactMessages(msgs);
    if (polls) setPollResponses(polls);
  }, [applyKeyUpdate]);

  // ── Real-time sync via Supabase: instantly updates all devices when data changes ──
  const [realtimeTick, setRealtimeTick] = useState(0);
  useEffect(() => {
    if (!loaded) return;
    const channel = supabase
      .channel(`app_data_changes_${realtimeTick}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "app_data" }, async (payload) => {
        const changedKey = payload.new?.key || payload.old?.key;
        if (!changedKey) return;
        applyKeyUpdate(changedKey, payload.new?.value);
      })
      // The migrated tables need their own subscriptions — listening only
      // to app_data would miss any change written directly to them
      // (e.g. a customer order placed via the place_order RPC).
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, async () => {
        const today = todayStr();
        const [t, h] = await Promise.all([loadTodayOrdersFromTable(today), loadHistoryOrdersFromTable(today)]);
        if (t) setTodayOrders(current => mergeOrders(current, t));
        if (h) setOrdersHistory(current => mergeOrders(current, h));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "customers" }, async () => {
        const rows = await loadCustomersFromTable();
        if (rows) setCustomers(rows);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "credit_ledger" }, async () => {
        const rows = await loadCreditFromTable();
        if (rows) setCredit(rows);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "contact_messages" }, async () => {
        const rows = await loadContactMessagesFromTable();
        if (rows) setContactMessages(rows);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "poll_responses" }, async () => {
        const rows = await loadPollResponsesFromTable();
        if (rows) setPollResponses(rows);
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [loaded, realtimeTick, applyKeyUpdate]);

  // ── Recover from dropped connections: when the tab regains visibility
  // (screen unlocked / app reopened) or the network comes back online,
  // force a fresh realtime subscription AND run a manual catch-up sync.
  // This is what fixes "doesn't ring / doesn't move forward until I
  // refresh" — the old code relied entirely on the websocket staying
  // alive forever, which mobile Chrome does not guarantee. ──
  useEffect(() => {
    if (!loaded) return;
    const onWake = () => {
      if (document.visibilityState !== "visible" && !navigator.onLine) return;
      setRealtimeTick(t => t + 1); // tears down + recreates the channel
      catchUpSync();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [loaded, catchUpSync]);

  // ── New order alert sound ──
  useOrderAlert(todayOrders, route === "owner" && ownerAuthed);

  const handleSaveMenu = useCallback(async (newMenu) => {
    setMenu(newMenu); await save(KEYS.menu, newMenu);
  }, []);

  const handleSavePlanConfig = useCallback(async (newConfig) => {
    setPlanConfig(newConfig); await save(KEYS.planConfig, newConfig);
  }, []);

  const handleSaveContactInfo = useCallback(async (info) => {
    const clean = { phone: (info.phone || "").trim(), whatsapp: (info.whatsapp || "").trim(), email: (info.email || "").trim() };
    setContactInfo(clean); await save(KEYS.contactInfo, clean);
  }, []);

  const handleSavePromoCodes = useCallback(async (next) => {
    const clean = Array.isArray(next) ? next : [];
    setPromoCodes(clean);
    await save(KEYS.promoCodes, clean);
  }, []);

  const handleSaveReferralConfig = useCallback(async (cfg) => {
    const clean = { ...defaultReferralConfig(), ...(cfg || {}) };
    setReferralConfig(clean);
    await save(KEYS.referralConfig, clean);
  }, []);

  const handleSubmitContactMessage = useCallback(async ({ name, phone, message }) => {
    const entry = {
      id: genId(),
      name: (name || "").trim(),
      phone: (phone || "").trim(),
      message: (message || "").trim(),
      ts: Date.now(),
      read: false,
    };
    setContactMessages(prev => [entry, ...prev].slice(0, 500));
    // RPC, not a direct insert: customers aren't authenticated, so RLS
    // blocks a direct table write here.
    try {
      const { error } = await supabase.rpc("submit_contact_message", {
        p_id: entry.id, p_name: entry.name, p_phone: entry.phone, p_message: entry.message,
      });
      if (error) console.error("[submit_contact_message RPC] failed:", error);
    } catch (err) {
      console.error("[submit_contact_message RPC] threw:", err);
    }
    return true;
  }, []);

  const handleMarkContactRead = useCallback(async (id) => {
    setContactMessages(prev => {
      const next = prev.map(m => m.id === id ? { ...m, read: true } : m);
      const target = next.find(m => m.id === id);
      if (target) saveContactMessagesToTable([target]);
      return next;
    });
  }, []);

  const handleDeleteContactMessage = useCallback(async (id) => {
    setContactMessages(prev => prev.filter(m => m.id !== id));
    await deleteContactMessageFromTable(id);
  }, []);

  const handleToggleKitchen = useCallback(async () => {
    const next = !kitchenOpen;
    setKitchenOpen(next);
    await save(KEYS.kitchenOpen, next);
  }, [kitchenOpen]);

  // ── Save poll config ──
  // If the question or choices changed, mint a fresh poll id so responses are
  // grouped per poll version. Toggling on/off keeps the same id (see below).
  const handleSavePoll = useCallback(async ({ question, options }) => {
    const prevOpts = (poll?.options || []).filter(o => o && o.trim());
    const changed =
      (poll?.question || "").trim() !== (question || "").trim() ||
      JSON.stringify(prevOpts) !== JSON.stringify(options || []);
    const next = {
      id: changed || !poll?.id ? genId() : poll.id,
      active: poll?.active ?? false,
      question: question || "",
      options: options || [],
      createdAt: (changed || !poll?.createdAt) ? new Date().toISOString() : poll.createdAt,
    };
    setPoll(next);
    await save(KEYS.poll, next);
  }, [poll]);

  // ── Toggle poll on/off ── (keeps id + content intact)
  const handleTogglePoll = useCallback(async () => {
    const base = poll || { id: genId(), question: "", options: [], createdAt: new Date().toISOString() };
    const next = { ...base, active: !base.active };
    setPoll(next);
    await save(KEYS.poll, next);
  }, [poll]);

  // ── Submit a customer poll response ──
  // Now a plain insert to the poll_responses table — no fetch-merge-write
  // needed, since each response is its own row (the old blob-append
  // pattern existed only to work around the old blob storage).
  const handleSubmitPollResponse = useCallback(async (response) => {
    if (!response || !response.id) return;
    setPollResponses(prev => {
      const next = [response, ...prev];
      return next.length > MAX_POLL_RESPONSES ? next.slice(0, MAX_POLL_RESPONSES) : next;
    });
    // RPC, not a direct insert: customers aren't authenticated, so RLS
    // blocks a direct table write here.
    const { id, pollId, choice, ...extra } = response;
    try {
      const { error } = await supabase.rpc("submit_poll_response", {
        p_id: id, p_poll_id: pollId || "unknown", p_phone: response.phone || null, p_choice: choice || "", p_extra: extra,
      });
      if (error) console.error("[submit_poll_response RPC] failed:", error);
    } catch (err) {
      console.error("[submit_poll_response RPC] threw:", err);
    }
  }, []);

  const handleClearPollResponses = useCallback(async () => {
    setPollResponses([]);
    await clearPollResponsesTable();
  }, []);

  const handlePlaceOrder = useCallback(async (order) => {
    // ── Concurrency-safe write (fetch → merge → write) ──
    const today = todayStr();
    const serverOrders = (await loadTodayOrdersFromTable(today)) || [];
    const localToday = todayOrders.filter(o => o.date === today);
    const merged = mergeOrders(localToday, serverOrders);
    const newTodayOrders = [order, ...merged.filter(o => o.id !== order.id)];
    setTodayOrders(newTodayOrders);

    // RPC, not a direct table write: customers aren't authenticated
    // (no owner login), so RLS blocks direct inserts to orders/customers.
    // The RPC recomputes price/discount server-side and may not match
    // what this optimistic local `order` object assumed — so once it
    // returns, we re-fetch the actual row and correct local state to
    // match. Without this, the dashboard could show the client's
    // (possibly wrong / tampered) total instead of what was really
    // charged and stored.
    let authoritativeOrder = null;
    try {
      const { error } = await supabase.rpc("place_order", { p_order: order });
      if (error) {
        console.error("[place_order RPC] failed (app_data still has the order):", error);
      } else {
        const { data: row, error: fetchErr } = await supabase.from("orders").select("*").eq("id", order.id).maybeSingle();
        if (!fetchErr && row) authoritativeOrder = rowToOrder(row);
      }
    } catch (err) {
      console.error("[place_order RPC] threw (app_data still has the order):", err);
    }

    if (authoritativeOrder) {
      setTodayOrders(prev => prev.map(o => o.id === order.id ? { ...o, ...authoritativeOrder } : o));
    }

    const finalOrder = authoritativeOrder || order;
    setCustomers(prev => {
      const next = [...prev];
      const idx = next.findIndex(c => c.phone === finalOrder.phone);
      if (idx >= 0) {
        next[idx] = { ...next[idx], totalOrders: next[idx].totalOrders + 1, totalSpent: next[idx].totalSpent + finalOrder.total, lastOrderDate: finalOrder.date, tower: finalOrder.tower, flat: finalOrder.flat };
      } else {
        next.push({ name: finalOrder.customerName, phone: finalOrder.phone, tower: finalOrder.tower, flat: finalOrder.flat, totalOrders: 1, totalSpent: finalOrder.total, firstOrderDate: finalOrder.date, lastOrderDate: finalOrder.date });
      }
      // customers table write already happened inside the place_order RPC above
      return next;
    });
  }, [todayOrders]);

  const handleAdvanceOrder = useCallback(async (orderId, nextStatus) => {
    // ── Concurrency-safe write (fetch → merge → validate → write) ──
    const today = todayStr();
    const serverOrders = (await loadTodayOrdersFromTable(today)) || [];
    const localToday = todayOrders.filter(o => o.date === today);
    const base = mergeOrders(localToday, serverOrders);
    const order = base.find(o => o.id === orderId);
    if (!order) return;

    // Anti-regression guard: if the merged truth is already at-or-past
    // the target status, this click came from a stale UI. Sync local
    // state to reality and bail — never write a lower status back.
    const rNext = STATUS_RANK[nextStatus] ?? -1;
    const rCurr = STATUS_RANK[order.status] ?? -1;
    if (rNext <= rCurr) {
      setTodayOrders(base);
      await writeOrders(base);
      return;
    }

    // Stamp the timestamp for this status transition (used by the Sales
    // Dashboard to compute avg prep/delivery time). Only ever set once per
    // order — if it's already there (e.g. re-merge from another device),
    // it's left untouched rather than overwritten.
    const stampField = nextStatus === "preparing" ? "preparingAt"
      : nextStatus === "ready" ? "readyAt"
      : nextStatus === "dispatched" ? "dispatchedAt"
      : nextStatus === "delivered" ? "deliveredAt"
      : null;
    const nowIso = new Date().toISOString();
    const updated = base.map(o => {
      if (o.id !== orderId) return o;
      const next = { ...o, status: nextStatus };
      if (stampField && !next[stampField]) next[stampField] = nowIso;
      return next;
    });
    setTodayOrders(updated);
    await writeOrders(updated.filter(o => o.id === orderId));

    // When delivered → auto-debit credit ledger.
    // Idempotent: each order can only be credited ONCE, no matter how many
    // times handleAdvanceOrder is called with nextStatus="delivered".
    // This prevents duplicate debits from stale-UI re-clicks, rapid taps,
    // realtime retries, or the historical status-regression bug.
    if (nextStatus === "delivered") {
      const orderDetails = order.items.map(i => `${i.name}×${i.qty}`).join(", ");

      // ── Build the new entries FIRST, outside any setState updater. ──
      // These used to be created inside the setCredit() updater and read on
      // the line after it. React does not run an updater synchronously when
      // setState is called — it queues it and runs it during render — so the
      // list was almost always still empty when the table write executed, and
      // the debit never reached `credit_ledger`. It showed in the UI until the
      // next refresh or realtime reload, then silently vanished.
      const current = creditRef.current || [];
      const pending = []; // [phone, entry, displayFields]

      const debitDone = (current.find(c => c.phone === order.phone)?.entries || [])
        .some(e => e.id === "dlv:" + order.id);
      if (!debitDone) {
        pending.push([order.phone, {
          // Deterministic id: an upsert on the same order can never create a
          // second row, even if local state was stale when we decided to write.
          id: "dlv:" + order.id,
          orderId: order.id, // ← key to idempotency
          date: new Date().toISOString(),
          type: "debit",
          amount: order.total,
          note: "Order delivered",
          orderDetails,
        }, { name: order.customerName, tower: order.tower, flat: order.flat }]);
      }

      // ── Referral payout (idempotent) ──
      // If this delivered order used a referral code, pay the referrer their
      // reward as a CREDIT entry on their ledger.
      //
      // FIX: order_id used to be set to a synthetic key ("referral:<id>")
      // purely to make the idempotency check unique. But credit_ledger.order_id
      // has a foreign-key constraint against orders.id, and "referral:<id>" is
      // never a real row there — so this insert failed with a foreign-key
      // violation on every single referral payout, silently (the error banner
      // auto-hides in 6s). order_id now holds the REAL order id (always valid,
      // since it's the same order whose debit just saved). Idempotency is
      // checked via the entry's own deterministic id ("ref:<orderId>") instead.
      if (order.referrerPhone && order.referrerRewardPending) {
        const rewardAmt = Math.max(0, Number(referralConfig?.referrerReward) || 0);
        const rewardEntryId = "ref:" + order.id;
        const alreadyPaid = (current.find(c => c.phone === order.referrerPhone)?.entries || [])
          .some(e => e.id === rewardEntryId);
        if (rewardAmt > 0 && !alreadyPaid) {
          pending.push([order.referrerPhone, {
            id: rewardEntryId,
            orderId: order.id, // real order id — satisfies the FK constraint
            date: new Date().toISOString(),
            type: "credit",
            amount: rewardAmt,
            note: `Referral bonus — ${order.customerName} used your code`,
          }, { name: order.referrerName || "Referrer", tower: "", flat: "" }]);
        }
      }

      if (pending.length) {
        // The updater is now pure — it only merges the already-built entries.
        setCredit(prev => {
          let next = prev;
          for (const [phone, entry, meta] of pending) {
            const idx = next.findIndex(c => c.phone === phone);
            if (idx >= 0) {
              // Dedup by id only — orderId is no longer unique per entry
              // (a debit and its referral credit can now share the same
              // real orderId while living on different customers' ledgers).
              if (next[idx].entries.some(e => e.id === entry.id)) continue;
              next = next.map((c, i) => i === idx ? { ...c, entries: [...c.entries, entry] } : c);
            } else {
              next = [...next, { phone, name: meta.name, tower: meta.tower, flat: meta.flat, entries: [entry] }];
            }
          }
          return next;
        });
        // Runs unconditionally now, not as a side effect of an updater.
        await Promise.all(pending.map(([phone, entry]) => saveCreditEntriesToTable(phone, [entry])));
      }
    }
  }, [todayOrders, referralConfig]);

  const handleRejectOrder = useCallback(async (orderId) => {
    // ── Concurrency-safe write (fetch → merge → validate → write) ──
    const today = todayStr();
    const serverOrders = (await loadTodayOrdersFromTable(today)) || [];
    const localToday = todayOrders.filter(o => o.date === today);
    const base = mergeOrders(localToday, serverOrders);
    const order = base.find(o => o.id === orderId);
    if (!order) return;

    // Don't reject an order another device already dispatched or delivered.
    // The reject click came from a stale UI — sync to reality and bail.
    if (order.status === "dispatched" || order.status === "delivered") {
      setTodayOrders(base);
      await writeOrders(base);
      return;
    }

    const updated = base.map(o => o.id === orderId ? { ...o, status: "rejected" } : o);
    setTodayOrders(updated);
    await writeOrders(updated.filter(o => o.id === orderId));
  }, [todayOrders]);

  // ── Submit customer rating ──
  // Order might live in todayOrders (rated same day) OR ordersHistory (rated
  // on a later visit). Locate it, attach the rating, and write back using the
  // concurrency-safe fetch→merge→write pattern so no concurrent update loses
  // the rating.
  const handleSubmitRating = useCallback(async (orderId, rating) => {
    if (!orderId || !rating) return;
    const today = todayStr();

    // Persist via RPC — customers aren't authenticated, so RLS blocks a
    // direct table update. The RPC only allows setting the rating, and
    // only if the order doesn't already have one.
    try {
      const { error } = await supabase.rpc("submit_order_rating", { p_order_id: orderId, p_rating: rating });
      if (error) console.error("[submit_order_rating RPC] failed:", error);
    } catch (err) {
      console.error("[submit_order_rating RPC] threw:", err);
    }

    // First check today's orders
    const inToday = todayOrders.some(o => o.id === orderId);
    if (inToday) {
      const serverOrders = (await loadTodayOrdersFromTable(today)) || [];
      const localToday = todayOrders.filter(o => o.date === today);
      const base = mergeOrders(localToday, serverOrders);
      const target = base.find(o => o.id === orderId);
      if (!target) return;
      // Idempotency: don't overwrite an existing rating
      if (target.rating) return;
      const updated = base.map(o => o.id === orderId ? { ...o, rating } : o);
      setTodayOrders(updated); // already persisted via the submit_order_rating RPC above
      return;
    }

    // Otherwise it's in history
    const serverHistory = (await loadHistoryOrdersFromTable(today)) || [];
    const base = mergeOrders(ordersHistory, serverHistory);
    const target = base.find(o => o.id === orderId);
    if (!target) return;
    if (target.rating) return;
    const updated = base.map(o => o.id === orderId ? { ...o, rating } : o);
    setOrdersHistory(updated); // already persisted via the submit_order_rating RPC above
  }, [todayOrders, ordersHistory]);

  const handleAddCredit = useCallback(async (phone, entry) => {
    if (!phone) return;
    const newEntry = { id: genId(), date: new Date().toISOString(), ...entry };
    setCredit(prev => {
      // Previously this used prev.map(), so if the phone had no ledger record
      // in local state the row was written to the table but never appeared in
      // the UI until a reload. Now an absent phone gets a record created.
      if (prev.some(c => c.phone === phone)) {
        return prev.map(c => c.phone === phone ? { ...c, entries: [...c.entries, newEntry] } : c);
      }
      const cust = customersRef.current.find(c => c.phone === phone);
      return [...prev, {
        phone,
        name: cust?.name || "",
        tower: cust?.tower || "",
        flat: cust?.flat || "",
        entries: [newEntry],
      }];
    });
    await saveCreditEntriesToTable(phone, [newEntry]);
  }, []);

  const handleDeleteCreditEntry = useCallback(async (phone, entryId) => {
    setCredit(prev => prev.map(c => c.phone === phone ? { ...c, entries: c.entries.filter(e => e.id !== entryId) } : c));
    await deleteCreditEntryRow(entryId);
  }, []);

  const handleResetCreditCustomer = useCallback(async (phone) => {
    // deleteCreditForPhone removes every row for this phone, and
    // loadCreditFromTable only rebuilds phones that still have rows — so the
    // customer disappears on the next reload. Drop them locally too, rather
    // than leaving a zero-entry record that reality doesn't match.
    setCredit(prev => prev.filter(c => c.phone !== phone));
    await deleteCreditForPhone(phone);
  }, []);

  const handleDeleteCreditCustomer = useCallback(async (phone) => {
    setCredit(prev => prev.filter(c => c.phone !== phone));
    await deleteCreditForPhone(phone);
  }, []);

  // ── Reconcile Credit Ledger ──
  // Rebuilds auto-debit entries from actual delivered orders (today + history).
  // Removes duplicate "Order delivered" entries created before the idempotency
  // fix. Manual entries (payments, adjustments) are preserved intact.
  const handleReconcileCredit = useCallback(async () => {
    const today = todayStr();
    const allOrders = [
      ...(todayOrders || []).filter(o => o.date === today),
      ...(ordersHistory || []),
    ];
    const deliveredOrders = allOrders.filter(o => o.status === "delivered");

    // Group delivered orders by phone
    const ordersByPhone = new Map();
    for (const o of deliveredOrders) {
      if (!ordersByPhone.has(o.phone)) ordersByPhone.set(o.phone, []);
      ordersByPhone.get(o.phone).push(o);
    }

    const makeDebit = (o) => ({
      // Deterministic, matching the live delivery-flow id ("dlv:"+orderId).
      // Keeping these consistent means the delivery flow's own duplicate
      // guard still recognises a reconciled debit as already-existing, so
      // the two code paths can never together produce two debit rows for
      // the same order.
      id: "dlv:" + o.id,
      orderId: o.id,
      date: o.createdAt || new Date().toISOString(),
      type: "debit",
      amount: o.total,
      note: "Order delivered",
      orderDetails: (o.items || []).map(i => `${i.name}×${i.qty}`).join(", "),
    });

    const newCredit = [];
    const seenPhones = new Set();

    // Rebuild for existing customers, preserving manual entries
    for (const cust of credit || []) {
      seenPhones.add(cust.phone);
      // Manual entries = anything that isn't an auto-debit from a delivered order
      const manualEntries = (cust.entries || []).filter(e => e.note !== "Order delivered");
      const custOrders = ordersByPhone.get(cust.phone) || [];
      const autoDebits = custOrders.map(makeDebit);
      // Drop customers with zero entries after reconcile
      if (manualEntries.length > 0 || autoDebits.length > 0) {
        newCredit.push({
          phone: cust.phone,
          name: cust.name,
          tower: cust.tower,
          flat: cust.flat,
          entries: [...autoDebits, ...manualEntries],
        });
      }
    }

    // Add customers who have delivered orders but no credit record yet
    for (const [phone, custOrders] of ordersByPhone.entries()) {
      if (seenPhones.has(phone)) continue;
      const firstOrder = custOrders[0];
      newCredit.push({
        phone,
        name: firstOrder.customerName,
        tower: firstOrder.tower,
        flat: firstOrder.flat,
        entries: custOrders.map(makeDebit),
      });
    }

    setCredit(newCredit);
    await Promise.all(newCredit.map(c => replaceAllCreditEntries(c.phone, c.entries)));
    // Also clear phones that dropped out entirely (zero entries after reconcile)
    const newPhones = new Set(newCredit.map(c => c.phone));
    const droppedPhones = (credit || []).map(c => c.phone).filter(p => !newPhones.has(p));
    await Promise.all(droppedPhones.map(p => deleteCreditForPhone(p)));
  }, [credit, todayOrders, ordersHistory]);

  const handleResetAllData = useCallback(async () => {
    // Wipe transactional data; keep menu + kitchen settings
    setTodayOrders([]);
    setOrdersHistory([]);
    setCustomers([]);
    setCredit([]);
    setContactMessages([]);
    setPollResponses([]);
    await save(KEYS.lastDate, todayStr());
    // The five tables are the only store for transactional data now.
    try {
      await supabase.from("credit_ledger").delete().neq("id", "");
      await supabase.from("orders").delete().neq("id", "");
      await supabase.from("customers").delete().neq("phone", "");
      await supabase.from("contact_messages").delete().neq("id", "");
      await supabase.from("poll_responses").delete().neq("id", "");
    } catch (err) {
      notifyStorageError("delete", "reset all data", err);
    }
  }, []);

  const handleOwnerLogout = () => {
    clearOwnerSession(); // onAuthStateChange fires and updates ownerAuthed
    window.location.hash = "";
  };

  if (!loaded) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.cream }}>
      <div style={{ textAlign: "center" }}><div style={{ fontSize: 40, marginBottom: 12 }}>🍱</div><p style={{ color: C.inkMid }}>Loading...</p></div>
    </div>
  );

  return (
    <div>
      <GlobalStyle />
      <SaveErrorBanner />
      <InstallAppButton />

      {route === "customer" && (
        <CustomerApp
          menu={menu}
          planConfig={planConfig}
          contactInfo={contactInfo}
          orders={todayOrders}
          ordersHistory={ordersHistory}
          kitchenOpen={kitchenOpen}
          poll={poll}
          promoCodes={promoCodes}
          referralConfig={referralConfig}
          customers={customers}
          onPlaceOrder={handlePlaceOrder}
          onSubmitRating={handleSubmitRating}
          onSubmitPollResponse={handleSubmitPollResponse}
          onSubmitContactMessage={handleSubmitContactMessage}
          onOwnerAccess={() => { window.location.hash = "#/owner"; }}
        />
      )}

      {route === "owner" && !ownerAuthChecked && (
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.cream }}>
          <div style={{ textAlign: "center" }}><div style={{ fontSize: 40, marginBottom: 12 }}>🍱</div><p style={{ color: C.inkMid }}>Loading...</p></div>
        </div>
      )}

      {route === "owner" && ownerAuthChecked && !ownerAuthed && (
        <OwnerLogin onSuccess={() => setOwnerAuthed(true)} />
      )}

      {route === "owner" && ownerAuthChecked && ownerAuthed && (
        <BackendApp
          menu={menu}
          planConfig={planConfig}
          contactInfo={contactInfo}
          contactMessages={contactMessages}
          todayOrders={todayOrders}
          ordersHistory={ordersHistory}
          customers={customers}
          credit={credit}
          kitchenOpen={kitchenOpen}
          poll={poll}
          pollResponses={pollResponses}
          promoCodes={promoCodes}
          referralConfig={referralConfig}
          onSaveMenu={handleSaveMenu}
          onSavePlanConfig={handleSavePlanConfig}
          onSaveContactInfo={handleSaveContactInfo}
          onMarkContactRead={handleMarkContactRead}
          onDeleteContactMessage={handleDeleteContactMessage}
          onAdvanceOrder={handleAdvanceOrder}
          onRejectOrder={handleRejectOrder}
          onLogout={handleOwnerLogout}
          onAddCredit={handleAddCredit}
          onDeleteCreditEntry={handleDeleteCreditEntry}
          onResetCreditCustomer={handleResetCreditCustomer}
          onDeleteCreditCustomer={handleDeleteCreditCustomer}
          onReconcileCredit={handleReconcileCredit}
          onToggleKitchen={handleToggleKitchen}
          onResetAllData={handleResetAllData}
          onSavePoll={handleSavePoll}
          onTogglePoll={handleTogglePoll}
          onClearPollResponses={handleClearPollResponses}
          onSavePromoCodes={handleSavePromoCodes}
          onSaveReferralConfig={handleSaveReferralConfig}
        />
      )}
    </div>
  );
}
