import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

// ─────────────────────────────────────────────
// SUPABASE CLIENT
// ─────────────────────────────────────────────
const SUPABASE_URL = "https://locesmksvetbdhsvgqip.supabase.co";
const SUPABASE_KEY = "sb_publishable_A24gDavt6HAX7sreGI9vQA_ol2PO1Yb";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─────────────────────────────────────────────
// STORAGE HELPERS (Supabase-backed, cross-device)
// ─────────────────────────────────────────────
const KEYS = {
  menu: "ht_menu",
  todayOrders: "ht_orders_today",
  ordersHistory: "ht_orders_history", // permanent — archived past orders (pruned to ~100 days)
  customers: "ht_customers",
  lastDate: "ht_last_open_date",
  credit: "ht_credit_ledger",     // permanent — khata book style payment ledger
  kitchenOpen: "ht_kitchen_open", // boolean — owner controls if accepting orders
  poll: "ht_poll",                // owner-defined customer poll config { id, active, question, options[] }
  pollResponses: "ht_poll_responses", // customer poll submissions — OWNER-ONLY view, never shown to customers
  planConfig: "ht_plan_config",   // daily thali-plan config: sabjis/rice/salad/raita/sweet + plan prices
};

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
    prices: { gold: 199, standard: 120, mini: 80, raita: 30, salad: 20, sweet: 30 },
  };
}

// Cap stored poll responses so the payload stays small for realtime sync.
const MAX_POLL_RESPONSES = 3000;

async function load(key) {
  try {
    const { data, error } = await supabase.from("app_data").select("value").eq("key", key).maybeSingle();
    if (error || !data) return null;
    return data.value;
  } catch { return null; }
}
async function save(key, val) {
  try {
    await supabase.from("app_data").upsert({ key, value: val, updated_at: new Date().toISOString() }, { onConflict: "key" });
  } catch {}
}
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function todayStr() { return new Date().toISOString().split("T")[0]; }
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
  dispatched: 2,
  delivered: 3,
  rejected: 3, // terminal, same rank as delivered
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
function CustomerDetailsModal({ cart, menuItems, cartTotal, cartCount, specialInstructions, onConfirm, onClose }) {
  const [form, setForm] = useState({ name: "", phone: "", tower: "", flat: "" });
  const [errors, setErrors] = useState({});

  const validate = () => {
    const e = {};
    if (!form.name.trim()) e.name = "Required";
    if (!form.phone.trim() || !/^\d{10}$/.test(form.phone.trim())) e.phone = "Enter a valid 10-digit number";
    if (!form.tower) e.tower = "Select your tower";
    if (!form.flat.trim()) e.flat = "Required";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleConfirm = () => {
    if (!validate()) return;
    const orderItems = Object.entries(cart).map(([id, qty]) => {
      const item = menuItems.find(i => i.id === id);
      return { id, name: item.name, price: item.price, qty };
    });
    onConfirm({
      id: genId(),
      customerName: form.name.trim(),
      phone: form.phone.trim(),
      tower: form.tower,
      flat: form.flat.trim(),
      items: orderItems,
      total: cartTotal,
      specialInstructions: (specialInstructions || "").trim(),
      status: "pending",
      date: todayStr(),
      createdAt: new Date().toISOString(),
    });
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

        <button className="ht-btn btn-primary btn-full btn-lg" style={{ marginTop: 24 }} onClick={handleConfirm}>
          ✓ Confirm Order · ₹{cartTotal}
        </button>
        <button className="ht-btn btn-ghost btn-full btn-sm" style={{ marginTop: 8 }} onClick={onClose}>
          Cancel
        </button>
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
      const id = `gold:${bread}:${sabjiSel.slice().sort().join("+")}:${sweetOrRaita}`;
      const name = `Homely Gold — ${breadLabel}, ${chosenSabjis.map(s => s.name).join(" + ")}, ${planConfig.rice}, ${sweetRaitaLabel}, ${planConfig.salad}`;
      onAdd(id, name, planConfig.prices.gold);
    } else if (isStandard) {
      // Standard is a fixed configuration — nothing to choose. The dialog is
      // just a confirmation of what's included.
      const id = "plan-standard";
      const name = `Homely Standard — 4 Chapati, ${nonPremium[0].name} + ${nonPremium[1].name}, Steamed Rice, Standard Salad`;
      onAdd(id, name, planConfig.prices.standard);
    } else if (isMini) {
      if (!miniValid) return;
      const sabji = nonPremium.find(s => s.id === miniSabji);
      const id = `mini:${miniSabji}`;
      const name = `Homely Mini — 4 Chapati, ${sabji.name}, Standard Salad`;
      onAdd(id, name, planConfig.prices.mini);
    }
  };

  const title = isGold ? "✨ Homely Gold" : isStandard ? "Homely Standard" : "Homely Mini";
  const subtitle = isStandard ? "This is what's included — just confirm" : "Customize your thali";

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-sheet">
        <div style={{ width: 40, height: 4, borderRadius: 2, background: C.border, margin: "0 auto 20px" }} />
        <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink, marginBottom: 4 }}>{title}</h2>
        <p style={{ fontSize: 13, color: C.inkMid, marginBottom: 18 }}>{subtitle}</p>

        {isGold && (
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
                Choose 2 Sabjis <span style={{ color: C.inkLight, fontWeight: 400 }}>({sabjiSel.length}/2 selected)</span>
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
              <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", fontSize: 14, color: C.ink, cursor: "default" }}>
                <input type="radio" checked readOnly style={{ accentColor: C.saffron, width: 16, height: 16 }} />
                Steamed Rice
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
              <label style={{ fontSize: 12, fontWeight: 700, color: C.ink, display: "block", marginBottom: 8 }}>Choose 1 Sabji</label>
              {nonPremium.map(s => (
                <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", fontSize: 14, color: C.ink, cursor: "pointer" }}>
                  <input type="radio" name="miniSabji" checked={miniSabji === s.id} onChange={() => setMiniSabji(s.id)} style={{ accentColor: C.saffron, width: 16, height: 16 }} />
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
          disabled={isGold ? !goldValid : isMini ? !miniValid : false}
          onClick={handleAdd}
        >
          Add to Cart · ₹{isGold ? planConfig.prices.gold : isStandard ? planConfig.prices.standard : planConfig.prices.mini}
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
const AUNTY_SRC = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAfQAAAIzCAIAAAB5sXxMAAEAAElEQVR42tT9eZAsW34ehn1ny5NLrd19u+/y1nkzGAADDIcLxAUECIMMiotkywzSJrSEZQUlWWErKFO2pLCssBQ05TCthY4wRSmCkmWaokRZEneJoABSwj4kIA2WN5h5b97Me+/ed7deas3l7P7jVGVnV1XX7b7vDixndHRkZWVlVWVlfuc73+/7/X7ELN7Hi5aw+PDZL/4szOzo3gM+GAPAx1/75a9+defOk9Pm42dnAHrDDMByVveG2ejwDpOU07TX79FUxD0lW60oZ7oPtxfGE2d1XKlUOT+dnE3Lo1GRCKGN2dh558abLNY3TnkACxUA9CW5yavizrddVKOve2pWO62q0/N5RdTGU0YupuT8osnMojm5s/m+z06vfGDRTw/SGud32i13isLIxfSCPvNnqwPOMjGs43o84MZBzCybYAFgjP7q98VijH6Wis/0jkaS7/+aknsAytK4riyN/4XgNOj4VNxnY/EkiTt0VwDQoNuVdmO7DKUgUoAIAAirayCoKxcDkSJuXDpCkyZ3Mm4BACIY44wRAM6FdsU5yxgHELfcdmkPtb0Qwqy1zlkEs1Ssl9IkEe1LCGE7bsbgNo7QbnEuXH1f2zhqjbVqYSE5lDFWCM540i8yAPFLXd5ljLRH2PjAG0cG4AJhJMQV7zZ/QUouP6QPbGPLK17iD03E5UMi2l+/c6bE5bN7jvPC5erVdblx6+XthUek2LgIAcyUMcYCEIK/9Fc3xhJRcCgA8Se+8iu85PlMk0/zc/jG3ATW47OM73uvRIju+gayd599IbJvgPULUfvlYP1Gp1eZ3ch+Qa+D8ojmV/ZfNBdNBuC81t0jtA8BbCO7mWVmlrXIfjlmYxFXIsr3av5CTN+G+IjsLTRfh+xdEN8G/W2Ib1eWjlx3o5KI+923SJoW66+gQwfddoCau/WPvo3sLWp3kbon3cZLNnB842F34/Yw4AJhjKfMc8EJlYLuHHVs/NtG9hd+zRWyOwv/AkykxH0bkT3+cF3A7f6O2zhOxKe+Oc2OYSCYV/iFIujv37K6fwVvAX0D2V8e3D/lQlNxE9q+h8tv43v8/3LIvnN5IXPvS7JQoS9J/Ps07zWr3el0MavdrN57GxyeXgflAA7SevOaWDRdKI9jg5Xzbex+dkoisrcg3oX+HT/NAU1Sp7WuiKqIiis3+aZdNL8O2bt4HXG85e/d7d2HEet7LGzfaV1YjxwqKFMx5XWaO7lxfzpnI645Fzpgx1/IwW+HD8FdB/3OhRapIyuPO4fgdhL5PbgfUTtlnomE0rCTJDLG47fronn3DOxHecY4qGixO65s0/Zfo6VL3q+D/v30/yXea88u6wsv0vYNbrFn2f6ZXsjuLeT2xpvOCKjIvJl1txTDUTmbvpIfJeL7fkBvlZmdO2zw94jyLyfO3Ha5lYazU4Ep7dKVduIMgKNBBsA1Owbq6QXF4Qqyt6H8MJPntRL9ND67sbQQ3yL7NnZvIPsJPQJAiM+kqJvLM5ml4jBLMiWWStfSwF5eX5nSOeeJZJLzLnC3ssw2pu8h712qvqHARKxvET+uM54QyXdPybf0mdxJsLBxv61hzsb74rZktoXFTzMAdF/bAnqL7zuFnXb7lQ9MggN8YPtZc6s4bX+M9lDbas+Vl3jTAnr37eL6nnd/4We7HZveiezteheLr1Nmrr9ydmgyNx4MutdYV59hPLmOj7/Esk3bbwHu36Zlg79vA/p1D3eCqTYmyjIbnP0mKjynaavM3Irdv7Q4czpdlHZ5Nq+NXIBjKs5xfsfIRfxZpnN66DI6WE2tTstyS4Gpr8K3ioj/bHF5ZrgaXI7tct7KLzuFnS6yczW4c1QA8M4HVquaLzPbq7k8oAAyJWppzmuNGhH34zjB/QAahyxB1UuSZENwv47I78f3bX2mfXiddLPnNuvKoDvvW8YIwLsIG2EucvaX0GReyPdXx9yFLM4FwHYRv4XyLqbvOGYgkZHRLc2E8YQwue/TBsLIPsK+GgIDaR/GKUKXs0fgbuF7J46/Yq1mW2pvH25A+afR3IPB/5CWSNh3IvttmDtl3fvPpWPgw+t27g2z5azeya+7gkyL187q7Y0vsbSYHqF8g8K/EOI5TSEbKPcS+B71mRsCvWr06XTx0cWpkYtpet5VXTpToTvnrL6DYkOTuWgy0d+hwMTlosmAJuotLTE/zJKunnPJzTsR1Ocze3UesAbQAUUJeUAlkoyKXpH4uT+X9XmtWzrfvlHc8qgxhPiDfoF+tuO7r6G8Bf0XEvmdsdM9YdUrDOt6GsV45mzd3T9y9gjiEU83COwLKfnOHfa/ijHi3BXQ2Wbi7Vu3T22vdCn2pSC+Jd0ynvSk26PHxte+eIaxd7cNfWYTx6m47hN+KkFmJ76/cuWnHTD+BwD0O2G9jazeTnNfWWUA1kz279kbZgdpcdOpKE/i3wsYkNU3R/kW6LuK/MbGPVL7rWSWuPPLIDs5P8xk/NuE6WK5pa3c2VTgt15rFk03HFo3xsr5TmTfs0ywOK/1aVkauejOGHoHSR5kFHm6hL2r88QtD0N9zmqtdUTqSM+7FD6CeBtfjVvielxpt29A/HWizY47cP+9RwRjhPEsarJRem6tMttw/Eqk9v1cuKu0dN83/m3s0P51N27s2erpqx2oXEm3Hcjr8u5fm4Ux3g4MG59wzzm5BcR3Rfab42/7qu75uU69+RQUPtKLm+vvnwbxv70B1f34vo3m7RZndYTyduXmjL4L3JG271TkryXv7YeRlMlXfH62kT0qKlFUuXrqVrh5NMjGTIwOfCTmZtHEp7qYvnN4uE5+2cnfN5a6Mee1npJzHJ62f0YuKqLOWd1y9jiQdA02LeKf11or12XiLcR3gfu6+OpOoYYGvQHx3YfR/bLnxutq7hvWxp0Y2n3qtvi+J/j5QpS/Jjp65Wdq92khfk9MtZfSFt+jJhMDoeuTwF8BXt/wIFTEj9S6dPYPLS888uWzwYSmav+ugPUNVZ2dlD8e54bCzi3lwVuZIAmV18ky16P8p1teGFaNbvfbaZRrNHdWt3HU/SC+B+g3cPxWUdZoe3+F4vusdqVdbiD7C84w72EIZjkOnuOihzubyP5KluMh7yozYlhbbCo/U3KO9Pz8bLgh0EdzZNcyH4eHitrempW3/7sKzAaUd7fsV+o3yPtKnNE98H2U6jrXI16dDeblkP1SmekcoetxDMG1YtF+tR1XTZydEDGCV12AaOlzN0C6EtzXHvabffJwE+4fZXdGAm42orTQ392zO8+IFn5AB6ec1cZYrbVWDkAiWa9Po0EIsITJnnTrmArvHn8fXu8E9FckxRApUO02ube/UfBXkGHj4barfUN/uzW42/mkVWYisrf/W4j3RY6m3EmKk1S+0N24h86/9HJdoPVGl6+kN4f4/UB/YaeTcvZEPW+RHWuXy066fUIBIJH5MGOY4h6Ag+cIhyxf7nzfw0zijnq2BcotN99+r2en5OROOLkTnp2SMfoxQSli9HbMdnUNyDmarN2t1fc3yLuZZbU0Wmvg5X++G0J8FGduCKiMZ592+v9CFtih1fuBeCdsdV+1bZrcaWzfSGXa4axnkgFA4IIDvouhV9CTvEzEuDuEXEvZiWOMbwwbu19CBbAy4YAKILQnp9TeNKtrsl9kYBTBBBWqxPPzpUYCoLIWwPNwxdqXE58kSZrlvWiRIuImn3mT2reyz6eG+KAMQLrMNWI6pcH7HVB+nap+XfpSHDNud2V3kb27dMn7Ye6n57s+kG+A3qeB7A0Kfx1YX7e9ld1fSN77kkRBpv1/K3zfieyq0dXUbSB7ZO47KfzJnQCcoim0qpD18yNWPgWA65C9+8Ko3uyA/l1yTSvaiGE9nl0i+3Ux2w2pvV3fNsWrC6+Hrp/7bdq+E8RvtbT+98s5Igt77qVI2yOyO2djIih22cxfIYW/IbJvw/TOUWED9LsPozgTNzLmNjQcxngvtYtyB+neydm3IX61vRNqbiO9N8f962yXm4Nc55CMhJhna5o63v5DKeRg+M7d/M4bDyQTj7714fT8FOBLQvvzakHdzEsANmCx1MoQb1dfm/JiIBdJno0kF4IPpSBpvhu+tzduP3UriN/auWXul9czDc5q53fLL9ep6vsp/CugLTd0u3fl7L3nQQaj8EqXDRX+ZbjJXnxv0XyPODOr3UcXp9P0fBQOgSsAHWF9J8QbuShtltQ577/4Q7av7RoiW9q+c34QpZjjIcfa5x7x3SwarH+umObaYn2k+Tc5acvMvhxwd+Wa615+WxPkVSjn+zWNl0Pkm2x84Wtbb/vG9g0o39i44Yjf6dokTAanrLFgdBuXI6Bfx9yv0u2w8y1afr0dpL02bEtFZOjtDs7Z7kZjw2LZBK9o0BQYenv38PAgxf233zp8/bNOmXj3ueUZAJ8PLTMxylctL8lNHaQzPpTTGQAs+4UYFbIs5GBIYhmG9Qe4BpdxM5v87Ze2pApu4xbZoPCCIvhNiH8ZWeY62f3mEB9nIjek7UTIlNS1pkTIdt7dnoUbaiz7I6ivBN9fKLirRmtVRQ/7lJwfQu4h1B20voMDfzavgecocTavcQOlvYu810krWFcaABattBJl9AkWx+AR01tAN4tme7T4di+t0+Y62r6xUjFfQOyjVER8GgS/LUO/IW3frhWzk5tvwPf2S26C7wCiLHMrVX1jQtMa/7dV8ojRGzi+h7DHTKsupjPGnTNRmTHWL5alVqXWekg1ACQJgBnPDmNhEimUM6rRpR/bvCCqYo54T4wH0Gz9+DmAYKpFaRalmRbqONAeC7wYvGAE2mbxtxLfr7kgeywscSWgSKjsqjEbD6+j8BHZN+fWghtjbwru3rsXQvx1+H6QFkRSADQVWeKR8FqvgqVZ4mtNu2i+8drusxs775dfXhrrrwPxFzL3PRAv0ySR+T17fFwePOcXrsIK5a8ie5dcj8KhKAooGLl4ohYAIDEl56ixrerEF0ZYj+Db9dV0Eb8LzW1QNErtAMqlL3q0BfRI3jcSoy7ZwdUIKq7WMwBwmCUJ/7Zkn3uSiNybim5UmLmJRPCq5Jeb6+k3InFrWLmOueOaUjOtGtP9YNbajW/nA4tSe8p8azO/CazvPGPbI0enttqViGUX2a9JheWrUSEAVMT/EeVBnFbl88li6OtZf9TP+bLgj8+tNPVba79W0TsYjBZCaQBnFxDeAWDGjgzXhgMVRF5Xl+etXwgASy0WZZVlejkio63B6QX4jluGVa/ZeVuZaaE8rrwQ2XeqNF18fzVWv4KqlsK3y/hOeh3mZomPyB7Xs6JPhNxA9viwu70J2Tb6v3BpM5i2y4rtwXdO0/jXakrXOSOvKzS24ZQ/HmdvHd27+87hZ4vP3JPHQvVH4dBVvYjLV9yQ53daS3usRgBgekGn5LwF9PavHRI2pJKDtG5xPOoq3fWNnY+HPMJ0i+wbQ0K3jk33aF0TZDcbFkCWCgBaueWifj5ZLBe11voV4rup6EaRmdzJNlB2SZo6M+j2vn05ZN+otXId494zGNxk4OnWk+m+drvgTHdLl79Ha80GQMc0opUP8macfbu2zJ7ztu1C2diyBzdjoHVb5W8c1Vo3tXqOXhWosjR3Ug6Gw34/VpYdH/WkHKaZKLI0noGEro6jSZ4IK+mV08gEpbygvOglBkBdV5fGvBf6Mncmu76Qs2+sbE8i92oYUX8nVN5EiH8VmnvSh15EQC/96i3blW3+fp3VPSI7xDA+TJMEZtaE7NPf9l1G/3KlCG4VKriOsG9vlGkikRzchWr6BV+UNgMABVdhhB4AofoAUOC0LKcXdHSweKIWMYJ6mOO8voTXbrx0o55MNMC0ex6kdffZVmDZSEltlXdczVxd43vTivLHVye8YlhzNTjMEmRAlqgLD0AeUHXhkeGc1auyNhqHLMlKMSpkktxIlLvOKtOtOnDbDNUb1g/o7rYBlNcd4YUs/rod1hhtN9SY6+SX6waAncrMTej5lnROrhPW2wPuL05wk8DptSpNIOiEVS3taeokQsLyrFcU4/7BgHmyznJP+iJZZVNmMmGUab/WbEM1NVx5pgxxxgdTRVlGiiBlrlRYapNlYmNwuhbc2wvp5Xwy3RI3Hck+RkGuU2ba9Z0UnlBp/CVt3xlW5Xj8U8gPA8tI/61XPn0e30knp5dYsOmDXCN7+zAFmk/N77ZTlraJ/IsjFb7ZCeuRvLdl31+uXphMk9fuHqqmX/KqOOt1ZkAA8NHFaUxZirBOhr3X6PDh5JNWfumC9cmdANRIr5DxznqDdEcIdAPZn89si+xdtX0VYkU/CjjlcgbgOSw65d2j/DI68GE2mrm5PKBDNtBVraCe+bOuUPOoMVkqamsOVZZIdiuI76L8NpSvybu4whNjaYFbGteug62um9s5tGabT7m0WNyFlesqtu+U47e1mo0pwhqsbySst/S8hfVdCsyNHDI7Ffnd53ZN2zciAbFe8aCXJcIe9DlfW8JpqHeWoroaV1jrUbYERER2Z7wyPBCfynyQ1/2e4LJ/C2j+lJi+he/BqS5/955QGjxk8IrxxK+dMxHcW6xvV2IZ57CG+G185/j4ayFNXDrmg0d7UH67tkxk613+vpOtXzTlbvK+gew3H95fFIzdY5H8NIR9u7LYpyzz2xJ5AKrRJa8Km59OVzo4y5cR1q97+YZb8ToTSyvEX2dxaR3rG+z++cxiHWKNcvxqlhZXeosW35/5swuVIq3CWdIWpVlmdkOUj+UQHjXmPNWv2WIE3BDfW5TvsvjdOvv6FrrEyqs1AiMu70HwbYbuXHC2XlQ2ZsqscCfLR4P+bXNWb67kbMROu3u+0ES/XVmMEAYKLuJDv03bN4pZbvgdbxuo2MTxtVf9FkNsIN55ykQvaWyacJETJq2xzrs2n2F81ANg9Oo71kq7dVzQGktEAZQAKC+gdcvcvS2JCI1OpQgJy+Mw8AI1ZqNY/Etg/c5ClTGm6kgLaMEr0CTCt/erpLMuoLfizAbBB2D8Dn8kfzqZIO0D1d3ps5ugfLvkeVZV9f4vNTltWmRPUsl4srq2xPCkZ1w6PjvbdG2npK5Bb6Wt78lO2inL4GXNMy9XOXI3VK07Mck0UY2e1U7NmxLNoimNXGwg+yM/w5aX8SCtN9yTEcFbstx2UBLDOiJ7lM7Noom4HJH35E7VHQm25ZorwZUejeBeLn3E94jgq8mEbM7rAbI5JFDvqDyzug9neJSWKHF8G3Bv60deVwyyYqrALnHz6t2otdkAmm3loVsD0jk7n01pU3GA63A+r848O+gXAA7Hg1vc4NfIMi9swbEhtmzETvcz/ZbdMxJS5htH93Dw7ZLuL9Rw9uD7KhcJ8M57gDK6Lfe3tvrWZd+y+NX+IgFM97QoyyXfvES9X41YCSWUuAYcarcAUAeZASSs7uKUKiB7MVvfI8vcCu6vHueyt8yatnpPNiSa+H9/tmrwCh3DTCfFCUCzAPC0wYhT4JT3h5so72qr1iisFwBYMyHNFC+y5nVlmYJdgUWXjgEcHfU28L0J2fUlOVUE/UQIVV+B724ZyC6md6H8VXki8VJpq3uQPdb+jTXcJ87cNg7Smme2newrRWW20tNXTD9FzGI9uRM2jDfXvcUmbQeKHt1B+WeZgXnUVou85uoQw7qeoR4brfXNyXu3hoHk+sVRrC7z6t5UqwKQ15L3jSIzy8YrSzMdChEgcA7UpXrs0etn7ip5v1WcdifvdmE3md8wwmOrl9NOa003sylq+tZYT8WtDExdqcS5aysTXI6FgUS7y7JSVnWKSMt+L5cbB2wb9XXFmes0lnZFpsNc7hAD8jRVqollCZTtDNiCOqzylTKipDwCoFS1j6pvXDPfDtFmzdy71vBYMsF7EmG9i+87yxJYSO4vU1U3T12XfROqQjoaLWZYQGanmA7t6GQdH3yEq+UHohqzrcnsUTlWQdR242AM4Ajo4nuaJDtl943MJpnlOzNON9ZvUgbyhZpMV39/heQd6zpisar7CkoudC3pYY4wW2K8Yu5htmxx/LxWkaE/OyW4o7Zt8t1KAFeab6yhPB5h9yBxRwF8m7y3hL19iGv6NHWnC/u/+3mtM6puK87slGhe7dIS9njfWlVprVVdI8ldWZcuKO0k1FTZvvZFQlt029l3dLug47au4lzoVjyPXkYAjLnrqDRjbluL34n+LUY3jsZ58wZAb/DxVUizjW2SK+1K2jzV64R7uABg1vh6OcnsEjpM63pGs5wvcO/+sEhu6NWJfVmd0dbYCOsp80U2EELUSi9n07NPJkafvf/1X/3Gtx7PKm2NbZQua6M8jNZKVRfVplUGQJblibAAlAKAxm+NEr/mtXy3dWZKg/MrpcUYKwQspFhrL3tquK/UmMt94u1KV7tWVR1HtNxmwGS0mKX9IYARp1NesGZi16AcZZn2hfuBvkeWwGg3kg7Gm/hO6iZkKalx1ee+uvisjoCbYJOV45qWTBtwv9GKb5vLb0RTN7A+4vunJO+rgMTSTufVzNar/KYLGudCruqxfPlw8gkZ9jYYehtW3UhQOq9Vt5BAN5I5Rv+6VKZ9s651HHUnvl9HydcFDLYa/m2Z4uvGTIMaFS9ZAW3bS2MqigFu0t+yFYXb6GuL5tuNjBlPgAqAK+uFDQCGKSWZ5NosJqeN4Fh3wOil9IV9tHcWjTE2VMoA6KXGOc6Y204d2iUcbea1XteqaWek8brA5koecRbRHc/oppayy11zSe2d9YFZtdBaJ3UtWAhNXc3LCU9oNmw/RkIJXR+5HUgioEdBJv7vLsvGA9P5kpfaf/OT0+EvP1TGvffo4uNn5874iN3OrK6HxhGlKwAyiZydpPBMUGVIN4RqjXXdN9rVVP3bV563RIotjPaeaFVOldXGxumFlHkimpHkRBRdHN8J8d2EJt7F5YKqNkAaGX0F5NZHcB/ZkjScYRKaybNJFXcovezie0FVeU0QtRb9/PrvuaHPpEkCJDCzjcSl7WUnOne7c+zh7Le1RX4aBabVYboP581pi+wsXx7mcFVvSs7Zmo+3nH1jObkTDjO/IYtFRr8yMqLG7DJe2lVgritV1iXvEYuPrypEz7HPY7MhrO/fHoefZWanpeqO+Tdk8W1Zgg0vTawh01aS2aPYdGNoztnQVDNlYpB26G1vkLfVTJezepBiQXMAI2CUBWeahfXQC3W+WCZ9AJW1Oed1PxOCM570i+zmbVe1RaVMvZxoreskSbO8yHtpLGq0y3rYNbF0S4ldVzhMGQegMc4a64w2NGBtwsPa+d7ifkKJBygjaNufeoPoQ9+F6drCKK99sOaytnCcgoTFdN7Uh+vTWJXq7PljXxcAbCISludcE1FIHgiTuRTbgO6dNx7KQylbqnVVtVDNS0pCI2UukgTAuCjOpouI74M8AVAaWwikLL51iFgfNRmAx5ozANGuQtsMJ5gNTL8E/D2X06fj+K1bpkNZyGQ5Wyz16cwEU81t/B3nwyy7MxQnRzn4tYV/gymBGEluzTMd5r6Tel+ifJ5hMmk3lrNpMRzFF4Z0RJppF+VvF6gcjO18convrZFGDPfg+wurPG4Ddxfub96h6eUwveSVXcjYInV1knkvP2KFXY1xsRd2J3z64JGfMSwPd0Uy2vpiLYVvI66P/KwdA7p6yxp56w1tHTeoGLwTo2NZ4BbQn8/sBr631sk9mky3S1TdmHpsRrg1ed/A9FgjXnK9dEl/zw250Wlzvb4o66auM7sE0E+SiOwHaUEOeuFidWJ7yP1iBqBKEq8CM8SZBsBCL5wJxIUaqOezkBc5500/S7O8hfhtfCeEKeMiUY3IvlzU9XxWMPJc5sfjKuuNW4Z7JcBIwlXtaFUE+CoBd0Z57V0E3Iib1lirFq3bR+upvtpxzCYCQDSQ9BJCaRBpkVCy8rpsaSmN8pUyjdLBrCpzHfWyO8MDkQ1NPevb2ZNhbp3TleuLBAONuZdVWVZlQxgAJVMAKT0jMpcy76VJkYlUJr1cJnwl7q9+nWVTKiOIByBFCCRNE9pLR4ejopdLKdj5rEoTOl/WSSIBpAlNtCehib4aZQiAASBFAISUmVJVaawzftDLNth6jHBuV6B7Mb6/ioLAypJnk3I6nY4K+T2vZb/8rcrXTbBhqjFNTDBcyvy4h23+vkJzscmn+QsVlRayy04EYrvSQEhbBlZv03bNx8O9xX4jvnPZu4zc7jiTcgOpd0L8tvayAfdxh5fG9FZzv06ZaZX0J+r51See37PHtpDH4yxWmzk9eM5my9fHD+Lzr9Hhw3VNMTLsdWn7BhzvcUnGFKdPUwFmlaw05DvxfQPru3pLW50GM3QNOddB/KXyXsgN2n7DWGu3rJgnSQS51S163Q3ZZfHBLCo7n03DYppl2UmfHvY8wtIgA+CUp2tf79OH5/kan0tCIx9kIu1HN4ILPk6GanVO2MUiHRyOAPT7gyhSA9Da+MBakttyN2e11lroxUGPzZcVqcJpVWaDOgJuTrylPS645ERQMJHkUlBGIwJ2NZlI0hvjVFVpdQm493vW8gG39dOHlTcNgHmllA3UhNKFqtOKvfEEAMlkSpFmMsmzPB0MC5lLkUraRlNdIMtKxQEJgNALAKMsG4z40VDKjBrjLobZyWJ2mjO9Fr4zsfqlgjYAmsY7Y08Dy8mcCS4TlhVycDg6NsPhsB+Hwjieaa20tULwQS8TSRKTxOM8o4mTkrUxJnpglEJ3IJXi8kZoyT6qBYBG+0bpcDkjuVkw/Co/WCpWoCGvor3CZDmbTqcAvuuz75yMRJIkP/3ff9QAI4Spth9PwPNFLz0sdl3UG+Vlrmjut13aSgOll3mebTw1OX36cvx9hAkT5tlSdDlkJO8AmrBbWtm55SakPuL7bSE+SvDXhVW7vZY2yvOe12otkR0PMxYZfYvsAB5OPuli96PhbllmJ7JHseXZKTEzsp1C0CX+e4Oc6tkp6Urt+5fjIX8+W7lx2jJkLdBHo2R3KtCN9K40/aaPq2pdrFJw8yjrRuXIxbpexyay73TRAM5qrdwBJ0UHBcT0FHcL2qEzvcGKuefE+ODLDhA4EwDQTALwtUqDa+pmfj5NWF7knnESSW5LnONs40Ev6Q2z5UwvVcWpLgYpAMECZjWAxXwGoGrsDACek5he3yG5vV6eCpbwS829Uf5iXqpyEil5xFxKRzg8PObuwiInBilbNk6w0FNu4bSvEUynga1nCx2amUkZyck8L2RWTKeDo5NxcTTuJ5zABcZIWbvzablcLEhV9qGQZj3nnGmW8+qDp9UwU7Maam4XJAuuWjIGYGFkQ1a/i+JcaQegCmz1X4eFtnmp6lLhDTCR9HIZpzUABr1sAIz6ueSk64GZlQpQ1ljl0WjfkvTdF8n6xyWhSgQOcnZRQWs1WfqE5QDytf9KCE7y/DqJJl45S8WCU94T410wZQ1gWWNdRd0YK9aRmNXFE4vI32BZlKap9Pn5c4rBclHXygOYagBw2tpqqV1W4MUZQsGURBT8ilzuX1l/n43CMrfQZwBusJO/x0BrPGXdIOdOfWbnxp0d+LaZ/k2qE19nmzmdLuaz6Tayr9n38kkFAFr1Np6NZvbuwxbfW4k8AnSrxmwcYe1SX2xo5VGIvwm+xyPUTzPfKw02Q6Dd+sAbS5vxtLFkqYg9+TZqio3Rz1KR4aBX85zzDbZ+W/9MxPfY/flmYueV+zaRjNk0kvHV2EN65rrku9VrCMPlReI7MQyaSTQWgHaV9kOtw2JyqrWelmro6z4nVKT9nmx7mMTRAkCtmshzF5AR2SPJnXuGpnLGAiuSmx+Me/3R/YNiWCSc8yhwXczLxcVZ1HaoawJA0myxVL1ZHSMHVRAAShJAs0nGK2EVUdoj1AqA0m6hr7CnqlRVqfzCAPdSmRwM5Epkb8rl4nxyNk9pKIoUJsxAUXs9TO66ILLhUYY6K8iiXKaHfaONB7FBNHNteKM90yoY64xPeTW3JNFrK0dg1dKyiRn3dC6F9mG5rJQNo34+LOTxuO+8i64YZ7Tx6AJ9mtA0ybbdjVLmnXvfAjbqToHYQBqt1dnESDHt95KYC5UTLwSPIkyE41aQ2c5iozRIisagLZrUtoKKF1WMwwNokkQow3jSz3lX6tmeKzSVrpX/ha8/AZ5MJs1U78PuF+I7v4nXZVOf8fIlkL2X8xvi+w7+DuwpO3Or2pAbFvhtdf6Gded3IvuFnZZ2+Zxf7GypETF6hN7ZvMZW+ktL0jeIedcGc9Gnnxv7Lqy3rzqv1c55ZVsi5oZCTbn0dE2uj7cmduXSP8cVnX3DVLO93AmZPFj38Jyu6FgY0UwJAPmQJ5Jt0Pbb6u8br4pRzU2d9PpUwyHV1NdACuB86Wh/kxktZ/VyXrWyDJUp1u+4sKF0AUCzFr7TWoGwqF9bY+vl5PlkQaqSAAFKDDP4etG5Op6QjHDREKdDqoOrhFWeAVChgkxDrSSg1nmYztjK2Kp8Wh9VwH0u+IA550KlzGQ5mz0/T4OjGTxLmSAzmhEue8lRmvb7fdEH6lq56aJS5sDoRIdIe43W82UdjE2rJbAasjwgrHHGNpVWqmpUoa2MF5j3RHlWlQqFPPMszWTOeTI4fPO1o7ffPHnjrfsAPv7wcX88Pnv2vFK6Ma4HDI1slFY2lCpNlk2pjBZ0aDyyLJgq4lrjQmmssqFSZlaqaIIcFvLtB0dZfwiAPXt+say54MxYQCsbuOAciLFDmyZxTI1k/AqqiLgXSWXijJZcAFgsobVShmCppcwTYatAE2OXPOlftcpE7a7t4dfPeT/nicwBKBYWzeqqpk01k0mL73GlshalApDkmbPpcH1NRqtM1+SeE5/mSa2ayaS5RhDK41fTJJfXg34bBdm8e/M8I810D3xvP0WaaUdwfwVL5O9HKa7EV29823dDpjfUZ17mQ24x97bX0h5kBzAl5yOJszmMXPAt2r6B7C12r5lvfZ6Gw12HvWiyWN6ra3y8mnHKd/ridy50WaBXb/sX6bIoUXbxfQ+yR9WlB37osojguu/WpGafIngrZWa5qCtrSVXWhAMrsfhOD2DiWsJ+tV/azCdjVACWjeulzC9mtD88SAtf5ABoWW32AZ5vMsSmE9KkmcyBkMmc60aJ5aKuL2ZpcDSTC0i/DL4Y9PKsd3S3f3zA03wMLCaTJxfz82mZSCRAqazROpAUgOaqNNYxH/gKAXPiAJRn8yzLVV9o0QeIM3qx1I0neS7neZFzzgeHbxby9ZOD+/cO3njrvqC58dXHHz7mnM6XlTJSmlXEdVZykSTJsinXKKOtji4TXy1ToF65o+Gdp4waD2WIzzKSiXRwFJl1L5fFGnDK5cWiCWfPnn/89PyiNACM1lHsNlfvYiZowhNkKQBFFdVVwpMoo0d7zGEhXz85iMhum8p5d+9gkMV0jcnsfFY1nUxUyYWygYtBxHHgCrsHICi44FxwVFUhOZAuF80eMefy962raakAjArZz3k/Le71AutlqtFNZahf3WKzNB821UwmLXnXypGqBFAT3tQq2sHXaK5iPmqL70WR3+nPI3mPRxglK02msvbOqB+9QMGUCXDp8+neOCRPzGXDLf6ZB/ef1jaGhUgzLSsU9Eaw3vXG7Md3X+RJKm+N7/PJSe+Sv1+X3LSHs7+Q0e8Jvb6Qtm8T/Nj8+oVt8BD97ChH8hLZWxDvInuXoW9Y1zuMvlMjrGN8bJG9NacbZLhTvfCzHS16FyQAqJ9muLuDvHfxvT3+Rq3gLr5nmYhtLRPJWpJuZeDqFXTMWC5qWs6HgjhG/LJsCHs6qWQy53cP2PFhf48s05Hgh3Z1JffSqyW3JHXKXzRlZO6XwqjW0CG6ZfYvgqKydtZ4pIwQTmQeZD7q5y3JlXLojfngm99Q2kRPy6xUkgJJIlYQkQ60ni/r0lAAmfABiFRXGWL8JeDGWGiT5of90eGoOBzmeZr2x+OItsDF+VkzmZank8WyUrNSRfSMaNtor7UCVj/iuFgBB8nZReUo58qG+EarmyiRPO+leREhe1aqWanOJouHz6fvvvdwWanHF+XT80VdN63ffIW/yRVOnbKgoSOgFykB8uiKiaB8UIjDYQ5gMZkobSqlc5n0x+M3jjhNxfisyJ9cfPjo6YZEs57PXW5pI9iGCwkklCS9AssS4EbnytTKEKCKZ1xrnWb5hlVmRXw57+oqqtHczjdBwCftdHDmE6EXIqUAApVNrXRVG8mvEw8ZTwaHo3RharV5aeWcn4yyQS/LO7nZ2+KM5KSrOHI7OjkaxXIC+mndz5tFQIZO2mrXAt/dsuFw34/vBWuAwa3xHTjBpIvvAOqbNeG7STvsl+iXfZ10E90vT9Rzdo2Zv6XMrupNO8S8GzXtpixFxN9ITYqofV6riyYzi8vWHK380hLtFtmPFr2UkZw4ZsN1Sa1dYSdl5KD1yD3JDdh1jpd4fLosAKBXX6fPxGQlFOjKLzdB9hcaZrTWlbVDQR4MUgCPXIPaBeonpb1YlOOD/r7ZQRffE5KFNDL3aIbph+pjnOHZ2dyKRVMuKhsW0xg7La/avavGNp4o7WXCUrpb+EqHueFFksheLy0kHxYSwKIJ5fIiKhiPn1w8nyweX5RG60b7UhkAgvjo7Vt9xogIHAC0oM6sno2Am8qk1x8FkvZ6aZQgzmfV+azCswsueBwzSmWjrVBb7YxvHFGOwJU7ANfqQvAkkVLmhanbjxHxPZVJmtBEJQAWy+bp+eqAAAZ58sa9w+E6MY0JGv3ms7puYkaoqiLNaxRSiXOgVwMMkgUASldJclwqKykkxdG4n6dp1TRRagdwZ9zvpyQWcwfAOWUiWZaqi+DXynceqA1QpTLJpZB5DlTo51iXItCGJ8JauhkMI1LEeGknXF8uZ0l6uA/QWpRv0blbwyZy9rYoWIz39FgYSR7bifSoV9o9X6xuRZbwLEtH/RyhakcveY3sHhH/UnN36RgpTtIJkJNGP037aBbVLojfpu3tUy2+T06blwuoXofvAFqIzxKfpPLTO9N3ov91lX5fqLmXvLohbQcQK/puCC8b0dQNZO/ieNfs2K0o0KkOVkcWP+7hiNKUhjSAZglmSUWT88NTXG917yekDxLlXSZ4s+6XbRbNg9O0ohRAs+hFGK9JICVCccUAs4HykbyPILVyXXy/0W+0F9+TJEGpnAm1ajJ5++ttTXJmPnH1DMC09tEd2HiS0kCyNI0pBVW5BnHnOiAS/R6NCwBSHXLi8kKmtaKdc5vkGVU8SWSaUKP1VOvpovro6WT06OyrX5OR9k4X1ZPJomxCJLkR+LZ5bqS3CU8SnmjoDU1ZUiyAxbI5v1AmUL2uEl6sTYQAtFZ1rRtHAKJ01QIugHZqrQDUKJO8SG2iEm1tC+5xIOGCiyTRdkXMW0gB8PbB8Pu+8NZ4VCya8NWvffDR00mcEzBBI/q3eaQyIQCw+gwlJBqFYT9P1+UcikxIwSaLclmpGEFN13LH+dnq1rPWt7JMHMOuS8FtoV/ZAOhG6VQmTCQ9aJsmq0isWUBk2lXOphu0QIjLsP/GMrdiQfnQ26i5t3HyyNxXM4a1hq88myqbWNv6c4TgxkOAUBpKpERQ4KxfiJQiK3BaL6FDZW1/7Ytqc5TINcZNIorVrIXknE+fhTSJ+B6LeV1B+dpuoHzrq+kCfell3HKTamIvge+suSLR3EqcuaF6E0eLGyL79lKduT20vV1c1QNwTx4D2HTBdzSZiPitjN6t7tt26uiiczfptG3H8R0QfSjkHgBJs9DUEWurJwXu5TshfvikkHSNGpKQhDadNkwH/eRg7VOeqFUzBeRAAJ7k9b2qxfRohqmbTVPKvsHyZYWa0oVyFvqYzGrUxk9UYIKnmbypcwaYlurJhQraxC9VBZYTh0K+fTQ4PHkgzXK50GfL5dmjp5ICkkQHS4vywQYAtQ01SBWsSogMLiMK40tZqFTmomZelRENla4OBsUbJ4f3D4phIUtlC8EBK32YW9Iie1fQiECsNGQSUhaiRURQMBI45955LnipzGQZrS8VgGGWZVn6udcPPvfG3f54bJvq8fOLd7/5NGKZMsOyM1BF8O2qKGUTLvREJvm4WEnYK2ovWCF5IXgJO84SQXw7lhSSdwwUUiSJUlOAFIK39TqlCACLSndpivZ9gWrck700iTAtKOrGVFf9iNb6RRNsU62nTU0qE8nVum8q7woUrTK2eqqD7xHrBQWlgQsuZa5UpTyD4YmwxthFZftF1nVV2URwvZtQDteau0/zjc55O/hKVWvBE2G1Q048gOrSyGvPZ9OlFsFUWLvZWcJzwGlb183T8+WgiN5NykXofk2ss1KVDa1nlD+1BSYzACdjtCy+i/Kk4U/TPgA0CzS7ui915JqXTlK9Cb5TkcU4Pk3rpHk1BR9eTnDH1QozqtFtGuoeWJ+S8xF69+TxuDgeZgxneLJuphpxdmV/XBf4PUjX3gVsIvt+68vd+UEW7CCl3XKmJM0A9JvaBzRPKuAODk9bf2ScJRzvasFuFk2L72lwsUdAJlAbP5Zhsm44VaHfxlezVLxGC+SIYSiZ0dzx1j8Qc3M2f+VrkL0bXN3ppYn1oSrKgjETFarAUi66k+iVTro3WfxioSOmjyUZwwPkuM8PTx68fjwCRuTsGamn5ToNpzZ+QB0kgXIA8vSSxQM4rX2qw51MVjZJJALJTVisMbeOmFsMis/dO/yut+8enRwDOH72/H3Jq2a+WLI75JJekMCVITGdUiYr2FWOKF3JJBdJIvM8WiFTSYeFLKSo64YJWqRFwpNCijShB4OiPx73U7JAnsulWM+EpNzUSbugn/BEWw3kRUqOBunBoKDEwbvYf7WXkNZ+DmC6qBq9OufT2ZKnK45TSG503joCY4gYoQkkbedjhtNCCgCTkhRStNSbiSQie3CXNjClTdZUmzYYwa2x1F1xi8WEr9WhAEH1cg39keArG0RCNvAxgu8U2R2hEa5Q9euQHcBszdwv4Z5etW/pRZe8S2Cx1AA0ddAJoAGIJCkk7/VHUupG99OENtrff9C/v45vR11uXtJI+OIUp83qKjIRE5fi10lCBYDf/Z4voTq388n5Aodi8mwpsFye9Do1lNPkJE0APJsgpP38KpHfQPPSyzZ5tdtyb39hmRvi+0GKi5kDIJl4VYUZXyKgeh2736PJRMI+WvtceF+VQMF794CzeY30fEOQ2f8BtssJnD8aNJ/UuLcKlMuqHIyvdY4OMwzhMFksJsNqvFJpAJw8ywMM1smEdSQ8amDlvNv7KTpHZjUyQWvjx+uOJeO5nXuWmxQweUFxhOguqKXJlADHtFRNrRqPlEJH/9yNVZoI61o5u26BlBOfJEkSaFaojrJJmHYGaGp19vw87tzUPJojL6WnNixGxGiQl2U1PRrgbD6WpE2kLF1YTE5PqQrKLBd6Vm8GHiZX2yjmxDHBnbFgLM2TLMu54EwkkhpBfMpClqWCiBiNXMkO6+8iEyE5sSzv96AN7VyciTQ8QnCjvdYCQGls2eTjniwkT8WqFzZnSS790WA9Bic05vUAqJRZTCYYj21TXSzrrevfdt8OgDRcqioQUUiRcCOI54JT4lZ9q0mYlXpamogsh6MiFexwVKiqYiKJ0GybyqzvKaWqjh1FrQUcZQIFIAjiCNQOOdNFBaC3LsHkjL4ucdQYE4JrpRjCZBsOd0a3yI7WB+l1WZsutV/tY3WMTksRYBbrg9uwP8P5GnyPasyG4B7xHTSL79Jorw1JEimK9KAQD45HJ/fuvfVa9uGjOoaOAVws6/NpGYeibhZ8jJoAKBW01QlPYmxm2eg46bnC5QPL0H+N9V87UjPo8VE6mS7wbLmEubRq3M3409rezTiAp+jn64IzuN7zPjltiuEqW/VKX2kx7B75tv6ZO3L+zHwqzt41Sr50QHVDcJ/V7mxeY3wtrG/pdM/VmSx4r+A9DGDU4ZScn9fq8Eps8xoDxlpSb+sTnNcKTyq1vpmHTwoQG0WYyNabB6vzn37iAfRFQuL0eVn1JypC/DN/NvSrJOra+EzQTFAEdzjFs5OOVSaTbR272myy7xWfBRRQX8xIljYeKIED00zVmbR1MCBAQObt0YIfoHghvmvlYlmuXj8bDFcFW2JBFUbZXa2mo0FTV1prrYrK2qZWdakaj8ez1VA3p4he7HbS0NRJmuX9nEcunyRJSpF0kB2Ar1X19NmyWoTsik0gfuuJ2j1zYoKnXAyHo8PhUHISFWEpwmvHw3jvRZtjy0NjsaYnF3Nlw7LRrbDQaJ8mVJtL8hjzdESSDLRugbsxLhWME1YpXSnDBe/30lYbaYFvsihbN85i2Wit2oxNtXWhBUJB0rX2LbRWpbLLxg+LAMZnpT6flstGRzfLME8GvUjbRtk6P6BezMpKNcaVykaSTsLKcdjK98n6S0XuyQWXNF02eh5TPZMkyuKrq44GEeNA/ko9nOuK8neRfZPmb3xZp5S9cndFfNdaL13exyurADyjWVMr75VCkSQY9LJRP39wZ3D/+ODXfelzw6OT8VHv4PDs/a//6qIJAGQyAbBcVpJfhk2jr7SQQmsV53OTRqUsoNJZlsZrJs4ApCg4VCdjSg4hh6z/2pGrUZ3bee/sbAXxTyeTqqqf5hnSHe6y61JbW9p+pQDLSyH75c+ZjqlyjCdJKnXzMhLQy1V438nfI8QvVNCqMnKBLRy/J4+f4PkGu3+OJSYAAwLeJl/MnQSA8ztYM+g9yB6V98NMdn01a/a3aoaS0oCABeQgpU9fm+TfGFYXfHTgI7KTNINzggUAh8NMVw5GYYKTJg9rTaaLcXnKT57lz06qk2d5Glwf7iYnR1odgFnjARguTmPqeXNpip80qNEPjA7DYFuiuRLMWCP7naPD+3dPeJpL4mPnHUrp2cWs1D6WZwEw9HUDSjIZapWtPRt1qepSPdXOcAGgX4gsyw+HCQCRFtbYyibXqfmsrkcAEtLnZLpG9rlnwA5pdUCd4omElyLEib81dtnofi85HhTHRyNG2bJqFstyqUOvlzvvlEal9HJZlcpeJbmXeR1ttSwAkqLo53GEKJWVyyod95VxrbvxoBC9Xj7ME0ZZpbQUjFG2pvC6UTpNqNbXZupLEdqCi5JCJFgssVg25xQAcilmpVo2utH+7mHvwfHocDwssjSR7PAoLXoHAMrlxYePcDp5tFxWheSF7ElOgH5Ugbu8snUrxo0xsWi+rE2gRmslOaAv1ZV152tjjBCCp7kxMxdIxOsWtbc9M6via2KzN5OgO4oytspM3laijjX9IXHjmhxdXiI6yE5knpI04u9BId64e1jkMkpY4/v3AABni3WJFaXNxnfZtnvG+M0qpl032upEJYLUppeN+rlI5I4QcOTyPOnfHSzsvAfg7Mknk9MGqPMI7umNyPu3Q3wHcDzAU1MvtyqX/VoqM62vJuJ7IvPj2QFb13IoeA9AfsSqM3cPuC6tCcA3ym8K1Y8R6IsmA+rDTG40z7vW69EpS5CnHOMkPVwCeIbqhB7h8DTLJGpUn53l3xim9W4fepKzgcuxrPopZoFuCziAQirffCoBN8xud4oG1M09o3WNiuGYotNWO6L8ea0z2rmRdt0erV0BQF2rA5mA0Frp+HCyKAHQoPs5p1QjyzGrZjRr6ArWsU7vdMZSYwEsgEU5q+tq2RwlYp6wXLuqO6TFrzkeH6zn+A0M5suq+70mWx81SjpFxqrGBlVVzTxPB5HhjnvD46PR4br1CmX0rX4RHeiLyaRSGkDMWpJrubHLc7v3tPLgQCH5VOvFsgGQShUtN6WyheS9Xv6ZB3fGo0IrpwIF0E9XePr4ycWyUqN+EElCQtVOCxJhA8m7W1olV1Kgly6Wzdm8AdBkolS20b7fSw9HRZ6mAMq6SWSRy0LK1Rfsp49XZ7KQLfJGMhKLXGofAKTGxpzVFveLTAx6WSTv1lhrUGQCa43FGa2MtNYDptXxd3LzOGVpJy7x7QQFrsrrse7xFc19LctUgSZ11WNZVGZ29znqmNw3NPfWQRA05o1viCIy7/VHheQxS5YLLhNhrV9MJsADALga/5eJ4IKnnbJoV31iMgbDuzXrC8FNQGmsWSgAclzwnY1Sw+LDIIdEL9pmSeeLOn7zk3EO4NmTfePYRVMCGCN9Rejbj7392odyMMbjh68K3F8C2SOsR2TvS6Iyxt85bGv5Yl23vRhpTMHYN687DsuXJuY0HZ4eXH3qMJPvT2gUuzd6YW8g+ygc4h0k8NO1Ig+cdjt7VOMEEw2gDxXR7bATaBUsrCj82l03uyrM9qE22kzObtb5IxMUZgcOoi1a0PSnQe0R39vsp7KsjLHz6enFs6J4kBY2v1jacq1OTJr0fDat6yalSLPs3cfldGFGo9HdYV8QH4y11fLjJgOQEpdaAJjPbB0WheClOV+eXfQT8h1r9aUvkvHdw6O33z7m7qIpH3/jk9mkXIP+Khox3uqNngnaOiAbD7LU83KZJrSXJr1enqdpXSuljdLqznjw+bcPe8NRpcoPAaVNKpNoZ1B2h4hXXhEOVsjVSxNAG63PpyvQj2B60MsiGUwkS4Bxj2VFzrN+ubxYNOPeouSCD411RmzJF4UzerkuL9PSRklhEqpUtWxoHKvShBaSW2Mni3KyKKVgPM0rVRIx68wAWCuqdBlo95tEZO8yU8mJSJJB7/IbcRtEQtqYamOc0gYQgLH22gnfBp1PKNE+MJEYdbviFktH+kBQxuw10dOmQpLElY0kJgA14ZoWA5kdFKI9J6trZn3BTB4/AaDUzDbV+WQWq3ueT8v2p29zzcq1fcgZr9YdcZWuikERKxjPl740WilX1slu8ybpvxUWHyI/RLWK9eWyCGZxN+M3ryT7qtzuK3wHoBdI+q98QtCV4F8iuOpQHQ2lVEm/IIstKba0S2wBV+tRcVVvekFHBx7hcJvdH6R1NDWaRYMUo3AYfTXt0kZoV6+9HnOrxqbBzdbM1DgirhatTnLWrxIAC6OHGWY1hhn665t/YTbvim3BfXvZv09k8cvMVtZGKbwKVFc1gCTPWq2mbdWktZacV0wtPiiB84XrPT1fnbF+L/2ONx8cj/tHJ8df+M7LKpvBKGd1hLYPH9X9lBwepednzaIJbdLjslKPLw6/+a2PfuphA+CzQ7zxhcPv+8HffHByspxN/fPny1k9m5TrUxHPA934dpH1+1rRTOYpR9NUtWrSwb2kH2WB8+mipe1Zf0hTkcgxgH7anAFc8F6H3m5AueQkdo9ryTsivgPLRkdOnSY0GldikDbO7mO+j3IrQh4dhKlgEMy7K80xop9SGckqtcYOAiAmf/aARvsomBRS9Hup5MQZvaxWvJJR1k9PgIvV1dIEZVyj9NqGeInd+y+YFuvj1EF5WGMNF6ITU62Udt7FSUM3rrCPvfnQSjEblyRhErscYtpwTTZTVa9bfJrD27gyXOP76j/NGq8coSJJUnklkFA1jdLGefeLX3l/PHoM4FsfPfvKB0+fni+UZ8TX3USz7TftatKpXHlpRJIkiW8drteel4jvZM2andUUCOntyvW13bFvx833Q/z/j4Ko13lmohuyv0XlYu3fneb3rtclJjTtcdq0BV5ax2TnIJuvinlMrVEysvtn/mzoi3DJdGhf7LiiWwRvifk2pr/ypW4McnBtqkS0yN5qMt3MkSRJHp4uph+qt15/43d//xdef3C4nE37Rydrnbc+e/b8vQ8+AnD27Plf+blvThb1tGwAjIp0WjYpcWleTMumrGtQKSgSQU8GMs/z735t8EO/5Yvn0/Lp+fKD5+W3vqq+3rz7/d+7/K7vunt4fDw9P03Wdcn7IlkY/dpgNQo+nfuNYSzDKoNJaYcUIkkkJ7GpBQDJQ78/AHB+1pyffSPiYKX0HoSKc/PIYVvjRIvvwmO+nAHo94YROqumwWSitJGJ6N9bzQbL5cX5WVPXKqaYdgsJrN6Fc0ZZLhnWRdJXDpOVeEKUx/mFquumkKK1R7SKwUacMx4kyuUMiClILXbHz7nSwK5W8d2/MJFYYxvAO98GEl6I7LdaYsk2ANIssI79djNUO54I0dt7qG4SU3emoqzqTsUWywZ4GAMqj2e2qirlSFOVqQRYAQCu3I4tNtqYyxGLACJ6bQvpS2UKwQN5UT130n8r4EMCABPGk6xbtz3to9o3OV/OVi07LppyVOQvxuuWm78iQL9tEPVVgf4mbY9n8mrnjVstsepAl7bHaOrOA57cCVG7bweAVr2Zry9cGPfYkD7UArK/JSZGZK+NbyuNvEB4uSGRf+6j7L5nWUG5NjYRVaDaquNxH8ByUff62XJRN6H4p/7wD//g7/mBydny8Ye/+vGZfe/LP/OTv/Lkp7/6kBL2W7/r/mRRf/Mvf2W2rEWS5AljhDRKPTydOw9jrXEXgjHKGKHRQO3f/8Qb5/7az/pU8INB+l2vHXzpM0f3D4rHF+Xf/Nmv/ze/8P6on08X1WBWr5Wr9ZCcJEnOZnW98cVr4zOsqkIWgkccnJVqzUwhUmebSpNUBdpPie24tqN6sM1GI76nEo0i3IaNONvKWCl5VHLrxswqnVDS+iwB+MZoFQUNbBB2rFunRtavtNo5uhQ2LBLJjL0hnqaC2dZmLpLoNI+nqutAh9HqemmFX6O3aB+s05wl3vk942J7PtsVSgP8urMVDcGptssgWjfktka9VkJa8VBZ+oCbneDZAnpcyTlvqJrYVYAkGhmVZ16VALIsjTOhN06Gn3lwB8Dj5xcxNr4xe4sjeqxOMSnLi/kl4jeBNbpp5mq2qNK8kCwc90Wa0J0ncAe+88E4Sz7BLb3lF3sqYpvZrjnoLh1m1+Ku5q21Vcm2/TN7+jR9O9C8L3coM11E3gZlofpjJp5X2ODvLShvNMKOS+zZFH2WG6x/Q52PbVGbJ6tyAqu7vVaLbAeyd1H70wsv63ubp1w0vWtVy1qahGU58ZBspcxYm+SZ8uy9R2cA7hzfz3rFD/327/vB3/MDdj75G3/5J776tQ8eX5Rf+eb51x+euUC4EClnP//e03mtikzGIaFRpvbWB+I8vPeC87QVIQkD4EGYEDIEAm9dOJs3P/HLD3/6q4/vHeYPjsbjfnY/oU/Plxe1f3dx4J+cvzYUb+a2lapyy4YZarNjtAvaxB5vG7jT4nIUxAHwNAcuuu30WrSKLaQjj471zYXR4GQbU9KESk7artMpu/V1a61lCYsUPrGm1TFWV+zaVVII3pYHuO0SIR6d7tgAGsONr7q2GWtgYiB3vSWqQ8BK3VyFZC201RfzUtkg+UrruA7l26/j/WZA9XIOsW7oEbNVN49wNXuu25a9G03tlh+4/HUyiSUenS9xvgRQpETy5PB4GK2QuUyiljg8OmkWzcX5tz58VNeLWRtRiNJNVOGtsY3Sg6U/yNlSs06NoBSunDZscTG5M0yAYUxfuNmk5mXpc4ys0rLyjUE/e/Fhu1uuF2q8dy2O7683uV0Dstud44VE/tvXPrv1vx8NsoL3mOVP1HNX9SJSt8h+cidEZJ+S87Ym+2t0+HDyiXg/50357LNN7LlKhr3D6z02KQ1SEpLQNDiADjP0RSAydpzZgN32OqbXgfjlJCB621+09Kjvh+yU7J7qZUokB84Cyws9LRXlxf2jofI4ORp83xfe4mm+mEx+xw99/73Pv/3Lf/tHf+zLHyyXVSqTj06r59MqlbLI0/PJbGksIWSQp4SgVEYpBcI4Jc47Kbh1Njaic9FDidhRGtoYH0IIIU14L829d5TxRRN+5cMz62PmUT4sxKhILzD4uV95OkjY73iL/NY30x4hS/MCPWEnDdy1G4sIvkKuNUKtKoIJBiBS1PgjtMVsrbFGa61VmmTtS7abnfpm9zXMSHDOggrvvAc4dxvhxtbZQpiUfOWhvKRn/mUuey54KpgUq+unbbcUv1csyZu4CkjaHPr43xqrbDgcccFJnGosK/VsUsbWqdHd30tWvpquSWbP0jL3bibXNrJHSVCrerVyfW3a68oPZERdaAvgnXvHb570j8b9cb/IspUPsp+SaDRK+ynOASDrD9spXZbJ6WyJtQVZ2ZCwvN+DNLzRIiYQmEC1hUzCbOGGWTboZQlLrLEvBvdI3iGGsSzwSy/Lyu7r18Evs8X2IzsAby5hQjdqD77vVNs32mR/Ggq/3bJjJ3kPs2XXmb4zswnA9IKO0NuImnbF9Pja5rkSs3w6qWkmYy5y25avxfeNvkt5yn1wCA5rq1+Ss2PCACwDrfglQB+i1R+6F/GVEGIE9FhfZcMMs2EjicNAbMt5x+/A99fGharZ9OEiy/Lf/qUvvPPFw9fGb0SN+J3PfPYrX33/rdeyL/xDPzg5W/7b/5d/J8L6G3cP/8P/+t1f/vA5Ac2kKKuGUhYQGIgy2joACIEICk6IBayzAALACAIJay5vfSAACCGEEOtRKhMAGA2AEsI5B2PWh1lpLpYawN2D4aJSf+295Vceqd/x2ew3vjHAVqCLZtLXt0u/YJSlHbCLGkJCybYy/uJDrfu1Ohc4p9ch+xpSmyg4xB8scaY3zJ5URHvZIntcuWJx0d4aK7nY+Aovw+Upo8xJHgByqdVc1WkuShO1iOi+HxYSSRLHhiWgVDWbzYjItVaml1XCAkhYHtsQdm2X7ewB6wDADsF9S5ZxVgcVluviaEOqYbVGMvR2m6HvERsbqgY83Llz8oV3Tl4/XmV7SeITSWLo++L8WyPzmvHVh4/qNvR9OewlIgZmurbIRNhEQJtcru5yOV/WKcsGeRLze5eNfpXhiK7gvrGlYI1HvhvfdxZ42jNX0LcYY1oDzHV9l/aHYW8aVpVNTNRaqKAaXfIKQDV11cwjReTjUY0hw97r4wfKyW7VsCjNC9UHyojsF03WFVjaCmLPTsld5SfNeSySVWSXKs1GtHabwtPrdZjcMgA9sWKj+WoCfRlQjf6ZblkCdPJRu+ma7foGyqeZDNJk9WU1sSwVAM4eKkD9nh/49X/4H/4fj99485Ov/MpP/vTfBfDw2cW//v/88X/2R374C7/th598/Vv/yv/tP7x72HtwZ9AY92/8pa986/HpQb9Y/0wWAPF+qR0hJBHUOU8pc955H0BYzHgK3tkQQgiJEC6EVCTWIUQCD4QQNVmKEHwIDsEaUzeaUnDOGWN5wqTgcsiPhsWiNn/x3fq//aj+0ok8kVf0q3JeX52/b4bZd1amfQkcjwrGBtGOyA6gXVn9KEunArVOE7WAFESZATd+MTvsdUA5ANPlG8DDBZ2w3PCEMBklFC44lG60L42VIgCpsqGXEOOvCug3IUPGekogWFcb2akjKRumiyqa/2JxlQNUzhSc53Es6Yow80p7W1JeAJBiCoxSaRMptsl7+1t5T+i6RHMgOTDbGVm9PL2SRfo8pPrmyB77daSZPJb5Gyf9eweDiOz9lKDjomsD7LgU62CbKq5k3XmPsY0iqFdRzITtmC9qV2nD58v6puBOReY/BdyXLs3W/B0bLfesBk++HWNMF9avk2I+vf7ekveFChd2eno2A3A2r41cIEV0OrqqFytBSqoG/Lji7ri0z/nFLiErlga7rNWFjicSwNOpTsOlvNtmq96kKE0bLx1m0JVbJuyVnOfxVqHEDsrbvJApBQAy9YejZNg7mrm5uvCnTZ2pwY/8vt/wO37o++9+8Utf/Tt/6f/xp/+jXi//u1999HSmp2Xz5//4H/jCb/vhD3/pK3/s//qfH2T0c68dvf/o7M/97ffmVXP/aKSUCYD33vrQaGOs5YyIJKM0IBAAHsx5753zITBKGQUIjyBGCTHWhxDCmrcSsjq9PgQAJIBRSlnwgXjvjTHGMCHEIBWM0YNC9DOxqM2Pfdgc8fDOcfIgXdUkaIe0AXVyS7Di61QsnuZtblFrNfHOb4DRBuhHJ1/UiI0HFxyN7irLKRDVpxBc1wZecOv9TFZnop6hxmGPIQA9NgRGnE47e86AYrEsw9SnuU9z43pmrU239BYdx0tE9m7wduP7bgxmXHDKqLWWr6N9bbZRu2cg+UqHUdWkclHWACCpjHC8Yc7pJatRztsSQG2xlDkveXSnxIPH1KHgNltRBqforlFVUteVrKMU49M8Otn3iNTRJNMWDmvjq4fD0dG43xrbxz1GU3F+1rSXAdYG1g2Ijyv9NI8ttOrmUpTbOLG9dSUfNTGAubHmDogsVemNlPepu81sYAPW24f2Zk2XtgSZblmCbd282z21u/0mDfn2CejKn83U6XTxjXKVr8TGy7YawfSC3imKoujlR6ywOSwqLCbOxHPfUvhpSc9r3dV5LpqsJe9Rbb9osnPFD6dIQ8wXVXbd8eO2y8LoJGe5Za0mUwVo7aJis6nKrMn7nqUl8hHlY5XEfkJIJtP1NZ0psfD6fMZmtf7+7/n8//qf+IN3v/glsnj0rZ/5W//Kn/47P/+1j373r3/7a4/nZV3/2//cH/jCb/q+b/3Cl/+Z//N/Ou7JN0+Gf+XnvvmTv/whZezBYR9AHUAIlPVV03BGxr1cGQ3nrGuZqCeEcs4JpRRuhfihVTCIJ2RF6tfMHSFIQQkooRCURax3gQAOgdiAeWMSTlPOGKP9bAXxP/2wvCtpC/EvXKqm4YsZsGodp4zTPiS4guyrHM41w40QH1lni+9rOVh2JfIQnHPB2XqYMa2c5hZAYie0bMZhGQF9H1O58M+D1ZVLUNGmyuRykfWc1WpdoaHbP+SF8vp1DTSi83LnhCYGEmSaaFfVdZURUF4kXnVDoN2XEJEDhvIi8WXjQXnhbTlfOxfblUEvOxkjlfKGwLIhzmyo6jPKe3vxfQPZkzw7HBV3xv1WZKepkEy8/qBI5JgKEZWZxaNrb7Ao1EQhiwsuud6Yt8UxrN9LsNQXlYs1QW8DxGLo0h5rJvg1WLoof2PE3ym+74TyF5ojbxVKPZupD8+eRJhuvSurFaJwfmdFoGw+q51W1Xw2NXKxobYDIEf6JA2RvK8KMV5NAjtIa2Q9TG1Xvt/psdleoiYTMTrmKOnKIQcAXbmupb3NZtq8arPLYpC7Q6MrVnmZlZoO8yzLozubyLypq8Hh6HA4+oHf8sXf/w/94JNvnX317/ylP/Pnf/LxzH794fnJ3eKi9mVd/8s/8tt//z/0gx9+7YM/8Wf+y9cOe1945+RH/+4HP/v1Z/08pYTU2rkQPEFZNda5hPGDYfHGnd7zadUYD8BaVynTaMsZA8AZ8aCRsVECyoh3QVnHGbHOhVaWCYRx6h0FPDwJ1BFCKSMJI4wIF4IIIATWB+M8Y9Q5HyWshPcuav34w/Kzh9lvurOpLWwoM85oIC8rZe0ky6QxxjtvmtJ2YKt1y+y+C7eY5qoRhw9UGwTTdxWAe342kKJNCb2f2IbTqfUjTgFMrY/DS1y5eFwd3M/thZ83TbwY+lXyWiGhba3OAExCv40jxo93EzVmG9/jl+oiu71SU17HSyUWhACQUhARgDyoartdhpR5LzmLyB53btbizHxZRyIfy6PHvJ5eurqpi2z3Xb9tlZkpY4ytAuXaYFfIcMDNzvly1+Q+7g2Px/2s03hdMsGzvpTDtJ+O33gTQPpxCvzqh7vwPVbZLCtVKd0NQa+QylVYd2PP08G8XAJlXTeC+FuA+0nPOMCl40+P78vKHr0ctb8ZnW+jrF1zZIvp10kxewB9T/LqdO7WyUrXqCKHpyb4jy4ube9RkLmyP1GHmTwEAHmY+fN01VYpkveuXf2ZPztB3lZnlB+U6p0e62QztXlMl0B/fqdgpk+vJKBGht5l7l1S3xfJnvTU/UsmKOCZJxHZ48a6ru4c3/9df/8P/v0//L2xpsXf+Ms/8bO/8NWvPpp/6+ETiLTW7pj1J4v6n/w9v+4f+ZHf+RN/8yf/3F/9crQA/+SvPPm5957nWeKdJUxUykRmPexlUvCoCZwtDQDr/aJS3nvnPQiJ3hjnEYINPjjnWiIcCNEmEBAQIBCAEArjnLU2rCUaRgijlDEmo2ueUaw70TjnV2QfADDKpU2TR5WuntjvPWBjSRRPmN9BTg0XyrhcMqVNlsmjwvGmXjoN6LkVAIgU93r23BTz2sG71jX4QpuKaUrJwoCbcVgOAUBms+X4YPzYbV63EdAvJ4iPq/b/82Dbn/t5WMGurpxgi8TTuRGtreXKGNapdd6GcCOX3NkgyXn3whhsW+gmqlvNrpFjdW/6y7h2luVAaDt6R9FmYXAxL53xsQ9UbE11Mi4ECBPJdeXDAMSqA1prXSm+1zXu8yGAYTVbrJF9Wqo4GtFs2Ovlo6uV/mLasEjY+P69wDIA4/v3Hn/4q7shMM3reuK8a4W7VCbKhqqZd05UlbAcQL+XlsrUpilv4pa58jaDsZ1PXqhRbH7zrSSmHq3xihaaCt+YCOI7mftOyWVnfLWL4BuOmj34Hjt1bCN7xNbDTK5rDCxMVYjct7w+WlweTj5ppfMYF33kZ4fAs44sss3HfX1Z70V/YKvPXuL48Emd0gB6ec7ziR6KkOTMOBLdILG0QCbTHrEwTF+t9di/hpR1ZZmN4Cqu1pIEMBrnaSaVx+nMMEH/if/p7/ltv/03jI96n7z35Mf+4//sKx88jWkdX394fjwaPZ9WWcIkC9/15tEf+SN/6NnTxZ/5//zU3cP+GyfDH/27H3z5/dMsFSyQ8Xg4L2vJuBS8kNSu+2MobZSxSlvrA6U0EQLBOxB4H6WVEAKj1IVgbYyqhijItAIsoQghUIBQGok8IcSFEKzXzpVNMycsSXieyUIKmQiljVtzKE4IAMHIuEhnjfm5Z/pzQ3bcd2OZd2E951przZHfy+joMAdwmFcAaFncoXMApz4DcIfOXHIPKLUii8paJvMXVRUnoUoCvavrwx4bhisy+mNnsnUkZjYQuFhdJzeR8dqkrYXRMGhCwcTuqG9Xc6epiCVkWvB9iSRSbXisZEVkHsOYaSbtlrLftTBeyuiqArAoDYDYj5SIHLaeXKyA6yJLH9gSQC9NigyCktZW36XtVaDQOkmSKlDlGayNnuMkSYZe94bDg7SIVu8dn185UpVVXuScF5kY5kkroK+09bMGuOj1D1ryOnn8pG0fuEvIoowy7fV1Q6A2HKiAXFL0ElfXsNXyRued9N8CvnaJ78B1VdkAHOb+0Qb+lls7p+scJX54a7lG76gb3JXa48qG8r4B992NG+tdgr9fugGg6up01mzXGGiRfcXQiUI4HA3y/IidPp3xewB6XYtL1/ESE5RO6NEzf2YWzQWybl7SCT3KU+1rd0Vv+cawGiexaPCIWATQiQZQNTZPecFIktPcshnxMYE+0vZeygaUA02M/sftEdnbhHusc+6vI+ktvscq8KvTwpNxJqelevh0+QPf993//B/9R0dvfyeAv/H//gv//l/5ua8/PD8e5e8cF+9++DwR7Pm0Mh7DYXjtsPdH/4nfOz7q/fh/9Xd+w+fucsH/3I999XRaj3uZc/pgkI8K4a2hfDXiUs4isjfaGhcYZ2zl8wugjAMgsD5EP4zznhAShZqWdEeOHxCiJRJA8AAJcZ0REhAoQEnMyzeNMTNKszSNkdVLQrMWasaFbDT7pfNanOvvz2YiSazBOG1WeS4p7t7PDtJinPtiOEKnLPZJ784J8Gx5etK7A1im5+gN+k4DGg5zKxpFt6vmtsu9UH+mx1rJ5fIHmi3rYS+bLc1sEWZq41l0PCKDNJ03TW6Zvjq0tz99SgGv0k40se2JofSLNczrVKaugBN7m5iOX0VSl3Me68flxAengByAtbYLbRvInlKgEGFNiYKpABK7IRJOfN0suATO5ryIddVv6VPyPh2+0CRT5UVTq7zPe718XfIeG/h+cg+wGiwjrt5IzNxU3oRAx+oWZfdqC+gThtg1EJjNLfm2WCFvLKD0b43sL1JjXuifeaG9fX9m0wZ5X6hQmsk2bd/olDQKh/fkcQyozo+ew2MD2SNhbzeSYQ/1KU5XVcO6+P7Mn7292R8NfShMUB2ulPF4dwDopwBcnya5TQAIFvQarzOZDvXl/Rbz6XXlVlrNDeq2byvvEd9r48Hx8PmS570//s/93h/4Qz9C1AyLR/+vf+8/+5f/7I/9fd/zGcrFuJ/97HunyTpgKCi4wm/8zvvDo5MPv/bBV9775HBU/Kn/4u/1suxzD8aShWdzBeD5tKJ8he90bbVWxgJI+AqOeYfnKm3jAxeC9y54OBDvXFijOyFEcB5C8GsuTyi6hgpKaWukYdFLE4hSZg5kgglGI8S3/53zgtHjcf9sVv6trzz6g3nyxgFbVHhwnI/DcnQggfngzmExHOV5FotmM/0EwLPlaYT4dv0Ond8Zx3iMAu8tGs15UtpkW8fn2iC/lFzOLzw/oKMOvu+ehwFRZD+4v37xY1TcdQPpsZxcxPfGX5GGjNI7ebxvjG2qZaWsWsTuV85qxpM2qBCJfC53B1R3xJ+tBdDUSsd2K7HzFOfoJBMRmYcO6SYyR12RTC5Xzf+Mr5uI7ABSRppKryTVatXiToqws8a91jomeUSNpZ8WtJr1rqs9QDm96kOg2XCYJ121HYAkHsDhUcGkAEDUDIAqG60cQCXxKrzYFysoEpbrq6xLuwrIe2nCBEWNlwF3PhifNJNvXVy7Q2+YbVjdo8/9lY8ONO2oKx1lZj/Kb2P0Dd2Q25UjVXM7Pbrk1Uabh1h2prUztvg+Cofnylo5b50zba+7qrHbxTYHKd05mYpMvOIumtnjliRnfW2RcgBhIHHeAMgtyxMGe0NV/drI6kSFqrH/5B/+XX/wH/sHzz6ZPP6Fv5cf9H/ix37qf/fv/tff8879yaJ+MOSTRb2ozaGQcfbzD37/5xfL5o03XqsuFr/4lfefni//8k9/7TP3Dt85Lr7wzslf/dlvrn84agMoF5w4G1hVK8ZoT/KuQfDypzFWOxtdLgCCsyDMBx+8b2n7yt5OAgElhERnZNRkWnZPKaWEgBDGGACGQCgLIWjra+MYIYP8knNEfLfWHQ2LRZL87XdP/6nf+cYX3+w/fXiOQW8Ec9K7UwN5nmH9H3h7/sm3ViP38rQl8u2W0YHExRK93nJejUk1Ybnt9KAnoamsWzYBPRbFdH6wuobMbCGG/Z08/TJEfz+PKs23HlfPgz3v3LbtHK59WR3kCJsQD0BppZVrVQVTz/rVs8VSFZ2cICrTrkJd+Zwx3o6jbR32nddbc1WWJISFsEk+WnzXtIBBG0rdecA0TwDMLYGtB8tk0Lu2e8l1SyyscpAWy70esiIT27Q9UvtcXpZmmTx+YnwVMf0myL4OaJvrpkEHObuY3wzcw+LDT4nCrc/91gHVnZxRU21Mr99rAzjXofkGnd+ZpHodvm+8NmL6pyxIUJ05jDZp+yq/1M+6+D4l51EajYb3FtnNLGs8SXddiqNwOL1GNG+NMUTyoGxuWTiULclo05cuZXq7KcTvJOmrz5+IoFfNVx8vnc+yf++P/6/e/L7fEQAmlz/213/8Kx88LSTv9/vjfvYrH51/z5uH3/zoPJUCwCh12uRf+eb5F17r91Py8//dL/61n/iVX3jvkx/64hu/8N7Tz7/xxhc+86AF97XG7bTxjbGpoJHIA2iMt96zKJQHeOeM8y6s0lMppQCF9957EBLZOOWXBNi5WBvb+0AopZe6jYuKfWgvHhMCZzZPU8Go9V7bMK80IaSNuMb/ythMUOXwb/719//Z3/3mP/4b7z9bnp76welcffGN17asCnc2wL37VIvvnjgAcBVQPferrqOBpEDZWycCdS+sC9Zg2XSPP1xD/GrlYHP+uCHBdW1UoVaOCaUqZfM4dQimjNzWDRh3UxHWvmw796rpadNblyRbmlBo265DNUSmUzmKLkNCX2yvTDtT4ajJdDX3cNXi4m3ZInu/EFF/3xwwKp2sd1Yq7OzUWgW63SbM58MWVTc096G3i6vjTa+Xb9D2y2fFlW8djOpS+w2I52mOzgwslqnYSHRolRkAUuYysbfW3G9annfvsq8Owc2jLo1KOpz9VnJNi9Qb8vp+vr8N7iWvTg+eY2/rwFhsoOC9wuYVFupMyqMdH7iNpj5aexla2t7tT32pCO2q6Tg68JhcmVYbR7rVY4aBIkl6ggz0lau5J0i88baBfj+yZ4LW2kSIf7zQPsv+3T/5L977wuehZu/+zN/+s//pl2N5r5OD3pfeOcbayWet45xp4xOqBol8+OTs9/2mN778lW/8lz//cVOVv/E7Hrz70dPT08XhMP+vfvarUY0B4K1JBGxgxvtUUOMBbZzzxjoQIiK2AtraUhnrHKGUEhIISNTUGUuwZuUr/SVCd+CUA7A+OO8JENOjCODgo3oTPLQ2lFFKiLFhWSuZJIKtML1UplSWEJJwEu3F8T/nLOXs//6jH05L9U//g997Mls+1vzRN55+xxffjppMOZt2ZZMI5RtA75J7TD85X7pl43opy4kBcEwxozwRvtE05xzYxKBwociBDBcKgHGLC9a0sN6CzXCDwj+unudodZjtQEswFTC0xgI8CZXWemhVBkTzZXuDHKTFPGVE242r63Jd22W58GS2jDp4f5QkiRA8onzsEEuuInvUrwG48ILCDFKEujMBCLUCaMpIs0Xe1+IMAJhAtb3sYQvB1FJL6rTor4Y5aw8haTUDgEG+ryoiMKR6CvR7yTDfpFlyPVoIeoXRV+pynFBhhzgjEwHU3bpye+rjiyRJWbg9yN4M2XtXe7JtyjLNAr+2y57KkbdSZrYX+wQsfwGy35PHiczRKQJ83RIhPlpoLn+qdbaqWTRiWJ8hS5s977nyMsZcpFZnj3w83maD9HKOTOZq5034Qlmmq89MA68WaoXsn38b1fm7P//3/tF/6S88nOo0SXpFfjqt3747fv/JPBH0IKPa2CxhxuO5ogPe3Blmx+P+T/7ih5IF2c/f/fD56enii9/z9s/88sO/9BNfHx2Ocg5vzfEoB/DJRaWMvaibIksjhgrOGKOCgnIxL2vjPADBOaMUlHIaAMZIAGgEQedj4QEfCAUCoQzBhxAoIWGd2UQJAcA5d86FEBhv6bxnTBBCrPcIxFgXi8MwSRttlfHK6ELyNtzKGL13OPwPf/LpkyX+1R/53jEwOW2+9sGz73znpG1UuY6joh72Tnad8OmFAlCrppcWq5oBS7NoNJCS0EQknHXAul0nBxJYVZ2Kfvbh/Xyn/j4EcD/H4+oRXJz5bYM7EXkUdrn3mVV3tI4XzDgs5drzmgixZ24beUN8VVB2OtcAhk0tRMJ7PQDecRJCIGkryHQ5e0xiiq3ArbExoNp4xBToGBXIVobIamFARE4Sg9I0u1ppx411kClJtS2d8SUsgIwohQKAApe+ejnAyTlP0kGe7uhWpAJNACrE+Ki3Df1dcWYD4tu6crH60M6YR2zEKCmyLH1JBu3SMfAptJq0/2qBeydkt4AeV6JpcuWCv0HVgT0eedys82qL7OPi+Hic7RToW0Fmczm/A5y1tL1bjQBA48lOcJ+S87vpOAoNunJE8thxiUieW1ocpi1h5wfUXvhZEjYozQtp+04ir7yrAvsP/sQfu/eFzz959+t/+a/9rX/zL/7swqLI0sjTGWeTRT1f1lgrHrV2AC4CnRs+EOYrHzz9wjsnHzx5Pl0YAP1hepDRn33vNOn3GaNHPRF51gdPZpNlRQkZ9XNOKYA8k1GC58TZAE5pL5MRW6OJJa4AsN47h0AIEAjxICxSeEJIAKUkkBACVlbI+CmD94zSGG6lcVnL8c5aMCY5BdBYx5wXjKYJV8bOG5MJliY8vm8I4f7R4K///EMA/+qPfO/4Tjo5rd5/dPrgoLchy7TLY83bgGOMuC4bl8l02VxqZUXwXBsAQi/InA872m6L8gcuXcnuy6ZV2HdGVmcHNKan7klrCKYKSvCE9PyyF+g2FdhvamgvrbgSUy4uSdJyCYB6qjBoe8m2+B6tkFzwbtnLVpZpBfeI8q1K01Ym2F7mlmiaJr6JcQtnfDAr7XIJMeBoQ6zx/7h4MVT6fOhpuW6253oJyTJ5Q0dJlJc32Hr3IeeUMmqV6haI3if3y5foY/IqZJlvBzHvlodsVyKgb4ReX2LM2LZLRmQvbM7vIcx2wzpiOTAJ3leqWd2trrQ42sHW2+WRn8WXRzfkJWe/iu+t1Z2kGYDmwarUjPlcBWACiPdz2NBTLvL3HiEDTfjBlaunS9s39JmbIztJhFvof+tf+188+NL3/I2/8Jd+7Gd+6b/46ffmtU8EbbQWlMlMFokAMOhlSptf+Na5926yNKnkgrJSayB542T4U7/0zenCpIlotEkT8eh8uazrfpYdpgHA8zI8+ugh8SHPs1GRWufzQh71BIBp6ThxUY4f5NwGFlsRXdVhTa2DDiQ453ygBJQ5YGWGIYQAhFPCGaId3lgLQhjnBKAheEKsc845QkgEeaw8NpRTQqMNE1DGSsGl4FVjS2UKKZzzlXbEmNeOxn/1yx8Vgv/v/+B3je+kk9PlRPZfG2eLtSwTPYtRjWFXafv58hLTu/heWVvXyvEQjjdBhBzIiOwxrHrg0nBVxGvZ/RCIyD5vbtSxYVxPh0mygeyqrnAbx8T0auHcONdcGL2o4VOmUMQCjZGVR3zPibfGOrEqZ4YOdrXIHqtYNx7bOnuwgXCSMhKjqYlW/moln7klA1TtBAU3Ltp8GTSuZqC8DZnKPI9FhNqiMZL4RDIoN+4laed2dspMlu4mb8E7FaGZSIDyWv6c0JfXvlsv185Q8kaoYSOg+qqWCNkRvq8r/LsN613yjqsFZ26oz3RpeyvLdAv5CrUak8dMADh9OmsTQZ/zC3yCtx7sDrPE+l/Ti5XZMeI7VwMABzQB7QE4TzUq1xCG2o3Gmflc9fr4QVRy2kwoAA8/94l4P18y1ucktzRGUO2Fj/i+k7bvWa4zBZBEAPjH/9F/4Au/7Yf/kz/9H/yVn/rqL3001Z5IwZ0zUiQyEYWko0KsQ5e+VBj38/Mn5977PJVlVf/I7/jcclk9Pi3TRACI/x+dThlLHhzkAL7+8GxaNoKxXi/NpXAhDPs5J+5sGUOsGBVpTFL11lDOCkltQER8G5i3xnhou2LkjBLng9GOMTACEOpCCN5bSjkBZTRPRfC81tZYSxmTCQuehcCtD0pr51x02oQQCChlhDNnOTeMxYKazvk85crYiPWF5JNlray6dzT+j3/qg0Ev+2P/8y8B0/P5rCwGO89q5PKPNY+0/UVuhbBs3GyrbswFaw5muGDNCfoR7sM6iWm2lccUkT363F+iveL0/PQgLQzgi3zalNukoSv6tdQhlsFo8X2T6WvRS8zKglkrzXlwyjsReWtCScLylE43QfxqcDWlWIo8ZboB0k6xzDRPmoW6xohCN0T8oCqg2EPYd8OrYLhaDiwKMolkL8E1u+JMG3IQSWK26stH05FIkl8Ln7sv8lduhbS+SXCJ7DcfDK7bfzOzKb1pgSSh+ga4J4+jP63gPQClXAI4m9fP+cWKMKnnEfEF+rjqerxyac6WG9XeT+jR+VXz7JHiNVzjSZ7LiOwAXh8/2Djm6+MHHz6YpZ/scCvai1uU+NxzqzeENZ787h/+rd//A7/5j/yR/9PPvnf6fFYjBC4oAMpYnkmZCMCdLc2DIQdgnFfGDvOkn8lSGVtWf/9v+uxi2Xzl/Y9X51PXAEyS1U68edwD8LWPni21p5QWqZQJr7U9GvUiaq++TmBnS1NWDedMJoITF/umtjtQLmSsi10r6z2nNMZgvXMuIARPQwCBdU6FQCzhlAguBrm0XlSNUdolnHHBqUcIwTnXFqUBCd4H7bw1JpEyeJcIniZcUEBwa12U3bM0mcwWWqlRv/dnf/TdL7x1+Ad+6/F5pcrZNNsF66uAanLPJfdGB0/OlyvAqlUDIJNpL2Utha8Jr1Vz8djaND1cz8xiQDXGUc1sAWA4N9NdodQN/J1e82unNCyvuWrshRc4XeAUQP/uWy2CXxfC2fMulzi49iam9HKa4j0RnBgbou6sXRWhP+2gsaYFOgUJGo+uITLNd+TKBJJGA0zk7M54XMXeOCFoOy5tE/YW3+m6FHuyrju/mxnLK0OF0e7m96P24SbNtiQF/TUA95ih+gpLDqDTn/qlZZwklbExU1d4uU5G31F+UggAMk3ePLhzTx7fuTt86+je519787W7h3k+AvBEPTdywfJl/ANwWpaxXtiYCfsE21J7K8iMDvzowOPwNCadHmbJkeJk6snUZ0qkmSSZBJC8wyOytwPDJgfJl1j3WiJzNUtCi+yzJOykV7f4WTN5sdCvv/327/8HfueP/a2f+OB5+XxaCRq4oMT7WP5lJXYHBkA5orRBCJSQWamKLCXeJ4x/92uDR+fL05lutInITjhptGHESBbe/2TSOEIJYRRFmjTKZAlX2nhrvDVVrcqqqWpV1cquZ9k2sHE/OxnsGJ4Zo4wQ6z1nVDDKOBOcEUI8iAsghDBKKaU+oNK6VJZTevdwcDQsQgh1o421jFIhRCqlTJJomgwhBAQXQtOoSullrS4WdYwouBAabQEc9POj0cB7XyvFE/Gv/ydffu/MvHHvCm3v2mZW4syatreF1zOZRmTffVMc0NlVWSb+Rdl9Izd1Q3PvbomVhbr1hV7VsiH3Da+fzksRdirmLhDtg/armreUF7FS2LqtWCVFSCn6hegXN2LHyW2qV11H0ndwPsG36+e0BX43fJC3Ze7b5cO6mH55h/6ayeJL/+qFmZ00fP+Up/vsdZC9P7ja3floVLx29/Cto3sHfHQ0lH1JAFTV9Gxe42ppMJYvI1IDUJYK1d/A90d+Zp8AwLA5alWd2LUDQBhRrN2+OecpRfog4/c2P9KGzeb18YOoxUdRiMzVvGlmSYgov2fZria2Q0E6rcLg8I/+03/4T/27f/Gf/dM/+t6TWSYFpYx4H2JPOwRjHScrQfz5tGqUMd557713RmspktfuHvz0r3zz2fnmOGd8OMyTb57W06rx3gP+5GAEIGKxTERj/KKx1vs2g3TYy1qd/f0nc+VIVOSjVqO0qWoFgHMmBY+v4pQKRnMpcslzKThjYd2KL2HUeT+v1GxZA0ilkAkDYKw13oUQKKVJkiRC0FgRPIQQvFa6UcoYcz4vz2bloMiGvcw5X9UqTfiw37fGMhKeTps/8ef+OwCxCEEX07et7lc4b8q6yD70dQv6b9/Ph7soeY+VLdy3aD5bJzTN1qNCa6BaFXzurLQx/NXLPZ1qvTMqM1q/xSBNr6PtSxP2R3TCRsqSvDLj986rqlouq0ZpbXgs/bhTltmW3Xd6ZnYDy9XDBlW9WG3fkCupvK7M/Ra43CiE2Rbob0tDu60ptUiSrjr/awHubeGwV0veu9DchexbCTXXnvDmpqy2L0kL6wAu7LS0y8jZNy/9cAjAyEVF1JiJ2L7j0tX+BNMLKlRfdCJFZtFcFMsuvq9ml5kcHfiuCLPbchMrlEm+TZr20/a2sMzOCGpD2DNF0pMH/+T/7Hf+yT/zn3z10fwHvvetQsRSXCRQCkBQlnCedooBUC4EZ9Z47x2A4Fch0OnCGB+odW7tjJ5b1k+TVGJZVvfH6ajIjoYDQaGty9MkFbSsGut9mnApuPWeMZpv2RLOluaTi+qoJzhxiaCFpFEjirccYzSEYL2Pf2sSR2XCpRAB0M4DYIwZFxaVVtoGD8G5SBJGqI31I72nnCdJIjhnnAdKKSUuBKW0D8GH8Oj5ZDKv42eblCpPWJalxrg8lT/+ix//W3/xK21tmaiwtysuuTJuny9dFGQ2wqozmrUQNusA9+XdPuwv3aZYfPG4ijUgZ/tvgeoWWoEZ3enffcsl97arBMYLLw4e24i/EctpCCOZbCOZKb0CrMajUsZ4KBvK2sQ6Xy0Qx2FgYzDownrK9plMBjxsseBVxxVNi+vI+9xeXuGzTgiT0lWnw928vmNyn5wt/Q1SI9sCPjexyvwaMfc2PbdH61dO3ltM7wL6DYMVcbcN8n5ZFfLGmnvr8AXQdk/dWf43boyl2wfDUcF7dy6O7RM8nHzSMu7lhTadJOwNh0wtVx9vu7Z1BHoy7O0h4zf0wOzZLXpj8pQ7Y9+80//440e/67d98SCj73302HpOKEk4y4TIEp5K0dbjbenzG3d6batfQlkqANO4TrbL4sIAcNoOiHKL+s3D7DBPpPCpoLV2wzwpJI313DmlMhHWuvZdlDbt38WimszrQtKo0rTie/wYEeKLPI3OFgAhwHu4EAAIRnIpEs5jWTFGCGWEcRZC0MYwQiTniRCEkAjxABjnhBDBWJKsulsZbbTW3vtZWX745Mx6P0jFZFmnUlLGrHUyEX/2R9/9j/6bxz/3cPpzD6cA7ier88D0k/uJjeJ7q8xknfT9ZeNq1cwr1crKtWrOl262S0/fqECAjiFyuBVQ3U1fdokz3ejoLAkHaeGLXBwddW+H7p7d41fcXRfISYNbi+CrrxapTITssjbO6FhAbZuwS+rSTHYbYLUj335Yv3IcUwGog1SGKM+UZ8qQVWn4/i2kYMKkECLqMP2UxL+XDzE2lfMuNlLXPrQBVRL2TSk+bUC1oKr0N8LBV4jsn0axuu3k4LZlaqozF4tEdnE2Vo+JmvjowB/JLD9iAOYfWPCVzWZKzoE7tTQfVRcARhKjcIj0HOd3oiHyhL6gZMNOZHdVDwirPNUcMKxL5MJAblP4bvWo7k3YInvsFPr7fujXvfHW/f/l//HPj/vZnYPxJxcVXzvKY2GAVgFX2jhnjXWDpBSMOYABjDjCSUR2ah2AUQIciLhSK78AhzYAEgoh6CAJTaCl8gAYIQDmZc3IKpUjVv1lhFgfXAickkGRlco8n8/WQRrCKWWMykQc9cTZ0nDijg7y6LEplSEgAEggcdabcJrwxIUQfZMAZCJMrRqlRJIQSoUQ1HutdW2tYIzSFaHiQjjrogrvleaCE0LOJsssS3uZnJc1gIBAQFwIX/76x7/vC19aPP3wx96t7r5+eJDeY/qJS+4BtqvPHPZW4dOuDxLroiuhVqafkLlC75JVvgEHViqs9T3WhE6935jK1A4GOyl8+9NvADETZMR269SqrgAcpMWH1xuxeoLArDw511qwQiNb63omlWdBVUrmPcD4ti4m70ZNAaC+HO0WpZlbMuAh4ntk7o0LqHSMqXbTU7fx3SH3pIypTKWx2RYst+mprSDT9UGi41ncienGV0B/8vhJ5+HeiVG3nRwlABrj2kpKrd8/ocmnA/cthWg/vveGGS0rYABAOSOZAD5thmpKbirv+MZsE/k9npmbpCbtoOSSxir2bW33iLOXssl4R6ZSdeZis73YFBsADk/btk3TC7rS6A9PcUo2kL2ydvuMb9tvHk4+ST/Jg3NJzvS6wkxvrsJARmTfSdv1NbH7TFCa8nJek0T8O//G/yHtp//Cv/Kn/unf/6Usk3/sz/x4NyczEXRUiGnZjIoUwLR0Noj5ovrovC4SMqkdY1S6AASmnOutAB3AaE4BqDt4svCVsw/6JEo0jW4akQIoJE3T0AQ2r+xBL9HGJ4LOKxWlldoYQdkoE4mgpTLzSjvvnXNRJIkiez+XAI56AhBnSxMrs0tGtQ0kEEpjEfjVf0ZJmlDrfQgQjMokqeraGkMobft4GGujOZIzFkIgAOMMAPXewMW4H+OsqitteJ6mlVJxYyr4T/3q2b/313/hX/sDv66v+Vff/3g5qH/L63ce6x1FZqI9JgruMaHJrJk7yaRg/uD+Fb3gY7A34LC2yoBt2h+7l+MQiGUAY4+9/VbInnNgrAvWMTOurey9XeW8nQtGFn8Tt0wrP0ZW3nikqgJGsXFrbBU9XawGgAjubarq6t6vm3l2ybVjyd9m3dxspxWy9dUEExNcdVxfisvpSMXUAPS5ZcfcRZXm0i2zq7z7ognb+F4uL7oSTbewzE7aXlZKGdciu3feGlvWplv0OKzzGpVfhVU/VeGwgqruygbE36HzU3/FD7BCdnzaDNUmZBtIfR1e75RoNhB/Pz2/SSXhy9+MV3ugtutxtAtZ2uddLX4F8R18b2OqJ3T1wkxdfuzpBX2Yf9J1y+yk7QI+pqcaSYKysS92b652yu6LhNehwdaNFxkWzaSv1Xd+52f/sT/yj9z94pf+3L/xp6TMHz67+Av/7XuX4xyjMhHR1X4ykHmeff1hHLp8LxPG+nupD86f1ybnrO9ChPXRnKLBh6mP4UV5CqQglAA4lv6o5x5r0Sg37OeHWIyPBk+WcMY/m9YQbFaaOlYNQwDQL0Qi6OmsaYyLmaXBe855JmieJKuqXtoAIkJ8HHgAcG2UsdHfSFdVxOA9wMDXTZT7mUAIjdbWWhMCY4xSmohEQ4cQbExxIiQ6aCilKaU+BKONNpYRop22xhRFQQGtlKdMcPaf/uLk8587+4e/9wife+Or73/8K/PsewZ4tv4JYmGZDal9zaBTYMeVueLjF2o5HGK26CI4rgL6bBfQ70R2kmZpo5d7DbTxc7rknpietpdWLBO/7XB/8T2ufeNBPIuoHWql+wdc8OFaZWqARNhmLc138X2pxdzalBG9RvnVt+AkcvauIVJbXVzTDmVnUcncyTnQs/MLGzVnEZF9g7nvKWIci7mfnz0e91hvOILM90gRtqnqWlVKR02mjaluRFPDroz1b4vm3g7dscXMt3u5bUbAzrSmG0Zud8yYSBZ9mQsVoibTzSTqKjOrgVr1AWhVudJudFK95O/t/9g3dYPyWwtAXfh2tHhrF8Q/nHwSTe6xAkH8j71OmFo1XeIWV2KmSb+X+lr9j37/7/oX/sQfvff5tz/6e//t3/y777/7aPEn//P/fl5ZANY6a11nIA/ryRA1Ho3xcRb5ySL85tfzQ876LrxWhdeqENn663PHlpfD8yjBPRmCDUc9/nqf30/ccRG+eFc8uHvwxmh0kLNn07oJbFYa53RCIeAIIYOMAHh0umyMCyEwQrJEDItsVKT9LI3ILihkIqIa03rhY7RKCi4YjazUe1AKSpEKytjqD0A/T/JMSikTIZxzTdNYZznnfl1pwIcgOBec+xCc94Lz0aCXCO5CcCF4HxaLJedcJDy2/aOM/tkf/+Cx5vcT+92fe+P9D560kdWdP9BlZDXZreFGzww5kGLYj4J7K7vPrkZch2uIj/HVPQr75ewt7MCsWRIumnIjCBxxfFvKn2o91bo7hOwpmlvXVeyZ10ZZW4yL6NlWmW85e9ySaNWNkYYtmb4ry5DQIFYAbvUlWuy86bZDids+GQBaObd39hMzm3rDUdo7zg/6G0XENgQZpU3rfWxtoPFuSoRNhN1AdklXotBNwf2yUcj1HTYKqiKFbwWpyNx9kZcufWVY3vkAl1OBlwJ9moobDgx78L3gNiozWNcF2/CbP/Kzh5NPjt1nrnB8u4ydVC+X8zsrzn5+Z3TgR+Ew/rVEvkvb4/LsG/jwk9ke2h6aur8uHZdb1jW3tZpMu9KyqlUi+PrqjGZk6po33/lM1h8+f3g2efzkL/2Nn1GeffBklqfCem+ti+DV4rty5Dd9x10AoyIVFCEEa53gkgr28Fy/c7xCENYJ/b/O5UOrABy97g/TkEn6+mECgB+Mf+/3vfmHfvPrX3y9T7OhT9OHF3bYz08G8ouvFV+6L3/9m/3P38++817yYJxczBbGex9InohBLg968nAgU7HqZx2Li8W3ez6tgFUWa+uiAaBt0MausRhLZdWahcXdDvr5IBWC0USINE2VMUopQkkIIXZqbZSyznHGBOfGWmXsaNAb9XuxIjGlZLksGRNccO+8YOzJpP5zf+dX6mHvfmI/9869L7/7jQiUG7S9l7JuWPVSu6DIZGovVsLf6KpJo4vsOyk81oLMrQKqXQ7edn3p4vsNi9C1+N6FeGUICc2iNFExTylSCkkd1HS5rJaVWlbqfFoulvo6xq0TqRPZ4jXhhPBVM6bGhelCtbbIQvD9xdwVLSKFd+UOfG/NM7Or2f5alXWtdmrubXA1keO0n46PelSIcY9dJ9BHBpAKFjWZ7pwgYXnCckkR/7rzhumiuqnmzqSAvx0IdzWZV56hum1I36Ok3zZ2qo25uVvmKtD37gFwx4Dqehzvyc8AOLYHz/mFkYsnagdhHx346QUdhUMcbJ5odeFTCmSbt3RdqulF9ujeDFt9bT/8ZJZ+4nsiESy0bTq6d2ZUZuLK0oSKO0NIqNyVSBpkHypi/aCXi4ODxWRy/M7bP/FX/8t3P3j2c199GCiFR8I5KFn1FCVkXtYxR/Snf/XZuJ+dLY3x4JxZ62rtCBELECj7OpeUqgeeP2x/waV6vScB3Dvv4XDJPPnSg8G9++PeMIsFLZaz+vd94eC/+frT734jv5tIAL/0ybMl8l5ijlIO4IOJ/c7Xeo1CKtEozDUZJGGu/cVSWecpgeAM0NbFOu2OgDJGOaNS8NhnA4BgRHlPAO8ZpSHai60yhRQrgp+IPJN5JifzWhlTpGmjlAuBAowzRikhJEr8hBCZJCGEqlYJZ4cHw0aZsqwAVFWdyASAt1Yw+he+/PyHvvvRb3l9dJAW945GF035zutvA5h/cqW2TC9la9F4U5HnvdVssU1WaotNtgq+vfCHneJCXRX++EVN2aLPvSYcMOvKMEnrhDmYnlKcRiv9dv7zHjWmbdceIb4hbFEanlspGBF5RNUotkxL1dTqQDklWRXoYqkjqW/J+8667QMeovKeaLUd4h0fjJNEaq1mdQ2gfUfpy6sOjhth16KyQDKkGsByUU8WZX887taW2ZzEzB8BrzWLRqnZx2e2XszqBQBY6+OV5rybrWcYq5mKWpmFrLHKY7v2QLs8mSy+XSV/1z1/B69ehbn6ASQTyplXM2CkcrlYqrpikgK9neR9j/7el+TOqJ+vy/m9ZqHOJICi6OVHzC7kBM+jRtoaJTcqDYy2YD36Jq+LNYW6aT6p7YF8dO9K4YEYRwVAJAdCxd3KLaOBdVi1Cisj8yq0pTfF1gVktw33I5+OpuX/9p//x86+9fHf+ul3f/a9UwDealButKaUAaCUMkZjofZPLioAHz1fxPrphBDOmaBRnwlZRh9a9fsS8bZKRvECTckIYjp3DwfsO389+/vSk5+uyL37/d/y+gjAzz08e+Pk6CAt7if2MyP+xsldAB8/O+v1X18u9NzUWrmj48OD5+eVtdNSLbVoVA3gvNKNMiRQQSE4MdYyJgZF6lVlwABImQq6KlG5OrEJ55SoThIgCSSQEAvFAJiXtXMYD7LxIFOaL+rGe6G0DiFYaz2ljFLOeSJEP7ukIFVjrbW9LBGcn09nAOpGAXABQADwp//2ozd+5AjAGydHHz87ywZLAPO11N6GUl9Agdd4Pb1QQ+AZVrC+XVWmWwzyOqreXhLOhKWn04XqUT/r8yH1m6j9uLJpyqFiAbJ2+3QX+mxMCjeGkOlCZbQoBMmytDJVhOzF6poEUBKdS+qU4V1Abyqtkx2ErG3Kgdhgr5PHRLOUCUpCM69MJAQR2bv6TPzpJA9NLRaVBMpYYGCxbnhNm+nMJ1GKidLNFGjqsvGgjy+kYGeUAaiU7mpKcXnvAxz0PorPnk0WZW3aiCgJ1SpYai7hLvaVXf2ga/t/twBDu9542MrcFNydMrh9rZvtmOq3VWrvbnm50jyqrs5m6mgoXy6+ejSUR5BRfz/gI3W0uoglTy7Yld+1LfW1AeWjAy9U/2iQPVHPW9q+I6rDeWUtyVKUavpuM0LaxXdX9ahx1DVBJLpzO8WbdpQksZdet9dSe791ZseqIWwIN/O0hHz3cfnn/+j/BMCX/94vA/jdv+H1X/3o7OF5PSsV48wZFyXpmPl5PMqnZVMqHwm7C4EBVa0YpVJ47VEr/zqX0B5A2hAATRoAjFIyynMAX/jSG2Gu3nn9cMzE5GLyxsnR+E56nwkAv/dgvOpkf3K0DvDkj88tEOaSTXRYatE4AuC4H8DGTVUCOBllAGZ1DVZIFpQOjUITWEpcmhfPp1VjfGOds44QknAmGa21s95zhoTzsG4qFJWZqlYPn08IwBiL4VMpZa1UsM47bwGldAnMF5xxKjhPhKAUhLJK2USwo/EoE5QQYpyfl7U2Bt7//DfP/vrPf+u3fc9xfKOf+epH77yRt7T9spKMagD4NJ/5pPFNBNzTmT/sDbpJp+dLdw4cXo24zpsGj3G+9r8+D/b4Me8qMzHislHPfWH0acOmCzupQsrsQc6GdBO4pxojEyL6diX1DT29i+YbT8WWjZVSwZJ6djFnY7arYHm0zSiZJz7qHrQV0KPOjtYMU+m4Iuwl+euDOGMBVIGlPGRE1TWCMQOiU54IawwXrVIfH8aVuvSzcDG7lCJKAOXVlNe6uRRMgidnzx/7emYTwbVpO8G2zIxUJYB3CQ9102b/pjS067spHd3KtIpBY21IIhJtAHgg8ERY9+0qHBbVt1YxrEX/lVnT97bVfukCvwCWi+XZTD1/dgEc9Afq5spMIoRdz/miLTImrPalbNOarNMb0c5I4c9rFdtnn81roJxe0NHBwpVCuH4Mt8oDuoHv3QymeDVM321wkYfXPoljRvpJHlyz4XyI7TuOCY8iO5krIInBVV25QS9fN2y6dB8HbRZpBhd+8WH9L/5v/tD93/h9T37pK+998NFXH83ffzIvq0Yba5zPMymL7HwyAyCliKlDoyK1wcTZpdHaAJx6Y+mqxw7HCtYJANwj4kljALw+oL/u7xuWd/zTjx/9wJe+F0Del8B4vFoBgGqh4oS6dmZy2hykxcfPzpaL0Osn33mcf+cxlvPqmzOXvHmglXvvVB8Uxb0eAExLFUxQNMwWVbPK9zMNMNdVImiMCVfGuhBqBcpYwiinJPigbUg4CQGt+B5lmYtFNVuUIQQEBAQfAiOINnkueCxTEwc8SpHy2IdPtClX8Thpwhe1QQjLuv73f/zDi0X5+ZHs9+TD0zICekkoDKG+No4AWMSPoKoZDYvSzC07W9oPZ2zN8jtT3Mqd5iuZvg3D6sqhVFhX2X20a4DfnsMBNmXkXp/0E1I1dgHnWUpdA8CzlUy0dC4GeJaMxT50Xfim2WXjsPjay3qQkACKDL5WJGF5QQBkqcmCRW8b6WxBCcPS0VDm7GAlS125VQtGShc6G5PiShJTd2cHYME0XdVM3oguJFsr64NvITuAvNMe4w4jgEM5N/Ng1o2l2qGtX5XxPBRwZcrzWMEbQMALUp2u07cERXBou+jAQuLXoirk/18sy8Xyk6eT5vwZrarm3DxOk/t3RjvxfSd55zR1iHoO0ElV7S5n8xpyM+Y5Qk+oftEbYwAjF1GHmTgTfTV3CiwvNKFqG9lzzpGhrpuUhqCN+qQ+x8BVM6DHr/ptI6znlvUI6XrbYzoJEAtxB+QMQL9K+gIzTwFQF2K+0r/+x//AO3e/+4/9M//Sj/3S0w8/eU4ZEZwzRlNOEpEsFoviaPj514+iBaWt7suJK62zznMuCCV94Q6oW4AtaptJumLrCveIiPjO++7X/dDd9LP97/zue1UtIrIzofK+hF3CmtXGzOBgnGfmfi3u3xWPnQGO3jhBFGoA9Ab5Fwf45tQC+jvuJO+d6qY2AJZaAEb6MpWk0ShtSCgEJQk0DBrDe5ngnC1rpa3z3tfWEkIE55x4bUAZJZ50568H/ZxTsqiUdQ6ESEKiBsXXNvAQnLOBcRRSbFQakYm4WFTPLua9IrPW1kplSbL0/m/+8kX9meKtAwHg4/N6lNHFpdPjatUtX5MeudPPsmAHKY3Q33qijCNEcuOAq1JzrEUBYCCv3PuChUNk8SAbC7FhkCZ3inX2tSDrKP0VJZqJFIAzTZ8T9HIAgx4WNvQvu8F1979cv5zaX+klHWJZ+/YbXRI4mgGgsr7TacaXybRWTTfgXBpC17V34kvaht3dWg7GkdFWVm085+0nX1w12wwEcSbEAYMJ4kyI/+PDTdF/d2A5AzDiZGFDNJ+UmUQL8RuTFcJi4m5caUhHnNGGrK+ruB705TTl2wLu6yw7uOTehrGf8SR2xf00S5okO2H35Wg7TcX5WfP86aQ5f+YXs5zAL2azTwDg/p1ROvr/MvfnQZJk930n+Hv+3vPnZ3hE5H1U1tVV1V1VfQCNBhqXQJAASIoSKYpD3QelGTMuVyNpKWlXNjOaY2VjNrIdaXTOrLg2oml3VtRNioJAkCBIXGxc3Wg0uqv6qOqqysqqvDPj8gg/3/O3f7wITw+PIzOrC+C6lZV5enhERka4f973fX+/9/s5J4nT6pQCWAO/HlyGxvIdxlUmmK2YjBm6Pg8AUN8DgBqmMe+PE8RGrcGErqjZ1UQPmUbYi4HocSKM7aAF1mLIJ43u3VTCYf+y7hvxSd+gOToHYxmFgA0A6HXCmOh/9+/8V1/58ks//Zf/u14Q2xarVwyRaVkmBIAEYurY1N1enFVtmHVozTXv7TSrtqGa4SWcJ2mGIEMIu1Sbd/FMmoIBh1H2Acu5BCGPAQCIK9ye+Wwd+QDz59cAUstMgTgAIFIGqjchcSy3L9stlwEwywUAeALYy/vRtUUXAK4tus1Gcyshjah3AUIA0u0EAdeiEAyT2b1OFzQVZAOXVgHy3iAAYOK01QOsaY7JuMhElsWpiJIkDAKDUp1SgiRIBECCiOf+O6OEeSRKeMKzIIpSITSJIpSiQUAVYxwmae8gdi3LtXToN8Psjw02o4edQAhBMA6ThBHS5bCyWG/t7lVrZtXUKhajcaTYNCROqQSAlQoUa/8OIq5TRcxU135unLM/1lfVmKG6uZZffDhluzLgrE1lb5CUYheaYPQKmSrFc/IfTSoVjgvgVk8vB5ZLqUQ2lQCG4viA8kaJ7PngoUY1GXM1+DlCdDEuMr1I8CF9lkoAkFGoAWTYUKeNnlN6rjqnFWb5DEBhPUzHZq0Mxqj+Tv8cpNMSzYv73y+472eV+lCmzZF3JniCiQ6nzbz5fm5ZlGbBoSL70UG/LbpmUrX1k5B9oOXzpapj+V7DdK/w42EYV8EBANHjDdi2BBMRp8LNOpnPeCGnqn+nRYXwZn5EhhEAYjwBXY8yMLaDjkFgpHd2Eoiiw54DvYtxfoFiihwhHCGA6l2MWs0Q6fS//ut/4i/97V/+7Dfe9hyz7rlZJlIuAYRpGEO1upK01YtUlV1FdgBQNXjVak0EqBXAt4KkpuNzkTYzL6Dbx3rxTa0+7+VYH8zC+2Tv6z2XATBsWCBTQFSln71waRYA3m11lzFdWXFqId0SRtOIGlFvbWF28Uzv1npQweHVF5//1ndvv9OKAcDpxchkFSL3egDUgDQCAItBs5tCnNYqVpTwikUYxX4QRWnKuWBMZzoOosQy9GYvTtIMkBLLSEipgg2SC64hPFCUUspUCAX6ZrvT6WHXMvWEq4LvGqFMpzMVqxMkfq+nPJyY89++efA//ujCr7560K57V0HOeRPbRKhSwDMOLrZqyusDF7fhfJvj5A4zsjhS+M5juYGkAFAAejo2aac0MIRxlGmmlil73BwFeulkrSDP1Wm5AA/jE3WWSQUqTl8ohnw6MljTi3Ksl2YqqDCbUXwv4XiMVlPHqQnD/bNK9C+NCvmPubejVgiaVBvlu9LmSpgbUqgTcsFeUu6PGe7SqAIAilrlNKM5o7kf5TktRb7DY2oSouYBecLMybMh89M0gyZR3DrcL5K9L0PaYXUmcNxy2kyxn9/JF696Jm7aBOJCJZnDuaSZVAytAwep7uosAgDstzGATKDqDaaKWLaSsB/izYaCUB4DodHi96guNZcgAItiWdQyeZ+HoVeYcH96AFXT/NBnfvi//V+/9NlvvG2bhhBppOqhA1BdV51LYVCrnem0F6exQJvbnThJm53AMnXO0/yK17BmYmEiDADxHKwwBIMJjNszfTt89gzyn6nU6qtA2CjZ8WANoUZplqYgU4Cj9YDUsRAm80jcvNVc1nmtXlMX3vUK20oAAC6fs7YO9Tdvbywt1wCa+4JsZQAAZ+ad+Qzvt9N22EfSjAWRxAAQxbIbxoySqmsJkfWiJIoiIahl6n6QmBSHcZpJiRCSGRKAiKZVLCvW9TCKhJRZlqkCOEhKUP8ABBcdv8sMI4gAIcxwjClud0OMscFYrxdkGFsGe3u39yuvaH/qA7P/6Mu7zpJxdcWZQvbSkcOuOOyetJpjDmJF85ITrU7QmAGQdiOhMWqhNJA0G4HsyNOHH83C3Bg55q4snKNloRoV1HGRRiWtncvtsXwfu58DPX+Fomwfpbx7lJrCESM+l0oAFaEvUqmJCI1rNCdOsBy3GAzoDfiujBdlxQAAqB3lquft6aUYb7sD5E//fnnuONkGOD/ItMmKOIbCzOKRtySKDYO+d58ni9JJxWQyv33QjpnZdVxHQVwxvegI5Zq9fzAFYFGrI+Io6ZEgOBAAYM1imw+ZeorsVjOpDNbV0cSXhT+i6lm2HHxEFGx6iiVgY6XZjIMPu3gKFxQRciUIAPbFq1946eZvfvuW55hxnGoYSSEBsgykTEWcpLN1q9WLVGwwiJIoSTb3mpQSQ6cYax0/TASXUlKi6QgsCy0xaTLNQgJThHRam2N4FV+nTn+Ueb2z+rxnuQwzerRiroD1/peSptq4mvtS8Pm5ek033tlthiK9tuhuiXSl6qwABL67JdK6Ed3YhK1msrxcczuBziq7Pm/1gm5CK5YeCRQnAQAYDBZMvR2G7Z4Wp+D3ItCQoVNGiaZpYRR1u8IyjXY30hnTpBRZlgqJEEozyTXECCG2HYQhYJxyLhFCUgJCQlEeIJPAhZiregAgRJaKjGAUBIEa/6TMoig2DfbvbrSfO+996kr9V15vXV2ZJslLD5VU/ElsGY0ZRbWeY1rtZHHUHfzYLXB/6EuZTPYRL+XIYOlNXTqUaaZNZS81Feg1fDLsUEPLjik8NWrij0r4MRdYzFVFnRLZ+yHlYcP9WKxPOjP30w0pHplp+XNPv4hpQoNsaVRHxfuoLfOeNp7AoG1KTtgi2XM9fmzy+1BtmYhyUgHYGT2N8A5ATeF7dAwo6vc+9yn1fdLg9/cP2qLH1RpU2nBnK6ayX6hwAaDKoN0auDcElSI5LkG2zEqMPjbBefqk+7ArpqAhp8NhV2iup/Kswx5+82HnD1xf/fLrDwglnEspkwSgXnE8m2lEreDH7W4YxGmaCZFyQJAkSRTFGGPLICZjACAyrgGqm9hkmasjprO6hddqtuOwSspzVrCfrWr11SLZ8WjFD0Q1AggTKcYspxRBqlF6ZaHmH3S3RLqMqTJq3FnniTgNML226H7+e/fWFmZ9ub54Zq7zcOdGy761n3SChGUB6LaBZcXSK4zLVC44mk80PyZBzOOUZ1kGAEzX4zgO4oRg3Gp3mM4w1TCgLMsyBERqMQBGyDJNAPB7PfUsIQelJtUNHCedXjRXcwcBJGKbRqcXBXGs+m4nSUIx/aXf2f4bP34WAHZjeXXmFCKs+EVP6qxdIrvCusYe3zLyyVuOe/sE7afVOQrxJTk/CmWKZZpGxw4DkzguY14EtyNEHoWCgntZ/gBFlOcLFdmdn6w4PtaLL249IbMwlgNPJiz4LaUg6iSUj57zXhcxKU/m5BZKn8WPw5ZhmJY0exHZJ1/cpBts1mMPXa/kzGiuh53Z4ZDpEOJL+ykyozDd7t7f32lvx3u40pfKmdXdDhwAoMI9W58DRFvtdmw2IeDFQPxQaD6IAVhO6hOSHQqrXUrPcgx8LN8VCFYvrG3c3TBmFh7sta6uVv7Zb66bBjYMQ2YQx6lt6jXPIUhUbVpzzaYfAoDnmHGS+kEcRCFgLDKQmWx1I4zQat168VJNzU8Mk51l4DrMqViOZ9LW/gWvpvoEGY6r/HRFdjyukJMS7AiXr5wS6zVK3VkHdpuK7196GHxykEZpmemPP3v+5o5/ZW31Ric+98TFi8n259/BOwcdMGhToBpOQr/7MHBcmyJK51O50eQAkCQ8RQiBjOIUIS1NUtDBMlgQxZAAJRhjjBBKpCBZlgJQQgDAte2O35WZgEGvKFUvXsPaYdvvhtFCraLiFoySuarTi5nfC7Msy7JM0+C+n/7eRufaqrmx2706U33v98uoIZ6r9SLW8/3ccD/28lNPUedP/9XTDZwxyBuo+9yfmSLMFbVHfZhjsT7qpWCK2pnWZ3Qmx+ruXLbnPxYJXkL5WLIXRwsbI38A9NxYVzZ6mGZIx2OxHiE8hfunh+wE5T4q2812tzl4/Vikp8hzV8gu9TYc8V6OCgi/t3WqmkHdiud4ZmfEdncZGvXci1jnWf9KJZqBRLPTCvcP2nv4Lh7OrVIVH5+qzFuzuE4qvbQ5+prFpDGfSxpHjmGXwk2jpvkk2T6aQTGd7Pl41jrc33249eQTz9WTvd/69p1uxA2CeJpKQBWbgIZVevuf+9RVnvJ//Nk3KME8yxLOo4RnEkkpkZSUgmMyz2YrNX3Zsz+xivK+yQCgMluaDQYABmgAoNVXh+aII0wv2i9FxEvBSypeNTG+slB7Z7cJAD/xVO3l2wc1kT5RdQCYZXZVRk1ux3/m6bUbm+03H+zVwnjfTx0NZBrcaaGL8wA6PUutswB3Hzb2Q8G5MAjK0iwhOIoT02Cubfm9IOUiE5mmIUAIYyyE4JwTjLMsIwSnXGKADKSQEiOkMx0BAAWEUKsXqSKaKue97loGwe0g5kIkUQQAv/W9wyeWvIvzp7hJp3syIxO7FAysQqOB7FvqOdnz80engyXnXe13T+AFTSJ7EeK5aaNloTZixJ9Egx8baJ30XEeI7qCrtSYiAcaUAWDsj3liTJHmk2R76RzNZMYgFdLM89aliIbDpMXAqeL7WGn/OD330bBq6Dk1gMaDHhxX4WtkxHmUtrzqVyjEF7l/QvFenZnrtsOieHc8c7StTDkFMz3S9b5PeuRQdeoYut/CeEYllggAgDhKbOJYpKeNdIfxJyQxKuEzFuu5FCqR/SRJEaNkdzyz83CnqVfPrZq37oTfubVNCNRq1etnZ+7tNHcO2lHKMxA20//jN+4edFOCNSklo6Rim3GSRnEaxhHFmBLEqLZS08/MeDrDTWSlUU/FqJ+9vtpsNGv1Wq1eU3H3Pk3MFDOnhPWSTs85PtaW6T+LAADN0rTP91bff//WVvC0iy3XsVyw3MXN+zvLOt+CpUbUu77iLc+Q23e2667d8HvQizsM39njy3M2QDZbdTHV8GbLb0fNkGtU09MsRSiMYstgnut0uz0AAISUo2KZVpz0fTwhhCovKaSkBBuGkSSJzKQEqVNKCfGDpOGHCCFGSJzyim1GXPBQYErTOPEj/sbDdgUZo8UwpngyJw+oFjdF89Hsxkkndx+fUVM03zPNDON+gWml05UVM8k9P5bvU4KrR2b6IIgqY57HS5Fh4slML4r3UVKfRLaPgt4exFQnGS+lwOnoo0XKR6OT3EcA+uhWN2xIOkf7p6XtWOX+SLhXvzf/f7p491bOtDch89sKc9WZuUn9svM6M0WvJo7a+zvt0TT2mUHK4B6+CzsXYBEAQGeY98AlaBLQSygfOzt2DAyQBiNT3ZzsJ1HrQwqrHe63e9xYrc+cv3nnKxGXn/7AEwBwb6e5vnMYp5IS4tm2wejd3Q6jxLaO3mSc8jBOOYeEJxDD1WWvXrEXbVg1ji6Dj59bBACo15RPohz2wf/OKNM1VrorKABkIwsIRlmv9L7iu/Jnll3YEmnztq/KGKihpQYA4N7c8euG/aFrT2zsHry9hxNXmH5v308bnR7TrTvbe55pGjoFD9o88COu3BUACKJY55lbcaMoiuIEIwQgg6BnO07FoDuNNgCkmcQysy0TAQS9oN/Jj2BDpwnnnPMsyxBCQgguRLsbOoaOALCmGUxPk/TSSn0vjt7cTq8u0e8333+/thHz3VB58WofAHrpGP2uUmim8z0Hd47vUW9d+enKYc+TZPIndgePdjFWjFZndgGfkNolRX+s7T56fOzaJSikSAJATAgARECKC93eE9xR1CrxXRpVgPfWBfvEqS8M0ympMvlwkmv5Y8X78lwVAETXxM7sbNXWKT1JnXeF+CRN4yg56IQDJTruCw4cYGBzizOhroxJZC9FWU8VO300rKuZSrcdJoE4e6Gepemdvd6nP/DE7e3OnQc7jDFCTcvCaqVlnKRs0EUsTtIgjFORxSnPpGSEcA6EgMHARPGsU3Uq6MUzVQC+suIAYYEfu7NOyYQpZjoiTEaYXpqsDD2aTVgspvJqnqg6HSSgwy2XXWGOqKbvtro3d3wo9Cxd1gEABjOJg7f3gjrYdReaidw7aLdj1IqSJEVJLPjAXTky6HgqOty2LYOxKI6FECkXvV6vYlQt00w5x1gwXY+TJIr7F6prW0zXM8EZpZau6wQBQJhmOMvSJDlo+QCgaQgTQih59+Hh+1cMALh/kJyd1U/O90cwbU7r4OdOzqls9FG1Xv5+s1AbDqKKYXwLlaguIp9L4DB2Sf4AoxoU6wT063YhSLMiRjWTdQDZWVbg7OA3phkAdADBINTZUb99/Gqj/lqkKT54GdzlSjIkHtMHLWsDKmYY9v+6+Ah9QcQf0XNH7jmAt0+u3B/PVsiN6Qv5cRwfy3el04vThelwV72ZDIMuA/gMMdMaa7Ufc72SIGU+PsFpAMzTktbkc5Q5eMI46uit9QhkBwDa2q8BPABYW1ttdR62etHLt7Y81754ZvGw2UYE52voFd/jlLe7YTeMMMa2wUymc5Elaawhef1MdcUjz6wsXD5nKbVumSm2a6LXdGcnjn6jPsyJ3CSGspiMFe+qqXxNN4R7lIFzZaEGCyDiNBjpstaIeo5nfsAztw55r7WvM51pDmr2Wz6lmbk8Y3bDcOuwS7GWZX3QCyk73R7TmWtbACClBIBOmABCjmHoBIVphjTNsfpunU6QH8RZlvEoBgCCscEYo5qJiNCxyLI0SVORpSKxDJoI2DxMF1ztnb0enGwJ0pRNgXg0qtlDGgBAorrHov7OMVI0AoDWCUzFsT71aGGW0Rtl/J8Q8UeA5jhiouLDp/oYRXrsexCBPOk3ZSEBACc/X13IqrxloQlJ9ohwH5GsLkDz2LPMdjccadl8fJ57DnG1o84/mZwfDbGe0A7K02x0g7H01HXndYOdqvNqEgftTAcIxtoyLkGT6wON0eylHx+N7MXt3Kr5ha+8fePe7pPnlj90ofofXt6QEgxytG6+1QkQgpinQRhXbEunOE54ECcq0+NDl2ovrHmzjnP5nHU9L2VDHADAdg0AAA2+EZnmIMbWMV8TIiPNrfhRgESNCqOIp46VdoNSkFbl5Fhm/7fnJWs+fm7x5o6/sXuwPGN2SdXmVNfDThwCwG4rTDQEAMuegbH+YK8BAIrsAz7EcRJ7rpNJmaYp03VG+21lLR2rtVw8y3gmD9tdnh55OykWYZKgTFKd2qZJKRVCqNzhNOGGYbQ5f3nDrxjadzY6i1V97MRuOlhHIBueDK+PAtZJRQ3j5AfkFImUY0pOiONTIvUIY+P/9qGP9KgJlOoTggrfmlGItz3aeyiVLx6P0lN8akbttEOB2e7eieKZQjjI1LMw0U5ky5yS7KOIL/K9iPjHVf/9CNYnW6e6xOZt4tjc2ufbSSzoBEOmYrFi8e7Ji5LEexHs+dPzl1JP1y28/jD8B7/68uXVuZ96YfWf/KfXRZZVHCvvM7nf9C1GCcFIQ7Ou1Q6SRqcnOEeaBgCzrl4hUme4gkMASwXV1dKkcYuP+kewRYvslrw9ivKxuC/yfVTCq984yne1L9RlybuWeVSS7IVLsyqd5gYAtENwzKSetJjm6OTOHvej5DAAU2fXzy883O+2ur1cwvct2m7PNA1VOAxJRDRNSpmKDPoBV+h0g1QIBIAR0lTdSE3DgBDWhBCdblfTNKbrSZJqWAOM4yTJCPnKnfDyDPYT+bATzjoExpV+nULbYwvJntyILcKa6fgHhuxTcJeSEx6EwRpUP5GP5VcbeNyHjFEkhsj+uDYDIxj8xrGgPyWu9ZM2thb6UugZAADDXZi7AcenjZROMGTGuvAlqZ7z/dE+PqXop5c06Dvvxyn3eXFhbtErLlUVqRzb9ySMo2JRpLFx1FKN70lnHjPvRZots13lWSdSPb0Rw8bGwwtLM3/jz3zyr/z9z0opDcZ6QRTH8dJsbb/pV2wjN2d2Dhqtbn+CTxFiFM3Y+pXl6nLdW5wh1yushqk76+RSvZjCeHTxF8iusH4Sshf5nrvwkyyasYnzxQVTSsUHIVUtp1fOLsL9HcX3LjVbEC97dtXm2117a793GMQ6NVfnHEZxL0wSwbEEIfqNBrtB6NpWGEVBGBJCNE3TEHJMRjQtSISh60zXsyyT8uhu7FeQtxgA8Ex2uoGUGYCm6tVEabofoqVEA4AwzkYTZ0rgzrmfH39MZB++13Sc/3/aTQ0J6rm/78ODSLlyOeTU2Q8iaDy7T6yyc61tFIj8yK95knHllHBP/JPzXW314WTtE5H9UfNkxpowo0cer3JXy1NV2gxZAtketd+cXLPPeuygHQPAIQ6hQhdD3omGHCqhvqRuOGnVA6YIOo9wBY+5cEcn5jZG+700eNj4lf/5L/2lv/3LG7uHjmW2Oj4ALM1UD1pd29Bzc6bZCTWNOIZhmEYUx3EUrdTc59fMZ864awueSmZ3Z5188VExEJrFfRcFYaIArYA+xnsxdABAUSINHUXJJLumKOHHuvnZ1NE3CKllpkrCNxvNLeEs12vXofnNdui4ejVluz6PU1K3JMzZ0R4+7MR+L7JN3TB0IoiUIpM6AARBSHWaJongAqBf9BIjpGkYgewFgYYx1vozV6RpGkKK4KnIGEAvSsMw0rBGlDmjaYQQ4PzAj7ZNfHkGRwLFiajWLBlGozQv3/CazMleEu8nFP5K9T/24eHRhoSTbCmhxdYcJzknkDiMp1VDUa3KqiCjSdr8xPAtPf1xkf0x2DKlrUq0vFvjMWSJMyhEPocKh42V5MqQGWvLTJXwp8umP41+nyLe84yaXJUjz8l7ZOdkn6u6zNDzOpHVeoatbgqgB077LoS9/vwm0CSoqv/j5llZGGuDxMqg1h8CrWby3v/GEBEACHqRVq3/337hT3zlyy999htvG0zvBiEAWAZLuMAEqxWVBAkusWWQTo/HPK0QkwvyoafPzJrJlSpzPFMlolguy2OkpRQX9WMWE42hogmjCK6ArpiuflRHJvH9eIGPiQYwnu/EUc5M/8N0GUANGs2vdWIAcDzTAViembm1Hmy0Wp2YiDSrGgKAea512GxnAIxghIiGkZSAEUp4kg6qDhxNqrrdfhIkQioMizVNUV6n1NJxkIh2L4rCSEgJHCjBlBCRKT8HYYQaYeonWtVlwE8nTRTWi71+TuXnjM4GHp/J0wf9YxTv08met1U6uTzPud9KoAoSvm84Lon632e4t4gN/ET9VKeV/C2K9BPSfEIT15On0h+7nFXJ8NPWhWeGPvdwfg93FdkV1oGBInuPBO2mAIAkDpT/zmoeAEAN1qEtGyYAHIYJNIShySDihhSaWU7EHD3ymK+wDP38T33izs4bv/CPPseYDllGCc5ERokmpTQIVmRX/zfDuNMLhJS7B635qmFgaZqWPT9TN+xa3VWLkiaFSRXNNehjPad5UaoXf5z06Kh+V84MTF3oNHgOHVO3lncBaK1euw7NG5242w63t5rSrDquftWd32gJ1m6ZplHLcN3U7uxRVdwYADgXAqRp6CwjQmZBmGRCaBghhNOUS5BE0wjGSZqiLMsQUraM6tLXDeNMgqHrhq53ut2UC7XqlVCiDBxKcN2kkZBzNvXVkinTAADVoa3kw5wc39OvhCmzgcfO95Jj8/1Q9DBomzdW3edYV7krBZteA8iUeG8lAJBNios+Rl/lcdk1P+hOTEO2TOL3QxpFnV4yZ8Ya7mn7Pcr2KSubiguXTlhAWOl3Zngw6Hm9xOZt29GZpVC+3/J7vLsd7y2xeQA46ISqlNi52sp6c/Pcigcr8KC5WQ2clqnDdgAqVXYC4h+jYC/K9vzW/W//3le7IbdNQylHTDDBRO93ietv7V6a8rju2oInix6rujRst6RhV0hFGTJAHDxSB7XkuuQ/FmGd07yE9feyKf9HGyS/9yW8TIcqUA5viu9QYTc889Z68OaDPQAA6gJAwpMgkkEANbc/Vzvopnl6qJBI07Bjmzzlqcg0JDOJASDLsiRNs37fbQmq2jvnvSgaHAQNaxghlYQjpBRJSjWENJxyEUpUAzA08AHCXmzaTDkzyGQQj0H8WJ0+iftjrZvfl+29CPkpnkx+fPQECwlg/czCnOxTLJpqIZOt1BdHcf+9c/lxjRmngDuOmlCpvdfwRV+5D0N8NKW9pOWPHSce4TI6bjAo1nyfTnlluxsmnVv0YAdyE6bBW4F5CKpjKgZsKW4DMNiO/XPgrRd6ZJ+prUANHlibh1BBrcyUSniSPP+s2KHx+7QtPXHZj+Q3bm6YpiFUpyeECMZMJ4wSplMyuPoJwYZhQZbOeWyeZZDEc3P2+y+fefb6AgBYZkqd2ti1SCVrZZTgRR9mIqyHH81fMM+fyWV7MUUSYQJpWjJnMKMij1HyrnrzKnkGALYSUjfIi0/azqa+1Wiv7x2o7ttxErQiXBWo1Yt4IZVNiKzd7qSFUlMqKwaBliGJADSs5SiH4YKRFcfWCQZAWNO44N0wipM0zSRFGSZ487C3xKzBVQFRBjJDMMhfUYgfpXNJy5fGgNL5o4HZSVOBxz4GTAJ6kddKfU+xX8YezNthj319V0c5TxXZMSXT09hbCVQnXJsqJBvy8bkx32+H/Qeh3G2v2tzfAYD5mrnXDMfy/aRVISfhm3qaEf5gPqDcnDlJJ5A6qcIi1EmVGV4ctYMDAdV+L+z+rW51c3W/eTdbuVDOCkWeUw0yqIPZqSexCDg3rX7HJUV5yyDKbX+Myh0ATMkbgXjh2rlf+8K3hZRIivxu8xwLI5STvWobqox7wrlDYK1GHC0zbXalyq6veGa7C/UakDGGTD9kGiWTVPmUh6aZK2OjrMOLoY7qGQxku0ZpxnO+g4jTfmOQXNCZKdRrNYCbO34j6i3PEACvQs2GwN0oAahstXnTD5M00wgeqE4KAFrNi3naC5M4SfsanAuMMgBAGkKahvtr35GUAiMEGBFNm/GchEspZcVSfz5hOonTTLk0FqXRYP2ko2UAwOIoAgQAMoxBAxZHMTNy1svhVew504s0P1anF5NtHovVc3Kyi5T3cZwkR4Hj5OiLPs2K2GnBWz+RpRNOsEDpBDPFcYk3uczP097lOOGvDo6mxo8dLYpJOD9oW2a+ZubNmIbldlb2XiZtPPl+47tYpWAs2RXTp8dUkyi2CdCq7YaI42qWZXGU8Orhw6yNPAcA8hBrvs1WTBhuhvcwO7KbdF3XdXAAkiRJCAlMFoWxKXkeR328m7RsJOMnnpj51j9vAUCaCpASEDIMg2INY23Woa2eqNrGQTft+DHGmkPkrGs4mqjNVixClpbdRtSrzc2suIw61iRDZgq7HwvWx3oyY6ZluX5HFBDFDIpnqfiq+v/aontzBwCgSw56YYsQZkmhV2aeOusszHovvXH/C68+CBMBgwgqwVqaUYRS02AaQiLLpJRZlgkps0xCJgBAQ6ARoiGCENIQqtimEBnnghASpzzhEgB4lhFNq1cqXPBeFOc3fx+IzIAwVppdXUM53+XY+iQjHD+V+n4sUl2lxk831scuQTp1wKDgWef7o0Z2kYn5Q7nGt/qUx6cS7ydH/+gAUDwy6ZzR0WJyy+Tvv+demzNaYki2OxYZYvd0d+UE65hUHs4jt2SaElwdBfoxmTOUpmjGlmEcBj0SAAfZ7iJvTCUDGru27fAC3B9m7cEA4NDYBQBGMgBghMS6ricJ2CyJhV7vtRqaMsrDXpxLqkc2bUJETMkh4HPza7ZTP2y2ASAVGUYIpDQNHQBW6n1Yt3pRnGQiyxjNslTO29K0WRTGZ6sAAHXDfqLqYDZ+uelj9NBLL1iivMaQKjhTwrrS7xgTKXgOdxEFmFFAVKXNQGHBav5EtawJFmZVG5Ptg9Z+5/C7mxtGZfaFp9Y+9ZFnvvj117/8xiaXOAhjANA00JAUmQRNI0iTGmSapmWZRCAznklIMwlJihEilEiEmn5PFSGQUvIMpJQIIUvHCZc8y2xDtw19t9kBgCDi3QxTnrLBlZOjPAIE47D+GEOUo6q2COLRR0fNED/hx3FZM6TMl9e/F76P7h/7moHsJ7wjglRBsUlP8YG4wMdyH+uq+th7nQHkY/mxEr44PhWzbn5fAqoZADTaYr5yMr6XqxG4U9z80/K9GFNlmIaQTjdnpot3ALAJz1uQxwcMcJnvypOZrZg6s+bA3Yb1ob8i6J+pyA4AMdeUkFdTUx671bqv+K5Um7q9o0AYeRrl6WV786DzrEc21rdSIQCAaijNpGOZREN5I+yqbQBALw4sk8k0NBiec2ndtQHAdbDjmbU5ow/KYc0+PQn9vd4DeV7NIKUyLyU2qVINwgQPvPhiU9Y8LTIIqcp8P9Io9VoNoNloLp+pbinEb/H7sf9rX3nj/Orcpz7yzHLd/o1XNu4HESHYADC8ipRSZDIRMk1jrBENk47fQxomGqII6ZTOVKwg4gAZo0QVdgcAVdu92Yu7nQghpFPaiWTNZp5rb3bCVY9GQQKW7nf7f7XRt3EgChK1HwXJe2Hi1HXtWokjhpQnNEBK3Bmrmov7peyRx+JZ55/V2E9MDUUGRtHwSNAafJxV/ShkmuhUT7JELyc7zBT0GwBUyEmHKERPWvXE0VMA6CYUADA98nVNFP+AlHtt7miNZRXznOymPkgM0DDvNEnlBKtec/E+Nbh61Obp8dkyJQmvEH+s+Z4i0497RRsdhpPf+162iZmhV/h8h+8VyU5j15JMDYGK7EeuYyw0ptHYnRFZYHL1EUcaRBnIMFZzZ0X5IuJVMkxx2cvwjFsYJosTQQ3bj6SQGkYok0CxZlKNaEdvoNWL2r2UEEw12GhFTyzYAKAz7GmJU3GvV9hK1QEAXGghny9NkoYujBqOmt8PrJfGEg2OxpJJNSNHqxQAoiBTdbhUdqaIeACoASzrfLeWuvdTi4itva1f/rXDp9YWnrswAwCbjQBjrdOLEi6YrlOMKDYQAkaJa1aFyADAKmRA5c06Or1QSjB0AgAMYzCMKIriKMKENDJpG+Swp715mK3V9FFOFY+MPnQK/BX+R9SSaaB2HD1VNFFkebRt+itoxJ52A/LepBPYoGJwPKg0yejpVH8YBn4vzQfF4igSxllV7/swtZqBqKV4aqJYG079YlSqN1D87RIZhj50C8dxMPZ4/2ZMjoLtSEbqTLXPmKWeq4YNc0yJ+/7wkJ/5A1Xu40OpKiHy2NSXXLlPyHNXbv57aZY9yvdS+QFVPHIS2XPxTmVYIvtREEJcAAYAYBOHGTozvHoEANDhe6uaFzN20Alz2V4me5IAQNbpf/0WGXySJhgAYLMojMNeHCcCdIwG2Y0yjKJMAIChTXROozBOCb3zYP/yxbMYIRtrPZG5tiWRVsRQkmamjnWqre92NIwrRBgmS2IhHc/xzEHJ3KP1Snnu+cnLCZzWliny/VS/ZWyhMRGnuTlzjHap12r1Wl1sOBWhM3zjYXjjzvZs1X3uwsxzF2bu7we3tzudbiiyLIw5TzkXPOVCQ1BxnYpt5Ao9TnkQcSGlGkOJhoKIiyzTqcYAg2GkaSqzrNvtcs4AYKcdn52vzFbdsWg4dtMpB4AkJaMHx5+P5xIRAICOrff4ZXWjpKqE54g7F2dwgi7Lx3+5cQZInu7dJiLQsdVlVjdpAyRTvB1EEKJWxdIH7LaOSoMhw9A1nXL3iOkWkoFEFsDQn5aIIEcwAND+dBzSJBnsJ4WvySqBmzFrdJwoHo/jQO0rvr+HFaq81zrN+aaeTUuSOdacgcfQvuNYCZ/bMrkPc1rbXW0uQ43hW0bJdps4llUNgv4n5xpclwiganOrRwJYBEswP+qd6m3nlLdc0gAAiE2bKbck4BxMlo/x5jisA4BhMjeDB5vbB7t7q3POfhPzKGSUkEFi+0E3DcK4YpEkzaq2kWUNHcGlZcciZNYZaZ9UKCeQy3ZQqbQ/2C2LZe6/T0J8OdzKu6qAZZ4WWZTwlpkCcfJawfPn115sNJ+v4O/MW2/vBet7jTt7rOaaV1crV1crbz7s3N7uZDzNS38LkVnDqxaIphENAABjjXNBCFa11MIovbRAAPCNB4lAeLZW8YMgEXLes55cm9s6aM9WvJmqLdIExpUWp9qkeuPDNORSlwGiXvEpaqcw3R+iapq91y+FUMIIirkEAEYQABD+KPY6TzmhJP9/gFEr/y35adMGg7E3r44AwE+kgZEKV2KdAAhMtbFzAjXQJinJh0k1xgx2rOLAUxxTVfqPTrlOIUn6OxJZIPmkkXiIV5oA6kJ6JHaHKK+JH4RyT0jNG0kqzzJxrEk3QU64GjUnee6PHFYtpr0Xe3ScpHZYSbzrlPpRpVQVeV5cUPnv7TDp8S4ANDiGFrgMzVbtOESzwPxYwkoLNsGPeiXZPrDdkyQ+Jj6GTGaYzHFNANATZSZqFsoGrj3QwXWfphxqbpIkgdTmLVNg0eiG5xdrOwdtQ2dZltmDRTq9ICIEdwLejaI0g4V6dcWTV+aN+z5frqFuJ5jTuGXOYAoIV6Y77I/dnMlVfMGu6bv8ag5R5Hs+qyj68orvGgHNsdLugO8FCV8MsQZ+rNpIKcTX6jWo1xTi37k088rtwxsPe7/znYNr5+avrlbyt9T0w4Pu0CWUl+iJByEaIWXQi7phtOjqf/mTT1w+Z/3BF576+t2DX/zfvvLufuhYRtrpBTEQSi6dmb2/69smNZiu+K6gXORvEdalg/kRXQaUEjR8ob13fI8dRcq3G0Fjj5+W79PxzafmNRYHg6J5DYNqYjBISQQAzTRsSkZrcSvbhOp6id054hMRFIV8cX5QnDOpfXWm2hkcDwbz5hFWU/fo/1Huf//KDzT3o/laH8E1W1pW+RdpGn4U8T547ugSpNE1TTnoT058zaD6BMN9kpAfGsYGtX9dg3daVmd2T+V8rmpeZdGDwG2HSbO3tx3vAQDsQGd2r8Ln67Gcrdo8i1zIAKoBO8xiHQbR9rEWjc6wsuAnSBKcJElO8yojlJLi56PpkSVYl+gOlluNRM1kKWp3u8HV1cqXvodckxisn9iepJmQ8rDRsQwGEsUpb/ndD67N7IfYIuB4JgAsOFUAAO34DiePl+xjM3CkoaNoqJoYtqtDJwwPP7lFgzA5WtM0TPahnZEuH7V6rQlwHWB2Lls1zN98F26u7zXCDAC+8famaxpMp70gCuLUNnSV4wiD8u485VGSci7EYGnBf/WnP/FHLrmf/949EQUfOe/9wz//wp/6R19tdHq2qWMt4yl3dHplbeb+TnOh1id1EU1j98fupNTmednl4SdO2k44JxhF+dilo2yQBPJolFfyfCzB1cGStJ/4R+lDV9Fo8nuFCM+sjMr23DofJXvB2rIAQKUsIRko5OqU5/ieJtQmv+xx35MLefj7MW69dt9z6GV9/dvsIQAA6k1S4kN8P34i4PP4dO15T0L26QFVzaAnLDWjVL9O6azHKmR+VfOu6pfOGZdtbgVBS5G9hQ5b6HAP333Q3NzfaTd466DVE4MSRXNVt1qxKCXqX8y1nOy6rusMK7KPvxqGXTld13VdL5EdALLECHAMAF2BAqmp66+X8tma+8K1czxNXZMKkTU6PQCI0mz3oJVJyUUmMhHESufaAeeOa85pnVEzpPyuou/7YoXSr1NrXFX1YOUL5aXH1HGNodIC2n6ipGGOrQ98VFnMTNW/0gkrZxdr9Vq2eO6Mm/3RS+TSshcEwY37hyalnIv1zb2dw5YfhHuNtpSAsTZvo7qjd3u9RqcbRLEQQtOQhrVZh37wggEA3U7wbqv7zRvbL5w3/spnnkpF1guTVi9+e2MfUx0AFmr2brOHqT4JysfCmmpD5xxL7fci6slw9nrMZf7vvbygYnfpxdWRkzgzR6Yxik/+q5Vazw0ZJbTVv5EzrRzxTBsKBjCt/68wjQAl8JOUpEmCZDDFkxn39filH3+wqZA534vFYRIfrBngSb+e8En0e9qORWqNO63IcfGYFkApk/0kcB/yc6yZJVSpR1WXoQRV4mifVw/3mpvYGuoyq7pm27OWy/rPZYauM8tjaTtOlXJXcB8kR+pJkkyz4UyrpqOxTC/xPb/slLRZqrmMYmJYBkEaoQcH+65pcokP2i0hpavrvTB0bSOME6wRpWLmtUToa52BEC624xiNo36fDJkpcn5s0bHBzhyKEohbJbumH5tAVETDCp04Vl+EsEGEoyzh3bnaCy57Ndl+c7u754vdTmwzrVq3AMCzKQwW9/7NP/bijbvbv/Odu+1eGsccI6QhAACsaQjjmGef/9qDv/yHnwKA/+Pzb2m9jr/j/dFnVv/eF1jDj7NMfvd+8/rFpYoBBmMAvXYvrhiQnX6RkabJ0rPGDgbqNEx1kSb5LCGnPD2lpZMDlz3u5hVFlCvinxDr/T+T2GMb++W2+7Cgjop2iiJ4wXgpOT9QstolsnRNHz2HaRBnFtMAdB0AJOg6DZSVL5FV8nMmujSFH7UfwM1Ws+Uo5Y/0UVG5J/4JB4lJlWGU7X46Q/AE3TzyJMgpiC/1Y7IJn3GRV5vVrBnot049Sp6ZMVn+43a8t9/y/YLg9UyMDMtjFBM9Q3qe835SL1KnOdkdLB0slRUzZdZskaTqWoftIPTbnqV3/E4mkaZpbT8IolhX5WelRKAlcaLjLBcvaml+nipzdAOM5K7gqPkDlvDT1b2yazSG0gzt7Tf29hu7fra33xAxpxVKHcty2ahCHyPqXaZafn9nO/iHv33vn3w9+Y0NiAWq2gaX+KCbtnpR1TbUKgEA+KXPvfbrLz985e7Bg72GKhAGCCENg6Zxzl3X/fw7rc37O1kc9Xb3AOClN3c96P3kB1YAQNNQoxO9cmsHYRbFiWPo/FGXy4+OB9pIjYF8AMid/VGCp9nRP3pKnCjZfqx4n/I3ljR77saUJPyouh9F8KQUUlUwEo/8bSp6KZGlnq7IXtTvame0VvxYs0WdxrR+7pD6J5FVNHB0yqekNo35cB77bZPXlpm+uXm6a14b8vdpK+W5qypgE2+JqdmQo/32bMIBoB21VTL7quY9gO7MIGUiz3zv8W4cuUXxPgewL1MnTgFTAJrFKcgEACgljGR+wI+NrCqmdwVS+9PdO0RtRwPHYpxnBsOHjURDKOZpkvaLosRJomEcpxwArp5dPLvg3r/fcCq16xW2lRClbbM0VYuDsljm5XyLMH3si1QfGet3N7c2tjsAoPWCRtSrG/YexwCd6HC3w+n1Fa82ZyxjCkBV+HQYNt0gpIrpIk7fbXW/fTf67q2dmw99AKi5/VBTqxfl8nSvFfgRDxMexXEUJwBAtX7FMIyxhjUpJWRZJjJTx61e9KuvN1GKViv6qk27KTloZ3/2Ixf+xVfuAUIaRrud+P5Oc3XGVlOuLEOTwDoqz0+i4vMfxz53JJ3mFF48T7lt0rHO+xTEk5MVJCiOASXKj3r0JSN+Smq85DIxjbFkp7qucDzqxiiCq4dycKu80rFML/44POr0Rwiq6yqLRu0cm0vTh7v01wEAxe3m1vaR3F5e6r9R9viTlFW6CxmtMam77z3fMQ+intyZOVVvpmO77pUQ3+MEzF5e6+hMbUVVGphUcyZDpiZDZc4k0L8aPIAAZ2mgYaILDrqunSRzJt8CHOc+THn4GdxsMotr7iIAUGbGia8zlgmhboCM8zSTKsFjZb6ubsXF2crawuxWAqo1x1ireqwb/v1A9gk9n91msPlgv7e9vbF70OG06ycAsFxD3XaY/wiQfOGNDQCoUNNx9QpJn72++kTVGbVovnlj+zduNm7tBk0/rLnmz//EcwDwD//tS4ZlKxPmoJv2gihNAgk6plj1tNKwhjKpyK5hTUOQiQxpKOVC1RSr2saN3W6FwQoAACy75q17zY/98Nqz52a+e+8wBSCG2G76CzUb+qnT3hR5PonvxeP5zgkHgzzfppiiUzRtRlmvYqqEkpjLUU8mz4ws7eSkPgnfi7wunl9yaYq6/uTzHhPFxRT1vo7W9BKLle6OMxi1aIqZl3lqv/q/9OPoE9VrKstevbhygahengcUMzJJ8/XfjDtN8B8GQZjHQgHgptcn77VLL1TPP/mY4a6NCwk+DrIXEf8INYGzKJ0i24813BXWi3zXDdYb6WS9qnlQ69+QD2BMcFjZ9J6ZtKFfER4ALMECK06Dvn5XX+VYvpMkzbuw9vX7BLIDAIGYMFekSRJzAAiiaKHCbmSSSMmFEEKoBasAYBtsecbeOWhv7MNPfvhC2oiHB2yapanKOVHifezi/8fL95zp08mOomSn2Xz7zu6dneCw2YFAvfP+wN/h/WFpuYb6P/rQScNOGoIP4Oq/+eUbly4uffiZ1RpzRRRs3t/53T38+p1dVRgSAP7Gn/nk+5+9unTlPBD9iy/f/s69QwCANFpm2fsuGzOVhZd2susXl9582Pne3f1uFPndUHXNFlykAJbBMiFW5uvxgDW3t9oXXPGh5aGU3x+5Xn/l7oEmJYlBaub9Xf/sgsunLthRoVfIkpPYMqOsPwniS+mVk1R8zKWiaonsRYhPEu/kxKXEJp15LMQlMgDak2yZgSkvp7g6xf2inM+9eLWTJolOeVGqT1nAlVs0JWte8SAHfdHqKfo2JLnztf1muCoPGIDC+UM0CwBeu7keBRdWrzwa2Wtzhq1NC0CTSq3vtif+kdVOZiQ2kQiP6smM26JBRBFRJtN41HZ/NLJDYYHSpG5NJ2m5p4ydIf0eTlxajTwHgiGs5wVNmaF7kOzHIAcNJbLEoFYEhXDoKN+ZJrhujlo0XYHU/2NvCeUVBFHUDpLVGQcApJQZoDSTGCEAwAh5jsklPvCj8657+eLZdQ3hZFvoSyXDPef7pLWpj8x3hXJh1BTN8x+nkD3H+sO7G3dbfK/pxxmu6chxzbmZylzVnfXY2lLF1mJpVKtE09IUZCriVAVLb+74ANCYIbff2to65F2Bsgzt+ukXX9+ZdWirF0EaiYRfe3Jl8Znn1l/+yv/+L377O/cOq4a4XoVPLc5cnCcA0OKZ62j7GP35H33m1vr2b7yyUXyHaoGYZbJLS5Ub9w/7cTwGyGQfeGrp1r3+n9ZsND/z9Nrf/extAXAYJJ9YsF67d/DEkmub9Fg/BFNdihhhVnLPR7cpvvkUUV+ieTG//ug1C2K8eP7YbEil7k+bSFMkeDGXZoqWzzdD1xC1Rhepqq1UIoYxS6d8yjrYoruSWzQDBJMkJXnvqVzsHztsTLfpRycKSAZEbzxYLRxSZF+VBwBgnv3gxT/wh5B7TvrrIk7h8TUonaFNgNr4LktHRjxMKktg6Ho3BAAYJXvO9yLoH82Tmc73KUtYS2S3ybRVPaua93CpbXccZugJqgy9AcMDaOvMiuNBOkohKFoYvRIo5LxHYWwRopQ7YlTGqcK6kvC5ET8W9IftwLGY6xgL1UrD74KmwaCSbcWxORecHw0kQZzuZ5Xrg3apxSYYiu+TxPvJya443v97o+bokSlkVw7MvQd77z5sdf3mrs/jFLXb3flZz3HNqxdX3v/k3KqpY0Y0hhBZVs/aaTbfvnvw8O7GVlNutFpho93oezWQPeh2OGpF+IeeXukFkaMlP/T02jdvbPQS/nf/6a/TX/78Z196Z9mEP/XM7IeX6IznAQD13Fq9tgSw2Gi+ltSIYV198mK7F3/ulfswKMR2aakCAHVTcx0jh/uZGa/dblHPJfU2b2QAsLPxcM7z5jy204oe7ncJJQaWrV46U7WjOBlLZFxYs6HIXjwoRVyEdVF9F1+tGGVVOTNT+F5aOVUU+CWkqjOn5MyUyJ6z/iQWTQnok3Ii+eMo3T6FuWr5Uu6WAEAcB3GaAkCUZIaulfLrHyVeqE207CUaXlv0EM0qrPf3zzyB3HP9DyLuPka478eV+f7HrwO4fZTnaTMnMMrx4y5FMJp+M8WIn0L2sSFWZnjFAmGjfLdmMQDospPzXZcdAAiR6ZnJfkxz8W4JFuBYUV7TAScWpaTXC3SGx1o0iFEIuKK5Yn2O+D7oQdc1RDWQlABAN4jXFjzLgEYhcQkjpFMtTDglGACYTl0DtXtxlyS1c4tjDXe17HNUvJ9Ks9/+V79y615zTZCl//wPzS6tFNV6rt9LgwFp7Sqp/tZGu+1Hd7b2B+WcoN1uXTw395GrZ9//5NyFlT7NI799827Q275zY7O9vt3Y3Gn49/gDHvsYAYBbqC7i4y4ARCDv79c8m3aS7K37B5HEkYZ/86XbF+f1v/EjK59Y7V/DCuv28jwASL8NUJvf8cGoAsB/8ac//eHnN7/49dfv7wc51v1u9Nrdw2bHX53zGJbLs14nSADggufdajRn6hoAzHra+8/Yv9GKsky2/GB13jvoRDNVu0Rzxd8i2XPZPt1jydV0ke9qAFCyXYMYU1bie07zsYHWIutLUC7p/WPDqoORgExner8UwemFv6OnYxsAjVajnCLbc7zGGQCyACBNkjhO4jTtpVykWTsMAcAzTQAwTYOirOKYoOslkX7CVM6i6i+SXR0c+qRysgOA7VVLhsxjzGMre+56n+99T+ZklrpjkTDRThJc/cFv/ToEA/ve4KIeVSfBvULmbW4xx2vHickgjBOT6QCQoIrJQJP6XNXdb/kyTi3Bcr7nWl7TwZUk5hpAEnAOAFynJU9GYV2RHTEKcGT1AECSSU2ToOkOE7e3GjXHe/psbb8dZBKpWjsY4zBKkQQ5gHiz1fNsBpA0G81avSbiFDNazHPvo2E4beZUmv2N//GXvvPZ/QrQ70BKvvy///n/9FeODaVu3Pzuq2/vN7q80eoCwJv3D3TdYDRizOp0wx99/sIff361ujqnMaQGgDdvbX/ne7dv76d+I91IBADUTKJGsyLW3Tq9fPksAHz7xv0oTLd3D6q2/fb93Y3d5kKFfWhV//EXnnrxTBUA0rYPAPPn17ylGsJEwQsblgVwDeBLD7eo6flvbz539dK1J1duvr156879jd22KjQGAIzoAPDEUqWO++P0/Pm1w3a7SrQWzwDg+StLv/HGIWMkSrLZirHdPGz3HEdHkwR7SbY/miGTIz7L0Kh9X9L7J/HfJ/F9CuKPNWryRxUWx56ZR1AnhVINS6c89ZNpowJjlo5PdBmnSRLHQZyiTpDKNOhwlIVRh2MAaPmpoVMjDJlu9VJetzC41VETZvobLp0/SnlS9GGKEn5u4VIu25F7jlXelln6aAsPmj1k1cfZMkfive/A9N32Yrb7ZPNdkd3UsymIP4ktk6dClsT7lCbaJ7Tgc/FecxjA7NJ2UqrenpOdmp5iehy1NYA4CsHwwjjx9CgeLGvKzZncf89dGmwTGmiTFjchRgFRZFCQqUJ8Dwx7UCLNtchmowcAFQMwMS2jcn/XB4BzizPrO32XQEOQJAmlmAukYS1O0s9+9cbzTy475tAFp9pPj+h3WtIHxyJeGLWD7c3vfXmnppkAUAO96Sc3Xn3tqY98ctSQycl+7876F1/ZBgDBQ0z1W/c3K47V6YaLNjq3aH78uXNXFuf9/eZnf++NV24f3nzz4fpW/80Lhy4tsTVLR9SaNdKwFx90+Z29pBnyNR0DQH2+/tOf+eDXvvl6VYcgRAd+NAtgg/yJF2b/0IfPz2kdVX0hbfvz59fcWQcQzThk6Oh2wYblGtYVkb6z3X79nfu37ty/fPHsrTv3+zeIH846tOaa7/D0/GLt6qIJAD/6wpm1y2dEnC6urfrf2YI5FWBJAMCiWN3wNiWMoDQDg516IoswwwWJpYm4RHNNkwizXPUX5b+ydPJRpLi+adSNGR0zjuV+keM57ieRPfd2xpo8xWcxgnI5W8JlMQ6pCoflPaGKvVsHZ+pTfBLF1jRJOt1QYV0VE9aHuwNGSRolANA2dMptGaeo4ph5ycyxaT8n0e9QyMAhnc17lZXzpbNtr7p44cwPVOvmRdsTn3ea/YhrbspPXrZ6rHg/kU0m0pIPk++fZH3TWL4XxbtqwlepzvW6QVG/K7JXqnMAEMZJHLUBII4SZvQp78fgMtROjFFzBgqp61liYAK6zqEXGyazUIaJjhjJ+2boOgWAJE6VbHdAyMG9LOPUs437O82KYQkeMoIMXesdyiTN5jyrG3YGd7tMU5GmgmIcBHEjzNbWVsPm9o1O5+P1aZ9P0XmfjvVRA13PUAhZ4EbgY7PdLaK8eCaKkrubW6++vS94uLl9oOt6kiRnZqx3d8K1Ov7M02vXFt2bO/7f+b1vv/Td+3vbMQBcPGv8xKdWl+ve9RUPoJ/NmW9bCWlEva/f2Pvtrz0AgMZe42/97V/JLapGM/wDq+SPfvLMlbXV3e5+/qxzz1yijpWNm0mLKKCO9UTVAej2kpnX7uxs7L6+XLe/8c5+3dQ++tQCAPRifnbOqtu0QmLV8knEKTas1etX3t3asrc17bnVCk0AwDGIWvhecUyD6e1erKaIRaEHI/VVRg3r4o98nCFAKIHBj0X5rwaGo3KMljXJQBBp0h8D0gQG8C1xv7TeVf1YIvUjr2gd+zqDdMyjj0vVfnG0DAaNAMd2+1OyvfgZqnFoKGVegziDTjfsBEk7DLMwHttmJG/V5CfQTHiHtxVwc77nH++xYYYi2YuJ8+Tqsgsjsn1h9RnprqKRe++9L3lacNLdLj1Ma7PTUZ/n0pyA7+/dlhmV59MFe264T69JUMyq7HGiaaJOqgAwxPfqnKZpWZZpMlRkz/9ng6/ZZHrRnJk4yaWkarNAaroqrYwoY4aU/Qm+EBITE2MkhBQ8RAWX3EGaTnkngmrFNFgSJf5TZ2fb/sZBnOWL4xXfhZSeyWIuAIBHQS/B5y3bMlMABohqY8Onynw/mSGj+I6j5uzSSu1HZnf/Q7MClPuYuGL1+pUc6Hm+Tb4i6eZ6e2+3oRLVkySpULOihfPLePHMzMbuwb/55u3X3zloJXBhtf4nn6u/+OTctUXXclmeElNkdF0YcwDLnnv9I2cuePiX/tO6cmb8RupjZJnkf/jjT714ppq2/d3ufqsRX1lbBYCVs4vI9YpR5aEZJKMZB2xYyzhuWj576syD3cZWo3d1tbJz2P3cK/ertnFx3l6ra2ez5otnzn7hXhuABn7sGhbV5NL1a7+x8a0nzdRxdQDQmamwQnXdGnyPpeDhaFzRwFkERNeQhkQmcZJJQomBMwDIJIZx630AQNeQOvPY0OXQUDGAXa7uMdXTOAEYM8nAhThBPgkoxg9GjaNJJlI3kYyg0kPqZUf9/aKQBwBDOyoLwgbpLHEiKE+VeJfI0Ckn1BodMBih+RSBp9zvRr2Uh+1WNtK4tUR2te8DAT8FGM/3k2eClpZElZ/2EM3Onb88d/W53JMZSlcYXXZ0SrKPsWVOvhX4fsKA6snrQebmjJLbJ1nWlJP92PzIPHlmtmpDCzp8b32zfW7Fq5OqYVIqwzgMYoA4StqhAACCdVvvQ1mFWEuZM7nnnjvveXKkhbJcrVuGQSBqh0IMHGS1g4kp+OBKRhQAlmbmbt3fXKo7jqEZumYz8tf/5Mf/+j/9bdPAqiSthjUA0LLMoPSg5Tf98Nb69uVzS5A2Iv/AcAEkzR2YMXXSj1PrxTQYtf3UL/xn3xX/4Xtf3pn7kdkP/YkfYXNzxRzKfF+tNd1rhn2yx2LWca5VewBwX9Q+9+ruuzudKIYPv+/MT3748lMrrCJx4Mc3d/yN790DgG4n8Lv9D7NNGG80e0KaFW8OH9hUnp3V/9QPLf3Kl/uL+5oh/6MfWT0nu+9sdKt1dq9Jn/cMAHDPzYGE3taeO3f0V2hpqhHIOIBM1YecUWq5bLnR3OJwZqF+ZqH+e9+7AwA/9PQKAHziEqOt/WrdqtVrlQettYVZtThWxNxenq8YRysVKrpUiRZ1m2qDmvuKwsWdQTwwywa9TBXZi8cziTWINEiNgScZieEWMdmJwpLF6rtqrf+olp/i6RfHgEnxA1xgPdWgaArlBFfYHY06YKqrp0+x+KPCQ2Mbzxq6pmNj+hxCrdVKkpgHXSj2I5zQI1Al0buc+0CyMOoEplor6zxSrnA5Klsiu7lwYfHpD8MI2d/LVqotkyN+gjnjkgocaXaiD2VMfj8DpLFIFaOTKNZP0Df1VPHVfCmTV5td2k6I7VsEM8PLCR5H+wDgmeo+HHNtZSOZMyX/XXBNORIqiEqwTogGHDwT9xIMAFwUPz1T8FBBB2MihT/jVR/stp46v1h1w43twx/7g1eev7z62p29/WYHEyKFyLKs6lpxKlRyZLsXE8Nq+A8AIAipa+dzdlLk+1gxO5rrMprXyKsLT/+tn3/ub/QT2yFqwnCOPIqSyG/32i2tF6lBa7mGlmuu45nNNnq7rb/01m6rF330yuIfe37xhUuzAPDyrYON3YNuJwAAp2Kp/zPLe/PBXpzhOBUZx92EOu3eFoDfS511/7mVipLtKtw6h/k3tgEA7IPk2csudaq1eg06PABuuSyjVEsCFV5WzrsaPvuUV7dDvXa2wm5tdADgY89evHF3+82HnR95ZrluaLje+frN7q+//vozZ9xlnQd+rHIydFapXb0QhBQZFgB4ruV3o7pNcxUs0gQKU7GiPAcABfRM4pzsGhKR0FRNwwyM/Lh6bv6UEuh1DU3ifpHmY8Vm3ldkUkXTIwMHjh8DJg4MU19EnVB0gYqsz5V7nAgVU1Xme8lznxQqyKHfjZKM9/Kmfaqd06S2tKr5NSLI5bzDiRaGFUuXKNNpAGAVS+KMjpfTM2qYBuQhml2PAgCoLaw8sfDE4vXnoPrUe8fZYaDZnjIljrJfdrv0GLj3L6JxpWZK6ZKqtRNAJM1J2e5FjX/ybPckTXV60gK/00vNjN1swueXlplxAACGSVVDbV12mKHHU/ORlDmjxHsxYQYmFAUTmeA8AzAIRKpygA2iEwEASCkwRgB9lwZj1IlAdfYRmViqO29t7B7ejz9+fSkIgiiOIy4F51gjpmG0Dgr8jQIAOOwYK2dZqS/20c3gWUVPZlShj11lOmlf8raq1Q4Akd9WOSQAYMWHVg2tLcwCwBa391HnpbfuXpy3/9yHL11bdJuN5m+9cf/2W1sA4Dps8cwMANxaD243/L2D9kaT+yHvJYJzkd+idZPajrkH+OCdhsm0LSXBQL693bYMslazK3N1gHQrIbsbtxacuVq9Fvgx+H3DzQLABhVRgA0LoE92qsmk74N1z1vJ2y0JACtzlV7MlQBvNeLXNjumzeRmuCO7HvS6DdDqqwAd9Veo2EnNYYsz40vnl/irXJcc6LmE15DIB4Ai2XOsj84GFM2Lr18+OLmQSzGOeipwn3Y7yYsUUzbzdHuOLYDWYJjhYYwAwEISj/ujpoSCYy6jJPN7qWHpiu95w3HJpQ9EJBwAfJ0oZyZvBnLk36Zc11lxoRMUKhufKtBK2l7twuyZuYXz8xfPS+Y9Ls2u9QKAiq0dNYoew/SxNvopTfbpZP//ty1Fpg685mCbVNVH0OOEQpr77EcDr6GDqkOgRsg4UaY8wXrCaI+fpqI9sYBnBCIAqPQn90rLDxb6IswIiuJkbXEmTmKDaUs1t9XuPn/tXLcbxAK9dndPcrEw7zX8IMskADAsezG/u7l/vgK1eg2zI8NdrWBSsh1hAs7cJLLnP568GjAiXuS3DVd1hpP1LKKYNiFSWG9EPTp35Vtff/2t+wd/9UdXPn5uEQC+tr5zaz14sLV57UzdqVjdTvDK7cMbD8O7DxuNMDUNnVHNYJiZVtMPDAI/9sL5KMluru892O9gXV9POCVIH9y6r74TXDxrmBXP7QT73szFOWMZX+4D3WVKsB+xxihnQ2PDgkGhYN7rvPVAPHdxcblu11wboJdW5559wl4kHejE97aCGc+b9bS9exuLZ6hVO9dswAzt1V024zLPZsU4qvLNdMhyQW3gIUwXsV5kfZH4xUfVQxoSBoaiq/NesJtOWGz1A9uOVgCkieK7smsAoBemiFnQK8OE6RiSvudOdX3Ukym1J+QpLxYEzrcOxyLhWIeapWjOfSDKkCmeFsUg0gzJCMCKsyNfZew62+kSPs6AfOwTPymZpxz2U311p+2hehoYDfO9mBxZyJKMpGmgcGwFgtPq96LDrtNTuDGnsm5sPQEJALS4flV10y7W+22HQpkzLkM51rUB/W0duLAAoMe7Jf1e/pM1TIjGecYHZAcADgYAEIhsXfQSHQAQElIKx7F299sAIAQXAhxD39g5fP+15Utri7M1982Nw7mlWT9Mu0GIEdIJeers7P39YGP38PzHlpuNpuUybdznps3Ml8I2o8odRtYiTc+YpJpMGge0QgEAG6blptcAmo3mSy2r0RX/8be+9MIK+Z//wjMA0Gw0txLyyu3De/f3P/q+JxZnSLcdfvGNnW8+jARoM67+cz927aW3dkH0mG4BgE61Rqd38cxc3TEbYXZxnhgaRBmYprWxsX9nL/GI9vzTtQ+sVhbPzHz4mdX5uX6eUBZLKXjaVYYMFIMZAFAc9jQClsuWfWhCtDxDvvD6zv394OycdX7BAoBuO3Tbez0Ah6KKYdy614TztVlP23mQnnO7tXqt++De1bOLVNcJJTztEWpj1E/uxkhmA7LrGipJ8v6+RiETOetLJ/Qt+GG+52cWx4Cxc4Ui+sc69fSR1ukcT4sT1/8q6vqiaz9yGjGlBABMj/4iRiXTjsKzU6YjatGco2UwEO+SS5Fw2zE91zKwBACZBpgj4ZfX9NAkzFsdIxnw1LJNWsrmLKWETvNtYPbZRxuOp7fZOzaMdtIA8AiOeacJaVtwTig7lXKf4sycJDdmki3z3rW84ntxa4di3ugTX4MwF/VKznuQtMECAClSGF7T1L9EKMmTYRTfC993VBhsRC/BWMMiA8/CuwBB2FMT/wsrtdfv7Da7gkBUc+2razObjeCg2QIAIeVcxbm/H2zvHixUzVvrwZWzCcDimLuuMivHWe1FoI9qdkV20WtpxnwxdpqvocN2VUTbe/t+jbkAgBndanVvBt5rdx589ks3/9rPPPPHn19tNpoAsJWQN29vvH1754NXz1dIunUIv/61Ox3JLq3qD/ZCysxezA+6KYBOovjJ5UosUKPTO2z1tjc2Plzjqi+HsnG+rqM7ew9dIf/Qh89//Nxis9EkHR7JQRu/gt8tBhERzPpuuwpCpBkiMlWd/JR4rxv29VXzd24cLHuLnQgI6d14e/OaS88vWwBw2MgAQPT8trcM4Ef+gVU753gmw400SXQNEUpsXSOE8F7gWCzlWdFIObJcNArZ4C0hKQBAG2A2O0J2JrGGtUxkJb6Piv3p13MJ68X8mcdivEyK5Z6c9aMreIeMLE2CjksZPY6WqVemWv/ppY61/ecyvRemAEB5CjqmPFU3mw+kqvOaLT03v050FCRtgFG+w6DTU+7MFIE+Kdl/NM7BNPj9mSYdPwefasio3HaZxidMcj9VeZkkTU+I9dNa7SkyJ/GdGV6e+OiZeBBWhaJdo05QZ+YnqDWr4/wLmufbEKIBsYCULQIVZT0KdM95tzd3lfNTd8i1C4tf+dab1PTiJP25T197uHMAADohVceuVqymH3qu1U601zd3x3/FFj1J+uNYso/ulycElFYk9vebIgr8g+7NbfxvvvrOZ79083/440995rytqn2pXPW7bXFhbW65hraa8te/9jZyav+nn/rgz/3YB8/Mm2dr+pdfvRP1OqHfPlvTKcpA9D7wxEwli5854156anlpuba0XFMG/azjAICqSaBGDgCImutRcz3wY/+g6x90VdtVzChmFBtW0Z9JMwQAHFEpuDquMus/8/TapWVvu+lzzi+embn+5Eo3lVWiAcDFeTJT7y9MpZ572DEwo9crLDg8VAz1bMZ01g6S6bY7ZCloFGOCMRESgUYxkkrvg9ZPttGwpmEtHwNAoyWg99Evj+9or2toknujsJi3zhjbWANGcjpLQcXpbTdOMhXAVB8le/6aUYaMkaYlyGSMWcVUnOKL5On5pcIMTMeqAYgLHBFELEfXGQDoOqs4ZsXSK0Sigs/jAk91EwqdnoqrbYtrtSat2yp9ON/fNnu9jA31lHsEc6aQKsM7TVUCXvBkbJu9YiX3kidzrCGjxPtot42xEdT36LmXoN/jRNO0kuHuMuTHspTwnlvw/WuOURmnAY6L4j2QWrkEJQ/6ZCcW8KCo3HPKc5FUTLxYrRw2OzO1SifCjGIA+PKr715erUepAIAZzwWATrcH4N3Z6VxcrDzYPhAm7Ju1i+woCTI3x+Wwnz5qyCh8R34bAAzXi/w2Kwx/otfCUB0FveRtbFEAy2VUxOmvvxv8p2/fv/e9u7/8i39gWef9ziEAALDz4FBxucPp65sPAOAPv/jEpz75Uavu3n548MqtnafPzaoSLpfn9FnH+cyTrvLuFXy3DFv5+N12uFxDlkmCkHfbIVSYKoSZkSWNb2t8OyNL0O+gHVsA1DkaR/vhB0SJTPPIKgDU6rWtHb8R9T727LndRrfukLmlpWcBfnOreWePq3KSqupA2vap5+Y+T32+HiVZHARL8zMiEzzljjVmgFc4ViZMH+XFO0WiXMsD1jCSivsaQCayTGQAeJBkqYHoq9M87TIT2bGInyLnJ9nHxWjh2Kz50RYcp6rJPsXYYSRhmggA4kSUEOAn0gCguj7q5OT5ObiUkk8og0xJfsVpzTT0ApeorjM6KBU5iKn6QIyRD4QRqpT7lAIMxYT94kc09PnmXTv6PzIPAJQd7+opRCf13BtRDwBqg+rwo+UHTsH3UTvIh7AXAEAAvVLBAHXctIfYzTCdkhSfp7fneZCjEC/uq51Hc2OoDFNk9jhR7ZmGbgaGiUAAulqequq5A7RLKTTFspE6s5I4QIxaMSi+tyFNksRCI2TP+c6D3HMv6XeC9TiJXYtYVjUIWjqzEMKX1hZv3N3+xuv3fuZTz185O393uxFEqW0aABBGye3Npmdb2JUbuwcfed+aUuuIeKLXyh1zBfQ88fHOZifsBe/cO+wFMRdJ3GkjRueqLgDMesyteOdk11uqYWvi8Cl5G/Ie3Ij+49955/Ov3G3d7/z3v/B8kexbCdnY7S/Nq+DwYSN8sNP90JWFH/r4lZXrlwHgr//VP/O3/x///LXbG9fOLl5dNFXrpf7luh8pWZ2/oOOZ3XZY1QF35drCbK3u5uFTEZ8D3g2KAoZ3s5Riw8xLHx9dVMNf+7LON3ZDzvnynMcMPQjCuaWln/nZ6hc+/23Y45fP10TPV86MgrtGIPScj5yvf+thK81ckYnNvRYA1Css4UfkVfDt/6jRItnzfbWjEN8n++A4JijlsvhqpVcuWTTKzDmW9XyyE6IAXTIWTlL6MX/W2AIspaW501/NYLrjzsQZRmHg94bu7jmPmqZlMzKajF8EujpIqCw1dXJ1BKBFYRSGEUWZrjND19IkUdZ8PxFencm5Kr2b97AsEXys+a52io8eTXSOnn3wvfuvv/awuQEAXrsJAG2vtuIsVJfWastLBwfdBecUnnu3HTaNqDZnNPej2lwTYG7UOiezp+uuRyo13mnyuNvviQEQwtDXUNLd6sfMYADBlIhontte9GSSKIZC5S91TlGzn5byPU4AkXw/53uPD4ZcXAVo5iJdlx2dIT+WrGBuxFHbZQgMD6CdO+8JBMBjAKBWpqd6kiSY6BgTDsbgS7aAB0XNzsHI+Z7rdy6Q4GDrwtZdRfxe2Lu0OssIuru5v9vopgkHgDMLdQDohWGrm11fW9s9bHc7AbZoFksxexlHTegBtquyMBjvbr+bRem3X19P4kDGqVpt1EnDJBYB51WbVai55+qIHfRmrZpIr55dloJnHPBIGXxVg0yDdhaT//jy/d/5+lsP9pKf/6El1e1PAd3xjvT/BQ9nlvfGW3cNjK5dvVKfOb9541ar8/DwIPrxD1/94fetLM9VvcMHoWcAQEJqOm/W5owapkX7BQDWFmZNdscHqM0Z3lIt44AZkYJrlCJcgcOtIBxcG8QRcSp6TVrtxwz4wJ/JKFUrm9Ti2Fq95nTiziFnwYHnztqa4RF7YcH+uT/+yX/3+W8dttszngftNrZdpfQRJma7W12crTVTx7HubjU9mxFKkgngGhXsQ49iBEKOPVNDAiM0qvSVzO9bPTniBbz3bUqTjdxqGC3XPrbcwqjXf8IRompTQmeDqFOtDr0ZVQNy7Nql0eHqqDx9ItQyV6ZjABGFUtWDNKWWJFkqtTBMoiAZ95paru6L/cRVTfyh6PQ4c2bYljn4nmRe697bN2+/3NzdrB/uAoCqJ4I2720B3JhZqC2sAACkc4vzp/7ackH0GLeZ1TUA4KGv5HaJs0XEFw308Wa630+PyR/VKU3SlGdRfvAof2YE9yfckiimMh0On9KiLVM+H1V02Smm0PR/KTITdHQ9eSZuhwIQtYkjRZolRpK08luXQAQcRg0ZQjS1X1LxCGE18W+HAkB0QuFZepzEy3PuF79zX8tSqhPE4dJS5eV3dlKRnV+eA4D9dni3PXR/i5jvJ80gCJs9lKTvbu4026G4vdHoRqouik4o4ynvJjogiLNg1+fghuBD1A2/edC7HFnLmFZX5yANlU4vFg1WkdV7u72vvd7Y2Gnd2UuWPfKh911SxVHU6qRuJ1ApjwDgVKy399pPXTxbx2J3Y/NbX/y1bjt0PPPimZlmN3riicVeu0/wZUxBdnnNJB0O/TYdRIU9l3UeekYYZwBge1WECXBe9KCGgdTFzryIIO0GuldR6T1p3uSI0qLKrRt2lxw4ntmIetI439vag+V5ZsKz11fvfuXNGQ8OG1mV+NRz3bmaiDkA1B3Si1PP0rvdQMVUS+tjcqdlPNAHq5TzRctqrUMppiEkjJX8Q758AfEYk3Rqid3p/klpVe14VI1biz9F7Jcq6oytujNkgFgWptyz5wZNbqcl5k/5cxizSk2dmI6NREZh1AZoh6Fq/VEku8qF94FUGSj3JkoyNXDkb2O0LzkcFck5QnxR3ZPP/ZvPeQuiubu53twEgDoQALi67L651Vfl9cNdONwFgODq+4bkdjRetqtefY5n5li3vWrxhN0uXXBS8kiVDEilNgtAKrXmQbd9ABD6YA/Ia5dXHpV65pV6aJRYr5heIFQGAAICAIgLk26WlsOSpSfmBE+RqeR58dE8MWYU6MpS92PpMgSyc2Syo4oqKOYypMiuflSOjWfidl4RLOBF7h8J9iLZIQKwlHInEHEwchVfMaAtaS/BBGO1lnXvoKVqQiU8+dDVpUYPvndvHwAOW+3zy3Oci4f7LUOn72y1slhqDKFKLXpw6/bO3mGgHbRjNU7sH/p7nXberAAAok5k6JqqhlphIgrjlsYqVXNeSwCAtnp79/qVhOuepeqOKabvhPxbX1//7W+++dVX7wUht0wCAGdmdOWiKDMQADrC7DQlCuOl5Vq3E7x8c/uTL15dNjMF07ph20tLti0TglTjtNBzlgf+Hunwmzu+apm9rPP8oVCkAFCZ11dNXQqO2dHXJwU/ku0AQByNgOZYWZqKKNQoRZhQrV/jh2oSAMQgYUbdKXXDbkS9IAhX52rCb8fgLWP6WhSpNkzG8nKtXsOMtB7up21/draS8IRzXq/YjU7PqLkl6V2U5GWrXUhcWAffLzQkJCGEFxKup0h+fDSeFRJvMiEEVzb79KBrkae5L59k8iRFDiaVPyu+WmnR7JTJwVjHv1+EJ/9jB+tmFe5HwwOjiDeYTvXUtanfA2W7qwycWYcEvThI4kjI1rga8UeIQFlpcpAWfvvYIvgTP+0MNr779iYAPMzaq5r3qsYBALb8sdQ+uPf2LACZXTv2m6gb4xvLKbKfJCVm2Hl38wx3NSqkYSTTuGSm5yHWfvjUpqMmzNHXMGy2qJEgiWLFYrfinTBzJoh9UaiT78cSoAcALgv8vgYPio656sihy8N2YgCAKt2uAqrKZy8Y6+0i4pPhbh7DfLeSOHCwjHQ9SRJ3uAdLn+wK8cTiPCNEUz0YCR8yrFRNG+XJVEzcAQsAthq9mm2fXXAB4KCbAsBM1QOAB3uNy6tzSda9txsl7Y65vMY7zW+/eufmQZAXSNhqtJNYgE6VGGkGYknzFx1WoWalQpyK5Xgmbe2n1bm6Yc+FRzZI2vb32n6z0bz4whUAeHPj8PAg+sJLN19+9a07e4llEhXeHLorWvsAmt+NwTQrOFx8annrkP/uGzuXztVXzfjitScd1DXb3dBzlmW3DXbNll6352G6JdKiAwNALp6ZUUzPBUhzP/Ib6fPP1WmFiiAdzkY5+tEyU8wc5a1rlI6tEJlmSCsk0qg7pW7YXrcHpt5BgmztAUA3lQDRh1+8fP6Zy62H+62H+81Gk3rujJUBwG6jO1tzDaZ3g1gFVBWpFaaLCr0k2PMfi3wfrFgelB4a7A8pfYly6AvBFeWVX59nT/ajuIUsndyO1zUElPCUW4wqBOcp+SUuF1V8cX/SQp5jl1aNFsIsTgJKgC7BelLzqVHH/yhPgZFDYqv1rirxJspUmg0xCIWBYHd1VCocXyHCMwt3twaMoGI5nTSDSbUT+l5QyXy/sHpFafZVrT/5fZi1QfPen5VHts7mPQAAw108pehWAdX9uAIAC04HJue5S2wCABLhmK4dg4arzYNu3GlGhdrleSbMsZUGyu2WivS3aSxSfVB+QDeYZlB9nPdSzqhJgRRyPDCLFOsx0wBAj4vuShsAYgCAdgyQRm0ASENghp4hUxuIeiXMoZ8EqauTh57LCRsOyfb5DgGNU0oJM9xS4iMz9Hhg0RBSyMwZlz/DdAoJcJFs7LbrNl2u2/MXF/ea/jsbh//9n/7QW3e3Xrr58GC/axksTIQfpWGE3uzS9xv6yy+9/M239wEgQmKv6VdtBgDnlvrB9K5AM7XlSy4oRdzcjxpRb+fBod9ND995t3A7Ia++tFxD52tpa6O9291/veNFGas75ks37ra2Y8uhVR1aSb9N0kGXbyVkWecewCFKwWF+t7X41PL1Cru1HnzofO3HPvM0AHQlNPejJpDldrcJEIrUbHcV0fNvT+XArAyqRR4h22Ww4wPA+y+fUXHRYiV0USj1g+0aIJpXCiuWyUSYQAZphqgmp9jUFYkD4M1G80Gv+6HFOTUzcOdqG+/cTdv+uWcuvdvq9mfuqSCUdLtBni2jWKz+RwhjPPR7CCEAIKVAqP/u1WwiL0FRwjrGCCGccx8DCDGk33O+Y4IAiBCcEgQg+8MAJkKk2uCOU5RXPB1rwow9qGobFI9PMnCgUAih+KzSztgRYux+sbCl0s4iTZhlHWvUMIJUymOcCMPQFOIV33MrxrB04OlwpoDErompxqgEGamYamnZVxHoJUVfFPK5P0PqM+fP1VYU39WmKP+qxifxfaFmgXEivttetTfImcnSEAAOtRoAVI1pZJ/I96nbyRvv5X05Rsv8hpAWV6gW3fw89Fq0eoo/DsK8FIqPM2BpCgBxGCjKKxmuy47LWM59bXgdU54hU0yVaYeCYB0AeOFjUfV7AVF90H3JY1RK0QtiFerCGs5DpuWppZLwRb4r+gPECURxBgBrizPqkcvnll69vTM/V+U8a3S+ZTDdZqThB1KiVpT6nTaKkq/93lsREobEF6rk6sUnVe/pvKHdTrO5v7398r30y5s7G1tvP9jthXGmCnL5w7NUV7QAwK3TP/Dha298+8693fWqDpfXXM80W9AJQq7ccOHQqg572/GNzfZcPUN1piEKncB1WLcdbhn2i0/OAcw191VQYSjZqy/hhwd7XiEAEHRGWq4blgrVXr28VDY6Yp6PBO5crV8grCDMESbpcF/pNEMwspq3NmeoumNYUot3v9aJ2yGo7noAgBmp1Wt7bV+tlgrD/t9iUNwFyESGSR/oOZqlFCUTJo+sKL4rsqunlIaB/Fn5Oeop+WnqlUtOPcakP07kOTmYKOMLALKRzMhRxV0qZTPp+CSpPrpWtjgSnLC85XirRBsTPh21+HNnxtA116ZRO82z5g1Nlq6qlFAXyl2fdKJLRJGMVL3+IsRLOr00nyia77nzTpaunIfvneLvXI+Cue1dcE+U663InleF1KgJ/eV8E+2OItOP9vNWHlM3wRNM9JPod4X10sLUWKSaQfOoaSlkemwEtUz5QZsOx3WSKAawAIIEVZjBNUQBZgDAG+gA1f40y7KSITMkzyHpJUpcY1UZGAD6lXtlmsTpYISTQsgk6fXvLpIPEkmO7z7Zlf/OC2P4gPJMN0Qm7IGzzHRqMv3HPnjp3v3dvaYPABqSYRInSUYpBoD7+/zLr7z9YGvzzPLKi0/OffD9F1X5F8X0e1v+W+vNV9/ZvHl/5/AwBICqDmdm9DNLJLtWmcMcAPYFafi9w73O+hb3MXKF9Bvpy6++tbcdY4CWQ/f9FCB16zRPsfIbacuhAUZfeH1He8J8+iw9J7vrFSfz291O8GZnQ9k+RYewaKOPyhMVSi1tirnfuvnw3DJ58cpSFkuN9OvniJj7+838NMyIinkqxGcc1JkUEzUMZCNMV11EVHSqg4QHkOkWxOnOg1vXZ50q0VSSjBTcclk/231w9zq5yUsQIURKoVisFDoAEDKk03NeI9RfljyJ+PmRIuJlYb6Ry/wS34tOTskLGkQOs0ziKUZK/pDKsDwqaAzZaYlcGglG4V7y7kt10PhIYkypxn0pmafId8fQO8RmelwKq/qDxKYoSFwdpYRCkgBAJCQiqEIkRVlxBdOUjuTpCT4PIplXWxhS7sVNWfBFCV8/3N03rLnT2zJ9RGYCH9dpWzFdifcx5jt0NWoaAOGg8AA+ZZF3GG6tV9LvCsqnrfVYNG1KUVz1f4+TBBEVbh1zITI8COEAlaGm1Yho5fa6pmm9MGIGMKN/zryRa3zcS7DIhJQiSVLXAp1Znol7CesbLEq0kjHTyaNcyZHjSvLzlDOdxklqmiyMk6rntNrdKE4wQmkqQEpASEMSAN66txNudtdq9o99/MzTV68CQOS3bz/Y3I3rmzsHr93Zeev+AQBcO7t49UPm8gy5eGZGGdlqiVC3EyxVLADX+fD5bjt8/YGvWiCFcabK7QYhj4Lkj5x3lp/wAPqS9t5W8Ku3W+tdefdh48b8+fVv7L74oSfOtfbbDoZuGkja7QTdTlC/ZBfJDgBbIu2nxxy3WS7Tvcqb9zfXv9H++M9cVSutCADCREShf9AtnqZKx8Agn320dYmWpkW+9xMi5wyVcdDLoJamGaWq3NiyaxrLy3mSjHKNeju3mwfObNX1bMZTnmmIUIIxwhqGQTHdPDkxjFJzZMFdznqs4WIaY2kMGD2YjxOjlM/JPno8R7yGBIAGw7XJjj4ZJEpHVKkcxfdj8+jHbmpgGDL9h90bfeD+T3Lw8/htSbOPhgFKZr1tUkblaP61hUQgMQyKCSt/JgoSVfiXWE4pRz4qlFqbnr0ztuEUQe65a5deyLNlStv7M/KqxkuIX48C2N62vaplmZN+WSPq1cAYTq8yc4/SBzqqm4o0L2N9ZIuSZLqEPyHiS3zPorRE50feSq9DZZjJoBgOHT8BlKGS8MUzC4p+cGQwQjADgBDgAQDuYT1OYoJ1ajrVoc+PFW0f9VxGwpiTgQV/5MzwwbdmW4xQ0vR7y/N1YlgHu3sAsLFz+NSFZUpwyoWmIQAgmFAiv/HaLXze+vSnX3z66pOq9/T9fQ4Atx++/ebDTt3UfvYTly+5cG3RBYBmo3njweHWIc8T3gEgafsAAA/8Wcd55ow790NLv/Llbb+RunUKAMse+T8/MzdT12Y8r/7sBc+pa2n61H6z/tobf+tfbmw2ood7bQBj/3ff+slz9dknzGod9rNKzvQ+7LyhlRpbgy+9RHnVIkNNMZWf/vmvPXhooR/55DODdBeStDtRcz3rCFLBRu2cIrvKjMwRryg/hHiZaikovqvf4s46sNv0ur10fhZFrYz2x6Gf/fg19ahGIEtTEaeBH1suC/yljd17d/Z61y4uGBRHqdA1NMplrOFuEI0SXB0p7pceLb7UQOCL0kNFxBfPL3k7JZ9HiCEWYCRBokxkCrWjOTZC9nOZisumlMsvJMpENlTBeNwAUBT+k/A91ghSb4lQkkt4lTMzmpAzKXWHasCYFZqBDONh+U+g4MPkPZ4AQDMNmxIAqdz2vKdrDvTpUn0s+gkA1J75sY8BwO/9h0n6PVfxiu/1w931mYVzAFPgPmXLMgFTF/mP0eylV0jDk/jvJ0H8KN9zIj+aeM/dmPI0CpkJmrjoLomFEu8pMpNYFC3KYhO+o4OlWmPEYoRz0LhIlMNuDkofhXFSHAzyh8IYGAnVQ5oMgegxJzCcPHNpdXZj5/DS2eWDRlNkwjKMXphSSp9Ynblxb1dDGiUaCEGJ9uZu/KErC27F+/Irb7+10f7t7+02/fDivH15xflzH6mp0ruKp3ceHL5y+7CV6J1u+OCwPZixWraB6hZmmthotW5tx3XX/tH3e7/1als58j96ztryw4vz7sUPPqvqQSJ3dqY+++m52mH3S7/47zdeub37w8+eSWGmrWfwbli7egGi3pzWeXLt8pGvPYz1sco9L9ubUQppqnvmm/e3fu+37370w0vPX15Si29bD/ezxkMA0OqrhstUMvtR3YVCFypF9pz7Ik4BUkQ9KFQDnq+Z7YytSgHMVd96RimvkNlKTa3kygO2gR+7s06HU0/P6o651/RV5ok5UOsK3FjDQZwkmaw7pshEkeZj7hQNF8V+6eDoCqX8ody3yV9/krzOlT5PeQTE1jWMASECnMOgTPGo6M7XyhZkuKZwj5EEJDAmGKCYXD8W8aMlEyYp+lIwID9uMRqoqmEEEUIMKTqhGHXei2kzmOpUL6ND2e65eC8H0kn/D0EyksiQyJrOGYMNJWiORX//nVXPP/n0wYfXv/Hvpr9iMcraEsQOwpPzPUvDXLxnxy1rOzaUKtM4iHtjFy4V8XpCDZ6vdFWpkDo9moYdW21mungvDRgThwSGi/tJXBbsis6aDPOdMd8l0QjWgbAS2RXQw5HYusJ6/pqMhDEMJVHaFltbnIml1gt7CQespYSSL7/67v/ljzz/X/6TLwgpNcCAIehGAYBemblx5/Br31u/ub53adn7Cz/zzEdmyc0dHyfbzQar1Ws3d/wvvLGx0RB7fvpwfydOs9WFmbvbh3UTG3qwe5i+k8k5T68QiagF0LtSteaXor3tGDDqCdlKkrmPPEsrVOXUA4DkbVqhf/pPfDqQX/5vfvXOa7d2Pnj97I1WfL2a+bsH52R3YW11rCRf9stH8sBp0UJRHvq/+vVvP+DxP/gzH5e8nbQ7gR9njYekgjOy5M7VignvxSBqqcugkvOi8MoppWq/xlyIfRFx5HpF9z8ZrHVQWG82misrjojT6yve77y1d/vhgWczVT1mFN86AYuZo2hWJtskxB97sPiCyrUvzQPUOSM7Q04OABCsi0xgjDCAQKiYZNlPvZcgJIIs1VCeWV8O3vYVK0EAICSU6iWMyvYi06f7PGOTc3jKQdfVX61rWfGcsauZmAYasXMZa0gRDWY5FhLF0gDKcEfUyj2ZPJo6GinNj+RkHz2hDHfknjv7Avxwt/HKWzeK7ZsnufDQ3DxXgxVwTiRmeTNMFszTl9ualDAT9vxuu2XjqNdt3Xlw2G0fn1RTXJJ+kq0+KBrFSeVUT2QTSiEWEmBOnNUTJX2vfEhQj05HEg4GQN+cAR6EMVV8NwulS83hMqa5fi+yPjeE00LuNo8C27S3NnZma+5M1e7ttgHgo1eXf+d7G0zXW93wyXPLf/HTVzZ22//d/+erF+aN//rPfvjTzyxrabrxzt03b299YtVN2/4/e7359XuNdhhGMfhREkXxH/7YtU995Jm/+Y9+FaixPGfoRF/fbl5cmn/+8tzN9cOHe20jhlmH3MEJAHzlTvhnPzA7W6llscR2tfT3/8Wf/pDfjX/pazvfubX50etnvn3gX5fBzKqnUhuPJPmA3a5hHe/YEkgz9C++vvG1272/+Zd//GzVatzZ0/i2BgD1VXuupoaZieqkwHe1r4r9ijgVUaARSxn3kqgphduM/VqaKtmu8naCTqzGHsxo8/7O4MvoXrlcs79C1P2ciazujLmwVVZV7pLnnB1L9v5APljfoGZ+vQTnRybhfvqQUHwUIazr4EAKkGE84hQV1kz1E+2RFIIr1yXjsphEn7vwJXYXeT1K8PzkKQ7+KK8JJUkmecpVVLPdA5JkCvfFRUyjrVkBIM4g470jghf9q8llcxiz1EI/Vcxd8Xm0WFgvTNWMQVWInFQH+OjXIPfc1U/+dH3m/Ltvfv21vbdgQjbkkavupz2jdULlrhyS3E7JJfwjbCJOG7u7NVsuV+y2Fn/3Gzub2x1UXDEYjxlI0YjCorj/iaQC5UdMZgCAY+AOQDdSl+AmAIRxlGknes82lQCgMQMA/HGBAVfX1UNq59itPRyY8zKeH/Ey3hEmADju0Uv1ABDzAdGaV61Xx1fvCeMkp79S9Ll+L24P9lqe1X/ltcWZRjc8bPXWFrx/+bs3LMsCgCzjf/NnPzhTtf/jN+6+/vbDX/iDF3/x09csl7W7DdLh33zQOuNm1HP/wVfvvfROCwDOn1n6qRcv/PPf/HZk6Pf3g1/8B7/aDQX0umdrulqWb+janGdcXTTnHXhwGJw/O/fm7XUfo7f2erfChVGs59t/+cc+DPCNv/OFhyK598HrZx9G/CsP/Z89P3keSenAQC9dXRxkqlGadoOXW+bnXn74J3/i2Z96ymy8/l0A0AYOu8bQJLIX64UNdaQClSKZYkZVaZr8eIZQDdyiKV+RGFysyA6Ihp5jtvvB25puLM96MZeOQ8aK8SI6pRQKZUXfpnSyktWqcwsUCkGXyD76xJKlU3zx/GBuzSOEGcNjE2+EmDhGlgOtWQqAj1Xf02Ow+aOTkiNLRShhsJRJ/Us1iTArdnxV2Yoxl8U1TWnynro9JymRCGBywQb1u4pYH62SNgQO5J5b+ui5pSvnn3jn3p2dN5q7m69OcOEfZu1VDgDeKd5v2gbqTSG70ukSm7nhPla2Z5kIYn9lbo7NzfU6vW4kdAsDyJzRiJ2ojnF+/tCROCrp2cGZCER0IodHXTFxBABCoOJIo95YqxeqEah1svepXiH/o1qFh1oAKmmy0zkarjLNFGnU0By5FBCyWnHsUUOm6NgMdDpRFryKsqr+HgbFFcdSKj6IEyUSKyZ+6uzsv//aWx+7fvbnPn3ttTs7/8s/+7LNyN/8qet/+cfPBCEEfkwAbu74nf2G88TKP//O1kvvtETCL6zW//OfevHcqqmsG5SF188v37q/tTpXrVh00Ybr71tZrqHocHd5xlyecX/oyiIAfPXVTb/NMUK1QYKBqjeJoiQvIqa+mb/44++3qfxffnf3N19+94efPZPY8Pnv3fuZjz2p8tADP1aCXVEVg0wzpJYUFYxLRAhgy9rbb3xzHX32q996cZn93Av17v07ymFXgr3PCIYAIPeIctYXyQ7D9WeUMzPo1kQK0TAp+mXFQEQBoh42LNV/1d9vunO1+ZpJcD+BWMSpbdLbDw5mqnaSye1GZ6leyVV5EeInyTGZlA5fVPSjoB91Y6ZY86Xg7Wj4VxXY4iIpPqSSO2HQcGKwdJbChJW3ysZRoVrl0hStnuKLAIBaFqDJoRlATnyL0VEhr5Yv5YI9X42lM6qOGCkHYCJNQKdKyEcayMHVZRkkiPhY2Z43Wc3Fe27slNowTUmPAQA2iM2qnZhLIv11VOqbOvvs0uyzi/5zrXtvP32w2+s2mmk3T6d5mLVhsNCpJcgcPLYtX7507JlEe/zFyCYRf1qEGsvxI0SByMWRRsFXnZAfH51ATDpz0i/NX6F/BacRANDE74qZE9Z5Y4THURKDxQhnhMecmGbfjC52cdpr+oSSe9udBZf+4n/2Yt0x/+mvf/t764fPnpvZ68kbu93NzS4A1Oq1ZqO5sdsCgNtvbX3u9RYAzMyYP/2Jp69enHXrS//NL9i/+D/9a5FmmIbvvzD3xKJ59eLKlSVqtrt5zV57aam3vQ0AZ2b0rTbXUL9dxhCYeLtYUwwA/sJPf+T69YO/9f/+xue+uf6xp6oA4Lxx/8PPrFYkDvxYRAFyvWLmkZam6UDCY7uKASK//fWX7vzaG4237h/8yAr6Lz621N3c1eqr7lxNr8+qQmZQqGWmDVYklBA/VtEXM3DGKMqRWheYEXeu5u83veX5NjSCjipvQKkGM3VPKTVb17YbHc/Sc3paRn530JIVM0iNHVgHSaqWJhGsq4dUuaHhm40BgE2GroQJJkD5uQREfkS9jfwXlWJFAMA5fS93bhBFUoIQ/fWxhJDRUYfgoTlHeZ5BsZTCRFjVb6CDMUM1MwAAW9eIZalHS0OUCcC5BgBCsoEV3jFMli83U2QvjmdxIlTCTK4Zi5V+VUlIgx1F66I4ibl0dDSoLUwmCfa+Ee0Q8uaXfs126gDgzS7UnvmxooqvPXOuBiD9dSTC9Ve/Xb1zEwDOpZ08qaaVdoLAOW3OzJRcl+Ii1eL+o21FRB572ljQT3rohL9OxryI5invRP2u/ISxZ44dS4rvsOgvuYAcLCmlmqaNxldL5nunmyorXzkz1YqhM9xs9fJ7j/NsrubWXPuw5Xs2u/rkxW98583/9V99vRnyK8sVw7I37t7Xshg+fWa3uw8ANzoxAKxH9J2tFgCIhF9cWgEAndUwo9Wltb/25z71f/z6Vy4uz117Yv5cTQL0awMcmUvb22pnZbHu3u6ZmrZcG8zMomRsjyflUL94fenX/uZn/v5v3/zcF9c37vjvbLVurQcvPjn3wqVZzCg1j7gseTvTCGX9I+8eRnfXG7fXt/7Nb317ztT+1kfmr6zVMrJUu1YjldkS049uE+LlxFeIn8T3vGvH2BV8qhrwYIaRZpRCBCLmen3WBWh2G55T73X2AODOy2+mGdk59J8+PxenQkg4M18dkJeWuyoSDaYuK1EOCdMpIRqlNE21SdPJoaoV47ehaDznWb/sKNE4z5hO4+ToF42zAd9Tx0rLMOIkBUhA9Mk+OoqoAWb0ocJtgdWghDVMMIhMEAAFd11DTGf5o6MOFdaPwhtBnPCUR2GsNPso3BXZj+KrGMs0QJICWFGS9QNpGgCwfBpB0yQGwFS3GC0Gh9XUQcNaNrw0TMMa+d03flf9cK628gE/WvroHylflO45APBm7xsoXKhZu83gWmP55u7WenOz4aewcCph3HdmTpIk8whY9wdTGEcIxMgJZfh05k6h/6TXKVoxiu8lyhdhrbCe/4pJA5I6nv8/6Y2pX1R8ep57MylnRh3pJdjOs7OzrNmKAMA0WRjG+Y1NiLa6NEsM6x//y999+eZmzSQA8NHrZ6iuX5y3f/fGzjcftF48M/fNB33rKOy0m81IJLDkahA1br4ZB2HPMu04iZ+soj/7kQu1OUNlQZjtbnPYIVQlHq9X2AUPA0DNJGsLs7lUzxsz9cGKqGpLLeJUxKk76/zf/8IPfebpu//6c9/6rTvd76y/9Z++9e4zV2avnpm/vuLZS0v5UaBunwABAABJREFUkundFj9o9R7cf3V9u7G50zjo8tUK/mvvm//IczPOygJ25vX67IkmncSTvK2wPonvGkMiOIobqWqRJWcGM2K5DGRKNSIMCwAiv23UZ2Hbb3cbfqP5e69t1D7xidvf/qrNGNYwgLCY3ukGMzVPuWc52eMk7YvxYdwP60fKw5I7NzyfG6ldmhc1ivmJm7jxgKgSF7qhXiEDOhrgUa+cF1kqnpCeoH5ffxhLACExluzF+IT6cPKPqBS3KLHboDgqhGRHJwSl2IPIRDeIExFMInvRjAJVMCqRABCniOU6PckcA6I4ydPtldVDKCkGhycFFcqe+3pzE773mx9zjaJ+z7farCMzSxi12aUarlmPluH+fd1kzAHjM3NVp2Kd6omq8HdmeVrQPukoMoiWDH3P+fIEemSPTAkDjNXpk0aaktujdpLCiyusT4k3qMTKsXynlMZJx9aFGnrHCnwAMF3vYHfv7/1vn9tsRDWTNEO+Ujc63VB1Urzkpl9+c+fFM9W1hdmN3YOtptzo9j+Q9y0ZMxXmOtjhbUdL6lW7NmeY7W4IYHtVr9vb8pzlgiejtrphr11Zcx60AGDZI7U5I4ulBkdWTK6aNdIvM543qk7anRevL11b/NSn13defvXOKxvhS9/Yfukb20dh7ToFAFXZBgDOLZMPLpsf/8DCU889XV2dw3a1PzmIkpOQfehznqDc81qSk5yZPKtSxCk2TAAQUUCJJXqt+bn6nZffcZ685NHKx9+/0o7O/taX92yLNbphzaVxAlt7jbmaO6j3CftNv+baudaewneVV3Py7RRMz9kOBin0EsjQ+LTgIs2Lib+aDE/YDZQQLU5gEtknsX5SemhObZ2IbKpMLPo8avnYYavXOWzJMJqwBnzMFgUJogmj0mB98d6Nkr6VTwlP+ZSUx0msH/rd681N+L3/8IeXl2D22Wl/jFFbWIJrwTHKurkfTerU8V6yZQbjaTkPBDGysrL25OUlVa13JPp8oklfHAaqqtcQysfdrvHU274dTkzkT+KgMCBNfFda0M4sL9/Pj3eEKWmqpRQAkGhnhqVFQasddFJUwdId+fqLVWvUeqhBEuRQCrwQvJew6sjXYposTVNK6d3N/Tvfuf2bL912hVSaHQBsxxR+48Fh/6UO9zpfvLl19dLa2sJst7NxZbn6vWDv45fMpy4uqxov6npYxpRXSKXqBH7MtVgpdxgsJVWNreuG/cKlWcyIMbMA8OaMIZ+oOlJwAJrr97zlHsIEOIAc+jD9g26z0fz4ucXrFfZn2v7ddvv+QbJxGM5UrMNOAABVU6tY7OysfsHz5s+veUs1UplVTJcD/+dUl6Sy3SchPktTjdJ8HJroHftxnn2/eX9n7coF4ByA1Oq1dhA+tcL+v//TL//Q9cqDRZfzrO6YQRRVHCuIE0W3TjfY3Gs5gyaulFKlfAe+dnZyyyVDJiN9vJaYPlbUj75mf7AZ7ihwzGc4bNeM/urROcQJhxzF8Zz7OdCnpIeWwrBTVoSph0QmukG03eh2/UMZRlNke2lT5X9lGjQCpw6BMYip9mLOSN+J7zdjKn5BItOwxiiOUzEhCjK8rTc3b379d69+0itFWZsH3eqgljrvNGF4eWowAP2ooj8MNFWBeoztrvpfj3Pej/dkIl9VJC9uFZK6Fa++sPDIQ8agxfbi6OrWUgkaOFkzpuIaqN6ES1DxtySxx5onALA0vIJJXdZ3NzY7794tGT5dP1GmSjHDXRWOLyE+TVPQJoodSqnJ9MNW719+8a2aSZ5/8YnFGef/+Wvf6Y+pJjNZ//J9Yzf5SDdef/dOZXXRqVjQ9j91pX51iboLs9cWXV4hlTynbYA+f31/2Lfzwaz1yW5YOS6XHYwNK+OABtkpOUOVDVKEplqsXyzRvm/WvHb77KyuUH7u6hIA0Op8bqYXmQ6Dpt55Ws4JnRkYbvFaWsek5YsIBibSFL4jF1FG0rbv7ze9pZqIwurqXPP1W+9299+35gDAS999N3NaV9fqszWXUsoofu3WJiPIYPpszWUUN/0eAOgEbNNWI3SJ7CU5Tykd636oTKoSVTNkTrHIFXZjTkpjhipUN4njY/X72MV6+ZU/eCd9v35KyLdI8Ek0H+V+/2KQKMkyHTLM9EkCX2QiiJNuELd78e7BQdDoAAytMVXZMrkVUzLfVSs+P0gM6O6nVsUKGZWMWWmS9DQAVWly5LcrqT6J7DB2vnP34TvL996uPXNuVLCrs0mlJqPme1TeU3qovpcgal9v2q5EZqkJmuCAZAgAcviSypstYMIBQCgEj9x+Y+YaJ1velGZ9zTIzyVBK4ykjzZgrdVDSMv+R8+xg79AJW7Sw0lXStNPt5vJ86LIYID6/sWuuXYqyFgeVME6eu7xybfHmVpt/59amMsEBIEpSjXgAvURnN9bbfsTvx7C07HXb4VZTAsClp5bdgWAHgLbpAkBdClVMUfFXZdf034nnLgNfObuoFhwh4u3tNgDg6ctLtELTdqCu2DyGqUCvMZTFBNKjZfqqkVPfUazXVlwWLLo3d/wbN25t3N96ut1eXFtdIQ6pQJHgxabeRx+joZ+Q72pKkb+3vLBM3rJDO7GloaUpMNLAEdzb8JZqamBYu3Lhnd9+KAHuN7I3tpNI233pzYcz1crz52fOLrgXlmszNa/4RYdxEoZx0+8dtvyZqnskpVW0k2cwnD+jZP5Y5o6zxckkFz7fUVlYaiEeB4MQTRnuowvoJnqJyFRFkNRcIX8D+Tik6M9I/5cW/5zi6FV020+i7kun6RqaZHCLTLSDhKe83YtbftDphsHhAQB4hhZE3DrOllFpMwrxFhJBkBgWtNuBa9M4RcU6YgbTT4vBMb97vbn59MFubYzRTGsAoLuQ+MKoAewGI+UHguleDfWOjak+8pZHFxFlEpl0eJDEjGpxmmUmAGgaVuZs3/ocPpOcoGBBlglNw+r/4609MGBQcUHw8WeMHWxGBxg1TpCRr9A0D+cwF4yUVmkLweMkJUQzma6APn4sHLd4tRSDrTj28++/cvM3vqcKo6tGGfvtMJXaj/3wB3jKW/7r72x1Wr1YhTE6Kcw6Tn/x8D4sL1IA8EJf5W7nNC8uIlX7xaWkotda324AwNVLa1MimYrvUlBVY8tyWbMxmPDO1VQVAdewXpyrXVt0/+3Xbr5x3wd4uLPx8KnnYpXjOHSpPKpwKYZVVSnHYiemEuiPmUFGgUYsADhstxcfvGnUzmFGNUoveN4rb21/pZ096Ii5usUzUbWNr769D2/vXz87c3W1cml11rZYxbHzLCkVFd9udOqOaQ/aeuSaOsefwiWl/VCn+t7VomUF0BzZU6ySPIIKxKKUguSq89ekaeg0SZSmarBRfB+r5Utda3Kaq53S781jp1P0e/5oke+qPuUUpgdRJwnCKIzDXpwr8Sjrt2Hqg3FgzuR5MkrFF9NmMCUugGriEbXTlKQA4NpBh9gVx6y6sm/RUPzocAeAh82Ns8X899ZbcaepURMm1BuwLHMK1lti0KqoQPZH66F67KbyQouaXSE4D2EVcTwl6fgYYaXh0kud8ClA+qOC4IDJGNZjAlNy12ihg2uaBVSz1I7JdNARHV5xp0WBugqPzVCepNmL0dcwTj769Nlv3th4d7vtEW0jETWThCHfaSc85Y7FfuLDV+CV+92k/+aX654q+ti39RpNaIA/zHFeIdDhvEJW3EUA6CBRkbhY4GU/kd97dw+gX06y2ARjNJ6JcCsX7/mYoZCKGVFFuCyX/ezHr/3rL37nsJFdPl/75mtvKMNdBVHHJlk+gvPeN9wH/ZhyIT80hA+3c4LC0tZmowlQq3oVoS81G3d5R6w/uA0As552616z5zqNlmabwX7DBw29dncvy7JMys291jfeMn/i/auqIaLjWBdW5tQ3aJrszHx1v+nncM+dk6Js12QIkmfIHKldoQNAFifZ4MrMiT8qsQGgT/a+x5IOzxVI7k4Vs2LyKy3foYXayEe1j1KFrHS62z7dnylSvmTXFFNoirYMwFEHktx+yZkOALKfz16OeJ3EcC8JeUOTMkk7GaYFyme81+naus5mK0YUJyqmMmU+MQ3uzd3N1sCZkf662HkX0jZQs9/rrvQHnKB8WCxSBwj8QDZjZFl/LrRzpk/h+yMT/xSIh/FknyjtC3Jeo1TtK7IXYjJ6LwomXdBhnNjmxJVfxeDqqGYv3v9/9Wc/ut3oAMDGbvuzX7oJAA/u79xfda9dWLy0OvvnqvbNO7trC7OwABu7B5UaAgDa2l9eY6NlXlQBACnbarLRQaKmG4qGKukbM/L2Wzuv3A/+yNOut1SLQ9CGg5ajVC0uIm42mmuXzxwI7HU71LEUW7FhWQCfef+Ff/s7b8zUtStrq2nbf+u1N640at7lJ/WZpUdmetEsGnpXYwU7ojBcqKC4qc9KWfZbfqiwDgC7W+0tP3ypK7/2VrBaN9vdQAMEoFGiYQ0zShBCX7q5+2yY/cgzyxoSL99cn6naS/WKaTJK6fJ8veiqj/rmOWdL9l0/eG4aw9Gg8uUx+oKTEl3yacFYLT82oas0fii3PU3TPLRbjPFOz/6cniEzSdSnXKY88ru9Vi/NwnYzkTIOFNMtg6ismCgQj4USSKeVJI2JrqQ95Wku5KOAGlZ9Nkxtkxqs3z/EGKflMzGhdMx6c/MDfqTIjvyHhdifX+K7EuxBcGKXfCDep3jux1giU+v9JlEsOCEMj/K9aMiUaA7DnTC/r9s0fwaOITsMki5KBzVNcypWFkdhPK1Ggs5wKXh7rIovVSkwTXZhZS5N0wsrc08sVX/p17612Yje3e6cXaxZTF+qV7rdYPn61VU99n9jvYmcmux6KkxarxX9lnzNTv5uasxVHOQDtYvt6ldf/ToAvHBpPktT0ClmJPdhSgmIfXOG9gdmd662d2/jmze2Lz9zHni3GMejjlWr11Ztdm8rmPH8c89cmvfjvXsb7VsP1i5Dke+PRvYsllLwfuqOTLO0EEqFaeK9BPq0G1xbdP/ut7v2zMELK/XDdvuXv7n9yj5s+0nEZeIyQmk3CDFCXGCdgqZpOtZ4ln3j7Z13Hhx+5v1nPvr02Qd7rdsbO45j1R2z6jmU0jCMTZOB5KMx87zi0CQHr3Rc4T6f4WkyVN43I1y9fhG7peBqKWWrSHmT6VP4rsYP5c9QambQXxSWNycoOjNlJTs4OInso8dV0noUJ70wJVm31YuVVDfVBzjZUi96MnntgaIJc4waJrp6EdWFNcoQgyxORNRO/V4aBdQ0LcYsx9Btk3Kmq3T4fHGThjUNTw7x3Nl5Y+ngPBpYKMQHHndP5UtmtgWQYaapagFhopl69nhBaWvHB2VyzT6W7GO08/eT8sqQOeVglo49UpTwOptoEKnkrTRNM6Yn8YkgPumhPK8OAMIwXl2a/fmf/tDf/5WX3r27uzrjqKV0BtPDXqCh7LArvKRTfcKsC+Ow3aaNpjt7po88NCD7YKpBHStHGwWpMYTc2Z1m89d+49a1RePps1TEKdL7sn0U64h4Cvqq8qI6fu6ZS/T+Dt07aK9dRq0HNd3IIWu5rL5sbdzvwSD18OIHn9145+7Go/I9T5LpFyEofmWDsarfXrWwU34Rwfsn8O3DjqHqz68b2S/++42V+t62n7TCFAAowbZh7LWCuarTDUJNQ1LKlHMpJcfAqE417cAP/l+/8cZrdw9/8sMX6hV7Ydbbb/rx/uHC3IyCrPJeNBn2ApG7ENPJPriAs/yEXMgrsivglrIklf+jDubh3NLFNvbyKx0s2TWlqG/xypyU3Z8fny7bS656txvEvaZiuik5GiRW2Bj1hHzvQMjrEIzdii1YAcAwtChDkKRRO43ageFZHWLrOjN0repajCDHsRTiFd8nwl02/ObWdm3trGSrAIBZl8cD8T6M1142PgSpMiBFnBETsigVOAGdlJx3gEFnVKIf7UyHdSFHftKvLroxuRkyney5G/P9E/JqjJlkyEz+e2mWPsqbCUm5GsvYJMuxMdWiWCuJLHUjUQppml46t/zzP/PBX/r33/72jftnF1wlHJIofqfbnHHwi8893Ww007Y/43krZxdHHXP1UasFO8pXycHNqwu/+itf2kjE//WpWt+0SVMYlI0uprgUcxCLAUkAWLt8RsTpu/duLWMKs6BqMUrBgXd5I1t2zbwraUbp6vUrva29R+B7MXUni6UorE9WNcIyTksWTc531VhVFS9T0WAA4B2hEJ+RpaoOt0T2biMilBpUCiFSLgjB3V7AOaME59+sQEjTSC9OdYIxgtma88b63p3t9sUl76NPLXzmo9eard5hsx1G6erSbF9rD6eXTMG6mvPlOl0tmMgvD+WxmEzP3XkYXlZa6Pk1/qobe/nlF94o/UfJfkxosZDmr9ayKr6PBX0J6yjoKabbgwJkPSFHyR5EfNRzPwnKRw9GGVIyfzR10tAkDCKxUTsACNqEujaNY4sxKy8+o5SW9r4nP3iutjImCpp2QKWcu+eQe64268Agw71oyIzFa7ElMQDwrO8VhMnI1ZNn+43uTLEXKB11RUfXduZMV/+Ofdkc698n8a5p+FQx2NMq+vK9wbtjjfUwTvJ/6v6ccldPGQ8opWGcXD639JFnVxth+ttfu9EN4q1GT6Xzv/jc09XVuf8fc38aJFmWXoeB5y5v8X2JPSMzMjIrl1q7lt4LaDTYjaUbRIMgCUm0ESViKBPJ0YzMaJoxGcfGRhrJZrMZsxmOjTQmjkQRpERSBECAIIDuZgPdRKN6re6uvbKqsrIyIyNjj/D1ub/tbvPjur944e4RGVndkOZZWpqHhy8R4e+de+75zne+tZtXF6+sWQylHMzj2nEoH91mfuE0ZH/njXf+6998/S/c9J8ol+51HGuQH+G475LFq8pvjMzpFuhtQuRYkbefuP0cby44xYqnEgEjVBz1djuD7f1+HNtBrHk7fOnCYmV9YfP2g2hn08jeTA19Atbzjxkh+7iXSg07M2X3Y0Jl7MZrHFXoFwDYGU8W4jvtTjeFMoYRUvVdAIwxRohUOhayM4gwDhgxhCilhJScMaVVmColVK1UBLDdDv/pn37wu994vVEvrV1YSrWxsFvwXE0KGeBO8/GZal6GwtlpY/HdIr69J4/UmTIzgdrTaH7G3vEM8nH+w3GcPKmf2cWqtGoPors7nd3Nzf2Dvd5hm4TDEiNVn1Z9miH7+d+06PNMk5kA9IfIMtZ1MwsMLYv3XFbzqecyR4q4Fx4c9brdo/2jo/1A9IZJmIhYKP7Tn/2V7bduN1rvdva3rdp+QtofG2Y6RwOIHouFiTskTvc7nWGve3xV1Orn+VWVHJP38x+nNDqd8zgPpp8N9H8W5P2RV4XTybv9VolLAGWfneYdlnI0mTm7hDKr2fn195kXYbc3+KWfeloY+rXv3xV/+s6nnl67d3//U59cVnGoEmlb6kUvAJa1BKR0PG6LbBkQWzXjOM/Ldzc+uP+f/F//ySXu/fVPLb15f/jUk1fzmGj7LWY2W9gW/+xTO96NOYmKxOb9gegFTq2yt9mp+v7y2kVbvWT+cZddrdysXmbb9/caQVJbaRDWzf9sZxROdWJUHJ0Q93g5k2VO3SEbYRQkcbgRhHHk1uMeSgBCKQEIqSxuKqUczlyXA8iMEnYPTghRSkVJUi74gAyFZIxm1P43vnYrGMSfeXb9qaurG1u71is5cyGfvt8iez6kaAL3MyI//fQJWPe49LzSTLb+UPg+zceVh+9su5C/nd8xTOweMtqesfXOoGeTA4o+LzHCnBOU8UNIMdbtfn7bjKXtFv3JLNZlH5ABvdVq1DAaRlFQEFEUDgrFYVJvlhxuvNqFj368eK+C6x8XUdzYejNL921cGG1OTbCR9Duk++BgjOcEWGwU3PaDLTIPwAL9TIhnHv3wWPgwZJ+puTMufxxM/9DmGWEzPM9ck20B4FGVmfOIM+VaoR88hGnmkT2P72fQ8+liV14DFWJkPHhyrTlX8f7pH78DwKP4XjH9qY9dVYnMNIowSGrl46qmHbth5fIsNdci+wfb/f/D/+s31QH7j/+NJQClOf/j1+dtoZXJHsoLLO7YF+VWlhlv4HRixCC072XvqXgOc5LNO53vPei+9e52jeq665Yd0rxQfOq5NYvsttefCqHHSx2p1C4+Xdt66z2rzjvlooV4TGVA5iuok5+OHICXmefACMCZnJRtJz0NRoM7OBdagkKGkQOAVxnG+RdFzoFEGcMZpYzEwtTGM8UIjkdSZLnkWutBFJcLvtImTESVMwDFgpcK9aN7LQCXl1pPXL2wsbV7dW11Jt6ddtgxvzmgV8g1V+cx3Z5O1tBiW5aiJM0Koefb49Kzz8mznfJ51jJOuxQnhouNG7gsuIdJetQJkmEnTZTo90wsfaNK7NEwpOjzabfMGX1MloBnUJ4pMz41efg+z+FT43mkrxmiEcQngoi0wAGQpNe4sGK8GoDFmzc3Xnl547u/3VhaNV6NACbY6N57F3nPDNDgEkCneWkROOiMCMuw130ohT9XWdVi+jn0mQlRqC+dVAglfyzP5YRR8pyIL1KVJPayrznuo2kvp2H9xP0zTDJnIn5Pu3nNPU/V7ek+jewTnasza1z2//5gKKUuFDwpk1LRu762vLoYA/jqt9//7a+/3eqtHkj2K8+vMo8XC6Of0GbeThDhCevLK2/c/wd/8OrwqP/vfX55rlb74Tu7L37qhlurpr0+N0InnPEUAI/3Z+wL4wiAHawBgDYvbt5+8LVX7r59vwNg/ULzyRVHtvVck2acPTPw6KlNzJWP3OhuHYZBUgSY5xjlEMaRdGeUQE9m2qhEMM8Z0XYci+yYNVtVJYL5I2qvhaByVwOarwAnNiXlYqHgMpezEKLgOAfdwKEEUFaxAUAJYAwIAUAIiZK46BcZpVJp36Fainq12AqiYSJ8z/2TH73/2KWFYRQXPDeTaM4onE5QeJwMzLDF/Pw9YyH+IbX6D43s+fPwYRB/YnuaVXSzJS1JMQjjVutgEER02KdWWPc5wIfKlNgjgGymuVuveob4I/zNzVA9S5SXKcZ6kU/NaVA+jf7EdWqAoSOID6XohzXevfdu0toA4M2t1688jvoTtfn7643V1fIooYWoqK4PDuJuhulnoW2vO3nJJTpP3s+rzMgfa0jVj3/kt/Yzvzut2wwHbQCeVztDkLG9S5Qy8BO2mZn4PhPxJwD9Q5dbH0mTObGCDob26YVKUcYh53QYJvNLi53NrcvLjV/7/FPvfHD/h9/f2tw8vHvn6hc/c+lavTxfo512p7LQcKpOHtnz0eof9Lw/eunWH//o/eWk/b/+7IW52uhblfUF6hHLcCEl9XqE16ZTX9L2kUrE9v090dPzNXrU03/w/Vc2dtrP3Fj5n/382lJ5QfSCVq83d6Xh1CrTrbB55j5aCzUpXVikaRgcDRAkxYo3OhOIM2ldJ04e3+3Cf7z8jx+PqbSZTJnR0qEcKhGyr3iV5YGt7qLoOwv1cm+YFD2/O4hTIZNU1Mt+Ko/xVBvAGEqMNij4vjFGau061HP4aLxnKmrlwktv73/iyYsff2Ltd7/5pu+wp25candHeHdiGvsY2WdC/BkV13NS7LM5xHn2kdOr0WlCzXRZNbsxDJODThANOhbZmUMqnATS4EPZYIo+RyxxCrGbRvbMCZMX4sn5/toza615iO8kkogWf/v9H9R6nY04XPdvA2h8ZL1+5fGfxq8en3usoPyG8eskPgHcHckBuO0HIPMANsa2trpTtWHcJz5O3/mzgOASTajnI4l/4q/8SJo785xkGNscMS0ETmfu1u+XdaieAeLnkWgyz/vxvJZpLnA+49c5L62sFEYp1VpKoFCpDcMDAI1KqVEpxUn61//y55997vrf/s//0T/9yjtff+3u55+7emO9uEAPG4eNueb1LKolDnpdqQ8D8969Vn8Qvnnv8N7W4V9eUj/79Gr5Qt1vrG+88X7V95dWrsj6Eg3ftr+yCkFYl0oCALymht1MErFqzHyNvrzZeem9HlVxBuuiFwCYq9XyyE4qNT2ef6RPs6K7xcqCo+IwDJLiSGk5dr+MiqLEmcb3LB1sWm2f5u9WugmDhFdPnDn2x3Y5C4KgWasAqFfKdiCp57jBMACgjAHgcKaVth3KUqYVv5BIxSm1n76UihCSpMJ1+f/7917/f/4HP/cXP/vM737zTc9hC3V3GGPC4Z4B+nmQfTr2bvpZ091M51QCz6/Cn0eoySsz7W6/3R0Mgo4Jug5QKVAAgTRKTMw1MxOy+6PB/ZQyk4HyNLJPizZniPJJqnx/9qdDXKcB0deMk1uvbMwtNVv7G3NLlaP9BkAq6/Urx9VUUlnn8z3sbiMH7p2c9HHRHG2R+XW/aCHe2myQy4PMT8Vj3AU0RO+0JINHLlEmcTYy6fyB7I8q0UzrMJlv8vxF1zygW/7+4cyRGb7Th7JvI7J26qymOlOomb7kztgdC8I9HF/D80uLtz+4bzshy+XizkH7L7zwid/+r5p/8M9++7f++N3//qU7eAkrFXpjcf/ShbtzqwuLjcIwpu9v7t3fD4aJiKK4pAY/veD/R5+vzd+8ZkdktN57H4A1tLC4oxmHEMHRwDJolVg6fDRC/ESEQXJwb3O+Rr/zWutWq/fphdqNK2tQI3wEYB07mRST/S2ydqoZ62IBSQTtOMSpVbwwOBoAY4i3lH/cqZQ/H3IXmTOh2EzydzkAoFBm3ni15itU7mbI3ur1Ls25d3tDt1B2HeoTReeq79/fbVaLwyi1sJ59cp7nJkmqjBFCKR++6yRCFgue5zpxIgAM47Ra8ncPO//wX73xH/zqJ/7iZ5/56svv/4WfftLSWPtxn1ZTfSRR5ZEe9mOi/Pk1nwzZh2HSHkRB59AS9nrhrB/4QyN7ButF/5FV4jOQ3Uo3CRgAkwpySnK9pfD8FSrR2d6gWAdq82MpprJugo3j09GrwakBDzqnyNkXzVHavASMpMKNBajDiA5DFH3mUaljHQtWKwEouPpYdk8DFOceosBkNdVTHkY930liAA4zWQD6n4VKkwxjAF7JzwO6vXEefBeRfYxj8T0fh/Ch8X32G42XuppMQI4j7qa9X9PKjL3CJ8wP05efYyQIzX/ZLBcqjYaMw5VmdWNrD2ELwC997NovPnN5+/7e9x503z0I94767929H9/ZzE7fhZLz0QL/1Fzl4keXy6tL/oVVlBdInKbto8yhuNfpLFWo/X2LFS8MkoqTUK9hhZEs3deC+FFP91zzkeuNGtBmcVP5GbLnYX3i9zmNtidj8wsVAmT07lZMtz766fJMvl4KPCS6HUAYOcUKAARHgwzWqdwVPQFgg5QvVXqXFqo7PZkKDYdpKRzOKGGDk5tjoQ3V2vPcME6E0lprx+XKGLu0+57TH8ZSyXZ/UK2WX3rtg59//uJjl5ZfuL78xz94/0s/8/SjQvN5sDvfHjGRTDAh+3xofH8kNd+e7d3eYP/oqN/rmqBLhTkb2c/D3E/o8idrqueB9Q9RPiWu42mCU7w0J2So4xrp0mrjwooJNkjS6+zsqkQw792s0EqdwszVZITpAHKVVQALtK9QenhB9Tza+knPTD5+wPj1IhHDMaiVwh5G0YmVnyy4i1SlSUfJFFjyzh5zPAsp7NPDZFivXnRcX2uVT5Q8Dr3hH0aleZg8d4zsZ9sfsy15YqgDfYbeKgh3tBxdwEZGSTq/tBh0OpzTQsETGp2jQcVFcDQoFsTatcZjH7+J8oJuHXS3DqnctU06AHiV+Y11t1ZlpbqsLyHukDhVw66KwxqGR0Cd09tv3Fv42FXrugmD5N3N20ffiOavFR5fu2FxUPeV6B2fUVfLzCowWbLB4pW102D9XDiVJUL7RUnUnc7g5vKiikOrvczcLR3fT5zZOgygJaw3BnKgUM6QPfvjzNfoYCuYqxYfk8lOXwFIhXYdulT1WmHICMmYu8u5yzmI5IwrV2cqnOfwREiHwnMdEsVaklQIzng3Er/37dv/i7/YvLG+cn+vs3PQvn75wk8Q2WdK4Zk3MQ/rEyrQT0SrOePo9ga7B632Ucsq7A9F9jPwfaLWah9QAsIxWGfIrqOEFrwJN2Sem2f4fjZhn1gSTCrwsIFTo5/A9jHtvncvSXpbnc0P7mwAaFacxtLqY8vP+BVfh3sTv18eyu2xMSu4aqKgeqx59VQTHV7FzDCykz+je/y/TKenOE2MIf2zOByXaa/RTbZY0qHO4rQgc4ZCYo00g163UCpmD5tODLbknfEPxeJnlTR63CubUzOSsojXCT6ltXagzy55WdJklwr7v4zDTjBsVEqOA99zu7ublcsr1idjWTaJU1aqNx8jhB/L7ll+uv11R3cqmdm9/QsXLq4t337pR4tX1jrtztuvbb5/R97SrcI9+tTlYJVy3qR2s9YDZFv3XDNXZldrxxu4xStrpQuLAPSHAvQT0o0RDa8S9A4D5jQfWxS9ELOaTjPsnllHPQb6sWITRg6QTFwhahgcoRIMkkrZu6B42VdJFC7UCrEBgILrwahEpIzSYsEXSsdxLJQu+qxc8LWUlFLOmVIaQCx0kcOhbKhSzlicCt/hP7q92+r05hq1p64u395qP3Xj0iOFDp2/cjNNrrNvnb07zDfBnja+5rSAmpn1VcvZB0HXSQM4xCrsFf5w1nwGc8++ZV+nK8w0RtOCdx6wftS/MHkYsptUjE7Ajc72Rmc7c7jbo9/BRmf71XdfttC/7hcXVlbsHvngsG2hfN0vTmO6OowOUW3a320Ywitn6JPRdi0ioCz7Y3yf8D7mE8om7p9G3pOwPhGX+JM6vJJf0s3hoA0csPoimwrmLZSK09OabNlzOGhT3ymUlvIuyelu1QzfH0mosQtG0y/1z+TveVnmPBOHz7j2HCPhF7u9A8/VlUYDgIxDz2FJKpr1ylyteOuDoyvPPNmLnPrFhXyOY75T6fi3jjt28hGmAG7xylrzsfUDmhy8fnckwV/j17H02CIH0B0nh1hkB/Dx1Wb+FRavrM3dvG6Lt4+GTY5jgl4WQWy9NFQARtjRInM3rzs1iL7IRBjCOIUcSTFmVA6xiG+/a1F+pmFmgrYfjTcirX64VKFXa04ShZVq2S/6R/ut1lBJJTnj9XJBKPSCYUbhhRD1crFSKRZcDsAYA4P+MGaM+p6DYUQIUVpzx+mG0Svvbf/iJ92LC4XbWzg47C4u1M+J79Nbumk3bfaADGTFI3q68tLN2XuCmV9OIHsUJcPOYRxF5agHTgJp+rEuMYKT4F7hpCvOhbNDZao+rXDCHF+JOJAGuRanD6Gz/1kcfEv3Lo7Yz2R76jElt/c3Vhf8ippfBWCCd4HWNFu3WD/oReVa4bQBqhNX9Qjfp4WUqQTKvCwThhEajf8R/kDW1mZ5uufVjEjCZEiGvfIUNPNChc+i7dFwH0Cp3PRKPsa9TgrKAn3G3yck+J/IYRKRh3Up9YTzd+YVla+qZUW2CVkGQL1WFkI4Ro6neRQPO4EgfK5R29vZAjB387rxXQwOJzo8J//CfoPFnRFtl73jwVilSmWhQeJ0aeXK4kIziXAFGO4cZPObHsu8jEbYianHGmOzUVloaMe5u71zdfXCh9BhFMD7crt9aF/KMncAxYoHNGz7lVPtib6w2D3T855R+wzTM0b/0DqNGgYA5sosDFApcADdYTyIZcFjUQIN1Q0Sx+UVn3dH5RxobYwxtVIxSaVKBGMUxkit99v9YqHAKNVaElAAvud++73Dn/3odY/LC83Sg4Pu4kL9J1syxSkz2ae5wswy/nneZWLewBml1E73MIiHhXBYKnpDQVQU6igZFryH/s552s4cUgKs/505pF4olBwDmL6AEh/WPQnoKDmPBf7RLvxUAOCmN9iqweJ7HuhnQvzH48cA8GpjaWVpfXe3qziArujXnWqdyQzfP6g9bB7T+KoeE5aT+swsep4jqg9pcvuJa+7Zdei4DOVF4MCIJBnGFqyPv4UaTnaoaq2SpJcoUSo3y5UmgGQY2yEbeX1mgryP3vRRlBk7cm+uzAaxL8JRf6YJusPmUum0QobUAOxPMXG95a+rUwuqgASGYVKvVrKC1UKjsr+7u3ZhaScJDx4cLa49joO7D9/2jpF9TO1HdKHV693wRkP1dGLsdOD6xYXKQiOTSmwt1KF87uZKfdgdzT9yHL9Ss/h74UPRdovvnXZnJ+X7m7fV3spTy5XKfDk7E+xyRXiNeV3bmaVCZJmXkzvoWZp71kab0XZbhGj1fTXcYaXK3V7PIotO4mfW59/f6QEoFkv94ZATZQFdxMIt+/WyGwxDAMoYrXQYJfaDk0prrV3OgkHck9JzXUKY0tpoXfTcw27U7vZX5ovc4a3u8Mcsn87k1/mBvRlzzys2+aSaiQCDjLmfrcifloqRPw5b7X6vS+OwNJ5axxxi1ZIzlJm8qp4x9K4wJUbqBcocv+SYss8G8SPIWfny6XG8gV/ox/pRx3pMdEX5RuGkmz7hLiW1Y0viRVrb0r0tferF8IN7HxwdDSwuL6ys1JlcbZafWrqw2iyXanX776yV1moyopfHaLsfl/3OJKafrsWfYev+SckyE8Qqo9WOy1yvQRxvpi4/0ZuqJBxaLJWbtrMpGcZp0smDuH1ZW1+deKIV389bNVWzaWAJ8UwiI6V+qPldj4+ZHCpK0ka95LmObXS0d1bLpblGbRjFJhEP3nvzVLnw9DkYati1N456enntIivVsyl6AFQihSbacSb8i0KPJqk6VcepOg41cdDTiYmDXhbL5Vdq9p+T0zepEPbfxD3W2P5WP/mHX/7hf/vH2xt3Pnh7LwiOjoNfssgw6hEruWg5e1DUTCJvYxIsrGu+ktdkMu+mbOtLC3UA1YXmM1UZG9ZPiTGmO4glTLNWKvoOgO4gppR4HmecFX1HaK0MQIgx0FrDQGsDSgkhI0ZMiDGGESOU3m8PkjhdaVa7QfjjK+ynbfWy88fyibxi89D9gc4dZzw4v05MF1GDYUTjsGQ0gKEgSsTnV9iVMBVOqkWvUvaY4zOHMIcwx6+UPer546f4H8IxWWJkrlpcrfoVTh6pFTaDcvt/BvQTyA6AW0AH8ILmr1AJIM/lp8l7Y//O/PxoPSjV6jbdxcYAjG4DyAVD6lKRnVTbp2eoWn1mUoqxWO/+hH0vH+rcVSIS1BmxcqfgUHkuz6XjMgF4qDF+jOyWtmdZxDOjxPLi+/mZ+8RR4WQIvzSLsJ9nu52RqYnryl5I3C+miao0Gvu7u9lcZkE493nFJ2L14r0HBx+1IV+nQPk0xB/HtvDyfI2WLy/nJ2DgpGdx2r+YiT8isqYpQoVgzXl7+qXtIzu7VfSC+M4xjdhkEsCa4pvjredOEL11NHjzSO/05HMXvU9eaYTG2dw/AnCzyquGFSve8Ww/XqPo6cQc03Yz2X9gafuJDHc5sMMUJ2i7xXdWqtgfY+1yCUDDDAZlLxVhLHSaSpfzMNWpSByHF30axskgioueJ0SUSEMp910ap6nDHQBQKQAYAxCtFONcG6O1Nlppw+7vB8/dWISkrSCJI/FjumVm4m9GDrITb2btdCZnP/9xGrILIcJoaMTAYmce2c8IZM9/y0I59bwiEdoxShAAJccUybjc4vklxEChi8i2tp4huFva3iyyEWd3CXW9KgAkQzUZLnZaYkHR52F8jO95WJ94CreE/fhE7A0yfM8z+ux2Z3/7qLmw1JjBjsdJL1E+8nfSKjOekT1dTpT9Dq82ztZkZmJB5uz+iavtObSVMFKkBdt8RM+dU2nXA5EqoUPieA4tOgUnE9nPSADO4/uHM0cyx552lemxkD/OdtteSI6R2sCBnmvUur1BaXk+MdQxUhAexKZQqd1/d6tzNGjMN9DdPyd5J7yGpGv/7LR5MQwSf3EE6w8hMpXR+WkVGEu9mV+0k69b771/cG/TAvoIwRn6cVz1fQD9OAbw9S0OoHOYAHgzDB/IBMD/5pfX/43PPNVpd6JauXMYNxZ83pf9KhruZDHpWHUZa+7TSWHH51UchpGTL6JmsN5DCQis4N5N02dQ6gEdUi5XsVhp3z3SvWHoOFymKedkGMUu577DtYGUihCqjEyF4IylUoNoRsAoS5NUKO061BAywlZDYoFqydlqDQAcdoK93uTHkY1/ObvKep4IAZsCDyBJRWHKOjLdDTvhlZyWa84QgvLpMfbLYBjR/tAKMhmyZ4VTJQxmyTITVDqDcub4cAl13cy2XyQCPgOUEqR/Dlmm6POsElsyWicx9XwmSNWPSswZKmMhvujzEnOoMjMVed+ozITj5x4w8Ui+3litO9Xm0srdrfeQK6halLdHnshvdLbX7xWBGxmg56MZSzSZVu/yHapWkwFQr5yop43EmXMPzh4qH8BEIsKf0UEpg1Ow16+SoB8qgdiKRRlnzwSZiRyCPFv/EJ5IjL1DDjse2T5z7G/25YSyOb3RzoqoVmq31VQZh1l+kyh63X5QLZ/YJBDP2dl4p3Hhc49QBZI9AMwvwoiiHIxs4Ce1l9mEKOhZfLf/x0GPODW3Umu99/7mH72df2SeoQN4/44EeOcwsfP+GgsegGcO8QyKX/zzlU/83CcBVBYaKg5RL2cq+am10HFL6sxBSyOv5Bj9Mz97druHUqbJfHAgicfnarUj4qIXNczgsQZ/ayuOhXS0JtoQwhiRqZQu55yzQRzbBDFjjNLaGANAagMGIUZvRAix9xMKqWSYiESRRPKjTtCoFPqDYVY+mc4CO634OS2JzJTIhRCZDDhdsZ9wxUwHTE6j+Uxkt7K+7cS2P1K3N1Ay5WPaPvNDm5DdK5wEOL1A6pKK62ZYf/xbez7CBOfwyZTYcSX2+E7HAAXFY0Q6BI4XAGn68PwoyYDbNyrzr9sVKDiF6Sep4s88/mkAlz/+2dIPvrnx3d8GYFX4PLhPCDUbcVhqHxyj+ViTGWpvqD1gspqaDeuwzD1OU3+0D21Ywm7xPauvfjg4+8keWbbMqPMwAXWRH7H9SFHvjMP2pp5tjDkN5R/1KEoWctWNIqOIr5UtNc0U2Tmn2nPzV1c2hB6TbuV0DFkn/AlRklq3e38wdBwHGMX1NeoLd9/feupFZK72hx6E1xgH0AW4Fbgz0UOc2cXnUJN/Fwvxd777cvCjnYlHbjL5/p1RYPA+Rr9QY8G7fo2vKQ7g6/fixoL3iV+58dHr8+OPWFhPpA0HtpekGnbzqcWEdTFhlTECJ82yFtlVIiAHuj1jN5Mhu9VkVh0GYIH2B3AALM9Xh8N9RohQGoAafzRKKZOdloQwxrQx9rMzxgxiYR8/RhINAxBog2EUecwcttoALtT4xIo+MzHG9RhwghumyeTg7PztrMgppVZaGaPsuMeJR55mnskGP03cPk9jqn2M0oqlBsCQUCUii+MOM0IR5hAoM1Sm+jC5PCvDUs8vzYqxCo2jk5Eb8hz7aVJyDPV8PX4pe6PkmCF8RKFNG64XCgAqiPtATFgmr1vCTgteljVPCyfQH7nAdz4ctJdWrpHK+voL0fOdzQff/d3ZrKo3QOOEY3LdL2bl0zOG7U2fwj6BHceFPMTnbj/qMSHL/KTcMvnoR4vmmYryqEM8bAxk9vQJqX0Cyu2Xj9TQxE6m3puSg0QBiKNQygo4GGUqv6JQZi82KZ0oSbPr07Ym5eWX6QvpNMNyfjyCHaXd27rd2dmt+A02uH22G3KmylGseEb2kghnTy9zqOluHR689KO8ku5fq8R3gkxPt3e+JQb79yxPPwHoAKBGis31a/yp59bWbq6pnMeX9yWb9/Ofu0pG+ZQ24d0oSXkubOCkIVILkc+ZmdiRjNWYPAlDN03XLjfa7BhKLvooeceuRyWltbdTRmFO0ECllC2fGmOM0Rb0QUAJyfLfCSVKmCQNB7FeXazf3z/eeGmt7VCO/GDeNIHWeme3F8ZxIpRWOtUGgO+woufWa+XsbJk+PfJlnmGY4PREUmqOeaEmhWzqgJ34QYEkjkY3xjkoM2tIUZSMEn2TuC+iGoDUjELBciTdauv5O60HhgmieNyNtNVthoKUfdBKDf3QFlFD41jynt0YCnIeN+TZvF6JeKgMLXgWtZWIu5HWUeI/FF4Knh6P6cmHGfCOGJSC9lywQepPPLb8zKXGyw8626RWJrVynrwDsHVXy983OtvrK9czZD/+8HpdAL2Khp3vC5j2QJeKOhaRV5qR5G7rpWlwflifiB/4s1Nj8sGQP8GRTNm07iwEOPt/uonpUfn79DAmpSRjBGBsSt8ns8o1+QtvZmr2zCsz63fNPz4pzr/5w1d/5gufMUePvvmoeG6tqhNzBrI71KhE3n759Tysj07x8T39ON70/ffvyDGm81/7RC0D9IljTfG1n3/K6jCZg14loljxrBOGece6OeVFVuwdF3vHE1CPTxtyMjxyXEql8kifSdvv9np1160BTeW3Wdwwo8vwySXvOxvj5TODaRDL4pUxLufjOzUI11rboEhKCWcEGFFiYwyx6QWs9NPPrn7v1v7NtbnVS5W4O3B9L42ToWQADg67Dw66rf1t2e6wOxQAugMAfkwArIx/u9tLLgDxbNmtzl290LDVdRv3b7eGdlA1oydYf9bejHOkTyeST83FPnE9WtUxPyg1/2e3UrvtWgqkqYBk8kspZ4/J3I3Uc3RigMTiuwXxco5lZz6ZRzulfY5xL+tpAhGAqk8tbQ+kGSozIaOHsbSCu91zKDEy3Svmx0OB3AwQz2X81Xdf7jS2y5Xm3OPwK/56Y3XaCpnZJfP8vav44km1HUCpUQBOTBroVTQwYD1KfQc4ie+ZE8atZHXUUVn1f9Ijn/j4qArMWeR9XEQ9OzIsY+74sXNm/ELR83w2q2xr7+Sc5rNeSwU/vy+2gzEn7szEd0xNzc60V/vlpZXlzbdelS8+zcoLZnA43oQaK2jM1NxHU41kjsKf4i/0CogP+u/+ziun/e6Wie9v8XcPh5aqf/6Kb0k9AKdWmbDN5JF9co0f8+7RZo44gGgNgzlUjn2Q4xPm+GyZamhSiQgjR/fVGcgOoDVQFyqFudrkXueXn5zbbon7QZIFyzBCjFaj1F9Gs4VQKgMpDIz9FiFUG2Jx3Uo0BAbATz2xdNDT33rj7trS3H/zm98PBnHTSTqp8ahaPzCd91tXEncVTgFsEbzpFavOEqcU4xWu5HsAesMolWLvG9Gmvv/Kwv1Xr6i1m0/cWF9ZXCjFkRgHy8BCPOfUbhFOmYw6OXgvLxLaB2RJNeMzDQBsndYuFXb0UlYFqcljgelsEcYie65G6uXxXQe9IsFgAq+JCI0TpKkl3Q+9Hkts5L2xK4Q+KfLUCwUgqnBScsxQkAon8GmJOYfDEydSTJgfJbTg9WNtF4OmhzbI9DA//qCz/aCz3Q7EY5uvIdekmtH2E8iea3RSibbV1HxNdTTNozHysLvtBxsoAuiKfner31habTjluUphMvL3pEPm/PjeNOpsReXH5+w/WcJ+miKfB/QPh+m6NNvdPxPZs8CZmaQpX9HKuSZGwqs3ck6fGIWcr3dld/oFx59b+s533nrxxadxsMOKTgbiZ6g0FijDIHHK0tLzmYJ7EuE0ZM+E9c5h8mYY/szlRgbrNvh3Akztt9Y/cp35xVHco3/yjzkB00Ywz6kmEIOQ+UXKMTPad+I8HLmA5K6eockEahhYB6Q9bNYxgKXyAnBo2skDYKlCv/h05b/6bkIpgQZjTCkl9Eic0dooIxwwGDNKdh8L8XTM2imBMkZIBaBecO7dfr/zW2897pMrSR/AErySwV2SALhCS0CjyjmAOnOrjj+un2kAqRQAwjSJrSGPsGVeWOPVT/TE3g+j17/31stLt9WnVp+7eenCShNAHImMpD+SzdESiwnExyzTpD39smi8/A7S9h89TAq3mCvym2DAC2SsRAx4E5hOK7VBPwQQDJJuFH24DtV8PVYncckxcIvWj19yDBzPCkTTLkmL71aQqXBS8LyKSvq5ViZPpgkfD0V6+/DVW+n71vNueoO8LGO/zBdabXE1oAOgmpdlsjlNDS47krvtByMIbu1bB307EFebc8DKXKUwiew58j6D2uf/EGd2qCbRudox4iBOkp6MAl6oFEs1J3cOxUEMwHHZJBH7iaL8hOb+Z3RoTZRW0/ieFVeFEFnBatpeNrO2lq+wTS8GJ/7IkVhcufDWa289/tQTi9V5NexSj9h2pFNnTCejUK1ixdMSzOPUIxMVetuYeu/bP8wzdAA57cXLKqX/3rWSFdYrH71w8embVIjgsHPQC/K11spHL6zdvIosyNcvnr3q54vqKg5xOo2YQPYwSGbSdps0MKLtvV4tJZa22+1FvoT5hSfrX3kr2Et0yYWEkWTU4KC01gAjRMjJ12eMccYBxEpqrRnwdNF9MeSfjctzb7lVp4ax/6KvZUnjGXA6lnfqzPUJc7kDgGsDQFICwN6TSuETFhsVG6WFDNOEOnyZF9b8ar8bv/H72698b/uVZ8svPPf0hZVmlDhSJh/qHNYTLdPT1Vd7p+3OA8SEcetcq0jOup7H3ApPRmqMzzJBJjRAPwzStNsLlTDnnJodxhI+r4sY8Czlx9jDU0JsX3miYDuqsmLSgeifJLVDQbJybqXsU2VCwEtTni+ZPsAgA/GLtPYAg0uN1Uxtz1A+L85MHBmmu8C3kmKztd9EYJEdQF8edIVTj+dhwT1rWcr+n8D3U+Jljj9axwFgEoniI4Qz9I723353O+h0klSUit7iQv36zSf8im9D2z+4ewfA2vqFMpo/PryKVM0cqWrFmR9nHtNDj/Mk3kk5MiGc1sF0nt6WM7oH00Rdurz8+7//tb/2V78oNm+xUoM6DmE8nyaGbMb0ScPJKHBxLLuP07uEdpytt97LFJUM0wE8/jx72iln2os9Fq+sAagsNA6dNX/nh9OE3a1V7aIymeKb5+OzJm9MS3ZhkIxMNVMqHwDd3pr41lFPW2TPaHsPmL9WyOoBTq3S7KGFxOJLDfiPPrf0v//D7VBTSqANKAFlhLNMbweU0kJHWosxfxdGK63nfPoXAvd54l1JSlVn9Oi+lgDCTAij/CJcyrhPmAVxS9LzyA6AUwqAux6AIiC1TomwLD42KhYKwCfc5id6ePmP2698849f+ezyU0/etHXXR+pROuPUmu6tm6gVzVRFTrsobNUUU6pL4PjdKGKEWp0hSFM1jJjjA8gIu7UkZhB/WnuU1dwDaViawj3LTz0kFOnoFbrRjCgX65+xzplupBGF1iBfLHj2B9BGxa5zyvANWtvSvacWnv/sx3/G82rt1r27W+9t0O0HJ5PFhr0uanV746I5GgIusEXm+9v3AGzQzsZ5PsRZ8H2GMpMvqAKglRpph3m3wNlHd3fzT79zK0zStbWLF3yys9ve2W1fWj1w3BUA3f7W27cfxEI1yszzHnnU9Yyi37iJKS/CZMz9wznZz3kE0nwIz1Cej5/WR37GY6ZXiFpjfmvvvX/xe9/6tc8+2Xn7T/3GulMu6iTHKsZz8k6eAQMti4yNGk0BdJKggQqA4c7Bd793G0B1XCm1enoe0LNxehbWAQSHHR8/zHeorv38U6ULi7YqmyG4dpzRPRPIPgHx4xtZYSZPz0czwb1GHvozm/yEIDNxp62jYjw6Kn/MlVkP+Mi8+3d+4eJ/+tVNYUAJYm0gAAhGCGMcxBQ5aRS4/eV7UsfSLLnkFwP3C7K67PhaysEY049xh/Iq5Zanz1ihpUiB2KhummaMvur4nFLP0IRoTil3PYvy/bEAsiejOnM/4TY/Ymqvfq37+je/Wfvz124+c7NRL2XbwYcC/WnfnXZP5uNrjpH9FLksE2rs3NSsajpN3kckKTWh6+okVmESSFNBzBy/XiigALgEAFLDosiK4FMi+7h+m83wS402MfV86vkgWQsxdBKPYd2Mfzy/wmf3Rlk3ZLaoTOg2tOAtMDID3C2Fv9RY/ezHf+byxz9LKuvLwcbc699dv/2DjcbqRmcE8eow6l6oYjwR2/J0iyoZVZ/9geXDx9NA9jsAgjS706m451JCCK8BvTxz1w8bpto72v/+D99vD6KPPrV+/eYTjsuAt+7d3x/0uvWVtTiIN7aiWCjfYadRs/NrL5Qykappu0vG1i15/7PD9/Mw9yQV1mNgxc3p/pEP15KezWyjlMaReOqJm9976ZXvznsfXb4eHA2KAPMc26OfmUzyf23mOWHkVE7OYeR9GaBTrHhv7wXvvmoXyyGAX/tEbYKn2zxIAC1nzb//Q5s6cMx67gT+tcpjn3iWeRzIITtgkX32rzQT63M/tsV3Knc1XwkjZ5q/z9jV9QI1DLpSZ7VTNQxI04M6RnZbHiBND0cpANnWLeCLlzx8Ye0//6PtWEiHkkxgV0pSRvupjqVZ8hmAGqf/ZsQ+pytPs1Kf6r6WGH+eZQ06ltStbn6CG46Vlv5oVu6Joy1lOwkp58u8YAl7V6V9LUMt7ToxUsxE2IVQ2jBKnk1K3/zn73/rj+5+5BefeO7GaqFSq/gk88+kiXqk8+2MNOB8GWmQsIzonHi6jhQmMmRinRirvcwSRhCkaQlgjl8vkZLRtih6XFZ1XQBKhBZqM/KeC49ENZd/MBQEJC0ZDdtaNf6R1TDCKKzGt8sGg1/1I+CE7J6FjtnVIoyljYHURg0LXokR+10+bXm0ysznnvmcRXYApLLuVd9dWFlZANb94p/kibDiNg9yo7N9Hp5ed6pFrwToo6MBDyCTAYKtrNHUmuV3nMpcc3n+fLb3hhlsedwy97MtSioRb7+7/WC//eTjjz129ZpfmXxwkvSioAegUSl9uInemZKuJMKkvbmxs7Z+waaGTcsyIlXx4IA43swH/I98THCofJP3aYkf0w3i06+WaTsvfOLZl771evkzl67Vy3bY9HgaU3k0moOX81ZCC8fNxxadxBiO3m7HZjTeeuntv/cHG/apl7j3n/3sygRhtyR9pLrgIHup7LCEndETsE45JHFG2wh5CrJbTJ9y7+TNsq2+X8MWbV6cpAVTjUtHPd3q9WCHRmVXk9RzavK0bLPYtBMrzvImtQ/74iWv9EsX/s/f2NsPUodRGGMlGq20y1ks5Dbw84XCrwT8CisB2EIKjQx2LUkvup7U2govE8jeTsKRtSan7g6hhgT7SAA0qLsGHhtlRXlbceWUlk6G+g3jxNZduyq9guLmMLr1W7deXb4PoH9FFaq15vz8yuJcvVa2jD4D+g8hBjqOYyuiE7KMxdN8ooBQZHqbizABvLJ/1ma9UvYwSiMQkwKOe9wYlVeBKmUvF0Tj6MSMzC+pGZ5cYIaEYuzIzOg8HMwMNrBjpOyIdIyTwggxfpQEQKXsY2IkeXZ86cmff+rFz6GyPnH/cqNR57Sr+GsH77CFQj3XyX1JNh/wtr19WnTwemO1XpsH0AqigjjI9JzsAXd2AgDtuaX2/m5raWVh6cripYdnh52TuXcP7t/+4P5crfjU46s2rTcO4iA2nutU5pcAGJFYk6x1VjkuOydtn+mE2dzYuXd/H8D1m7Oxu9269+abO5VG47kniw8fdf1nduQHZ8+E+PxEtHNy9pmX381nbn71a9//6198oVgQYeSMtAs5OL59XDN3ABzc26ytNAjjmWgT7G28eXt/ccX73/2VT9K9jVZbQ40s7RbiRS846AV5WWYi5L10YdGv1JQNB87Nw7PIzs1DcgUeesxVY9kfI74c2IGrmGpc6qGkhjuttraumAmrzGkVPwCV5XWW7pp20pX6Z5b91Z+7+P949eA7GwMAlsJTgljIKmd/i3mf75cu+dXROkdYBsSZaJ6pKBO0vWvjxggZ4QshQyOPiO5DjGCdFq4W64Vceo7WJoGyaJ4XZ7J3v1qsA3gCc78IJJEK0yR+VW2KsKXvve69hXq5f0Utrj+2tjy3ujzvF5yz6fzZIZFn501aAAVQwYm20gzfqeef0GdcAqBk9OT9+VqLcZDOLhfbYoktn46KtB6CNEVqrJ5uXe06iSGIRXZLUm3sDACEyWzRddbW3MrxQ2VKM8H9qYXnn7r+ccw/e2ILGcUAjO96/sJqf1hn17uKdxW6ol8LaK+i2UIhb2/PzPJ5lK871UKpqGSqjx68HYfrfvHirP6WZmv/Fbq9LvodMdDi2vLVSzPxfabjIs+n8t4GlYj37velkNeurFumbIF7/WIBFwv2njAZJqnwHVYq+KXyWdXUM7ySmcbSKLNgaXFu3p/5GIWf5FQz4njMo/Wm1xqEU9gt2TkqBx9ujuVDOXv+/ka9VFpcfGlj7xefuVwsHGN6p90prpbzyE4YbzQbnXE0LvOcYsXrtPEgoOsXmn/rF5554uKilmvBYSdLBJtoTxW9oDMGdCu7jyUXk7aPRmScHEcH8ymz46nIbsRp1vtJM8wY2adpu+gFXannmjRP26c1mYy2Z3I8SXfzNH/+WuH/1Fz+g/d6f/9HXdu8qgyeLrr/y6j0jCw2/VLTK2LsX3RzcQiWsIdpUnS9adquhQAhx7AODYIrvLjmV0uEU0oARCJt6cQuGJmMM/FSfXp8DlTTBAB1uF1gXO4UqbfiVSglvwwEw3Tzh/1737v3uvfWnz7hLFy+euPywtLKSqXAZlb1Z+4Xp5tjS4hnBtWf5oy0+M4ItQVPncRDQaz5fkhoaeyZmYngSiQTmvtQGSZNdeYOwHUDpJg19sICepCmIBSDRIl4e6DaoUpSrYQEwBweaxXGsu/zMJaxJkmqPZdls/qsUTKwwzoAfPbqr9WW1O/f+iMAn/34z9SvPH7iVA9GG2ESp3udzrDXzQYwqcPodd6+dNhkC4Vn+SWW7r5CZWapxDh0rMoXrzbnmksrjLvhOFvMIvutndkxkHbyX63XAZDH98wKmUSPAH+DoL25uVUuemvrF7IyqeOy5twVAFaiaR3F7UG00qyurJZsztfM4EaL7GE7EDqcKLrm1fPm4pXKfDhTcrEhM/XqxU9+rOR6DUtUk6QHIP/4CTleC3EGwefUPw2VbfCAjRxglD2Ud59dJj3PA2ZegUFsrt28eee993qFSi0YFCsepAgjp9FsZJtc5o28NM3HFivzZbuCBkeDYsWLauUnr69dcGWDORb0KwuN0oVF+gmRR/l8QbWy0LDBkGrYRSKUOWFsZR7o+KssxJEwDiln1FFnraijMdnZX2/Kw26RPQ6OzhZkLG3vykk/v+gFppeQptdtz2aFFvd/+Wbt0wuV37zb+Ze3gn9XuF+IqiWDpl9aLVQjLSEV6CTF64tYCzmN7AC0kBbThwQpNXU4zzvFFa9CCbQ2CdFSjRaG0ZI2juihDp/A96qmE0Cvk5ByXk0Ti/Lh2FXJKX2qPP+My34FePBO5403tl9x3vvWYyheuvLxJ9auXF7ClCV35kmY34ae4OnyBFjYeJlZoG+6wjAZKh5lzy0ZbbXyPjBTtxnEaihI1u404Z8ZCgIoOuWXrbguCiZbZvphYrcRls5n60QYy16sDyNt5LhbO1aEa58R5JhEkMqKS2o+zfAdAG9FSd3MvfDskys3r7TuJ5vR655XI0nPYIOclGVI3N3f7R52ov72vWNaS/EAeMDb61htLPjAlRe2743wvXbcCWWRfa5SALQZBMNcDTarvr6gj7cRWbj8n+y+/3ytQZ3ChD6TxgnwCEM5Njd2BmHy5OOPTaCt9bNbiabTHUohK41G6yj22L7QFc+rgSsAIhLd/pbHnEJpqeg5cRB/cPdOEJunHgdQm1kUFTrM43KadB5st+bm/VK5WeQ1S1FdNKxAtL9755139gqV2lOPH+N7OOwZkdig4AzWrUZxHhmHOb46E+uzVia7jXU9libqPBr6Odn9RDqrYySllPjFN+5Gv/DRJ6OdTVZeLPLQau6jguT49yK85s7V0vaRU3aKQBgkF5hzYdkBUKx4mWfROiPrFxfqFxfUJ2QOuDkAoUnaPrLu9e37e8hxeZsoYJl7pi7YdlPmcZWcYrQ4eeeEsJ4FPRYLAvCs4kTlkTzpbW/1epkgM6MeWJutz1RSCbjmFJTnTVq/J/9j4b/I6gAuOcWmV4zG+MtzPU2hHhnSp5G9SHmo5bYKhwQgWOb+ml+tcNsGYbRBQnQ7CacZem7XxUfLw7RGbMu2vJDtD2wlFnKE75GWiCWA1UL1Uq3xi7Hc/SB4493Db3z17td/euUv/9xHG/XSOae85puoT14RI0DXtAAVn2E6sM4W5pC6g3xJlgliYTrTZ8bIHuHMjPjTpDZbre2HiaXnY5uDCsZWyFgZMxVJZqSJZuSUUc8ldSKzxAIOoEtaL3//h3N7b25GrydH3iuv38Lrt2pL6qc/+yuZOKPDvcNOtBGH1hLz5IXRKXhrJ7BA3Gztb8wtAcDcko0OvkhraNR4d26hXil6FY85iIMwjADY13mFSluDzcN6274IsD7ufnr13ZcBUPrc/KpFt1MZ+1CQYFb8t0pEpzvkDl+/WMiItrWZA0iGMXWcJOl1ewMAQadzlIq3bz946salx64WASceHNz64Gh/dzcRam2t/9yT16nj7Oy239/cA7B+sZ3NWsoWjGQYv/3uNgAL1u2De2+/f7jb7gO48djl554sAsIa6q/ffALAxlb07Tfv37jYvHm5al+q3br3zjt7/UFY9P0LK83Hrl6jjnM2eZ/eexqdnOgEtqf4mLwnqVBaAed9wbOjtE/71kRk4PUrl2+/885Hnr3e9IsqDp1yUQxOSO2ZBd7IntucV8OuUy4Wx1bCEbJPrqPEorz1ughNkAgAJg6DIJmQ3YsVj4znMdkfbTp7fYTv41rrqMQ6S5yx+D5pc+Rlq7Pr9tbEn2N/Z4Ts0+kCIyZePlFKPf5W1atz2qs6yl2hexvHKn+t9q8/OHz7946eJ56tna45RZ+wME1c7lhtHePOpgzZM5Hd6ioW1tsq2RRh1fGv80LDLVoffaSllXE4pVLrM5D9WLvP7WUtcI83l+MfhjNX61QKC/GxGBUD7AMiLWWYAqg6/s96xZ/Fyp98d/fvv/GVF7/05IsffzJP4U87FUfZ1DmVZmLyNdURZZhJ3ieIPAoneb1VUlyijaaeH6SpNUfmO1Szym2JESWM4jGcyQZXK9MPCe1GoZ2x14t1kJr45NrgMwKg4NHsfiMNObkg+YzEynRCA+jEVbF/clgHgG/vfBk7ANBKk3fefgdA/a253j574dl7fsXvHe0HG7ctImewbo8nL1Tyuoo6jLKyqq2y9uaZVxEAaNwOx8liACwxz8P6+JVHhHeLzG/MLa0DG53tV999ueGUmfdEY7586nKtCKMzbAzMc5Jh3O0NfIeVyk3mOSKKw2Fvc2MniEd/srV53hmo9iBqdYeLjUp7EG3u9y4sNi1TvvXB0ebmVqNSavXam5tbTz427zuLtuh6+4P7m5vsqRuXrt88wd/TpHO0f+C5jkOvx4ODV97eUVqtNKvvb+4d7R/gyetChzu77UqjoYUQOtzf3QWwtnaxUFrKaq2dYAhg+2CvUPCEDj3Uppm7fpSh8hOajFSpUsa6C0oF/wxadLYO89AyV8b67RuVGgvf+uZ3fvUv/4K69QMthFMuikE46s53HEvbbUHFyB4r1dWwyzwHeQDN6SRUCOZx4TgTQQV2VF42TXu0MPhF64AUmozw3XGoEJazGyXJ2LvKPG7tNIRxxqDiaJK/j9NmwiDR7S1eZfaX51U20t9ntSx9cCBPQ/YecDV3v9VkRp9UW9dALPoH2Mg/+f/z3fv6u+FfYs2yxmCM7HlIzZC9rZK8FGNhvcm8UMu7aaClbHrF58rzBcq1NjAmgvbAPDAAEtoK9PPlqlXwuTZZT5P12xQpB2ejt+MPKfNYa7w79urERoVhkiny2ctaX/0vli9+JAl+45+/9Y/u3f/SL/xMo16Ko8nTPt/EJGY5vDPa7jCjacGeIpaPVzipFwpKxEEe1qdG7tn7WyJkDlGc4CSss3GM17TszgTJelAzym8bXPe6aTtIQ8MsSc/jtUV2e3sC2S2Xt7ftI+uunT0i4btZyAyfK3gAWtHkdq9LWr/z9j++27lqXS7N1n4zR9jzWvm0q/1BZ9u2to7OqkAA264cqSi9WqNRG3kc28DYHT95XDRHGyg2W/uW3d/deq9Ubp7TAj+tkIRJ2qiURqVUieBo/+Cwe9gJbm+1Sx7HR58EsLnfE2lar5XnlxaB+9wvAvjg7p3Nza21tYvrFwuW6hLH00Jwv/iRm5d3DtqxUBOCu0hVmAzbg+jqalno8NYHR9ZZPzfvd4KhnZKxubHTCYaVRoM6zrDVbvXCjL1qIe7caXWC4draRQCxuD9LGD2m8NRxMP705srssHeq8p4Hd6UVIYzzE/Nxpi1o0/1Kp41CPhvZMxvDMIpXl+dfefn1o93tpcVafNAD4JSL2SqlE0PRy+P7iO9kzvEZZkQJx7HIbiFeO44dH9toNuxgaxsqoB1Ha3AjOKASUCvgeDwLZx/9AB7RiTlB508xzBwjO1/poVPDEEDc2ZiOGbCCDE56Hye+NVOTMe2k55q5MrPPJeMSaw/4B985WHpH/rqz2NeScv60X+XZwFKtR/9TYiVy6vB5v2SbUYuUF8HbKnk5bnd0ugTvE+XFEuEYU3UP1DMUMNYzU6IOd2mGy56hYMd5K6VxL2QCfTase4aC0UQKAB5zPELtc4dGpmPUm7ZmdtKwybz/iF//+nd3/v5bX/lz/9bHPvrU+gS+55uYRpNkpqUtPsoGpzoa4TtgR6RSz9OJqdrk92HUFcdR71Zwz3NzJUyQWwNmLgOZ5j7m+4XRQGOfWTGn24/3umkv1hbZM55+XNlWJo/sGZrnb2SPHJt2mBXM7eAObhMF5mbh+/4heQ13n7twdUKKscg+gelWTrGemQzZH/C2Lbf0O0Bj1RpmyNg50xX97InN1v5EZdXe355bWh/XVxudTd91s1lO5z+MSGKhsvlbjssq80tP+E5hq7Z92F9dqK7N880jGQziy0uVa9fmWkex77CKTyy/9hx283J1Zz846ASXlpqeVxt2twBYZ64Q4tLq3ASnbh3FALhf3NzYuf3B/ZVm9bGr11679f4gTNbWLlLHCWITC1XxSZL0NraictErDZP93d32xULrKN45aDcqpfWLhTff3JFCcr/o0KKtuGbjv88j0QghlSHMKEImI3+zSHfbSHK233Fi/s7Z2ssZh6VXWuu1a+t/+PU3/vqvfQoHo0+T+QUb426U1Amn6OWkRGKUYwuYx5JIBrVj8d3m9IqxAUYBlYWGFd+ZX7BUXWtQIaT9uznwCshHmNnb9q3tjuE0tT0rqFpkt54f0QtQo7I/ewN01NOttn5scbb5uNXWN66c6OrIazKkn9TKxa7UhMUW4u/2en/vt/Y/3jdfcBb3ZLzM/avFumdogskPInPFFCkf8Wvgbhp8VRzFvnkB5V/0l+e8otbGjlmfOY8XgAeWjC1eHRG53CnlCfLYNzni9TkFZoTpwNDIUCZFyrO3OB7sTkmesLvc4dqEuY6DUEuk8vPVC1fC7m/819//4PN3f/UXPut6bJrC562QA0XIyTpqwfOjk4bpatEr+4xWijoQAMrAwHiBjGGj3gsjwX2oTrDy8yeFWVeiFWeo51vvQD9M+rHOstfznH0mak+rMROknnCSSfMlRlD2qTLcWhUfTIZZAoBT8ecKMy7aDNkzSwypldHBemMVJw3vE+4XAMA2DlDli83K6LMcRUVeeSwMo0y0AbBSqxebi3Bq3CvLZNDYv2M3q1F6AoBEfeFExPAswT2rpGd1sJq3VK40W0dvzdVLa2sXK/NLwftvAXji6oV69WLr6I7nsLl5fzhod4LhhcUm4+7ObnunPXzy8ce0EO/d72fuq0Kl5pcXk6Q3HLRL5aaHmhbCCj4yDg8CYYu0Qoebm1u9YbJ+sZAkvaP9A99hc/P+5saOjMO1tYuNSuf9zb0f/ui+0ioWqtJo6Fi8v7mXSLN+sRAN93f2g7l5v14tZuL7eTQZrTRxnAnmng3uyCLdJ7KZzpDXJ4qrZz942l1j6dV8s9Z+Z+et23vPrK1FO5vUcawkkuG7CpGlSJ5Yk/yiikPmz/CxWG5uC6SSOHby8ESipEMNa86fixCcabS1q4uV2lt9X/QCQMzXzmoFaPV6c02a+dlHoWC5b+Vpe16TATAYQ4lpJ3O12g+227/9laNfCfizTs0i+5pfhVQJH+GpHP+1rd88Q3YAr8WdbzidrjAfr/IvmvWK72g9SpH0mHOMtpN/DgNCMny3mTMpRmqMxxwYkygBzrKtw4ikQ0Oqjk7CNOnq1L5OnbqZtWbkohk7lCjngYgN41XKl3khC7cZLXhJuMwLf4df/o2vP/gne//8F3755y6sNGfiO2bR9uN5VLSQL9SVfTTMAOVj9lMXBSVCW7iypvgJvWVC8LGF2Znz+UbD8KRhgiz5IivPtkNlC6dRoic0lvPT1glqH6tjNanqEI6cJ33iaPoR4L2geb58anWYLGTG8v05AI2aOozYwozIRgv6G53t4zdKexc7texbpXLTm1+ad0W7p2y9lHvlemXcoepWAMzPl4PUqbji6GjQ3t+31rE6P1dnDXG8ZrmQpEILAYyM58kw3tltt7rDik8AdILh8lx5caFuaXUiVOso7nSH24f9RqV064OjB/ujFWuULDbPAdy5FxYqtXhw8GC7BaCUqwhIIXcO2oMw2WkPF/cP3gaOOoGtnQLb728d1UrenTutKEoAXKiXKivNt+7uvr91lG0t37sn9jvDeqW4sRWNhhcexaVyiOSYv59CkOOHCu5n3Hl+1yPOjAeZMLznx/RorW888cRL33p95d/5K41aN4/s2Y5EhWIiYszCtx2yeqpDESCMO7msIVtrzYZonwfTM1HobNLQaXdET6vhTj5C4DTaPiHI5GOHW2391HNrp64KbZ0vn/7Bu0cbXz7890l1mft9LUfIfixmM0jFAUlJX8RWwk6lCLW8nQbfcDpvG/HLSelLlUu1QkEnMjIK5FiXz9j0MX83BoTY4upQi0wiz5LFoEewngky1kTfNkoLOUovMAZAnXkAuirpqgRZwVqT7F3sp18CGyr5uh7ek+EcdS/CzRt7rMfmb1Suvnzr4Ktv/9GTf/NTzzxx+Zz4XvD88f8mP1I1NA4lxWwoCq3USnG76xwPVzp7sKqddg1gwnCZGSKzyuogPuGkzJB9ooI67Y2ZeWc0ReezR9rFhj/obE8LMjPZeh7WJ57SipJLuT3lJdlcoH37+Bc0r/pFAFmBP9/WZOl8wynX5pf4/Npi9aTnPfM+cpfPrzUApAGOBgDSMUwv0P47eEjh2/Nq80uLtz+43z6455WeYJ4TtoMP7t556+5ureRZUQXA6kI1u33UCX709kat6HqcvL+5t5aKK6vz5aJnNZYLK83K/NJw0E6Euv3BfRmH3C8++di8tb0nQsg43GkP1xzOHS7S9P2to1LRu762vNvu21eYq5da3eHtjd3FRgVAEJug0wEwVy81y4X3t47eeO/+2vLcY5cWpJC33v1gsVGZX1oMYvP6a+836qXHrl47pyFywgF5thCfcfDzGN4fqsycLfW4Hltcvfh7v/eVv/ZXv6g/eI0e2+lyOxIhgAL1CGGcIhcMcHrLqNVhRue6kg7jlqqff5TrsUSTdLPXmVb6wiDJ0nrnarUzaHsPpVZvK0N2p1apYWjhHsDte50JQSaT4O2xrWVlLOn+g7e7w391+JdYs0p5X8s1p9j0iiOenitmWni1+NsNB12dvonhqyZ5Xnt/y1+zIoyMZSaYZHpLpoSEWmb2FZkre1pLzCg1DAzGjONhSAIVpmOGDgyNBFBSDITUmZfzRI4gfiTmTOwPLCyCXTXeXZL0tWghLcThMvezDJzYqL6IP1FeXI793/h73wv+7eGLH3+y0x2eZSUY5dGbmaayYIAiEa3sDKyMwn6D4ycel0zz8rqF+0Aa65ic8ORMmGeyDtjzisnS5MWWvDIz884AvDLuObCFYm5huh0XrnpFVhxMA/3v9e4DlzNkP20l2NI9cLzQ4jaZqLp6pb99z7okn1O8zmSVLyKdEUtg8b1UbjbmyydSf/NdqTJ3WeY0d69wrKZZfE/i1IhkovnIcdn6xcLRfuGVt3euDJQFUxsjs9io2DaitbWLFZ+4XsM+OAouSKkvrDSvXbnQ6Q4b9dLa+gVrsKn4ZG39QrnSBHBhsblz0AawfrHglxdtbrDQYavTa5acG49drvjk0mJdSr24UL+0Ovdgu2Vf7anrC3e3+lGUVBoNAJubW7e32heapRuPXV6b56WiZ9/9Y/P+nTutbm8wv7S4frHQOorv7Q+yFI6zPe+BNA89j6aZ+7SffRriHyrBz2TumRJqb8SRWFyoH2xvfePrr/78T63Hd+845eIENWaeo+LIqFHE2GlU/fgd+bHjxSjJik4mqZM4PQ++n3PWqxp2Du7ttno9u3d0apXp0O08Sc/y2WsYAsMsD7LV6/GTggymZon0OsPVuVqd07/3RvvB9/v/IVssa/Qhb7iVhlNIpOCcQSqJkfMs6/7vqjQQ8V2S7BqxQpy/U7g855dgTGSUl+WHEZLx9EQJq7GMmPjJ0Ry2p9TGQHqGwoyxkhBb89yJgwydh1AASoTXqdvV6bYKS2A2miaC7kNMDk8kqMIpkOMFsmQwwneIArw9Gfe1tGFnFuX7Il7mhb/NLv7df/zml4fi5z799FGUZO4Aa5gpMzO0dnJBsjnXmRvSZofZlMf9pGCnZACgJjwtyIQ5pOmh4PmZtz1bITJIZc7seaq2QyqQcYWTfqyTVD0Svk9r7gWPAsi4v0X2XqyL4wYoPlfwWlHS9KMuoul2WAvlv4f7+S8nDvsKWch7dfXKRXMEc3RrbKTpir4d62E7V2fj+7vf9V13+eqlRy2WHuoqsDfN3CfwvTl35crleGe3/fbtBxaUC5Xa01e19av4Ff+5J68DcAqO1qo5d+VjH29i3C9qhQK/4j9eqlkOZ83ynlf7yFNr167NFb2SX160WTRBe/eNtzfv7nSuX5x/6vFVz6utrfeMSOwDHvMaGRxX5ntGJK7X6Pa3gIsXFpvcLz71+KpDix+bX7K1U+o4z5abdqiIQ4ulcmjboM7D2SucnIZkZqrEepq6cp5ImUci+PlnpYl6+rmnv/fSKxVffupmLT7oZR72/C94TOTzrf9nAr2F+AmktshufDe7/aiauzU+Fgtie3uQkWtWspB9liBjj+xhx2r7LEEme+U6p/elBvDYIv/v3+48+H7/PySLAAYUN9yKJeAec2wRlVMaygTAXhrZv9h9It5DuALnr/gXVgvVbEKTB3bMYa0ekoN4EOKN5617lAEouccSTUL06OmEAKAEgRKbcT8QcQnMwvq3xwW8FTgNCLuODLWyAv0yHaHzCW+eOv449mS8j2QXIvZHP+RuLJ5kpUUNAIGItZQW4q069HcKl/+rr773L4LWz3/mk0kqsvkzo3hIl8CYCWTHVB+TGkb9cWALEwQYjb8oOWZIaJYSVi8UFioUQNkHUFA8npnxMhPfR4GRwHasw1gqIfNDZWeWTEdCDSMWwa3CPo31mT+ym2JOyDAe+5pIrTw3Bu79w+MnLC2YCYg/45greNYh8wqVL2zf21q90t++l9lp2oFApX/2K2x0tq+29+bny8dJkA+b1GGPBdp/1+PW4XQGwDguu37zibn5e9bHYuWXN94OM6QuNisqEVnMepHXsrWBVXw7kolSRt3jxYNxlOqL2dAXkap2697GVnR3+3CYyPmlRc+rMQ4PNbsVE6lyCseQVOSjpaI5d6VeFUKHWSeqtbSPa4BFp3R8f75byioYj2R1N7kZLlmranY9nJ3QZNlQvvdvOuF9omXpbDne8vfnPvbMS996s0wuPXFxUQzCCf7+CKtFlh8ATM8DGf365xZndK4bzv6Fs2alwfa+6GkLvqxUOUOQschua6cZu89o+0xBZoK2y7a+WPL+4G4v+NbwP2SL9k7L2Y9n6Y2LqBl3PiDqNTOIPfM50fh0ZcnW1Y9lEGPyMneWDjb5ZfaAsW7jEeYZShnRegT07Thsx0PL0+8T8Z4J96CfJ94VWrIB8aO0yHHBljJKXQZApyo/DnCVkuy9ngK00kMj+yLeFGFLp+8h/IYKnifeErxFwi3EByKuOL6Nt/xbZO03vv7gt4Z/+suf/aTjOFGScv8ho+VLjumLyZ3uyOM4ls6bnt1D6P6YLeUXCdtfWkF8LPvICOPo9mmgz/evWp9MkaiY05mS+kwWH+eMMUYaMDItyoeGNcZz1jjGo5fmgHaFiiD+ENfVi5VnHluZs4EzbQA5ZAdgjTHNitPvYGZa5GgN2N8N1p84cbKfD9/PeTguW1q51pxTlom//9473d7gSr2UTwGjswqMMwPCskdmkZDD7tadOy0AzXLBd1jWDZvPCDstup06Th7QJxnrmcbHvM/9vILy2CRjyXsWgX121KrNDwCZ5Om5OatqJsqfkb5tj+c+9sw/+8bLv/BM/OLza2IQ2rT32Xagmblds+6cKbBkyG5R/jSst7Tdut1HgjtxIDuAY4uot+91rPXlbKkdCCyyz9dob3ynhe+7Uw6ZabW9K/VOED0YDsir+t8lTcuH15xi0fVGlkepPOZ4zNlNBllI75skvOelL4jyTztLlYKb+dYndO0TOH7y5LCUXOekE9vKNNTCCj7W6LKtwiOi+0TsGgFgz+hl0L/tX1wtVKnLdCIjkcpxmdczFIRobaI4sbezxSOBglBW7o9z5MMn7Dm/4THnl4COiG6nQUun95EySupwMhbf9Io+Yb9euPQb33vwZf7Wv/XLn3GMPCffyZPu0cA8ZWwYup1NWvbZILYjZwtwCYy2X1LPp55TQjyET3UkRGwHawQnxZkJCm/19xIjITWJw4PUnDZlyGckHzAwTeon7smr88fF9QxtH2DQ9KP9gAB4cs2d4OyW1Ofp/IltyEKhVKuvA5awN8HzrafI2pTmVvNhMpNbM9FP+h2MlffRMKYpfI9NAYDUMVABoNwV4CjT0R5W9LPTM0aoMb+0uLZ+4VEXiek0MUpZMozfu9+PosROBEZvYHMlx+/4YSZynDNv4DzMXUrJOc9g3coyWUH1DOaOM82O+cUg3+A6kfp7Gqzb+2369qdffPEP/vVLm/tH/+bnn1HDDkqNmfiuEsFmRu0boaWTVVNn0vYM1jOUP43F68RYn/vxlCgjtrcHFpetc7HO6UOldovd0w9r9XqyrZenBJnpyd1f2+g9uUV+VS1oSKLkJb9qK6i21GmFlN100I6HIOQ+Ed80g2VDfx2rq5WKNtBKg2AEpifhO4/s1gxz4i9w8suhFt1w0Ke6qmlXpweQVjmx0LRCHAAv0tInS4uUkiw/AJSUqGP7WLMzIEP2RAmPOZahT9siKedWfgFQ1ZQ6/IZbcblj6fw9PbSFhKsGw7h/ya+O8P1bD77i/et/80ufo8lDLri8Wyaj2DYb3bYvMce3yFv22VD4SsQMfl8kgTT1wrgjaRTF7COJRS5p0pL3mZ1NebgvEgXGzs+mrZcm8z4WicoaoDJkjxI99gOejPydK3hYSABcaqyuN1a/1bqFMbg7FV8E8UyIV2FZHUbbzuC1g/cf9LaBUb9Shu85J+V+1pRkm5g2cnP7NjrbTw9P7kkzfD9ZYh3KyYVMKJJ1Fatx9TVD4TwcjwchORbWPa/2qLOWppEdQLe/FXQ6lUajUWb37g/qtfLZbsXz4/u5HpOcVVA1RnHOJ5h7BvcP9b1ktpnpqZUTwdlnC/enVWVHCqmRv/C5n3rl5df/h3/xrX/ji59Uw47i5eNNlRwg+zIOj2dYnxLAqxOTn4GV8fTzqO0Zec/P/wuOjpHd9iL5Fy48qtSe0fbTvI952l7n9PffaV24g191FqzOXqW+jfDNvORDIzfjvk3o/Zrp7kH/Jdb8dGVJaxMZhazRNEP2vCBDCIyxWY+WpNvbE0Q+gWonYVellvq/heEtM7SAfpMUGSVKGwBXePGJ4pzl4ODMJgNrA5jcixvAGJqNjuIMBpzSJvPAvFDLoo0O1hRAH8dA3wWQjMbRUce5CPcidbeQtnR6lyRVOMOk/7g3xvevP/hy5fVf+tlnu1Z2Sc3Z4UnZcAwmCBDNrIVaDScbmtpFpATBuCsKQMHzxTiNgDmzZZmzq6azavvESHNO5/ts5o5cL9LEcZHWTGHkn8lIff7YPyROxa97uNMdfpd+T+6iSyzMjOIHZgXR7FdXr5Rqddq4vBIFdaf62sE7x4JRcuJqYXFHnjKPiVN/Qhg9G4Iz8cRKJdSF4/4E5l8fX5ZHMYCKTzaPZJikV+qlvLyOP7NxqWegvy2optoUCJNSAsijOWPE8veZFsmz4X7C/TKTs3+4MuynPvPCW6+99V/85nf/+hdfKFYQHA2KBQFetgOblByHpOd97iZXbj1l+EwG6OdBdkvYASdzXgZHg4N7mxmy37jSmK/RMzi7ncWRoX8PJQvx9sZMqR3A/uDQYrpt4Hjpg2DrT6O/xJp23mmVcjvvYnSl5EyHlrA/T7z/oHjRY461rluPo13JEygPbKL2cszQx2g+up1TS0bvopIDovbHDOI5Ui4ZwGBIEGldAH3Ob9jqLojdTBDKyEhPH3euRplSQthIvgcDQYFyOEwbeHCtjg8PUuuiFDE74ZS3yj6E6jNOlCwTXuVFAH0tWzp9N+kvc3+ZF369cOlf/d697zF185mb5zkPS46x3vOyj0q5bkdg59j9iavDzj+yI1gDaSogSGKL79PBwpnaM/1l0eexVolde07n6dFYW59oVjpboulrVqUK1ueeyS82Z2au4D3obD/obJNamdTKmBVLcEyZg7jrR920hT2AjJwzdsEArWEnmMb3b8XhOrCwdH3+wuVyba65tHJ3672Nk6O3P8QhFLHl72kVJVNFGJ8UVWYmtuPRp6fOzfs7u7BWnIVGZW39gh2R+uEEmUfQiE7XZAJpSJrmi6gWzY81GWUAyTnPenc/hOPlDFg///zVfH316eeevnNv5//+z7711z6xtv7kShwcAUearxTHM1XDIEGQFCseICYSIrNmKMK4kb2ZbpmMmE98195jZE/FEXUcnZgsGuzg3maW0ztG9rOOeGdngtdbZBe9wIr101K7bUmdq9WsvfKVrvjKy4O/xo4ftuZXC4RpbYZGWus6jBkw8g2n043NrzuLT5XmbN76MawDCdF2JZA2LSAbrpTBbl52HzP6RKY2P7Krksxy06DuRe1YtcSq8UPIy3CvVec9Qy3lz3YJWumE6HxvVNbiNFpm8u+bG/lkf/hR5gwhcM080dbcSVWqpRwaSZQEcABZ1CBKVh3/ItyuTvdkvCfjRfAvlS/9/u9sfnswuLK+pMRkKGP+AqlwQj2fVooNM+iQchkoBiJ0azqJhwJKxNuRsT1KzPGtmb3kGMDA8TAalk20ICUnG2lNTkP2/LdKtjY5S3U5G7gnDluSnfmtgkOPfe5NP8oU9qzvlNTKGV6fdlj+3vQj+0S7QpjeYKuGmfgOYCMOF4ItzD++fPXS/Hx5rrlcf+fVu+3WCW5ebcjTyXsQ8zCM4J5L+piAV4u5GfjOfsojajX16sVKI0pSUSp6Tzyx7Hm1LFL4Jwvl0x5B6jiOKLqOE08xd7sdUyfXfIvvShnGCJmadj/tYZ9JsafvzA9c/RBrQ3ZPHIlrVy7MNWr/5Uvff/KDw1944epcNdbtrVgyzVfswzrtTqeNRrNRHAfB27YmLQQFLL7rhDN+quQyE9/VsJulP9o6qkrE4P4HrV7vzfvDZy6Xzm5WygSZPLJbtm7h+26vx5t0ee3iaYKMGgY2N+a3v3L014bF+lhQWHOKnNJWEmZsnXK+qaP/znQ+Grv/SeWxCnNGNkdz4seztvSGWxxqMTSSK5PVNk+4ZYwBQCmJxAjW+1Tf0+F7CGHwHCnfoEUAfZ4blm3M4351xatkq0WC3NBppcCZx5zJau3Jii4lJwu8s6q7HphHWclzVoAEynZU7cmoJOVQyVFZlXAAN2iROvzdpH9/sPcsr+Fr7Ts/1Z+rFocC01bIDN+rSawD0QLmygMAKDMMBHw2FDqQph9rxcicMzLLKxEP4dtJqlXASeJ2YiCjbnSM5qdJ7aOIAmls3dWnJgGKREUgpykzIzGdkTNqrdmScKIA6zowilsa7uTgNw/lT7rXm1edl+6+3IqSpQWT5+z5wyJ7xv1HP1ZvsFXDC5i7NQvfwzBq99RiFbzaWK42qFNo7t+bay7/mPDHZf8MSn4Cbbk6m7w/0uGV/OeevB5drvJCJcue/B9ThDnXIqcMYyqTZc6jtp9ByfPGmEfC9IfqP53usOC5v/Jzn3nth2/+N3/09pc+vfj42g09RXUPeoFTq6xeXj6W4O2CJ0fdTNPwPWZDtZGqPo6BtGg+2gYRJ/M+Du5/sL/T+97L6ac+Ubq59vBx7VZqn+bsdvqSPEVqt0K8bXRq9Xp/77f2/2pQWOOFTJDxCbsbdrNKY1XTl2TnVZP8O6zxxfrFLBwGNjzAwveYEVumXOGu1iahykbQnBDiCaEEkVFhkliaf1uHr6nBCnFeZPU1p4ixD32E7MaAkAuF6kiKGW8RsjellMDlJz9Wk4E4peQ4pAwOtTnd03sI+5q5tDLL+j3KKr7b0MW8amRFm6GSJc0f96oANkXYoG7wreDBs/IzNxdmNiVZWt0fz8VuDdQoerPMWgNVckw3gnXOnCD7iAGvSAR8BvgVNRn8e1r5NLNLBifF8Zly+UO/NX5NPlPY8Y06UVBtxwURxBkHP/EetfLc6W53p+Lb5JO5gkdq5Yu0diz1RMkrF2oAsBNUV68A6G/fayIA8Dbw8eai7DPLyhcvzTsFf5Tom+YC4v3ZV5Rr+kB12hTREqWsapoR8wm9e4LQ5ZF9Yuzqo+K7V7qM3BiQ/0nUmCz3LpDmmEgZwojJaHtG5zMR3lZH86HYs9dOv+gYOcHuf5z8mZkbgkzNf+5jz3zlu+x/9V++9W/91NGv/fQTNpYdwGjCai/Y29wCsHp52SkXtZjc4uTLqlloTPZlhun5tTPT2TNkf+mD4DzInlnaJzh7DUPRC6yqcxqy5+uo//RH+78S8Cu82B//KFVNd+JgQFEee0h+03Rj3/xtXFz1KzrnaxkhpjnherRgety+xJkdgmrvoQQgJJCpDY98XQ/6EFU4X3Dml3nBDvEI00TrUT7MEKpE+Hq5me0VMtilFHZC99Snn6PqlEQivZsG2aZzmRfm/BKlBCDHjyTEYnoyMWrYjEesGOOBek6h6HrzUrVVQlUaiPgA8iDpL3P/6WITAEL8d292fkDNx68vFomwLkaMU3zPLnVSz68XiJ3OYQn7WHgZjcmmlVoZPcAL+vFMZJ+QZSYGt1rZPRTSZyT/DautT0s0+ZD3jOZPdEIdvwhhvlE8k84nOLhF57cPXyVpOV9uPehJAIs1niF7/immN7ABk9lK8NrO3bmCh8aqHb+X2W3XAdhw/HzkQOaQyZSZfmfiTiMSx0RHiTm7oGrxfab2kunvM3V2kSo7FW+0ingN6jiOy/D/N8dEJKQd9/Fw2m4II8YiOyEso/DAiUj3syFexqE8c7p8Hsdz/vcTNdhppX4C+gXh3/3RrW+/s3/QDauuefz5y7ci/Z/+zuufubnwc09daDQbVO4CvlOrzAF7m1t7m1tPPPeMzW0HwHyH+QUVRxSQ/SOS+6SzJOFjA/vkNlhk8zf2d3qvbg4+81hl6ULtkZA9k2JshkxWhp1diu/1bB0VwD98eXP5NfOsU7PIbrvt+9CU8rKUlPO+lr9j2s8T7y96l60EP7X8srxz2vLikRlxXOHMnkUJIpHaIR63dfg9L7iSuJ/1FprMgx3bZJV3m+YIDKEqzihbeOSryTU6Hf8s5viN7EJiXfNDLbrBYFuFY92ZaSF2xDiR2PUKtg/NGG0wwdknIH4UkCCVpIRz1uTFJopS682439dyT8b9UN5wK1+sXPxIXPvma4f3dnt4wtxcLGX4PlIaqsVK2csGaGTkHUCRiGBsagykgYzsTI+lynjDGvSmofw05p6PgM8/Zib1Pn8wZP7phBN7u0qVSVU04S7IexxHCsxCMpf9IQoeFpKb84sA3jtqj2E9mqnn5F9nH6kKew+Ko3Bg66zf6GxfvXjTSx3s7NrRSDIKWkC5yHE08KqNiaFLst/hVVisH6au9SrMvD4TJUojbutk2ssZZpVMlgnbQZp0Br0uBnsACr0BgHatXFi6WigtWfeLXS1myjgiVfk1IAPfR9VSPoS3fabt0mruUkiVKyiN9XdpZZmR+D7+sS345rF7Gui5X8TJAZXT/UrZkSYqg3jMck9my0CjzAB0BgpgX/nG6//Fv3zl6StLf+7ppaVGCUAijZyvfeWd+//kO9tf+sj8Lz8+DwinVrH4frfX+/KXv3/16cYLTz0D65X0qk6taBFcxRHzCxmm5yX1bMCelidg/ainb9/r9OP4+bXyIyG7rZo6tZEyk0f2mYM4MmM7K1X+5I0d9sPwC85CFqKSMSEtZZ26r8vBN83gc6zyxcpFrY3Oq9WEJDLN03araWhtrAfxmFDnzDDtONRC2lgxAL+O1ZVKOVEi1NJ29lvRwzKJIdQlv7rilmEmXypvk5+EeMvWtbwbdgMRW0wHITRn3OpD92VUTRMA2TCmkZF/kpaOXnMUusAZl0qOPfSc0qvFuoX4PRm/FneWZXTVrfyVypV3Wu2v/uuj7z8XrV9oZvq77TgtEmF1GEvGMc6GDI0DJMzxK4hHwgsnlbI3V9YAOqSsg94gVv0weSjET7D4s52ReWSfkNdPq6lmbneMAmfGf5DTaqSY8rPbYumXbn4KwO+/98et6FhnJ7Wy6Q1sgEH2LKvz2NvvHbUBLNH5eqgxntHU3t/NbtjBHdnRWFq91r82P4XvyNnYh70uKosz5BH2EGS0QD82vINSJlIVDw4GvW5h+w7vBXJtBeXlqAwM9gq9AXpvRDc+Qp2LealnckUZxtFwv1Ba8ko+pUyIOBruR8OwXKv7zuKjCuvThVP7pb1xziT30QfscJcjlTP1d1tQlRO4nGffM7D4FGSfFl4ssp891NgvOGmidnbbX7u7O0wkgGAQ/+mtrY9dnf+lT647FN2hAHD/MHj3/kFrmHZC9cOvbv7+G0cvrhc/c7N2tVZzapWrAIA3Xm2/fvs7Tz994+PX51UcqcRxqg7gMDjTO7wRnZdSCzHS3+QgDo50X1nCXvX9cyK7GgZZvIxtXDo/st/t9WqAjWjf+lb/c6LRH38cmcJu//9NcbAHnbliZlYpj4dgEJ3H3xH4juVs22iah/Vnee2p8rxWujMeUDxKlFQJCNFCDBh5urhYos5k/TPvW591RFoeDfqWrdu0gONEyawMa6/u8VTVME32cp5CGzBwXKs7OQPWjvUYvQI0p9RC/HKa7MSBjRuz0fB/w7/68usHX33tEM+x9fW5LC4mD+g66LXsPejpJAaI1WEqiIOxINMaPbZnR2PbRYIVCtYFf0ZBdRrZbU01k1weamnPvuvbtBl+jO8AYtB67mLta8Ztd1IG5XlvjLXQZMi+f0jm1gCANCuXGqut6C7GqTIvaI7a3CsN+Rru5oqu8bFu01oAsK+P0J5/rR3Um/bke6fabvXlwfSvsdHZ7uxvP3H56fri5XoFAFjcUX7j6GgQDcPjBshZGGeZ+ygTfIzgedqe3Zkx7mF3K9q/m/IGauUCIMvL86s3ABBz6XDnAb/1qty/ywuV4umRgdFwH7ffaK9eW7nyBPMcDONo/26hN1Clj/z4tP3ERL3cAnD+Oqo9TZUhAKz4bu/n/IT5Pd9ZOqGkz5won3UnTSN7nrBnD86WCkvVN4/kn3z77W+/s7+13yKMzhVd34PnFj91bWG+4QD43js7b91vC5A4FbHQLncBNVf1Flbn3+kNXv2T/VV/94nL80sVWkvJhUphJ4i+/dKrt96f+7mnLqxeXoZxpv+YIy/NmKpDDsLIoXJX9tX+Tu+DAwngyoXiOY0xlnTbR/ZQcsYniI35PQPZrSBTG49Veu+b4aeSCma9YV/LbzgdX5C/7edE9nyXqeU03B1RaTOW10cK9Uh5B0YiTFelVU1f14PXveHnRMPOTbWye/5992QEQoZGVhz/uWJ9tgoEHOszuWKpx13b1Gq9PdcLjYXqKHRepwoAHW8W+Ql+WRjGSRshVGp/cWuGGRKk1Kjs3RPL98USPBsFbBcMLpX9A0qtG06h4RSa6eBB3N+E6KeyKvlzfmNZ+l997egdcXjjwgniSCu1CZnF6vLVogcgy5Cxqo79lsV9+wDqeQBsjthMWLfD/PphkmUCV30K8F6cnqGzW7HlNNAPDSsKacUZz2XhQEbSFIkCSF8zJSRv+lEbIxDPe12sEL8fkH1YpkwsxL928M66WJ1+sD3ml+eA1tadIgCnFh2L+HOHGb4v0dEonAedbeDY3p4fu4pxFPD6MJQXLs3Pl1uiMYcORIhHPGaqMSdou4ijYZjyxtzFteDIQ+9OoVQco3+hXKurWkWefGKmzNgCbBzEvVan2AsKN4pj0trhm7uoVRh3H7VMmv1/zviB86jt018yYiYMM2fk+uJkXtjMKui0IDPTCeMXHAA7u+1/9IP3f3SvBeDxC9VPXrsBYBCnb28FgHny8vwgNV/+/gfv7YcuZ0ppgLicxUmyVPWevTZfcjhq9YNh7+W73a9t7i4oPH/F+fhK9ZnLJaB0b2fw2996p/72zjOXnaXywurqqUPVw8jR7X2L6f04rvq+zRU4OzQGJxtQ8+XT7Pbe5lYPOAPZ7QPsROzv/GHw7L4p0hMftOXsfS1/R7Wf195fLF0sOG4eSWe5K8bIbsefnixjWli3G4KXMNw14texemm+IWM5gexFytsqsabyiuM/VZ7Ph3zl3yj/FtrAmjWLrtdOknYSUs6bTtGy7F54wqbB9fGf1zPUakFW3z+AjKAtfAOwIQexYwD4McE47QDAPpKi5gC0kPVimY+t9JyOxg2uuOUm8+6mwT0ZtnRqp1b9euHSy++2X/lggE+XqmO2jtxYR6u3KJE4zIxna6ghfGutybwx9QLNGqAAUazQ/cCvIO5Gepq8M8ennlcFgMQuAPXCaNgTpgYqnS3BW56OMXmyyO5TY12VWaE1tGaCaXsMANErWHSePuzQ6kuNVeuKedDZxklcnn5i3cyhqUFM3cytePMLy7W+PABqJyc6bWeKfB7fqe8Ay9wbXaJpnPyYYJen7VZmKZSK5VrdocU0TngvcHAs1wx63QKQ8oZDi3adyBN/EcVKIh4c1FoPBBANQx60EaC9v18cLQZpPDiwVdmZ6tA0Q89T8olnZR6DR0qCPBXxleEcUkp27nLxTP5+nq5U12MAiyPxo7c3/tXLHzxoRZfmCr/47OpcvWRU8ta91vfuHO53I0rMv/3Zx+/sBn/0+uYgMUWXC60MtNIkTcVH1uofvbH89v29NittH3UOeikhzkCawKiNu8mr91ovHg1+4crCx55Y+Rhw+17njVeDbrpXa5Quz7s1gDS9pvIz1twDZFvvBFHZIVXfv3KhaKua5wl6PEFoahRj+6PV3G2N9OYsP3smyPSAGuDUKn/00ntX9tMrvJYZH6uadpEC2NTRK87gC7r65yoXjiuixkxI3megvKXS23HQVakWos68bSO/jcGLrP5X51d1qmQss/lKGbID6Kp0aOQlv7paqB4nSmY7A3NijaGURGliC7PU4TtxMDTSMF6Wsi3lCe1o/CJ16trW0wFFS6d9iFdNsk2lMmarSAJGKsq8GPJl0BXiVDEK2OgTAaAKB0ABNIJu6bRqf+BwUC+WkctmyOxDV4v1euK+IXqR1ps66qfyE25zTRb+xXcPtz+Nm34px4Uda6qxIF53RqWass+GQtuuVIxN66xUoK4LHP/plip0P/DZrD5VK+6Hns8EqSDOZoB4LgtSiVxuzDRJz+4cwXoe4oGaTxdKfKhMO5gqj02o6tMAbVHe/p+xdTuFw0rt2VPsFL25glefLwNYX60lR95uctAlLVYcAKPiqzefNCtOE6sbnVFKwZbuzY3NNjYUfgLfPeaUa9hPflwOO0HbR+HsBQdYoo6TJL3h7m4RYNy1yD7sbhW27wBoLi1Rx7FwbE04Vs/JlPrgRzsAKrU7wWCv0BsUe0F8J8A1OLffaM9dqs2lpfpFxz3RsxoORwOvZ2eXny7RPCqyM2Ly5P1YljEE44SZLDvs7MM5vZQ6E/Eppa7HSlxuHQ3/5JU733trE8D1C7WffXrFKxY9MdgZJj+8vXdnq9VNtO/QT19fbAXJV3/0gHLmMJoIZaClMsYol3MAf/LG5tHQGETDKOWM5X+Ae4a+fyv+Vx9sf/Jq56fWKx+Zd29cuWBVb9nWLQDt6G58Ytxu1fdtaxIAK50/lLDb0Ut2FGre+IhcdAyA5TOR3Qoyy2sX39vccr4eP5tD9jpz2zIE8Lrs7Rrxq3ThiUrzVASfpbwfS+HatJJwT0ajBC5CbusQBH+jfLVWLFh5ZALZR3qsSgIRP1VZrHBXK513xJ/A9/GxHfWtgj80EgqGcYCXx59MxsRBYMd07Bqxp/S2kcqYd4q0E8lIa2VrvgxZUNImV2suuxynqzqH8pkQOi4b7skY3AfQj/t5md7lzmiMidZVx/8EYTZXsoX0tbjzuFf9daz+xne33/s0bi6WQuPoJB4KHQBKjOh5fjBeyTFwPGbjxlxSMhpGzwTxbnRqTbVIhHaM3QRMOCOnSbqtlGb3VFySDbhlDldjQabo83qBspwc1NejQtpDUo8PehII0AMQLI4fbGMdX9ActLZVO07xHd1o1B5gm9TKVb7YvO4sBLVbKbI1oEtaG7mgATu74yKtoTF7jofF97pTvV7kcB4+JccLj4Drj8riLXDLbrAQdew+ehC0g6N9i+y48RE7agMAuBKRELqXN6jYS9q/Volqo+1FfCewF39UK7u+xwsVLUQihNChHcU3CNqtrU0AcxfXbNjvTMiewPczJBrX92bGy024ZSyyZ1h/WnbYj+XU1JpSauWXNFH37u//3vfuvvegVXXNR28sLzVKDoXQQBh+0Iq+/daDvuDVajk46lZ9p1p0v/H6fVDGKZFKSmU8hyutiGHVkr/RSRihnst6g4hSqrQ2xhBCoA3hHIBDmXD9P74bfvPu8GrN+aUngifKpQmlZYJ6H6P56UNQM0zPYH38xEdG9sz7uLx2cSfl3/nD4FfGek5ZowraliGMeZOEu0Z8wZl/ojgHM0MPmc5xzPNoABmsYzx1usPMR5zaaqEKQMaSUjKts1tjezsJn60tFyg/gez5FcUWabVJiM5sMJnBERoDCpsc+apJ/gd+YqudEpJmSzIDjQ0FYYw5jFAwABpqfAPvCnmLaDBZJmTNTV8M+fPEq8IpgGb4HkHvybhkAKBE+NBIG/UOGVU1LbqeSx1ben2aN/sifjfpR9DvJv0btPjrzurf/ddbOz9PLjSL+2MlPTuywXjU88u+pfAjdg8wux4MgPxYVJwybG/isFOcbLx7xSXBlBvSEvPMCVMkCuAZpishmTO6ckuMMMdX0Qy9ejIVMk/eRa9gpwogZ2zPaPsJQM9lQNpvHe213jBYX61NbwtYcfCgM8gUGBtiM4L4U4677Vb9cH5hIVc1ldxuiC64H6ZfyBLwPH9XEtEwJPYavvVDAPJHOwHAP3ejWVpyXDZywUeifXBv5JVculooLZVrULUKrkE++XxlfglAa2uTYse/VsGNj1QKFbsMtA/u2aUiWL3WXLxiRFK8ewtA4HuYP+bv0xA/cY992DR/P6dalXUzWaDPrJCO4/ykwN0aYKz88s5WG8ATF5tf+tileskZpGYYCe5wj5ODfu9Ht4/2A0mp2YmSVNFhat7cHiTGFmkNo4xRKK1ch85XioMocijXxvSHsdIagDGGGGPGIWhSmUa56DkacIQ0bx6pd77VfmJu8OJ68dMLFaDTalJL0stsCMAvV85TL7Wwno3APoPaZ0M5soyw07yP9qVe/pe3P7VPbF+SJQWW/N4lCYC/4l9YccuzZW4yClycJu9WXj+Kh1lKgZZyT8ZFxn+6eKLzqBVPBp+53Aml2JPRerk5Kp/Okn1sO2s7Dm3baobsdpCeTZPvxmabypeo6ksFCe5wChBCiDEAfGc8C8EKzeM3kWOZUkNSxiiIzzgYNFQsza1EvoX0clk9PTQf1W6eyEfQEUEBdAhZZJwoae2kXaAbp5TzZV6wg8Krjv8cYXsy2pPxWxiuqcKvO4u/8UcH7Jf8kmMibfIz3fqxhk+DfrxaBcYIrpM49Gxq4egXH8Qqw3ebD8zGUzswjncfClL2J52RJUZQZLsn5+1ZWA8Ny/DdMvSMs098HENl6iIeKhMaZk2QVnAHwDPXYya5tOOCNbp0cCKAN++MtPieR3n75fHOLi7sB8fZOOO0yBzP6A3QqMldAOX1xkMoeV8ebBw5hdLT5eJPjGlO9KyKSKRxQnchEOAaLBMH4PQG7YN7zcUrRc8RqdrbfLfWerCT8oWoEwGFq0uZAa4wv5Qfk+TUKtYZKVJ1tH2b33rVgnEBd9JaPSP4Pl6VtYq88ZFCaelsf6QF+nzRdYK5D92V3Bzy2VXNDN+VIVZ2ny6NPupfMvPMWLb+u994/XtvbfrF0t3d9oWa//mPXq366McjUyOAbhC+fX+vG7NhlAoFarRQWkhJiLN12JvQHLQhzVLx+qL/6v1Iay1kIqSGRYpxbq3S0Eqx0TRnrpQEVMFjALsT4J0fdR/ckE/XKFq4WAqrvg9grknR7lhGf+KPM2bo3VyYWp3T85hn8j7Is5HdSu31t+JlXtM5VXpA8R01WIHzWW9hhOzGTCP7JKznHtNKwp04wDilYEunLaRXePGJQjNzttjG/QlY59pYZF/zqxWejfhgE4mSCVSYJBYcSwYlMIvpdlLrHvQ2kasxz5Dd5ZxzMgLxLIpyqniolNKGcc60UnQkRIxORPtgSlDkrnbUfqx2iH6JqxdlsgYnk2ssl0+pgZYggJYhUKScKAkhAxFf8qtVx7c7lTW/Whfuu0n/ng6f9+p/STf/8f2jJ64vYDx7LyPFVmCJkhjwMwQPBglcAkFGcs0sZSZP5ANplIhDU7PdUlnE2KWFul0h1GGYMfSMnj9cpXAZgDCW20A7VLEyBY8yhyghY2UWRi1h1ti+kIxujHPo82zdIrste8J6H8ckPTssvr+g+Vat3Ixa+wF576htnzjhqhx9omEPwIq3WOW1ZsU5IxhyS/fQwYXyKtBwfQ/nGxdlJfLzG05c2eHXKnJtxVm6OjY4hs72HX7r1TZAnRu2cArg4rVlvSklIHQ46HXJMJBrK01adFwmUuXKTm9B67lLJccBEA8OCtt3BBBefdI+nTieEYlTqzgfrQQ/2okR6LlLhdLSGXr6h66gGjVj4HrG3xkjSpnzpP4+VIrxC869+/t/91/8yCfq8x+9urZY6faX3rrXAjBuz8ZRP3574yBOxe294VKzmgrbxyhToXyXE2jKWCq01hqM2dabossHw3C/awAutYqFNtoQajuwTCY9eR4vea7WSioKMrKKGK1cl1NS2EnZf/b5p7/2yt2tzhDDpO66/ZhUfb8FDYxUeN60ddHJw2LxGZCdaTJn5wBbZLei39uvbR79cfAFZ95WFK0mM6D4jureJMVP+3ONcSlvdu00C1PMM7ic9dAi++t6AODT/lw+BAbGhCKZkGKgjaRkL42uFusFyrU20w2idkmIjbJztxcJH0La0XrA6A9e90kdztup+BqEMsR3+EwoP3HmGFAC5jhaaa0UZ1xDAZSCaCgAlI3WBsvrKSOcuZEUX6fy8xqAs2eSup9eSdwGdZU2EQyjxNUEQKhlRLStvj6I+9cJs/w9lcIn7HGvuinCd5P+4171xVvD7+DwiesLtj5qs70ydNbUp55npYKyzwA1TJEhewb6oXGCNFVh0o81AHUyl0YnMXw2JNRy+dWq/8xlB3D6YbLbnexTzddOz8J3mcbcjUN1NJBZxFhomM+w5Jlj+M786Qc92UBlwvGSdSTtI7X4Pv1OJ6YvWfZa8YGobubgt2YIT6SF1sLKCh67tn6xsXZ10LbdTNMobydr7wy2Xd+zVHGUUqtnxNDrWOS5eWYonEb5vF9F6LDQG6BWKaw/W640RWpdNCIqFfGDbxe278S1ent/v9gLnFpl2OsWAJSXrcGmWKrI8nJGrjuH8UKt5sw1LNYPel3eCwDUWg9ELwivPjkHDHpd1MopbxSvBQCk781E8A9njLGjS04rrp5UUE/kEHwI2p4h+9e+/fZvfPW1L3z82ovPXIp77c2D4A9/eP/qoj9XLw0G4f394Kgb7Hej2DCh0/maHyeJAmAgFBiljFGtFAwB4HBKCZRWnutxRlOBjU7CQGxxlVBipXZjDAW0gTKm4he0UQCkFEYrQhkA+3/Rxxvvd773oPs//9JHvvHdd9s7oS2lHsN3czYlzyn1w2k0z+D+qKeBIM/rpzWZbCoTgJ2Uv/yVfTuCg3JeltJy9nt6+CKr28Fy0zI3pSd7/U8q7rvpoJ2EGax3ZfoShg3q/mL54mgEx/ilhnpSZAcgKemLOEP2PKBjnMXYF3F3bD9vEf1t0419k/cm7hrRjc0mxFchXM59TrQylBGAanUqVLmcM04IKBxIraGNwzkAJWfTfK2MhiwAMWN/ZOQTBfKXQjeGAdDRqR3PBI0qHDYeAWVJ/ZDgdho8zZsW3wH4hN1wK3syejfpf4Y2dt8+2KwO1holy6xt0m9WPs3yZHTQG+G7IBmyh8bpdnrdSA+VaYcqSZVl1j41RTvN1adMEGu5sbuBbElwmKn5VIk0czHm3DtsGuUzwd2nBq4DjSRV1klppXmr49cKhs+qoKIzKqIe83cRxPZbDVRaUZiN45g+XqHSdAZjZM9ZIYEuaU0GCM8d7ibatAN/ya2tP7GwdKV/tNVYWu3sb09DvK2sFr3KyHQfUiVGnNQkknhnKTZ58/hshiuSnZQ3FvxmrlJKHYdxVwCiF0S9bvHuLeuBKQDR6rXm4pURZAOFUhFAMozbB/cWog4Axl3mOckwLmzfCe4EVuSRayu1uYaMgsL2nd7cJbtWObWKX6sDiIb7jLuu1/jxCXsOeclpsgwAjIZ4nNctc5rI/rvfeP2fv/TO3/zl51cX61EsHnTV7//wgZDJc1fXX7611RkkjbI3X6/EigSH3cMg0YZQxrRSBkRJWSx6WilKudJKa8koB0BAhdJaaUIpMxqE2GuG5BkrpWmSln1fG6XGT2TMBYHWihKmNBKhE0r/b//y/T//lP/i0/N7NXH7XifD9N5DYH02T88T9umwsJlyfHb75X95+1NJBRyZIHMAua+TZ3ntqlvxssaIsdgygnUcx8LYkml2p0X2EayL5HUi3jPhF5x523SaYTWlJFBTrkfOpNbdcDBfrk60KVk1xuK7RXYt5ZsYvmoSAMugVxK3Spz+2Av4MpLvcN2Xynd4RrfPODjjfJxiZpcrzpiEElI7juO60JpJrQGttCZZuZgRrUxKCGeEgt1KJIp4MeT3/PRK4q4QZ9eI2Dd+LKBGq84cLQHoQkDLjUF7vTzCdzuvdZkXAGyL8EVW/53vtrt/jmaDVUeSS66grYOeDZ8JjQOR2Gke1PMfHHb7sd7tprY0OtLNhQyBXqy9kdU4mpid3W0nNvag6PNYk3CYWE0mixPI9Pezq0NBaszIo8nts5Y8VnHcSUBsoNJBMByMGFypTDPEH9P5aKzhnIrvGIW8QwRxGwX4LQvudTNHaniusbqle0d7rYy/v3bwDmlWruGaV22sP3a5HlyWzYWrwc2OGJh20BX9diCQ9rZ0b130E1kFwBFPqw1nCNYzUTKj7Upi0OsuRJ2QP0kdJ8sY0EIMel0OOLVKGCcccFYQXn2yNtdolpZsmZSPPRJaiGi4n0G56zVUIqLhvt2PW7WnUqgYkQy23y0AtblGr9XhQG/u0rLXaB/cA1Aonf/XOje+q3FCAKMTBVWbQMA+bOJxlKSlgv+bX/3BV39w79//wkea1VKSxK++f/j7P7qfpsn68tw//NpbhJJnrl2MouHGbudBJ42FkIoQQhg0YyxOJOOcagXGAENAfddjxCgtKHXylt9EKKmURXZijDaGAkpKRkjJd4dxWvI9bY4HKx6zZmmIMe8cDP8vXz38335hYfmSs3jl2YN7m3mIz2P62VVT5CztyEXKnPMv9p1b9+tvBXmp3ToFZyN7nqQbQynJRzxmTLydhHXqbovwdZLc81M/Jr9euDTnl/L+dPvEPLJb5SeB7ou4XixPcPZjt9WYswci/jYGP6LpU55zJXGX4GVdo1U4/4R0/whSSeOPKn42hMloZQAFSpHbFDLOuY2+MMaGi9m3ZpTAUEMhpWQOp5S4lGnDjFGWyEslszXDbgtc0FuJ3OTqMynrGrMMepMUmSCKTP4uVqg5gKRxf82vutyBRGxUbJTF976WzxPvOwfD+uV525ta9keWmBNmp8GozhkA3SjqRlAiOtKs240zZM+XPZWQoZBJylF34dNM6skSygqev1pOAIRD5JH9pETD7QqRpKMX91wWa9h7okTj5FgPWvCAKebu1CJLZuigpMvDBipZNJhTi7JI9607xf1aNI3vr1D5oLPdihKAWBnHtrlioWXB/afnnqw71XXR36Dbr+2MAgwedLbx7sud/e2rF28urVyrV4DK6vwKALR7Souo1d5rbo1Eeeu0k/BnDg7vy4dHbp1tKMw/0oK1sDy9VletBwBqc41CaclGjKVxUqhVRC+gcTsCov27BcC/VjksNJzhfjREtH+XDANnBQlvNO2ztt8t9AbR6rVKoZIJvtFwP40T++7RcB/A2RL8zKMdD53xRm/GCseOAYuxUSk1G5ON01O98lXW/G2L7N997b1/9aONv/mlFwCk2mzuB3/4g7tCU2XYxm7vkzcXi8Xivb3OXicCIGUaxsJzXU4NJQaGpUqVPEcT5lAKQBitRnt46jMqtXE5E1oRrVORWinGwgQhRBsjlC77PmO6WvKV1jCAgdVn6Dh+xGillGKE/M53tn7lInnq6XkA60+uOLXKe5tbrba2EF/PTbSxPplpiM+o+odbC3dS/t7vHfwqX8iQ/T5SAM/S8rxbOs4POFlSttiXz+nNHpBAdcMBgNs63CfJPS99Nin9Uu0SJRi5GI3J4l+y3BjXTmUCQEg7CauOX6LONLJTSlrxcCcOYMx9Ir6JAYBfNqWGcOvUARDpNEP2P9SpQ4nDud2QHeswuZYiygghjFLKKM3EIsaoMcZAE8KU0nb2t+cQpRWhnMKCPiMOtDE+Z1IqDWNf3wJ9mZCQkJeo+gwAzffM4HntLcGz1dQs9Nm6PK29p8/cquPn8b3O3DpzIfDq20mrEa7NFTJn+r4glsJPRhS4BBGsvB6FSZa+a1MBJvwtSsjdLlB3q36OTDS91iAEUC16gYyZwyc8kdOyjOey5KS7RgkJkG6KBkdmfq8gcYsFdu36lLcm0SI1xhWlMq3WtL3HijPlEoYhAaATp5XEvQM/dA6EDGuFKoAVQ3eJ7sfBxq4WvQLzZaa8F7gE8PjqypX1J1YayzKMw4T2ulFMoqLDAfTj4IHutQ53HYf5tFwsurza0ElcWZzzmfYqSyXC1xYuN6rzZY8GQxHFaVWFq3PFoDe4tXkEpQmnJpF+o3F5bblYnZtUXWxPjeMQxmYifq+173QO9cJKsTqnEpHKQe9wy9l4R/QCubZSufCYX5zrw3jpEK39IDpIg6NUO7W5BuaW9M4DdXDEhl3pu3J+La4064cP9jsDboKUN9hcqeB67V6IdI9tbThJGq1eq8wvObSYJgE93HM6hwO/4vqe1XZ23roVa1OsVzj3zblF8GjYJYMwHXR7obKlJ21IRFzuFy1kGzOuQ4LAGGWIm+MXjDLH4VIph7OZyE4ptaw5K2M6nIVx8g++/MqXXrzhuxzA1lHwP/zrW+CO0brgsI9eW+gF4b2dVidUBZfDAFoyzimB0sShkMYwyoquwwgBIIzFZ0JgfMdhTBNDU6UoTKq0NcmYY+8jlFQGKPiOyylAbYi+NKAERisQEEJBIJQSQkljLi2W//rnbt57f29heclxdLXqutTXaSAKZNjWgQdoEyWJpwR1vSwuZtBLwsSEiRF+GQDzvRqGPkQCF7nJqOc5vv67d57b5WXK7cd6Hymj5COkXHS9suOfVi8d+YJyyE7pSKXYH/Syfv0E+gVT/Xz1AsnNuaZ09Nx2GmYYRxnjIFapBzDvFoyZMRe7n0R7Mhqo9E8QvI1kGfQTrFwzfMU4PuM7Ku5DeGAW2X2Hc4cZMz49KB23yFJCiAE459TaG+05aIhVnLQZFb/tP7uJJIRoQ6RSnFJjRi+pjaGEcM4ooaAUZHS/IsQ3JgI2KOZh1jy2IeUAQkK5hDvkGEwdQoXRLtCXSZ25jDJGWaKPNe4l7i8a9vr9fumxUrPErM1RaOIyuJwSzzc2urJSI55fUonSXAopDLpDabQW42wghxijdZ5OUUaVkJJQSohLie+QpZrnFzhVuheqss+MFCIW7RQzy6qUUaUMZzRD9rJDqgVulG4lOIoMAJ8AjAnQBUevlL0Kcfi97dRqL9mxWOMChQ6CvFtG9AoA9nMBv8OBHqLXuUOfuXZComlFiegVMW5ttcFhmc+y4ZQBdEW/Lw9YcTCHE5ObHmCAd18GAFybz7S5aqPS76jFy1orLaLDnQcAklSAo0/Oa/PI2Po0c7fp7a7sAMBg72gbaZzUWg94LxCAXFsprz5uO4+ai1fagDW5o7zcrNX98mKS9HpXn6y1HvTmLmWkvg00ZAfl5bn5JYc+3j641xjsFXoD+5jmmJWXa/XB2kqhN3B9r1yr++XFeHDgzM+7P57r/LSCqt2n23MuE+SykaoZH8/4+0RozET2utb67/72969fqK02eRAmm4fhv/j+pjDEBwmlrhYLd/e7e7206DqcQkitlGDclUI5DIpBKqU07PmvAEYAA+5QojUljpVTAAUCZUg8jrW0eaZaGWNLr4wyRpWiejwm24pOmjIYQim0VlIChDCCoBc3mo1Gs/Hu5m2bObO6Wha9Gno95MQZq8zs7/QAsJLORPMJw8xp/pmZ1L7RbPy3X3ml8VawiFJfyzJwADlH3RtuxeXOKG3Ryuvj1FzLbSmj05za3rM96PSpHiqZMgONZ3ltdmAkECiRKewAPEMpJa0kBHCp1tCJPM14cx/p6/6wG5vnibcErwhe5RzAnoxtbtdXTf8PTZoX2UcVVGNOcHZCKKWUEDa2Odmf02ZVaq0JQAjjjGqtCbXnJ5WK5LN0HEa1Gf3unFIJTmGkktogJaRgTKT116CQYhV8D3rPJECyrOiTrJQNLCxSbgCi5J6M1rhjy6rxeMhwbNTTxSZC/M6XD7t/rnxpoW5LoBNTWHXQo5XamJiPNsHTcsok4waSVLUBFNmcc8L0PohVwfPrDcwbcTSY9EFmOkz2v0/NQslhDmmHJEp0KGWRcwBRogseLTjULTJIcAvTVoQplelijS8tGCyEziHPedv5QS8YDjQGKJWp1eWPfYp3irgWkloPtGYTCKzTxq4HOBkx5jHHetXtI6ePB53t6p2NhlOen7+GHL7X0QHY0dEIgE4F8bCHc0ei28cIHSqZFnoDYTPce3fsz22Dfy3FBiBS5ZX8+dUbWlzJLxgOLc5dXDNLS3OOZ3uRXDSW1xpCh/ZLLURz8YqYXwKwfLJZyfUalfVnjUia4/AZ12usXPHsyz6SJkP9Gb+vkwbAfKqNOzUgJz+SaaJNNZvKZFHeYnr+b17wXEH4//G//nIrTH/l0x8NwmE/xm99+/1EkqLLEqkJIamQoTZF1/FcbrfbBjQVQmk4jNpSqlSKMxeECJFKwjy7aaBMa6U0YQSUMKV1nApljGX3GiCEGEJUKiglnuPCEEVATqxtKk4kdxxGzHD8Y1vc7LQ7609dfaHyzMYb72/0guVLzvqTK7h1YmJGVv88KcsMp30y0xXUmcg+V43/2Utvx19uPevMByIG+IBimfq2s6ZEHTsO6TSHTFZyPE55JGQ3Cbo6HSp5RHRfi896C6MQmCxgfRweGRmVSlGkvOB6kbW3MxooERu1WqjqVGXtpvZNOmm4JyOtR7XT5Zh+lpTmqDuKRkjCAcU+kiqcr5r+/xeh7/BRrPq4LwF2RjFj2hhtDCfUdbnDWZJKY0ApNcYAihJeLniDKNEAo8zer0GoMYQQe9ZZUxSlRGqjlAbA7J6AEM65UoqDaygpTUpIAYgJ/aoSPw+zBqfu//+Y+9NY2bLsPAxca+29zzkx3bjTm/Jlvhwqs4pZc5IixUESBVIS1ZIoyzTRNgQ1bP0R0EbDkNsNCO0GZDfQajfQtkW7LVq2waaGptotQ26RIMUiKVLNpqrIYrGUNWRVTlWZ+V6++d0xhjPtvdbqH+vEuXGHl5k1UOjAxX3x4saNiBtxzrfX/ta3vg8B4H4t93n+EubP0sj0pgCgzvfkzFleN9YfH25v1P5v/fZd+FHYHAzM82vdQ8bw3QzfNwcDgOreCljP0ym9uGVa0HEtTcsl6VFVAZw9Ya9vdC/G8H2dkOmFNyOHS9aRw80BHVXStHzUwnDtBB4iTwcOAErPnhajvnf6iefdziCz6rsfWbKMDgB/834AgCUsl3BsxT4tRktYwngO35gA7OtgsS6pXOF7tV+cTEjdrw+fH17aDBuXDi4/dIsLcerr7ZvPPdjZ2756xs+9G8xZG8XciJUtMgvnxk06f4f3KOHtivMQ4lB9wx/+ZFqW9hCD0dD5bBLy3mPAVoLYsvNw/lMJNKTx9MxTnDEVOOMh01/PYbreQaUQcph+5yKZNRXQMsUsmbF7Jw6LTIEjO1TmJNo5UcQYTWDqPdl/Y4w2uRrXXk9KMsiz/+Ef/+YfvLX3v/mL3xvrJbr8D964Oat5Y5izYkwpDx4QCdj7IKyJO5+AmFLwPjIAuMQMAN5j5AQAuSNQWAfpyJwHJ6IsQgCqusIFMMo1D9n2dLQx9A8OFgzALAhKzqUERe7zEEBhlGfLpmWAjcz9xIeyV2bNjRgB4EPf/9H53uLrt97Y5nj1qQAw7ceX7HKhVwEAhCnsHYsh+BSWZ2iZM8hu4vdf+Vp895fu/KVwSVIaoV8A3AhDMz/pa/Ze8X1G2H5y45q7wH5TmvBxD2UG8UfzS9eLSd827xcA+0XzvyVHVduUkoZZ3oDM2vpaPjnfvD1sy7JtNoDegPR23l6t6SM43KHMklTtSd+WJQB8OV/+fFtl5MmhgK4mj0AUyKEo2jhS5rPcO1EGVe+diMQUESg4R0iRBRFXhB+oqkNkIFB1iAQqoikxEHrnFCQE37TcMU22TiCiEgALcyUSMk/oPhPjx4f4w6XfLHCzwKNafxmX17l5CfNn1z6sg6bsfeGPuN10WY/vN4qN/0MNf+9fPJz8aTRT31LD8LQnsDQ1x8bkkkZ8X2j7td5cNXyvBWe17C9485xpkOF70/K81VLdJFsZuK9K9YnHaZMAFIDmi/rh/KRs759uEgIAtOUqZm9wtbr+5HhnID2gm2DRQNnwPb5Jd0VsMagWHb20Ox9TKmAzPniEBxOK89oK9jCteqV8PyG1X7214S9Pn82H+STfbeDwMXh0vHgr239yOYc1cLeYPT+HZfIxLlj4oF6W1QWtrWX6FqZYOYHV2jQOg1GEi/xb1vcB5w2ErTY/k7v0OKOYxz0+/OFcOGrbtllsiTQBZHkAAFEHLIRdz4uQAXzTRlu07Mr5bU9aTWwOBvmv/u7XX7l58OOfunFlEgD0X715///7tTujImMWBGIRFgbWIstANIpk3qUUWSF478ghmm8MX96cLJtGmBH9cJiPcrr9aJEHBwCBaJlQYzRC5kT+qKCgwlIUeeFhY+gBgCU1CRFS5l0g53IIHgEopli1DQAKy7XJ4OO747vfuAPfexUg5yZOdsffv/u9873F/bdvnXrTlnNeXjAm50aT3mCgZ9std+lxl90p7R3Lq79878filqy4XUP2YZbnSmcL8zNix7UrHW4S7tfL+6napOwNKWcQf3L8VGcqsELz9XDUqm1GLpwgO/lc6TBW2/mw69OuedRYzb4BndX7s012BTvDdFhlZFsH+J7Gv5tqJFeAtgxA2j8KOQJAAPUh5MF7RAYQ7Zhvc5VARAAZDvPZsgYAAmU17gUdAKk1zC2EHbx3Zd1q0Dx4B+iIuLMtU1sUGMA555wjjsKaqULwr5StSSSvAgHodfEAcALxNFLnH0qiVF31gx7i+yuzWD+XTX5K0n/1+eM/92enBuULAMqLPpNvucbm96P/7z92lDkr3tcD/yz0eJAX48Jdh4Kjvn5/Waqzqp9jqrMcAMbMlnqMuZ8nfdCgle2bGRy1cNTCZgYbxH316Z8bFwCAxeCFrfcZ+xzcyJ/bu1C7qrDwNQx8E2KNjxFydBOqX7n55vYkPDG+/szW9dtyvG4q2e1Hp2M9XszSw7JZHs1hE07SU9eBJqW07ovDUYFg4dzWB3h/z4Nsb9jy3sX++0otvw3v9fVV4Q8J5Yk0FCNTs2SEZG4Va8bHZuzuPYUQLEx1PW+vatoQAkBMSbynv/9rX7n3YO+HX7yaZbkL2fGy+e1X7mYhIBAAA4B3LqY0GowdYiusqiKi6JijtcvMEWyQ5wAAikVW1DE1MdWNOkesAOhEeWdAj5atlerWVLStugCQo3GRifCjw4q5ZSVUzbIiEDkiUGAxMQWKYowMAB/ecU9MBp+//2h+AJPthmNuAUyTbRhOXijnzeHBYTyen6nfzyD7em1us0vvrZx5Y1H+7m/Mf+xR2CAvkhYEN8JwIxQj9GekXj0H3dPuJwX7qpvaYXTbGP6+ruVfmzzXIzsYp7F+/qnmPiOE/XppNuvg3VKSpZWuaxAJO6OxDaE7XM4wfqo5oWIAQGICgoeQDNl/xlc1YAHanjOfsT5KEYIP5BQZAJWJHCuIiPdOVZlFCcuyMflT8K6x3dzaeFqbmFYy/6LIREREGxVzZCUVVugthjyRgpD3DNpyylQz7wzff6rs6vGXMH9J85eh+WVcfiy0pua8n2qTuhvjtJ0PDeILdKWkjw+3/+J8+fIb9z7x4Ws2sgSxkaCUFwAAbTNPOoF6PVzJindjVNbtvU6GQkgbgONaZmVzdHCBOG1cuBs7gyXrGw+bPo4DAJasLpzwExz14ZzLlJ4YegAwfAeAjnAHmMfWP3V5XFeNDqh3HTjhCte48p1BDoOsGUlBUAxyAKirpu7DvKpmXNKygMGK+U1wasDVBO/bRXWE++8c3nlm97lniucA4HeOf//8n4fTMQAcxsVOs4DJxUkLZ+wMiWugDABmPIA//Mt75yV9QJX9GXP27xayjws3K/s9GmZZNhqO11pbHbL3SR09+R5CGORZ3y8dDYr+iojY97/7S3/w9rv3fuqPf89nv37v089Oxzn/qzcPI8NkUCQxgR+LcJHlfkWhqCpAh8udJ+WqkTsrK+dIVRxhm5IKmDGgqdQjIKLLAqbYnT2ICAjCvDka2jRWkftlw04xyxVARVkSW71B6IKjFhw5cKLP73QH89fuz39wewJpAX4MADYHN9kdT69tSYzzvYWh/PkppDM3vjesT2H5xqL8Z/9wz5B9Q+g2wY0w3M6Hfczpeknew7HASSppj+8GxFXb7NVLAPgdOXw7b/+D8KH1mt1+sWvGrlAbEPsAjSH5JDKi0IVW04nBZKVctg0QvCFlhdInHJ0w0SQzSRXI61r+jK8WqsMQEjCtpk+pE6EJAeZ5QERhEVBEtBW9SeIIHUKdUrd7UwUAFmXuOrrM4r2r25iHTgRJCIiYeZdSalObhRxUHXYEniOyIFlW0/ugMYqG7xvevVK2TxN8LAtHdafHfwnhqtD9Wn6ZlteluQr0kSSSksH6u/XsuhvWYdVlTfATxdW3X7v1zvjwxs7AApiWUEBs4DGevY8jZE4dGwUd13JnwU8seGfsxoU7Ez49Ltz1sTso/bv7LeRuiNy0DENnNXvXJF/UADD0fpDTEHl/VVVPB2CcDABQIxc3eS8MWupWp6qpqwYA1iSbsBCqVnP/O4NsfTy1x/cHj/DBI2z28rZuLl3a2Lpy3TQ2OB3bV0/LAIA7inXbHhyzRaeuCpxuLzNcGx/vlSH8fk6b782cuA9M51yYodFfP5+2ceHOwNJQ/7DXoRD8KZE7BaBgyM6szJ0xJAvHx6wuWe6KQXj51bf/s1/4HWmW//aPfs/NB/NRgTubozsH6Ss3j/LMK6hDiHaekyeHKXFiicIAUMcYWbzzkTsuyAh3BBIGBkUCB+gJXR8lo2hGY4hIrtcCiogUwRXBi3DbpmXd0kojb8J2BlB0AJ3aPXFKMY0cXRojADw1Gr/yyhurDWC3a7Q4LftENp+89MzHnnvmky9cfvaGBXAbUVPfvbsO67tTMsL9QtnMFJZ7x/LP/uHev3c0NbZ6RnIjDK8PNgboLpS+dE3UNZH7epOz93oEgH/MD88ju+Eg4WnjX0Tj0IdZDgCm8j6Zbu3TPLQj0++n+ku6cIRXffHccHOdj55JQk4ziD/jqwpgI3MAQOAIkJzrB5Qy70ZF5hFVVRQcKoEkUVbwjnLvHBECBUeqGlnqNvZ/rCMUgMTiCFiUCJ2j1efORMjSHWCmnPEeCYGInPfdaBtiSuy9y/MgPtjdfofYkP2eRhumvYbhKtB18XcofZHaf4RHX4WlvQPq/IzkiFvTz9j3v8SXXvvccR+EzbG2L/N8t4lTK9ULh+8dgnrSLCQ+KPnBXPo5pp6c6e4wzLeHbpBTn9BU1gkAdFW51+isYJ9k6IK3Caad4hQAem2+heA6rZp6DfS1uqB1mfIZ7Og2wAGcBGSvX+41D8tmDnDp+SvPAwC89vvm5G76mZ6oSVJrbCRWR/OxkTNpdiix6p0Ot4vRuaUSP2DdfZ4SgZUPMH+LFsLnLXnfo64/vyp8t/D9cbHgMaZ1EeRqPBV5bTrcPf6IzHI3r/XnfvH37j3Y+8GP33hh280i3N5fvPj0LgB89tUHB4smC05FBYBFvHNZIGEFSk0EQEDEEDyKxFXHjwW8c8GHmKI/vaJ2YSYrh5mYkgj0puK2YZ8MBkAYGQa5IyJeTS3ZdwcA2mEAd4+mWxv+MnoAeGIy+N1H8/kBDDtF1MKNToVkKScACOPhdDycXtsCgLgoLWe1+xzTvTTrJlS3tre2AIaTqzRvTIrTI/v/4x/d/kv7g2uD8b12YSXwtXzSzSIhgGqD0sec9jrIHs1FtEktAAzIBEvaI3td6P82f6G35O149pV6cl0gb8hOwRtObYRi0k/ArtEph20pMd2G9gE0H8HhDRo8N9xMIgZtNpuKAHsof2ewXDS6kbm0kv1Zba6IwlzkeR6cDZGpYmImdA4VES0dqWVJLM5Rkk7aaPU2gZomMnjPzMEH7cXtJ0p/KvJ8XpagCt6bebCoCeRBrQgAEMIk4giAMHkKAIvInxumHy59XWgfA3INwzWAq0L3Qe5Q+kVdvF20P9hMhuABQFI6ArBPrVa+UWz8hcXxL32+/ON/rHChWC/Yl6yjvkiv30uW3bScE2MWAKBQrrOQt+3+rNyfjHfGruffe/dgK97vHWE1l9Kd2A9g7oM78SXu9TmFw81Mt3KchO4jvsB+4L0vOMgLglo6WMdBrlVj38ckWISdQXYwKh48qq9cUktnPY/vRwd0FGcAsLs7rpZXDreuW2f1SZrensJZFj4eJwCYjNfr9/d6hXz8bVTuPUPyQZD9fReAD67C/C5W7g2/D6uzPlLBrOYHafYDquzorKW72YE9fHT0n/z9f/nUzuCn/sSLI6h/89WHbz2sN0fFE9uj/aPlzYfzzDuVbn9NVmcxP395PJ0MX7l1BABN5LqOwzwDSMGZN0DKQi7KzpEnZDCFH7OiCHjv2hizQAhK5EXSipn1CcA755zjxEkkOAIFBx1Hb8V7FGljLYqjPJuXjdGy1zcCAPhtmgJ8NBu/duuN7//0h7mKxsy8x2ckMYbxUGKYbnbHDDfPwBYAwBjAFUPyIDFO8jDfW/RV/K/8xqMfexReHG33H8q1fLLeL2045i4AXlDCE2ElCYxc8q6Kbe7CneWRsTF1of/7/Hu6LijiKUrntEjG2Jiu6GubYZZPzkzAAoioLQC3oX1bllcg/55841o+aYDNqOCI2/upHgEsEf6zwdHXmzQMmZmjiNEmgKCgooMiHxaZiLacRMB7GuWESAoqnJiZnBdl7xwgCackai1fG05llQwREU3qvi4csl5L5ESIhZ01CIlXrJPFNyGmxOzIVhEFAekOnjHi15v0JCjU4R7EPn+1h3jrg36tjYUufoTHcxtqlTST1O26Yv0TxdW321uv3tz7I8/vWI4SAEyg5lVVtEH88AI5Q7qQmanRGb7PF/WiHhiU93Vyj+8bw3xaNI+qriSqBTkqrDwGakEjZPIsL5dN1eA64d4PhYBR51yO3wMa9qumObCA47wgwEFumL6O+zuDDHYewWnLMAC4QrunTMS2ZTNsAICrDwejydaV6xv+8nso3yEe7+0tVrg5sNaf92eJy4VzRsu0DUcpP7h3rtEjHxxn1zNUPzigXyiwOcPhfKedgNHwDE+1juzrUrm+YLfxpX6IaX1AySx8/+Of+81PPr35Ez/wIeXm1hH/wTf2X7u9/6HLo3HOb97br5um5wFS4iL3zpEC7s1rQ3YAaFMrLA51ENDKNwWyNSBYyDggADgXigDBgUMonLYNa0ciY//CCHVjkIOqCDsCXWE6ACybdtm0dYptYu/8KM8AoFidCU9Ow0ZRbG7nxwAfujF8+zBwdfZtx9Mf6pleSP9JhfHQvlwxBO1u5CbKwe0pLP2G+8zv3Xnp6/JDkysNxwNuTpAdVrSJqg0TrVu0248M2ZNIIjRQBuhsA74si3saT5AdTuDPCBnCE2mNydgp+GGWW67ppY2Nk13CipMxZJ+RHEF8lkaG7CuCJRiy23//5uDAkH0NOLAv3oeFz4NrE0dmIiJCB5BEk3JM/JGndq9sj5s2GdECKkkUkSIzIQKoiOTeIaiuSFejpKx4bxNHFkIExBACEdnBsJrb7Q7coshslwZECoSOEJHIJ08Z0ee83KFUFxfQtleBAOC6+Psgb2GzxI6/KiXdWgVY18r/HlwffE1v7Ve9gbsLRU8VDAL1RXRPuD+Ocy+UaZBfKRgAerbnPDMDAJdGYdvL+ezsnpx53FOs3sZ8WBDgkRwd0PvCh5HsxYqZMYg/f7f1xO0rtHtpNPqRjWc+srttEH8tvzxcHUO7u+Pnty/98eeffmbr+pkkpmE+GWTS4/vR/IQoeB+Me8+R/QvL9jMI+76w21fuTXN88PDtg4dv14uH62zP8uj28uj2+o0fRBP5HdIytCxXCvGzNIuwtKI9vhsPY5h+oWvYtUvFF7/2zv/1//Uv//wPPP8DH31ysSjfuLP4J599Y9nC5c3J01cmdw7Sy2/PlYiluzhHhK6NUkfeW7Kx7SIsitZmLwZjIscChKjK5ExBwUTkAFXEuSx4nI5yAHC+H2UUm2BkkcxnXcdWEaGjBmwHQKjB+4BaZCH3GaFTYXDOETnEpyYeACwde5uLLV184e3ajU5Jq5TTOr6/R3FgX+QB8Own+LlX9prPVH90dFlEzyB7X2U3KKe1TN0UPiAKS9k2ZjjeQ0zZNne4nEH8D6cf6Yn4dWQXPfkihDlHM5wp0Bl298NK/dYBoJPQHEl7P9VPSvhwNumQXdXKVUP2Ifm/DfuvlG0RnJyW+JjleuZ97rPIkhJ7RAfgUFO3kGBw9Na941mZbOHh7sWjqJgzgUPwhI466kZXpgV5cKLQJjYC5/SGQ9zKANmexyFm3gVHDlFEekrH8N073yL+wQi+1kaztOzKbQhblH0EhzbudBXoZW0eQNP3J9bxvUD3Z3Hj61+pO9mMFe+r6oEG+eMc2POL0udHDjfGw+kAjipZnONz7JZx4TYHNBzlhUMzjVmyGqwv3InDzLrVzHQAw+TakuexBQCfEzf50Jh3LsddkvW5sh32LwFIMciH3pcpGcrXcuZu7c4ash/Ug+3l+NJo9OKHr47S8JKfXrt/fC9/eOnq9PqlAgAeNRvbBexeu74Xpi8W25thAx6++i4sAGDDXy42T+0kUrOAyTgMijV55RLgYsWCxiYGCHF4YefzQlT9NgC3Xjx890tfmnz1FgC8+4kbW88+s335WbMGS7/1BgDMP3HjiY9/1CzALqzcv8santFarOsavreiRXCFA2HpXSEN2VXZaOo+ryPL3dbY/d9/6V/93iu3/u0ffXE8Hi4WZZFn33y4fLRk79wTE7c7LX7xd9+el02eeVB13jVtamISSZnPPBE5sKrc2PPMEZErqyaJdqmnAIQOVw7skcGcBgBoUVVJHQInQRZRka5jphqZ64giKTLkmWtSmzgZa59ludWbvL5BYQaASeGfLvzONoXpZHp8DAAfufHk67fe4Rd2rejuPx39YP2Wkzk4D5ICaCznjYkjH/1PD39y/AysbFuuF5P1filRN6N/IpjpA/NUG5QzMRp2ucPlW9j8mxtPr7Mxp7KZVohsfdcZn/DsFPxz+fDMWiKiS02G+w8lXQa/SdlWNuxDlw6a8t16BghD8v83ffgZiEXwtssX0PWa3WaUkCh3nXAFAEgdKTCAI0wsi6YJIQCgJBYAQrS+aBG8Daa5DvSVRb0jJJdSAkdA5DpuXVtJHq1qp8iSeUcITduavySLlK0AIBCiglF5xucgooIWHg8reWXkbnLaFHy2yQBgBnELsgHQp5qR2aIZvr+E8JzmS4Qe32+EYa386WLr+2eLd+4efOzpLYN4FwpYhZdu5VjWnRTSBd87fOWpLYpQCxrVVhh/yHVwg0nI5rGuGhwXozOaGSNngtOC1vxBq2ZRDCaM656JHJNJZda3Dsa8+6H3kFINgEdyBLQzvJCUuYRHsjnK+1GoTg25fK9Z0O3l+MVru5euTgEg34pXwg4AwH14erQFxQTClFY14+7uON/YGg89bk/gtd9/9/DO9iQM89H5uQDTJn+HmsX3QFW7/weBeInx4MGDyVdvTb4yA4Bb7q1L1eH9upnuv5u+eHfyldn8kxuTr96qLhX+mUkOU/j/g8s67W7yR0S3HsNkyP5f/aPPffPew5/6Ey8CQKyXgfCzX3nnrXuHRfCJ08eeuXzz/vzV2wd55q3IcoiJUx48M+WZl9MQmQdnMmdA7cJ0iERVlEExEIlycECUmYRRwSdpAFAkMQs551ZkUZ45O6xZpGnBppZcx+30ssKOfMcVaEyHGQDsTKdTWMbplJfzy8/e2Fw8unPz/vWnr154kKDzznnD+jOrvlX39iN0HmIFAMNBvAOjX/mNt/6N9uqkCHfqOQB0fgCnig4lwlzdycm5AsSGu1L9rFK+nb+NzU+On7IOalfjr2lsOpE7olE6tl3o/VK282GftmalbhXbA24kpiNpFwDfk28ccUurLQsR3qnm79azJcJI4Z/wwa9Au+HdynpCDOIVQZUz7+wYUBVVEGHngqpYvxQRWbSJqQjeIzRdPwCtC1JkmQoH7xJLWrXK8+Cco3nZIGJicc4ZU6MADldsDICp4DPvENETsiVvrYZckdCBU1UEsYd1HlNyw8C3F+2Lg/C1Nj4LHb9kPsA7lL0k+cvavIT5NYC38xYauLI2ON5L4P9s2P17X3o4u9Ss91S7AyMLw6atEtYAw8iQuWlBtSASFcoFQp2FYsUiziHfAciG7vg+YAGDFc8eGaGpjaIBAKEBQAsApTrXcl24U7Q7K7RgbPtRC+c5FFo1YYcAgEeyf04AY1y81ewdYeK9Xe+lkBeSM5vbMvJjAHh0//j1N/feOugM3PeOm/15BfEUwz7J4u61689fef6ZretPbV3fzS8PRhM4Pfx3cMypWbQNpyQpSfIbFwBYqwCAIQeAKOUfKhnSeY0BzD+58bGXy/ob8+rl352vkL2TIjyq9XQ59odRs7//UsRixLdDXR8RMIhXZV0ddv/Jz/3L2/uL/+WPfoxjy7GdjAZffufgN7/2oEmIBJmjqzvju3vHTUKH6CxMoIkxiUfMg2vaxIqKzmz+2sQGvkawsEDwHkF66qx3YHfGpSI0K89xFiAiv3LxRMRAjoQVkFDz4AdZbukchI7IEbqTst0m70FVZTLw49MyKkr3rowvPVg8WhdEniff0Xl03hUDVwzs+pkf9QWHG239xu+8/tLX5XoxMUOu64ONk2hTRCJcnwXtVI8rp7ALkX1I/m49f1uW/Qxqp0/HC9lVENGybSQmq9klphNkX5HswmLIPiMh7z8+3Lb7m8XKgPydavZaM1siDMn/E+isY1rbXoBY+p19msH73GcgCqqIJMJXtsdZcJHFI/qVdDUP3juqEqeVPAsBiuCxW6RVVb0jB6CqiWVZR+dc8N4RImJnOKHs1kSizjlmVlXvPSs4xF7ttXKwRwDg1LH2oug8JnXOu9fryKL39NQJWEq6Avlmgfc0XoH82Sa7p/EBnJy2CwLTR171g5cwf/dRCQDzpPOkI0u2q1PPgGvSUruyfRNTz9v0yF6jk6qxvTUN8qPD6gzVvk7OdAfDRZyPJjUn96PTVlu9Fr77J6cuF7Z5c2f/hf1e5L5fNXCwgUfS5M5Se+o19DfZzEJoTAIAMDjLLi3TYnkf7jUPAeDezYcmldmbVUtfPre9s32lEnl2e3ryW/nG1nNPfmQi441LW+fbqhKPF2VaVt0b4dMMYPg4WgZXRm7fqjTlcfLE95YtGpqPHpFdX8d3eyXrL+NfA7iv66VO1um19KV1+aNRNDHG//PP/2bh9N/4oeeOjo+R8qNl/PI7B1/85oPxoLAt9mTgxhm+e5SSKDdxkAcESJyIiFFTUgVxSKDM6Oo2OjJrSWZBQsy8iywOyTlgloAK6Ez+6Bwxi0gXUWb1nV/zZw4OOLXD4eh4WToXAlEUAdTOt73PG0K3rNtBDrFtRZEBLueyURRhOjHzLzeapBlvbW/dbf2dm/dvPL+1zsyg+9b0Y9zEMB5+7uVbe/98/r/a+PC61WIPx31R2QvS+xsrSUmlvQjZ32rnX4XlT46fmvjs5KEu0IchqALRYbPshY8SuzHUE7pf1JYQWU08PjfcPGjKGcmmyzwREc5T+1ozA4CRwm+Gw5/XqlhvQrCSEwECkMxn3rtl3RZF5hQAgci1UVQ1uG6wNLYNoss9sWjmHYADwDYlkc4LtO+LJhZmyb0jR5wEVEEFAOx75l0Tu1tUFY2qR4wsWQismlgQu5K+F/GTc8yMAI66NRUdZeAXMX3Oy40k16wUJN2EYCvrs032MjQVyBXILWHqATRXIDfbhpkkE0d+yk9f/tJD+NMrwt0jVF0VmWdukHeAe4LpVWOMylnESDoBNKy3U3WQF7FsrK3aF+/d8nMujCnPHAD3sL6Z2QLgunM/98EplensgbV/e3pSv+9fag7k0TxWVXm0bI6WzaN57L/my7gQAoCFkF05qE8GRI9w/17z8KF76wj3j3Dfbrl9uHxlfvOfvvHlf/ry7/3WV3/rjdtf7ZUwVr/vbF99+oUPj8bbBujvJeCJo/VGc39Z9y+04v286vF98f18i/U8bw7jqwDwuy/ShVhvdM3o2jVzH3sPz5nvysX5i0Py2vbUsm7pS7CaYOp1Mk3k/+L/+TuF05/4/qeOjo8B4Bv35p9//dZrd2cPjhpABYAken0rW7T65p3DUREGeTBQZYFRHhx0hq6syIopMSIWIahq8GFrMjDZg6pGZmZOrIK+TlpFiQx107BI8KF3n+9twgwIyDkT4Vn7tPtbAFAZEEQ5iizrttfPhCyzWnV37He2yUSK62Ol3//C7t3Wc8zXi/cztDvl+B7/tTvHRflrP/fVf6d4woSPlzY2pOUL4Hh9QCn3ADBPrelhMh/OIPtevfxyOu5qdpb1RzqJzcNunTBctoeSmEwes3N6CqThuFcvjWefkXxi+0oSkZg2hAp0oyKvJL1SHnTIXsz/dlsieSt7u2cksoaBcwGIRAQdJZbYZafQ3qxqYzJPmMiMQN4Rizoj3xWqtgWAIgt9MICqsiiLeu+AMLLaACoiBudsnUgswVHXfXXOESEiORdTYhFYpRTAShmvovZOe5PDA6laproa0T9LfAuiFe+H0vZ7pmdptFng61paruwGBADo6/dS0kFTWvF+FejdR6UZirlQbA7IglIL0kmGNk80b7UWlKqhi1iNGjtp38ihtrFvq/Y6twtr+f4yXsuk3cxgMztFuA+Ts8e5AJh0T2H/0n7V7FfNftUu2jAZrTpOF00tjUm6r8pvL8e2JHRQstaePcL9B4+wcwOe10e4/6W7b/3ev/zyNx5842htrnt3dzzavFxk2XcL9Xp8/1aB9Ywd2PlfH08355+48fEwNhw/j+/F85M+2umM2cB38a9bZ5+mjy/bDelYu/GlrooHUOVhUfyDz3xpOhn+mU9ene8tnc+++aD9vdduX93eik3lnEMRUI0xbm+MXr31oEniVjo0EckCRRYGtc14E5N5pARHImznXEqcmAnVEQRnGm5k4d2Jf+bKRu5d8EGEY4pWtiMirjouqhwcgSRyrqprZnHkAE+ylprYMkCRh0HuCN2oyIhOYr83Me1Mp6v3ZxmmE9p+EgBcHj52dWK90P5D6St3ypFylOZ0OvOZ/ybIpht//5/9qx98gNsuT4SXNjbsfT6F7GvqQ/vvsm7uVLM2RQvzXE+/A4ADbl6B5b+58fTEZ73bTI/spq7pRDJmS6BdHtPqWPUnpJAhxWq69UjaTZd9bLyb6mS/QsFvZUMAeKs8KiVdVvdZWPzX3DjnDA2RQNfsOjPvh3kQEUAd5oEQMu9VhDlm3iOamQRd2poo2NgaMlJiado2hJB5Z1oX1zujIeSObF+YRAaZd945wiTSJk4sAFDkwaEx9tgV5mghHmoOwLrqM2MX+gEAgETOOV0NO5mm1jsfvPucl/uro6taa+x9qhndB3lbljuUOcINCBsQhqumxVK7fc8Pu81334Jl7BK0XSg2ig7fpwVte+l1LDZH2uN7ja5eHbRL1j5P1Yj7nnbvT96jqqoF17cCPcWfp9aQHQB2CjXe5ri6iHM3Vt1kkZNR2K/a/dvT/dvTceV3izgYDLuvUT4ZhTNfJogcjPLBYHiC7Ct8f+/Lq+2rL7/2+w/ufWPenhQv21NHYXBh2X5+VGdre+sD4vu3yVY/XhaZ5Vtbzz5TPD/pGZiTLchXZgBQPvfRye6V7/q80in6hS4gptbDOtqGU0wX8zMAKaXRYPTPv/DmdDL88ZeePm4iDLsDMeSD3/n6gztHERGjmQQgZj776rul98gsJoJEpF6uHkUcueAcqKa16ZqY4rxsihBYIKZE5E1CkznaGWYFsigzS2SootRtRETCk7WHyItoGxEUI3dcvAg3qSVyIcsUUJhj2wYfkAgtyE1YWIvgn7rUvUXHMKLtJ7e2t4aDTpw+WdmOnm/US6PSqEH848r2sBG+fvNu8Zn7PzC+nAinwwEApOrx7XpREd1vym/M9qxCPwPrdnmtmf2x4ZVRkZtr4zpN3/9XRBtgk74cnB4yt9bfepxTj+zb+fCp6RYALCX2Cj8ifPf48H6qL4P/KpY/46uTj67rYaJlceR5yL1DwOAocwEBzfiBAXpxBCh4b/or8IS2wWoTB+cconn8drSqI4+YeY9EBuJZcACALKwoIixqtgRNm4ioCF26kzUsvPdtSogIK8G72REA4PoAQZ5lPvhuJfAIALkPs8SfGyYr3vuA71LSDmVXge5pLCVtQnCEgxVCGsTfhrZWvhGGT8341uESVg4zm4PByKHh+/Yk643DrHjvkX1d6g5rdillnUzwfmk6sjM3Mi4jzmo5E6rXi9xt2PWMSAYASs99h4nWe6RbGdqM0rjyVR3HlR8MhtuT0VaGOXFOjPnwQvG7dVa3Mhw0JxB2xp3mwSMMk2J9mmlnkFuA6lu3X29OD6BuTx1cZKUqdVy3QLl7GuttpoC0eo/6/duXmlykqty+/Gz66EvLS3IG2eef3PA/9uHtK1csc+PMIMwf6mXa4uMq9x7ZOwMvxTzLP//qu23b/MQPfCg1c+ezsdPPv/Hg9v5iVqZOuqjqAwnrdOgBYLEsA7mWxVL6EKFJYpJ2Fm4TBwfOkWkV7LkiQzJDR0neZ01MJkAPPrx72L61XxG5pJpWJn8rUtohIqIrstCmVtF8x0w+LyaniyycuAghD1nw2JMVzpGAonOZ6nXvzJz9+vXxcNIdk4bvADCc5GUVIC0kxscR7j3En8F3APi1n/vKx6ptAOiR3Srrx73599qFGfZuu9wIgb4wtMuX6sMfGF+eDgfSpFPIbrW/uT+yAMAAHeV+KbGn0WckFnV9iqWMHS/3RDHpBO8As1h3ZXsYWBP1srqvwvJvuFkNmHkPAGp5faKEoKpZ5gsfooh2PAykVWqSDQzZ9kSUmybe2zs0v19H0LSJUAkxplQE5x1ZK9U5yvOgIm1KiOQdiXBMrI6EE5HrO/89geNdV7CDqoi0dRNTijGuj7YgoVtr1SQRQvArz3h0ZOTM63X8InUZsH3xXkq6huE+iLExmxAqEPuYLI61lHTEbYHux9zk5teadSJlc3ACsobvpbpy2fTFe6Hcf3XHVdfohIN5e1Sd8pmZJ92flWWd+lTVPHPaRqmaxemg0D6Pu1RXRemZGQAgg/Usd/1wkCH4JR1Yo7VH/x7Kz/JHciJ4H3rf4fvOo7M15qTYLqr1+aaTfeg8VuesVq+Mv8s4+J3U7+szpWcWicnulcFLP2T4PvnKzJB9/okbgyvPZfnWea7/u17CnynejzM9vb1wZ5iZk8Miz770zfu3Huz/0CefbcoyQT6r4ev3q9fulO/uV3bSDjNnUxhJdDwY3D9uBQgRgyNWBcQmRVUmIkWHQCLSMCzrJrEiopH1CuKdSyIEzsiWLFBv2Vp4JKLEac1ORFYbcPYOY4oxdbcE50AjCwfn8pAFR4iESP0svm0pmMWRF9XBwG0/sXp//PgE1lfGA71rmBXjH1DqrpzcMPzib35l85X5c8PNDtnrdIpCET3jDXCvXRxxuyFkTl5D8ueR/dPFliH7Sem9HpmtWpnW0xEgpjpZ7U/BW2t0Ohyc+bitbN8cjneKkYhS5uapNV5+2+X32sVrzcxqdkP2ArSPVVJEJBRFRzQqMlF2qKLsHalC5l3wpCqgqioAULdtZEiqwcbNAFg0iXjnQTU4QkBd/TmceFm3TeLMezMLM7YnxUTOA6IKd5PJRIBEjgaZ94SJuWpbZs7ywjtHRG2MTdsyc+eE0c/iQme0KavxKMvo9s6LwisjfDtvrXjv8f0K5Fa870trKknDd3UeOQHATFKt/MkwfWrG+7Oyb/itkzOG7xa1cVxLWafzDVWpmjnkS9aZuFLdu/N096A0csaFgqM+WsaDebvOyayE7bpwTtsTCJq3ul9j1chho/vHFQBY8U7rsN5fjIRZF7YbcPdYfx7ibUnIcjf0Z8ufTd3Z1J0e1q9c0iuXdGeQ906Q5t5+9m8ots4X71SE3Cf41355D/LdYvYGL/1QT7X3s0uPq/q/u8vV+qJ1fFowc6HU3cr2PLhb9/e/9OatH3zxxqJsAODB4fKbdw+/cW+2aFIdJYlk3tGKckHEvXl58+HceSeiIsKJYSU160LRQBAxpRS89w5FOhNP77zVa84jCxRZEFZA7d0OEIClK9B6USYAEPnCB04a+gA8H7zzNhXVk7aGLyzEHJdt7ByDmWNK24PwtKe9Y6HtJzscP+cnY+TMBxyhsOLdDcODuXzhF9760fzSqMgBQFpel6ZYn3NdGGPIDgDmvnteHvOl+vB78o1LGxsdsbOOUKsHEdEBeXJkPsCHbWmTSla8PzXdktO7eLMu2B1vmGUYERrbTsEX6A64uRXLy+BvQvs33Gyhet6iXQUIdZBnnU0XOkWXB68qqhrTKmIXsW5bBCqyEJxzBPaJp8R58G1i5yjzTkFRNfNumAdWYNE884hgOYkCLiPXR7SbkAbRrARQBOZNqmMCgCLLJ6PRsMhY1TlXFEWeZQCUODFzjFGYXTfyahy9zceC5TU6jz7424v2K3X7upbr5AwAfASHdaEziKWkDfI7lLWkpaR+rOmI241QvIT56/dPodbmYLCO79OCtnLcoMcaiknVSNVwTFUje4t0Z8GPjpcAcGVCtg9Yz2XNU4tZqNEtWdftbw8SVY1YWMdBouMKHmqy4p0AIMuyLMsMmrPhYCtD+zoP0+vV+vterCV7mZ/75NMvPHN9ep6uWfcIO4yLddq9b66ex/cmeQBo2tj7Gloj4lsq3r/tKv5CXsXwXf7MH73/4+P5J25sPfvMOrKfl+t8V7D+PLK7nM68Wf149JmL976J/Nmv3/uxT39onPPxsvnyOwezRfX0pUnTlsyiqpy4aiIAOCQGBeXEwKqo2jmvaqdmc0SWspZYBUBUh3koQrDxKCLnHTkET5RYM+9UtQh+EIKIDHMA8LwaGbfY+9X0rHrnGGCQuyLPBoGIXB1TZCByoGBnb5Ms58FEGuBJLXl1WbXCcm1CZ3gYw3cD+hNA92PTzKwzM+dJmJNSxk//6T/57e99BEZhn2midoEba3X7flMasq+bpMNqzB0APlc+uuqLp6ZbqU4ns2brZftqbbbnqpQN2e3229A+N9w8QXbVXo2zO94Yrbr6lLnDtpyR2JTTrViOBR5C+o/HxyViEZwhu2JXX5sicTgoPGJckWbQxXWBWLGtSkQxcWL13qkKIsTELGpqWxsoDc6JKqgmlpikiSmyWOqWsKh1RUVyW4BXashB5j0RK6rqsqqatvXOhxCQkFWtQldRK9idwxACAqSU6rptU4LuJ6CARASihN1vBXKs+vIEv0itke998T4AKmo0qftM0lhg83Sy5v1Uz2L9o/klfSvdmdVn8L0n37WNmIVBoEIfi+81uh7B7x217xx3spmNYT4sfK+9AYDmIjncUQua1ASRmxkUDmt0Zubece7rarkhSsrCheX8hWw7+ZFdyYlP/cr+pU3d+fQTz33khd3ntnc2/OVN3YG13D5TWxq+v3t453FPcQbfcxfMvDDPwrpSW1zRYVmGHwQTAw3P4/t3wtsEGm5fuTL9oT9pJgQffB/w7eH4hS+VGzHOvS/b3Sr/10DBvjuHTeRf+73XP/3s7u6GA4Df/OJbr92dvfDU7qJu37zfEmIbE6sNlxKrpKSILgsEoorIgMNBnmXeDGQcobDGFI0MJe8ckfMOgewRAIBBgwPTtwVH2xu5pwQATaSOOpdunpBQcVUBx5REhMgJcxUFFNo2mdhGlFlEhLuJFZEobJHZzokI5xl1jORocmHX1OXhlKW7H0uM70vLWJf1q1//+uLV+k/8zRvzf186qn1t+tcapz2vcqealW0jqdMdwpp1iX3/Un04JP+J7SvSpD5D41TZvnrYSpJFMnWz7OgKdDYf3yO4PamIzmJtyN6D/rJu7qdq02W18kFTWmD0fzg+fLeMhfPCJ5Ysq++a5yF4J8rBEaEjEFS2hrZz1l5AUW1i6qK1AOKq3AZEAQiOMn8yp+YRrU8zzIONcpGjpk02odq0yWQzjtBmUJNCYi7r1ns/zHMkhFVauqUDdFMEq6U0eF/kRV5kKaW6afopd0RSBAR1aPw5FsE/mLc3CzDyvSdnhuQ/gidUJ3k/lrOtkVux3AjF90n29XcXHOujquqtgHc2hla/Nz6rBWt8LyCt5RRe3Ttq78zqUoNZ/uaZ6w3iex8CqZpeM1OmZMg+Gg+2torBdPNEyxfWYgCzlfpwiNJ7pp/nbfueqjEzmSzPUDRZ7q758YvXdj/59AufvvziM8VwmE+2JwHORzv1jzkdfxt4apW7mWhba0KbBK02dcup/TZ0JhcqTz74Jcu3JrtX3hfZ33cfcCGmX4jmgYbv8ZrX5f891Z4HVzfyu195++Mfuvb01Yk28Z9/6c7dOf/JT1wPBJ99/dGyiavUJBOlSCA3yLwqg6ICeMLMUyCYjkKKAoosysIsYCoXj9TEJKy5d+Y04BAz0sjgA2XB51m4e7AoG8izsGyaJnEvojCnJ+ii5jDPXBEgCgfnQLSzFlhNpXI3iC+RJbIEckXwjoSFAICiAsATY3cW0Nd5dj/uEX+dfF8XyZxH9qaCX/u5r/z4swUATH6WpEnryA7rgRgAd6rZEbe3oSXvac3Dz0ZjAOCNdj4k/0MbV8Ws/tYAXU7zag1wrtQNo65K/vup2iBvJX9fns9Te6+ZXx+cQnYA2FvMJKUjbk1gsyD43+UP3y3jGDFxAiJFhNVskbCSWXHZgtfr68k1MRm1rSJEuKzbPHi3StESEe9IEas2ecI8eF1Z+IqIrRaD4DyhlflNTM5RngVbpD1i7inzTkRb1jZGZh4WWR4IADJPtktziITYY7qZmvX/JaQ8z51zbZtE2Agyci4aT+gdAhV57hBvtQwAZihm+G6yGQC4p/FoRdeMT3MVpaRb9eyH3SY/dG/uNbNa7ix4f1Yayvc75nLZHMzbKsp5iK/xpP+5zp6/cxDniwZWeR2niulzO4Ch9y7zOzuD6WToh2MXaH21oHVYP7mSO8N3K+HPYH0vj1lH/J7DybLsey4P/8iHnvnjzz/9wpOXRqvFZJ2Z+ZYuj+us8rkia+Hc+2ZffYcV+rchTHxv1c239FLPAH2/CzlFuWxTz1b19qQA0Io61KqOX3rjnU88/8T1nQFo/J03j/7gG/vPXdm4PJJv3JvfPViMigwAHAkALOq2A1DVJCfWNCK8qOKyqhSEhXNHRQjr+KaqSaS7v6pztL0xAuBADhGrug7kiKiq6xD8KqAH+l2/I1DlPLhAjoWcKe0ICZ1pZlghigg3AmSeCmtP781XUgICwGRcrFMx3MR1EF+/vo7spmc/L3I3ZP9v/tNf/Uvz9snvm05+ljr6ZV3GvgbKd+r5Ebe3pColbbqsOH2Gl5LeaOf70v7QxtUzRTqsx6iu3tMcnPVRm1XtUivPJD033OxKfuu7lNUs1tcHG10noN9L18sjaQFAVnOLP8MPzMi3RVTErqEtskpW0iLLWFXR0Zp1aBMZEZ0LiSVZ2ClRngUQTaqKLniHYKMRmmdBxFQ0IKJZ8EXoYpjKJiKSKgSiLHjpzD4RiVigbDmKNm0LAHmWIaIqsSoqdmwRABKtpDT9Lbj+EYQQijxLzDFGU9GQ98m88okAYJDns8QseofSGXw35/dDaWeSyPvzuqZ5rE0TeXvGByUflHw7uQcN3VnwnQWXdWpaLtUdJLpT03EtR+p7iK/R1YIzOTF3rFnnrdase4tkIksr3idrVESNTttYRZGqMZbGZX5zEqaDwajAtRfWAoBu5JSdHhdax3eD9bbp+Jbzs6wnbMla0yD3Mp4OblzbGK4a91sjNdP2x1XoT9J0Kzy2eL+wswqnI57/dSpnvsOH/S6qIY1c6p/U5XR8Udmu3ABARrhs5fNfu/nhp6+PCwKNX7s5+9xr98aDwTQTADhcLossc86832lZtcycWBggsZApEwmZZXc6GQ/CouLM0Sh3zollUuPKY9usXPvD7bhsHhwsPv7UWESs6HPeIYAADUJgkWiC5X5hYAWg4IMtJJFhWbWZd5brBACoHBxlYZB5FzyGtdYCixwvGiLnAW2P/N7voSE+rGz9e87doPxCZN+9eTT9q091Srsq9qh6QrKrEuFhrA6a8u1UZoIfPr0A18pl25h1zI9vPHHiQrO+xlwU5WGbsL5sP+L248PtAfn+mSvpOqtn/sxK0t16viBYrBbB/5M++HXHw5BZzb56Y1W7xBXJLDCFVzmcCFEk+LAxKpy3MXeXBw8AnlASMwAr2HQSEqaU+iAXQgyeCGE0LKJAFaMjzDOfRBS0m00FUlUVCb7TPtVt64gGWdbLqBxiEtkYFZ6IO3IGC087G0Nc3YdVmZOJsuzZ8zwHgLquVcS4pZTYFjDvXeb957xcF38L4tt5a4OpFcjGimfv3+0z5MwS4YjblzCvGunNz2uBQ/UHJe8lF1eDx1UjD+e8t0gG8VWUWvCMgF2TAkCxcqpZ1LwzdhvDfHNruLVVDJHXS/Ia3fqvu0AXSqJ927bn8f3MzPqZyn29YL8wpc9dOptSfbXYgudh9tpDc/Q9c9nwl3cmg0n2/qj3vnlD3wYQv2+5HaX8gIzNd0jsfLeWnx7ZlxFhbQX87S9+4/s+8sR0lHGqjhf8qy/fU/CLKh5X+utful03YKnWDH5R13nujJZp26QAhFacIgDsjsPRkllSkzBXDwCjwgPCrG7DSoTrTnI/eOCdKNcN5Fmo6prIgSiLEEgbUxJV5d4IARETcx5c3cZPP3cZAF67+SABZN4zR1Ul50GViBBAFBC9cxRTQ+jqmEiT85kIJ1AAOKoqAAjTSU/IGJSfr9/7RrcV7H39blcM6H/+v/2l3ZvLT/3JqyeEDK08e9cKRiLcb8q71ewmRkd4lQpyvi/bzSdgRnJT2p8cP7XuAHOC72cik1j6CSYTwNjj3BhuTIeDdQnmgDwV7oxmppL0Vnm01ATgxwLk/d/iu79OPAyZgJloqmhnjo6qouC9G+UhCo8GnVsnEJKmP/2pG998uHz13QObDOLVtIF5RZiTDDmybucghEnhq5ZZlFlYde9o4QgzcoBoLm/mTxA8SWJPyEptm5JCjDGEkDunaMu9M8P3xHx9e3jnoGyWzCKiwuryLCCSmQww69Z4UMWYLJ0RUUUt5aOsqizLgvcMwKqZd8ySZaGq688N0w+X4St1WwD2hPs1DPc0bmCYSRqv8H39tJxJepZG23eXmx/fzUICgDb6pikbP5qkZaX5IMgA4LiqpKqrRmrGotUhKjQNnI7aQI+D6abBNLrGLIXHhduejDDX8kD6tmrT8kYbeyPUPBsCQLZqt+IgF3faOOzCy+Mw/WS1WSF7p5TPsrZtr48zC1o6ObbCZDSYPDmYuKvxwvbpc9s7NLz63szMg9WQU4yxaeOZhurJliTpsnUNRw/wXSyQvyvQ/20juz3+heT7evHOzWM1TIMi/MrvvbYxzK5sjzlVAPCFb9w/LpvgMSW9vZc++dzOa3dKI1aXTYOIhE6EhYHIpt6dd9QmZpWbD+dtmxx5InWo5tVl9RqCADpEXBmBifcBAFLSu8e1c5lNj1ov1PwDIndGstZQtRgi5whA7hyUgQDJWYPGBmvrtg0+gIgjWg30gKKrU2SBzPuMqIlt04qpFwAgHs/7nmqvk7mQk+kjO3pOpkf2v/tf/tKf/obC9nAOsHcsE/M3Vzjrq45YxfZuPf8qlluU3aDBVT/oC/Z+4OjtVP7o+OqJpP2cOXtfsDepzV0w+K7WkvMo+OlwIC334pzuygrZ7ZZ5ao/KhUgaoQdWCuFv8d1fkXbDu5aTIiKRsJADcr5XuA+LnBUQyJJvTaKeZcW/+NqDpo2ZdzG2AkQgjpxzzhaFvmnPifPQLTjeO24ii7BCcCQsG5ujR4dza7omFiZHAEikoADQKMQYi+C9c6zqQIkCrr0n37x3bI0cVkWAJqb7+zMkUhEjZlhVBTpDGVHrwWbe02BY1ZU1XZmZFcA5VKUQbrX8NIED/CK01zRY2b4B4R7EGcSB0IYvjM66DP4hnHAYG+Q/5sKD2d7TH36hbloAaNJw2aTYDjYB6lZQ641hBjCdlW11fFSz1kBdm7TVSYZD5AqQBoULNLLBwOAeMe4vmCbT57R8KNlD4urgROfc+IyXDQBueB4VeG3rxDGpaXjTLwHgONOztMzjLo/jZDAfFmut0cnQFztX+qClE5oeq+FoevXJJ1/6nh/42KWX1n/01Nb17SvX1r0hHwOxUwjTx8VAf4dI+h3qZP41cPfnX+E64p+5nNGGTkaDt+4eHsyWL71443jZ7s340f7srYd18OgAY0pPXtlRGiya5BxVMQYfJoNcRBDIexdcP/aNddsGcm002hIIlchZWdbE5KDzaTIGfOU8LqrgCctGqxhtN0BESmTUAzP3fE5iZoHMZyKYWO/tH+/Nyyg4KApDKzMjcwCgwCygwNyWTV3WjfmXFcEDQJEVNjw5Xu1BuYnrapkLkb3H9zMUfFPBf/E3fvUHhxMAmH9y48nvmz77Cz5Vsaum1wb9u75lvfwqLAHgSQkmTbEvQ3YK/nfk8KV88+yw0qnz6sR6ZZDlhphV23QCm7aBc6r29XxtyhysDMVu1TOj2kFPkN2MfE/t182DzKGV7Z5IRBKn/qMx0LTpYgQYFAWz+JApETOrdoJ3VG2TRJbMeUCoWk6Jncm0ELwjF9zxomKF4J0jyoPPTEcrQohJpGniIM8z73rV1GoTyMaxV5G70XpLzibX32MlCopJ+tZF5wLMIkg4KAYppZgSketTnzLvF6o3C7gu/rr4l7XpZe9WvJuKhnrP89Pk+7NN9vCV5TAPRZ4VeZZ7HOV+XGTjItvdKCbjbHcr7GxPn7s+unLt8uYkL9yJXcy8VZNCSlUDwMZ4sDEeGMtdapD5MQAUg+HQe1zLKVrnZEbBb06G9hWybCvrrEeW+zWdYWDOMO/vUa2vd2z7sn1SjK5cHmyNTnWHBrGrmwajyfXxlQ89/8zHLr3U8+8b/nLnAfkewphia3d37PPxaicSTC0zOL6A5FlPn7j4T7go7+bbwPfvLnG/3iY90ym1zYH91670yP44wUyH7xlOqQWAV289+LFPfyiPC47tl966f+tA7h+V5gljA6hf+uZDZnl4OFeB7XEu3Yg5WliSTSfViYsQCuM3sHP+M+EKAHjXWf0RYhRuEyNCE3lZtYjAoM5RturLiYh13PhUwaqOwNqrhDDIs2ERLBm0aaOCArDtzesUGQAQlm2sIyTBzPuRleQshkTB+0A42in43PDzYz+CRSnN4VlD0Eb/m//0V1943gPAzXe99VGXddOB6Zrfi4HIYVt+WRYA8AkdblJmNo32ZXd5uTn6lJ8+Nd262IVmnZBZu94jeycRHm+c4V5sC2Owbj8S0aNyITEuNdlD/b340JCdTu96LWxWgIWVECbDIjJn3hc+oPEnCqKAgG41spRYADEmqZvoiCzlrutDxBgcWYTGdBQQMSZhs+EVZZYq8iBb65OotjEBUpUkxTga5ETQ/W0qtl1jERUQAQvY68B8lepldDyuNkAWtN3tJJD6loaKAmiWZaBqoK8WbYVIRLdavkMJAPrm6gn9AnG29uYb+d5D/LM0okVzMFte3poM8zAeD6ejfHMURoPggx8WG8NiY3sUtsbTJ3anT12/dunSaJBTddE+O2TZ5mQ4nuxkuZuvkHns9Lww3ZYEXVmP5R7z1Ttq3gOl54tzU88g/nu0Us+x5/H69ng4HFzUSKwM35+/8vwfefHjf2znozgdcznenoQP6AG5ubYfsIDsu+1Z9mXisUuHiI9NicKQa2ze4w4fBIXfQ6H47UF/j9HrmH5G73gGx88U7/lgGDdP+7W1qm765p0HT18e7E4LAHgwjwdLuL2/aNpOH1aE7ObDObMs69Y55wmrlpN05gGKjhXMS6Cq2yx4kGaYgyPSVcc0ijSxo26DR0JwSITYxDTIw9bGcF41wmbqDQhAREnUuYBIp1xB0Hz7OusbAMhcYMsYIUJAANemtoldAIgIe4vIJMqDc0SOyK0gJjg3IDLV/+MK9vVankJweeAqcnOidqcc//bf/MyVJ9MPf3rnrV853v7z3fufK3VlslV/trlBPGzLN6vDGcTnNN90+TmhlP+yLHYoO5G0n6FiThMy68DdI3vZNpvD8ajIT8brV7J6IlxH/MO2PJJ24dD+un+gBxa+YS5g6y8sqWsVAEgUijwnRO+oTckGxAZFhp0NgPFmCgDLulaAxCZ8dL1cKCbOvMuCV1FHeDBrnOtc4BCg5dREHgSHJx69UMeE5FRYmIs8d6gOUVi2J8PdzbEKo6pD6AKeyImq0YA25GXcSwffnfsOsCoiWktAz7235JzYjhJsMaAihFnimwUAwHXxdyj9ti6MmTHZzIU5WSY9uhGG3yfZO6+9Phrm42ExHWbjYT4Zjwzl7cuK+p3N0ZM7oyevPnHl2uV1w69BTpo0lQsAmI7ync0R5JuVH5cahhhPKxUVAHjNCjCuIhubpKhlaOc6Couobcl0HsrfA9kbced1Mla2d8+9c+UUsheTVd1xahXZ2b763JMf+Wj2wrX88kTG7+3bfurk9B/UCrgP63jcTw3ivyU47mvq9cr6cb/1OLrmgzzLB6d61h9t2Z6eftQwCjqL1d5hfOH6Fa1LzMOrN/f2FvHOcSKipk1mr2qV0ajIxoMMkezEQMROYLbyCXAoxE3wefA5i4giOeiiNohYANERdt7bBk9W5hOR6Il4JrJ4QkLAVch9b/ANAIgWao0OQEVSYlZkkc6pCl2e+WDZPegUhAi3Nob2MlikNw0mB4OBe1+pTI/sEiNgsNTsuCjb4xnl+J//N58BgD/35/7o8c+/+6mn0Mr2kwZmr3JRJcImtXfr+VvYbFF23Q3NQGb98nJz5Ah/ZPe6NOlstd7X6SuxChH2KR/rTdSeardJpRMqZsW829c8tXfr+VLTWGCE/p+6Rz+HVebP1uyoCiJGtQuzGTq2iWPiJJpn3uxczKnL7Lo2hqGs2841HZGIHKjR5YqYRMeDHAGQsE3MqmXdLup2mIc88ynpsAiWAWoZpyxCzifmyDLIvENtkpgtcFk19gwmr9KVtVyRhw9fHoCKs2JcT/xksGPJbDIVbZViZk/duCxSJ8UhorZt+9oCEfM8u7VaGnt8t7PDmBnTRNLpuX0Lafpht1m83D7YO86z4MgN86xH+fWvYR7y4fDKpenO9nS8uw0Axrl32qd5s39wXDetDz5f29hQeQE89hlMbWoBoMizvrq1sn0eV5jbA7pdMQXkBwGXofc9sk+GfneaA0BZVu/7izuTwXPbOx95YXeyMQWA894DjwPl8BiduPktzJMmbt+jcrea3X66vgDYjQbfj2Ph1zH3g9DiZ1aFM2vD+24LPgihv36HUXZqVR5ipLz47JsHLzy1m2UB87A341dvHzRtfHh47Faywm5haGJMHNu2TUlFE4uqekLba5uWOPfZpelgUcVFk6Czb6Q6qZX5rOpdV4kjYRPTsMhGOcUkg+BoNV/XD0GaY7DCiQcsixRZ7ghFmEBsT7Ax8iLJmBwA2BgWCBiFm9SmxAg0HuSjnAhdTDEKm5pZhNu2KQB3Vqr/83F6F+hTNVr9DgCuGP53f+9f4Lv6V//a9936ja/dfNfHn7o++VmSlk8F5q3+nEp5nWqn4OvTIydflkU5qf/87jMW0nQW2decBoSFHBnBAgD7TWkku0Vt9M6Opq/v7N3XNgGEsJT4zuJgqWmEHgB+XY/+dlv64L1HYe3LdnKY58E7L4oAZAZdCmIZd8MsEFGbeDQsACCpMksT+XBesiqRjVNJcGR1vQIKS3Dd5kmNxnFUtcmOoqaJeZ94ZX86IgAlERYZrGAk92QbwTrx4WxptkKoGrwHESLwhMVwhOTsSFtvV6iCtVURTfOObA0egS5qVbtCl5C893XTiIo5aQTnliyfG6Ye329B/Dovt6hL0y5PMzPrxfuTkF0F+tIb76zTwoby61+DIkyH2XSYPbE9urY1uXRpNC1oOMqHyFa8Hx8fHSyjgXUIft5ePIy57jnDUczTO8Xk22iEe1vycbWmljnB9zVYf29CBvOhkUGFuhp5Uox2hqaYxjO0+4UN0mtP3NjmaEHYzeywN9d+j8s6gXNeLcNRzfVX6gj5SdjeeureOprbjamaV8tyMV80VTlvdJJjcptbI53ubJ2xiHkcMfK+QLxe41/swC5lv958qx3a7sEDRDzZM+2M3f6C/99fvHf16tXdadE2pfODL731jZgUoAJFQHVoGaYAAFvjgfkpks18ppQXmTU/wep4Akd09zj1wQ1m5Sja2UbbKSiSyAVmCd7lmZ+ViRBYIKyx7QCAgArKK3W83b5yelJBMjMT0vTik5dfvT1rV2rrNjFzDM4yeZxBxoO6XuGaM2QhdE3U4eR9NFPn47HsenF5+gv/8+cXr9b/7k9fkYPb6Vfbp59K0ymd4U/Wprp0bzF7Q0oAuAL5JmUFunKlbDni5ibGGcS/MnjxsSFNa/S6HwRp2RDcdOu2CTiS9pnh9jqIn2kkmv/7nDtkV+dB4Kuw/BlfsWIgC6xQIAJzaiTkpAIKoCwSyHkb/gX0q3xXBJQUWbRNzIiAWCexyNpVEHancrHEu0Eeyrp1RCoaPFVtIoAiD21kBbWmTI/vqMiqKjoujAfvXODz4GLi4IOur1moACACrehXbx70/mIrcl4tzMM8bRw584iXrk+7MqNEy/MQMadSohijc847r0TOu1st//AKFW9A+H1orknHzLSkM0kb50zfFgRE8mkZf+GLjw5fXA7zUxvoPAtmxcPS0YkAsDMd1k0LcY6Yiqppgh/GVAEezZv5ok7bo/X99+PK9hWOlQBQN20jEHrH4NgCgO+h/ALO/iJk7+0HtClzYgCfe1EQSHT5yvala9cAIEuHy2Po+ZklFxfC9njox+A784d4fDQfb06+07YkR22bsifW1yma87W8xmZxfLT/8CEtSwC4/WBv9uhgGREynGTZ7rPPXr42f+r6zuN+/QO9njUjBBPp525+hmgqm2V9tDhcYpa7rbGj4oMqgqSOVIT++/Hh3uK42gLYGbvPvTV7/X790ideePHZq8vDR3uLqhik1989JHJt27JithK0aGJA3J4WB7PGCJY6xeB91/ZEirEhhEAOCJmFEEE0iTKzdxicU2VWCA4CuQSiAjW3wzxPpn1Z1Wks0sROOGGTiCmxxemJiCWriWhwIICAIKIhZF95Z5/IoTKQA40KZFL6XkYpot7MT8jRatPtHOUBy2rtAF6Zha0ju2nb150+uYnF5ekv/uZX7n/+4N/96SumZ59JeuavPmXzqL1scR2gD9vyDpet0yuSXwZvZbuZNR5x8xB5BvEnx0/1bc+LM1FVAZEyJy1XksyWvWybWtmWiu18OPGZ1fWdH6foOiFj8hhDdqsuvwrLvzNYLhrNiISVHAgRiDjvkUjtxTArKClkmS+CZxZE0JX2hggXdWoSD/NAiFGgrargqNMc9vJ+QjOEMSNoBSCHx2WDIMOisL2CfdAxseFyy6qqbYzDPO/+dkRe40mSCKI451dFhgKRqjqH3pFDZACPGFNaMXvdblTB7CQ7tkgBgqM2sXeAoP0xIaomA0kpeecUMc+y2bK8BfHGaoLJEf4yLP+Cju5pBIEM8Dy4A8A81ldD8dRs9rW37v+xT32oac+2ysumBYA8gOvi4N3u1mRZxQUAAUwxHUSwLuve0fzqzng6ymNMS8lGTT0uHKxeT6F8DGePnEbAJ0Utt2UBkFtEXxXF9+4Cvd/A42B9nXDXpsR8uDkyTkYAIPdinMypSz3/4DiYmgVMxt8huC9ZH+3P3ro9e7JuACBbc1Nq6w6d2xgBIOKgbfjo4MFg75s3PvE9ZpPwtXcepLYFgFuxfefu4Y3nD44Pr+5ujgCgqb4DO/hlCQAPU/cGXvanNuwH9XKxCsg6mA6+1Qfvf/fe3hEvq3ujwT//6v5guvkTf+L5S5uTR0dH+w09XMAmQt0wgENywNKyBHQOhIjKppmV3phNhygtsgigY1HTjQXvvaOYpBs7JUycWMQYe1Fa5SWJ9dxGee4cxSSmkHNEdtKSA1U1sxFVYRZVFgFRzTyZ/oTQUSd+ZwBH5MxWLBABhsIHZhHlqEzMQM5S+QDQwkPYot1ERLEGPQbY7GmZfOs8FXNGG5NNN37ns9/8wi+89df/1zcA4PYXjw/2yh/ZvT4HAQBTLopC76wgCodtWbbNEiETHClsF0MAkJiOpDWQ/ZIu/p3iiU74uIKuDt/XUzjsAF6UiXBEgTJ3XFYAYNNPM5KPDTaMhwFdo9pXuwcirCR1bAw4QPwqLH8Zl7datmwsAGABR+iyjFABOtqIHEpCH7yRJ1EEVT2ighrf0sQEqvbR102ThRC8K5voEIOJUhyxIqeYm/8LIiK0kQFgWBRGnogAiBKRcwAKbRJjYzLvurgnAFB1XaofAFKb0iAPbUzeEQApiENgVQfYq2gcYurisa1+F+1coE0e0zVUg6MmMaHLgutNeIycIfKcoogAkXPOB/85lRuru1wXDwAvQ3MVCACMee8HmvpxX3UeAF7C/H968+b3v3hjvWy3ml1YWlFzwexY0zzb2RxJdVwBFMoueGgVAKrjo/v7EwBIKfPQLpHGANPU3D+pXxOs4fss4XxRAxSxrELQceGOD9kg4ewq9EGodlNDbmXYs+1Nouc2vXEyH4RwP5Gur7dSv5Xi/XHM+8hhs/9wftu/Ox+8LyAuZqU09bhw9mlsXSp0FGBFT80X9auvvw2HD44vbW/p4oO8qv0FGyVyMVO26N7bd868mJphFYk7e3Qq7NsG1boDUapzUeAnRjoWrffq3eXLx/Wf/N4XPv2hq4nbR0fzLB8uq4Mbl4Z1VV6aDt7arwI5jmItJkN2ACgCLUTMbK8Iftm0MbGIOkdE3pFjVVWx7lbdRKNTFKhnj9t0Ile3CabNjaGkeLBoHAIoiHJMGjyISOfBSp3gkgAcuQ6wCFlURC9vTo4XDSA0MSEixASioiDKDCAMAg6YibxDDT4YreScY1FHlFgh4HStcj9PyJzBelcMPvsHb/3az331r/zlJ7vN5a9DIj//96W3kSFaq9kRD5tl2TZ3uLSN9HU3NMnjkbSGp5+FxZ8Nu6ZJP7GKfIzvY9U2iXDiM8rcsm76EL77qbpRbMA5KzGj5nsK/huzvXVkf1mbmwMoI2YExgM7AgtHtY9PQIgIhAi5yAIixRQddppFVHZAbWKLKo3Mquq9z4JjAUfkHXmipACgMTbGktl4URJNLNNhzqaJUXUIav1PBAZIIjHGQVEEApt7iImvbg02R8Ur7+wNisyDMCKqekcsYEsY82q+gpyqmgmBKggoqDpw1kS1TFUzFiQkAK3aREiRVa1wR0wpZSEDgCz4RKCqtt4O83y5LO9QMljvL/dBrtlZLKkfaDoll5T0KT/95bfvvnl779Mfvp6SAICNW3ZFd3Bn6Jqd6XD/aAqzYwCYFsSxhdxVjTx69AAAJuNCGgankCNkONBUAtAgd00L9QlKS1W3bTNfwHbwg7xY1DxfZW/582j+QYSPxSC3Gj/3Xdk+vf7UaBVDfMR+06VvA99Ts5jnW+/tQ2ATqoPTGX5m+esCTjxuDHOZH8/mx7Dyv+3+1FVvbX8FskeHpTYJs+zl3/2akdTHh0tjrGzpk6qZlW48P4ax21+w3edUW3iF4+lAAGC6WlHX77YzdpvbOQBsbgMAHB00Z+4zLtyi5kFeLCOemO91EwpqID7IC4DizFvRY33V1BvD/Iu3Zgf59l/+U89sb+TLw0dYDC9tTt49aO/uHT999cnf+sr9b9w79kWRRIssDDLPLE3imGQyyAGgTSnz3iESghVx3rvEIiIAjlmsrp+XjXOUB7+oamNaEcCCzZBARHIfEkvwbncc3rpXWmfEBRcbcYRWRSJRb/ZkOwMRVZDMUUzMwsYaAQKDmRN4URRIzFGFg8vEMQCw+kDkvANVlo4LNi7IO/zgux9D9qPbj37t57760z8wtVi+yc/SW035qcurst1mQdfad/v1smybI2mXCCOFEZycveT9PNZvYfNRGn1i+4q03BtzWj/2FC2DaKOnuc9GhU91kjqVa8OomyHrbQY6PXtP91tICOKdxeFyRTkYsgPA6y1n3ospAhGJvM1sAqiyOOccYs3sQ3CEbUoAGLxj0e1xfnlz+KVvPCiK3NZ4XgW6cmJE9N6DikKnQhHFPHiLscszv5wtrGYHAEn8wpNbR8v60WGV5yEm5sRt2xZZAJXIYCxN5t3+vL1/WAGiEeVuRfp76iYtvPeJO+aGVTMCZkAEUozKJGQyHFFFUEISwE4howoKuOoTEJ528UQUVUQUVUeE3r1S4PU10mGzwK+18arQBgZj3h/HMPwFHX3mldc+/eHrsHK9L+u6idyKZiCwhu9NGx25zVFYDEd1ncDcCFoFgMPDGsMcADZGATgBwEjFOBmpmCOvV+6adBlTHjS0CyiK9YLPlymZoePjMP28/LEY5JujPMsyQ/Ym0e54sLnhrGxfHh9xQzCEsqx62v29PHjX8T0eczOGDyB3rKqGWQFwZ6PuEdaQfX0+cz1zbrHX2o8WNduV4HQ/tgBwdK+9c0Kfdci+bshpQHwG2e0We/Z+5eiAPuvqcbtMocHtbjXa3M57fO/L9mVE87O0cOIzFfo6iJ//qd3y2XfmMr70F//Ic6rcNqUfbdx6OP/aO/tffOP+x565XDNtjXNwzgECQRRmdS1L3cYsBFaoWk6CWc93dk4A0qfUCyeEwMoAnIesbqM5Pa3GFxEAHKCRKZriZBBuPVooABFVbfJgdo8ng5d1EhFjfcE7B5oy5wSoTcmTErnDeUnOxzYWWQ6ozBIViZwAyEqIEhxZl65D9m5JQO5GaOGElnl82W7MOzfp5//7L/70D0yf/L6pIfu7x4c7T6f5XxUTyZyK48jcclGafOXhSkTRC9uPpF1yegsbAPjzu8/A6XRDm5s5sRxA3K+XQ/KDLO/LcKN6hllets1taH9keqlT6az07L3C3R7hXj27wyUAjMB9FcuXtbkK9DO+IvIAZhujlozKScl3bLtDVBBH5IliYsssVFBHGAX2FjHPgwONIKooqgqmnrKWstFf6olqFkRr2AKojnJq8lxVmVUBGPXmwzmb0b+jsoll02YhFHlQUVmxUisZFXUfbjexLJ1hpBjRgt65/qiT1cETE7sO77CbpXBORUFRUElAhN1KwigKgApohsMkKmAcFNihBIMsu7us7lBYL96vi78Pcg3ihoQSElzEvJvVzJVXD1596+71y5tVHVvRWC/rqixTNhqEbRjZnKkx7yycD4fZcFBXjVb1BjGj1p4OS41H1WBQFFl+nOVXIBoncSHHfdTCVrmoMMCg28GvaFq4ANYNzXPi87C+zt6sDx49seOvb3eL2Wi6CXB0Ucl9fEFsXhiAcfYrfP/gzDtzgrWElClJcNjD5cVszOpHhu+DvMAC5vUJj7QO6zNxV3K9MKzuvS9+m6YHAutrzDmIsXWifz2joEsoRkGXEdd9ej/IZVy4z7++J+Orf+r7nm6aGjQCwFe++eD/85VbrQAAvPTC1d/4wptvPqwnwyGreiKIqKIxxUERbGp02TQE4NAzS52iCOa+mwmqmtqmmeZVjYijPGNmFvaekkjmPZqu3EI5WJq2HmauajmtIVpM6tDUk8idtFGTiCNTx4OAJyICoEA2FEvkYmIEsm0ECdednHq1pBVFShxTZAa/enb7Pq+rpkkZ+nQgcJnODZ6cOjfNDPK//j9+5sefLXpkX9YNADxZPQ0/2/En66btqYqWTTqPtaHKJBSmDJiRLDntodzT+Ncmz9md1yUuJ91UPLGLWUf2pcS+bL8N7ceH253GBsHcDkROOQwftuW79cyQ/SbGX8blX4DR3xksy4gFIYATFO8crkx9TbCUZV5ERZEIiyycuOYCIkLdpnnZekeJBdG1iVlkczw0L5e+BlDVpCDMWQiASKCs+ui4tgfpWCjFZd2SOfbUbdW0hDjMg2ndFSCyBo8iQAQOLVBXMiLnXZvEOrEA0iRxRJa9VwSfwOYe0LwwEFFVyDkVUaCVG6XJebCzKwBAQhIF6BcJG9EQh6bVJRF2ROrczQDXy1PF+1Gtb+ftp5pQgTxO0LZB/irTa19/I/cvzI6P2obLlOqqqQU2N3cDAblJHlyvnJkOs8V42pZVVdWYBScCSTYzmLfxcNEEFMjTo7aKjEt+LCzcOkwfShEGRdXUs0W1WmnOueb2gP4eyN6Ig5Sytg1huFyWbcOLY788PrKe5HA4GA4H62V7WzeD0fAx2+HqgjUA3gfcWbg5vROYkmRDd2k66uGyr98vxHr76bhw2w3s19CvdT2sc0wuwObW4HyZfCHVbvV7z7mfSaneX/D+olxncjaevLpdjNZ7qgAQjh4d4tg6AT0bs+JkurI9MkpEkqov4V9/uLyfb//FH3ihLI/2ZvxbX/pm3cDd4/qJaTGv25APfuMLb/7+Nw+IXBZ8G/m4qTaGhYgM89w7Ym5FvQgWwSeWyCKCeXAO0Tlqo6nISESC951GzZEoekdRGM11xAwJhEUxONqaDKuWrWtaRSaAIrg6xiIEVXEuROaVwr0T7ThCRFIV1tWEqkJkMXcEUEjqhNsokvmQRFJiaiMAELm+lmUWK94nxYCgParqu/PqQ5cn3bwSBvIgMYLGviyQBGEj/Hd/718AwI0//TE5uN19Ik25nQ+NbT9xgFkpDu+1iw7HBUYK6vyGUF+zLxFe19KaqKeQ3SIj6Gx43k4x6lXtwjKLtWWc3k/VjTC0TmxPyFjh3LtRLjXdreeG7A+Rf1sXfwFGv4zLV8p2XBQCTOA8EihYwUseECgJE1HkJCJ58IQASK2A006QKqKOAKFbD1Q1DyE4KpvULxIWoJ1SykIYBOrX8pg4z4LBqyqkxIA4zlyduGqSqk7HQ6vWPSGzJhEnpqUBIvBEJnpxiCoi4hAUAHLvu0klQsXOOMyv3smuBlddM3VfW79PK0xUhZB4teUy0p8QU4qJOQshy8Ktpv3hcy3Jo1pnGDcgHEE8k73XF++fxvEX3l7e2n1g9XgtuBACgMGgXLTDCZ8mZyIbop6JZJpAKvf3bx7jk9OwMUwAsJzJ4CJr37JKUCUu3MSfkLpVFI7qz2hgWhqdrnGWF/dUCY4AjpbN0bIpCGZp+/ffqnfCNzd3Lt241uF71xI8Pmp13HAcwwc1ajw45vf1Ecuz0LT+oF5+dW+8v3gAAMPkFjWvUU6nqIzIeLoVqeuo/eRGlg3d/nEFQFWUDeLDlbByGXFWli4UJJXQwFBVaNBX3LZ4rC8hHdOCZEzZMiJJZS/AhcKEq1c3QUbDfDDsRDh19z4vZuV80XBs5kk5Ktg6vKjW5EACsBw5dAGhqQHglT3+Mz/8obJaLhr3xdff/eb9ZRIq8rxWVybvQV6+eRiyTEXbmBzCMHMmKmcRhqTg25RElRy2kckRsLAorIa6jXIJNiqDnXmAVX+kYLt1G3ZkFoeUZz6KzX8DM3tCFm4iBJ85QlFIq5HI4EhEvENQDc4jggoYstvenDmKoEMHCOTAEQVHbUqAK+HBytPKWriAwCxZ5gHAJtQXaxvMDtnXindD9l/8za8Un7n/b/1HHzFkn/wsLRclAIyKHH4Wzli4gGqTWuuazmPdny29NsbkMX0TtVfB5i50+Rt4wu1Iy+s1O6wcfU37OINkfD0gzlPriXJwq4LU5DH8zryTxzxE/ozOXsL87bz9TBOL4M0YEVCdc+bbw0l8Hli6+t0hCkCSDhFT07rgWAQQWdGbjVfi4H0e/KjIFlVDzquIR2TAFUqCCk9H+eaoeO32ocUogqqCmp1vnvkmctlEQG1jnI5GiNByB3EOcZj7NjKR6e/BBinsuyc033Y7IO0OmScR4FWma28/QCv7gdXtVlB7qxcAAQAASURBVL+rCiCCipj4BwlBCAlRSVWQOmtrF4IApC6A2y8RPzdMP1yeRa2XtflRDCxaQhpeRM5c9cVTs9nh3qwg7SHbD8d5PlyfOy2bdj6f1VX58HD+cG9Rl8lyOQqHVVLjW9xBW3qB03lMpbo+O3DFbMNWjsGppadOB1BFKNX56ozCT1Yo042Mhl4nf0rXaYd22dasLzwxntdLAHi1idP9e/NGP/YMDLcvQz2/86hePqqPPY4n4yofQTsfZHJh8sa5cn7sNzrhWpodPu6e9xZ4d//4bhXUOUSBspn3DNMK5TnqkrVCb6soABSkhTINZOSQuN6ZDr7n+gYA3EoOYNFXWhzTu3M3XxwAQI22TW4BYFj4wYa3fvKxru8eWgCQYggAVJfHklVZ1rbtUdPUFQ26M39plkQPZb67nzZ8BIBZClQez9vW2ilHVcVRHy1PKj572YNRDgC1QkGgeQ4AQ+9fv3v04oeeLnJqW3791r4LVOShicSqj44qIhpkLgwGVcutShQO5BQdg8YUY9JJkYlqzYyiR/OyyIJDYBGDS1VhNV+lbnfLIoDaRra5czYFBaEiIpCoFh6EU1mpM1GzYO4pOGqSGD0OVuOv2E9EZAFzkRKRKFKEAAAxxchM5AM6UXYUhBmIRFgEekmZs0lX6LzSRTj4wNwCeMBTZCM3kcKp4l0ihOnwlTfufOEX3vrr/9FHuorpZylVsZR0YfL1OnV+G9oSwWb1kE+KoM/C4qPubBO1x/d+7Khz+BJdN4Sx+5v28Ta0nx7vdqNMbeMBcjp1kgvLW9URqK4j+waEv5tm6J133pLnCJBQAYGTeu+Cc3Vb44oXyoO3RmKGNBxkILoxGR7PSxZJCm1i75x3ToXnZQNEtjqi96a9KRtj6rGN8vCoJEfWk9SVSLyJ7DsHR1pWVZHn9gYEh20SdigCg0BGeSFA4gRIVv47ct5Ztd7hODN4AhZs2tY5B4jd9lDNNVqpM6XvY2BtuBW6Jm3nTtP5bfTz0tZQVdHMBwmcYqpUg/e32mjF+1GtV4E2i1XxDnEDQkv6OHLmJcx/6e00+PioqOpacDIKm5uTK1uj8XhIjhw5Q3acP2yOy+qoPZqnw1KrDC5P3BAZupEjORqHvhi3sr1GB3Cq2qhBt30YbQwGebF/fGjc8kxc1bCfLy+QpswSbvg4S/06c7LgbPhThIMZEzeJTMG4t6jw/v7u5ugKPDxcYtnMD+pl8q6tm7JYAgCn4Pz7QbxpIuGwx/ezvFDkYQF5li+SzmxkabJpWsW4Ev+kLPg2lilBDsZ56QrZe9Hk5oCCG1yajs4/hfno56mFQLCWXtgHZY1GwzNGN6N1dr4YKePY6XHjj5ZNtWxglA80VegH5VKHo8W8GqTFxu7meDq49817vKy6MOsMN2FwBJUFqANAWScAwEFeDPKh99YgyYaDzdw/XMB0Ck9fnbRtfOPu/LdeuT/IXNmAo05TjAB1FNtER06BHIM6xEubw7sHi2HmrcgJ5JKkUe6JCJEIlYWDIyJiYVUW9o4UHE5H+fGiYWbqnKT6nqpyZxmo49GQuUtcAu3MCbyjbhQFIIkimh+JOlr1RQGa2HoE5zLvXUyxTVpkftVfiQrikQDWkH0FlCpSN5EVR0XO3E35eOcB0lFVudHuiTGkRoDQjy89fHTwP/5fvvDTPzBdR3YAqJWNkDkJWlqTlpeSZiRlSuensD8Li2sYzjRR+4SZdYXMsm6SyOT0IWT3HJL/Un344Wxic0wdKR+yTkmpaiKQO8sj4QiIC4LP8Owq0BXI/3vdX6gOfeiQHVURRLHroDpSUFHNnTX0JA/eOXKOWFVYn39iureIwl0j3T5fXZm3BNComgfvQIEwsZjIxBHO6yQiaKFd3olq5l3VJiACJECtm8Z7P8g8IrQpTQYFQmoTk7ONIDgHLILUWdwktRcAdZNccI6AFZMIsKJZD6GZUzKuDoPesVJXktMT75+zfhGKqoiUUiSkleGMAmAWQoqJE2chlIjrA01FjXWhVry/hLAhAS7yXZSUnqXRU7OD9aHHzclwd2vSH711ZCibkcrVwm9fgUL5Gw6rRuatWgpHvWLY92u8P5NBoCrKIJC2EYCOWthcO3A2Mxg5XNfJcEzzg+QnowuYo8nadwDoF4D+zpahirtTa722bTuvhQByD9fGmoWw5DwrAACGz05smEjqCAAVRICyLMIwp0H22HAJEQZwaXboN7b8xtb54t178j7PsxA8+nxiSXIiGEemu1eKqc1KSAkAdoldjuOMsrUNzqXpaF3IaCz5JGSw0QLAoOoWdRsqmoT1k1C9S1VMrlUY5gAwdorn/MHHTcQ8OMah90enhZtYLsvhaH3JnCedQO1GA8N3qGDkuhbKsPCIHvNhNszGuc/atlTazH0I/t7h4Z966RnQCBh+75VbZcudbpdFVh1Oaze1ic25wQE4xDZK7oPZNjVJkgnKoAcxXDkB2LnhiCjLfGJZVNE6bka8di01UUSMMdrsaJ6FZVkbiLNqAGExnVxHyFq5yioIhGBrkME3Oh+WdetQIwMROVRRJnTMLaL3XmkthpTFOgTqHAUXHEDbJkDLaGZTCczq7hgr5810PAQMxskAADr/D//zz6/LYwzK79Tzp6Zb1ke1yEEAaFAAIQfXpLZsmznX5yuCt7ABhb9y+cMAkOqzERy5C+sKmQF5oI6Z6ep3UQDYCoNXq4MN8jvFyJ7afrHT2KwudxaHR9LaLb8VDq8yfRrHn9HZrzs2PbWxzAKECiISvBvm4bisvUNbwJMooTrvRFSSAEDwdOegnFcRAIbBqK2y/+CIuuAOt+q7tivGBhCEtYmcB2cJfDbCBgCkAkAiogCTIkMAUAjONzEpgCNMiV3wrvvTyCOqV0IE5cy7lcu/IIEqeSJQUVVEYkCngj2Uq3jykdl+hUXcygPY3nLnnNnOaCeXURPVmHUB9TsqciELHCOLBO8/p7EfaLqG4V4dNws4qtUSmvqU8zNuBNZW/fJhubk1bA7LYjVyY8jOwikmrI7GE/fsbrYNcBn9c1dTW3YS9eMKALBGfzBvS3WHDdvexTqCvWXYin1GG950DfZ6kP0aAcB/+MldOG8MedpeZnOUn2mxrkJT+eT+Qw8Au5efeOGlF3a2r5oShlbWrOcbpxQG21N3NIe0uAMAizL1hfAgE4nV3h7s7o7P4nsvqkniPZnandU4UnAOILaLVlNMUh17gKwpXcDJgDaG+aTtPiXdyHfGbnL1mQ5Y779jyD7aKcYzfKiuLXkSoLdoOBlf7NcGqUaLapAX1BTH5OcRoIZJMToD8drEU4rU4cjKdsP3mzB6VM3h3XmZFGuZAYyqpQtoPNLJ+1+nJvcDgCGayCHLAELwv/31gx/56LXhYJS4ffve7OZ+lWcZqzZtMnNdOe10ag2oNjKgWs3FCimxghTBq6oABqKWRVVVGYBsv4uIq/ANZe3F2mrb534PriIUqMjz2bw08QyLEmpkzDMnqoTIKiY09kQs3KaWyA8cIVLL0ZETYQAkcrFt8+BNjyzKSR0RiLIoOArBUxvTsmq9d0UWVssDG7JH5jxkHtt+3wMAhweH02tbff0epsNf+J8/DwCG7H2y0n5TAkA/tXSqzaPUIJeSbkOLACP0y5NRdngLm7fz9j8IH+qQvbd41FOujWcQv1Oprw00Wav2Y+PdM/NNnVuZqi0/R9wYsv9SfljU+GkcP4Dmf/RN5jwBCTD0NTMCIubBee+8wzaJd04URCTz3eSqgpqhI8ekwpHFEmu994CUVmkqatF0AA7AYHTQbf4AADaGeUpsDQGH2IrYAFSAFFMaDQYdgHdCShVVBPTOx8SRZZgHABFEUqPOu36pJ2xZMuwwVAFjSojkiawoQVDr/YDJGUWRcKWM7Mp2JHSI6cQ2EkBQVAjtOxESc7JY5uA9x2giyzomK97vg5gObW2mKQKEC5mZmaSP4PALd6oqa85QDj3EH/t8VNfHYwcA208Mt9dKzB6d5vff2V/wcr8uPUdGbRIADELbq7Rn4jjqVg4jh1pXq/F2+sQuwG7evWU2a5p7aRK1bdt7EpxR0dhsai2g1JnMGMobAb0x3fzxH/ujz3zy0+AzAFDXPRVyBb3O/fQ+dHe3hXYrzQ79HFKzODOwunfvGMLUzzuJpM/HEKaXL20uy2a9hM+DkzyUTaybNm/rKR8fHZcOYMyMAz9VGnuENulGjrNm+4nh5OozW5cKADh8VB/Uy9mCpy0eZzptEYoC6vrhEKw1cbpg727E3Aeng7wYFw4gDjXSZCrz47JMAtMe37srZcpyZ6ujcUF+lANA6/327u7l3c0msvVVej9OyEBX4lQslzgoQECbEiYbIXjnszdv7/3Bm/s/8vGnXryxebBoAOCzrz5QCg6xjcnmM4hIWJCIPHHiYR7sjKrbOBnkSAhJtsd51fKsrBIn7zwiJoA2cRaIWVjBIbBlJhN678omekdVm5KI91nP1iFAYnbO9e5ggChmQ2aBeao22iqsnsyoVhAI0WWBgg/m0xuIRDnzvk0JIbnVGcoKSaTwATGwats2SQIqj4cFIejKMMtWCGEOziFSng+o5dszXh1Nc6NiJEGYDn/ns9989Zfv/ZW//OTesTz7C34CnZFv2TZP716ysn1d6JIr2TzR/VSVki6jN4HKEtiQ/WVt/jo82ZnxruGyMS2DkJ2YPupJ+PW6PWTDsZR0xO1zw83evqaL8dMVr4C435QHTUkhSEo9srekfydfLhodIvVUuyKggncYfADEsoneeZOImINX8G41ToWAYGp3RLQBorKJsLLSXSfiOv+JKOYGXLXJEWbeFYEOmqSJjagRYVXNs6ysqjzLHKKV5+YU1vstEGpS9YRmM4CqCgQgjrBseRC6BmhX0okwMyH5rmWrDoEBPGGrCIDee9uqdul6600XVSTilIysJ8AVc9V1WVG6FrEjCllnYS8It4d4Y63nWNT4vsU7AOxQ9tRscTwYDSejjfFgOsph5fcJAD74LMuWZXNzrx0XzvDH5numLT43naZLxWi6ubxUTB7VNH7neG1S8slRvYiqowAAuIwAUHoeJlf6wQq1Vtj48PC97F+Mrb7gdoGiKTEfNuJyYnOY+diLH3nmk5/WvGMwcdKVxjp/B9xjzADcAPKpH+7sXgVILbQnL+ZwbwsAYlX3oG+At7NbHB6Nj44XTQt5JjYGZm/ZTi5PD5eb26OjA2+qRJw1i6iLqOOAODu1ih4+quf335ktuJ91su9Yv1ezdx5biO0kZEa02PTpNruDreHRQfPu/PiwGW5uDAFDv85vTDc//uK12WLxjW+8I35jMvRUlzqe3njy6hPXtgHg8Gi5d3DQNqU2ccFYV2XWtrbitqN8sJLKlkrlor758JCj/Mnv/dCHrxWPjussC2/fm918OB9mzg7rzHubQcxXywwDJ+7a9qM8iEhKujMpNjI9XiQEAsTEKQTPiQkx9z6iOEJCNF7LIdZN9HSStWTfAU60Dd455515ACASOqSk3nlPCAqKCrISR3epyJwHD6CAWCftzWBVpW6bIiuC9zFFIscsWSCH0CQB4Mw5AkAXVIQRHJGYi612xjKdnsQJEfXcJS/n3ERrqMbjsp9EtQo9VZEczVNLKxbCKJr1iNSGoxEyl9H3bjD90NBPue2npludb8npeKbcBcq9tGwkzFnLMFUjf0pJd+v5E8Wki8xet51ZkTmHbXm3npul+K/rkSE7APwWz7/epGHIBKz9SAIKKt774IMDYNG6jdY+dUZVIzpEUeufIygkEFF1ZDa8ikiesC/bRcQTWTuPu+XZs2hiMcn2cdkm1dyRWX5GFudcGyMRDXPfntiJQmROooNOgokWC2NyqTayI+lscEDNNWZnY5hn4f7hIneuAcidmWGoIwQkFWYrHYRppe3GNcN9ASU5EUiuTd6RFe99RWJjTQoaQkjW3MrCraZ9mqAfaOrJmRp01jy2eAeAq0DHAB99eteFbDzM1+eKi+AWYXTs26PZ0ZNLhwGX89UUV8A33j7cdfXho2uuvUcHzTqyG/EwnjVaOJw1EHAR1aKXDNl7vuGU5e+3NMS0zs8MvV/Mq91r2zeeeaJHdsP0Ht/fx6zGoN8NYO3Xt4aVwX2aHR7Nx6lZVMs5p3Z/r44xLso6eFxP1OPYUjzefDq/Mr50ZQzxeH7gaj1w60b3m9s5Z9d6ZLd18jjTM7g/TA5Of2LD5ErPALADZ1cpPWj2oTEx+3wRlx6mecAiAMC8TJzaj37kw88/v7O/V3OqtImmNZoUmdXpIhKrY0P24ybGmNq2bRvOcme1/HgyKA/nj+bxzbu3B9PtF5/eff7a5rsPjhaN84Ec69dvzxoWQ94seFZFQhA1vyfnXRM5DytPPhZ70xZVdbwk5jbPclCN3M22qIqqFxFAdM53BMsK4FiFUCejQdM0oqtUazsSPHmiKMwKDiQpsUCRUVepqibtlGkI1MZIgOOhV+02756IOQJAFEY010DJfGAWsyJgMGLaeR/sdHSZb226RtksohAgOBd8AIA8kEN3Z677x8ebnox2n+TBDYf/w3/5q0a114v5BKbLRZm7ICy36tkntq/0WL+udQGAvXppU6Dr7MpNjG/n7Y/FyY/sXu9TVXsPGRHNXSBHZ/WUa8gO5uvLfD9V5P1OMTpFyKwSVglhvylN0r4h9I/5IQAYshshU/hgBbus2nwELvggIohaR+nHjoAoMQ/zrNsNiE7G2Uam7x6xHSTBu6pNuafMU2mmkT2zROgA6mj9dmxiyj0hoMkrC0cqYu5AeQhJJKa0MRw6RMsPcI5iHfPMpzpF5tw77dDW2cbuhMZEBCAFcETLJtZtUlH1nZ9MSskRIjmHmFg8kSdqYwx47n22NYwZwTlERhTVXjajsbOtUVHCE0sMURUAUnVIXbxqCXWhRY09vtfF+xTv1zB84evLy39086yqPTIAbG+M7iWNDR9VR6V34Lt4vEXURazuvlyNw6lG4yKqFelQQVsyLJtTFefaDGbPzvsL8boR14jTprywbC/oRBff5MOm1aoqt7Yn870HR2+/trU7hmwCAJpPdf7OhYc0Tp458yPkCgA69qadA8Dh3sIq91jFtjksm+X+Xv32zQdN23jvx8Miz4KF7RkFvyib+WHzzVvxm3Bz3fXFlgvczq+ML9GNJ02A/+jePYBnXHtPofEAMB4a4WVYPwLo22Ud7gcYg7f3FwBsT7So2STtuIwG/fsLlZFfME4AFo2bHe9tTDdHg2KYj2q/uLQ5AQCfZvvxienA5YVU5WFTt8cVryP7SVt76Odl+uLr9x4u8YlL4z/+PR/a2RwBQNlEvyowHxwsXn9331hsIEginLhvbalo3baTYc7cGlI5NC8wVyf+6FNbtx/sz1tR1chCqM5RmyR4KfLQpi4iIzinot4ROGpjciGwsJykV4KIeAJHVARKqQnOi4gD8USn0uPwJG+IRcj7NiWHWrUcvFcVY0rLuu2lbADAqA5dZMnQReQk3OF+b66ivGza3emGc7RYlobszGJ1zHHDxwA7o8n+8XFxcLj9ocu/+JtfWT4IT/70FAAu/YPpclGCd6BwGKut6zVUIC2bo/qpfV6sLGZ61JftiDehfV3LZ5vsf7H5lHE4Z3xjGo6DtTyms6mnog0KJC4lmar90+PdE+Wl6voDWrISAGxS9o/54X2Qfws2lgBGyJQRixUs9gM7eR5MEa3oACTzrjNYVvXOmaOLggJhHSULnoirNhFonlHuqbPoRwJhYUZr6gKYV+hwNGCRJqbheOC9K+sWAVeuoSAieRbm82o86NJSnYOYOCVOCiTqHZk5cGRlBWdipE6ZQwjoEBsRXrlRRlZEaJN4osxj5kNZR2/ECULm0RM1MSbpgpgcUeZpUbdkjgWIoGqeLCKCnmx5ds6vs2Q2s4pEEqN5KhFRnmW9JvIUDNZYF+9VvJtm5s7DoxtXd6yiyoMzZLcqfjrKH81g4dyT6YIyukeb0nNflUN7QS/w1ARPFAA4bPRicO/p9foxYpZaehU86PzYVDQxpn/1tbtv3Z6NBkWfdEEhFJPC4F7z6Qn53nwZ27nBNzcxtiwxWmAFp7bhuL9XW1VbNW2MsbdYK6slAGxvboQQfDEEgFRbMRUB4BH7dO+oN4fphS7Z0A32iqd3m0nr/3+0/WuwbVl2FgaOx5xzrb33ed1H5r1Z+aosqSSVpEKABBKokWRkWoQd0IKgOxxBRAe/3I5uR0d0R9P+Y4jmT/OjGwemQzRhGwPCtInGKGhsjJAsBAgJlUUhFVWlkrJUWZXP+z7Pvfdaa845xugfY6119jn33swsYZ/IqLp58pxzzzl772+O+Y3vceOF9smWaNO/8+CxXuxwaQnWvawB9oAvMX3nwMxbWTNb3wGA9i1JP5+WhwvYjwmbsBv7VYeLlNKd27fv3ErbYZNLefnujRQjwIufPto7Onil6Pbi8YPcD08ubLixeLHPx+sqtfNNLLbLf/Wb737p7fPv+uSd/+Xvv7to4zD0vUDpN+882u61aa9d9ALHm3K2GULg6sm5AALWRCYiUxtqaUJcJAZYnG0GJiKiWosYgOHbDy/6bIGoiPlTWc0QlBGaGPJOKIW/FBmRibZD2fR9k5LP7F6GGWP0QBKAEAMPWZk5+r1qDGAF0xGqSq1NSovAauLBrc2kgR+KmMmyXXjdaqmFiZsUte/n7wcBIpM36hGxKKaQur6PAT0bkplcYxMYT9f924/zp6YLoavaPfRxFj5ClQHkg/7ie7rXR9gd6q6CZWN1m4e52MinaUf2lzD+sYPXZ9rkkkJHVNGGIzwvvR1gqNnLfZYU3oSL1+JygaxX96iO7J3Wd/pzMDvixpH9D+PBBmBl8NMTIXMdetrkJx8R+50shhFZRGTWwPg6pFR5dFaraGCOjNllrAhQwUxlkkV5ieK672OMCDAUaVMUtdKXKhqZ0UwAWBURL7Z9IFom14f4MxNELNeqqoFDYDIARuQQXKsZEEUrEkbGSCgKIpaCczfAIfSlgCfhiHoBlCgG5u1QmcjT63wMF1UxrCIO7jMbQzzfFVz1BSACQBONg2rKRoGDiKiZicQQcq3vQDnaCb16CeM9KwBwzwogLJSeHt5dM/PO/Ueffu3udjI5+jbVH4gQQ2p4T3Ev4EF76ak8769Sw4UzXFIu+/HZ2VtnO5qVGw2eDBZON1cYCesGAHC/7Ie+FYzLvVRoedRE299Li70b2yGv7z0mFABg/iCE3xx3CzcOv+vb74bFPgBs1sdPHvczIwEA3ZABwBE8BIoxlp2IbYf1Xe0jADyF7AAAyyamhs82o6apK+qv3PvQwxNYxO7Lb8Ph4sHB3tKlh6cn3XwA7ML0h/zi/FTEFFvrAYAWjXZTH0gTLqptxA4b3l8tAKCUmprV0eGel2/s7e9RG5fNCmNzePvOjU+8BPni/TeX3eZBarfriwqwOuhDsvOz3C6a9Jf/zj/98rsn/9t/+7s+8cI+AJgJc3hw/+Txef/ek/X3fdtdsNLG5VfefqwqCUOuolIXbRuM/MVZa2lCRMKLrqi7N92YahgJiko/jDGt5G9oVZQoqMrZZguGHNGv0iFw7rMAiMIgEmIcpZZmAMoEkSkEHoYOINQqQ5FlYCIWgzAVyImUELhIJaJFZDBgjlKrl8+bKiAUkRRSIDLTIkrEYFCqZFFf+QIIEGoVV61VNe/3IGKfNDkyqBEys/pV4Xw77PFGApWzi3/037w1hz7OhPgg5XG/uezGNLsGx6fb9Rj9OA3UG5DfhC0A/JG9VxcUVHRXBqM2epWcY30msndaZ2R/K18AwMvt/rW/dzxgRB9vzlXKETe/oCeO7ACwMngLh7+GXQrRmeWJlrGU0njs4myVIlHTSbQeiZzrNyM1I7ysdNr0OYzpiSqITeRcZY6Ty2KqukhB1QJTZPJqUyQuIoEv162l1psHe/78qUNBQlLoa2VmZhYRMSxiiREAsgARVAUwi4xiFgCZ0M/+UpUJiMaUob6KVCni5tId1Z4ZIyBxNQHEXDWFOHqhQ8ilgCoSjVS7dzMhAqKa8mj9xSrCREg4lhD4YgnxvSW+trW7gPeseDGTkzOuojnACM8iZ17C+PWHDwA+O9Myu8O7u2EPls0BhVs7yYMBls6wexzhwbHu9eiDpgv2bsFi1k1emigXcNbBTkSBhs4aKTrbUDHuAYyGv+k9S44EACv39UQzbNtEALDXJu9y9S+43hWxRE21AEBWe3J2781v3Fs2cdF6szHMGceO2o7Xc1Tf1az2ck3ePv5e+u21M2Bv2e7t33hvM2zvX/HTPh3IwLGF2k1gTc88/WaU3z0PMcXWBOwZ/On5ensBzeLg8ODwqGlaM0nNynR4cnK2eDe1iwgANwCEc4gNAJx8cA8Aim67zXZuEdlvK8DylYP4//6pz3/p7eP/3R/53SGG8078efCL//obD067H/3eT71+Z//2AQPGz//GB5//2sMmNVW0SG1CnCXJakYcfOLOVQIhE6mBT7uTkWMUqqJLG8H9orotrjEflRIBxxDdUdXqUuLRAYhVtIkBASJB5ZRLLSpNSgBAzLXUaS+ors1Ts73mcneacw2BzX+nBqK6TOyZkaLimQfbYWhDZB4bP0rOAOARNAE5xDF8xu/XJedukNUiAYDD9Rcf5rNz5dX+P/jZR3deqU61v/CThz62u0blPcg/ePPlXYXM3EPk4siHUF+EMMO3S9r/vfYT+xzHDF4EhSu4fC1AZreRQ9WgiiP7Vuv92v/+g7t61WgzXx3e35yeynDEzRd0/fUm/+HhYGSK2H6i2ciADZLr1xTMEBIHRqgi+4vkYC1mjsJmJiLMjEQGFpiGUj2wf5szAJgKIcbAmqshLlJA8sOXqkhVq3XwB9fAApEPDWaGUxduqUWJ+6Es2hYRlovm/GLry1tg2FukIddchYhUBMgAgnjrqZmp+hdXBSEjTxuY17DVm55AxQKTazQTsVTxgydFzkVA1SU0owZGoIq3wpKZgmP6rD5VI8BdNRJPvrwQgpbi2ajE/ExmxremTs4wpeWz3Ey/+uXh3u8/v7m38DKmWQ05FOnWJ4d12NvnsHcFhQ4BYAfrz27STVjWYz1oL4f6deKjlE6vl6zOMnlYRAr/6x/5nZtuc95J6TeqWBSGan6keFFfQ+AMrwcjtE2aCV8ASNOgkdXmfyUm/+6byAuArseL9SbHcKttF4tmBmWfyn1gv3IpKMUhvpRnuGcd+n3S383Cb1J88fbROtvJ4/PtZuAYpFSOAaZz0lHehirQ7wc8XzRQOvd9XfsrriH7TvavXpHrl86/7AU0ALA4OLz94q07t297ayLHZGLD0H/t7XdTiqvF6mTR3DiST9yBs8djceu9R/3Qnw01QB0PpIOjF/7ZL/3mL//Ge47stdQv/tYHX3x/DQCbQV++ufqXb94HgFdu7X3rS/uPTy+amBglhMbX/9UT8gjLUGNgETUAAuWQcpEqGgnQRJCY2JMUDcGViL55QgA1o1kmr0YTVwuTzGDWG+AUhG0A674GJg4slZiBEQUM6VLuEQiHnNsYmFQtGIya9/1lk3NVVVFhIpqGzRiimrQh5MozsqvWrgQX8ntk2GRoKqSwrVKrHKxaEY1gyyacruGL9zKv9t/8+gkA/OEfeNmRfdMPDZBHAjzuN6/FpbMxV6TlhF3J3sXhCLMBcXnM15v8p+DllxcHndYGmWhHz+4qaldn7GSd7P5hgBHZAeDNfPEdzcGokHnqVHh/c3qq2ZH9C83mB4Z9Pw9WBn/VTqZ0MINR4w005R4HJlEbPWmTSp3wcjDBnaOoiqoYcagigcl/vd6H58Yltcs20zZwEWOEanL7aP/2XvzC1x8t2oRmooYUikgItEihqg25AF7+VYzYpFClerM2A3rHUyQoDtngRLf3a4Ozi37/MatiPNpl1RBtv41dUTFgwqoapkFN/MAx8+5wBauiHmgPYJ6os+MAgflZhITqRdqqSIRMWqoBROYu53egHLXJd6rzYA4A9/pyD8rThlV3Mx1F/Nq7j25O9Uyzv/ri4rw1vrNPt/b4mWb9OSQcjgcAuHWTzgAOjlvH971RVZB82zdLty9K9hEeAML3f9+n12en9x715+vNZjuIynxr2BVmXvvOrs/CxLvClet+JSaOqY2827Cxy7c8Dd+llGci+wz9juzjZScXB/eDveWto3x6+6ClM8vlBEBK3Vk5a1fgPvTu5XX9PwCcDMIxHJDsLCVgxyPw3NaRGw0uIu3vtd7KfTgh+xQ8SU1z45W7LyQ7vxjM06f7rnSb7QLggwcXH9w7nppz81BERRdtfPet9//eL/7Gj//gd+y19P6TzS9+5cFX3z/hwE0MkeDthxeDKAP82jdO3rjVfPoTh8tFI6JVta+FiMAwBlZRYnSNVxFlZFBT1RCQgJgoizp2IwIjcIxgUFQNTRHNTEzJYMgVCJ2Rn5tOPVNbdUw1YKIU2F/Ar72w9/B0e1wGM65e4oHk/tjA5K0OzdRrjEhmNcQgZkCIhlWsiUFNQIEIGUGA3bC6HcrEvUDbhNmiYqbe8SSGRXKt4DO7v1ClUCQ87sqbXz/5H//FxmMGHNmdZ/dN6fuy/f23XweArmRnyefZ+XG/OZVhg3A3tFrKCsMXYXMF2aeCDn0qimDyHE3p7btDfRVnhN7fnB5QePXwxhg8aTYXogLA+/3FqeYjSl+CzT+19R8s+yuDEyg3DH8R1j9tZdnGsb/cq0IRI/u4S4nJzHIVA51tvQjEPLqFo7/u1JD8U5HRFIwBz7aDq2bNxpFWVWOMUmsKbGBsxoFr1tt702XRYw38jqa6t1g4lG/72kTaDrXqyFwtUoghdrnEwAjoSwURYUL32blSS6f2JSSsVQErEoOp12wBmoqFBXMVI3Irqpk3h5gAAqKpghozq7vb/L8ielyS33V2HixlZpgEvm5kZSQMwWcaI3qvucLMHEA8h+J/vmflHAoDPh0V+caQfv7e+7DTveeyUSvrl0L3Ich+Z+8FAHiwfrQ70T/xEbBtnZrfiwiFn5rfx/E0fPW37j8N6w7iu5DN9GxY9w/YRfZaqxg2kWd2aXRRXz0YZkzfndBLKU/35z1vhPdM5N0u2lq1lnq0avaGeGGyiJdDtwP6nA8zhAB5V0ZZnxNOVp+ZOQMABySO7EcLchJ/pptCoCEDc3jl7gsvv7q/bO5e/kU1h8V+pOWt2yUPh/PWwS8iN4/2/+bf+oVvf/XGy7cWj8/6X/zKg7cenDt8i+hQNBCtmuhz2ftn9YOzJ15tM9TiHxNdCjmp3Q2ginLkwVuJzVxqoibLJjFhLpWJQuBaB0EUBSKqRfzBGUqtImBWDQJok+L5djCzKuKBTFLr3qL1ITEQvXXvrNSSUjKDmU71aBTE6O2pzJSr+CwnKm2MUoWIqtTI7CqdvhT33SQmqSAAkWVaDwRVZWIY7xVj5V4TiGMLzRhLwEyCgTkzc9fJX/25R3/uR1565XsPRyfqVOXRcPy57YPf/UmCDjb9sIvso0JGhocoSwpaq8tjvt7kH5cXXr15o3almZQpzrn7unhEedtp1dilZRC9Y6LhuLF6Tvpde7cvI4U9OsYAEDdajoftEaU3dfuP7eKHcS8pelPrY9S/yB2irxnUjJzVSBzUwA/RLOoLUgNymawaMJNJdTtxCLFWGQwa1UnLqGJQxm0qDqUiRpewjK9EphDDUGTZBCmCSL/x3omZLZtoU0ajmoUQPaylqolaMsy1GhCTiUipREyBx52/mZqREbEP+IKikgINtQIQANkosvIFAYGp94TEEM43PSIGYrkcwqmKuB/V27QB0PkoIvK7XhWvjFQlorl/1Uxq5RCmFlZUMI8F9u7GQPROlpmZcRHkU4hk14b3c613oLn4+ma97RdtdCDdDrkcH+/X9SGFD0H27nBvcXa93TPcpIPj9hlL11liF9Nlzd5Xv/FBVkuEzqVcA/HnYfousj+V+jJupnZvALtMzvOYlufh+zyqO2461g+5uHx7/g6HXI7X3Qr6l15c3nhBf+N9fOt+t4g0cyyHCwIA5fbWwdIWRwDweL3uzs/mpeiHSIt2f2hMEQBaV6pJf74GbBdS7Pzs9GS1uHF45L+ZEMKtfby1v4C4D1MtCRFzEwEgLt5Y7Z1t1sfaF4D2ZC039vh/+NzXTk9P/53v+x0Xm+7X3nrw/vG2iUFkLIyf+yjMTMxcyibOJ1Iacm1SqDrmgfrAVUQdeW2nhXnIpUnJk6HEIDHVKmKcSyXkKhVA1TBMoVGeqScGMzciIiEEMCO0NM4B6L0ZzDFXM5UUg5lV0aHI3mIBYGKwGLM1bJF4OxQmJiIzQEJRCARgUEp1ysh0lOQHoj7nCEDIgSwXjQ3LWDqBLrE/WkJWHQpNAVJ+AEEb8LSrn10uP/O5G/A52AeqXfElKgB8pTsGb+QAgCrAV16avclDlEz2ogKY+RL1D5Ybn719x1mdEb6nJK9rlI7apJO5DB0bB3M/Rb6xPv7k3s2nddmgOqCebtdHlN6D/MvNxQ8Pe4sJNlYG/xmc7KSDzaEoRIQ51/2DZalaVQPT+FsA93NWxFSqMmmKIRJ0Vck0hZRz9Swgl5f4arGIUhU/y2MIKpKaqKKO9hTY8278qAAaSzNU9WCVwIARt7k0MVZRc1g2N1tIDNH1tQZGnt6u4xaaaKxs9H0pI6AZE/rSB80a5lJLYKqq3uZhUgMHwzEc2EkVYN5hXbCaMqKpZRNCJEQKodQ6m558qUBqRFRrHad6RCIqtZoZM3elvE/1ro5XQ8+G9Ed+FM88SzbjCcDvPjj9zBt3RUVUzs4uuDvFXM5jheN2F7h9PHfR9gpAz9azmPt5b3sRAa6Q7zO+B2LyWotlk3zw3J2F/03eGG3E+cjQXxfAPM3G7BIy87S+A/SlVq1Vax0AYDvk9XbQJi7aEd8fnlyYDG+8GL7l1TvhnXvHH2yfPEv6whEh4d6+P0J70p1e7PxSnqUhpWsob9kT0GARadRBBrwAqMcn3tX3wq2bTLxKktoGAPqc2ylVnJt44/beyeN1XLR7XoEEx9qXW7fbb7zX/eW/9ys//NnXVtD/+qPui+9ud5WIQy4+Yo/bHsRSJTCFwACw3fQpBjNAN19MJECtQoSI6GM7IQ61NIkXkaaiMvWwrW2ukamNAQA6MRVT0CkdTOevNueReVZMCsmN3X7wMMdq0vVlb7HweqYqNbBH+lkTCAE8T2o7lECIyGZAhEOurozucxGFNo7iGVUxZFY1QDEkBKKgdSijmgtdKsNMkQzAOt+p1mIqzGkR9dz4u5f4Z+yTcxZjA+TwelK6+7X/oy++4XvUp8f2437zAIc3YOXI7lm+P3j75U0/NDAyQw7fBDbP7Jfz+46ocSZbupL9b/9Kd0wh7Ie0GynsMOw7XgB4D/Ivyen36Oq20QZHZP+59uKn+9JSmDMGzAwNfJWRUhBRf/yZsNaRZ5i3tUSUQgiB+6Jm+olbKwC4n8Xda6OIU5Unx5OZxeB/F6jYFALzFFlahRirYhOREavZIAqIKaA4pk9e0KqW1GIgL0p1T6w4f+UTCKHTRJHRi/SYaKi1KjSBxEwNRL3njwNRrTUwjMyMCiGIjXUCHn9ENPa7+1Hk+wOPtRldewDMHGBs43M7LnNQMOaAWJyQLGoCH9GS9sySprtAX3189pk37g5F+iLri5PVeg0prYsBXA7gPpKf3aRbZxf17BRgNEzizcamiMlDgLObVI/1oG3n4f15+B6eTlsEiPOi8plA/yH0+rURfh6riYWJHa+fXp9eG9U/hKjx76dK7ov4FpeKLBs+Xnf9kN9Y5W959RUAOOYeAG4dLp525VrfPSl2erbdn4Lz54PuGqw/3aT6tPbmcAEHe8vItg8jvj9KiTk0qYGwBIAuk9SLdQccEsamqeD8zwjxmyXA8d7h0a9/7fF/9Jd+6pU7t779tVtPhvzl9y5coOJQXkWNaCoNG3twbh00vmUVUVEr43UbkEAMGBCRiIHBs3/RwIqKiDYhdrnGwGi2t2gctSPTqk39MNQiACpmqJRiJCJGArMimlFEx/okU1FPB1ZDmvrbELquzJndQ1UASJEAIIzJIuO+MTB505OoqVqusr9sU2DJlWlUx5cqorpI0VQRTLWKAROLIQO440lxpGvO8hiBvR16AGhTS1izhlXM/+W/9Un43OXqEJjmTel3NAfXtecyzvXbPLyN5QalPQVA/EUbs3xrP/HsuztSgGfIHacQgrnplAgbiH5ynGv9/tWLo4ZyJ4GzK9k9Taeaf8lOX8I4IzsAPEb9K7Vn12tPtYXgVeZVUgqRyPuzzEx0zEEPSAYaOHplhzMhi8RmIRfti7rc3U/ukWAB9LHADxxRjTGYjWn7Y90ojNHtuboqEcswpEXjblURC2NOAATCXFVUFSERI2GpkiLPKixG4zEkbmTVFzF4tJjUucFRKoKZuUDed8ReC1hVPSaBOKhUM4OpmoMRBZyQN0Rv2VNEVHONExKz1OoVTmrGNg7vsx0sxigiLpZ/b4m/Q213p+rM+7xcBYCnDavfjst/df+e6LcCwHq9zYOsnnIq+V0RAOADOATA93sAOJuyB+bh/exZWvh1sadp99HEtMvG+Fi9K1X8cGS/tkp9mqZ36cjHPBJmTH8ezw4AQx5KtUQIMdRSlfB43Q3b7Rur4bU7txdn6wfrR2996WRdbAkMAG6j2AbZ3yZPdvR8NRNIS/aWE/9Pz/R9PbPaalcOb0OFJTu+Q8Dji+5JfHJ0eLhaNidrATidlY6pberqYhj2D2/fcXwHgKI3/+HPfO4/+Tu/nJrFD37mTj/k4015/3gLAC57iAQHy3C2KQ7rIuqhMXcOmgfng6cpLZqoIo7dIKCGPmswQYwREHOtolIV2hg8rdsj9/wr+xfMuTqRNm20xpXpkCszNTEMtTgh4zUdKVAbg3+T/iqttTBzYk9hhaEUJoqRxDQSq1kTuIpGpnWflzHsLWKXpZS8bKLbo0TU5ykwa2JQ9a4cIgqqlyYm5pHkJWQXUAJAX2rOddGwW5mAw+lm82c+/dJnPjeGQY5mVMCuZG9A9UaOMUZmZyU6Jg0gvCIBwL6IWwD4Ywevu8V0DGjEZ6jXZ7vjM+b3HfbmzXzx3cubTt2M3UxmgNjlwb+xU81fhM1LGD9lzYzsTsicV2ljmDRN4IyBmHHAFIKplqqIJFKYyfXdQ6kOhlW0ihXST7+8DwBv3T/v/CdiKv3gGGqjlFbBgGDKdlZDYkZLAUPgIdf5p/e83BjofNu3MaCZGDKD5wT4FO9xkn2pqMZuWAUAm/qvxVJgTyodcVzVZVoBQTxrzKCJMRB6FIKoAY46dK+XYYSqCszeADOeK6pCBGZVhM1i4nk3MF9M0MxHdUQynJJ2djaugUOtFYmI6Z0spzXcBXwegp1DWUBzjXa/Rcneqk/OtnvLxsrmBa53V82M7I7LR9Pl/qBtzwDgeJjDZM77/vhZ/tVdQH/mYBoc2ec5/Rqs777fMXru7d7BbngeTf8hh8SH7EuvQfzu8F4ll2q+JHAqfzuUOlzckO0bn4h3Un2wfvSFNy86q0u4vi14+aWDubn04v433n6ccVNGRdEquEFgd8yfEfw5dM3lrxWHxc0GvIrvpqzXGy6lLherPMjauqp9oBYAcim5Hw5vwfZ4CQA3Xnv9g2/8yp/5iZ+/9+Dx933bS74pHap95e3HtU6x1KLRn+5me4n7oiFwJCgKbz3q/NxxSqRtw0VXBrcFiBIjAo07bDMPDGA3p4yKaEWmx2cDInS5BqJqRoRtm4KEPmd36M2GTDW7PJ3RFGCRmqaJtUou1YvcSjVXYhCPTAuMFX2ewwdFFM3cFEOBuyybPgNgKdIEq1I9C6WIRaLAJIjboXh0KTHPKvHz7eZotRLvZAMAg+3Q5yptapxDaFnOBvnh1P6HD1+aCZnZF3osAwAcLfeuKFsQwczpmlPNj1FvGwHAF3F7z8qfWry6oODxk+OcfjW895J+sfFjrkjtdhD8y5snr8XlSMjMLD+ii3POSQ+U3oYMANeQ/Rdh/bNYl01UMQDS0YVA7lGYcw6QUEXcoABgGEM35Di6NMVM2rR4++GFZzf6UwvNmFnNHPvGVx9hE4Mn/6QUGM37qZsUt9vBc9uz1MghEm+HogpNCgAg4vQ6EGA3ZdogYoyx5Oy6w2omUnFckqOYCYCIJiIv5HDehokieyKeAWKK3EZ6fN7FEAG0rzpqfjzxi0mluk5GVANzHRGJDvaW224Y45PGp7AhkqqIKiGpCk63hzHgWhWI53SfWisjdqq7tPu14f15zMwBhZdL+OB4823LJsZwZ5/e2Fs+OdaJk0k70sYrGWFPT+iXxrqcdxHprHt6OwhhRvZdsceu0HCXD7mG4P7xHwfBdaqFnaF8lrc/b0Lf/U/+hyEXkUs1vf/vUHIp9dVDvbP3Qjm7+Nr727OTTVpeR/bvePngtc9+x+rwyMu73wPYW39ts9NC5aIiH/NP8zM8vs+E+LMOaNHs910JywgdAEQ2uzh9SIsXbm8AbgOAI/voBiil22wPbkcZyv/jz/4/f+qffeXTnzj84z/0mSenm3WfAeD0YvvWo86Z9FolV6lKMEAg8seOmTwEap7rReDFFfZGrcYYuFRRUvcxjWQoUZsSAlaDTddpCODB3IYAAoqqWpEIdLFou74ft2SI4+UUAQC6XEutxOwTIwGsu7X505jQ02kiE9PsR9Vbh3ubrlcxIPAhDsyciG9iNLWs4yufR46YvWWbiYsqlCoGTXQdZ3V4igGbJnZDkd0Gu5oj87IJAJComlqB2OD2z/3IVUIGAKo4sgPA4XIBV3N9YYp+fAgVpsRHl8fcapYAENpw2c10bQtqdk3veFK6G2k5fux0ElxIAYCXFwduEN39GveGi1PNR5C+oOtzKJ+yxjF9g7Ay2FHIANDOJxJKtZWHDrp5x0yctiAyVQaIITAhIyhxbGOeIqBFjWl0qOHuWeUu1hBi4M1QAjNxcKJ6O5STdbdqkoiIQSAuVVWllLJaLNy4gICIMOS6HbJr1dsUASkgQIzelJRiUFXxjlcAFSCAkMIY4zhmC5GqIWFDIahWkaHYNisAGBoABkIiyOL6KJ7sex5oDKVKIDcyISP6ncCXSKP+xyZODMbIHc8qUKsIO+pVxBBCHgZEyh9Fu/ta9WlN5F2grx6f8as3yLLHXt26SWGyJu3uVA8BziZ8fx6yA0A8WcHelZyVZ9AyHr/1tOr840D2/PHzpz/zPbNEslb1vegzt6nX9O/XLalVRWV3bB/hctgs6hoglLOLX3n/+P1752nJyymIZy/iutjqVvvaZ7/jhW/7Pc3BDRmKPnwb4P58Wl77rfkVadca8DyIv4AGYNBuuFg02ukLe5ffFW43F5suNezW8Ozn2TTC/8P//p/8xb/3+Rbl3/n+b2mbBACPz8dH8XNv3x+KNDEMpZoaMzHiPMX7//IECkW9BBDaBi7OulpDFe2GEiLxZU6sMWEVRcSh1BSjmzsCoYCYgpk2Ka67IQUeSi0CgMBEIiIAaObqOt99EY7lvFIFuOHIPHXlqOqmH0IIe23yvzoQBQ4uKw4I/VAQUdQQOTKZQRUloqHUZQyI1EYSVZfQ1CrAYDYGBTuyC0AEQCDXthOyAJRa2pC8IHvZwraHpoknZ+s/++m7VwiZiQ8FAC3Vx/YZ2T3KkZi2pZ5qfgDDp6x5j+uvyvDHy83v2r8FiJTYM9/n28x1meMkdnRb6dFy78oxgAhm7/Tnn1oejdm/O73YT/rNLHz8Tdt63OM8swPA37RRIVN0XJLDlL0cYxC1oZRlE4tqGxkEq4ibfwZRUW04OCj5tF6dmqsCTA7x5jbTOpLLk1BERBWIGG0sTvFpOhCiP1sEkYooEaWAVY0RAyMienVWzpm8NQSmW6aZEqo4F0+qZmAAZIAioyiTCcCQCIpAHGOlMcVQxCKHAqYKZlYVUCEQMZGpIBIxQtWZH0MCUyXmdTf4Q+O/sXmdJaYMOO5dEatURARkd63CFB0cOPTae8rBTLvvqiF3h/d7VkDhiK7g53fy6usn90t9/VDr85yoAHD3tVe6w71DgMXZ+oMc4Nffmuf33dF+Xazc2OxDGoPERnynZ3DuzxImlo8DuB//LauR0a4r9Zne1Gdivcsfax2GIu6DzRM9WktNzermJ+4evL736HgNcIxNyNvqOTtpyVAY5oTIcla6hZau22w537u1x7C3PP5g6wfAx/9Z5uF91lBqN8BeWwQ5tpDwqIWSOLYr59l3osnil7725L/+x7/01oPTH/rOV16/M/YY/quv3u+6/vu//dZX3n3y8LEEomFscZyyxcfOMHzqlyOCyEzvHOuLq5S3WYT2l00V9Vf+Ntc2sKiJmppyCA6YgLadaJPI7Fk0BgpA+8tm02cfcwJRycV3TYEpMvvaSlWJaX9vsXvYDFVSjE3ioaq3seYigSkRBabqHn3QQXTVpile2ETN/ZCmCoGHqoTAhJzCkCsA7GpxGWA7VObo0bPVDABWzfgbZqahwLLV877+ztvhkpDZQfbeBADOSV8NyRN64Wry4jYP71G5ow0A/GO5+F3YfP/qxRnZr/QrXS1amhGfEr9/drJMzX5I17Jingzbu2GxahvH9BnZPfHxiNI56a/J+jt5tZqGCh/bR4VMSApjmYbH5CIaM7cxIGGu0uW61yYAKDUHIgFgQquSQnBPAACCGjOp2lBq8OAgg75Uv5Ahs+8hTbXIaGhIMTolZgYeCCFqgbGJoWoFxGEoB3tLmwX+gNuhVDX/e3PObdN4tgGO1WzAaHVUXiEB5qopUi4WGZnQxiQDKaKJoy9va/VmV/Ros8ChigylsEeDTWXYbkD1J3Pk0NVScx0fLERGLLXSZCujq0lt7tTzrhL/HjylGolCDFqrGFwwnm7tQ2j3p9eq51qPIC6+bMe/Y/PC8z/l1uHhjZs39l68DQDwEryy7Tjfc53MnDYz8fKw1+O62MzUA8B+zNd4hfC0WfRpnuSZo/3zPuCZkJ2elZ20+2HXPmv+gv7Orhu2fT/na9dSXTgvJXNMr75095XX7q4PT3W1PHjyaH3WAcD6fAsASywAcIJ7+496gDdzeJRLefDe2/hWF27Sk7Vs5pTka6fRzszuvzKf2dfMfvApt7QwAFgxcsSjw+V+SnsHy2F5GwDs5HyVLn+cw1s3vvyb9//GP/rXX/r6B9/5icP/zR/4DgDYdCXE8Ovv3M81f/e3vLSp8MX3185Zm5m7pRBxRvaqWnIWgCbEtokiOq9Ymak3FyOSCx8dN71OM4URfAORaqkKhFhqCcyBaPwCIUQCNxmlENTq6E/G8XWiqkxQqhmAmC2axvXOXa7LNvrg07j2nsmndSI082JlONhblJNcRAIHv/P2pd7YXwDAxXYYRBcp5CpVpE3RFSAHq3YYigCgyZhJYALAyyZWqUPNRCGF4GloI/MitBWQYfuf/tAbTsjMVPtonUf+oL/45N5NSqyd7o7eHeh56U81C9iLFn4Gzu4C/Vh715Fdh+r2UVWb5eq7fMssd9mst1rqsm2uubs7rb3Jq4c3rgf/ip5u1xQCKPx0efwSxhuCu8juCpkY2KVJY3WGGYJGDiEwIQQenUoeF2NAbQqg3qfoH+9Ra1RUkchMX7q5PD7fFG+nvuwCvFTNDzmPOkK8ku5ChGa26TMiIlI3DDEyEx3uLTbbvlTNnurlwnNmnNK4imgbOCBmsaoQOHgrdyAEVAAipiJqZoGDIRig7SCvR8eIamJEpFILI8QQvaZmqKpiiJ5Td/mJ455p3P2qTEkMo3jGn6PTwpuQqlQgCshtpG7cEKCppZT6WgHgpKtTj+wkdb+aFPZM5t0TIi+OH79+pAAf3ZMB7f7m3r1dBeS1GR+O210Z5czd70JW2IXUObblefA9Uy4fPnHPuPw0OfMh7989ZnaRvVbd9v3Z9sqhtIvv7vykNu4fHDaL5Z1XYOi2F4PtN9gslinGeXz2n/5mu3rn1sENWwMA3tzXoV9cfYQ2BbHpObaraJuC490+IQAcAcDhEgC0Xfr7eRWW0mAT7+5ZDQeH3sKRCwBE66i9oX35if/6n//sv/ytV144+uM/8K2rRfT0nkHhzffOby7id752MxL8ym/d3ww60y+jX8kBJJCZ9TkTURvCtsv+Mr6UUOU6FGAMu8Ev/vwNhIEI2CJTrqKKKdBQhYmYfI+HYIpmwKGN1GXJtTJzCCFPu3ICFUA1NDMEwjGICqpqLmXRRNec+TsToZnJOKONyHt+sS2KuVoa61rRYcjDCVZNRMI8SArj2tRUq9+zwUpFQ2DCIUNkyqUici11tSBfpJVaYogAAUAfnJ7/X+/ecULGYwZ2CZltHiiEw+ViJGQmopyYtn2npT6E+rrFL+K2b+xPwcs30jK04TIB2LPan16l7rzncb+53a6akHZndkp8fHb+UrM/lvDtyB/HXDBofkFPfIl67UXx5xen68HayP77H83yqkxE5NGJZnUMWfPjUERAGQjzUJsYGUyQVRXBIhEiENL3vnHrZ78wVNXEFACGvs7LeUB3i6prrlx3LqIpkBuy+ipNCIZWS621Hu3tMYPW4kUxfVF0z5IZE408jykRBUIzSIzVHGvBTAE4cjCDAGBjbqjHsqvtoLsb+qqoGhuAAgYiIqiq66Ew0dQpIlXEEAg9Mp4AlBB0VI1O0O+RDQa+ViUanR9EZABVtZrt3pUJCWjcXT/z7dpa9WlN5EsYv/7efTh68UOQ8+T45AZAPQibbbc4W5998+6i3eE9PG+H+byZeheXPw6v8jxkf97XfBrr3Yx6/evEAAAck4N7t9muLy6tus1i2SwAAPb29/Zv31muDuOiBQAZiqqc37oRbz8cuq0OdgNg6C9/HU2b5n9t2gQAsn58SXWddQBwwUsA2Jet/yE14wldAzdt2m/wYjDmIFILLrQv/8e/+LNPHj7+Qz/w7TdXcdOVtx9cHHd678HjO0cLalbvPVm/92T9rS8dbPpxBjez7VCaNKoM/bmYS21C9JF8f9mImVuu2Sf6KmNV8bSKOlzFXPSiK/5yHb1Ow+Bff+QTkdWsqoIZEfVFYJuLVFcJhBBqrWAmChZYVUutzFxrJR/nEHKVRZPADAFCYDXjCR1qyYocmQJTqaKqZrK3WtQyWu0DUS4ylNrEOC0VJIUkYGxazYah+DZ19nbrZCIlHHOyAEGkFBHftXbVvnuZ/sTvPYTPXUH23TfvWrqCyDgSMi5/fIhyz8qPywsv7x34zD4HNO7WaDhka5bdzdtFzcvUuHBl/nhK/O7ZSYsc2jB/vAtvngzbOfHxnpXfiXu767oXjX8STr60zcs2AhCA56qjoCHiftsc7jXrruRJZcyqFLjkQkQUeMglMgVCU1NVVTOQkBICqMF///m3iYMBZoVZUkk4V6Co/4IZERBzkf1lc7EdmNDtC2JGCLlKSsnZ9rNtZiZVLaWM20sAj1lnBDEIk2tUVFXdYq2i2OWhaRpG/N5vu/uFtx6pkqm1bdz2l18nBT5Z903wFHgFUyeKuqEyUWKql0pWJhRfew5ZcOqGxFEASbMMchYXsZ98089eRQh32vcmMwcRaanA+A4UgHj3KY57F9/P4UpOpNZ6APHxuxW++yMcpyfHJzfghh4/2k2V+e29hV0Fy9PI7vz7Lhw7Ou9O8U9zNfPHXFFVRn7mefAhJ4RLMJsURUVFvYGoTkleibACEF05S31pWXUKxrwAamObUhkvm0zEHNLe/l6KcX9SsEz3vggAmxqidQBQcAEA2uDFMP4Ve/D4SVnBsAWAYXk7Ped3ut/gQ0b/3f7p/9fPnJ6e/dEf/q5a6oOTzc9/6cHZZiCiWwcNR3rr/sn90yEF/Or9DTPNaL5q06jGhVGpEpliuJoMgehX4yaGGdmdmalV/BIQA/u/IuKmzwZEyJPo2AhB1HywUlVV7bJf+0F2hBOIyADbUqqqHxWLlCLxUGogbNIYYsOECKhqVVVNRHG1CI4CXa7OtwREiAFUYdwIWhNDZOxzUU80nCRofs6JGprEELwCNDVMoMQpIbljXlWKQONGWQHoN/+3P/L6Z37phr9G55iB7bTFur13MO5Rd+rrVPS89ABwwpYUf83Wv5+P5r692V96fTt6rVnJTyy1VVqq2lA9gwwp8dm2O5X82Zt3dj+eEDqT+7U74uZU8zmUXard397G8rd5iEZeODdKzk3MqI2RAxcFEWeiARQEkBFyFd9quH5JpBiyqi2a2A1lltsTB1BzoW0v5moTt/aMChIAMIsh5FJxin321/QiBVUVsSpysGgGUaduGJEDtzH0pfIY7QJI5HFgHAIiiOiNg9XtvfiVd49TYA5kZirKgb/w1qM2EnPqcx1yDcxFxEOKqpprY/zJNuY7Eie2IpqaCGKiaiqBQxNjrnW0KalHnyK5OGD8bCI1NR2joscdxjShW1VTUgK4jHp3SWUF6Ozj7udEbQvj8L4mWCjRelj3AnsfQcucHJ+Usws7G74pKN+LeHpVrU3PDOqa354J30/rYa7h+HVYT3EmH3fVL0+zN/N/nYMeh1w+Mg6BiKiNDs0uRwnU+h+q9tqXbnOx3ZxtN2fri+P1xfH67NJY5Jju/8zIXrWv2kfrUE5mZB/6/KSs8rD9OL/owwXf3Av/xX/zzx48Oft3f9+3b4a67vMv/uajxxdbDry/iJtB33rYbwbdX0Tn2fuhDKUOpR4sw8EylEnqPpSaIrdXPd+M2JXi0TEeNTNfIZ3rEFGP/3Vk991UnA4PRGSiqqNnZNZdkO/TRsulc7Xgshkxi8wigkBNCp70O35XiALQ5TqtGM1XW6IWAuciapYCp8A6Vll7IYaaWWQqoq5taGJAohhiESXCgMgICuR12kwQkQ1ZVQmBA276bCo+NCDRJpcfXC5/7JdemKl2R3ZPiRmVJ/N+268vZmpwUjot1ftRf83GjIHZ3ORT9uwy/fDH3Wf2jV6WtgPAl7bHr7UHu8juX22bB60VAN6GfADxhqBx8H8AwDj8+cXpeRUm8pINPxN9QokMqtb1hQMjYBXlwEzgW2gmKnUi2QX2l82iiUOpIbCDOOJo3cy1ihTHTLqq8fR9ey4lEEam7VD8duWZoAC07vq2adDGkABQEzVxIaZnYPgzDcxcPkugYlVUaznd9EiMhKKKY+kK9FUu+iqiYlbNmCAQ9oNHqioTqqqBIaCZMqGhITEiqhgiBiJRE9VASERXI0QQEWw+zycoH3Wlo5NDZzyZ9f6084iHEPwC994SL4UxTw3vV1Z3O6PnksLLGs63A/wbv31MuubZG9RrAvMZ8ad0F/1w4uXjczXzV3v6K8+wPsdVOhXz4RlkPrP7/84QDwBWhmt/eLajyrp56q/ay3D9J51JmHHBHTe34uZwwYcL9gPAD4OvvHP6E3//8w8vyo9937f4VePnv/TgvUdnTYizYn0zaCTwf5gpBp7Lz3LRbigAkEsFs70m+Eju+1JEPO9yqba/aJipbWITg7/2nO6Yw9b94/2FOs79aIDEhClGv6mLP6cdykX8Wtswm01DvUie+A1ETCmMVsadPFhGTIHNYIIhZCYmHHI1sxTHDh0kLOL8JoFBZOpy7XNpIq/a5NeCLKoGMTAgIFJAXDbxhRsLqcZMaUob91GVQ4JRsqzB6p/7kZcu/vc6j+0A0HCcx/alsyVZiMfXMxFutGzz4GP7iWbPGAAAHeqMdUR4hZD5UIgfQAJRExKYUeIvHj84oOCa+t23zmSbhyNKfqi8Dsk4oFQAQKkrDD8lx1/a5jYGG3UdhmiqGkOIzIZsgFU1iyFhYPIOvDpfxQx40n6frTs/2qeIIfDkHzNLIYihN27M07pN2mVT3WsTMZuN1p4QQqm1ilapZrZIgQjYHZ5EYLbti6jnE4zURuCAAIs2qepmyEOpx+vh0VmfApraC4etW1DdS6UKQ6lofpxTZA7MuVRPZRFD5/0QSdTjNQHJE9ygihwsmxSpTqZlQAwEO8wMqI3BZ9PyYmeTvPPnXQnUGLChHgd/eantW3P65UPcqqK23dE+3gV699FHT4fl7MIDVP6npGXmneozN6uexfiREvhn0izLJonKtu/H7mbiud7aP/4arM9RB0zMxCplLgOZdZBZTUr2E7rh2ANc9IHoIKQsg4bFSLN4y91v740bgkGexvc8bPOwfWnPajh4dHrx1Q/efvtht+ltyOMj1w/wXZ988Vtf2j/dlNUivvmNsw+O1z7nzir13VyDfiiu/UKAR6edgC0XqarCmHEIbgQFAAErpaphdF2EmYvbZk+KK779PbWKk++1EgcW0b6IWfGpiscR7KrZUrVpYhZzEtZhYs4LY+Y5BE1UNoMFQm9iAgADE7WhSiBIsXUuRQ0CEgc+2FucnG9EpPiydSq4aJsAaiJqpkSUq6RIu56gIZcP+n7RsAtjnCJAMAJWFUJmptPN5j88uvnK9x7u/2Waw3udlkkhQoUlhQYmXfllQpadbtcA8L5sBQ0A/sjeq34AzE1MT7MxH2HWQ1hM+emPzs/v1/5Hj1555th+TgoAJ2C3IG2kopfZSV0Bvw35b4chAosIxwgABgQqe8vFGKPvRK4ok7lctFQ1MFVtUlI1JsxVBkVmAkD2cRVADY4Olttu6LvaxqAGCqhjEYpewhyimO0vFoFp3Q1NimDGhH0RBEgxnG/7/dXKaRYEBEAD22QxM2YScM8neiRSFQGIQ5Em8ZDFr56BqKrcOWg+eLJxiS0HL+sAANoOvT/TmshiGigMOXsssGfaiKq/9tlcBImAuO4G4lA9kgyAADgwiNVxXWFiysjj9RJRpxTMHS7KCwF12nCYmrHt5JNPJrjT/qMFkdfSCF7C+PXnd1vL5uJSvXX8TQ/4T+u5A3xo85FzM54B8JGxM88MMBh1O+tuvd4GGA6b+N66A4DUrPb3VreO9neR/Zk+2N1QmqxWr7ZnqKJfwHMpACHI6UV/4PCzqzH3mR1j83EPvYnVmTkZAHBOxof31Czvrbf/w6/9xgePNneOFm+88sKqCa6BKTm73Hid7av3nhxv4Kvvn3h+1jXevC/qWOzk+OXDPAcqRcxVZl9xikFEbx61RWEYOgOeT4tlE7dDYYQqWlSWKfka9vhcgRAI3bc3imcABAyMFEFLBTJVLUWIvW4YpioPJKY50ZvGUciNprZatKZWVFzGrqqMI83axugve2LUOqYTn6077+QbrxCARZUQEgd3rjYpDqUSorvAQS2rtDEMVUS0bVgERBUqFNUmplpzEVk2KAovRPoTv/dw/y/TaEZlmjmZoBauBjnNiS4XtQCAhw2cQ/mecOgjtic1zmkzc2LMR07uxLSAcQbsSvaWpdmsNNugOq3bPBwAvS/bG15EvSvWAnHLUhu5lKn+UCTF6MUsbYpIVFUPlk2polN8mIwHEphZQHQPRBjJPdlfpBB4GMpm24va3qKpooTQBOoLDKWkEFKMNv2AkRnMtkOJIXryl1vzmcYpJDE2MTSreH6x9c2Kz9RgpiJm1qaIhkXNde6jqqohV+L6D/v5rz0p6rqJzJg4MJpVqaWqQfVlUuQAANSmodQGxtUUERUxDwz2VSkjALJ58G8IuRQFkCpIEAiqAiJGDH7dxDF5TlU1Ba5qMEaneRQ8AeDIL6qMdatX2Z6ncwgAYAEET8lm5rc70Cy+PDz5Nr11kz4S3z/i2Og/erSn3cF85t/nIqRrjUjzuP08Q5Mj+zXe5uRi8+79ew+/8bWX9ewTt8KLlB+9f//9t7729jfevnd8vvvB/ukzmnv88exdelosXxSKgqpqXwAg2TkALNKamysNyLv4LjV/LL5IewB4Hi2TmmXO5Sd/9s0U0h//oc/82O959eYq7iU8WsWbq3i0v3T6qAn46ZduvXoUXr2ReNp2zmN7UaiqTYptpOWiiTTS5VcldugKsFyFAzvT4p/eRPKiASdq1t3gT/FcRVVLFfd/upTYDHIVAfPWJIGR+25SdOP1UOvECI3ikykjlWZ7gZoFRnQtII4xMimEruhQapOiGIjB3EM/FBmK+iLSKWOP9CuqgFBNRC0GdgxFJDPzHGOHUZmG3Cq1jVEtuHW21OI5JyFwP1SAsO7zf/DJO69876Gz7fMjvnsjbjiOBLoo4aXAHAAeQj2HcgeaeYl6RRszN+fZ9U6lq0OG7YbJdCW/lS/GlqUJ2TXLUPNFzY/X535dAIAVXjl4VsB/F85/Gkoi8gqQiVVjJqiuTWSPrXe9NoiaR6zkKimwY5KaNJERsahWs1IrItYqamMlgJkxoXllHSEjqqhchq94mr8CEhEcrqKf6I6qfS5tigZQq3iR3lDVY9L9BHRmgzgYGpgxzkfG+BK4sb/0Odkm2nCsBzETQyRm5lyKGKITIwAB0V2pTqoUsXFgH6kSxTEKxjMfZdRFmjcQjlP5JRSomqrL8JEApyXBfIKrKRKOiwP/5iei8p3pHnYfruPDkgJfhalu52PuhvZj4vJHoNOx/nZomcvbx3MiX563O33ezD7kcnZ28fDRabroAPZvtqtzvL8Pw4Oej7fHe/uLm3uL+RPnbDLHd882UTFXtRMKAJlfi3ZkM+frzX5bq/Yzpjstk/vh2vA+4lc/fEx836VlzjqZh/cXjvb/i3/65idfuvFDn/3E47P+53713rtPuu/95MEnbh9+9d6TDx5tAOBwf7lcLve4HOwtfuC7Dz99fPbVD84erAUAFomdimmbqLUAgNbi43kk6IsOuXBgf043Tdz2uU4qSZ/3AaAqA4yEzBwI0xcJhE2ISAgGXkCjqrWq2khD92WMZY8I6MqZXAjAdQue+MhTdRkSgACizzgQOExWe/Q4gaqWS1m1Cc1UVUSbxGamambSxAZAvNdYis6DDyLVXICojBmHEAOdbvomhsQkZkRUagmBt0MfJrBGJFEVw0ikBk3gfoBtrm+g/ugb7dNjuwsVtlpvxAXR5EWaRIonpfOx/QEMAPCHXnwdAHyyVrtCoVxRy5g9je8jsk/OVRU9lmGsvd4hZLo8bLVu+wEA3tTtAxw+C6uN1V3L0hdx+7d5CG5ZUPN+arNxZvQDlafsxjztzDt/p3kNKVTRyBEAailTpSoOQ3GG2t9Tqno4lw+tzKwyLo6RSLUiYmDyNMtqXETbJqqYi2ecgs/VqtYuV5la8cYttQfBM7r3bVrS+K0UGOHVW4uvvFfUTFUDB0XhEGopYjj2BBIHtlIrhMBoziz51lQVmkhigoY2xkSC+cLU1GC8+5F6HYgBPl0C6iaQsQt72qQimBarkQLCZV6N1zPh/BRk8rF93qleq2RKiteZmZ0Gj7tA722GN2AJ//O/hZlv+Ti+pOdRMR/Oz3BMAHCu/BvvPH5woU/OtxcdWCmDcs7PnaOHIowQQhATdy31O6r8GdmHamcXF7dXkvFgv/VCmb5ZLKv2fjdarJYAcEnIfNTkPk/r3JAMut+MRbSHkM9g6UqYf/KF94e8/Z5PvvTmBxe//KV33nrc7y2aL76//vw3zk8utou2raofXFyAnjPTIp2nSEer9nB/+aTvapW+aFWNgZ12nyNixpculibFmTTvhwJmTWBGzKU2KTIWsVhyjmHM7MyiMQbvuxiDIGd1xyjysibE0TNP1AT0lHZRtam3frbtmVkuxYvQxmoOVQQgGp1TaAZIPidKFfKAGQNVa2KIRIjY5xpDTIyi5GV+5gZa89kKiDAFnqs1N30WEXbnLVGuQsiMgOz10wAIhFBEVAEIXM/QBjy9WP9Hn31tdi05z+7HmLdeLCnQFGfmXa+eJON71IdQ71n59/c/NSP7GOtINDeaXlIxM4I/Rc7M+b0eGfYbw/nd0K7aZizdRtystx7nCwAeM/A7cW8e9o3DSqpx+InmeD1YQtx1LaTIDrXTAzQy7n6naAID4VCViJhI1QJirtV79VIMudQYoscsmKkoglmKXFX7nJGCC+E9RmjUMs2WBbWKeHK+IQ5mYGDj/YDQDJghV5s2N+y1eX6VbFMqVQKRq1MmnEUiCswPzgfv3OAQApEpBEapWEUSsakEJlWMTD71q5rn+opqDFREa6kxREYEMlCPNMCp02DyLCPCRNqMWhnva2XG8TWCAFZkFLkTMbgYFIkJTA0RbMq+hlGsNNJuL2t42qfql8UPyYl8CeOvnj8bgk6rHn3zyS4fMbnvwHf5EJPqh0ghr+kXr/3r3rI5Orp9/+yd++d6/3z0BJ0rH91Y7u3f+LBWEMMAoKImA3LjmI7cmAzuXRqqJdvmIVwMi/3mvCrtkipDtwVYDlKW4ZIam6nYj5apDrp/cHhxfvb2o/r2u++8+2S7zhxRU2o+/+b7P/K7v+W9J5uf/9KDD443i0hDLveHEgMv2nZWrF+yqIOeb9dmFgK7n8j3TgBAIcZaXMK414SiEMOO7DEwIppRCLzts39itZBzMbryt1SBZZNMTaeSX3dyIyIgLVLw4DAiWoQxAM8Ai0gV19WwVCUeg+C9XG0ZWNxepOpWZkY0R7ep/jK4TkbNO5XG8j9VVeXIQ6lNCoFoyIV5VCFw4KFUNVi0sVbxTjg1SCGMmg1Vv/gXUxVoJs8qMBWByIBEhBCh9By+e4lzjIyP7YvUUOLNelsJE8Vm4j3mNSkAzGP7r9n6D8fbs5rlShrMBOhzLPszOlGnimB/0avBSd7er10H+l17tzXLjPgzsgPAF+rZSxhXY87wCAovYvjJSSHjsGNgItKkRDjbESxE9E2742aRykRi42M99iBOewLxYnQmMAO1w70GAM7WQ0qhiopIG6IA5CpVlQFMBF0r6TtVHdUoomPQijM6KTAYiFnO4iOAeM6vM9MIiLhoYi616hjl7wxJZEKAIvrkfEDCUmqTgowMCjQxmFmuqqKLFDqwKuop0D6fI45VY6qwalNXFNTNtJPcEkAA02SzdZqmiuIVqoT8SqSmhARwJbXJVJWAkAzATBnJD4DZ+M1EIPLM3ekM8Ux4jbDxIcOtTEf304eJOFb7H595/whw/3Bd47WxfRfWr8HxjNFPZwUvm3S0vzxJfLKpHIOUujUGsBvNkmMacnlmDbef2DPhbuIjkOcNYNFnw/HMzARqOwwNVO3Lbnq+62o+zlvGg//qZ778a199B3gsTjnd+OtzfefW4dffe/T2w/OHp4OqZYGWmAnDmEJcRZRRmmaEjFutAeB5Jp/T57j2ogC5uLhl1kEeJOuN8/QTMpMT9A4gm2FQgcijpHqROAQuogDGiOL6ZdUuV68dGIUQEogRzHsmza1KqlLViNldRWZjnZjfUg113gGY2VDKwaJlJvGXn4kHwDYxoBohDLXuvkhSjEORRRNFlBGrWkBzTYV3gixSiASDaK61TdHnQUe6oQoiNoFFcICMNFZzuAK6wdDn0gTm1Iic/8lv/QQ8hGtse+3rVuvSZxd2yIYZnX2fCQBfhM2rB/TZxZ3LsX2HaZkDIGnXNnrVw9LloeHJxoF4Mmy2efi6bn9XczRmjU3vnz/lTd3es/KDsAcAFAKU6mbUL+Lmr1GX5t2vOfsYAlEIvGxirbJVA0M0b6O6pJAjh1LreEMhLJIDcxUNs4wKoagWhVVDHsUOZssGLnoAJMLRhSRm7H1MnioDllLI1eNBraj2ucQYA1Op2gRS0TplwA25phiQ0FQJMRAW4lJrCoyAMVBVm+6RPkEDIgYPmKNxiwCAIMohiNkiJtnRm7u+pYrsQmOVmmJISLkqKs5q9ksN2NXHy9SYUUS0eDCGjfM4uDwfcU7XmV4705cZpfEphK6UOR+mbw2G64LIpDgP77vK9zXBLUhwenIG+4cfQzPzbyJyh2vxA3Mk70ealXZNRrvIvh1yX8Q5Ex+uHZVOL7ZDFo6hSbwttRsUALbHJ/f2Urc+AQCMq0jAMS2b6FXd3r8aALxRzyd3KbnoR5Mq3FDVfpGgKuQ+btuNX4s+XC2zqSFnVAzJzjMe/Pm/9QsPT7e/79te3N9rG4Jru9WS8+2j/TtP1u8+6U4utqoSwvgoSpW+FGYKQZnpINnh/vLsYjv/Ni53GwRFR/ge92kNnWd1QZh/sIhrumDZJq/DFtG51a0oDI6whOIvHgBRG8ao1THmtOpUIm+FmMkEmQZx96lhCFCrMWcd40Q8E8p74mFqrvE24VytiCFcqicJIYuqWhPJQ7qZ0FSYcCg5cihVqxoS1lqZUA3aGFT1eD0kpjaGPhdyE4oUQybCBRMzHewv7z8+G2PKAYYqbcDR7Wxw0eU/EBfz2N4ADyiNkYoOUpzlbDj6q3PuqgZER/Zf0JN7Vv704ruue02fVh00YWRXzC6VM4hdHmAq6PB/9Xq8W5ReXhy4D5YQPNuAYmiRv9qdPMDhO3kFAvvxMsn7IcpPLDZlay2PM5+BEXObYpy1sKJmUgUaHnM0xSBMKK8qzCM1rwLMwkRjDCSNN7mzddf1IQaqojHwatGcrNdNYg+69enY4yFdnLNcNo74UjQQbPra5by3WITAXu4Ymbxyq47jt+MJMlMVTQGHrH0uTQzVCwURc6lInAL6AT+TJwDmxD0H9m2o3//8Bi9qgRBM/QpnaLlqZCrAMOVw+Bfc9FmVIqMnc3h5S6nV46sRydQICQhEdapRBQqodU4kwLHxFdFXCDhlsvoLQe1S7X7a2z0oL+FH6619eD+g0Pb4ZC2Hz/epnj5/4P6m0mbCh3DrHzM6RlTuHXe11LPNUEvV7mw7SS9wuwGAbV97RSn1RoNQZQuwaKgbdLsZzt67n1aRI+4H5NgCwJPlfmt8sWyQmxBDIkyElRsPgLy8EFRzlsafHkOfAdLEj48j/Nx/lPoinOFjpbFBsvNmsfxL/99/+fbDi//VD3zyYt1/5e3HD84HP1VePFoeJn1w2p1nTBMk39hfFoWT84tF07ZNrGrLphlvLYvmPOOTR52PWf4ZMTEAdFkgcCRIkXLRLo/j/EVXAGB/EWdFjc/vsz4yBB5ykbGyXUeviM3T3iSu8HYLJm9UcgeHr0nVQMCcfJzHRCKPVq6XgD5xvi6rioxVbSgFx/4H6HMO5BdYW7bJP2Vq2zBCiIGWbbrYDmamUkNABqxSi+BYQ5y8rLm6XJNCnEX6IfD5xbmny3iQIYAQpvlCs95sf+g7prF9rNCDARWqPN1jOXPu3dRQ+vUm/5+bTz+DjZn/dZbDe0KvXSpn/GN8VTuP8E68vEflR/ZemqMiPWwSAG5y87jfPEYFgBuCKwwHSrNg5i/hwy9tc2TSHd/1IqU4DZIiqqptjHPOUjUjUzGNRGLQxECBRXX0pnIgM7d6oiIgMpGHiXqhnZn5U7pIHrWUY5YnjRc3s64vU9OpEZKoNnEsyD3YX56eb4uIGLiDiRFn9gOnPy/a1PU5sjpVbQaBqS/VdOynHo9MqRzGnx7NzJSZE3E3aKlqAFXc8oKeYueqRBk3CEFUwXSRosi4tHdqaL53+qLCo4O9PM/F7EVrJE/GHXn5MbYeRzWwjXwXTa8tJESbx43nq9p3mZn5/VutBxRewvj+vfPf/Zlbp1Xhf8638DwC/UP2qDORMmTYDvn9R+f5/El3fgY7Eec7N0toAaxq0yCmCAA3oNwAhRYwpdaERPYoQQik3aJpV+V8r2XIQPuH5yWuZX7J4UeO7Z4EmfEg2bkLZuZ+jFE+EdKH21NVts1i+f/7p2/+sy++/eO/9437Ty4+//XTi66PHMQs5/rB8TpFisQcuNGwashplhD4YLUqVbZ9DuSRJQaItUpMPPMql8NgiEHHFj3/qRajWhKQ0C2propxuma3eMjMBCwSx4m+l7HhaLpXlQrzsIHEpFVNzGhq54kBA3JGLbVyDDDJBZgIQsg5774wfHZL7AdSHRcGBB4nuxuUZwbV3LpCNFpAuc+1ippZDAEBs3d7MpsqE+VSz7usqk0MLnUX8ftyvdgOtVoTx95LQCAao5lRZT2U74jkY7uzH42Rr1JPdJjH9qfl6sfD1gmZH5cXPI2g9nUXsgeQxXQwqFpYhLk6db7sq8FQ87iqBfBS1mVqvtqdvBYXq7bxUJoBdZsHLXWZmq3W92V7jmPFEoVwWrNrH3/GTn8GSwrBwHTSVy9TE65ubnKVNoZFM4pTRdRcS8MkVcbMdSA1aVNEQpe1IFIMlEsNIYzRiIhgVqp6LPOqSV2WHlGqYGB1Kyc474zufF42sapK1f29VlX7oZxvekQUg1IrjhsRv09YYFpEclIoBFodrrbdMNLuakwYmPthWC15bLFGLKINgU06k8Dk+sUmhFxr28RSTdQCkZkKIk/qSTFgNEQsYl2uyyaKoeyESZqZe7arCBjQGASmahaYRUTByDP9L5kbAyBCVBUxI+YdPBvV7u81+NpkNXVm5vqMOP0s1xgbp91/6cnmmcj+4XD/kWP7tTz3Z4ezf8jA7tzLUGQoIiqPTy7uv//Ok4dPtBt2kf1a89Mi0iJSa9Ka3D0g/+dOK/t7LQCcKdnIqMNey7f2+FteW96w9V73+PzstO+2sxJppi+SXXfxzmmOrnbPeDAju7/OZwXFc2mZnJrF8p9/4f2/9nNf/kPf8woAfO6rT44vOkZad0OtJQRMkSKHWdJ356B5+eZykbhJcbloDveXyzYRkVQBQkKsokWhLxoJVg2lSC8eLQ+SaS3zz7KL+xTiXhMOkgHA2Wa7C+i1Dma2GYaulBSCv/JHEryIqHmfxlBqE8MiRb9Cllqrmr8SkMjUAmEKoS8e16o+eY3bKg/q8cin3dI40cBcqsfMXFay8SRS9lcTEZpCYDK1RQztVNxZS21iIMRqsmqaNvhabB4gKgCMSb9mxURUS7Vax9yYpokphaHkSIQmIJmQ+67/k99yd7rG5Tkj7LmPrxkRPuk3HiNzg9Kuqn2XTHdkH0WQs77vkj0AzwWbOR9V8+q++7XbIIwBYYgDjnw0xbCk4FzQHWhmbbuLIB+i/I394hcdnITibdO0KTKA+EKTcOQMaM7zcTaPAiGjO91GEU2YKkBdGM5gRUzUxt5yBFMDszqJQMZuPB9IPVPIAMn1rqMcfuQueHTAFdEyVqLX+clD46Ot3h+AiD4KjOa7SW44FMmlxBi7PsvU2KWquSqxa+XRcUnMxm1tlTiHUzEVUVGTKcxSqjCaVwlW1S5nAHBTxaTLMEabGnhxFJIBAaCiD+cIaIweL/OUIdls5/02m8YvEbl/dpSYs+0HEA8gZrI5QewWpeOvlCcfpVU/+yZJmNOnlIfPXqhei/SadY2O7HMLwVDkeFNOT7YHJFfc9ABnHRwuANvFvpedrxb7KV3kLJuxaBQAiiAA2JDWjGtgGACGfn+L6755spZ1L+fb4Wwt8fbtF5srPLXpsMHlhwzvDvFdPgAA10cCQFjsWxm0L7kUT3xchSumoTu30k//86//3//2r/zB77l7a7/58tv3HxxfNE08Pu9Klf3VskngM6kP5rXKm/fWd/aoKEIuTYoBJTR0eBiePNGulOjRSKLMNHM4/XbT21hW54Wo7c6vzmXv5xkBYLVoL1+BooETALQhziIZ/6+mtpsKub9oDveX55vOq43d3GgAbEamiigG267L1QIzBjSzapcUZ2BOKblcak4j8+gYv867LrPuBGmJWgohEA6i/sFuhAcEBWCmlAKPEpuJDDQFBDFQ0SaGGHgo0oxlxygGCNCmiAiesZNiiMzMpFUCwzqXzyyij+1etLSL6buEzOg8coZkImRO2MYAmSyX9AvArh5mrGdCGBUv0/ud0J9f/CrquWMA8I52/4u9O/PX2faDB5a1yK6QcyX7NGSNe/2/isdvX+Q2BmI2VVOLkZde1ULE6ipFP1VhyNVvcp6SyMyuZ3WtqrcIUaChZMQQCCOMckabaoZGh5HiIrJIVrVcKiARIqoxo5rhpAzB8d6Gm6H2OTcpuQgdAI5WbanS7XB6TGSqKTAiVDWt4jYrF0QBut9olO40gYR5KIUxEcEixSKSArmmlrx0FxDAp4oKgIGxGvCUyu4OmLF/UWdtj3o7IARmRpliAwYZwzDVXL2OIAJAjORqoipeTEuI4O+06ZkjtcaY1MB3tWhGRO/k8jpdqiHv2TNo9wXQ+bOY9xchvGzh15+c/YGbNz4Sss9gjAg++yazB+CZNXtPw/28OHU2xpG9iTwUKTlfZBO0c8UDukZE0T4bBDxYNge3j/YOF3tn3fnOyAZDn7dyUTIU8KbXrug9AIDLZPZz5U8dlGuuVIAGwJJtK6RtTe4wOlzw0GcPYd8d4auSB//yTmSYh/rmAnOVx1vvnT85efif//QXDlZh09vn37zfG3/y7lGpw9BSqRYDNhGHon2pYtBG9sno3dPiAlsRPVgGAKg9H654UfjxeedW1Xa6JOUyFoWnSeI+k6rrrhhAYFok3iVkhlI9TdtTHhunTasAoakJXmnt8PyZ84utZ+OJgcc3jgE1ah4/op4HiWjTWGpmTBTjqEvxVxReNWRWETVDwhi4yxVBY4iOLOSN3qXO3LRzuFX1bNM1kcfYKcJcqhhMYxQQBz+9AhMYiKh7mrIAEqpIZFCVnCGGMXXWIK2353/ys6/Bw+tFS89eh+II8e4LfRvyj+594or05enyjav/+nS8TCUMRAPIcd466/LV7uSI4+Fy4RzORc0zsgOAHyod6IuY5pl9Bfz329N/0OcUAhC5MoSYlm0rADAFLBfVSCxWmcDX6Ug0NqJOuvvpIgeImKUq8DJSLmKm89OjyKh/R9Qmhtdf3P/Ndx8v2yRVBjNm9sl9DJ9ENLOhKhN52V7JNSxCqWqmHHi5aN65/8RDu2qtKbXTkM6MeLLpVm1KgVfLVmspVX2XngIX0SZ5zQaY0pgjjeStYfMDEhCHooGIESCEKuJP6UE8DkMD01AkMMEOL1gVA3NV9Tgzr16CS9PAKLkfOXdn2Al8fWqjaHXUvPsNQi/bqdQA/DQNzFCKW5mu4XsmmwmZJYUD1VElqXFmSdYEd4W++qT/A5/+aBtquElnO+8JN+lj2lOfDe7P1MbM0YyO6T62A8Bem9plgq6TUk+ufvrJIDwMdxrb39Oj7T2OrZT+otrepBK9KPmsg67oyXDltcQx+DlxrtwkrikCANFoE4sE62wusIH60aJ1GVRg25/G5lbkq5z73v7egyf5n/zTf/2LX3nQbzeH+8vv/ZY7t/YbAIiv3y4591nbRADQ5/FX8d6T9SDYbzdPttnpSHN7DsC6G5jJ5/fx6y+as82WFIvg+bb6qP7iqvXh/WjVnm56J9wfX2wj8a7Fd96g+p20HwpOWe0TjktiCpNtVUSzKKAFZHHwNogIg45GRzArKmhAiBTC7l4E52fw5GNiZpfK4FRU5EocQmxDSIG3QxmqxNiIagzsMVUAsGpTruLxTkjUd32KcdlEVfVZnoj6YTAOSEwMjJiLiI0Mj6iKAZoE9qSq0YODOEZKxRCP19vX95sffaOFh1dC23fVrrvv8e3ok2F7qvkh1FuUnGofezOejueeEJPw+bKH0ADA8bD1mX2bh8eoP7p3W4fqlR2+RG2RnY3xRestSKAwW1Lf4/pXas+IIaCoARCAtjGGKXK2zyUyIBIQehYmEeVpoSqGAKOnwaPbzHkYDIZqBjx2omKfe0QG074IEQYmVXt4umWOo469VNpRIU/HLcMUMtoPg/nQjYjIqnD/8VkViUSEaIhO+Ls0RcwOVq2fNNtu8GcsIWyHDJDWXU6R95eNL1fdktoPFZiYfXk76bxGRgUZLTWhH0o1BERD9LDrMYcdCBD9kBBVMAtT5dP4s3hAJWGuJVKYUqlx5N7G5wDuHt9qUKdd60jiIOmUn0pIWzNRe22SOd4HvfssipsJTzTv3im3Wrdavx2Xv/JutxsyM0/oHydv4FqAwfMqoMMzYwN2eRgf2Lu+5KmTc/ftaBVfvH14cr9cZFvi9RWylNoRwrq/WENX1otIhwvYlXE+jezzwC6lcoTlzRvL9mBuXHKIT7bd1tSEy2/7VtxUOLjGzMxy9WTnTy4M4OTw1o0Z1k/W8rf+u3/13/7LdwHgO15evvTK3aP9ZRNwqHb/yfq37j0+u9g+2eZP3Tk6u9g+3NgMuN/zqRduvrh6fHpxlunh6fbx2flgxMSexj5SjCgA0EaC1XLd98BjyXWtcrrpc8H5V+5SmUjsKQJEbBbmfWZV5cCMWKfKPTGTKkUU0ERBCxCCmBWpkQNN4R5oxggcuBEQsqpjsBdMOS+7et759WzT/xFRk5JHafuL1lwwYeC13aqeQyKAwMRVxnWu2JQiQuRBKJ5MgEiihSkOuTtYrg5X8cn54B+PxJHGQr5SCwKEEOffQC4VDAy0iMVAItoP+T/4ttc+87kbMyHzkfju+boAkMn+kGe1e8yA6IC6wKd0NddWDmo0xovAUHMKsQG+N1w4si9T8y/6J/OZsemH0+16mZoUYq7Fc4Y/6C8EDK3Ocnfj8NflwTnIsm3U7PKUGbfgZKpESERkoFJTTKbj1GljXKhjfR3F7IagWk2amETMFSxVFRQNKDIzQUFUAybKUs82yoHNIAaqFqqMYvPLpf1klfJLWwwBEcEUkKpIX8qoDtTR4cyIc9tqE8NQalXNRTxNZKiCAH2pIVAu5Xxj+4uG3Ndr1qSgCiK6bNO2zwieskelypz3ogYEqgbtNF+ObXmmpWoMAUzn+JfLkNN5r2jGgEXrIiYxE5FRGGNAiDqpaGy+PdhkTZu2rK4XYsSn73aXUQQa/ZzIZKD1iKKAnUPxEIIZ329RovXpBxfdrZurpxmYEZpvUj3WXVgPN7/J2rtrWvXnJQHMQbvXGu9evH1UFLbHJw8vcrdz+i3m6K5BTgbxeRyK7K5wZ2Tf2pUzY+nTkPELh8s7t2/fOlpdS4LMuASom65k2SZeAkANBzPTs8vMODmT8QAATjaY2q0j+z//V9/4z/7hFwHg933bC3dv7Xma4+nF9oOzenLRPTzdroeaazWFz3/tCTEQkXcPMeIX3no0p3elSN/5+t3TTf/otEOMIjpAFdE2jiR7itTG5WlXwmQS2Qy6aggATjeXx+9y0YgoQGSmYehCmARViCFwJOgLOtYHIgFpm7jtcicSSCOTqkQONBnTxw5MHBOXEmMiUqZtLqKKOwLHkY/drYtEj0hylpecJvdwMQYPiB8RfNW2puABjkiYAm+HQYRnhCy1tCn6uTG5kApTCIEfnXZVDQlqNSZEYq9CNeRlE3MRBJPxGyMPnyJkgHqyHv59WF5aUq/xhzshcZd/RnSFzNuQf3h5d1bXOHvuXrBdw8suwz4+qUD8AHD54zI0J3mc2QHgq93Jb8L2T99+w28D2zw4oOdaACCFeF7696gslFbAALABWWH4+/Hkp6Us27jTDgcEDGZFJCCKh0EaMEARyNKvFq2IzpJMUQOTQMhEUo0JOfC2124oTCiKDOPDs0gB1MA8HgtENXHwBYqqZoUUqCqOsULMNjVzRaahVlWtqomZCFTJg+h8g+5SwTAWgOB8GfTOkMCU3bEhvsML/lxCgDBlFLqciQlDgGF2GyCAQSDU6YGYmgPMB3sXsPgzuYi61UvMmMYZZdOXtolIRDo5uTyoXWSWqFepgcPI2oEBooIB0Nza4X9QVRizcZTGRbPJR4U/z7ufXU3k7jboezW9u1l/FlZnH29a/2a3qePkvutL+hCUr6Veb9sm7EQ3XXE078WsTs1wk+fHEX/R0LLU8xjOB5By6VOdPkyvnQocg0P8DOs+s6tiHja1PlfR6Mh+bXh3fFfV9cX6hbsv/vWf+uW/8bP/+sd+96dev7M/VDu92H75vQunSu6fbhcxXnFaerYegtdS7y8bs7HstC96thl8uZSLeueZ21NLxVajg3iKdATxoisz05yLuh7GyZmHp9s4WZpFtGkWzqovEndZRFRk1OoGoqrKRE0MMvEz4hsoH2NwlIhVA4ZxKZSrjiWWhGFsvVGch0SfE8dAgkkTYFZFiFAViBARa9XA6PIVMGhTDEzeNm9mCDiU2qZURZEAgasBIKfAvgpUkxv7y3VXxKzri4AhMaOFOMrPI2NV9safQKQGZVRBkKiBAbM+PO+/I9H/6ZUD6MY96u6QPqqhUOemDmcDLqRoqW/q9haluRqbCLtaLg+AZ+1U5/80KyN9bN/mYa52eg/yT8H5n4pj6/FFzTAVPznbHtSOh+0J5E9ZswFxqv1tyH+l9iGGKUcZzWy5WDBan7MIBIdjAPYYL5AYEhh4Ms7cE1TVInOuXruBYuasKQcWGSlkJrxxsHpyckYUmJBAt0NZNcnTFkENiXwVw8wll3FJayaqqzYVsa4UNEspiVggGgBVxRQ4XEZDu7fYnfnLNjQpnp5vC6jf+yNTG1kUmGibswE0jFNa+hi4mAVylfNNH5hykRgYEauob2gQMYRQS0nBnXQVYwwhgGkgREQx88uxXz4j0/RLwioSJjkjEanIqIVXQzYDJPRaBG+6UruysCFBJUQRIQ5qSoou9t1VQz4tdU+K3rF3BBEIpov3ZVLpSxh/6Tx/U5P4M+F+Xez0OQldYddf+vQG1f/TdsjuDu2HMdGlCQgAbZPONsPjhx8MWfYT7gPKU6G1HAMAHLa0uHlzb9herHtoGMA6QlZcovnYPlM6HPGAcBENGu6Hfn3xBABuHV1eXrY1ZdkCgM/sHzNIwKUCKca//lO//A/+xW/+iR/6zrGu+tHF579+enK+NdA6ZVwsYmxY9poWAEodgJpahRhCiG4aqqJYqqcynW3KZlCf1ldNyIXWXRHVfiiR4otHSx/SW41DqYHIwTpNYQOnm34W0riPyTO7mxiKjm1KM89eVaUKEW23AyAwaRbyErjYxCu3UanFAKeZtHqGLjKTRSZjGLJ4PsEs6yRmHXuUbVfhzsxqpiYc2rErwSwQohs6ANRMREWloZiIhlyMtda51c8jmabw+iq51iaG2SRCRKKaqzGCijKAgYFZZJo1Z8y0GcrS7P/QrV7pXp+evAxVdpHd1e6ws2FWg1zLqQyZ7Q/dftmR3d8/xgZ8ZLnSzn/aagWF3sSXqL/Wn3Sgv+cgfHZxx4Nrci29SYs8cjIUjmX4ImwOIK6AHdzXjH9TTtZmixjVpqx8RJWaYvAolSk5gFVyIA6EzGhTkJm4IS4wmrm5yXHQ074WDY3vUTNVANp2AyGDWkBUgyZ6WjQGpoNlc3w+eDfLZNe8vMapaq0iqp72xYiDMz5mxD4WA4AgIpLrNoP4t1SLzxlDrcmjwdCcvk5h9FX408/AXNJOBFXMp+0qdZ73x4kIaRFpI8g09m4POacYAfBy+WyGE4nUhHDZAzwxCk6teIiZaxMQcaheh41mSn7f9dsqs4rMaqNx+YSovgag6wzJM2l3h/IECICZbLkzvL9Bq1+dst2/KcnjxxS5P2Ohuju27/55vd4O9bIooxYIMWy6zZOz024zXOpkduZlZ9gBTLk9WtDRjUYH6/awCLqq/UzpYm3dKPOeP1GcsXFd/Mnj80F5GXJqVk/b9wEg6Bqgfd4P7D7VBuomp1v7+F/9zJf/7i985Y9+/7cAwK+9df+th/2j045Jb+zxKoQ2xXa5Oky6WLQAEFEP9hYA8MFZBYDtdvvgfHAcB9BcBaq56tvN3EWhDBoJDvaXQy7bPndZHp5uXzxatijQ8LYTjuPAcrYpi8QzrPtaNQR2P9ScTOBqGUYULx5DNCJV9WRzMTTTFIKZDr5bNhSDGLDImLY4V+556Z4bAFWh1Go2zp+uLstTYA+OIVnBwHAycSxSWkQPCDMXWTZx1FOP1t8QvSmNaKyiT0zzWlIAu74PIZZ5ezBlniDA2M81516puafebxL+Qrrohv9LXPxweGGWP4747oC+y6Kgju9BHEC2efgibn84vjAj9ShzvGoRumZSfcaLZxLAOM/+1e7kbmzPtf6ufAQL6PxlHOKSGl+xphAbDO9uHgHCbaN5bP9JOf5pKMsYbWI3wDClmCY8ioG9JlRMDKhUEZVo7Jr6GWJKVU/B9o8f6QJV95oRADMV0QiQiyCRgZUqiGQqECKY1Sq5eEfdWIxOTB6v7VeWoapMh32ptSI6kyMi7nUgQlVOMUbGXAAYiGDT5+2AXumnIsBkiKpQzRggTFGj3VAWKcxrA0ZaLZrE6DdjZa06ahxTZDQcZLK5jrl7Y0TdREXq1HONgOgtgFPODIrZ5VIUkQhJKc9FBWBjCP7EvHsmtvMxPFLz7m/dDa95zihJlhR3ZTOZTNRAYe7LHheWLf5Wt741LQsP/ydF9iuc+4e4lvoijuzX+kvXfe66Z1cCOrLfmrxMq4PDu6/eWp913XsfRDZYMgC8AMBxAScdXF2xzn9YRGpq3h6fPCS58+IqEgzVfGy/vKrQHuwoTGfO3ZmZLu/tt3WT051b6af/+W86sseUfvlL77z1pPvEzb3ve+PwYJlSatpETy6G+2f5wWkHp127XPXbTbusMzl+tGqPVi1An4vXjNE83uZSh6xFtIlBArOWVUOR0nqoXZbH6+IBIC8cLc631Q2lPqc7uHuZaooEReuE5rv+ulnqPj/t/CSwKh6kV8Q8e83QI5zU5xffhnkCQRUhZB/o+n5Q3NUHjMwAGSKBAJC5BxtVFAIgQOPIDmYGTq+rsZtOAGBQ8RezaxVyre58cf7aPfExhO0wMHETaIwzMzGjqiOyA6FWIQ6LyACQc8VpbH94tv6x1erHu1uvTtLghuNQC1xttnKAa4zmcXubhzd1e4PSq4c3ZifqM6Ifn2Zjrr6p2vmkTG+R79duP7afWh69tT31Og5fh+yHNJMz+yE96TePUW9QWglvQFbAc1w7IjsSadXlIjWBTFUAahUObASIpFLdAeAz9Zjl6dG5gIHAwGoVY7dekMg4wgdC4lBrJbQY2NfpNLePmkoVT4h8eLp1NSQCMAJRKHUgVVQT1Yjo/UQppdEBxySE/TDEEPw/OeORS0UCP91HF1WVlMLN/eXJ+bYBQCTXPzpbkqvOpRYiCkiJLq0yYiaGzOA2KhVjsjzUJiWncM2MpyctIgZmU+HpmmiqWTUF9o8ZqtGYjA9gk7ARbFqo+sAONocSjzV7QE/vL9FwGs8vGD98p7rrVu3AHOV32YY3hvSr97vvf/nANY6/DUz/EE7mCuc+szEz3O8KaZqA11PGSoVycbRqYNXgdrPtq+XiKpcbDQLArcPFsjIA2CreffXWzXYFAOeP2rOTTVqym5j2pNpiFLnPp4LjO6ZIbXhxDzc796sm4LXDZBkyc7jGuV/znd5Y2a988d3/9O9+7sd/8Nv22vTVe0964x/8zlc/cXj5iV9+78Kn7MP9JQA8OO9zwSf91n8tWss7j9ZO6oXAUEZJ+2YYJ+6hVFUZakFCZspFU6SDsNh2w5BLaOho5UE32/Xkxa2ic5zCPMLPIvfrjxNRBZUqnpurZps++zKzTnsOd9EFQjFUs0CUAo/tOQjOb6rqkLNdbaWZTylFY/ANpoIikLmuoGkacLZkHvOrzr9pz+8FgFIlBj5YxsfnNTL7DVdEh6qLFMyg1BrbqCoeeV8GDYF8+ZaaiIgyFivats/t9Ny7GOqnGf5CfukUsntKLytSa4HAl6P6tSYNs/u1ewDDH9t7XbNcovfH2IZde5s3qBTD/doBwGdv3nn37ORTy6MxpYCoAQaATmtQW6Vlp/XNfHEO5VMysu0bkJ9YbNaDLUP0m76qLtqwbKJbmrUKEQJhFXXLMQLSZGVAGHOsiKiI3r2xqMb3Hp8gBlXxpg4EnCo7rJh4DalfttpEMXAVJTAA7LKslm0InKuOkZze6TGVVakqmAGQmEXmQFRUxCzXImZhSsJNMZp5NkDAHdd/NYNcgbCoNUg7TzhtU0KsQ1YPKWtSEPN1EQgYAzQx5FIie7WTqgpM7Xp+CaApYjmGMJQyP+zh8hFG7wo3AA/ImBoOzE2q44RuOwMOmKqC5/0izBA/M1RERDtVUz0843X6EsZrvalX1INqu8zNAcR336pff2kLAPAB1Lb9bUhiPpbOfRfTr8XIOBvjMsF5yTkoQNw/Snm1Wm42zWKQba3UDQurAHDQksO6JwqszzoAWJ913dBjE4qADRWbgE04aIKyOtsOAFKMxADAlqtFCDduNGFbt+Zb1lSGKWNgh3DnnSP0abXMKuWTTfpP/s6/+AO/43UA+Oq9JzdWqx/89v3RL5r1uNOv3z/ZdN3Lt2/cXMHxBl0t4zjuyO7z4xzfWBSgaIo0x35BDN6H55Y8CAxFU4TlotFactHTTd+iUEiNTkwLjSS7O1R3M36HUovSrgLBR3h/uBCAAclN56KeM+wI7wK4yLQtJU1nXq7iKohS61Ar+aQOMF9j54ww30chIZg/10e9c8PjXxeYiDEXaYLHCRiqqlbmWKp84tYqF31wuq5ibYpTHzEtU/Cws/12AQgCvM0ZVVOIVZUIm8CiJlKHIpFhyNCMbWVVlM7X6/8YXmgT33i5h27UPo5DOsfrt+QdX9Ig5Qv17A1ardpmV9V+zZX60Xfemme5+vGwfQj13zp42f1Tq6nqa0FB1TqtUKUJyR2qTzQfQFxhcG3734XzL23zso02Obwi8yI1ntHjWQWRycnxwAiEilDV0hhZPlbZ6Xhf1BeP2vuP/bCHNrCBmWpgcrMXE4upiuUqiJireLAEIwBhrpJP10w4lDGxrolBDKDrvQlrfFaAMuK0OAURKUNWUQvm0b7MuOmGyMzjQtIJJSiivQgxpxTcfwRmpWIM4w5p6ZR3qaKWIjUx9FrIwAACkbFVNQQBs0Wb8piE49J0AyIDrCJIwMzmOK5SVV3mG4lqrZfC3BmgcY4EBwDIolNB9sh3uc6RzHuyL693ngDshg8/LbpOrs2790Ffeh4/TChqu61MLoh89Xz9ldOL/ZgA4KjYXsSD4/YsGQDghxr0XNv+zLF9npXDDOu7apn5z6Jyts39kHdh3ZG95DwMW0iBQzo4TFLzXqlwYz/6BrWJAHAQSnvrzst3bwDA49MNnL27Ojh6+rs5ugFnExV1sa2LqdkuNQwAKaXtMGYID9OUOosgAWAO+38Gp9Sf7berv/2P/mVWiKj3Ti5eu3OrIVj32cn0k4vu/eNtJFgtFm89OP9SFqk1BmwDHh6szrf17GKLo3PPAEACTxsn6reV+Uok2HLRBJRqPOTSZQGAFCF71+ug0LDnE4iQXwLEDEQh0m4iWiQQomEoIbCZHa6iZ0aO87sqqDETMG5zRUQ3YuBEszRMAsCAolpE/C4/pz8yEZiFwFXE125zyIACoLMlTsxPL+lFk8RUDAITM5nBtpT9JgFizS6UatXM7yvj98koqmLqh5D/Ztbd4NSNZ4sDwI1lPN8WZFKDTT8wUROZiWbyjzk9PD//sdXqx/CVz60f/GD3ug5zA1eGwLts+4A68u8TiP9afwIA3793x71F121K8OzOvKcJGa9aXaZmm4cvwubH2ruEcNxvbzbL3Q/baAGAVUihDZt++KC/OIfyKWv8gflFWP9kzA1GAFK//o+er4qINOqtEZGqKYALSZNUERHEqGYcWES9wTYyrvu6vn8+sl4y5vB4EyiTDVmYyUVJjdeTuntnsmgVUWLkqTbd+WtGiIFL9VYTq1NGv5mZCoHVSYNiZgqQYsxFYghNCC8cprNNyVU81xcAZlUlITIRAlYDVcgqROR3XBIyNBE96btlE8cdBFiTQqM2jPgMuRREd0QgIqTItVQkEpHRqKGCiJ44Y6pF5/YO4Ck8lYhs7mO6lB/MCk5T1RCCp7qLm/hGSQACc60K7Plxz33OPO1T3WVmdrPd/e0u0P0O9uMoZ7TVypJdg++jlJ6nenQf6NOc9nMdqrNxiYmHIsN2u+l2Zvmn7iJz5XSMgUPaX4bULMcglCRHN++89MarTXN4d/3wq+1he/oIAEI9f1JWAHC4YA8P2D8/A4CLfjNjeh7kmXLMb2LgGmy/wYdn+g9+5a1PvrCXUvOJ24f+I8SU3n60/dLbT9wFGonONoURX9xvAJrf8frR/TP/ofrNMEraD5K9e5KromsQmdTV6HNJHgAElKNV+3hdmjQG9vqK1c9L52oc6bbdMLYcAFx0pW3ibjZPGwkidVkWiXfTgL3ZXQhyqQLmvsQqQDBWJDORiJZaAMboOw/DITRRcHYSweUkPMb4mYmqs6Wws1BFMxVNIaQYtn0fYyBERjzvukhMiCqyalMu1f8WMDjbZlALHAKhqC1SPFzF4/NBVE9O14wGOm4kVQAQn1z0KbCKbnJpYghMKfCUf1kBwtl2eLnlv5BfugcXBxQAoCtTRlh4fn6zGQCclO7ruvnh5oVxfQp2zaD0kRtUAKDET87PZ/r+F/Tkh5sXbjXLCynz2F77CmYD6oqmDu4sfgy4WWkj9THqTy1yHnQZk8zJAQBDrkRYRPcWScX6UgMqE5YqokBEUsTpqRHCfMlhVkTDmHOEoObWUNc1+h9CYANUlRiwAjQxIDkxjWOao2hDQQBCjL6xaWIQc5ngKAYvtbo43cz6XFbL9loZqSvQRv5z0PNtB8ieQDcnLQbm5dQttiDc5nEVVKqMpj/0n1e3Q1k2MVdJkW/upc2gWSWR90fykIVncbsqcVBVH9uRnITBWVcKcJnm6A2FYx/T3GuotptedykYGxen411WwBjmTl2dxnacEwieS788dQAsgDLZNS7nJYxf39mF4qZAyx+uYffd6dmVTeUlrO96QunaQnXWPnroY1/Evf6OiY7suJPIuL0qVHCgD5xWSVZJNplV1crAATA2s+quhoPDBTuyX37TOz1kM8RfuYnk69vU6S/trk7r2f93v8G3Hgx/7e//i0++sPddn3yxTeTff0NQcj656CLBiyv8vd9688WjpZgdruK3v3rrez954AkEbz+8yEVXDa0aevXW4nB/uVw0e01YLprlogmhqVWGodQqc7f1rjXJSRsR7bJoLU2KRSeOHuVgGWZDoDqTs/PmtDsi9tMsvGMwAlMjIgYEQ0YKhK5LA4MsWj3lDgARYwiBYOqMN9GxAVkNHRgmIQ2OfalX3wDgYG9ZxAwocgDEXEUUVm3cNWuPmyoHIDfXTF/50UknqkMRATBkNUETNHEQjMxFrKvSxJCCFyBjCDz373R9/x9j81KzfyrZQxwvn6hPKWQu/4A4SPkf8/ENSi+3+6r2zHn8I5Hd7aYzIfMLejJ/wXf684O5asOMmFZtM3/BTusH/cU9KwcQXQz3/8HTXx/qMiaF0QFkZk2MnrLS8BiE0oQ5B0aT33IIR9UsondauW9orC01C0yE4LtDF8tWta6KP9xIDGqBKXAwFVFzl0MVZcQx7lFd80VFNJcSQnCvKSPWUj1CDhHVsOuzKIgZTaEXo2cVQFSPz9cxNqpaa53ZD0KKTN7Ruh3qRV/AlAgCYRHzA4wMiNhJ/1zFQ7uO17nPlXGUzDIG9yvheMkA8u5ukTk8BxF1Cvt1GnMWJqRnxdy6rma6ws0Rkjp7bt3UrXMbFBGA6qXAGuea7F1m5sOiUK4+Fbdab1BafNkAwNeQ2yCbJ73/8yFf55nIfjLYNbd/2J3THeifagqHQaEhQNsaLhuCD22tgat8t5yfPnr3/fgqwHbYdNuT395mYIlqZVNrcirmmRB/7e32YfPWg+HP/pc//+oLB9/7bXf7rH3WD8622+12ELx7mL7lxdXv/NRI0Xz+aw9M6c5B05Ac7C36rA9Ptx6wnou+eLS8sZd+44NzD74YCzeI1lUuY7wAYuJqHFACSi5josTYNK+wQgkNbQad5/c20npQH8eqaF9G8r3LImbrTjztIIQroR8ypm0DBwZRf/1XsUELIftqy8c5BKuKu09cR0+bQnp1nmKu/sGf9CqSQkiR+6HESQ++6XPbNN7nN1RVHWKINlkKXcXhu9MUaMhlk0tgZiZGAANBRhNCFhCa/FKBXJ2pRCMbi0gAdLLt/+3l8t9bfObRNDtv1tsrHtSr+N4YDagNMJg97jcnmv/YweuqO8TLXMnE+BHA7o1LhDOyf0HXAPAjey95/zUAeO3qph8aZJi7nKamJx/bF0Arg59rL356KE3ymZ18cbdcLNoxjl8Zp/uKQVGVKm5cGB8mBfSmFBiBZqxAAlADBIyBidDUqtkMH07CBCJXPVXVIqPzwKVTc63jnOPW5WpmgTnEMF+Rc6kxsIARuaFB3P5jaDG6YB4YbSg1hhgZqU3dUGyqJw0EnsTLhF4cMBa6+s0QMAIYjGXcHJARc7FSZWp6h0lNrylGMBciExOB38aYEZUNZEyMufSXzrI0RlTVqfz7CrzT+Jwfu8fUzCM6EMlAJ+HsHBSKYhox+PNdVEWfLZgBhKd3qksKneYOFHaaZI4gAgA24VsXq3PsnYqxVdzP1ZmZo5Q+RA+zK0K50eAzFqqO7DMhMxTxNoBhYkLQtoMuEQBt+zSyl1LjjkTShlKbvNt6lAdZn52erJ97JgRO/ncpppQof9QP83HsSxeD/ef/7ee/+1N3P/P67ZJzzsMX318/OF7HgJ84bFcvru7e2tsMNcTwwYPtptDRIt7YawAgptTnPk08eIp09zDlmnNRV+B6juNFX51LiUTuTe2LshYloBBThF0afSg1UkiRVg1tBvVlbIrUaNj2GcaJw3xm95dl00QACFRXi2YzqO9gcxUXw1XV2QxsIADgCi0kZpCABEimYFBzVXJ376QRnm1KzCxTOtgM6z5UEmKpcrS3Yp+mCZFwyJUJFqO83fqcm9ViTkUpVQFs2cRSxUwBXMPHTSAiqr6UJhZgASjVlk3wXvkiuowBbIyX8fu8mMVS/oK9plR7kyNOs/9oXKjukuzz/wL7B3xB198TDhfIOunb5oF9kLLg5sOpdkd2VXNwfw/yOZQ/sveqF3C/mS++e3nTAb0BvpYZqWof9Be/asPvwgYAHqP+ldpjYAaUafm7bNtFZDVDQFFDHokMmS5nTQxMlKsiMYAq4lxAyohVKoUwBqkDioKhqRogNRHE1JvQGD14C6raZCYCUIuRM45mTCZvCkUD8DLuIecQwjX+E210MqvvimhytwFoFU5BAVLkXLSITHleAIAu4PF1ZUCu5HZlzNX8RFdG8109YiAA9FtLMB0voJMkkVDNkGWiTfyuGZhUQUABrIp6hywTlVrH0DHGmSQxNd8omO7mto/BMgqXUh8FxSkkmZj9yUkUcPKXIqJ8DLX7tXfeovRE8zVB5FGL5+st7K3soPlExrNkhxnDJxIAHBzred8DXHLu2yD72+Qc/axtP+vGV+V1lgmu1lKP35laVlPR+TH2sX382S//0H6cuVtVT9byTA59HvBH1n6pTbhyr+FVaILmQT4c8c86Oetk8/9n7c+jZUuv+zBsD993zqmqO9/3Xr/XE7obRDeAxkwBJEiIBLkkjiI1eJBoDXSkRGKkRKPXih1ZTrzsZTlOZEdZSbTsrCRLQ2zairRMDZRESRxEAiIokwCIBhoD0Q287n7zu3NVnXO+b++dP/Z3zq07vO4mlcLDXdVVdevWcM7+9vfbv6FnvwIAf/uff6mZzn7b89cB4OFx9y+/cvfVO4fb69Pf+cGnn7mxDQDzrtgb7B8vAeCp3UlE3V2vZ3UAgND4OJQe26hnPhyubFJxEykpJIXINPJE3Y3AyZFJwekxp9NRURE9WZYb6yqedNmvz2qqAqNZob4oNJGYiREjQSSIoe6Tdin3OaesVWAHQVZ77TrEOkQkb0TE/Uq9ffGOWVXN7U9dfgIQmAOzJ+oV4LYUO/KBqs97p5PKHUJGL46mqrw3XPZdwAL5ImGfs5lWkX1DsL251qWcRJjQc3bU85YBmLBLOZZzHggGjcxAxPbtzsPj+U9cufLU5vYy9QCwEZsO9RzOPiqVVk1gutz/xmKfCV9cu3KuXpfKXtUXc5PPnxWETn8EgCPSV3X+/c31GYaa48vLvQNIbu17EduhirvcfwHmWw1uUwUAf9P2T8waDuIMJLMYo38IKYuBBSYmFEkCwAgBEYFiwSjKPJMMTC0phAHvAjPHHLKJW/KqCphm8SG286aYTZkoiTAXNX82a1PuUnaCoe9BESmt5JsTUYgrCk9VIkIiHfxcUY0RQTUg1lW16NKkCr6EmJm3vnXF0zo4EOTuwVmVscB9TsCPTClL3yUQGTWfVQiAmBQMbdn3iBCZwkhkGXAFV7GWQZFqYBY5rbxjnozDKIzoR/EwEMbVvVsJ3oPBX+g0tvKcNYWu9PxEKzT4rQbPITOi9ijazKoJgbPd7xwpAGz2OP4sXe8O2Ua9FnH8N828VVVbVVVNeT1WTrPZnFzyDy4mMYnKak0ftmYrjTlO0RYOu6O1jxBsv52w0kesBFhVw3R4fRqmUneZ8iPsbs618Fl6H9L+7GffeO3h4Xe+57F5lz/3ysNPf/k2Mn3789e+7yNPNRX1uW8qSn1fECe2rUm8e9R97dbhb9w++tTLd3/11Ye5ZW/e7x51rz88eeVee9z2KXfXtqbve8fuc1cnT19d840OhTjOKuoqdt2yTbo6tW4ieYac1/SAUscwst0nFY/hG22XfKkIoYhXl70se5EspmBgKXtwtiABEjgxUc1SkTApAFsRediy67ssjs+imZfiwOxnSZ9SURINMcSICKBu7G5Z6rpiRKdnVDG0fc9UXmoWTTk3k2J4YGoBuYqBEZcpEVHXpz5LHUNkdg6Z+8P4GA0R6xjMFIkIeRKpzSkyIYAaVJQPlv27I/0leyYvk58GgQiyrGLrqwXdY4/G9NQvwPwT08fOlG8zQuiGyb++DRqkJ3sAwOfzoQ9Ry54gH34gbj4KtddeXumPb1t6tqu2Bf+xHf1jSFUIhuBWDTGEejDvrato7qdIZOjKD/WRs698kyow2imkpFLc85maOjp8xiW2QmNgM4vMiNTE4uCIRItuyGjy5Ba1LiU1bEWWfVp0KZslEVWdVCEg+BpcVVVkksFJzUpmiNmwLoYQArOZItikqRDQi8aQcoRuTRyIuPTXaoBccCHd3ah9hF5XEYiqOjIBEqYsTuhati06iV7NBwlqhmA+gZhUjMQ5i2ixMs0iSB61AWPEDSJm1aw6bcK0Do7YYIGSRk8CPe3XhznB2JWOXyydTsh0vPf1KT6KM/NI1EFxtaN32P3Ba3RYXX5Q4tEZQuRaRO/fPQnjUmHq4RLuHOkyaXDfmHpAuFYNIHu1tus7hSpmr+kVT30maTgF6A0buGyAYCYXw6irmpdvBZVPpT62+eqSs+AOAEKfoL58wYgxVPV0c8LesAPAyzcPfv4Lb3zy/U/Pu/y5r9382p3+XU/svvPazJ3Zbx3m8aO98/D4zmFfLDqT9oBHD5cHyzSrYyTw+ss9Hs4TAMw7mdX1vYMFAGyvT6cA7WJ+1KPmxEzOgFwsu7ouO6TViKXppHZbmBOANQgi2ud8tKCNaTgFZwAE4HiZAlMk6JOOaiYiApUsiohcNpQMIGIKht6M+AFpKkhgan0WMUNxYiIDYjHwGk5RW3EmGDcB3sg7eWZSV1Ji2JQM3RfTNYqLLscQwDCprE8aEe2TBMKspmKxoqN561lCDuyr2rSOg7WANHXtb6okxxG7BaLvowWrvjv+P8ljsA5zy63JRmxqoy6conjnuO2dxxVnAYBf6feepdl6qIpSnwoxBgAy4QyDihLhpbAMVafouSd7fF5PnqXZE5MNVSOmV5bHAOBi11P+xGBt2IFAls/nQwB4zupXsPtJ7iIwEznyxkRrk7pQNcDQMc8ShgdI1KohoLM8VE0Mw/Ay+yx1YGaat31dxbbPMBgFB6bIBIhVwLKEIrmvZJ9zEgkcTAuynnIGAM/RVFM1a1MmxKausejUSn3mEJL0o8++z9hFpDBJAJhAlLLqAMhoaRDACFBUl12a1NFUfUjAXPpsJnIOFTl3Cwv1FhG6lOuKRsJlZFRVU1BxY4biWbpMCqZAZAB+XogqD/GQDINNhEuqDXIWkdLHuBapjExLbKuV/yOKKYE5GuOwzCnJ6tQB+BLL360GD1rzn2/pTwArIatbEJ86kvuH883J2nly4J5uNM2qe7uD8iXj6BGD1pE5E8aavlriLx8y4Wplh6Fzf7PI6XnPDrnMQp7n8CagyhkcZp4BqnM4zMLo0r+UoXaeu9f3wNWnvnT73Y9vAMDnvnbzlXv5xvXqnddmfd811QQAapLZZHbrMN+++8DT7JLCyXyRBKY1AsBinqeUq5qlXXbZfJ65t+hVtLlaJYU39hav3D5cm8RrW7PW2j5pXUUA6fqUtRT0akBvHGSPOa3V4ViNEd1WjIgXfe/OwJGKUzyaqRkGTgpjOoeP2twdtw6FO7HsMyCYgoEgkACyuhO1SsYuufFhORI9HbhE7qn6BrTcOYDsw6YXkdBSbmIowdyexVHOBGOirM7D4xjY9+k5u1YGc+pnTd2l3GeJdWWqRLTouopJDVRFgZgpEKoUIpqazNtcheD0Po7h4Xz54338zseemLedu+ZuTifzk8VF7uOIuY/t/Cv98Zdk/ic3v2XwYAFAXGqugdzVa1YVz6xH9d2jagkAXoI5AHx84/q4SHw+H/7I2lOnBHk7pcj5ArMnXUHbDX7KTo6yrDXNGNk5ayrX5RMTWDHSicyq2mVZnwYDbPt2UtWDD60AsBsbZMlXt9ePjheuay2SBQQCWnaJ0WXzaIpdztOakIgB2z5NqgoQ+5TMQAyySAihpLKskEzAlJgdCkcAA2XmIsUAKPCdh6YaEFOM0d3NmFnkHNSLakqene7THUIEKgawCkTQZ0UTYm77pAZVKLF5dVVFRlPguhYrLTQjImGXMwgGLLuYrMZEolosiMrQCgUQPFhq8KURseM2mQEx55y9C0pZEIHOQBfOAAZVDW4AObgvBA46VHzwAfeKA8GIyWw12LQIYHdAb7ypTpXPHnvXgV65s7x2YwUgOakBSnHF9rSsP0q4dCnVPbhH6DhBbVPRoxYZanYtXKjiKeZ+8XJupnq+Z7ejN3fF2ZzwvQtpg1VVAehU6gUsH7kGygKWU8lLgHV/npdvPuz6xfXdK7/80s1v7HfXt6bv2V0DgKqq15qqU5jV8eu3771yr60ITtq8SEYoz+zOvvOFrfft1m6T8HhV+rJ0eLzH7cFe96Xb6XNvHL32sL91uDi0ACAAGbUzqimUaA4RHRkI2XhWw+hP0CadTur1CZwsEzOJqvcwJ13eiVVp3nM36gy88ooqEBabKAUiQ6S+UIPP5sBBMcrPAkmyn4eF6TUIQMaiAKBQhnOoIiPg7tpUFROz9boGBCt1nNAADImJCRddQtAmlu77ZL54bGdt3umi7Y0oZc2iVWADo5JlDFzFrKqGkZBCpWKEIApJtc86q0MMKApNDF2Wq6T/0foL7tbibfu5L30kyZyyZbL4Dvfz+fBDuDahsNTsw1XVYjUz11SF6NrUN+dBLjUfpfZ16J1v48yZ0ITXDve3qfKVpg7VxSeYIH+2O/C2/e/A0T+G1MSgIAgMZrNpUzGlXGJSDKzrcwhu900AMm97twGgEkitYAgIkyq0XdeE2PVp0aXKDdsGdbEr0QQIVAMQEdaBVAwJl10aJzNVYMe+C8nVVsKHEFUEkPosacXqg4iISbIwoooaqw2tqyP4fZbAgREFzOeoAGQ+ikRsYkjZESFS6Xe3N7s+Ldp82vsiDy0Iui8CEFYABhA4ZNWu77mOhWiLxkTeyINBEjWzOlAdQ9dnN9XxzSdC2acSohfkoacBQHTavgIwlaTscY66mrVUTn8VdqxnuJEAs2ujHjGQbxuD9q1BP1Hr6bR5v4Hx1066M4FKZ6mQiyAQoF/IKtX9Ytv+SBFTrwYrJMhVOlSsKrC8Sm9fLfTnyvqJYH1RTPSvZ5KwyLk6C7v3suhT6LoeoN+cbFzdWnfXgc+9cuedN6597pWHrzxczur6sY3yWpqKZpP4mS/cuXewOFm2x60ezxefeM+V73nx+nNb4YPve/Jb1oAnEWiNYtQVecI7ASjG7wfQlI4fnHz55lc//bX5L339+F98bb4/N4Tl+mRy43qVW24iUSheBZoTRGpQ5uAkE+z6FIeUSw7c5wwAi2XPiJuzCMOWMKWMFAKIp+6V/akPLo2SCNLpd+A8GQCIxK4ESSLD5Mk1hKbZyZN2yopBpBV6DOIZuqSBElNdVQDQ5eSMhazW9gkAYh1F1B1L3LLVVzIA9VT79Uldx6BqvrIkb5YJTSwygYGpIUKXxcwikZB7njVOlz5cLP/Y7u6mTeZtF9Qub9sfIS51avmPrD81FHTwzYyn/QDAjKKXdcJHIOZqTn/UlF0ANUFemtTA2svNtPjk2g3tpeY4/vWVzQEfS/p8Pf9wV78C3U9yx57/DmRmkyoGxJTVszK8iS4AtKia+Gw6EEUil6rnwbMwiy6TXt2alnEW4ilOYCuwGpqBEaC7D5laE6MwdSlN61pU68Dtqu5mxdvXY4zc7NMG49zRkULMyHTMZiImZuYBsshqzGC9qWoMJApqWjERARGnLHVEQdacRNQRJzOg8irNvTAWXaoCRyYz67MxgyisT2tv5xFBRUPhfZBqcvmSmEoyp3i6FXZgFjdRMkPEbCA5ERKYQRmpwqrg3Cu7qERiWKnyI0fIF0DfiGQzf7yZIjCd9RVrWmwbG/GZ25a2ufLyfS5YtYfk41ZPZQKADYhyL8Mzp6XcrXMvFnEHXgY/xvOE9/MsRAdk+stmTCEGgM4Hj1U8M1YF6Ffb9osl/hwNZp7Dm7BlVhH2qdTHkB/Zpw8DXi/rXULN8/09vFfHp95x/eVX7krSvaV+9fbhrK4/9M5rOxPq+w4A2l5/+jNfdxwmgr3/Kv3YDz//+z++M7t2I25fg7WrZ9542wNA//C2dGPOfdRqunkjfvTKRz76oZP/+b3b//CL7d/+zGu/9PLB/sniajuBEpiXxvoOAK1xJO0Aln2Ooh2VgVIg6gEYECItUwodA7jVoiKyt5YJAHM53BwlFzUxY0VX+2gRE4LpYKXii/HgiYpEmh2NgRXlXgHCR30eFbNTcIAmZZk0NTMwIhgyIQOoah2DE5bLUMWMmSULER+eLMEsi0zqiogMYNLErs9dyojMgd0/JAxv3wBEdFLHLuX3P3OtZvvVrz+c1vG47d8d6c8vb2RLgLDQvBGbEd1eYbUbrCZ3mwHAg3b+BZi/gNOCtq8uAIidZZeMOTj+JvT2pUpr8hLMPxg2n5hsuJEvmL2xPN6gMGvqvEy+Wuiowhxg9186uXsg9hjW/409PMrisddmFkNwlan7PjozEK0owBNoDEWfbIbM5GUd0b9oWPbZhbtdn0IIiOBZFjHwdFLfenCISNOKs6IUAZAh4ICeY11VYtYlr57sdmAF4h4+pRjYKzsUwaqKCBL5V+zLng5xLt77O0H2dO+IKAAyHIpYmFFl2ABIeycdMakYoFYh0NBiMhgHajsVxcAkQ+pIDGQGkWk6q/eP5uzCXDcXAKxjJC4Gdp7/J5DJCoYTImallDOZEZKCEbFaqdHO7k2aAdAZkIxUUvRMcNjbsvu5e0s0vEcYPoQzCtLWVtkyYwsvnbmNO5z1gxxNIr2yLzRPgJ46koO+f9L3+4kBYDHl9UV1qSr1UhHTJJKP+04x9/ZsbF5O2RM5mlLcAQC6bgFwBpPpugUAdAnXAeqgiuVFkPWXovDtMo3a0TcfqPoEtQ7aZbrI2PG/u7q0eF8/P7j/eh3/0Wfv1oyvvfawCfyxb9l55+MbX7+1P6vreZe+fOtovuzbRLsT+w9+77t++MVmLOvSbAMAt+cFVtxMxsoOANQvFEC6BFA328/829/T/fCLzS+8jn/tf3zp1+8dXr+yOToQzBVmNa2SnyJTl9PMvRXNEDESJxUGTCrOYfezRdSIDAxNoQdvKEBMDZSJREbVtCF4ODuIokHOMkZKCroEXNUdWcWVMCvtuW+HUXWs+K5+cfP1SRW9I1O1SR2coh6ImantUuSSuieqSbWOoWRjchEZBsIndqav3DkStWkTRZRA67rqxT3LwAzqwIgoKtvr/iHfA4h9zn+mbibIx5qCWCHJmK227QVnh9IBdqiA8KCdvyGLV5v+J/B6GXx52z7YDDgbfdDnXu7uO6qTXmuPtji+uHZFpaCrHerNtPjOK0+ssuDLNNVFCcAP2/mXZP5hrD9nJ/8Uc+QilELEaR215GaAALCVE7KpOATm8l6gy5JUqxBGG3KfEDJhZE5ZxKCK3rmjqmaA+aIlxGkdhmQVFy4hEqYkgSkGUoWTtp1UlTeudVX1KY1Lo4txTpZ9HMiGMlQ0gLHZBbFS3BHAZf2RUZFFhYi7PotqYFZTADdxAVXfo6gF5sEMQBGO5+2kaaZVAARGTAaM2NRx3qasUAUaDmRwPcegny/9tDubAnkANhWTXoJJrJwgZGZEAVVsSF6FEmAFaoXrhWB1FdrufLC0K5i0rCGlMzAsnXyhvQ9HDyPuLzMAe2VvGxubd6/4R3gGdl8M2iVv3lc79ymFrYhfe9i6VHUKDADTzNOqHPnVlPuFrMfzgIxX+XMk99FYN1z0bHGcvVnBVrqEAIsuubzCuoS+XZmnfAVilwngDOb+KCevuqnepL7zLCzglPdzjvA+Liea5xRKMJPmOQDgYg7ra1/8jTdeuf1wZ2O27OX5G2vvfXqny7Z/0u2fdK89XKbcnSzlY+/c/MufvPbOj7632r1hZ80j8dpzdu8VL/Shvbu8dXNx3G3e2OZp1CLqDdIuuR7RoTi78d7vX7/3vo1v/X///Jf++v+0X03WJhXPl0snp48yKDFz2vIypUmMRRvN5PxFBuj67EmYHJhUFBhMCQwUey1erA6YOLxCiB6rNArkspTwDTpDDBUF8FHqBR532VObnOHjuplMiMHMoX9Us+31KYX4+r399YK3RlVFpDblSIYAveSstjapPNFA1F65fdimXAdixDZLE2OXMhKDo59mPgCLIf7iF14jwo3ZbH/RvYvhR/C5Y0nub1xRXJWeniNBdiWPCPa6xYF0n4KTD3az3c2pF9zxTZXOGh/ZsI/l3lnti76bI3xsujM+vja63Z+4s4237au/6EiOqn21P74DCpb++nqyxam7w6SKqchuh04ZwY0Y3QbOiWVJta7ClEjVCDGppJyZEAGd255EY2AwEDAvuQZw3CZXIaSsiMCInSoYgnjvbMNIfNQqAA8S5VNun2oI5GNVQrTxnZv5MenxairCIbjElokiU6eQJcUBzS+RUisUcrOi4y/h3aJ1Fdank7wyUYyBslrXpxjQs/GYIIlVARFBBI5zMoMqjN+XH71ihuPyiWaByKX1SNCnnERHDB1hWAJOQ16h6zMN42L38NWzVjNqA7UGMEt2jo2bAHvmrz/sDcpbF+zARs7MEpQvcxkrKA2dQXX2O339qIcjoEm9Dh0AOI19tZsdb/Eqvzk5z5AZ7WUWNrjCjgh72/WroRw55a5bzJMABM3zpdXzBAAwGx7QL5ZQr48zVcUKcj9OOH9TF5lnnoWVNYbG+t4uu32pAUCSrlWged6UxRRahSUG6O31fe0VjxZ5UvF73nGlyzbv8msPywamIvhz33P19374mWdefA6eftGXMu/W82tfvXU0nx8eTB57DuDo1ktfurrcP3jqXWvruy//o5+//vSTz7z4XDq4B2GtubapnUlbnpMC8O7j28v7f/aT73hio/nPfvbOGw9zRbSzQWuT8n0fzjt2AnJgSzDEpwEiViH0OTNxSuJmpkxMRCpGZCLq4rKkYgpeQwhxxZZPYCB9OfFhDEH1BNSB9gDo/xuIMYUQKWXh4bPIdYyBEVVEVFyyVEU6nLeus13V54NZCBEA2NB1XjJITIf2llJWp0uLQQ1qSjSQAlNOaiWUNWfp+/4/zNuTio9BIcuRdM6AHEH2kRVTG3Uo3r/v94u9du5u6d+9dr3UJTNiUjWfhY66JF3xf1qlSPoQtZyrsnh3szGj6DsAfwG/ng4dbV8Vr65+aPv94tNycB3oV6D75nHJ+TSzuqr8Yy/hSqocuO1TEpnUlYExoSgAgQqIWhXQKdo5qfv99ClHZiIE30Ug9EmYitcmDGNRJDQ1IghGYFpF7gcB85CUW1iSoppzDszuxmwDfeUMZcTMMxdH2N0XfijuZAaIXVJRMZM+oRtN+5oBaHWo0JxAaVXF3mcAIQf2NODrO+uLZTf2HC5TqmJAxAyazRgtECfRLBmJwRSRTk3bCasQVE0RAnAVcNEJoyJxFqkiq1lkcKNjRILz6QVlFxJC0JRshek4rnZlbkw0qlUHFi4DoMd0vzks42z3DYwjN2Y1g2ns2cfLCzj9V/eWdLVetBnavAAGgLut2GD8hVVsTC6yYjxCY2UQWzrvg15LTQ8xeH33tr0OOJb7LuEshnnKEzyt6ZfyzVdpMyMJ8u1cVqmQl0Dtfd8q5MUJxulalSaTaU0yDaGquaqqk+Pl3vH8voRWEhHn3L3w3JM1wZ2HJ1/8xj1/nxX0f+GHnvvhF5vJ0y/AU88DwMOXf/ne/nL/fsv97Y0XPv6+H/wjd3/pbz92Y6P96ueWV5utF37/u3aZ2/1Pf6Vebq597dOfbz7+PSdvfHnyzTvLzbX3Pf8EAGhnJtkkbz159QDg3/oIPEHhL33q7lceLivKKWsVJ4fzLon6XJS9SRlK6rlE5q6XumJSi8SqicjDcIAK31EJwZFOh1UJuUDfriktk3AFZFV0qZ4Vn9VBLS1ymqk91PTCYjZjRCMEsaaKYNYlQSAwm1ShT7p/tKjrGAgHa0Xqc44MLjtSE3afjxISb13KnisOYES8aPuCtpt60MGiSwZaMamKqRxl+N66/mRzw90Wy4lExcnRO/3Tzh2x2AyA3GqPKcZPpcP38myd49LEuTEqem4Aq6KroUur1dm91wHgTl4+1WzcqNe90+tAJshfnD/cguho+5lmH0uhX/adt+1vUP6nlqvgZGwIIUwCAwIRq1kS8V6NiGIodvXjma9mTMVeIgY+WbRNU6Usq54/fRYmjIFHYT4h+CwBAZBRBCIjAIuoqQKTqqbUx1grAhrIUJWYuSLq+mIKOO7k3D2mVEQEJ1ONH5cMoISpZdRArKRpoJl7QaxjmFbcpeyNNXqmEpGVg81WLLrMp7WD/zEwU8oSCE/VG4gqmTiMDbgDhtEDDNS6rFmAERzlNwPJJdO1rrjtOmYa9ajDUl96nqx6UX7pqPooQ73AZ8dxP+Rd/xMaLo5VnRB5vlWn81Yzq/XdYfcn33GN2sWhVnZ8IMnmYtCExTB2OrABJ++LkEhSBsjep5fnGRCXSX0WlvG2vVMI2ZxPPxr8zmKYJ4DkQZFVvCAUTKttXZekkbHEd22/Xh/1uPEoTOZSKuQqLNMQwCxuzWgaZmvrk/Gu9WYCAMujw1uH81fuLlDhuSd2n39s+uCo/eUvv94lxTipoPtPf/Dad7zYTJ7+YH316kuf/rn9++3ue971/h/9XuiP7//3f237A++Br/+L+tYXDm59AQCeBNiyrx986vMntw7e+/jW1kc+BP/WnwaAg//hl05ODv7pLx6GD9y+/lTceOYDPI2ySNIup5O02HnyOz4Ef3mH/tOfO7h12K7V9Xy5VBV3hR27Y7ceVVUxqFirEJ020+dcBU4gFXEkXiZxscm0rgSQABiAAJMqoYmWcZifqLbqaZezragtyhbbwMBU1AjZXM6CZ6HGcgJXIVYxlKa1CmKKiIfzrqpCEp01jZn1feaisWQAOGm7enXJR3R5aojBba8EjGhl+OYhnGZVCITITCmDSv/j/WY9o0XuqhB9lFrqKV4SrEGES82vLA4A4E5uYbD0qoFKz35B4lSvqKbPVfYxi2MD6MZ0HYateg20BLmpy0+u3Rh95M/5zyw170n3aTm4CenTpAxMgzHvpIp+CnrxDoSAqFnWp/Wi7b2V5oEYF7kwFAFg0SUgdBcUn50YlV0XEzvdSMzQgIizagBCQlFbplyH4EYCnmDeijJxZDxZdlXgwCSARNRLXos1M+ecQyAxdUajSfEgyjmHEDKImXEI2jsHLBtxjCEGzjkzY4ghtX3KmZkJiRjNbNFln3auSH4UiVMWJiQO+0dLIvB34fXSw0NSVgMj9zQ1CIQJIMRQM3XuiHk6gStRvCO8QwQihoRIBCDmqxRRlkzMBW4HVAOEgtiggJXgFkfmi2eYgvrbH7sBA7AhqWOQDwMTwcDwP9e8OyGybQw6OIISvDdi7n5ltbKXuwQA4F3vvHFyuIRrUwA4OVoAwLET23s7DLUdH3gvfUgTXMyXA2tx9xwr1zIAhHbINnIcw7kxmeDkZAEAqe+TUT/ott3cdpna5Vl3mrcUqR53BnD4WwDinfDeTOqdEKqa16fhnCZ2ukmb/c5LX9vrhK9uVR96brdT+OI37nVJe4X++Ph/94NPf+zpzdn1dynAAV3bh6vHd37xu/7wv2Ovf/7gV/9Ze3L8y//1X3vHTgCAm8C//IX7//b7d9748s9tbtDP3ew+crR3cuv/u/b4Pyva38e3/tiH3vN6P/vSlz578NLPvvD0k0++7wWCBACUb9MGf2An/Iffs/Uf/P3b86RmYdLEc2NMRPSco5yyGhDlnI3ICLHt09qkBkImtj77pGvZ9cwcA8aAnm6MQDIcFoWJOHDVsxRd+Kpy+pTjSAOv2MybfxyVPkSIKJKb6J6yUDvGadhm6VKaNg30ad72dQyA7stqHpxQBSZQwBCYSrSxgauBrfQNGlxT6sPJLJFhvalkGFe2it/bNJ/EG90py0iuTjdGnsx4jq2Go+51C00JED9nJz8Qr8ya2h/veqIaikNkByXdtAOpVw7IsRtdDUe9srZxOok1I8LPHT+oFGdNPW+7Gugc+XKp+cHJ0YH2vwLdp4MuzZjQivNX+eo7sY1pFDMmUrU25zxvA5MBgioQimGf86QKqoqAxAgCrhd12aoVpMRGdMXdN1tRU41MiJAkM9I0shg0p36KCElpcPR0FJ7RVAG5RNSGELIIGgiWnsAQ0Ma5ghblTuF9G2gOgRlxda1z6mSWHGPkQH0SBgpEBkhEPoEjgj6ZAQayKtCiS4hURcpaggSwWObQ2B5ntcgkPs4VDYHLEZUzx1BVp6l+bRJJAmOUGHiKL9UhdClFBAUUVWYiNTNAQhAQLRiprRQyMyV0A+3CtDmzSvnC8KY4hDfvDrsfYQKAMXjPi/gqPnPu8nC/u/rUEWyWyOy1zQkAXAfwJLsbAF70S93frQHgkAK1l0v/gwdxnGe1D2PVttflsrW0wDgFAEsXn2XtIrPlN3Xp2v5wKU6SOXdZb2bewm/N6vVpeBR1UqbZE6mevb69M4uf/cbhUY/IdO9g8ce+64kffgfdvXV4Z3P//T/6o82VD/52vXdgV/b/0X9zcusAAH59L/+dX779u59/bHeHfvFr918/6n8ejzaa5uhm+8a8w6P6w0+vARwcHul/++u3/5efeOLk1sGz3/Pdz37ff/XS3/6/3PnCl79y8/Vv/9D7pwOtZu3xrQ/Awb/3Pdf+wj+8vejy+nQyayrfpHuCUghsal2fxQyUANz6hQNz23VzxKYOU7f1cPGnSBWCIbdJiVi0ROE4LDgm05e2bjgJxxvdqt3Bdk0ZhrFaOeEJXWMNQwxIHQMjZjCXnM6aaplSjMF14TEExyvargScdilvrk3aLsHAtuxFfa1yIWGbtamie1Kas2sCM9PORj1fLhedT8Xzj/ebk3U+JgWFfijxHcjYbhfA3anlhMe532vnAPBN6G9gfHHtSunxh467pHmYwQBcPGqOepx7D0edVnUNPDJhAHFp4pZheZlqWNGdrywwAODuvkUNVBRDoWZSE0BuIrvLSp8lZxGz4KNOFU9NMhUE9YgrUwO1KnKfRASIyWwQsWlen04HcIaYcNGnlPMkTnwXlVImokAFcjXAtk/u+pu0GK+LARMyAQK6U3yS7CwYF+wUaHrMpRs6U0IQRJBiJlpom6LGPkDFYgdmqmqBuU8pVBUCpKxMIOS+ZpZFqhBT1sjciqY2tV0igvXZhIrIzke2IGaq0KcUGOq6djRHzIjKCwiEfYYsEpg9vBtxmGl59JifBape0Ba9mppvqwr5hgo5EoaoViIu95I3kWNkdtEWeBorAb5lgJcjMx7M5JPVXaoWmkd6zAjOjJzI60BfvrN3/33vvvhsayOz/eJdALBWPYLnruC0vRBD1+VYVTUVEmROedUazEv8uUI/DeEiPnMIsNUt5rw14umb0F+Mrj7dZHWLS8kzIIB11K6CC8x3H71OpQaA/ba5dSw7a9Xjm+Gbd4/d5XH/pP/QU1s/8S31wRPfAi9cBwCrN9Pf/9/c/dzLP//S0csHx992/aqbNvzRb7+xu7kZN9d/4n1XznsbHMndW4eHR/rZmyfrsfpbn7n/29+1DT/3C2tf+fyTAE++70r33He8/Pf+3vWnn3ziiSuLZQSAbq35yNatP/ah9b/yS/eRxkw+8LwC6fXs5sYLqxCCodtxZKcpj8YvCkO2tejoFpBT5sAl991NCxAdObUhRHQMhyxbTqYyO0PkwT5sXAO80x+9AFPKdV2LmYrVVTSDwMiEBpA8W4NJVJNo2yVfQHIWEc2iG9PGbdmlGNkouFTQhBEmUXtVgHo2mXRp3mb5rhg/SddULagFCg/a+dZ0TVespccq7933mHsHiF+xxQ/EKyOQ4qfc6B950WXsYon3p6IYtuPEn2GUPr2yOHgM6t1mttS8umlYRXuOSF+N/euEJ51VRG4uywRdFjFba8h3YK4mmdZRDbIqIjkbnQgluxuKM1vNAANiIDeCtBGrMUAs43TqxSoEQvQAJjVTNcXii+9rhqh2WSZVldWSSBUjmwqAGBLRpKqceQKGfhRlETUlZkkpZy1nq54iWHiRbkQllcw9pQEgA1VEMSBjIAIiWnaJiQNyNlBLVQjelRtYzZgBmcAAlm0/retV9nCfnLMXc07ueAGQqxjELIaQU+qzZVUzcFPMGDi7Dc2wDLuvDBK1SQJhgWIADIwUnbK5ArKZrpDNyOWocOqMTYO0wteA31QGr09WV6H2EZlZBWdewOm/enX5Np/zUeX+ZODAr21OwljKAaCm8yKmup6eg1PGyn6UcSM88h26q7uH7f0WLjwLU6mxjs6ddysCxYqs97sGbSZgHb95/+B40X3rtzwGAF/8xj0ASIqR+d98nni2/p4/+l/CrV967f/5Xxwcv3Ry6+Cbe/nlg+N3P33lytOTTzz9wel6zXWkGJEDAJj7iPLpirX5/FLm+zfeF3Xv9a/c3H/11uIQpnsv3Xz28em3/+B3bX/4u/HgtZ/5yU99+Om1d370+cUybu9s37516w+9uP0vX1/+6q3ldHstZwmBEUDAplUFAG1KAJjFmGH03GDXTBN1KY+cFgR3BQk0aNKLMwGfpjjRYHC6Yu5YSvpgxzQgQiGMhLzViY+ZSZZYRYc1u5QDhyZwN0zkk2RmqgI3dVx2aTqJZpDVqlCyyd0Ah5lqgCbS0qztOgGoI7tBmJmayrvf8djBvL1/sNw76uo67mzMvnHn4Y/3u5P1amnFQoBi2JxOHGPphq/Zy3oHQoQP2/mBdFtc/6Lu38D4nsmOZ++t2jnVwF3uM6G37TVcbprk9EcA2Kmnqx+H1/1X8+Ljza6z3U/59Y4dMPkM9qYufz31X6EcmJ18jWZNiJ0oDOYt/sxNFf1T8ni8TiyYmlHf99PGM7IxZXE9EZhVMfSpmJKDWeCQRAdwGczAjQvcT4ZJuQBYiAhJIRfmkrmlHGNZJ1LOqkoEAwpElkVUAwczNVUOoZduMV84xGxl3ru6IiqAMhMAiYoPSZ0wI6oOxiJgn7K7GZeIKBEP/MoOXqmJWtunqqqmdThZ9iUjCE2yjYc3moUQVSGGsGh7JGZEIiPCnLMBxICMlEVLgrxZFh39ApyTlnJGCmgCdsbqd+CzF0OI4Ex8GNB5MN+4ONCuZmx2ViNIy7NJe8ModUBmAO+0egPgBsZVeP0ic2aUMtFJd+thfnw3/JaBkNWiH8LKNMzBmRGiWb3rcLkEQDgNtPNsbtw7njtr5VzzfhKqemVeemnbHvJRDhuHS7EuSXvKgyzlG8C6tODueJEB4Mqaq4TiBiYIK5mu9eadw/7G9uz5x6Zfu/2wNQaA4+PDD1yLH/3WD+SrTf6Z//z4tS8dHunf+szXnpzVtlH/4Y8//8x7b/Bs+/R4TYnGKzGanC6nFCNtXdvcgrRef+sTJy8eP7jzWsp7+uqtxYuvfenkM59ee3zrd33f07/wOvKXbj/z3htvvHHiv/j7P7jza2/c6vrkVl8hcLvMY6JhMaUTcKKX51SknKEIkQrMouKhaFKhAfIobHGVoK0ITVfb8FXHRzNrIvVZHFh3mnzJPx59r3IWs/WqcsBdDSbVYO7BNC4barZsU4jkQ9Gs1kRywmEdg3fugPDgeBGRxTAWwAeIUADRVrRIWRZdumv63XHyyeqGS/w7kFMzGbNz/OCxbS9OvHpy29IfaB73OfVYmjvUwpUMHAAccH+UHtWfamu6dip/LeNo/OL8IRPuNrMzxJvhy/MZLMXwa/Hk06hiWA1zDgTIZk0MDusTYZclZ7HAvv6JWZ/VDW/nbc/MjIVJVccQAx8tOkJgNv/+ANHRBlV1+DcyqkKfZW1Sr24nuqzTOmS1ru85BACoIgeiubqcwQRA1UZXTncxq0IwU0dnXIhQx9gBpJTJ855EiUmlRLq7L3wVQ9enwRPY3N98iI4aWHqLNoSASB7LQcxERew6SDEsBOuzTarK0Lo+P7Y5AYC7h+20Dq7EcBCdGWeTetm2IcRpHZRLbl4WaXPvltouFulTYi51mAgkKxVujg0GkGfCVZz+bgCR2Ux9a60qAgYIkcLQ75fZz+kIzUwN3qB8jjBzsW2/gfEI0i5Ujyrro7jpCQm39g4f39191LOdHC69fHuHvrY5WW3Vxwf4jWFVm+rcmJPjhYuGuoTzlA+Xy7bDdqhKzeDxUmmrS3itRwBoJrVzEwfDrxKmOqsEgOumqpvNyo66s5Y6Xtm7o8PV9FSZZwA4hkztAno7WC4PaXJte30jpGFROss9Cnwwb194ajfEsDf3Sboy6H/5H/+hF7/rB/b/zl++/ZnfAICv38tP3Nj4+Hvf8cQTa+4ho9U0ko11HDmYZIqXGMe71QzXEert9a1rs+vp2rMni5sv/4Ofufn6vPuR9+jz3/Xi7/7WF//aX/kb3zU/5tk6ABxk/cCV6nvfvfkzXz68urGGgz/MMvnws5CIDRSgnBLMXNTjw7nBRCLJ/VANiNFTrzGPYTeIDsieLVnmBu0ju6DPksXRxmL66ntXM0NAp+swYghl11lVIRD2WQy0ihWYIRCBJskiOm0a36uX7D1EQuyTeAfU5xxDSFnWJnUTaf94ESOn1CcBZvrmvWMRRaTIUMfQn5z8eLtRz6hDHZtuj6+DYVBRWm8jV6Ec5/5A+znIEaT38uxGtbbqTFCGqCgwxDL0OYWqPjdN9fL9sF0ckW5xNcNwccr6al58uN7yyl4C/MwbYexADhYn06r+an/803U6MauIHD3zDMIqcJJi4yVZln1fVxUMpSWLZ1yMXHhGpDz45WbROlASVTUnSBaT5rJomxigoVgeiKcuMxRCqGIwg7ZLVeDACFxltazi0djJLMTAZmFobMUbXuYu62gixsyoGogohjyYyRTpwOCLIINXM2guSMWQSBeY/KUGDrMJM5qoiZr53/Wi64sWAEdqu66ugmvNYgjurIeExVSJKImBOaHLmrpu+z7lorwVs8BMYLOmWnTJzDhQZSyiOBhKi0EInHIRYxcmAbjj8vB6AAgpiXo6oFnRLnlrP4qhGNGQzPLZfe+bjVXPDAj1cleVsbI77P7NB0c7739672yg9KWNuV+/iM+M5T54IFHq+6OTpYtOJamjLgDQdjCW9Y0gPTWVtjRxo75Gl20rdrC/2FwW/gxOmollm862ZvUDu9U1M6zjjTXrADqAw6XUiwfHQ8KGdQkAHpws+z4DwGa7ONRqbXl4POgvnOk53QhX1iZrmyGHjbHlP6MHmzXvfXLj4HhxMG+3Zs1LX7/1Bz60+eJ3fK+99NMntw7+83/6xre9cOVHvuux2bUbQGtxc+pOMtj2lg/drsY7dy/iF+u73+L3emu/fnV7uv6h3yZfO/n1W3//5Yd/aOPltXu3/43f921/92/+0vvfoVtDGu+/8d6Nn/3y4Unbb69NsmpgypJdf+5uMVmYaXD1Ihq3tw6eeAgkDwwBjJGxKFGLImkYpY4JkGCnPGJVRSBFE4HRQrA0KwMQ1Ka8Ngnf9vzj//Irt93qwE2GxUzUhuhTINDt9SkAHC56txFPWT0M05t9kRRCVC0ZhETUJ8lZmGPbpz7rxqTushwvOod3AtPBsv/uqvlEfGxuOSABQCZslE/b6tQBwCxORujcmS1zK15LHppxuUlR31UhAkAV4kVMximMt9rjLap2ptPSyjkhDpEQvjh/OAF6YrKx7DsHfGrgQrQ22xvAnL8rey8vU2D2TyEGclboqD4NQGoya+o6Bp8IqLpNLnV9Ho0oTnvBUTUSuM+5jkHNDJE4qAIj8FiODB0Sc1IgEwZENAiMkSlwABUH9kU1S+EgqtjKrAVArY7BUaCBuV/IIczMzJjzqaE5ABG6AQarW9Sor+huR0GIJQrV4WlvUxCrWOigbtnly0CXBREbZmAOhK5+yCk/OFlOJ5M6hC5nVa1izCJgRlVQBWbcmDYpS5LMBXKDKsQkyoRZkRGRg2gSkSrGFapVYdY4zk5wOo0ZareNXb3r/tQKIZKQCEkNcsEeuYxh3+rStLjVwKpJ5JvwZPxyA+Pn9xfbVxu4/1uHZU6L+yuvfrPsoYYQi1UkvamhWRHcNwAAzfiAo0mjy/a4tw1KrpWCdqEk2GZchMx4FB9sTSZ31uq1jSUApKPFXt8DHAyDVDtYLr2IA8BDAID5kbTKxeV1LrbEsFkzADxMs/7kuKqnu3Gew8a1IDqbck0HR/Kh53Z3t2afevkuABwcHPxv/9An/tQnt/Z/6q8AwM+/dPTM4zvf/0O/bevqjtvI4MZ2PtrnB1+V7rRt9/J9adu+2ryfXteTxTFcfyr+Lt78td/o/8FnD38XwBrA+//g73j49z61da188R99YudH33vw9748ZyYz48BdKnQuj5MnMFFBJET00DswULRAJV0+DKMqUcWcMQQZ+nocw8BGw14vxEQ47IR9V7u6BwXDQZypbcovPL7xf/+ffeylNw7/+edvXtnkLMqEvSlZ0VsxoYgRh8NFn7I0dTQ1AciSq1A7dOIFIAIgkqF5MqeZJpFJ05iVXOYqsDKlMmu1Zdv+aF6fbcS5Jm+6j/rWncI6EBBZ9N3W9LQxLySZbgEAcwQmHNVGYwvmdbw2Ago1xbmmR1FlHpwczS0/Xq2PNjWjy6Oq3dTlx5odMDvN4x4+xk7SgfRbsfpqf/yToTNDl3Yh4qRuGCCbqZpIChyJcNJMl20ahtzo+zMRJaKkgzMjgqqKaGRCQieYjt+XqqEmo1iAFDBGzEkDsx8LdeQs6gwOUatiSFkDERJmMSbP0SQxy6ouOEhiXd/XMUiWYRN5ygHt+17NYoxjk3HWcUEhBBcT4bCW+yaiqoKIVgE9OIkC91mzahUoBkpZDSmJpVxqDRPXsUhPuz73WaoYTTNRCMwZYNF3pjZrmpLSTqwKVeQuaTYNozbAjIgsJzcnqCN3vVWB+qyM6HGtXrhFMnPwL7pP2XnD46y1MBBUE6p3NiNPhsDUjJkJ3EIH9G3MVJsW74De8Gp3Njr10ssGxP6NDAAvPL99b3/5OMdbckmo0/79dqeZrd7inf7JWUcxOjjuDo67dtFvBNsI9sRmWJ/F9Vl8YjOM//yu8d9RxqO8wtgXe6OlI+UNkg0SALA+6bI7PmkP9pf7+3sH+4dH9/eO7u8dn3QyX57+S60kk8G9h+R0jZuLzcUWbW4V3E6yOzq0LnVHh7dP8HApe+38wWEHAJ/94qsAcPPuoWckvfsd1/7cX/mv6V2fAIB/8DM38Ylrf/5/8f3Xru6sEGD2AUCuPM+zLZ7GsHGFrz3u/34TTgmppnzbuY/f8aHdx9cnf+sz909uHXznY9PdHfr6vTw27z/40Xc0ZF3KMtRKVTe8Lm5zvh0flUfZVrKSnGG2enatRKeu0ufPtfA2XkYFOXMgYuYQKJC2Xd+n/GOfeOf/+Cc+8tFnm3/yq694nwsIWc0UAmFgqgP1ufgELbqkamCAhJLFD30nPKacmlgNoksQLPmoYpiz1FUEA9+hMFFTRQQ47tK7I/3I2lMdiNdfRwCK7j/LQvMR6QiYuK3uweLE2/Yl6MeqnUvsv4YiWofK1wyv3USnxiJuI/OGLGYYplVdZrYrK8TLyz0A2K2nHt96jnKzJx0ANMh/V/aOslREhujgRmAaE653tzfL5+l8EkZEENW2T0Tkg2g2rULwVVnUJlVAwjyY/TITIIjZ+iT+2d/xLajJBZ4lQMMsBj86ENQQsUtiBqLqAeUGlsRUkxiKoZh5Sp+ZZVVTQUQDj7dFZxaOauYSqwsQmIsHpCuN3KPYl+fhCBzxHEK3wcGsFsifBBDMmVleI72yB+ZJFQJzFchnK2bQZ5k0FREt25zEIuOkCtOqDswuVe7zKYGqCuR7o7QyHium8MPXnMR8QuB2OoSESKOTgJpWMV5swNUAiSpi5+/rYAw1IJ5ur1cwKHl7nBlP3ZO3ke64SxWddPv3SyW8JelxPu04J4cnk8OT8d7Vy2qtX9uc+L+wtV6vz2JRgQJgPa1JRkeXUZ8KAMfzM2uI1/ejzNJnAFtWII1xDBvDr4/2NwdLBeh4SF3wK5La42wccSzux1CDGEANYnsLAYAT5fUaAOCwS5vDBsK61HWHt+sIcHy4lF975fB977zxpdcLULN35843fvavPz7/0htf3sMnrv3B3/dt7b1DrmO1eyO7KdjQuedF4mnMW4+Vg/ONrzjk8rbIPHVs1q+cvHE3bHDY4O/40O6tX1z+/EtHn4RfAIBbx8vdnRkAPDw8/FCg9+xWLx/00xqXCYvSR902QIlIzFBVhiqMaqLiecQEoCO5BbGEnJ0SYuCcI1hBcsYUY3RyAeqAzgPAfNkCwAuPb/z7P/TcD7/YPDyCf/Vq+9nXF9NBttyPSmMkN9O2wSevqqOfyqJWh0INNLUmRLcSHLxlRgebnLJJaSpxUPpZDNT3/Z/qZ7P1MNdixtvntBGbYvQIcKs9phC8U3Ze46LvjkhBYI4wASqjzgFkcLR9HL2+yRzVAZkZhmfWdoolmSPyZgCwNHG0HQAKIOMkSDN/MZryBpC37QEDEHng1PqkMVW3YgcAzclUgdgpLm4hN6kYAT2PEIeVZhQlhMCQRczhOwXEQEhkOctX91NT150oAyCCymhLqcSUUo5EGdEXXDELoFXgRZciV8XuAiCJViG4b2KfRc1QxFPuHLc7Zy3ntv8xxj4lW1EOioh7Uq7asIBZjBEQmKjPisG/UwMkRiwheVSS5WMgADiNfUNYtqmuKjQUVSRquy5OG1VgxEkd/coYNey2OYzIjCKUxCKBlWAmw8EdszRzqqYqA5g+VnZC6lNPiO6PBADEbKr+mGkTF73AioikqKwIvUsbqf0XHWZuYFzNUN1q0JEZn6mO49NLsMThrpfeOHzh+e2xvq8+5lb/SGBnrO9X6QgA7utGuHZlc6zmnfJY07Gejj8nxQNg0SrYsoNAXtyrvtsItt/DImeAcNDj9lSPmaYoR4obabko09c0lzDjBQBwLJSb4pwAMDonuFjRnRNSiACwPotbs3ptfbJZR6wvKbvd0WErCAC37z4AQJmf/OEffdfmq//8q1/e+yffPPjotz597/7eY48/m7ceg43tMHTu+MZXRDJyGG3c+cFXU7t8VGXXlC4ja26HjQcAoOHGIex/8gOP//yv3/rmXsad+sX3//ZX/uXPP7dWDt4PPjX5zO29ab1RBex65+Y6vGnmOTFDr12UIO4sZjZURAQkRMginq+E4wFXig6pZnDUXpUH5YFrPRwcRbS2zWL2jt3ZH/meZ3/vJ555nOPDvf3djfal1/HBUbezseand5ZcMZVGDzEGVNWULQZ0bxkmVDNitmF6CwiqklSaEN3bQAGXfddUNZipCgF3fXJtLiF0otcr/G682knyFEOPUgpEHZSQ63uQPxRWvOeytCaa0gz4AaQP11u+DJzB01fkRecYkKdsbbO9fjG3/K7J9gzDQK1R95icIL8yP5gAPdGsX+oi6fuJ62Hys3b3qJWmrvwziCEQgvrnj2BgbhhXcGrVnPO0qUTURct924uhmTG67Y8GpkXbM5HoKDUrc5FFl37qV1+vAkmWuo5iFhk7Gcg5ZpEpqzUxgIGommpGIrXAAQCYANSyngJ37gYTmRkBsEjhZIjucnKU993FnB0ghCBZzAphRlVd0ZZXXMdSFgCOjAGoS7mKgdFEQTy9FVELLb1ARv59oW8WASL7M4NHApy0/bSqiFw4Ba5HFQVG6FICoGkVVCEQGVqfpYrBAJi4SxnwzH4XABgJCVUIV8hlIYScT8Xe6lJaRABY9KIi7q02RlQSorv62CMUTAetXQd0esxqfW8bu90WNdNbwu5PaPjG7b1w9OQlfcnm2vZKF3/Zb88AQGAGADvOPOmU7ayMCOupdYtmUncKfsWtaBqAlmAC0CqsAxzPrQGgCW4vW8sGAJatBQBm6O0YCFoBgCnK3nHPjzAdk5QXxlOU8QF1xc0kNgQ767Pd7Xpjc6Oqp5cKnQ67NGtw3uUTrbrDh3/1L/7Y93/v+2//7f/H33/54aHS9rPP7L7nPXmo6WFj2+69gg/vOdTOs608OLnL4u327GcAte1n2v1vjP/59DtmP/2luz/2+7/7yd/24S99+lMP9/LuDh1kfc+1KcPe/cPjzfUpDmQyQE+4NnK/OwAwOHUsGvwd3dXOvRxspXjZSgamqXgyjpn5uxDVUXDhD160+fpW88d/8IN//Aee3p2ta7e/n8P6xtVZyLe/fDeJujxERFPO07q0AN4ngllKXTOZ1DE8sTO9d7A4bsvyY8UDAZnJ/I+aOVeBid3YzL0tfYjrqbD7x4t/18ITzfqxpJCl5nhbFg2eVvmv9seu0u68bcmSCT06cg7io04VrZFHh6+RBAmI/rMDOW85gPCwX+51i6eaje04GdH88fGqdqT53fXGOSepsQ1c9N1WrO7k5U/H5ERhAwghTOsootNpvWxTGXci+YTWwERtY9aYWcq2WHZuEd73qQolpNQXeFHts2TRGIonZVaP+qT1igFACIce3Mo2HymSHy4FN88KSFAFEgHD4WFAKfd1jFUkSea6o8BsKn0+Q+EgA7XC+14l5or3N0TEOML0K6KeYgqSc2ZkIkLjPuWNWdP2WUWACgF0UoVIiISqur0xA4C940XfZ1djoWFdx5SS401FZoWn5lfERWSXc+4IPKuAAQXKJ6Oq73lq597B4o29k1DXATGr1lVQ9bWn7DNoEKmGEMy0itFUejk9v0RETNFK8HwJTzADBN8BIJPjeW8HbBmL/mOPbtvHi+tUL4XazxX6izdun+Oa22VF02/0Fr4ZNuztsmsmdTOpO+WmWwBAsx4BYF0BNtcAwJbdiZ52He2iOMYUx7L+9FOYogCAV3OdTK6QAgSc1A2dsiqrqrqyNhkb9qqentOyVvX0cNlWoUp9rzlBFZbHh/q1X/rmXn79qP/3/uKfePb973WEvbype6/IvVun/zlS70/uvwUggxEsXQrOaLhRTCEODzcBDpfwM//4V77tC19+ah1+/WuHv31n++GefuBK9Tvfu/3TX3g4WmaaGULZ3I2NUtasngknqnRqt80EvZwnfKzqSweuh6iVTFQa6QoACNqn/G9+57v+qz/9ycfWSRZJUwJa264AAOLm9I29N5yGLym3fY/IgMMUlpARO7W4YqK0d9IF5hXPGjMwMIhMfRZGcEKkL1eMUMVwvOgiS4wVmGW1jaC/p73uklQAmFs+kP656RZkqTm+MT9AyU/wtOZYMJksfU7HqZ1hmAN48R1L+bnPpZiXgWTVGZ35Tpcmd/KSQnAC5XmPI6P9tNygcKNaO289hloDO4jfIH8+H35FUhgOmI2mrmPIol7ZAUAlM0enh6QkkYtQuU0ZzEJgYiQnoQfOXVIzLgu+cWQ44zqLovaOa+sA8JXXHsRYqRqY1lU0dYlmGbn7FmGUQ4MqEhOBmi37noiqQCLaqYUQmKBLeQTZYUi1zipE5CwRj8Q4dZUBiGhjzl+fs28TVTXnnojqOqpkUSOCLKKqyzaZKSAukwDAZDBlNzUiOpovvXx72+57gAoJIIpIHYInfqAZIwBxFoloYliHwJBTzilnIqpjBDM0JAIFuHewOOmy71pscD/tUnLSy+l2HIwA3TvZVPLqN+40TaQsmUjHSBB3mxmon0REb8578eb9ImfmzS+/KZ3qm19CqzAC7pc0p5N69brjNjUJTOqx3x9/t7mysb0K1q/HAWxZeUK6/PndxmBkytdB15tS2ddl0Q05UKst/G6cfw3A4zgAYH0SbvRf/ZWf7V45kf/4r/zvrzyxvVrZw8HdfPRglKHyNJZcjoO7/eHiLdr2yyq7dMmDO3Tv9U2AtLn58PDwfVfWXrpz8m1PbGwCbFUVAIQdAoA18mkq+7AUEVPWUV86VAT1hkVMeRQ3DpZGo2Z10C4NTFuDEFANshjiadUnRNFsYsuUf+wT7/wb/9HvtXzYLSEMpCCexm4JGDbvPnhAQ5hnDDFG83GWnwhZtEu5iiSmXcpffn0/qzXFY8aNpSSEmHNCI8YSiaBqXGzrCQDqwMTkgOzBsv+x4/CejZ3SlQc+6hbXw8SvdzkdaO9+AKeuMiCLvpsBzy0DwlOb2272cs4azE9Lh+zHW1ab90Xfac7PrO1cKmgCgDt5ucXV6coxLBj+DO4vtui7n7ITIYxoolDFWNfRzEM7nbSakkBT0wh2E+Oyz4BGCHUVEaCXYiaTszhSQYhE2GatKGCxdwMkFIVJxd+8dwwAMVY+JfexYRW4Iu6zRKbsVm5EjGDKSd1/BkShS0JUIkuzKCMwQckPISbTMRVaV4hY4+piWI49LoEnZoRqxr5BVHXrsUDkQ1r/MAMhkIekMwAExiwy2sX4KzeXwkkJC/NMQQZ0oWksvpIghoxoaGxoWJhJVR0rAH82z38XM1AEpAfHC9UxGTgjkMoZM/fhvDv9fpNIsX0vLPhy+zAOUQeo1AyslHVVeZPiPlrKrHLemxaXoNNHQO0jC951qvv32xevr79l//4Wxf3Ssn6u5p523MNvLXL2Ev+WSwIANJc91bmLl/VRA8WzgOH006kXD9Y2Jw/T7Pyrj6ETBICk8O6ntt77+Po/3I//zl/4wz419Z8OvFg+HN0FNKUQrvjt/cPbYyL2I0v8Izr31cuVTXp4CGsRXVKwFeig7wFmzsSuc09MgObTmOKGUVV91409OHGht/OKxNQd2xVk7KWHu0qaETEBoA7nVdGCI6KZirUp/4kfeN//9c//kL/9egIAURYpYxy1xoaNV3ZDjIFSFrWEoWIkAFj2WVQJIyMGoh6zVzE85T5zUmHkgTLhjRgQojsaiigHVjVUEwJJ3e/jx06xdNXStnvvrB2YzYB3uPaRZifJkW4fpV4PzWqvDQirrtwdKmSBwK5dWoXdO5A7efl4sz4GcZw/IfuTI83vmeycqqJWtgUdiDMgf6G7/88pM5LzMtandZ+kzTKtgqm1KYva+rQW0bqO0ufAJEmqwKLqMjFmAtGVVEWsKKQsgSiGEs43InCMBZ8JhO4J6R8yr1CFkniTPkB5hOx5cmYiEkJgLBYuLuqRVJw+/TApG0fJIhJjLNnTImN9H/M6fH+QRDNpNPNOxWOpCcnM6ip6IF8V2D00HFInAn9JpqKqMVQjo1dEArOIiUld1HPKRGImYswoYlqcdUjEwDRwAFMAigyMVZvy2CAxAhMnEARkNApRReG8z9cgOCU0NVNDz1lFUhXA4kLjQ6xTRxoDVTUEQhoWAKQBnPnXuayKmEad6l47zxvbsH9J2ZltbhVK4eHBWxX3s4V4tYNerbZlTt3352rxpZe+k6pmpzC+nUee+yt10KlMXIha1dMOprtx7q36yeGy5+m6LLrpFYD5RgMAULNFgq+9+uC/+/y1P/nv/+nyxsbK/uCrsHYVwybAg/OT0of33tbH/4jKLl2artcnewONaXPz1VsLAPjpL939Mz/xA9/6TP3qv/jZZx+fAsBHb2z8t19atF1mZm8EPH53JYB+dO0YJoAlCpVVlQwH28VTBuRIcxQr3PVTfqTqSdcDwP/6R979X/z4x9rjwxUYLvnPjBEALB++/vAkII/Z2VlKmlJhlRGpmReVXJxD8mpfAwABGUbZioGpEjIzqQ3W18PluE3fXTUfqq+M7r5Hqd1aMSBqTc5V1T3pNGVnZ/Rkz023znmK9TlNq5VjOHBWvahdcoJ8cQe77HIzLTYu4KEdlPSPRd9tKKnmf4DzpNYwqlkMwdu5OpB7jQWmmgkM1EBERXXRpfVJXVeh7bMbmmc1Va2rKFqClBAgBtYsNEjaTltpcz4fZLWmCiLad6nPUlfRCimQu9PqBh4q3SfNqlXkKnBScEqOR2CLKKHFEFLOa5OKsTppWzHNfQ51GI9AZlbVnLWqghWc+nQ0jaPHgJWWwg3lI1MwWyalAjTB0PIreoIKkpltrk0OT5bLLnnYdmQEwEKsYnKvBTT0Y3wFfwQ38gXVKlASMwMRGQ3/x7QpBOLAogCqMXDKujps14HLWFzc3SRMPSesqLFgcB/2dWU8ZnBI90IAM+U3pUKeG6uOhJm3oLpTuC706Zfu7TSzUac6MmF0Nn24OOKatji/dec+2gZcWs3P99dnSzAAnDP7neSTZVirKqiDwopJ7+aK9PZw9RQ6fYyenehGB9m9rJ+hcILl8FgDsLV5df3kAQBMp9Putbvf88En/vif/ANe0EPBh0pll2Yb7n3xFCtvJnnrsXBwt2+XjyLDvAXPvVsJDNrgfCQD/NoAHL98X/qXvvDB973/rx4ce3FfizhjSgCM6uz1Ikb14MrR+U/VTyQ1cInTgKqbU9xILQRGxFWd6jkIPjAu2v63PXfl93zs2g99+3MP58eP3G1sbN+7v//Fb96rqpBFGdF5kFUMWU1Ep5OqTxKYIxW/hDyg0W4iwsyArncPZk6DE1WNJdYAivxqyNnp+/5H+1m9TnPSoOZj0rFtBwBNeQ4yg+A0RIduKAZouznIuUQkQPQ6PjJqHEU+X+4B5poOpH+62TgzPGTydD1PSV1oft905wx2b1YjA4LjQhTDr6fDX6SSWo7ukMwkKbvBLBNWgSWLk9B9dVyf1IFJRFOWaR3NPIocEIAJQ+Cuz84dzWbBC4ooB7YhSwusKCdzLvszlzj5N8JEgUm0cKvMoEsZUH29UYDVKYhbd3mIIyJ3fa6rUAc+WbYcfJMAw4zcQXB1WcaZUROiiqorGdFGaBERu5S9ZV6fVIeLnohS0hhI1PwDmi+7EMLRfOkfsORcDdtlp9B4tUw5D47BZdbqPX7F5H5qqsRoWUAAA4GZVQHBQLICYS9SIzJhmxUAiZGEkuZIYVg4aQD/jdTPOHe/CSXmAIEQdRxcjRarrtQzNf+UHOZfuYzeYRcvnt1xjvX4SJ3qzfsv3dhZ8WU5XOHpFeutjRWLrUtNIsPa+uQta9lqHT+XW+23jHdpmNYwxiTN4Gzl9lejOY7Xj4brfmWQyKa1NcuBASBDOSFH67Ex2YPmC8C4vT7ZP17+wIev/5//8p9afVX5aB9ufhGuPS7NNj/4qqyQGuO1x6Hd7x/evugxAIMl5Kp32JtUdqdCArx+CDOZ33r+2e0vPTzcrtvDI/3sT37qNN8WgCINgdh6ToIEYw4DnvKNXZK08hBDM1qx6nWm4+pcExEj28kyfeJ97/jv/tL3YXt+1+bJgnvt3N2F3vnUEgDaTogrdwrOkmOsfQBQVyEQneTew/EEDERrRq6iihGC+XBJTA3QQ7tVfW/udaftk0ekmikTLVOakH13fbWTFAD2pDvo+y2uaqNOEjB1UgD3LSqfWybUtmwUXoHuu+PGOaC8z2lKwU1eF5r9OCtt+0qzdrA42YpVUOvCKZg+Tk071L1ucT00M4qlVV8t8QDuL9Yg/03bPxJpYlCDpq6qECYVp6yu4xW1lHpDrpgAoEsZEetIhVeumrMwU0mkKwC9rLByjIjQbDqtF21P5GkXYAahLFrGNFBmzQDI0ABPs/rcEX7aVItFN51U+0cLBYhMYu5GWZjafUqE7FHmfSo5eSEEx2G85/AkDXdGJKLVvIex1BZ0XoRCYEQByFIW8qSAgKqQRXydoyowYgyhipzV+iR15C47eQzKUF7BAOuK3fGEGKN/taZmJgpZs0foySDbriLnlGOI5QslFDVVzcYMFEiJ0f2zHWYcTVJ9oLpqEUNU0lbJh0lO9h/ahhijC00CB2Z23wV528a/LlUFvLysr954pHkDoqTusEunFsRDHIc2U5lnt946bqZdJkdTqoO8Wo29Soc3L+iXFvGLD1t98Hozu2SvsbLIXHp9vLK2OfFXdS2U4/4wnFl+xuSmwzC5usn7Bw8++vTmf/af/MkRhxkrO197HK89x/dekcWpLQxfe1yabbj5RS/ovqN41CKqGSjACMpfDpmt121mGNxunpzVv3Jr+dmbJxtN87Wbhx94F+Q93WiaOuBRnxooR5josAM+jfKyMojEU4dVXFEn0WDrOIyFzjBnPCW17eRHv+0d/7c//31XWB6u1HSXLN+8++CVg3zz1oP7x2l9Fj94/fZs62qGwihAM0Q2M+/VmCmrqmrkFTfHJLXZyGs0M5E0qStfZLokdWQVKZHWkZNoHODeg5Pl75xMbuB6l3uvlXDWa3eh2QWo3ne7IUFpvS2HDXmCV+KZAPzBsMKUXyW5l9004n6/OCK9jnwRchlJMoVW79Sjcwwcs0XfuU3YL5KwoS9ma5NKRI8WiRBETcwIoM1Wx5IO6ik/7kY7OjcAgCgwABjk0hWCqKUsxAERVKFLmQbVbnRrCjVvEwFAJBGFUAV/Ku9DiVwXASFQ12ck6koiZvD23btsQmRCFcxqZhaZVMVx+fKtu47fzFVLZYCvGkMYQ9V9UExmzD741/GDioGJsM+6aHsA6nJmZkfhnQhPjiYWsjlVEbs+u3+SIdaBu5QZKTBnyYGJmBhRjJadFCUBjAo+f4W+m9E+4zifiCH4DBaJPVXKFdeqmgUMCHBYwPGMQ6Qb6qmpY2IxBCkCbR2S+FAkkxEiqYiKvj4NTy/eLjJz29JjWI9H+wiynyv3E6DHfwPSh3IdSmXX5vwg1m+pg9YhULvQlYnmWI1/c8bBFyv+6jbhkShSeGvcw/1uzm0udDal+WIzLw/D5GIU33qNr985/ujTm/+Hv/hjuFLZud2Xe7e8suejfT657zWamwntXpNmOxzc7Qfu48Wybq5vWlUwYTzHgFxt3p0zkw6PAUDmxzuPT7/xCw9+rj78o98+vbY9XZkqo4qmnJnjMANUUyAGGCR8ghgAxGAlcBTONO8rN46AjBtDtl3PiH/h93zkz/7Yt2J78PJKk35ytDju+4PDxVGrSwwjeelQq/u393KGusKhDMm4twAAEcgiTV1DcdEzNRMD51aLG4JTsXTvvLyadUlCYPdfZSJRVRMCUtXfBwhmmTCoTSlcD5PCNOfoZJU5wsxgWtVgkFV16BYfoL643IGZdXmwbkfsU6pCrI3mlvsV3G8Vbfc56vUwmVIoy8CqF41RJ8lp9dtxMtJvVp9hbvmIdArwd2XvCKSJQcymdZnrTpqYs6SsVWD/OamC13pRY3QuIzRDxJVXJYph1XkWAWdN1WdxDKFAE5JLIBxA8MmKw8kUIpOYw8sgojlL5FiAjpKoh32SEDgGAqCUxcyASQurx6MeUQ0CEw6sD79S5qjeknvrSuQeXj2kMb5DxentY88LjJBEagpMZGjLrmciZlQVx5FylhBCVk0pTerat7ExhD7lugoB0cyYqc9GBKIghtETThUIYdaERZeZcZxMpZzBeFJHMWMwUOvULoTuqiEaIAKFwKpZTcsaPrRR/o7otJsq1yRnpwwAkYJ5526jv9hlbftBa1sNPAqZgUc7zKw2756nenK8rLfrsY4/6vKojL1S3C9tycfe/tLLmfZc3qKmr5bsc9Y2q/e+SZTUZl5CgMMwWa8HUKKmu/eWb9x+8Of/zB+RZg3OVvawcSU32+ON1c4VJ7ZLsz0yZN5sgDoaigXQBG9JldFwQ+ZfBICDrJsAzzwe3rXbvGMnXF3DvKdhh/KeDqdB8MjjEV0ZzrfCNoOVUNPxzLGhnwJQJ8wQwugi2aYMAM9cXfujv+NbvvO5nX/2T//VHdOD++3BvAMAXMxtOsPFfIkBVni+DcH6NByXGSQRkSRB5OBEBTU/x9zZo+uFCQXQ5R4qWlWhz+YV3E93EQ2BiSgEYICsiiZO4FOVeZeuTsN39tc7TmE4mqsVQlQn6Ti1gLAem8GC8cwk6ulmQ9UK+R2gDhUAONLSr+yrTpsgMyLcaxcAsF1NV3M/xrO4Q33QzheDcGkw9V05cwj7Pm0o3cnLnwwdC4oIEjcx2NmUbWee4DC3YOYsxXW8z8IeYIu4TANPZuAXipnL8Qv9EcH9CYiYvdCbCQ31yqBY+buBAZUdEq58XOPsL2eLgVXVs6v7lCNzNuhFK6ZetA5sJUx3zAvTGKOpqmFgHmK9fGRKzFzCw0TFLHro3OCJBsht13njDAZVCFKafWTCnIUIwf1nYnRiOyBWAfrs2B2EyChqrACgxGN1UckxBBeToSGRSfa8dyzOXwYG0KkF9lRxQLCchDj48Mq3vMsuVyGYyKD+M/CcMFBA/2apeECq1DEAUtv3tCI78LL+diwhz7EhAWCrwRZMOlus5Mo5CfJi877V4N3j+e52fWnb/napkBeHoo9q0lc79LFwr2Lll1b2px+7sn21tDmjmdmj3IrH5n11OjyOhrfBAKwP29szu3uQX/mNV/9XP/EHrz/31CqfHduerz3u0tNycFx5Phzc9cr+dhgybuz+9qes0qXpJPFsXebH7hf2+Bofp/7XfqN/eLj8lsnaJsBDgBaMVxgmgwNM8emFgf7mZtk0JCjZaTKyIoJhsUBRgJySb5MfW6++9Zn19z+7G5YH/+TTtw5p4jW9xdBMapvOAMCmM1ieSakd+/cQQBw+t0JOX5maSoiRvdEzQwLVlAUwUp9yIDLTNmtTRxUjwkCkqh7rzAMaIFmaup7Plx+h+kZdMBknxkyp7qAYpo+71OsDCjejCNO1g8XJV3WxTdU6R09cKj2O2ZRCzXEk3gzHbTXuspcmZY56IfrDG/y5pgPpphxW0aGS9QFQAy81OybzN+zmUStNDKIaoyeVIiEeL7qKyV0/szpgZXUV3V9zFCIRUVZbb8LRIiFRnwUBq8g5i2++Fl3yh5nBILYEz6wFxLLieEZcMW920B1oQH5XElqAEVNGUXF+zsBcxazqk3MrnBBClHPiOG9XS9wgABRBNQJiDEFl5K+UIYFTekzF7RZGb7tAgMgp50AoRo4dAUBkBKBln5moIrcLxT7nj7/7ia+89rDt1dNOIqMLcdGwy7IW4iC7BkZUYsk9hxAZPT01ZS1RSqaMRExZNKdUhcCrzXhx6TAFG42OASjnRMyq6nVbi+V18QAak2Wx2Gfqb6HUOtt9DMs+B85cfPBy3r1l2+4PeGRAdt/35+gxF8t66dPfNqPzUTjMWOXhPjhicK5hf/qxKzqb7k712vYEAOZ6lvNweAAA2zMDgH/xmV///X/4965Wdm73AQCefres1Hq/3d3BuN3HtofZFs+2zvTp+dBBeQdh4jR2y2jzexDWVoGXgtFfWvTDWtxcf3h4uBWIZ+tPXT08Olns7hDcgd0dAoCjtl0uxQglZ58FOdVMTRG4xAiocSBV9cKhdmr8OyiZPLlNl10CgBvbkye2Z++8Fh7fnDmp9JvZptX6FGCRs01nzSAqbs+W9YbASAHgeJGrqmpCMBUMwUBFMTCMaSFgmFNSxhi47XviAIaeQS9gYRhL1jEc59Zrx0DWL3lmZfAl2vfp/bsb1IJjMgvNzSoIjuhDS8dkxi7bw7LvQvfd8eo4/2xNKoow6DtWT4+yFRjSlF6ZH3gWRwnJ85TtVer64mQO8nTccHym5ngOcHcAbdF3//00c1fqXSHJqAVCJVRzn4aS0eHBW+z0Qw8tCuysGAqRKANAxZRF2yzByzQZ02kK89CkKwDDSJYdevMqhj4rExQjLQMslPDS+Gc1A/cyRH+Iy/37LCPzhIgioRikbFyUoDj+Le/lhx0AimdxYJnHeqA7ZHHcxtWxYpD7HEIwg6xuQQNMuBRBiiRZrfjDqGJAmE6qk2WnCoYoWZLo/vFy2YvnfnD5NtEMupwDhypgn0eiL5iZgE3K+YJJIavFlTQtESOELNrlzIi+74whLFNfhRiY+pyLkY6pG2E6+8UAxLRovhQYqRCRzJDYfSLpzPf0FpeLhMglqAPrY9t+ccp6A+Ovzbs3f+ZTGssjFoDg7PWxvl8KxRy389VA6gV3kGtaHOr08rSEoxzH+r7XzrfhVHiy6le5tjnZaWZezZ2ZP6POmq2tQPUKQtMNQM7BtNz6N//6z/zQ7/udz3zgQ9Afjy6PTnkMKzXd4XWv7OHg7vLWTY6dLBPPtsfQ1HPEGIoRw2Z9teoAqF94WpM/RlPSlM5RZYYacLK70baBHHZ/z9rsMycLAHhqVpaHLx6noyyRCQYzVY9yPxWUks/EDBGdDWmqnapzhNlduoAQtBfbmsQf/Nann97hqqr6vnc9wUWZmNf0c5V9tcSPwgUpnR2LauuZJKpg6ty7LBoIEblPGhgisYBPrhRNIsPRvDUbYx+cAg9n4/8ghvCR+6AzO1+IR6qi9gAFk3HUe79fLPrOb9+ppx2oYzKacuBTd/VVjvxUC3OGmI7z8Is5QeBTDszYNPXdgXQzPNO2w0pe66hK/R/k3jePu0hopkgUA4v4Rl5VcoiVqAFaDBzdizEwItQxrJ7/genoZClZqkGFr6JcBVEVNRyENqV+iWCZf4zYrlcYOJovN9cmfTZJWkXn15N6PQUrQV4EmiWLEgc0c1+XGEIVqAdwJyyxgrCPgMyoTQ2RQEvC16rvo0tni2FZYHUo/1RzhaOtnZjlnJu6ZqKaWcy6LmtnVSQiBMMsioVLjp3kKsSXvvFAzNaaqrxPhGEQyllVzJihRha1yChZKy6e92aQc3ZAZrTnzSIxIBsDoFrxBANm58yAFaHW6uB97O4ZaTDVUck5xkoBTVVNCQfEf+VXLmU9Ni1eRGaaFm9DAoQNiG/evG9TJffym2PjfvL2PWxS7/X9HIYT1gvT/C02GmP6Hc+Cc3GAApxFV1Zxm1O45nC537Rj5z4279vQzDa3LlTz80wbDJvNYA54HcCa6v/4V//+Cx/7tvd/4jvyg5vuBRbaPl95fhQucbsPJ/fbe4e4vhnWN8PBXZkfWI3Ntc323iGEWub7MImS6oH2Pq12rrjVjDTbsLEtR/vNet/vpWCpP1yc698fBbvzLMn8GAC8Z3/11mItlq//+KQFAEc4nNieRXBFwaSqznG34bgxMwISOPUnQFDgkNvld7x798Un64f7Xd8tXSa2qhpb5Hyupl9s3sskg3oAYNCk6vlQ7iUfBnpMZOg78TkkE0p2i4RStwNBXTfMtHd04lw054eYb3gRRS0QiaRsuBH06TxxEqRX9tGStzZa5A7M5ghPDYImz1OdVvXn25PHoJ4gjwnal59OJg0yhNNY+pvtkQ9su7CiX1253MlLAKAQSkcfGAAH1RJ4fdeUj0j/bt1TVwocMyOgz+2Ol92sqTQLBza1RUqBiAmduQiMfRYmQsSuz46vCI40DXSvlREKY0AicmQckTCQqZlBDDQ6nyBCU0UVqxhVC6vddxJZLTJ1KTMCwbCL8sF4lkDIBF2f+uwG+l7QZVWMxlR2Wimbt+mDPWQp9MW2aJBAZzMa8WuDwa20rGQQQsq5CgygqBpjTH0PITBAUvVAPlELCE1V+UEuKQemrAaIKWkVCRGrgBUUtVBYCeLl0X0eYdrEPhsSOr/LZdspDwHxxanenBVJIOamCqrM7FnY4xJqpZ03EzndN49Gfi5kettt+6Muq+DMpYT3LYhPHck4U31LEegqheZM5/6b0+/M85vcdQz5HM3eURev6Q62lH651PTZW4hD8yGGzeFXqr/2//onz737ud/9B37A0Ri794pDMQEgH+3bK5+BRUrdviwTANgxPLx1j/LtjWc+AGtXse25Xsh8HwBkmSDUpV5bykcPcB5o9xq3+3Bwl5tK5gdch9LU5xMAkAwjUHO+B1yenZwEUm5en3fv3d18uKe7O9SWcRo740XPpin5FtwIfUbqroFo5oQt3zD6oZT7tLNev/D4loeG+/fqNb3vxMu6z05XhceXVvZmUmsz3dTcVPFkKVmDNzI0eIxEJpexGKgAAUBdVSl1KkxEgGXGm7MEDiOx0+l9njXsvD0A6EVuCDzdbMCjLfTmIDMDT8ceC+sC8lds8e9OnlI1QOgkOXpzsevRlKtp42V6gvzFkweuRx0L+ujuOwpWNefXOX+AZ6em8CvBHUS4t1wAwOfz4cs5BWYDA8R62B5pFtflf/i5jS+8sThZdgCQAarA7haw6BISbzZh2Yvz0LMaI4raaIs/9KdkXJSf1dD+k6cy2Wlz6cPVoRBjXQXnOyKiR5YDEw/FMQYWLTo3p65mcURZCnvbVAzACZEGWQSRDWScHDqb/jRI3YOcQnBTsFHNREyehGFqMbC71mSRgbZbEP9JIBVOIsSByRtk5EAlKpaQCcvmD4CIqkhc8gm0xAEgev9RBZ7WoetzL1ZHnzkXLKjt+0umaFQM9QKVyDMmBFXHWBztYiIm7EUJEBAVFIkYMTkMO2JURCDiKBa+TYwaIiDcvoyU8ahO5fQBOT+nfPhWRpLLsFZf1p0H+P/rZVPz2sb06ceuDCPTsNPMxm7dCdfjS8LtCZysFvrzPfuZKt9U/5+/8Q+eeOb5sbL7+LSYO978Mhw9cHhCUg2h9qKse3cVICnWjq1fAFXc/0tTgpTs3i2H1KvdG7R7DU7uywK4jqewTT5Zre/OiVwcn5abg6xe3AHgaw/b9+5uAsCrtxa/8BtL1+N5dJcOIiaXOyOAgQYsNPYxPrg0EsU0RolC3y6//d2bY6s+VvaxYffZ6c5QgBb5rTXKUwZVUJWRUI/F0jrLwPJ1HiSYIrIMlklJVEU9+FskAVXeWwGCmbrzOxgz0bztvmMRZhuhg+TSpEDkJjCQZfQvNw6jj6OPMT/X7t/A6KFINcd97Q6036mnF9t2imHUKB1rOtL8obUr3dkjfqzsi77b6xZupLlTnxJpxnXFR6l73YJC+Ck5EbCIoIYhcNmtGzDh2qRWtbsHy5SFiM7Fg3hnuuxFBm/CQAgEWTRlZXSNDDJhEvUJnsfszdvezKMKUbWsrIEwZUVCRPRevm970dOcIBq47UXuD8UpKBAxWZtERDyTCxEDIg+GlO74aABZyjdbYMPsdHvMMvDu3QR4oLr7fBJECU91WFA8W0BUVZXJrTFRsxBRyjkqTqvK5bvmHNuSCAjztp9NCvfHP7Fln1W1ckNgBDOoY3j66tobe4uuz+iJg2Ypq6n15vskMitaKv/pJpRVZALzSAEB1GG0MBKeANHx/BWvURx4okQ0GgUrAIhppBAuszEfUzt+yxeH4K8DfWPvEHavPZKyOA1EPYA4yf0iryY4zPKv81JW0Zi1kHwouuq85zj7OYbMTjPbv98OZJjb9wFmm1vT6WSs8u515SXemuqnfuqfh913jJWd2/32ld843v9Gs/1MAyBHD5zo0h8eXdL+Hx8qmUn2HvzNYRaZ70szoeYarF2FxS3pkjfm00m6hO2eT3wQ0B4/kBWh/9aESGgE3L953DngbkgyCMEL3wCRS8TS0MVnwdO5ZGkTCW25bG9sT97/7O64IztToy/zZZuGsMjZu/hHge+7u5NXDo5NYWWEhmqmxdFJwJAZRX1IiMtOA1tA7DxXQt34kNWEObYpuwrf64tP4Uxt6/oGtQgCmXB09fL6Ptfs/fho7RKaAD34KPWDvsYH7kAXfUchNMijodjpRsQxmSwQ+Oby6Plq/dz49CIg8zrnZ2l6ccp62rab3cntp4OSkbgOkzkwqUoS5RBDQAF45UGrBpMqmIGpCpQEVCa3RAQRlcEzQMz6LIEpZYk+6DPrUw5MTOWz8pGsqpoaI3r2IQyc9zjsDJYZYvEhMG+cfQyYxOKY94FkYFXgk7ZXhbpiMxNAUatVDZCYwXA0Ol9VVaiZ5iyqIuLzfzNrU3bu5BkjrgGQkdMOF0kJ0OoYUpYskgTWmgagKEVdpitmCOR2jn1KIdCqeM8nGV2WKgQv9z7seWNv0fY5q8XAhVFK5BbEk0ndJ1EDWxGLKBgZdL3UFQev7CKEnlZLMuxCxog+Hdxj1HwBcG2T/2fh0njimOtY307zfhvSRZbkqhnkxUb+BsZXL9uIXJQyvRkV8l+/so/wC0DYa+c7wyj1TX6x3NvOAcCaGQA8XBztTg8Wm1uzk24Fujls1jdf/fo33jiZ/Kk/97sdYZf5wd7r9wFg/6iBozvPbhZVen94dNpclyt3S8lul+f4LavNuxfrkQkj7RIe3qMaNZ1pzMf+fbGMU4A3vnkHALZ3tinfvvNa8ra9fJ3T+rX7Baz/yp05ANR1bQADl9bRzGBgBMWoy0ARKGXhCxs+otCnRAjf956ymznXtl+6oVut+BcrOy7mALO1jenmZJlkzyDgAMjYAEeWTSi4bawRRo8A5cCFsjC0+ZF43qXKcgi4WPaisY5cGigERvzIfYB18BFlg1wEpeHUShcAtrgqtbVHL8G3Lf2I09uB9tMSADaULsUopxTcDv52d7zF1Sqx/Rz9cb9faM4AsK/9B+JmIcmcReS9bQfEz9nJUZYqBDPxUQQTMkZiQyi+zVUIWdWx72KerCZZ2LM4tAhzBqQYXVUQnYHqPl9DZlufchVOSetEWHwFsJQ2dxXtstaBJhXL0HSX41aViRhNDALi4JNuiBg4ZMhmYI4mIy76XPRLgyLaD0tV9abb2wsH67wjcdiOEYVKZy1ZfHYaYnTyPq7YVTJzm8XDlVLWlFMgQsA+yaJLRBRDYFQENDVilpydFVMxDqEcFpnd6NddFsZ5tQ77IV8yDYA5oGFgNjN138iSdYCKppKDUHAnSLPppDKDZZ+9DTfLpUwP+QpOYMhqKhYCqGpwoGxIETU7lez+Fjgzlx7Dq/a/GxD3u+4tMZk3KfTBC/Rb4um/qcubl/Vz/ftpCZsvHsIU4GD85dlmvQB4HODTn3rpk5/8uN17Jb3xTdATWSbKDzTccF3oatk9rdphDQBo58nFzZfX8gnU2+f67jenrgOAtOdtZPw5eba9/8Zr914tf/reoE3dCuT1/SDrWsPLpE6C/Fd388h54KE/MkRmGoBOP8UKD8FbuFPaMmgW61P+offvvnCtOVw5nMYh6ljQvZqPlX2R88Wy3ip0vSxnNQCcHC2uNEmlnMunYhZ3NHMDDRUDyklV3SwlBIDeYKT3jOM4AEDVj3zL9Tf2FvtHx3WszDQr7bJ+IG4+7BbtQDzPw8E3ylCNw8aQsut+XndyewPjOscySu07AKBYPMXGNqeMUgFqjmPux+WV3ajDktdxpHlD4yod8xwiD2YU469KX6Ad1xSB+mbKTQXcWaGqAhm2XaF/eJH16Kws5qlaFZdsVS/6ZiaGYKqKXAUXtY4TaSjiU9hYm3R9ylmKU7yaKlSRaoA2SXGYwdGpcDy6CA16tYCetkFHy15NYwhMlMWcmQ5Eg8GhRcIuS+9udESEGGMEM0/DGLLWjZnETIaQbkbkISQ6p2Qcil+xWknMRep6iYGrwDlnAGYE15uuNdWiz11KdRE0ac24FJwv28ChU6irwigdJUhd1kDujA1mwIiD4V4RbyNhlozEiEgrwx1CUEMiylKs8ImKDpaJBqsyA1SXLxFRYR7DQOT3ZY8UhEa+kJkR05OLy3Wq1+EtkJlRqjryIM8RIt2EAH7bb70Oh3Nt+KMmqJuazxEfT8nsp237b6KUv/3LraP5ydHi+v4dvLbukPpiCRBuAMD1p+Kd11J/eFRtbpwCMislfjpJurZ+YbexfWlBv6Ti55PpBBbLOJ0knm2v1np5tNsiAGz25av95dvHd4973ybbEHNqhXNWBjXeLGHAnISHRGwafI7alFX0E++58q0vXD989DZtFV73su63vMlktcsEBDvrMxcT0mDJ4iZlMJAlzIgQkdkf44nPomYmWWxSVz43a0LssvjGdVbTHmCXZH1aL1NaF2uQF333VV1cD43n1q8i1EekGxDOYdanmMxQ2WFwpHEGZGviC0M1bWoMzpApTmSXAjKIe93CLYYear9LlcugztX3gsgDHGn+n2ZACzIVT+vGIZtIJNVVXUq5FKJ0Sr17S3iABjN5ow2nwSolIFfNIqEAEWLbpVM1svukqBEhEx2dLAsByT0jETsTRgaiQOqtNA7IgFOtTM1LkjetzrgdPYRhyOUY9TiMWAfKasuui8zRPTkQzaw/ix+eP4m8vjNJFgNwD+GIAYq5wYq9gqnTeZs6SpZicmAWyhFV4HsAmFQhZVl2fRVjIHIe0aJNk4giNq24E/XW20u2DAFM4vbLjuQUlgsO6L8hltdAblaKRoBdSuzzB3cKRiyQujP3TUdBFhEQuBJbA5OWOEwF/E0A6+eQGX+pLlU94zpwtoUHgYf7netUlytgw5vwI88U96nUCy5nzqpFDC0OAUCnm9A46rJ5rkC//fb8kfuI2XR3qgBwIEE6pfmCaxpJmaMn/d2DfHzSAUB7fBhilPk+QAQAyrc13AC4uTjuqk04xdPHTyGfQFgLGw8Wy7i5FdPJ4lGV/U16+fb4wXT9iv+W4+yXU90Hnow372HQLv3U1ztvqXzBH5OYVBXRmIaTh9AtsEevRyLKqrlPW5P4ne954n1PTvoLlf0iLHNugjo28gWfmZT6nkJczruT42Vfc1XzNGInUjvrbQjGZABxUqNZHbnN5Wgm5qyG4NQM6LNUgQUg5cTERPS537g7qXlnY+3e/nHbdZ3iU6GuLC76rie7Hibga8CQqgEAmvMpJXEFFn9uuuU8mbG4r7LjYQhsCmrAcLs/AYAb1doY2XFe9AFyIL1L1ZjxfdMd8EjuMUY19wvNi76bW36Cpz8j9+4vckByTMY7tTZl1UwUqsDLPqMJA4lIFVgECCEQxZp8QCpmOGxxfL7aqzASqAGjLxdmKwC02bSpjuZtTcGgmEGOZHMfxPTZxnwSHELVR3TC3RGwwDUmCjGQKbZJxJShCMwKB8bMENuUFm0fkMNIBBr8qIv6QXo1wMCiWtCYodY7LpGzNhVBjGBmampKp4zPErRhZotlHwIHhK2N6f7RXMyYislACJyyGhgRrU/qrLZ/slyf1nUMx8t+mXR9EvOKN5yqqoGKMrEqOPTDPr5SHRgJZWdiBeMKvqnRFYq6lK0P9H1u6sqlp4SUTHh4C+rvyUluDISYXdVV3v4leRVbDV7M1VtFZm7SOsYJAAEAAElEQVRb2hgo8L4HHSv7KvK+1eBXbt6/dTi1ZYeTdlWkgvW0pvMCl3Pm7WGs7K5OOgXQd3dXOu7NS9vw32x998f78rB9tZltbsyoA4BrIyIKcG+/vLf54YHX9265WF+rAWB+697mje2Rd+j5pVc2aX9vf/3K2qXCUcgnzfoVgKQpcR3PgTNw1gWsNO9hDQYYZ7GMY2U/ffx8Px0erxJjVnkyXt83ASaR/tZXj+8e94wIRFlVckbEscojIofABA7detJYCeUAbLt+I/An3r/7wuNba+uXVPa3ibxPQ/BG3jv35bw7Udrfb29CuNUfbgTDOJ00YbkQl7+vqlqQSE1NlUPNompgZpJzYQePAP2KgzGaVDUr0GLZNVWcd32b0vuvXg3HdkRaZZxWdVYNZzmRc8tP8XSExX2SuU3VhIKKrmYthaIFGGI9AHy+up+WX+6OPrZ2rcxpLyAt3v572/5qXuxCNaM413S6XTBbVTYdkf6q9cN4kANjFgWmJgaPShXRKrDkAlgzoQj0opMqiCghFs64CCpWoeDjKjadhGXbgiETSRYxZAJwS2ciNwqGU3+zwf8dfW0ro9q2FwQQQ5GSSKcKagBIWYQHsxoxS1lFzRcnETFCBmdGirvH5KwAEKtT8ar3IMXOCH1gTjCiMXaapKpQcgjEPNKo5ECJKiH5LSISmGZN5VhWm/Ji2YmCRx25/YYU5ZESKCDXVcgKD4/mO+uz7VmTVV0owIgi6llX3fEyiRIT2hmrl8CcRby/zpIDB5/u4mnLP/KPzaWqN7amLzy1+88++2qIJaXLoS4syHs51EMIbgq/MvSF16f4Jq6Qb5PqfrHEj6Knr3+znW+AiQIkZKqGtxppCQBNVYphU69iKnYKy6xORJ25uEpIB4C51vPDg6+/9hBW7F8ehbqMFfzNS/+BhBnAXOvpoDv1Qrm5VgrlYrEc6unpd+fd92njlm/DzpPbFzzWz9X3R/HTz/Xsp837iOqs11yvnUNvxtXl4Z5uXaODrFuBnM+++kaWSX/263MA4MBMpAAxBOc++naPBye/PA5RB8mJmL1jd/YDH7qyNav7Tk6Ol28SaOXI+1jBz2w7ll0LXatwPHf3fGw7Pm77LmGX+4fzHgCaOi2TmSogMbMM4QxqhoOdR5+LjMarOBn46ey7kKwGJkwMaMSh73smVFUzjIF6oY/cB2jgSLOH5J1W9izekr+C3VNnOYtuOeAfyDhxHa2A3eedYnCUZj8tf6XfezpMZhhWNavnwBn/W5rzEaSPV7tgNlZ2Z8FPqnqq+WDZUQg3dfmL5FsXJWYEZ4hTXUcYrF3QzAOnVEWUAZELzUNVhYgRKTCNk2dVa2Lok4ih/2ly/0MDA3QUok/FQ9F37iPCA2ppsAh2AyIAiIxjTpOqMQEVdQKlrC7sDESByb1uAFhUBRQGTwJVTSI8MCC9KRYRHJCT7KNUP2KLgsF4CIoJMUDKItmtCACRwUKgRT/oOK2gOszcJQlMZnne9oFDVgUQz3IS0c21uk1c2nO1jUlsIiGC+/YkUbcfFVNGzL5QmEmWwCGGkLIAo7jve8HZlYgCEyLmAQ8Y2C0rGUxIJ21+9c5+wbKKyoFW6Aw0qDiKA6rfQo+GZS7F3C8iMxenqWOJ9ys3MAL0XToNaOsgwIrvGCxPG7vqLG0HmcLHrl/DnbUtzqNeFAA2A51VEumMOoDd0fnrUmRmr53vNLM3AdZX77K9kze8FB4eOAizWLEfAICtjRkAHITZEwBf9DoOAPkKrCh3vXmfThLk9MgKPtw+smLeHHBffcClD97f2y8VfOcMFLO18qHxbL0LFcCcEasYA7N3J1lUVE39sCuRTHl17C7axPDxb9n6znftvHlX/qh7i+uAwvE8tYu+FTvKnNT60TBG/NxmF7J0SQnNmy/GksJTtrd+whO1XfZxq7PivMgTkTiRGSArBEYOoeuzWnHWZrQMtNvQ0+3ED9aCyZztVg60fwzqBnmsxd6q79RTVXO/gYuYjAMyI+y+BfG56ZY7DVyKyWTVI1JQ/Cb0ALBbT5cm51jw9RA6tKH0a/HkqHWejAZmn4tGpmWbPHvk9EhWNQxuHZvNQI0Dd1kZrAqQVT1mNqzEzPomCBAFQMw82gkMPNOjzzipOJcZqU+2oanjYtn5mBLMmsgAkMTMDA3VIBAauDMwiZkzY4JbvnlKVAy57Q2BAdUnpACEp22vrVyxYV/m1Pgw8HmISEVGG04z81TVru+buinNiigXxAm9X85qlUEdo6iIAhKgGeOp0L9N/VRrZuqTAEAVeWyxuy51WRCxIjYABnSqKDGDWV2FrJZFz8njFExVY4yImhVNBxqPGRS6OppaBkXE4zYfLtrAYYBlTkcgHnfssNjgEGziVpJvA3MfbQaYUNQucmbGOr5a1sfJ6vjrFUEPETQB4WoBPFMNxlmI9AABFMLzH3h2pTDNVvU4Y7XaCkRVA9twrqMH2D6rSzp7uf8W71w6BYCHQFzTwd7JFuc5wLVtOGi2HlsnDJuWD7eW84VD/wB3XkvXnj3/xqbrNUC9SmAvaDvAmzfsZ5rx4259pY57rb98Mcgn5yg6B1lfvbXYaBqera/OWrcwOyt5VCqpOWcWENHnP0y27IUB3vvkpm+yrs3sqWtr3rCfg1/eXMnWLkuHfpSx7aDtU1LrkvUKpr2X8joSAHiVrwiQqdS3Kh4skooQlyCR05PcZ0pDGMiIyNsKSR8RvWLnlJmQkLSEEmO2fFXhepi0JhsUplW9WtwdWplbnp3hfeLNxdFjUDsm8ygVn6bs9Z1iOJD+fc2OOw1kVSC8SAzoc3JM5ivp4AfilUd9kq0JIB5o/+sr+QGFl0KDhSeiqCbRpoqFUG3ocqEAJmqoVkdWyV0yYgyIwMHt752WzkwuYkAttHenqEcmYaqZRE0VmIGZVCwpNB7wVlx9oApkgxOkoYFBtkGRD6BioxOAw95ZDVI2ADTXk6IORr7VwIAcR4gw2BGHEAIHd7rV4kZ62tW6UfV4SPgvyrC5IFQ1dGF/9F0DATOnnGpGMQ2EWRSJTWRW113KIspMG7PJYtl1SRddvz6te9EqBkRQcVMEymopi5vCuzUpgwmoDOR7JARRHw6bwiTyosulvgsMxr3FKs0MmIApDK5kJV1wtNoux8DgyaFmZU16e9jLBvi7ByZcFdUV2P3C4b1KfmfCJxd2MgNkqkGAqRMYxx4OUhVyqp16hgME37mErUCPmg2eOZeq6W6M+awPTrC0O1vXlPao8VA3b/wBANsDXwlWq//DBdF8scp99LGqdOreYdPpxAAWi+WrCwCYv7F3cpCOXn+1nR/c1/BhgJvDEPWR7fnIQweA6fp5VH21Sfcb49r0+MHJI1H7C8tAe/xgFWTn2frDV/dPkj37OAFA3FwfSz9NaoDjuo7D2GlENcp81a/3bffxd+9+57t2Vm0ixsp+jux4rmdfren35jgUdB0r+AgZezU3URzkLRgns5r6pACwFmnvqO36Pk4axHJAi3gSvLsABtXTdtUHSiLi54+T1fIQnQyIhFZY0lmequuphDv9svBYBpKiQysH0s0Rrq2ytsyO3GB9AMHP0RkBYJFPb/xyd3Q9NAWQCRzULrbtY9U+Tm3b2NOxcOfPQTc+caUQXs2LTweFDCJChIxINLAm3QOAXN+vTgdkBDVyO5cwmO+EECGnQMFDscffTiJjKwcAdcVdkklN4+wOmAKTeaUt4bqyWGhxp0V0zX2Scc5hATEbiEoM7N1lHUgMu5wZLRAioZhVTK1P9bFUdge+IxXbuJFLcxrSXXgmPDB+ismMjkv+pUuvmbhBDaA5xRPBDPo+T6p60sRI8OBo6QtRFbiuY9slImLEK2vx5rIztGkdTc0deHzcioBEaAAxsFs3MFOXsgA6xD8yZEy1rqouZ0N1MruD7D7pHUe+LsWwohZAQiLGLOLBsOMkSVUDBx32NmekrZdNUw/a03t5hfh/Dpk5gsRUbUE8R4Icr1fqrgwU64mfqqMk1qGa0c94GIV3AIAYAcDQwuHJ3iAXoos9+2od98rujz/PMYN2u2oAQMdfXCsa1e1qsT+EpV3bhnv7ulrrT7GO++3DxRHA0YPDLuSj2yc4zyeLQ+37/mDeTUOgfPv6U0UpulhGx0aeeGIN4LyxzhtvnAxN/fVzGMs5aH5x3G1tbuzv7afD44t2vud6dtejPjxqAJID7rs7JPPjLz08fO/u5u7mJgx5TAdZdwFmjDEwU9Hr+ziLaYxlMCY6WrTrTXjx8dnoD3OxiK+27W4gc65JP277XuEUmPN5C5zKSbygVwS9gomaChK7P2o12KSuT+u9o4VNlNBUi7O8uQBmjFsDkJxtiGTyup9VJxw9NsRzol3cOKlDl7KoPnUk9Ub0yWcnyS1/8/Da5iB3obsemhFyOZa00LwRG8dkVnGYQNTBSghqykekd6H7WHPNee4d6LnK7pzLrHog/RZVX9D5s1213sRl6i+Fbpy38xVbzKUwQwCRqJj9IiAQmtvMiqkKhhAD/f9Y+7NmybLsTAxba+29zzk+3SEiMjNyikJWATWi0A2ghaaBDaORD+BglEQ90GR805tM/0G/gXrrBz2IMpOZaBJFmiSjEd1sM0kmtBoDgSYaKFQhC1WZlVNEZMZwB7/ufs7Ze62lh7XP9uPDvRFZgFtmmN973Y+P59trf+tb38csRKi81f8ZZBA5MWOHQYSuqn7weQe00FH0bmREpWR2Y9s+EzMATKf1etPleXotYkSxMlRBHQKDIgIIO3LmSkOAIpIgk2wuN4QTADRVlVhEGQEQnSNkzf6IGdxHfaDcYB9ALbcKBnf1BCAsBpQOs/jHmL2YUu2d+dRHTkbjpMTLGC0NVTgxwKaNOiQV/O3jS+fIrCcBNLHk6Nc+Be8codVKlirT9skR1SDdsFMxuY73nu076b2KgTXJaGx1RECxaXZyaoEimQdy0QgMm5VsO6MCgAxqGfBHde57kscxxBszU/iZIog8mq06Jf8u+08Ix6dqxv3ypVXnkYcr1EcpsOU//OkFAJy/sVkP0/9Ha/lSs5/O71G/xet8lOt0cdICAPTtbS/yvGqkmlq/dL3efPHy5vLFlwDw5Aavry7NCWv71EcW82ez+hdfXb+4fv/+SSv+bcPWeLUMp4vjD3Tv/KuPPy1/3QP0AtlhPr345CkAPP3084eP3hsQJGRdzf7yFSBdtMvn8Soa8fJ4ufn2B+/8f/7y8VlVffuD871ND6+WpyS1D2UQSQFthtsKH0TsYvQAv/urJ3tKpj2Iv61IXyXj/6Tf1bwa3wIAwedlr3wt+s2mPyaQbZDPF9NnV6vE4B11MSK64hViwg8r68yYOAetqSozEm3aCIgxxhqRhq36ctVayfObWHccryU98iENNbvxJJfSrxBOIJwIeVEgqJU+ai8BYIa+3HKscIfEHeQ27LSqf9pe/AN/amV77asx227EvVkdXK5vgOCa5H/k7n8V3pRbqnvr3F5L+lPoWDWQuT+iEboIpKAxcSDKe3kkROgTE+Kmi5F54WpB6HuuK0RAVgguz9PY6c0KoDle1SG2Mc2byg1YD4yqidCJKCEAYW/KWue7PgGiYNb/mbg7idZ++xYF5/ukOnTCE7Nhc/7sEFm0mLMjoidI4ACUbWrVmBbmVOAM0fL2UFVGGXSqCrgN7zVagHMniZjNKl0cUQJoqmDKfVUSEEDYRIkxheABOOs9ELrIidO0aWwlcIjrGGuPCA5BI0vwDgFBgRUdqsnPjUxiRU9ohvWI2EUp/WoT0SMAgmImZHAo24FwGGJVLa52CNAEn0RlEBRkEwLMtxaVQD5xukMtY66/e5X7mJkxB4JDzcxhJBP3qV5wao9zs37YO9kVO9kN8b01RV9+trr3rD1/o4G3376NqBlTNKfVFACozy8rI/sxQN+2W6nBm5dfXWwu2b94/OWHX1y9uOjG/rT3FrOqdgbrR5P/msWD9cbkiTUAfPjp5+9+48j81nRRv7i6Qtf+yvybW0eBY3Ka+yftFz/66xcv5eEjOJ7CgWGbsefnTz97wqulmy1+/lWaB/zpxxeXff+f/KNfOfrasfZGWZjyDARFpI/Rh+AAEnPf9f/Bb7737TeqrQ59l0bvxG0265s+aFxbkQ4AyzbuAXQp0seYvrfO51v6WnnTHcP3KlBw1PV9NWvyFBUAOCeSndmtNoexqdlAXnJmbGjTtmbh3fa9sLjgHeI5Vc/b1clBVWKEe086kZ2n+qlsHvkJ7AZkj5VuRRlZtPBWsO9NpVrBXvmw7rtrkhOhfyM3Zw1+0y3yBoLoQMHVA8DHsvrJgmhNAKC4I5xAQLFsDuuNs1j8rLAQwrypVMUh+RC6mGqfmRZHZP4wrGqj/c6RTauZpUGfpPLkEHuVIRoXRMGWBU9ozB6rgCAMZlhlN2BUfmR2iKBaBb/prbMrOLQHVdV7tMY4IqoFkI6Ck0pDVQZyBgr5YN6QIkKkxrPsDjc57zgmI+7MFVJVgRyrVt6BTaU6Z1aRDlE4eueD8zzoiNTmbxX7mOrgNY8OgRqPgmgSz7ryzAKjCTtWjYkRwDuaVL6NgsXGbPg+6GCXNFIwbpkZc2kfFi0JjrzziaXI4XHwZCVAfe0MpqOCmUrwUDOzAblP1biPuqeGhJOvbS9sQO/HssWLZy3Ak/XIZj3Xs/1aqulRlDfGpmD9+GaXSS7aS5NRlrDmL2765ToVegEAsJ6WKcq9TKjyy4b2B0fD6eKTnz87MrgE4OqA9+pncoLO882tGlRD859/lX5ys/on987Hvxxt2+L4isUtwdXVj19c/cavnX/6yer3fu187lY3PNudgF3wanmq1ATIeXMAjqRre4dIAF2MXdf/k+892EP28rY8b7eA3vYbAMjWfVTjbpHeA2XfYroV08cIHhONW5oNcqvOrpzNJ8+uVmezSVEKWxCEeYplB9fdUcViX8wiNunedb2Nz9hEzATgEU0+l/6Rmx52RG1bOlO0In2mtNLEoo+mJx3KOCCbgjcdJAzxTACwjO13m5Mx/XK0Hl/33QkQAHyo69+K87oKK02HyG6czA3Bx6G/2OSoOQfgyzALgIqYMWSfEiLWlU8s3lEUCd6Zbh0AHAh47JLZJTrn8jynJ+ySDpI+5aTB+2kTluueBQDVoerABSVJTig4EpHs/mi+0Ia0iMo8DsX1jlJiVnBCniiymZUPZimIKalxawN5lJ3YCcl4tiw0LHVGcS3PZgKAAKhQBvFUjQbfAXoWzu4DACpiLgIM4BQcAmLecATv+iQ52NqGsYkq5xJz6qLdK3jfx9y0mFbuuhUzpc5zjqI50xqxHnT9SKpiy1B2P/JEnI35drJPx9ezwJfQ55KGusglKNwIm8HRnlQFEAX0NedT92gZR/i2hHGOxzXEUt8cjWRyN6s0m8PXv/g9keLFs/bi2dPzNxqAjaF8rsEHKN+b2RkzNlabG5q/WNPli2eG5tSur6QqDLLxDFPvy8DkTsfMS5eolO0G9+MZepstOr93/o0H1W2v6q35G2/tRiwd59ABAOCvvuqni/q4/cCBAufFS3m83JxVVXop84D3T09vbhErWlIHah6x6DphESVqN21w9E++9+B/8ujUNi4vlytLNB1pXTKgK9VG9wZCCE2D3OoEuk0Y/JHzM44tBHqdzzv4uotSEVSBGlveG04AvgNjZtoYHbmYknMuMYNxtcYX446ZTNbCW2i9KYJU0Vk7wTmiNsZvVc7KFPON6VM0br1P8ZoEBBzhTLZo8unm2hHOKHTA/SgcdWwCYyX/pfSL0Lw7OdlIGk857RXvL7v1JXdnrv4cegD4jXBqQnsTPu9YIMQWVC8h/XUfN2BiPhxVtQJAolz50LOZapE5/XaR62CMgTJASlx5hwouqBX4XS9IzpxsbU7VkJKFyVHbRbv3lvGw+RrMsdFEhJrTnBEgsQTnQBUJkmgAUtDEggQs6j3C4Kq/8203dgJJVUTECHfNQ/bCKqiWveesYjUEtc5hjuxwBGXWYWir6rBSkCNVRVBHTkURsU/JEXlHfWJV7c3yl6Ua8scGjxqAkU2Ndy6xbLrsOUMUVptuOqk9GYsVTybVJmJMiZwHMVN4D8rknB0QPYkKJ64rn73aARiRBsGPKYVyQ6IM0w7bU1aAPulATGUfDnsTnFFVVJL5js+mjnqqJokpyN6TVoKFk9lSr6TWVj1CflD1vk+f/TJjUuCtbN8Tp5tJ78Wzp/kB3mi+gs2b5+1WhD7qvmJ7uZL6i5c3Lx5/uVebl+lYq7qMUx53CKcLX0rXPcGf+SdY0NQha0Hpydm9uzJKzu+d75Xht8H3+wsf5lMbj6IQjtTvexuuvv+9Xzv/q09WP/zGjFfLyyT3T49M8J40jQNhFYfURl53nUe619D77z/41pu+IXh8tSpoDgBtH0uFPmqb9FBPrLJupg0AwHrVNBUApxq83VEdhOb1P/JCytt9PbAdpwo0bcJy0zVNbbN5nohFSliPG8B9m7W2J/UtgznD5RstXGMqOAsAU6oNi0+ELoe6JjdLU/+pbM6GBatVvk0ECQBfQfqd5t5mOB/8sTPN+qiAeE3ycVqVpm7Gd0J7JnZfu+WF9KwaYeSaO5yZBEDk6iAsAEQsahmEqozgrZb3jhLn0X8QdY7IO1FNzFGziUkVnCqAKKCiKhBF1uDAk410YhQGcA4EkVRECWmHDIM+pcp7AMccI2gVPLDEpAgQkyZMItnQ3EaK2lj8O5UQyZbtcd0DCISBEBEjKzNnEx1Em2nyzuHwBEwRu/PRI6IoDeWFJ0TEJDAIXRjJDdwImw9MF2PlffEgg6LRVvWOEkNKKbjgCX0IbRc9YuUJUTqW4LAXbLuuDr4K3l6sebHb2G0dQvk+imzNEkyoLgCwY145UFIiltKahl5unsJCGPRCr8XGFDP3QrvDYGlpOH4i4XqXmbmQ/owCHEtlOoNANx3cn4632r5hAPAdtOpeUbm/0s/rwuj4AdOtI7pHthQCfYf+Pobae/LtQ7Xf2Ban9uJmHi66H113737jIUAHZaDpqA4SgLv4uPfvLuqjPPshxP/6d9910yAxAAA6v28OvFvm//jF1Xuz+sXL/Ax//lX61ptH3NbcbAFw0QBeRbnsNijy6N70H39r3lAeL/oiV+gpHgsnCvbVC02D3NQMblY7BdCOsZmOPqwptOtVg5yGZe62rsstmm7XIENXig6+f7L47KuXRf5lZjNlErV4AvMADeUMt8FCcz8pYyAi8q5Ua0zfrU+SSIOu8sH4E9OQrzQBglm0J5Fe0oX0v1GfWoRm4WTG40sGx1/w+mForMA/1MaYgUGHcrm+EY6AeC3picbvu9l5mJhi0rgp4+VhcCa4cfiE4+dTpI5y9FEWO6MIKUhk7KIHlU1MwZEn7GKqvGOOApRiQgyVd1lS4p0CGAdde2fqeFZltqJVHeDptLI0D0SILJsuNlVQC7EQAIROFFjq4Ao9YuOmCqo2ZUbONgRJmBAEioDPxO8aOdknMjga5RsE75k5MSNlhyPWnKSaaXogVYEhdhHBBK9mcudo5P5vbxECKKAAOgTrJJuSPYmqJHOzcERdz94RDv4HiSV4lwbXGiuikVBYstIf0QcLh9E+SlNnNT+LbAZrM0eggHbAypu+E221cKQOXZd3G0hIiRM5lzccuOPMMyzigDneEpMk1LHZvfFXRIN35yvVMoeCyD3B+22EzJ7koRRzDeattm27txXewV382O9lpz6aTceadFOsf3XxhQH6zy5Xl8/acXl+pLF5J7LvSUHuvmVVu6efvYDv3d+fzjo2prRedi/blavfHuN4uV5+s152cs0A8OitB0Uqc9eg0CbEq+Uy9h+8c/6Hf3thEP+tN/3pCR1lZvw9akFXm81796bff1gvZmG5ij9fIQC0fTos0jOsD3zLHqzf+qlPZze88h0YvtuSfgfEo3S9QDV8uTK+DyvS6ax96ogT02AvY3vYreAXgIot8Oj0BgIVtdA1a17ZEc4ahC5zMmOAbpWvSVYCjvBEqPKhT9EapNn4Nx0v243PUfBHfX0zWBPUYPLHvHB9LCsrgoZFgK2hWvgck9/YvnjpSs8NjEPnlFikruvgKaZI6IINtYsmZk8EhKkkYQ3e6IjQRUks0zqAqogqYmKOLMGjc77r07JNOtR06y6ic0gIAkmzhXIVnAizSuU8i7CKtUC6yIAYHAknVmIAh0DOy5CBNyZ5jI3JhM+wTidmZtbBkTGpuIHDHlSAwiqqmIt4IlCV7E6zLdlBRDOrbuJLRSRhdt6zameTUwAWIWmlemKhweGr5DeVZwyY30QiSKIqXFUBLAcKoHa07mIXk7kFGOfTVEFRHVEdCCzfVsERbpI41MoTC3aczyNyjgAtcWlMwUtulgoAAVHjcNMn61IMX34FESI3GIi8Vk/1GuI5VK+8cXEAPry8K/6TPjYQAMAgvpzv5SzO/Oruie/vv/MWDMOiBc3P32gumXQFL9vV4xdp2a66D6n2slyny1VnRPkdXrLNpB43Ce+YtNwTcQP0ANWeoSWv0mLqP/vy+S9+/CScLs7vnQPAi+vmmeAYu40Wd5Nw8fLiXjOjsKNqH4vc7V6UngjAF5K+OaQAovNUI7fHCXdKz19cXS1C9Yd/e3FWVSdNc/8eudniKLLbkOq9SXj/jZOmhq9W8KkNcxlyBQcAIbZRtBTpBujGt8zd1/ZGHn/ehx8zANgQhKnhe4E+inVft2v+euUbsLZqU1eqSARW67GqRzSpgw76yEK/GliQ3/pcW9lutZj5yRxSK8JxgzIRmja1Qf91v3wLaqvHC/9oQpfCurTKy9g+Gvqot106lMvVDQCcufoLXps+4VGYFp2MHy0G2ZmAYQPyFMS6qaLgnJt43wT47jfeAoA/+fGnADCrAiCQCoFbxaQAiliSP93YxxGocujJgSoPdlQAMK1DcJTMd0zVOzSWZloHEz4iQuL8mh1in3TaBBXtTBZJRv4Ii7Ko944zBUEqDLkqR1BkBR2K0xK8ntdso92cyduBRRxuTbLy2mw+LYiDyW12i3RFQ5J7sFuHSLOATIMffdenljmQy3s+RGVmIkdG0EMSOZlUXUzMUJo39hqVqI+JRSeVV1F0SAh1qEzrOQgoKcauqasseUQUNtGqgjFmwuSdmTo4RFUQUALQrW9lGU2w0Ct7UVbjI4Ig+ijJGhKjxfKXTNEzcoZFT2CfmeGhP3xYwj8E4j61Bh3t4CwzwNQ2A3T3lE81+G8/yPi4knp1JT//7MXN1ebTL+E6hec3m5vl5mjgwx6gtwJF0DJG9rsvp9QDgDTTMs6/mPru2E5g0cw+b796cXX1nVMCOG8WD+D65m/+8qNfP6k3p/N3XJgu6mvkavn8xRfNh59+/p1Bt77XUM0pHF0EgHTNAICr+Ob5RDqlEKhG6fQ2TiZd8xXAH/1F/+s/gO/fP71/j27TjL64uhr/6XIZITQQrEbmLZ6GJmRAh1QzADQHmF677fPp+PhXau5mN/XW5GfvMy4gXhqqAN1472a1PwBAB76D+Wz67GqVsroxm7VaLOfWjniA+HxaKKqI5SMMwjYQtSlIeOiP28ytgAFgplD5YCC7HpzFSil9TWKMfPF/v+R+hv5ePR1L2seEe6nHL7kzLPsIO1B4G8NJaNIuh2O3N05mBXwN8QtKK/PYQqiqAKLrqD/6xfPf++H7/+v/+Df/93/wl57IB0qCpl83Iy3L+RQAFg0OYxJVrYfORPZiIBQBR+IJLbkJyTlUYbCpSxHxlOfiTRlpqRpE2kd2ANPKdzFZMwARzUwiG9oUbSLYxI9LhZzJFM1ArA31u/3NAWreZqFxPYBbu16y/oqq5pk1KJuzUm5bS92B3VcRyKkwgCImTg5p231V9SF4orbrvPen09x9cUQQLbElW9qISB18tV23sE+JFWYeOxYfvEMMjtrEiM7MIRyiQDKAzJO9quZb4AC7ZHG/4Ih0aEgAgCiavbuoVo4YUCTjfhQQRZtmyLF/2VNIbRPDfJfv03hOtWC6o1evCofkjAlm+mpbnJUT+g51XGqdL46PY+r8trzNdiip97SJDW0L+aPIXsZzxqX6xs+tSF9MfUl3vc2HfoP+xUtp7y3nJ08AHsSr5e/9wwf3T9p0tUq/8iuTf/z7E4Av/+QP4mcfffK8f/TD+d1NUZO+PL8SnYXzeqGc0Hn0p7p+vqNtH3EyAPDpJysAeH82NwPIYiZzWLMDQHopkK04A+xJsBu2SCf4+7vM3cDPjGA9pq4i6GNdvgRVoPFM7+liOp1OTk36PoGWsZnizWr27GoVmnqsjSmJ3lvCffCdV7VzilQYkPOQFkCXUpOa85PJStMhtbIyMxLnDWf7FHvSR82JzSgZrAOApNT4icG3qRXv1dOxjcGOFHKAbBtHOqPqUnobBXwL6oL7e+qa0rl9opFtKUNS1BQjAJg08J/9yYf/wT/+zjffffNvfvH43smcEMbEVDHVSonNVs28XIJlZqiiUdKoaJNEzEigwuhc9hEDYNHiB+mG9gYCBjL7AwBV2yIgouVrR06JddQwRFUNPnd3EZEgeyEEn/1/DOVNBuMJkwyOlXldwDybaioR26INXwPmuMv2YBmYYgAUFdayzrZdtJDdYc0nABVm68irahKJfd+js/mP4Mk5co6QIEUwXPZZgWgJqJVlUYGK8y6JoOqkDp5wEzWm5AkSiPOOEyM5U5EqomkinSNmnXjqzVXiQPlue5qt1bJZvecYVSVEQGfLj20vRF6teW8btVKKh4+48O97bVUTRG5jOvZEH75enk3b9apU5Xd312yb7v+rf/6vX1x0psbTTYcDRjd0HNnt93vaxDtg/ZCc2ZFXtGsr3g3ZTQF5FN/vLWY/ubn5Np931827Cwini4/++MnpdQSAd08++/JP/uCri831Fx9fXnXzxpmtzW3SRhe65TK0N8sXV2kV0dWe2w0B8OoSAMiDxCOczPpm+aPnN5cn8s7irtip4jnzR88+dZU3fDc9TFNnQK+d3laG31a2lx/tjuPruW8Oq6QuDZ8rSgdUzyaTsci937UoKGw71bOhQQtTgO+8/+DZ1arveh/8eAdaTukSsGnNVeu7AigQ6qgwdIjfp+MLmKS0AXGEc8m19tO0qWQ7WCQpnVF1TUKjL1WfInl/r552g0py3XdW+O9BtilzAOCTbJYHD31zm2LSOrcXTtugnxNCByoMAFT5gUvhxWL6h3/x8+l0BgDrTTudNJZF5X2VY5AQHYISdomdIyKMzERUEbHZHysgqCNTTKqwNlVgEWZFIgX1A6vD+cZWiSsrgEqJb+5ics4lAE1bEgwGTaoJeCxqqbg3l11Wka4KbO2AoDjzgopkZ6EkYgnQ4L3NqcaULK5k+DYgD96RDgBFLfu7qT0oVN63fc/ZRYfs4Q0l110XU/JE1nggxIg6aZpp5bx3XUwqWk287Te8RRKKWjYsAlYeVZ0OTgI2W2sZIZEBEZEFyVkWKwD2fVQLK0cEByJQeerEQsXzuKntUcDs1FRFxYbMXDaAQhE2JZh5MGw9Jr/OJX+4onfT7ofIfk4VQDpfTGBAnvV63Uy0nLbbGnS9Nliwvbj/y588AQDD9MmsHpfnR9p3dIR1KT3VsfbxDnlMuUzSDQBcSQXrPS6m2pPNLNvVfDH52eMVr5a8Wq7v/eD83vm9d6Zv//oPLl5evLgGuH72EFaT+RvffXT+x3/xVyd3KoSA5vLyb5r54uMffaHTN5STES90eytVrvnqWh7f8H/0vcX9e2St1LFN2M6OzNNHV1f/6hfrt4bAk7ra0Vx9rUvj1AXiKO0I1rfIzqvWFFGxNSrfivQGq2aaOzQ3vEqta5DtBgb9oZ6cLurp9EgX53wxeev85MuLazdSNJsrpHOOiDgJbL0JZNQQI9VcM/YpvT+vfiOedhzh4EwwnUwl299fjwoWK6WvSSzJ2oYxanAfpR33sXXftcoVhEKwWP1eElAvU/+hrm1jexs7lEQupTc5GgB82rOw4BCJRWDOuoCJJ3XFIpX3MXESRRDngnkzVN6xAosmZlWNzDZ9mjhH7nmHCjk3taqcU43SdxEVhCiAiE1gJpsEVQbFQESOVm0si6g1A0u/ulArexdVKUtyuZIBX3Mo6M4abIkZg/FnIWTABmjNBTOllJKtDGU9QQW36z8TU2qqCilPEVuQniOydmWM0b5Cs6Zpgps2VWdkTIK6Iu/drCYAX1fherWxQPAcVahyvpis295cLeOQTwJAzFJ5cg4qF6JwTNonrgIl0S4lGu1FEHFibSHRJrh1ZEvQHsh3zPGqg6W7vQ+G5kUtk63WECxl+3V6qk8ghy4ZLTOeZtrTzBTa/agaUrrVtgibTgHg3oSawcS97QUA7k3mqy4CwMWNdox+XKqPYX1cp++V53coZO6u37fgXVW1FwFvivg96C+pQ7X3pZwPwQPAJ0m+eXpq1jGnAIs3zs2KANINwHwOYAkfd4wjjTurP7lcvvfWu4VYP+JCg4Hb9XQSbwAuk5zX+L35zCzD3Ow4slvZ/l//87+J1WQ2KF45CgC0/LqrfUHwxikAVL7qyDXdyo5gsF72aFnxUgUTwo/qfZ1Op+v1GmDW4irV0HTcqqsC9bE+mzUlJuXw8mvvnj+/XI7hwwiZDD4gmL+GUgQYqgrAYynkv790b5/ML+KmojDmxPsDeL2O7SXERzSBITLbCvZSttfgVhKvJX1vcq+4iZVo7EK7F48wCuFE6A8hv0UnECwB6vCV2uwSID7ReNnqhkaavFKFeLhpU2SYevQe+zTM9WB29WpjKvZSliZa4MC8XLwDVkwiMUZnVgQColx551AjG3OgfYwD/YXCAiwwNqgdiBfDd0v13KL40OIeElJLRyT/xgQz4+U6a2KG3+lgbGsmM4ZlpnNPJrscDayOxC0IZmEGkGJKzM45Y7R08MhLqVcAJGq8X0xrVQiOuj6Bas95k8csL6+j9+76ZtPFVFdeRTdtJIesap6RRqIkEQCqPBIBKpbcjECuarBPqsJADlQFtPI+sahIFE0M3jkAseknHkgY67KOnQncYE6nwxh2fnRVUSUd7vc1K/e7afdriPdv0dW8K/7njNOhNt9KoTdSwvYAoBNXYv9qp/6QT7+NiinlOa5XOp0dIv5r9lFzzZ7AIl/tjq+0LCft7y1mL274dx7R8ytpHz8GAG7Xg8FvmE7yOR/P3ji0eCx4TSEsn99cwax9/PhqA79z30t3ASkWYj2/okVtFA0Pv3/xUh6ekJXtdzVSPP3ZT5787AreeffvjVLvxKFsWsY9WDcpZANQO501qDQ5uk2DYVhpjO93P+L5YvLo7QcfP37mnEPYeoML8+E0h6qCgoIWrsbmxP8dnMNB6ikcTCddx/aSexZ9WE2MfDeFTKHdYTB5fxS2+wxzDIbKHY4vPfSTyodP2+uPQ29TJPfpVi2a+cl8NbQqomhwVKIfEqem9s5VAEkBmYnAAUSz4lLIQ+jB3B8tjWhHeYrBOVWOCUStyQybyGaIb/rxxCJIKjKtw6ZPeTEgtPgh48cndVi1/SjXFEFkF6gt+kp9CA6xT0lHknY17Z4B8WAdU9R825TEwb68DLImZvsocQzlu5/9GO5ZtY9x4txgUwPBU0rJewtLSvNJZUdLIoObGCcbBxOx0CWwFx65cgSE6y55Qka0gVOHOAlmPmq6M+xiRCBrV6hC5dFhQMQ+CTOzCBIWS5g+RkQS5exO4wa7xwzxWfw+To5U3SI74DjSj26r1sscU0HtEwhHCZmxD8ErQKBfHz27D/1VOkZDUz+mXA77pWPEL7+cnJz+cgU7DPYpl/n2mz1SPo81VZXV72YVWdT0nbgff3HzH37/QW5mXl2tl910Agbr680W39F5uKWhahI7C0F9fMP3mhlvoqXx5U3AsAbEm7XV8hcvL04Bfvzi6v3B4eHM04NTen4lRzn3/+ZvL6f3s3ZeaYKyua02fyXznov9gUorXdByg1kDhul6C6Wz9yjNdAbr1SGhf3j59W/c/+LZRexjqMq8H4lYSysD+nZoHooxrJKjpPr+NPxmPDvkZKx8fo5iUhkbVrqG5AhtGSjQfyJk5Ezlw4t29TS1j5qTlaZywGlVH64cdoQ28r9JV5cxmzc9CtOcyj1w97bq9ClKSoD4JXRvY/hTvSmApaCV9y2burofJQMmGFY777I1YGI2YYnpx03ErQMQ2/gPgYJCCN4gGwewUFUCZcCujxZfxCLBBWs51sFS/XL30qCfB+es4roVYzQiRUUYMcaIA7Vi00NEhIVe293BGMp758oB+9iLiAV211XV99FUNPvILvmX5sFr86Vd11dVRYgMqsoANG1qc1lo6mCmNzFx5bLYsgo+tn2eBVO1bVNTB86tY/CEXeJJTaaAZ1HroDoUR9SzJU8ZZ4I2/sWgHrFx1IrUngBozT0AOHKIZH5qw/LDzvucrZqjVLjwMDos4QOUs+1RaCjo4ZaJpEPBzN/x8hDor5ab6fsPdiv3V+z7/R6lflv9XvqoR0HcwPeV+G4Ibta1l4MgryGAyc59i/6yFdhovWrVVq26mn560/6rv3jxu//w/vMruQK4eHkxfXdusD6dRPDzi5dPC81iDIwLHcd6S9RopPSEV8sXL+UXj9P5G42bBI6w3oRy3/N759NJdPM3l88ubCV4DvD5df/e23UhXo4iOwD84d9erNXNplPuVi6QdKsx1O4xM7d1VruDmzVOZw1Wvjos6u/a7tSz8RMw+XwznY1r/zsu337v/o8+/tINqTT7bVXN0UKIg5eqVfAiIvLvL6t7s3otaczJlAam1TKZeBFYSzobbiYxmT1vgfg+xZ/2y4e+MdbFoHla1WZqUXQymUBf3wDA59A/0fgQyAj3IoLsUzQyZ7uQDJzM2xg+n6IVQkooZuFSw7pNAug9OnJd4jjoVTK7PZz8humGvDhYxVi9bF67oopgBjxanjMiEgg5L5G7xGH4pTH1dQhWydr5FbzXAYsxi7EJVPPSMqCzDWpi2UPY8JHIEJGYjXwLyWDcThxcnR1RihEQCQjJGpJb/Uyh1+1dcACsxXQs/5tSQiJlmdYVOU8EKZoFBSYRM0lG5eADIDrC+aTixH1iVgFwMLgLr/vknENA55wJe5i18tSxiETnKhYJjjaCk8r5IfwEEJjlZDYB6JIIAuqAvsx5DkARCcyURlWKmbEFTukg5B9tHLONu9ngkMmChb82cJeEliyYgbBnHHn3nGph28f8O+xzNSNV3rgqv41n38PxAsR75Pvej7dh/b3FrGB3kcy3hvVLaAVu+nC12QwKkwQAbZfjvXF+/n/6m+cA8O0Pzl8+XsMjAABKT9abt0vZDoNlGK8uAICTtcTmrpkak5Ou+TLJ42UuqHkT3Wy+qMN0Ua+X3XQS3WzOXQSN00X9xSdP5271ycu0iXLSNOMg7PGlNFf//FmcP7gHsilU+9ecc1gBbEU1ADBrsPL1rA4AMO6frLr4SxcCqX6tm33w8Pzxy5uXV6umrqwqz829NLiLKKApZEZzhqzqVP89t7iVWyQBgQnQCuFdIQDYgDwcfadl/EWi6mnaXEL8h9MHVvU/TZtxd3QP2Y3S+VhW5uxRtGi5r+NDNcypljsWTubTnskV0bQu111T196zsDa1d6jrrmNVi04ci+EKXMqA2mUrY1FHLGKyUaMgICvHIbEoYKBhbogogJo8MeYeKIhmiWTi5MiJ5KQUq9ktWaI4Q+iIKS7WuCml7CSBIInTwNXssTo8DDRkqaKyExxz6whYvBAdgK0GONTs24Kj6yaTyaxpbGVxAJ2wzY1Z9W1oHlP0Pmx6jmyRrqIAKbV+wA0i4vxNoOWmz34AuVlNHTOnVIXAIpGpj6nyFkIAAHB9s9G8wVLnKBDWwd+0fX7rhjfJOdenNI66NlcGTwhAojETWTiaZh02XWWf8fp1ekH219S8j6XuZ9dpXLQdbtAPW3r+dZB9T/44NmG/VeMxqW+zmik3gE3XCjxbxus0WO1knwQ1UqWpQp6/dwi86hhrpy+g+s//x6/+w5vVqdKXN8/ehbn4ty9eXsC988WDAABv0PXw4uaFY5EEoJFC4HRjRfcnbbJB8/UmTH10dXDNdArgmnPyg5N7uolXy9rBX32y+rX7zVFMP4XV8yuJV8sHp/Rf/esvow9TX/Wpt6wjw/e9CnqnQudV6cPav7XTxgnVs5p4Nmw4mur4klvaKbeV8C4Q9NmWYLeEf6264/vvP/ij6zWn5LxXzFhAjjix8w53tY8GE5H5jVn4jXiaCEG2HEihRJaxPTngGQ2vi1vk+PKpbB7RpAYHlDWOxf7XRpmsEL6OrSG7le3Fs+kDmo2dBnZ0MtxTCF+mtbGfm9JhYyHCmJhlU4eqqoFQV11vGUaWf1s6ldbk9A6TwLg/Ufhok0Ia7+GcM92haeHJOVQddCiqknqBPeIezWhGkQVY2CgdUaVhA+G9T5G9p8KbC7PV73m98d4eSAFYk0khPVHR0mRFYyH0B2xVszUFcoEis7nHWFtVWHZzO0cnRQhns2bds8Nh4tR57yyvigDBIrP7pBK7QVeZA4+89/aEB2tf+zdPNhE5zbuNnPdkrvRdjIToAFCEELskniAyN8GUVFLlyGKLgpcR2gohDRlMOYypCiGy5NnP3GZQAozKtiESVX3tbupeeQEjE7FDSuc2EwJTQ96xQS/krVX30q1aHpKE75Y/lvr69ZeaQ0MCK89NTX8jNHJD3D7pHqoKeoBonlm5ki1W4LzqGOpqCtX0n3++5uUN3lv81ncykQLDKClXbxd9OgAsl2G6qE36Em/W7fK5cTIfPl3ZoPniwdykMuvlDQDAsivku7VSP3mZ/vtfXP3OO5Prtj1pmrEHpDE2dnl+JX/2sxd+/iDrW8QBgAsbjiKD0GVPxVjQ3L7hjVPDdACY1TTu2LS97MmeXvOiNKndes8j4YZXtZu+zt1LZxVRzdY1yznM4nVXcicAFjP8BkODbuzZa2a/nuj6wOvxUnpHaGqWVlliHHO7X/AaHNhwk/U/z1xVQ47mSKMs7AadpARUmZOM1TtP2viomY6RfW+xkZSMk/m47mOrlXcJBBAYLJxaNl2X51BUAaCpK2M8yv6dM8mei/TxDoaGyDoacNN6qkX3DSL5BFd2SAKokGcIkMiB9okRMSY1geN8UsfEmz7myZph32BGETAU7IbvVnU6IizMjEhkDt6H8sEB2C8dohZ7CREdLTDkUERQVcpiwNvFgHcVgU1dnc3zV8s5Mo8X5x0LTAJt+hRTTAJlMMrmS2WwrDAvIxHxjkRpq0ixLYWKApgyh4pKyMS9wn2fmuBF1ZI26soTqCdg0SqQilaV37Q9IlbeMaD1ilVVONuibcsUQhUtcYPFKynbu5MDUDgmvjqs3y9b3eNexpX7OVWmwbVLsYfclxcK0k23Xq+PapfHjE2B+6lV7q+D7HfrI+9CeQEAePbVzXXCy+U2wbkEe4bR9qQaRk4gti1AU4W2g7qC2qlBfDO4aM1OZi/d7H/426/+09/7QSZk/Dxbg/VP4mXj5m+6+oS7tJhvMzfWy46GOaNfPE7nk+1OwjXTRTN64zTy6oLScwC4AvjF4/T7v1KdNM2hB6S5/n7n0fmffnrxRUv3zra0OMqm6NO3NHohXtysdjqdTu5NCAAGmsWQffsBr7poPxq+F2Sf1eGXZmZ8B6/hZbTtrF4tr18uu4nfzqwqMzq3Yyg2nG/C8rtrXy3CGNxLsVy8Hou39VeQziBYw3PrBDkwvBdOH9FkO9wU471qkZF9dHbZwmCLwTjp5m0MtswUNLc+KgxTrMbJvAX1f9uvjE5xuZhVASVHatYLAI6cd07HhW12hsnbl8QcBsHQFg4MvzDPLrns92L6a3bkRIFFRNQ5GKb8BQBQTUyStYYGNF0fRdQolBDCSOkCKYkjcN6XWeK+771zRelhMnZPO3QAD5VsUbNmVfigb0XAMpNMakNVasvekW0i4nw67RMDgsNtw90htrGPCWOM1pxwzhXuKL9qVUVgUBPdeucJoeA7QTawIyIRCM4BUddF74kQVQWIEnNyZGNiSZJP4LxDQEfAiVkheFcHv+mjmctnhShkbzUjdJAoMQNkM5xxneGQMtOlQkiM6EDfFQ8jG/c9wYxhvbm671XutzEzd4Sp/vzrnuZ7tMwrL6+D7OPy/HIZbzruEndJRBEAgnPBY+12kH1skRgImyo0NdTVtHHqAla+6pPhPhrRwVHuzeija/8v/1//5tsfnIfTxfm9AMsOAJ7/bPPF/Abg5t1vPFwvu6JrXC9v5OXnFzADgPv36Ffe8b94nN5xQy7zs4ttwb60bUcw28j0Un7zg/BvTRefQjq0HGjeeQc+/fz5lfzhh1f95J4V7CgbybCOBdZzhZ5XqUK80BiyC6AHlDiIbQ3EZ3XYu9kY363ev42c2bORu6unMlQHttuw67/5zbf+fz9+3Hd9qEIGEyJObDYjiFltXor6szcWcKxlex3bS+4unF5LPIdqA2Io/90w3XIyvEV285956CdlTOmdyck4bqlPEXYFM+YkA0MewjlVBc1hlBZSynbTyfSkzCXqXrO7ACGrOgCHSETeua2g0JpsADFJqUBRJKbkvUcAbwnShll5eB1JcnPC9BiJ2VKh0TQnWTtPzMnQNbJu6R3b8yUORJMqdIkJcTs8RgSQFMz0l4y7UJHI6jx550pwkuX7ldEEYc7c8Yhey6XJoBrKydU5CwzHC8O+xHnSeIQExDmrG1R12SYWScx5KVI1N0pbKdV8ymxqIFfHuYFJSPZ6bGrUuy3k1cERUYxRRMDuqwpEfeJJ5e3NNKuGYD1k55jVUv28c31KIa/CKiLGXwFR5alPAoBiEfDGqqm5qm0/ektKIaLJQM+M5Y97OsixGnKvfj96Am5AprerIe+o3I+c9YeE+9gF7A7lzG2AfrnsrpO76biNqWftExumIzqEVHkXRpG+ZotYzBHN7M1g/ag4xEjkgu91Nf2/fnTxv/3gvH38+Mnjx/l9bFuLz/7ik6dGiM/daqAjZgB58ui8xl8ApBNvvPyi3nGRnC5qSDdDiB8Y4X7YSjUnmfunpz/9+OLDp6t6Nimd647JAN20LoVvGd97AO4jNXhVbcda76jQ9+r3uyH+dRqq5duTB2KJZ3W4N5n/o++8+y9/9IljRRrkMQCs6oEUVIZNugBURL/1DPoqjoeMDFgbdGeu/kSi7TQB8AteM2qDzgh6EyaWnfgK4BFNpuTTUJ4Xtn3I1ds5YVaarGx/G8M5VT/m1QcwKySMIXsB+kvu7fbfwSmLZqmMCCFYUTZWhdvsyvh0NI2KMR6QXcVpJCfyNqzrnW/7zhv6IwZHkUXU7BGpAOqWrLf5UkRQbTxGxjSolfK/DgJRO1AKZRapCsEUjZHFhku9c8kmS3OO6ygtb6cgRR2icXWUkVuwG2UL6TnNCHRMuJdb1sELAoh0rIDYD23Svu9TTFVTh8F7zg9KFedcIAIizpz+tmkpuqNXsWcnIo15iolO6nrTdUXNCUOv23q8dVW1Xcei3lHbt955IMeAiFCHYBmzAEDkRQUASVSEHQAjkAKY75uqTdiOmU5bPEp89t2XswahvesGxSHy0Cpy7ziyaeHsa1buh7A+RvA7qBjLnQAAA/TlJrV9jIB9amV7IiDlr585qaIZdygDEIV60iA3g+/KK8XX2yahQVuAF+3in/7RJ//L758BQJGy/PTji29/ALxaxtkCAK6uZdyzzFVGoMW9cF4vCmlT5JLTEY3Oq6Xl6pm8fc9ywM0WL66u7p+eXlX6okXXbB0CTitxgZSmo74oHUXqu9mVvu8AaHb7zK396ZUUje+2L+w1G6qN03Lwb705u/zgrR99/KUpZ7LqV5QhkcvAQURJ5O3GPWotPerA4dniqkff4OcoE6A9hfu4itmzDdijYmw3YA8kMW0NIIeZkUfDnqDyYa+El5Seo7wNwRFeSP9pz2VRyRl7O+HRah7lOirex10Hm5exma+BcXbMvB3iB5DB+UsxD4Za9e0Qo5XtI6+YvbcCS7Yqm50yFRAcqVkg8hBvbep1761FKaqSkoKkpMG5UimLSJJtQjSOAMsV+SMZvILsjuHstVIr74NzJv+OKQXvbblq2zYmnjR1aSmL6tZVWJVFTD5bFKXni6kn2rQta3ZsT6rTodpJnK7XyT4lq6/NxLiqnENvxH0IHlQq8/tVRXQsyjF/HDGltDtxRghRkkaqAlmW/XZLNG6fDgnZqiosh5m9WaD19S9W1+9V93tH1vT1jrw/oXqUnNlD9mfLEaCv2zZql7TfSVHH3SkJLDKj4AgJ60DB1yHQ2Ww8Mb/z1DlKeXYDJ3Os4zevP9vof/Gvn//PfuWeIfsH70z/6pPVt+H8MsnZagkDyQ4AcHVV2qHvnVRfdtHVnrstKT8u3tebYIX5Zd+/N6tXb8j92emh5cD901NeLb9cigG6dTPGQpfbTWvuuhSqvapq6He70yMap1wf0zg18SuL91deptNpTVyOv+riBw/PP/zkq7brDd/Nfs8G5dG7PBYv8n2cPGpOCuYe1UGOt6v3aWZoa8OiuU6h6kewug+VZScdlbscNmaf7Np5FsJ9vLrYj9m+BvIe4onG68QO0WLBt+c84eisRjdQKDiMfXqi4mifk2b3c8O3CRiKQDhILTG3EBHROepTKvS6PQEGjWJOJ1sWBYb2Y+7QDhT5uIRERARzeSwMADkAdXmMlplVVAjdIJgp1brR/NsSHjMxZdOkh8g+lgOajIWQAHPzlhAN2YN36Mgsc60ctkXFxqDIuabydV2rShIfPDrE63UHCkRgQb6z6aSuPChAGJqcIm3fq7UfPDnCPkpwCcnVIbBFG8YkI0s1QnSgiblPyR8MWjvKPSRrtMIQHltCCyBz82jHJEfnEw9LeCW+7wlmxoTMeGzVqJtiD3m3GnLMoxoxcBzcD5mWwz6qpX3Kpt0DdGFVLJGcUOiXAuhWtnvnM9UeKPja0pmbaXNbqW7zPi71R5mZncI29ZNJc5no//hXT3//V05/71sLAJgH/OnHF7/7D+9/+fgKRomvY8a8mrqz80A18p0ioMskn1/3379/+uKl3D+99Tb/6qfP3nj3jfNZeYuzp88dypZXdkQL1V5V+zTK+OCGv1VVx1uOZqT/a3LuZXmY1aGpvD2NTpwRPnVVS9fZOAwiggdVVQJILN7Zef7+NfvTW9czU6d8B7fU4cmxqY1L6S+g/yfzt8xJxvxnLKTJHNjH1Lld/wT6ttEPusrKn2uIhXAvmF7q90vubwiecPwOTnvSp3zLx2RQm/noPMCZgzV3a2obL0JVIkIiFSlkCAH0MXrvc80zzrFCVNXEqbQ9GdQhsYoD5AHECbP3VfGkLSuKjmaaSogKwHbgyBqm2ZTYOSIKIejgXmABLKU7So642ExKbnTK0Io41D6Or4vouk+LaQ3ivPeE1PadHZmIHDlhttnX7GCDWDVNHbzzzg4VnHeOrlfty+V6UldVcG54jdM6sKojZBYk7CPHFB25+SRYBzWyiMjaROuFyvfOoxsLlgBJOAkrbLHdUsKBlR1S4pFCZpgp07zOiQM0Ec1r5nUY0I/tww4FkYcF+1FB5AmE29SQLeP0jsrd8H1MywBsKZeLta4Z2j52SROoKBbPS3K4+4zBESMCoXrnCdWRDz44R55SRRDqiW/Yd2xDSSZdP/p0AWDVqk5dTTxqqB7H98pX/f03/u8fv7zs+//p9+5/8M70D//24ttX52+9c3p0lPTFS5km91a9zwPkodY6cBcvXl642eLq6uruzy+cLv7bP/10re77b92PfT8WL76yNv+7VNahqkIF40cse4W9I9dO21/2UexVGLJ//PSiS/HsZP7iamkMshkSEKIKa2IhAoDfxNpC8sY0SCFDxt7u1lA9c1XB/Qwx3j9Nbdang3jR8XGSyBjZbX/waXv9oa4N2Uvz6hEdd0azsv2F9G8Pdn2fDkyRlaIGauVHYVFCp5qShOKsaZhYsutyFpJA9lbLqG+FKgwuNNnlqvh8ITgkBVDlIqrJdmCYSQBRJQQazLxgx6nNfCAUy7i8ESPj1h8iFZf2wWBgzEiwc/askjVXB6VjYdjL+7DHw5R3yYaYWLXreyLyZOWtSErkCFiEue8642QWsyYmFZHZtCGFs5Pp9WrT9alpKueo61Nd+dq7urZoPZ7WmWFzWdTvAIBJQtMUjn7dtk1VNVVYddGR9lFgkMJMmpBNx/IbIp6wH7ZNsM1zF1P3GJMGY7OwYYE352JL2bY3f/GqIVUr4W+j3ffcZgrnftQe0hHSTYeyGVtIrdfrbnAoOey1ZrVMK4NmcRnbdd+yXqx1ndIygiQxyoXAASYFD8CEiuj0gCQNTr3zHsH5ypF4X7ttVe+UzG3cJYC2BYC2QYbpXVS7dKs+kAG9VfSTSXNI1Bi+v/X2m398cfn5nzz5/Q/eOKuqj66uHpye33bkecCzaiKd7kVzjB0l526VXsrpXf7t8OGnn/+rX6x/49c/GOPsYaH9S0sYCz8zhnUAiH1vV8bHP7zxUc79NS8vlt3YZ+5nn7+oq2pah0vEFFOoghnbskgkKwDZqX4weLgfSiF3dqbD2ncSGnMFKHyIofy3q4XpI9eSrDc7JmeK7qXy4Tq2/yZd2ea37G1t2bDnsPdMzOFgXDEV44E8yCPbXqIJIrMPDAgLZm0GECCbpS2Opvlp0I/DwJlYLxR1xOEWSndIsgAAIicquE3PALPcIsQuJpDoQ0BEq+ILyg++khDNdoaH4eGhFbylbnYvJZSDEJMIOFdVDWRFifa71kzlHB4rIMfQn68k7vo+ETnnxv1GI16CD8G7yIoYT+f5pFqtW7t3Erled9PKO6JeuOsiIJpDTzBX92FLwUNCob0RPSdAV/L5WKCpqpSSAFSBzIItOw8TsQKZkYMIDrzZKEAVytpsNvTmzFOIHVA1VvGXTto7JGfucHjfk7oDAkeh+pbd+YDvRfDmjXLZA/QicdmhVoABMG6/HFz+aiolI14qAnQEdCsLsBMZEVzzOgDX6tVyDQDddNZyV4Q0BvGFuolKfjr/8fXqZ3/5bFHhW89vfufREXC/f3r64uXFTdTZbIiwGUZYt0visgOAZr74o2e/+Opa4CHcv0dzt7rh2Vjefv/09L/78y/f/cY7oar2wP22mdK/l0tNAFVlQH+0eP9aCpnbFpUxcf/Z5fM2prfmU0Sc1PVN2xKz9z7r2FRBVVhmjk7QryVJTGtI0xGhZIX8CgEUKsGZwpcYz6nyov2QmJFFMpoehqbyIQ1uMFZuVyNkHz/VT+P6icYPumqvDjok/e1o1yTL2DqXjT6uIZZu6t5MubXaoJDOqsJC3qKQVImGPMItRTMOmLXBytwpFcHBpBeH2jDrvAkRMcZ+p2FlEnZVAQjeb+Px0M5HFSBEjCwRoPLOZOBWehtlTwqVoywyHvDdE5XE81z5DsGq4IRBjQnx3qeUTBalI/qeblG4b98928mpIoCwOOfm89msCTav7wlvNt20DjCEICFicLhqxSee1sE7iomJyGI6VBUJrUtsH4tDXEdmlcr0NoiWGO4IE4vzrm97QDyZNc5R2ycVnTTVpu1jSoQYvLcHzd9b+xQsK3hv6Sv0eg6l2smIeB0z9y3H2OpZA9ddPNovLYYze1IZixEu5HuWuh9jYNr1qrEYmd363f/lR8tSoRvlsitxGaFDDsziMZNOzgVyjgQAnKu8dyDduPC+A+UN6C9X7dksk++H1lotI7BNBg55Rk7PZ/PFvFnetIbvmZZJvU0MnU4mMJncMH71/MWffnrxO4/O95gZa5POA67qxlxo4k3WLxb/maKW+fFftt0bR2D651+l+/fopx9ffM7V+4u6IOwhyo+La0P8Vff3CfT2iHubg24jf7/LyVdftQ7RPuiqdiE5YQGfcSo4p8xR9VHlHuqk6F7WfTfG91Z5sztwfQbBRJDXJCCZJl4hvO+qAuINuj0hTSF8LJqjjKSWxhQATA52tlbpr9edSLpwamfUBOhDjasBsPaR3bCMi/RdTe1FLlPeOPJTQxs6ElED8UENAgAiIJr9tUvUbOHf7VTT7W5dSgdPikZ+qy2BKliERe4rcrZzzMcxPsEhOu+Mci8kjEPMxsOj5zaWCJXX4p2zTcCwDBjJIUfxfewt08dk9mQs4rybT5o6eMP92pENUilWphoCpE4TIipimwSTDDy/Up8cIVu0naoATiqPCMa8x5imVRWFVbTybtP1ffKg6p0Ljuy97PrUJ4kpTSo/b6pNZGaOKZkDRBN8z+KdTymOW+g2QmwubIV2h9Ict3X6YBPzSjWkzakWHD9k3sc7zoLmL6R/nc22Ifshxe0/ue5z9Q3oAQEziFv3J8H4ZSOhBu8dCvmqIgUKtWPW4DACACvuIDtA8HUu06UL/jjKx25zCWD4XpA9m664mTmVz4KvqjdLLRyqalZ7VOn7PLpbkH1bwzYI9+//n//sxTdPT8cVdzhdvLi6un+PHn+ii5MpACyf32yfzbJbPJgDwMXLi3i1/LOfPAGAr550199u78PUDvLglD789OLbH5wDwH/345+enr45BvQxshfaZO/3f5fh0nyoqjrE9102331dWmZPY7O3QqzX3aSuFbyqNj60PkXpZWQY6Z0nkfd9XWloI48B3SroPkXzgzSme4W5m2owXfz3V5qmzhtXc5xfIrJ5VMtg+qy9fgI7ptg20l2ytsdle5HrnEH4GFYAMIH6z6lnUUOoMbjnxAwAQuCRPFEUgNl5T4ODblZA2hToUJtbRZ5GAacikPumw95/vJLkBoZ1PodYOyufc4fDuHK0NFQiQsiVFhIRq9ggFVublAgA+sRjVywb+4fRugKDlWPlEAEc7Fhoxcg6ml3FYZ5z+/4coxQ2bRe8q0KYzSdg0xyifRKLP0WiTdvLbuWr5qGmKqyWcAewddy098Ta+EaziGIXkz0fQvLed5EnlVfVujKpjPSsiDgJzjnyRH1ichQBzEbNeVeT62MsVvjOe2YWACQkyWvnMMG0l9qRB8jeW+shyd60eFQQ+UTjiYS9VmoxmbE/FarQ5lQdYRlYPSF/FlBvLup5Xc7T6XQK6/VtnUs/UC54tE7f3s55j1BVHsDXQQZekQHAoeVeRYc7Z2MgKMh+V+FJCLFt11yPbMpPK3FhVvnq4f3FrPbzCl2o2q7vkl4u18ubdnkDfR9Xcdudc4EayPhug06zhj565v7fP3/2n/7WWx1kcB9rGeenE4nR5pXWm2ATqgXrrcB3b/KiDT+5XH7wznQYhloAwJsfPLp4efHTS3z4jcmYBz9Ki8e+t7K6FNdj5eLXuvR911STo/U7QG8PcbRy36NlDtsve8i+J7dqk86mAQGYxTkiQPI+MtdEjkg0q6F/OJ3abOo1ZYl6q1zwfayDHHdT1yOt54XT3wj7z01iouBLQ3VbpMfWtOpjZM/lkqsOK/fr2I4tJ08gbEA+aQDWQIQKyCPXFHOMKjgoCpRnVhWcR4Wk4pzjxFtmZnBY3HoPZILemHSxRBMtGhujdAHMmjaP+CKOlTA2rG9xSMBsFL8hvip67ySLWDIGZb8wVTu4aTyKSHlHGm/vZ0rOFCZj2T4oMyuI4tZGwJBdES3j4rbSNRDOZrNqkKh5wraLMXG0TQxAjNGq+63zsIAqW6S3TYYZz487a6pKSnFQta/a3t4HT2iZ4Gw9DFUU6VFtHkYUmcUhAlLiVHmnjgIRiATnVKhXZRuXNWreZYeT7H0PtvjlRXfgqgXg78q5H70UoZfpgyvB8cBq8cLbl4OPslXH9r/+KJQXQA/OETki8s76FelouNQOrFNdQWfAFQhiysxMTJ3V8iidDlwNylDBqjsFOJ/Xszos5k0BdB98ioljf7XqVl2KfX99s7le9y5QodoL/+4CwdC/Nnw/XUz/Hz+6+I0H1f3T/LRfDOqXy77/QbMjDh1cB7aXm6gvWrzf6E+e8X+0y9rnRaihUFU1QSc7mD6uowuyjxueXxfZDy0KyoO+8pZHCfe7TYjK89xzji7sATpyoDK4jphTuQP4rWcAU5CYzkJV1CyFVCnAaoR7Ke0vpTei4HOXSov1FW8Iuj7Fl916vJN9C2oQ+BK6c6qOEu6F2b8cqJsvBwWyiDrjDUrvbgAvGcjKfIVQWMQrJw4hIGFi9t6rbMUzNpCanbAMfJ0zISOboeNIsKIDMwMlgnkIO0VAE5nkMI2BtBEANwzHlmIfijBm0OPDsFoU4wQqEawDcWwujDIM9aSUeEjquO3NV0RNPIzyAiDCyCRytljUzimoJ+yTdimxsPnOC7NJKoMIIDrnbKaJCAA9IRZyaV+NOlqTRDX2PQ2LHCOSU1Dt+tQEBwBkExhu/NFzTCk48oQMwArBuT6m0lW29yf73Ss45/oYiciWbbc1JMhW/fkzvT2pY08QCaBto4V2PzSWMcbGyJmj1Lyk9DaGO7whj0shx5p0o9GJqCJ1Q+1jcxbMUhiYUQtl/zcA0ENtrzkQANXGvBtFE82/c6jlK4LJafXoZPb2+eJsMa09NqMw6bbru1V3uVwXtOr7Liq521PijLVvIGeWns9rmD/8L//86X/228dWvDd2du7TSRwn7QHAJ20CgPMaf3YFHz9ef+fRu3tHmDb+CGdyy4993wXML+HvoaH6dS5zN7vh1evfvhMHu9yOYQoM6rfcPDSHmeDNbumdaXjUTgpRvqdWNMrlBDOxaF6MGfoHHLmQ/t+p3zgqozxahn81+q6fUzXjnPF0BscTmi65s4Yti9op9ETje2v9WfBtTIbmwTsAiCmbrhAVJcyWbmYLlgDout4HXzSOsk0yyZbrgMjmxzsIFsm8EwBYZDAYtJUDnHM5eWOIcyvxJyafF+ZczgMIs5X7IjLIydH0jkgOadSXdWKVqQ7+i1oCVEUQMaVkSw6o7SG2YHpoS2BXbLbFDVsQc4EGgKquJsHZ5qpP2Zi+7WIfd1ApbhdOsdR1U9c4csXlx9iSbZw3YjaAQMVhq2FNCEjJfJhjAkREyYokRB3YFQy2coM6JEDoo3npowqrat/3PgRvWWPFzwAga9tFSlM6MzMHjXe4czx1z3DmcI5pD+uNjelJLcqmtFXrZwAPb92CD5nJuXTzCp4IPdlQcv6/oPlApgeQziGwhqM1exLvKdkV1HwvK9gDQYQapNvRyPj6pNLTxfR8Xj+8v7g3C4bpbdc/frmyTukYEw0NA+6vkjkNw2+VkUbLXG025k4zq0NT0ZN07//wx0/+599+61tv+sskhyGohuljZD+FVQuwvGnvNzoJ7n7DP7lc/qMreXBKV5ANasxn+Bg9chzoi6TnlwP0Mqx0d2f1DnzfWwVfZ5B1cKJHRBJJDitw2HaddduCc6nvVR0hssj3cfLQTw5dBMbq8p3FlSoYUkwB4Cvk28r2aVUf3v2S+1J3n0A4Z1wNJ8jJLXE2FIKktEK4hvgW1EaSPmpD42M7BAIiICGg9zxMKpbBUTNEzBW25tunmKyTquYVY+YtpctqYDQMBBR5ogwjTloqa1QR9eO4TsOaAVAGiAHBQW2JuZJ03qEZ4IAyolNR2Y4mceJE2zw8w+I9XWT2qFHN6Vq7ZTsOhX9B+W1/QrPoxZoWRLSJrKIAmphVJDGraiCE8tJUc2iSsVia7XMlr5tc2hK2uDnnaAjsHlfxeTtCeVrYpm+dc6qJRWwevvIusnQx1sEDqjFUimgCG0QSIgdgKlIpwqHRKEBiJcIchaJKzmH2cz4iiXkdoN8DdKvZrZY/kTylYXNMleAG1K6T9+dSAaS7z1nDd1NG+kkTAjnvqHB8BtMgAEP5U2rzQq/vfDFYvEsDv5aAaoDaqPajgD6dTu9NqKmo4ODLVVx+uVx1sU+96dmNn8k12u7sZcHx8RVD+ZaxxMg2TitfGwf99vniCcA//ctnv/0mfO9scdLkD+EdF3h1sVetbz+tJI8HH/R35u7ptby4ugI4ffOD86+ull99/OmbHzw62t48FKQfpUpeSwmDcvSwnewU73sUTVNRvStkPIra1jJ55cW8ISdNMJNCVu14qDGJ1LnEXDsHAD/spQqhjVz48cOLfXdNEGn1deZqEL+E7h/4Uy8Kx8r2PZrlOrZP07YIeDBaMk8gHBLu+U9CX2jaoFjZvgH56z7+4OH56eryspAARq8jkHc8BFPYgKMN+NAwyVK6iSKqIGEkcBzHCTnnUkpbXr54lzsHo3GkwU5WzTJ8C7sjIY1Fuxn7m3ubFk0OWzaGChszQnBWxRFFblEbO93jQYcPR0XxiCaHRxZEEAW3uzwUHXrf9yoSQgiOvHOgguSEEzl0g/2WrR9JxLwbE/NQp7MqTZvALDGJOmd9XU9IRPfm9U2X2i4K5BZo8YK3hZOtRz3kUtle02Ke7M1xkJvJzBq8c0RtH4MjVRWiQLQ1gxveQ4eUkO0DMYbDXCTtUza/3zvYmDG+Hxq7H1W4F95mDWkrlKRB6n7sskexTqfTbrnpGP0kBETMBbjmAvyOS6nlC8TjXhUgHQB0UUzwPptMzmbN+WJiE+2LeWN492LZ9WlZ8lGHUL2tfdietm+PzSgzq4NWssR/zYBXp5PJybSqhmRnw3c4X3x4sfzrz29oc3leH3mb9mgZK/DfmTsAeO+k+tsX7ceP12eevvr403C6ePrp5+HlhR08VK+WKtoqBQBwOy2z12W1V11VtS2E46p8j5YpyG43a3t5HW+ZV97GSnsL8TqZTr58ec0srSVHDMZPlXNpYN4/6KoeX0sF1JPaytIqk/cS40oTIDz0k7WkozzmeCrV2PZStlsNvu2IHCPcbXl4LGszHH4L6p70WvKztVFDJKcqBpplBruI/7SIQ4bhUhS1Pxl1YwyDNT8js7dZHlU3FN3GpwOiI+JdpR0R5Rbo0MC0WKJeRvmfIuY/jooDfTKwQBaZNBjF5KmogVU3aLaye6tbH2E9qxoV4lTMvazATjYkMIXKwPyMv31JBVmJsK4CEc2augrOE+Wtv6NVF0FpEnz2JEFgli4yANTBBW/BsRATJzY7jVAH3/YpsgonUWBhUVhuYmQJ3imiJ59E+yS2PiVmZi5N0WHfnKrKF58GETGfA0UEZdDi4YPOe2A2zp2Z3Yhkk0E2M+idht+rToiOflFNMAPDeOqYdt8zdneEhtc9qRXve+cIy9ay7FrSlDzddIdtsNtaaN5TSrIvljnKpLMGVd1DfyNq7MZWqJt7zOm5zt3sfDGxIh0A2p5WXbxYrV6uoF2v2j7aeEWozUGQDZqLpmev1DUL3KIgtGr9arMBKLbvNAt+FdPL650a1g5lGvO3zxftbNb33ct1P+Mbo2IMrAHgYpdpuW532KFJoD9+svzNR/MXV1fmR/bhp5/fLVg0qA1V1fbS911+FbebwBSZimE6AJzMsxRnmFrKvVnrM9/RDj2UQu73Z459RW6v8eEbby6eXVz3LObSZ7oCM6IyEnnu8QOZFXELVG5PDTn2BWPRtzHMJcfmAeJzkA9oNqbaDx2DC74/TRtz6zVr39nuDuSE/CFlbxz9StOF9KU4eqJRFvX5GzVcb0vQwRpXRbNiGkScc1UVErOwqLAoOAQpihHEQmBn1x1VYasuPRGYF3xJsVNE51xKQgSYM4a08l4GEqPEKpWoEHsgO9eLHtFYmRyvMZAkJWTD2BK7NY68Cvjgy7FjETNKB7VFy5XxoaLhyVsFjYkd4mTSNLWvvE+yVf0zSxJxjrquO51NVTU4ahOvVq13GIIPznvaOgYH76rgjPBq+7RqexZpqmriCSCISBeTmMu7Q+8rVSnmZUjkiWKMZM71AFa5d33f1LW9M0mUFIlAWBgQRO3NBwBhNnd+T27fj3OwD6PB0dp+yfI1NuIF7se9U6vEp+TXkox+uY26YdEx7V6cZO6wDMvgbnR5Er8lZAaw1mHOefhrBMz0uqp24kAiQAcAiULteD6ZTBd6v8rESwGalxt3sdwUQO8FlMXq/T3xe7teQQ3gZptNa3T5HsQHFBhqdhfoFCbWXC0R0lGprhRACzddjlCuVFV9AnDKDgC++vjT83/8Ww8++K6//PJnf/Snf/PpT3/rOx+An9+8hJ9cLkuBv4z9eyfVnz7e2OzSZZIzTy++Sp8/W7/7qzR2ArD6epyKVyru8pQK2RKVyvUxmV6q9f1vSXZ6gRTTUanM65ftt5kNlZr9CFHIHFMcF0cioiIUXJ/StwIVpvtSelJfoHnbUMUtObMjyEN0hN+uFmNkv5XYia3EWEI5zkfDDdaAuo2TueT+wikIPFBaIUyAnoJ0bzgAWNwLsO5N/iEsRmioJB5me4zU9s6BcyIuppQ7q4OuZriLSPZrRCRjDyKAK8oWKQOclLXSogN9qzkAyA8IBQB1FpuLgiKQgeqgsckQi7iVKyoo5YEjVUBSVBARdYggYmpOV8zFdqo0LUDvEMnRwOeXNsHQntWskrKs8JPZFAmC8/Pa32xyxcGD21rbRcTsGNrF9PxqOZ9MTmfNeH6qXO2j9ClZOycyx5S6GKd1Pam8I6oax6qcuIv8ol2R7ZKM6xdxCELEg10MDR2Lru/DMEfdxWh9DofICpskAGh+ywjgvWcRJVQW20jZK8+WQb4CkLF056gl5N391SyYkVCUNjaGOkb8oxBfBJHviv8x4xTAGqctY4lOHRfvViL7gt2lNgcAzkVWnzfcpA4xiWdVkJ4ZeokVKQDMJ5OTSpvprBAvqy52As8vl1c9jQF9pz8zMDkoHcCOarvtINWrmqeWYgHZ0Hynfi98xW3KkzvkNAVVdTq7eHmRHr391ttv2at89J1vfvnnz9abMF3A8yt5OrjAb6KcDmvVf//xs//s3lt2/ccvrvTk/hjWx6oegLoIz+0Rq92NCABUoyJ9r3e6z8M0WxuZw7LdOPc7uql/98uPfv7YmkuwTTuzeUUHQCLxGy09rCet8iX35P0l93tW7EUHuS8gQ8xJe6NKX+KOdUEp3gFysW9imz1CxtSNeza/pWxfxpZRx3f5gtIUAQDOrilv2C2dh4UciYKzxilhtn61ZilRZe4lIgGRmaMo8EBo2J6Gtw4kKSUh8iWVcKiytwm0CqKiiKriiIL3Rv7abZrGKYAws4hh9niSCAHFPBJGKsIcHaeqoMKCAAJKhM5ZfhaaVr2EXENOm0IlIt2hXYo9me0wxmS9Q5xNJpBHrKCNAoQSeZ22e6Cu64L3LOoILm/WdQjzSdVHJkI3lO0GmJs+dX2vqiaeqQekjimJSFPXU5eNixukwNAm5ZSSqvfeEbFqcHkwWAZ3eCtCkrnqE9nvvfPgtgNcZmfviDxhz+KQoubGLAyaemZ2ykZF2p9EZMH7IGN5TLep0Y/S7tuv6LHi/ZZu7Gq9OzxVhpj2spq3ZbvTvtcAokeklBLHdVQd6N5k4hu2In1I/4FO3NOvVu161arro6B0BdOVBQDKj9l/BkCp7qNUgVp1mZkB8B1cdeuO8d6snwVfyttxPRt72hsIsmi6PiUYuc0cYXt3wXR2epYBZXlFGt+av2E//vTji4tO35m7TZSHJ7QI1TL233vD/cvPBP78y/dOqs+v+y/o7LuP3iiUdxkjsjdpj1kajwXZspTx/Rb1S9kBLObNuF8aquqwbC8/tr2sulgT/B393Lcev8QA8JefXC7bdO9kerXuyoyMSf2Exbo9P6jClPzTfiMpkfeHvMr4YtAMACtgUNigfHcYXDJkP9qStZUDVD/BCAonEGa6X+ZMKYwNfi/XNxR8BcEU7hOgcpcNCIv+xs1i87OX74OU9uPhhA55X/xSYLBkGUI4ITjnVDnGTGioZG5bEAlVgAhVNEpCQjJZ9wj3D4zFxcZ5dMTIW13pckZdTFzi7zSvDYgI2cLdepsou670o6moHICH6INHE+0ckbLruGZXUZNLWqWshMLS1JWR1JXzALDuYpeYVVDBO4s3AnTUx8iV71kMox0iw9aQxzQ2nvDhvcXF5Q1SseZFAuhVJt4zYEppDTwJAREAgZyvQOrK95HbPiYARPRV5Z12kUUk73wQgg9FTGm8eeJkvFRxhcx1OpK1fIP3Xd+7wZfYvgwJFcByEPF1jGXexmDpAqV+P8zO3i9Jbynex+LI0jId4/iWyt71bvFdlGG8CIeP1HLwkgonIU+C5PaK9PEhLm66jvFy1ZojWBxELMpyTCHinaOe+9qVyh36WBu+D8DWQmhgvVq56fmsrgbqfExTGJKuOhqLC6NaAt9dw2NjMI1Xy/Pp/rTnxcuL6WT+J0+fWc0+CbQYNUx/9RT68zeezavqbPrr9U4FXVOurzuBtn+Fye4disbC6pip76z2ANB1Kctg6LhCptxr1cHfPamj4PusDi838vGTF/dOpiaqK6BmTT9hsQrrt+J8jWk8/7nHvBfahEXbRs9jBQLq/CXE+5BboMbG3CG2kRgB8UNdv43hwbFN21gEaZGtRNKgu+QOAAqy2xTVWFzsh3rVyvY8W28KSJEkgqpuiFEdBVMDEYEIVpV3LjHbEBCKKqkXMmEhZtcZYdXgXM4TJ4KRe4xNnaakMYnz3oQ0Q2STMrMRys6FEs/HIsxs65CMRxDGLROXBYjJoNk7GY3guj00L/lTu0FUXKJWd89kBLXuIrB2MZntoh3OlkOH1PXt2vvKZzG7eQN0kb0jc2zvI6PyP/zWm3+xbvuYFFARneh0Uk0UWBWFqyowy9W6q7yrvGNhAGCW4J1hYmIRTjYPVaRKMOT92jarvC4r8HGwczCTziSZdSEi571ZcmbrYEJrOXsyY4Lj3gN75cvQR92ZLH2iEfB44tLrFO9nDVZ9VxN39WxMqxYrYJRNMWLxMWnM5IsjpzxYXwZgJDevKfjpm2fT00rMa9eAw6SUR4v0sf6R1YGquU2ZzBgkAlQVZdq9H/wJUCAQQmgaZKiC5XiYTqMIbA5VKLNaTEA5Ng67TUE4LttndWg3SxjleFCM3MV4tXzzg0e/+PGn//Iz+dVTnAR67yQju0H84j789Wb96OEbXVJD9qJKtCudwJ5O/5fQs8+bnZ1HWULK8lYg3uj+We1XXfr79aEstPuPPn7siCZNc7Vas6ovqgxEVQ3Bb/p+jvgIJ+vdxKhrEhqKd0PtouVqWqxwa3n6qJ7eQbLvXT6B/lAhs/32u6qkc0hMgHgi9DRtViPd5wphpvBx3b/b+l9bbxKGtu6bpGs1n5bMq5LDmLiuwtlsAgrk6HrdAubvliMyQxIE6PsYqgCIVQjBexYxNFFhRvRIVmITkUr2NjHRt6U80wiMiCil5FSRKI+SljHUYT0pkdzOOSaCAF1KHpECFUaiVOjF4NAeQwYVDRb41mEmKGvntyOihY0ZN11L3p73XgE9IausNz2LeOfGsd2IZJ7C6/WmPl3YoTxRTwACm65XDYi43LTzpv7jH38WfHDO2c7oZD7p+sgsXhW9M8+J4P26bVsiRxCG2bHcjPWOmbvYm4eawzIWUMbJAAcukUGn1rxVKlqvohCSHJWVxwvKRJWR/CmldKeNe2mfluJ9LJgpPadzqL5u8T5eJ/bSkovJu9KE6mwi5U3iKoqRmSQ58sHjfDKpAo0ljGYAu16vr5ZrA3QAQOkNnUuRbsU+kRNhTxZMdkAZ2VAZgKaI5ApFA6E5a3gQzKgJYFZdNHAfl+2GoTUBzJt9qp21cVoHrY9Jy8f18vM2fIjV9xanCuAvv9y0W0+Gf/pHnyxfxsmD+tcfzMd3nwcEgB9dbVabeKhKtCs1QRwMIMdP4JXBTHkJmTdWqgPAqkt7ksfxj4ULstvb4nd9s+kk/L2Au1Xun7+4+fzZzYOzE1VNbMkV7EMoZIIjSiL/dl2f9dXLuMo68YGZGRfvK0290yccS2G50rQWuE8VDO4xRp7cUbkDgJXts2OnwAOlYlIGg5UNBX8d13u7uRWC7ZHT0tk5c77w65ZB85CnyQGb4N84WzD3KryYzJebznzBQggGo2pxccPgklX0hFhVlf2QyV/dpkNspY2K4hAAupTqEApv4L1PzAjgnAMjd8bhTbs8uG2kJkRdFxXVBjWtqNchWDVrb4woP3jTyvjSvu3MCP1N178np1HVru8RUZOyiIgkxOBc3/fsnHeZLFhMp2zCUKKYUhdT5b1wJKI4OPlUwW93BQqAsN50XR8ZtOs5OBIFQPQOqrrebDYYwqaNwfsmDFaRiEQ0aUJKqmDcS95BOCQXSEWKjb6ytF3y3pv+Jdv7MBfODYkCQGIujYw8QJA93RjNP+Drz67sRe4dFu89bc0J7IrB/V480+vszj0AOPI1SVOH2YhJH7MuT696Y12MwNnu5A4wvQSbBI8AzgHz+OtksuJBXGzIXtUTALA81Tqb9gxnYKvQ9GMtyhjgDN2MiCjG7uxaAOgiKsodYGpQ+/SzFwCAbd4TfPHJ0xdXV//Dv/yLP/jR8ofv+NMJvLOYFEFkGX36xnT57OryrQcPjPs+dAIYZyR9rWp6MW/uzYLtCWyo3QdfewTwXZdqygrIwsbYQ6SBn2l7+bsbG+xdPnq2QaKcljCcGziMvOkgisifF/AM/F7xPh2UKvuiT81EzUPyMmK3DNklpjbsDy5JTMa2f1NrE97MFBahWcZ22F3tLPYnQlRPAQA57T30c5RPIf7OUP6/jWHBvYgQEhsNLaKE5PDF9VJY6zpcPb8kVFWaNCEgrQtSqJIjHNwxYSQrcQREXlXdALI6/MkQ3+hgZYmKVeXHjEdMiVSRnKo6BECNaTTxNHj2WqeXiJqm6mPsY6xCMMSPKXki733X9+Z36EbMOwCoANI2yqNoaHBkUGMFflYt+6wUrEM1qU3C4gcftPxFiIkdAZInFFCMLKfTetX2bR+NU3KO6mAq9S4/f4DIqXIeEMzDgEHXSWNKdfB18I6QVboozHms155bYl4bx0JUhxBjB+gcAg18ke71hU3aqGixUzFJVXlCNIe1kuNcvDmF1TnLCKSUBD2qORaAmfv/MifUuKfak942l7SnloFRPNOm25HD3aFp9sEjgJ9PwptnU6vTrUIvNHpM3Zg9rwh6ARUGgAHQwRHQyD7bBjsyG6P7DWLnKovcU6qrQIPInWHXkrhlbJwC4N6UkAFZYUJGioi7oviOkLPT6q8/e/niw78tVPsprP7o8fr/+Yub6cSf13C1AX+Pvnnv/KMfXYzv+P5s/smzC3jwoDyfo/V1vAXZb5tWbSqyGtzQPMVctndJ7ZhFJFMT3LRbZU6oMhG0etVUqvVeOn5dQ7uLm+6Lry5OZzUAJBaR3HVEBSKUfBogi7x/zXBL6kqrfBKaM+UCwWWvagB95iqRXLYXZD8ugiS5lvgdnNp5NVOYoR+z/HvKejva3rqiziMn02IWo2C/4MVJkM97CoSs1pr0ROaf29SBBYS1mdYQBSQJgcNtHU6D93oO21MlVAFkMcG3iAgoYFHdjPh6Eclrdi9lzl6JgjnQEiFiGmL7djKVBnnl9hQIgZlN/Gdye+McvHNDdJqmxFn/DrBVxejo+CYKGoxwh0FNXMxni0mVWAAxmBpiePRNn8qPlXfB1QzgwImqD37V9onTqosi4tF1faqDb7xbDTFVIiKsLuD1prdsqS6Jiswn2312cL7t2qauHQiLT8z2YmNKKaWmrjdt21QhvwrhOjgA6CKzCAyePyb38g6G9rKklIL3iFSKenNHcEQMQC4rU8H7mNoyNsyqc8R32X9dZmbcU2XRvciBgvV3kDNvYzDVxsj9cauGhMFqxhDfD6SuXK7IEj0uV+1qsxkDunnrsDrDLPtmAQCRMxw/Rh7J0I/NAzV1yML2KhDs9hNadb7Zp1yNcDdfgdI83Osi1gRxEL/bv5vYtoyTXd1h0VOOxe8n88nzJf3v/sVf//4PH71TJQD4r//66g8+7775a78a/ScgLQC8fLz+zqP39J2u2NH4e/QOTOon15fLtTHjt3l4FS3jWNR4WyHfVGS+aeNVN8Vkv+mSlkI+xTRG9qai3clV/nvpptqhPr7uVLipa1XtYk45EBZTbevgogcAD4EkvtqvrpKcF/ybWM/UfQTrD2DWoLNJ68LG3CaVMb8BU6kbshu3MybcC79fSPyyqORTgRMAfFz3rs/F18dvVaf/9sPJX3x0QFiUNhJn8xOGWRXaFG0LP/bINZ+AEsERE5tpjIGsEiVmSUmIipqw2CgO4c2DzwGiDnkdPMjeYURaFBZIRkRQKTmrEPrBU9f2W3VwnlwSTMw2d1ue+fglbCtWkRST827aVCHUAAyK0zokEe+Id1M+LD3DpnyskDPTrk3fj4gjN62JRQgxsry4XtPWtTj3/CzdKg55IwDAig61AK53DoARXV05acUTqlJMqaoqM/9JYrcBVWEVIue9B5Gu66xlnVU0SOOVlUXMfMV2KwzDRLFqCCHG3EI0EwT4pax+C9aPafdbOBndyoV3/QlK8//smsa+vt2uZmb4E8J6nc+imw1v2ityHq7aMaBbU9T248VlgMhRBnlRAUegwgScBpQXgeARyQUC5yae0oDpvzT/e/w3BVj71IfgA0o/cv0tAvmqqo2vqHa1JfcX9acvN//5H3w4ryIAbLR+/923AeD09Ozi6ZOHJ3ATNTdd78EY3x+e0Oc3m7PFFG5BNB88xARVtWf/a6B8ZDirqsbIvj3I7mUP2XdI5GHq9Q58/1pleyfuoycvZ9N6aJMwIfYpZbRStimXJOoBvu9ml9Lfom9JPcZDWsZswt6DqtUdL5qxDnIsprzk/i/05jt3jV7tZzY16J6mzW2743fBA8ITjedvLASgme43uDixEppblieaV2YnwJx0UrvIAJAKsO6Q6YOjb8FNIqqIIITELCQeEVT9AM2gCo7cYNyYmRtRclnmYfz7jgivVNmU0RpNDzlo+/oYYYBvlrzxGs2XgsrWaHgct62qnHg2m84n1dBEJURMLIA7MYSIGBMDonNUCB+LCmk3rXeuqnw2BAZAzKpHVRDmJMpKFm16MpsNN7SskZx2tOm62aQuR5jUQUVVxQHWwSMBgXNEimB1dx9jYg4hWOqnyVoqTyrB5EZmbmxbmTQ4YoqIkDhy5BwzWwp2eZ+dc2NfZQFFImEB/8uXUEUHfBTfs6jszkvJSh3rII9z7kaRx+Q4jRZkKS7WTAi0u2KZRNKuKCCOivfg8e46/dg5yYd7eqNl9saRjo9lahZEFpGM8TObzWD73ncBjysOq6p+bz4xuDzLmNufzCdLgKsNvD+Dp59+/vDRe/Dp5/fvkeF7einfO1t88vglvH1/XGUfxfe4W8WPIf6QyemSjiG+9mi/KfX7TXskpvX1LcleH9kB4OOnF12XzhZzZrEeeK7CiEBzxK5DYObThs7WAW4R/46Buye1bekJBHOGMbvHUvVT8GN+phTgDbpStmdCBraT4kbvHEYvPU2bvbK93P4LTD+oAnTQPpwt3wkPADBMAV4AEZHwUEcbTBCRA0RyXeKU2HmMggDqve9jzIJ0RARg5uDJOWJBQ5PhHcsAEQrdkTl3sM2PDGpLk6fkithGxgQUJDEH74vyPY9TWY1vokZyKlpQjDPRj4DQ9wmyn6Nm4xkt+am401YFiMznJ/NZU617BkiV96rgCQChjPvbhsO0g5FT26UioEKQJoRZHargN30iIlVhxcqZU0LuW3pC73wXGVQb76x49/n4YIGFiVmEHeU0EhglbgdHkcUhTCfVxohLzfufruugritPFvwk4oL3KUZwjpwjJKPjsWC3tVJViVyZQSs7N3vDcSwYVYVXjac2Le7Bt0nd75hv2pEL30a+k2ko0xjiYTSbOq7ot+CuwgzEw+AGWsc4G8V5kIQj63sZCPdBYmlqJCyADgCvX6c3yJYBOF6FmtFydEdPshNT0XRF/shRun4DMF1B1/WbU5iAhzLLWt0iKj/E3OatdzeXj+cBP368fvgo//L+PQKAFwAnTXOGy3V7PW1OUkx32LyEqnod7aMPfozsBus7rzTp5XJ9QDTVo+t0yKvslfDl7X0dlP/y5U1de0+UQDixAhRvJlEaInYxifzmUk+CF44z9K+kZcb1y++6s7GwfQzxhzD9JXRbth1caSpubX6FSvEuMVkK9t5x1HkA+FJWAPBBV/kFn/1W84zhJbuTaRUIy2FR1A0qQJMVrjodUMYZb2ueJImFhR2RAmShCyICOAIWLESNDvJqGjSUXd8PKRo5rLmU+Spbv0HjXQAgxkRDK7vkMWW/F4DIkjK9v6NcHOZqQccVqG6DVXOstqlfYppNJ3XlIwsROPQOswmBiq5inE9qZdl0sa4sGRVv1l0VgkUOAhKodEnOF5OuMwsTIaLTadj03CfmbUdZicgRssBN2ynAzaa1PUcpEogIlIpCtPgB2FZCIvvgK4dQu7br2NSrAADEKbWMagEpKQWPPoSYUlnHxCzjd62DlVNm1YcVD5F0SKQpb5c9jcUxNeQXlKD1Zw22jT5pj5fnZw3Cayul7yDfx2f3bak7PiYdDDd3GsCESoDWWSJA66AaxKuwgAJ5BxA8mpbxdYgX37DvINXgR6KbQ2TfgQNfHYogxz/uFbOmcy/Gvzvy9v5r5FLfX9Try0zLPO79G6enH11dnQ60zCnAey+qj2768zlace6DfzX1NhjOjBnzPQQf43v515B97FcDB2NQtrbZJsY+eNMyHqVo7tjKWStmvV5fLtf3Them9HBQvu7oHQKSqiKIDYD8DjQnQl8Az9RlzQz6E6FrEqNTTmTbbn8I9BTEklQfDVOpr1RAPk3tE41vYT1W8MHo/JxpvnueYqXMvy9jax3UMeH+BKL/bnPpFwCgkzO4uZHN1fs/u5kQrSWvP6EKzIwmChdVVDMBr0IwTkBE3ljML5YbRIyRc8iGc8ksM50D5lkd2hgB3Vh8YtSJxTZVIRQmR4bGbBHn5VKRyOQcYJF4RMzcMxsUWl0p5lNWzt+R/RmMWrDjOr0QfVaJJwCHaHqYtu+bqvLZcFGaOqzbftX2dfA2qTSdVMyy6ZN3MJ9OK5ORZOwjJOn6xCJ5vCjxpqckqoiAIqysYPofRFe7rParvYssMSV7sY6oZIaw2sLmlZklq2gmdbB1IhBA7WNMvfkh07CkIXZ9b1bNdZX3Cm2MIupDYIuFGirxvMfS7B1vySEIhoFm85tnbkW+nv7xbQxP2jg2mXkNNaQexfdiRPM6UsjpdOqHCSYkHM0WKhbLUxIW0EzRMJNzjlzzdTB9W6G7WZbXT+/CGivbjVHZC/PcQ3YDSiNhSp7q1j14hHrwqqHQPQgOVXU1f3DZ35xV1fLpL9559B4M+XwG8d+/f/rzL9elvi7ixUO+xUibeIyTKY9VcPzoJcV0KJzf+UJU9Zh2H+P76wD6DotSzwDgsxcbUaiCuQmp887FaNMgttclVARi1anH35WzIoXclyQNEJ9lFZab2uCTNv6uO3vN00Ni+hK6PW07+ayTMY3BDLNP2TjhbwzoY07mqcrbZ428kx1AH8znb/6Ljz+7lsnC3ayTJ3IATVXFlCxAedBgaF1Xtcn2FQO5touUTRnVaGczqMq9SqDKNH+cI7OHohsFwJGWRGwqKRaDWL6Ei+quvbv3npl9CJqS9TxhiGdFUMsqUsgrwfBrKLa3mddmKROnhOC8n9Rh2jSFFs9qdgtgQuxiurxZL2ZN5bxhIiIRYpU9+9CEQCoaWargKnSJxTi8LkZHmGwLoxjTNmQ8IBEhK7CoAghgcOSosq3P0GJVAIwsfYzeq3POe/CucmTG9xaQjaDoyAXYqnUZlGNCAEFMANKK5V+rqidkEVah8c5sIMqGPMUtOUMDq4ZWy79qPLVp8SnIw2OdV+usPgV5Ajvev3eQ73fPNFkpZlOpVM9KEpP9KQ8xZfoFACTBMNaUFAAMGpFQbb7JHH2/FvFiNXvjZl+3xXd/Ud9Gaxiy37R933emqDF23mr2guymnNlbIe5mSMr189nsb798/u8+ql8+Xm9+OD/de2736MEzvlyuz4Zc79vw/ZX8Uk3bCv0oxHcCv3Tcxx7H9ZqXx8+XCxtvFgWA9aYv5R4LEKF5g/TM30B8FKaX3Ct4Q1J1fjzccSLHX/WjMH1dabDsjKTOwAGiIbsF5gHgvXpqZfu4/D9KuH8J3ReUfvCxo5sL+fY5/fTiwSeXAPD+CTWKwqIAjsgRuirYfH+uEL13RObP5WibyxFCkGKoCyAIfphi7xMjkk3KFM9YVnCoAiamHznYZGdaoWGUBkoUqhEcA9x3XVfCWrXMOOUhzAzJW0AfuTua8xch1HVltul+iF0DAGbRoV+Kngpds+nTrKkXk4ZZQNWM2hWg8n7LwitElmkdYuKUSW0EVUdYD/r9Td/PmsoT2u1zs0AVhhkiLl7HiMGR844AonAfozVChVnRewIaUv8sY9Y6CpWnPuU2Kcc0IrqAQSVGm/gldI7UGOmIRlyUueMckRiqKsWIg5p9nLqkRbvyNU/HQrgbM3MN0VH1Sp37uHI3945yWa/XRQfZuCM9S2/0S+4flQq9gDJm3Yth+i+neMk1++3K66NIdD6bHUX2sfSw7aUU7Bzl0AzSjnbUeXFPHLnHnMS+X8ybj541X2maJnfxrH3n0XtPdw3cf7AI/2K5OVtMDdYN2QtMv85C8jqMPOz6Td5x2cv62KOqXh/xL5abru9OFmesCoR9Sm3XoZn1oZpKuoTMve9r6EFSQh1RH+iPwrqpy5sWv+9mY2XLNclta4DEZEGpM90lZIby9oFSKduL2OZQnDPm+gHhgy97v948BzBk3/zObPKnq0ykqjrvCYQVp3XV9tH0iE0VmAWVCV327EJgYUc5vZqIPCGqG8LedNMnP0gPwTnSbHxEzktKxve4IstTta5gzvQYhIyGnqhaglKRsnRv7K6OiPnwilsl+6BgsbZQ8G4xmy6m9RjQDawLtDlHXUxdF1W1Dr4XVtVZU6033Sayqi6m9fWmQ8S6coEcACwmYbmJq7argjOtZIWUWFikIHvXJ1tdVj0PKmogQEUETnXlgdyqixZQHvueGac48cHFXkVyEiEi9imxcxOPiMAADjFGrb1jVKO5ur43ESqVeEJVAixdjciMDIgKRA4pQTLQL0rQQso7JFEREUdk+SV2Ip14dweyt40esurjVuor26oF8QtFs0e+H0ZzjL1/dxqqI0xHBXQoVqQX4uXr1um39Utfk/k1QmYxb+6A9VK27zSU461v+VgWeTdLM6a2pyf3Pnr69N96e3Hx44++85/89h6433tnGv718xRPx7Beqvg95UyQ0jDox2yMFeazEc/+mnuLX7qQL9+G6S2Nmi9erkPl6+BTYmZJMfoQRNLJZNKzdDG54cvCiX94YHyqzhNti3cDbiu0n2h8CvIQ6DfCaUF2iQnorrL9S+hOIMzAGe1jyU07VJLf2TAZsh8dbgKAp8MzS0tnyP78G2dyej6Bj99b64+yGMMBgENlxcp75wgJ0My+KeepJlVvEKngiToRVWVh73xUNNm7txRpBFYlFVFwlOXU3pmHjUkYwbKBCDU4h5jzg+zfddeTLWlezes8t3xLyGrJ7iATvegepwcA0yZUvppOKj9M0qaU1eWrLm7a3oiIKgTQuNy0mI0lcinNot77WWMsEDRVANTKexBlkTZKF5N3rutTXeVy/v5JDQAvrztr9npC7ypCravAqiLM6rouJmarysm5WYNdZI/o6hpRALRPKiJVHQbCBAmBmSNCcEQKfUrekQIoIrN4p5V3XUyOyIfQd52O7B+IiJAAs1qm+A0UQCciBnWqw6DAtgWNSDmo9c6AvS8oHYaz740yfa1LJQhguwQEgeIstj6A8iN8CWvx3hRHPlRV7XgP0PsoZsz794Xsr+R/7y/qsc1AYa7HokNDt1nwK0iHsF5XUwBwBxLIo1X8bSqXh/cXX908v4l6EzdfXWzun56+GJj3K4BTgDdm4fl1+423FuNSfXy9EDXFecYClUpIE9w+BnU3pXNUB1naqmO2vXHafh15+7OLi2kztWquTTE416eE6LQ4SRknwOJQP+gqqOGGYDBsBuRkFN+YbV9pWg1cw9sY9gTpd5TtFr/3QMmQfU+QM0O/0jS+OwV/EtOl9OPhpj0R5LtD9FhaustfX0x+91fXXSx7beccILICaQJywQGAgAArioKT3NUyUXblQp8SOSDG4LKGxROKgnekqn1iR5QN0PNkCgMSAln6ByE4VEWHygBoNSSb8iPPK5IgkILzXpzLjgWInCRJ2rOGV1UcKT76lBBgMmkq72ZNZbQPKNSVs5p9uWlv1l2ZaDXdxGLSkCO/mwDtBx6/Y3l4PumjbHpmgmldLzdt8O50Ptm0se0iANTD1/7eSf3yulNrC2O2BHAlY1bJeyRyLFw734l4Y8RUAUgRHWIkisIOswDd4LhPbG+md0RD8KyqskpwzjtiyRHjYyGjMCvmWKViK4ZE3rw5KU9fJ87vaplrNUP8Qm2dT8NRHeS74r84iCm9Q9XOor/EUJRet+NJfjiYY9qeCw6lCWE2aU5n9fliem9ezSaTKtAY2QvQ91G+HrLXr1WwG0XQuGwWdj6bFVvEcQd1zGjb71/HSmUsI/m6tHtN4Bb3PlvdzANef/GxJWKP26o/WIR2/bIU3Xcsf51kYU9NeeV4TU7mdeQ3471IEcyU/16fiK+JL5abPsKk8qraxyQMRK7ySETrrjOnJxFBkKjwRqAPaDaeTTWt4T4bQztfm3/gd8v2XTTfu+NH2BXt4wy9Femlc7vSpM6PYz0adNckR5G9dHQf7o19i/rgn3/jrJRjlD2vHQIFH1hRgBxm6pVFjZ5mxT4lIkIgVa0r71At0IIQ3JBq4h05ZyK/LElHyMUgAPR9InJjv5d+eJP7xF1MjqAiV3nnECzKI3gK3leVN+X7UFpiEeSYAif2UVjquhJJXUzLdXdxs+lTcoSG7G2fbtbd+WK2mNbzSTWtQ+XdtA6TytfZKDgLu03Vnkw+D3C1im2UJAqizELkHFEXExHWwVtKyLPLzefPbs5mzffeO+liWrW9sMbEKaY+8WrTrjd9YlEBFDF6h9UEo8yKmz5tuniz6UTEIRESDmirA45bEKtmL08SQGElQnNJTsyOqIRZ24rHOQYXREBFsnRUxI6QcWbXYd+it+0tzlZod7pC7pm2H0X2pyC/dC3/+RQLptt/+1Az/JJOZ/XprJ7X3jB9jOBJXVI3LuHHxXvJ1rirZt+l2o/C+h7KGCHTiaV/QE37he1e07KgdiHcmzqX7XbkqFSmnF4J63vG8Z3AyXzyZesA4KMfXaQTXyyC7fLBO9NzTF3SQFtkrz0edlaLGU6ZrR2/NDvC3duIu/G98E632R2/5uXTZzfeo1GfXeSmCkQUnLOuu+0PrXjlxN/H6lGYXpPMZUeacgcl8hCoJDQdOhbsqSGXsX2i8S2oV8AzcIV+maEv+F4M3IvrwNE+qpXtH+p673x78MllHW8AYPrbb509XJhjev5GOVLVNqahyBq8djGHi+IgFrTwaRYVoKHoAwZERAsss9n6kXlLHvkmzN9n1bzcsWjwwSapymJg4/GC5Ai9IwRCEEfgva+Dq6sqeD8khUqfUtdHBJxMmgdnJ6ezydlifjJtnCNHsN70Fzeby1XLLDdtfzKfjp3brb9a5JQiyqoi2xA+kzyy6M2mW7V9lzix1EaMKAACEjZVRYRV8Itp/dHT689ebGzfUAUK3gXvvCMFco4cIRIA4uliGofsKoekwohYOXLOVd7V3lnOCRZNuqqwskgsUihVgmzYAIRmuEaIwZF3joistjf7NhEh2hbm5QjF833sr7BlhIYq+24n99e5nDWvW7DvzTRt8ykBaqf232EJb9dpr04/LNLvYGNuw/fb2Jg7hDEF4g+VLaVXOR4X2rN3t3RsF8hg/Xxev7kIk0ljYsqAYv/9EqaJoari7P5XmgBg+YtnzTvv7O/F5u5yuXahigKHG5vynH3wZTsyXq7seorp6KaouIbdvRrd0UIo/Iyto4er6Z568uXValZXNoMemVWli4kVFUgUMUu2CYFY5IcDKXRDr6jWy+VQAWmAfihyv+T+OUpRQFIIY5KnbBRKYmqDrsRwzw6sbW3W6SnIu+JPIPjF9qs7/W8+rAhxeoq/9w1CAMw2rzroGhGREDgXjJhExaZeRAfTWqi9V1UCUVVHjhBUBREtpyqxpAyLXAcXyLGoFZ6EwCYdURt8hSo4VKbid1JCi3L2tRKhI4foTJdsZmF916eYSOFkUr11fvLWvZN7i+m0Dt6RIXJd+dmkCZ5mdVDVZ1c3hGjJSqC6buOq7ZdtvFp3L1aby1Vr+3qP6AhUIQ0ui5Fl1basGRm6mDY9R1ZPOEZLVm27zhqqPnjr32qe+dJZU9XBT+tQeV95d3F1ExMHguCdraOeMLIwcxdT28fY95wSjEcBEAGRBVsjZfPnBCzKigAQvDerxzr42juHZJW7jK0FhpSrrSfzAPFjsQ0SGS0jIk7V0dfmUg7r97bRMVLfhuwsOsb3EwjfaKFdr/aK5kOgBzjWySrVukf2x+D7leTMIRtjj3r48Idyjtv0ggUic3/SmA2UgFJC9c5ns8bp6WQyq0NV1YcmkVbV9semmcaPa4YwxRbmZD55dqMnTfPhp5+f3zvfu+P35jOIyz1OZly8W5/gtkjrMY7vLaOFuy+v97bi/ejLLJBd3mR7n+/g3y+Wmy7FUFWs2sZIRB1rn5iF7dxhEUJtqqCIc4+/FecAcC3pkA0/5NM3IA+BHoWcyzEeXDo6viQpXUO0zJqjB19pOiE/tgUuZfuh4n4DYpzMBz988Omv7/Tq7y+n7331CwB4+9783iwAgIMi1GPD6xFPyuY21cXEIpV33rmyTSd0e/SIzf35Eho8PFsLXCXnRdTMNY2U947Wmz4a/U4UvHewVamLsoIAKqCySNu2y5vVzXoDAItZ/c4b57/y8PzNs8XprLZUPiNSzBbxZtNfLtcxCREtpvX5YuoQbjbdJspN23tHszp4B56wcW7T98+ulst1d9P267bftP16063b9mq1utm0iVVU+yhJlAHXbZuHHEffLGbpGNbrLgrUubGMxuMHRzwyi/XeDWaZYOpJ78g7SirMnJgr77wPRM4MeyrvmtqzgoiIKqvGlPqyC0R1qKAydB2234SSu1SIGpOAGS2TmIdWs1gox9hRwz6/xDyhvx9X7cLe9KR75Xn5sRIsC4ll7DnCd8WHfnMrjIzO7iNP1CP/XZ50gwy3Cx9vo32NVDnUMhZk3CNkaoIHJ83JfDJWvzQVTSaNHcQQvISvvlJFc4f45GwxfS7uum1fPl4/5oj3do72rTf9qWyuVvsLhuF7ec4F2Q/LcLuZFe+3bZMO79X2UmzI9mj3u99w+5fq2R4dP6vDV5drBHSInJgFHJFxlIgOlOd1WDSVyUii8HuIj2hilfJc4DaauwD3NURTQEpM5sd7TWIQLzHtUTSX3JsC0mxR9/Qwt/H7pWwv/43L9muIn5246W+/NXsrAkAp3u1cWvTPZ//ln73BZszrnBu946hdTH2UyKJAjqAOflJXdfDmHOsAYkpWxZd6X03mqALZ00WRAFQjC4M6VO+dSepwCMizrYAPRA7MlKYk6mWKBkgYVpt+uVwvV2tOqW6at+6dvn3/7M2zxaRyABAFNj2nxKyaRNsuXixXF9crZp7U1dliatOJdfCzpqqratN1fYyTyiNA5f20Dog4qapJVVmlnET61J/MGu88kZ81dVOFylFw5EiFualCEuWRvf/JfOIcVd7VdQgEmz71kQFgue4SJyQkBVWwpv267UXVO1JQOXAomk8aM6gRFRYRlT5xTLpVLgKoahLoWfooSZDFFP3J+2D43icuno48gHj20y/FxKCb9J5suGErurUfCO+Wytz9pz1lpDEz9t3bU7uPf6wE7ccynvrwdm3ZHjXib5PBJJvaVncH1jfTGaxX2+zTOy93KGQapxx3/lrMcu+wbfHBnwV/uVz3vYTgtwSFr7KG3VdVFWz8Z4x6fd8dKiPvTtVoTh58vnry/funV3/1Nw8fvff05Y4m8ruN/5Pl+vTheezyXiHQPkUzRuethGZH++gBwIUqdr3dfdeKwAfJoXrjGJC9nupeH2K7cI5aQINR/rauN+rm5UYev7jwHpmli2xnDqtUpgt05L3btK01vvo+/m6szprqknvktLr9rZOYlpxJ8Ec0Mbhf992l9Echu5Tt5ixWrH1f57KVSO5GgNoi8W/q/uT7i5tlj1U1gdViNbkwa+zfd/HRr9F/8UePrqcwbU2gAiBdFPLOhou9Q+/8wEcbbeJAgY0fIMwDjQjOlHaIJpSMwxfYlDY+kLCC4rA/YHLgacjSyy4u+V9SgWyygGanuF53bUyzSTOfT0HVeecQvc9FURtzLFQSFeG2S5aUVFfVZF41lrhSnM0TxyTBoWuaddctN/208mbuyCzzSe2HvsJN28aUZ/0XkxoJVcG4eBAILk8yr9pUV84hqsJ606loFVwXUx8xsXQxAmpwRERm6V6Y/TKRpKAxcfDORk9RoakrGBnHlw83+58NIhkFYE4igo4cgwCQcypCtuMkYmYEJSRE9N5771kFRJUZBl8H+z2oxpSKnbXZJwZblgVE5FHtIb1upTuWypggstj/Xrb6BOI5vHqOaWdvLf3bGM6u0/IMX2ny6seqmDHK34Hs5WZ71M9dnAPjbfg+xpp9kOp7i5y+Y/LzbDFtexm3E6OSOYUVduIO90TUtq6npWl56MAe+/6y79tefrbk798H8xE783SZxP61tuo/+7MvXiy7vY3C4eNmIN7zw+kzWRSV7i/qQ6VQCd7bc5csBxzPr5qLzh3dhcN32yD+4qa72aT5dFJmuEXVARJCZAHy6y7aPEQXEwD85uD0YhX03pT/DvnOsEI4gXDmKuNkij/wNckZQAnYg8H5a6XpBMPRsr10a9eSyphr5cOn7XVh2w+3ERuQv+7jG5MpAOjk7Pk39P6P+hMIk2UtTXNJbr6arBDe9/VHwwshwgHZPYEM4STkABhdZAlEABBTdD7Yvh7UETnr+dnQDhGJMlm4CaiwElE2LlcmdAQgwg5BiRxgElUQUIwi3oGzCSZEJFitoyjcP12czJq6CutN5xzVVej62EYZdVPZGAaPdDLLiG28f7EAE5FeISVOIiwwrb3zrmeZepdEiFBEelZyDkARPWJSsdQnkMQ2rqUIFtptFHlPyIld8FYK9JEDEbOoSh2c2c3XIaiCQs77lsHKERGiSVcUnSNVaKM4Iu+IVTxRz9uTCAHIOWYtzgt2cHTksAi7MaqqbEtvUbXYbhqZPrICDtb56OjQNyYbwefgWXmdbuoXlO6u3w3fbU71l1ND0k0Hr2H/t30S5APsMpW31ey2DLTqmq9D4NxWuY+xhqNc32xO5kcI93G1W8IrRgBXw27OnCGszQoNivIeBpvfQsh0Ebu4yac/QFSyoO3CEc2CP5lPHt6ff6n3fra5eRP9lzfP3nrnHRgGmgzl31/43/uP/+3f/o0PzHSpPLebqxcdR2kjAFATpI0XNwwAfccA0CltllfPLpZt5BTT1aqrPVq10na9H5wgVwDLm7bvu1XcKvpt1CugHFIxVVVXwwsco/xt66hZjF0t11muQDSt6aaLNslt04/MDMV+wLk58LlU40FQ2+mZ8ByGGNXiLfMldB/QzPjxdd/tJHbuergXdmUCZCl6+99s781Gf2w1cx3bUrYfEu5FZvDmH32J/x7r5Gz+vQZ+1D9QWv4vpvAP/lG96ZazDQA8eF/gF+C9kwjBgRHEkj2AwQ0tQ4eQFDoWUEV0okyUZ+iGKVcVBU/oiZKAA0igrBgoay4COTusaJ7YjCxASCACpCie0Mp3cxXYdB0hvnn/1AZKV+s2sThH601nD7fuYuKUWBFxXnvnQnmDRTR7OyooQBdTFy3lWci5ugp15c0UrE1s/QYWDY4QQUWnlbPZGYdACOBcoV/M28u2SbVznC1zqYspiUDMxiwiMq0DqPaJFaT2QSF7jUli61SAIrOE4O2rEWOc1DWAEjnOsA8OaTA6VgAhJIEcFZsHlPLzyfwJIJl5eWFdDNlZBdUK/BxOEkIAzfW7HXAY60R7mUgUheeIX9d4YE/n3rQ4tv+9hjiB+mshu3WhLFjpdcH97061G9zfpm3fE94fxRoXaK/kLCF2Bd8PJ/vPFtM9O9wC+kVRbhP8BR+tqWiy+kdv3b83C48e3j87nU/qqpkEADifu/npGQBMZgsAeOhX/98fP/tn/5f/25tni8uX3Xcfndu0ainev//u/I/+/McAsFlepSRdH1n4xdX6xeXKCvBZ7cdGvimm2SQ8engfAM4XMwDo+jif1tO6qqvgPYUQfDNNQ2x3jDElefLy+uZm3SVddanAfXlFXb+2bkfttHE6ZtX32ht7M1+Wgf5i3QMAobYxGRXJqoFIJPt/A5EwV961ZikzBK5nblQARvzJStMCvPnuGuV9Qn5btiMe8vIG/dYUzRGpB4SMrRYzcGPxDNyezFfmWp9ofFf9B111+ZnCb5/o9I0Xiz/93r3p4+9/c9lMJwDwv/l3Jz/9q7f/4EtWHsfgceqRHKEDZRgFTNfBCSdWtPfKWQGG4BS6tGVsVS0EG1TVoQKCCBPtM5lmOMMiYbAvRyMrEAiEWfuuu396oqoX1+v/P2//GSxrll2HgXsf95m015t3n3flXpnu6q421RZouAZIkAAbpCgGhgSloREFTpCMIcUJcSQFqVBo9IMx4ozICYUY4swQBOgAECDQhGmgfVV3V1e9qldVz7vrb3rzmWP2/Dhffjevea+qGtJkZNzImzdv2i/X2WfttdfKTS6FqERhaR7QHaVRqOqVcJRpfkDdN3kiiLmx3hbYGAOIUnDBZSC5D8owxgrGcq37o3EljiRnnp9pxOryybnv39rJc8O8eBNAWwIiP5rljWLsZN411ToOAr8SaGvJOmtdqBRMQvi0g0ybSqgGSW6dk5wh4WQujEvGnXPWEWdMMnAESORcMZpUdke9diXXxhrDBRNCMMa8ZaazFkUx4munO6JlKqGf4kUwxiilfJfVkWf1yRjjQ1PR27mjT0oHr/1diMSJwQeO6XiUpP3x9pCPuqsZrk5YcS/X4XuZM4k/CqB7tt3D+j6+8/ADiSCncda39Y6SD9P1+1Gvc4/vo8wA5D4se6KKAYCkLOFr1bASVH1pLKSYrUaVOJBSRoECgCTLtdZJkmU7GgDeyvJU22w87o70MM2zbNwe2+EePNmE9sa4c6rjp1W97L1r3Lkq/7VvvPP1N2/XBfUNuiTtm6kZUSWnRUSNKPKv+rvvbvhX7dE2ikKvBA0Vq4aqdDXwtbz/NQxUtSpOSO6XgSzXADDO8uE4640y7wyc51l/nHe6e94gMyUOOg2VDAMAXmmA87jvH8t7SY4y3RnmAMB9CQnAGCuGEktLLGu9MJAcfSIRj4pgKewHtHHG7IABhG3INkl/hqsChQ+W7dNaF99u9SzKPB1KiIEmV6Hg3XQAk0S9rs2bXIXIuy73Wvhj5e05oy3rmiFCBvP3ursfPh1IPvND8wMralfv559chTCGJKv+Wh5ahMBbaLmCFme+S+k4AkMObMLmExFjYCkQ3E7l1WXGMg4cILfWCxa8w63kZbrb1JNEYMi1dRwsYxycBQRGzhIiB3CIDAjYaJRKyZXkWaa7wxEAcDRJpuvVai0qJpiakTw5Fz1oQW+cl6lyQDTKtH9u2hgAJgSrhIEUnBc+KmAm0sNMO8ZZJY5K13Xfnn3zXmswziyRIq4mLzaQjKhwd/GdW985EFx4h0hAREbgGCJacgwL6wLJOPL9zA0puCUHAMYQFMmClgiUZF48Yxw5R0JwH9BRvPGIgEwIYEwAQGmJPKFhyM8gFGmIwJwzhMC8M8PEScYz7F4qk+c5EKkg8FSMBSJrhUBHRaIhAFjnnhwgwA+YweTrdw/0npkJU/xAlEzOyG9Kl4HZ3Lw35/7IO9KOCfme5bxnZkp+JkR77H7hWE5mWrwxrZOZRnad5xqgpKGn+5CZKeyQimnVPE9zJ9FVKpVaNZytyGo1nq1GgZLRVNJukmQAME7TcZbvdAat7mivn+51B70kSTNIc33cDkBOyHH2dnfw0vLC9nB3qbEAvZ4v230J//lLzd++PWo0mkIbG0WRL6Wnn/ZktIpLVpGTXbx25SZGovNQm+euP0x856BAKG1G6YG3a6ZSWZ6rBgL9ywSAp544DwC1EAcpmXScJNmD7bZ/gZ3RaJRSlo/T8SgdFxxUoxYDQBzHvsAfJXkQKMYFJ0NTs9dSYJZPa/sAGS4DO2Tnu49X1gATxMWOK8iTTdCXMfZkep85mOog1R0DfoCW6bp8b9IsmWbb/S3L0dYQuRKya3OnTSofqdXxZXvH5evMvJAVhyUN+lkcAMDgyqm0uuw3i6Z1D62JrszW77e00VJIT7gTcgDw4GsJyDrB0OM1BwQO2vvZsn0PAA7AGEdrfZgqRwLkFogf+Sp7ZsYT7kBTuI/kHHnjAwtgtGk2a0Q0SBMPppaoJrBikr1eHoVKMBxm5kErKZsl4zTXxnjRH0cuBUZhGAjm6fIyTclO9N2GkBCQSAmeZDrTJgwkdzBOc2Pd8nxjtzNQgie5N2ZHRKe4EAytdQgQKIFUOhODtk5yxpgokNC3g7FwceSC28nIkiVHDpTgKsTCv4wQETiAIWts4WhvCLI0LyM7SlDcz9DwdpKOmBDeec0RccY4Qm4d+Q+LYRmETQwFcq0159wUIa5eie/FYUW4XJnaYYnE+zODLB2+DhXs5a/dlJaB+f7qJumytwRTGdnvuU7w4egDcO6HGqpKMoD3hewflHx/j9Upz2pT9rpHS/gS0wGgEslqNQ4lDySPw9CDuK/EvXy13R10BqMb97faIz0Ypp3RaJ/BmK4Zs+NL7CMneb2bv7QMezeTpecPivCMe3Ze/d71bn+ce7A+9BBQ2hFHERzncRZFoVIS8mwa06f5dKvzUqsOltr9nVubOwcXj+txHM9GLFRsaaZyannu5NLs2RPzUa1h0rHWejTOptez7e4YALb7WfmFDAQY5/z8JVpLuG9si+C7X0jE0NHRoQw/x1R1xxTOQHBWTOTtfhRl4sZeMioe330rtY+FvH1aKV+mNY3IVFAoIQHAD7uOyyXwuCM2Z/SazU6QEHVrBtwMOLvegaUFAMjrq5qYJJNkebh0duMvQj2Yk7/UHmdGCumLzcn321uJeR0O8P2gY5STOpQzcM4GgjuyzlnJeZZnjHl/eDiK7F5vU1iyOgtcFEa+jPEJBgkh8ywLAqGk2NjtWKL5WvjRM5Uff3LuZM01AP7du71/+Xr/wVg3McpyIxhaIN9TRcZCKaUQnOPEnBLKfqOxThf8DxCiBXDOkoNKqJBhboy1LpAiz3MA6PRHXHDBWSDYRBaI3sbAZ14TOQsoHCjOjJ94AkK0kgtfGmPxboJDBCpGXpFxAKsEd86nkzK/NBoiC94wGTkjxtAYB5MMDYbMwdS2jsgL3qUQAGDIcX8AI+MI2jpLrnjzp1gajswYz8WD4NwQ+SlWjkX4u6drYLIhM8YoovepdHwUIhf8+0HQn6bdH4/s08aQJ0UweK9HFEc1MO95evwtHzXB5MmZ6RK+JGT271koTfuCP6mKGCZfmw+GqYetuWZjZbZem5mpea1oZjNivlbtDEYlQdEfJv1xnh5XQfsiGvZNtcZpdgzWH3pdYQC7idsYJKu1CACmfcR88X5hLni7N0YZZ/k4UHH5uNOXp/co0/NE+wGwB/Hd/3qoFRFyAhUfWjn8eXPbbzK0zQ1XIlQyjCsztWi1Ic6fXJhrxCeXZjuDURyocZbvdQbtkd5qDZIkbVZOd0dprl1vlCXaFj7mDMEyzpg/yjnD3JiqcGfZMc0cj+yeKC9luV7R2Cw5mSPql0Ot1DI2rwLcd2WntTRlRZ/vx5/Asdnc/mmMyPiy/cNOxYPQt1Xn73XFS3t0bgkAPLIDgJQSls4K42Yj3h1lcWAAGRQkLfMsjSUgIlGEQHlkmRSqjAkuYFLXkbPIeCAfbR/ku5AInDkAYYGGSRYGQcAtOMaYQ8YJhCMaJBknWlPZ5z++9Nmnlp97Zu3y8iIPRN7rjwfZk8/DT16++v/8TuvfvjUAhLl6tTcch0FQiwPhfXUBrHXGD2YSAaLx4SGTAtg6N0wyO4ldjQMJAEqILDdAWmsTBIF1loMwjrR1jCNDpq3DiXWXdmCdBXIgBHnvcM+jWgCyPlgDvLskkLcAM9Z5Xy9nUdsis0kb7aeZBGfGgZKMMY5E1pEj77vr86ktTDt5eYPMiWeAZNxY6xwIAWluff1ukTjjMJW75J3CjCFnjQVABowxBgXnhoUDsEAER8QZamPOK/5+RJBldf8+zSA9jf6BBJF1kGz43kpFcbRmf4/KeurGpcL98cX70Vbqo6QyOeR+3LQSiFIi4mcimrX4ytmTSysrxXGTjgedzgAgy3V7mAyH4/ZIe2ZmlOnOMPPwGnIIOYUTjvtYxv9oiX38LTMIA8hZeG2kV2vRu/cfXp7EM023VV/b3MNqpazTG1FUYIAqEP9oV3P6eg/r0/heaHtMPrUU7a8KR9ePRi3O8nEYyDKXPB2P7nS7dx7AH37vDgB4xF9qRvPNWq0anlpqXFqbTbUFAP82brUGW728O0qHw1E3MbnJHSFnTHBElLnWpznUmehPgKzqirJ9yPYr9wrBCKFCAAjTnAxj4qgQvsR3Z0xS+K6gZ2/qjnkrG6dNrIItloOFumPjPGNSlLrJY2G9gmKEsEnaEqXLlfE48Q9TG0Xwv2zO/u0rqXN+q+fx3Rin33j1ZN/dQg4ggJwjy5CTc44s8+Ym0yIfZzkXQORV22gdTQhZZLzkWDhjttSXAHDmCERhpUswGhkLdqbCP/Hs0o07e5tja1EEQiRjLSFbm4s//9TZz3zo7E9frNXmq0xKv2ju5tQAiGsBADz5/JX/8ZnNH38r/dv/4tp2t1+PVC2UkeJMSGcKlWS5ovg1xRR1g6nHwWiUpVrLwq8fB+NMCF6Lg3ol2mr1CRgHsA5IEBAESkrO4ijYafezvPCj4AjAeZplgjMA5sgCciDHGXPOxkEwHQZiibLcWOuE4M4VTpnGgXVUBOsxZgk4ByRmjNXWlUlTRAQ+h5bITWa7BOfImDcnQETvFwbgjCmM2pExTmSMcZYExyTP0RHjrDDCREfOIfBi7QEERGMteq8yQIZoidDaNf2+8Les7ktkL1F+Gu6ncb/j8qX3oZkp7Qo8jfOeghkBB619j6L89JVHjQfKbur+9hyg+j507kc1eV7bBwBZNt7KHQDUquGppaWV2XoUBV46sre946HcK0aO8jahYqEKKoHc61JqD4Ogx9DAjVDGh9JWw+D4gv3ojuT6TvbRZlpvhzARvJea93NVPl8VGxOwDjnVY+XllSE4UHHID8hap814NTGYsiM+VL8f+y/lKzp6+ciewwO9LPclN7d6b95r+4O3GvClucbaXLVWDVdnK6eWGl6XudUa+m5EN+W9kU6zTJs8y/LTTDWV8iHUMGUsUyJ7Sbl4bL2ClfJ6X7aXNzgU0+E5mWJ/StTkwXTZPs4zZ3UFuL/SaQOKd21eovn0/UxrEsSarL10Zqs4zBT869dPjuppddnTd3Nf/1btjf5bL8Rw6Yr9+vBk32Joy27n/gUCD/HOFaJF73zlBx19yWmt5kIdEsNY5zhzhAWgEwgs5qQM5Pnf/bNPLCw3Gqn56V/827d/91d++//zu//2znBnM/vkJ1Y+++ITn3qqPl+fAYC817eZtpnmYQwAsy4ti6m4FvTx5M98LKk2ov/sn3y3lZpaDKl2sYCPX1r4w3d2x6lhDGzhF+T8WCYhoKPO0FnrIqUk50IyjszzmYNEG2OVEoNRknNWyAF54frbG4z963XOATApOCPKEDNttCHfO7COCCwyNs4MkROcARHn3DsWC+m1NqWnLgnGiMAzSFluHHmZIgiGxgEBWCKGyJkvvYtS3TmHPpAWOYCzPgq19D5zzk3Me51zQnBCkEJMtqGM+aklrT2TU1I9oqDyyRExZMaYiLEPpIAsh5Ueo5b5gbuyfgnZfv+0zCGUL389RMQfwvdDyJ4SDzML8Xvr3EsdpKcpfLsvUFQJsTo3d2ltdnVxVoSxFxe2Or1Wb3OjPZrOJConM6VSSONci+mZoCgK02F2CPiyfFwXhDLmkoVQCCKnOZPHoLyv3MMA+lmwbmwdoBS8l1aRTcHOzMqNLTdTDXKTKxH4fboSKoe8IsvNPBxbth/C9APMjFCJfr+p6eWLfQzRVAuVZBpkCDrVjh7udh/udgFAMmw2mzO16PRCfHqpdvnUHAB4oG8nrjNIdrrjNoz/6d76WaeeY41lEYFJnDFDdqBy9+xKEZrKCk6mJGSmmRk/x+Q5mQ4ncIWSt6yRD9Eys2FlWmBTrBNTdKpH9lJG2U2ptrwCJbIDzPzQvHzqHDGmAp4muvZGv3WXPw3j31sdKoBmiArBHpxnKaXuQMC5JOf8Ml2OvSBDAmccBljIY3zNDgytdaMcHOlYCY6Wc5Ebm1ka9Ed/5Scv/8Iz8XBjN6zX8q/+0zUFf/qLp//S5ee+8ftfOwV2/smZcKGR7vQOqpEKpOCBtJPU3DpxENUffRL+xV+6+F/8yr1r24MoroyT7Lt3WlmWZLn3BqBSRuKRkXPkHGMVILL9SXsibyKcWScYcsZyY71KnRwhw0KPiITI/VeQHBnnJGeMC22MV1VpY5gQHEBbB0DG2UCJYZr7zrwzBMIBcGe9Wgc4Q22d78QCMs8jWUDBUCJp61jhx8nIgSNHPuYU0VrLEAtCbMK/Q+GwxopB04ldOwD4UHIgMtbaPOec+1Bsf8g5a2GipZloUkEbsxgJPiJwf1RQ/qOc6iB98R4zARbS91JD8mY1to44x0Ol+vQ1038CgGP/JJD8TxOAYsdQjZbQEpaOuR7ZU4vD8diRXJurvnBh+amzS1fOLp1dmZtt1rq94d2HW+/cfHj9we6dzV6rlwyHo3LbOz1zzznXU+4FgqOxpATnHHvDgeBy6k9SkEYua6HMtDWE1mpr9aR5BR5z/IXScSgM9v/kmUTu9NPnKmli5xt1MRoWQOModcSluPuw68LQywo5kj/rCQoooayz5Ci1OMoSALBWCy7BGiakAwRnlAoKdwsAzoW1NjWacfT/9X6Og0Nc0/TL2ZeWWucjc701IFcRFxK4SMfD3e7gnYftN+7uvbve3+kMGcDyXHVtNlydq5xarGkR36iqV6vmO3rwwHYzbSpM1ZmQU2OEI3AVgi3Ma8ifDJrjPHuUT2QhgmR8rLMO2QA4ADQJF3lY0jXImdc55IItBpUkK9a5HpihzRUyAFDA9FQIUc5ZjtAn8w02PvvCqaXOuhYBBkEF0uj8pcrCEu+s17795vjkiZnv3g4GEWvom7SH77jUuG+CDqKwoHFpf86IiBLjtLU+5GHaHJAcATAiV/gfIigpjLHj/tA589QMf2aB73WzoWHGuotV9/FF+hE2s6jp93757nde6f/WXuutNx+O+v0Zk9evfOTUp764e+PWjavv9EUwt7AAeebRnAkOADbTTHA7lYfu/8RUdGJl5U88f3KUpd+63atGQXuQNioh53yY5pxzmihcJWehEkoIwbjvdgIiMnSEymsujbWWfORImudSFGYEfg1NtdXaGmttEWRKvoXJkXx6hp/RLVs1CCAYKsE5821OIoLcEy6eTAdwzgruzUeJEAHRW4s5AM/VCIHIhDHOumIq1U6itKmIcnXWTpAdgLzYEcABaW28swKfGCObCY2D+1lLuG90QCS4KGwiAE2WrXLWNFB//7EQAoXZPz5qE8O4GvLhkSWihpwDk++lizRAAXCGGALvUPaw7thj0Z3PNSq+Hi8h+1jsLtu1x7Lz04R7LADYI/tIJbi3+skoNRdWZz71/Lmf+PQLF0/MBFIMRulWe3hnq3vj3tbtjc7mbjfXqZmY1nYGSWaN9zMSHNPcCY4wUbOmuRsnKQH34O4nJpDBcDwWXAZuZFEBgAd377bqwd2XuoJLwWUJ9CXEH7U/EQJGY31hPooVm2/UzWDQNS6dNLJnFLvXGvcoqIWS4z7WIBPWWSVUOQHrkb14Y60OpZRS5CZHJjzmKhVw7oe5hSPkjBtjDOEHRfb97tahF8K5YSoUaKwDPwiq0wLuVaSkVGC10bu98d3Nvbfut2/tjPvDNBRscSaaq4jZWlxZbdyr8a9G9qoZ3UmGDN0SqCZTOcehM5KLt934AsbLImqRdsbgox31UrIDcAlZzy02eVgHTs7hRB5OzvnlIQKmre0zFxDukkZyChkgAqIu+5lcoDXA2PfdYBPty+t9fMdl3MVnF9Dm8ydOjofj8//sVfEdrqLNfCkYvZPETdq8Oa7mgUL4bsX2DSjBWWHqQozxTOcMaHl+5txSbbEZjzNrrUNkbMoZxjorOAcEzvleb/yZZxZ+7R/9zfrgxp//zOLf/O/+6w/zd1dduha7n9xif1ZUL3yocW5GPHW+/tII7IbZuq9/893xKzu9W29cpfXXn/vRHz3xsU+1vvzl3lZr5sI5yDMmOKAEcB7imfdOFNz/CigBuVNhGOCFGL58bWeYUyBFmhvnNEOeaa2ECAOpSrp5MuKUO/ATyAi+eeiMK5SdUjACdM54oCTEUIo0N3Eg1eSj0cb5bYEjUlIIzpwj69zkUYiIhBDWkp/kKhICGGOIPmw2NwaQcWRuKvG7ELAjciBy5ID5aFNvNkBTxXjRI7VWcF48z4k5DEO0xiIwKUWZTOucY5wL5gl5ZpxzzgnO/X8ZS5x56Q4xxNyYgOjpDBni+wf31EAVjgF3ADgW3APgHtxzRhaBH/ma50XWC3hwf0Dp60aHM7XHgfvKfO3xgH7g1o+4mQFWnsGSeIRIIOCU5eNWdyyD6DPPnvy5L7zw9OUzjVjdf7D57v2da3d2Xr+9u9EaDocjILLWBpIIi5GozmhEjhINeZ4JBgR8ungv7WWstTQ1ZRApNc4JAKSQhjDkBE6LMKiIPLfcEHpM399MMDWN7486jYxYZdnSXGR5VhGVJMsmhSSEAKTUzda4Xm+U1TcAcCTFmS/hfQF++IGY4syV9b5/LdZaj+/autzk5OgQuGf5eHprUi4V5YpVPoqxEAaHIb7Yb3FugME07eMMOKP9eAvHSElkmGrT6o6ub3bWd3vr3bzTG0oJc/XqqcWaaUZXq/Zr0ryJaTcdVYlVCMbg7obZi9hgxmXoJwDdY/A9N/kYqQ96k/TTohoQ+pq9/J5nSE2uDBBypiwBwMBmAKCwGD4sK3ckBwBjcL/BhiecWMolAFSTxK25WsSj2eW1V14NtjPW0MF2li8FdBt2ekCaEYGt6des6TOhOLOu6KlmWQKMVeLYGNsb58PMRKEaJwmR88y7/+ZZnQeKSyGFy//CFfHzn1p46rkLp/aun1hthI2Z2nD9M5955sc+ee5ad/d33ux/460+3xwvn6nWPx2de7F25T5VEvPdPn7tzqjbGzXNZhhHM8Hg3oPOZmvj1LmzJbNcQjkcgAkHyNE5p8K55TnS+je+97BWCVv9weLcrOCMIY8D4c3qcSJn9OEj1oFgHMl5pCMihuAIjLVprhljjoBxtM4aQ5wzY53gzE/8MwRkLBBcCI6ISnDnyFi7n3LnjdYZy4xx3gofHAFyBEJO5ByBH4h1ZAVjnCED4OijCL3DATFkzhsbkQVAb+Iz4esnVBJjyJgxxndZfcqSb8ZKwaEU3BP5+Gz/tIy1zjnpdT5eTWS0D2PyQdtpnp9XvK7hA4E7wCPB/WjxPgSnEKreOpDwWHC3CETQBx0hD4EbsK/K9wL3o7TM+913oDXHOwYfA+4Bp9FovNcfrS0vfemzT/74p55bma083Nx7+/b6V1+/8/rt3TubO53hyBMUQcB8UWAdci7yPOunma92BYPUorXW47ux5Ev4kr7wFw7SQZqTn8ED0mOU8XxNSCkzByWR6yGS27EUMjPvLXcSAhLjrqzGaWIXlxbWe/0MIAMwbacjbMb83vZI8+NXOA/u5aZhmjJSAq12hM6/fE/OWGtTQ2W9fwjcjyJ7WbZPM07+OZf8TEk0lVhvgIEzIENw+y+/lNUWrCiCECyQPHeQZ/k4N9udZKszaPWSJ84sPrk616yE2Uzt7ab8muq2+tlemIcpvhzM+bJ9vxZ7BL5vUO6R/TLGpyfiAeTMaeNpmQwpZNxp4ymaPnO5M/sWBYgKsCRnKsBvY/o25ZdB+q+Wy5l6MGgs8+jkSdtk+a+34iZ11kPzToaMbVMGAKNqCgAbjN8yJgokOUJgmcmBSHDWHSZJnvdHaWc47gzHDpkUPMtzDxoOmLOGCIaJvrIo/psfPfHam703vvba3Z3s997YwQe3YpPr+RW3t/7RL/3Ms2t9NcO/+nr/e+/2szdH516sdYXavjsUcVxdte8OYHujfyLZXVyML//l/ya/9sbuzftLT502jnMGyLl3jjyC9cAEgHGW8edX43du3P/mnY5X0zvrqDBegQm2I0wue28xr/+zQNY6bUyWZ9oHwPrhT2eLBrIjxoFjMe9pHFlHfgTKewAQgLFU5v4VeiFrnXOMcQfgHHiUd0QMgTOGDJylwl2aIzmyjlwR04TezdE3Rf0ds+kJZyJv+84596U9Y0xbywu8Rz5Jf/VkDiB6uzI2WQmUUo7IWss5z7VGRI/1CKDJuVzPiw8G7uvM1Ik9CtwfVbwrxj2mc8Kc0TS++9QOAMjAKWJANAK7qfN88b0q9w+K7CFagVRaDkxDvOdnjNYlvpewfubE0l/+Yy9+4WOXRsP0nVv337i5cfXu1hs3d25udjmQEBCo2ONRo1ItCQ1r7bRblkc3Q2itHae5h/ipitX6n5yLUDHBUXAkW2QtAgByySVjwPuZtdqVQOkXFSkk6XH2PgSngYrHw/GF+UgNgap5mtj2xlhqDgAuoZkIR9re6kM9ZtZhIImL0D83TSzPtOfND4F7VQnGMQyCsnL3y5UX2wAA45i816bCt2ePUkyHVibfYi1R3lgQSCUFfxTcDx806C1wUXDMtOuMs1sP29vtYW6pGrClRjg317xXF99HPQQQ4/EyCwtJwyOc2euOJVY/gNTrCi7zSh14KYH35Aw5F9D+hCEAlJzMiIwC5oeYPLh7H4LXYbwO9mN1xQJiAWWfiu2VORqPK6fOuLBei3eG3zbIOTLWd2a3Mtq4WMXLfPGJRju2r22ksUQidGTHqY7CAIjOnanvttLMGIEQIzJr65wWHK00+bmMnVqwp+r80lL47OnqDz0xv0lR7eT80hMXF5+4cObJ80shG+31f/srN+/e7T95RtXOX1iqDs8FsqPU+u6o9/3R8pnq8pmqvtHNTaV5knc03twcLAl2ct7WYnfznft9EZxYO5nnmoEj5zurroT1Atm9gbxzjMOHFqPbu/13t8dBIIylahxYY62bOGL5tG4i8NlSzuXG+rFWAmDIAqU441JwzpFzkebaJ+T5stc6koL70YeC00C01gnOCMA44ggE6DXunIOxVKbITjrTvkdL1i8P/iVw7qxfKX3WlfOLkiNCr8+BImavyGp3zjonOEdEB8RZkfvhPcK8y5gF8ouYx2vfLi688Px8g38saznnQLRvG4k4TtP5irw88rYF0Hh/3gN+DSjB/Wg39djifRZkSbsfqtztxPPCd6QkIAf2BqT5HHscB/6eT1RnCQAQC0rljAlAZMdn7JWC90KDaUcP2/naQvMX/9Qnr1xZ/c537/3yb70KAJudwe317jCzgWTVgHuV4bFM8SEfRKvdtIZyNKm9SwJneqTTmxb0hwdSS5RQI50fkhV6eUlqMZvqgXh5zCFM908yy8cpBdfWh0/XJNyEuVnW9u/mLDNt12q7J6uVqzudTM8GkuBg9tO0u/ohoc7066pMeollnpQPE3vUuMD0C3lPwX4pCipVNCnxwgXxOE2OZKgPIn3uQDHIHSBndckAYLeXPGwPA84XGtFSM1qbq63NVR+2hv/zYLyw1/pjA/GcaMDUhOoBAS9z3qvAfw3qTPgj/1Bak3eL9NLJPnNjY2IuhgBoYcix6qACojSHGpHZAvfs8uzeQjB/r5t8tBJfecE6C4Or/kEHn/9kDb4OALU3+v0HU+qdND09jCPW8660AFwbOxhniigaJC8sBc+dbD55+ezqnPC6nbULy3EcNQWjQa/obUoJAMgFANg0YVI6re3MclpPrxjXartXfu/q08/MNy8/N7/xBz93Of7de10AeP0rW899dvnl2fhlgP/lDk/Oie4IfvPaNsDvXvz0Cxc//cLNN6+1uGyuLdhUQ4kXNHUZJqszaQA4cXr5f/hZgH959XffHTbjAACCQAJAmhtv95hbstZaImtMwdAw5n3EPDHNGRIREgMExlimDTIBhM45KTgQ+OnTQApkOM6M/xdjHRE5xoH8uozk9h2K9rtQHt89pnvDdABnrXMukMJZR5NWpydMrNEckCPz/+SIvLJFiEJjiuQXPUAA9G6U3g4MGBfMm7+XEixjrSPaV85MvQMFmwSQ5Tk6emFAAPAwxtMpwB8pn/j9DRIdie/wngQ5OzChyhlywjSDx7RUHwnuw+EoM7ZWqS5OBcsN7UhkAKUHy8SO9RDQe4Oqh9ut86uzf+vnPjq/tDjodP7Zv/z29+/s9QbjNNeDxIQBDx4xOZWbXB5n4H4I5Ys5IAmBpEwjQFZ6+R51wS39e0tZTTlG5FeLXpIcRcBj6+LCRSCAm62swVxT0/yFWRrafj+tt0OP72KWnenKe8kIZOyXHKQ0OzgEERwcawIg3271r3QEplzbpp9qOdY7LZs5FMfxqJXykNazXLr2X+wj1JbaPc7D2mtTw4CHwHMH653Remc0V+kvzTVmqsHaXHWvOfifu8k0xB+eYzLGm4utoFyCoO8MMFF3rNSzl8g+fYqZ8AlQ3lC+EGIiEhPgYA/dOprTn1x2ADuXZk5dOJPlmk8U6CrgsPug9ka/vLdT/fjU1Xx9jUXPXrkY3li7hXeynGs9E4mPnoifvTz/wtMXn7+08vRKHNYaFCoAwDQHADI9O9ZA1oUxkLaZtqNOIcxPJADEkfYXGMCHP/4Ej+St797/pd+497N9u/ZTPwvD3Rf7v//a/WE9DF//3a3nPrtce6P/50P8B71BvLh0Pxn/5rXtP9e4/eRf/y8XF37zrV/9/cbKy8Uok8d00mXN7swBrOdhfOJE9ckG+808g0pgjG1UZK5dX5uiA+rLUeSeL+cMi4MIGYKb5LVOBMdCZHlODhBBTlrN1gHjPnoUnVdDIgqGxjpnoTQj0oamAb3AU6DCfr2IwXAMkRAJILfOQ7Pvk/tSnSM6IiTyk0qe7fHOMMYY5pU4U3SNcQ6ICsGMc95MrRRBAoASYp+IdySU8CIon8OHiFmuT9cCPiooEet+kFzsR4kgj86veh+Co7CuHHrE93O85fXvaTp2GENHmcuyZLURfvbjl0qxubex7QxGqbat7ujQZH835YM096U9ANQVdQd6ZDp/5ac/8uGnz9y5t/3Vb71xY7N1e707SAyTXDEIg/3dTbN2+MWPUqrI/UI7h9w+IrXVWwQHYKdrdp+3p6SJBYyNCiTVY1UOCk0Hqx71HPaejo9Ru08PQ7VyX1UAtTMAGGqiOjXarp+mNAwuL1buvtOFqMBuj+wSj5mUz/JxI4rqsQJwflXTguUmL3ct0+ZiHtYPpM5yqkjpnWeOe48qYEePku3v704eW7BLb/Q6dXD7sv0oyisGKpK5g3ZiW/d3w0CeW2o+eXphbTF/2Ow9CuJHZMojtUIA1gys6XNRt64pla/fvU9Zk6tiZ2xztMabDPtcmaL+mMzKvmvHrhZg0qWoOb+2vP8Rh2F881vuyqdqV+/bBzE/OQaAsTMVgBFC7anTKYR3bxoAeHKl+uMfWv70h8594ty8rEsUDQ/leXvPplNrpxmCqPqaffKtqvrr46j49k4uzIOoWg0XP/EcAGxv9Nydd5f+xN+/1BvDV77dNW7uTy2+/itbz312GQD+izfgb2/tnbqwOtgz//Y7d898+f8VXnq+UWff/va3P/G5l11vXID4BDuKmn3auoQ0r8x87KUL8put1DjGqTXInXO5LZCUMU7gGEeOAsgpwbXzok+0lvlQJ5/gCmA9b26skTIoDnsCb5aLyLS1Hu4zbaTgUoqS7dEGrLV4kPh2RAjgqEi2Y4iMMUvOfx3LiOoSlD1qO2uVYICMTVYdrfV+Ae75dN9HRWSIfkbJeCE8onMOAYy1Po+pEPb7oVbBOWNecmOMRYba2rrgTw6KAYf3zOh4/BzTey4Axw46WUc5O1DFl/ju55geb/zLF2eKedJRkgxGyfMXVv7yF5//sc+8sFBVUaCkFF//ztvXH+ze3+7sdoad/tjX7NVqZaZeWZuN1+Yby83wzFKj3R0GHM6szr/zYOfp8yf/zv/hC3OzzT/49rVrd3ZefXfj9kbbIA8kO0Tv10J1lIO1VgspqlHk9d0TEXGB5uSIHJUOLdbZRJN2zkskPdWupFE8lsyqIBRcDcaZJsaRHCBn3DrrEVNM7RxCKUMpwemAgafdjz4xT2dXlRAMBIPMmMDmi7EKmypWzI4NBCLjMCTUvVzFwjq7l5hqwLxiZ6SNF0RyIn8PoZSGsKpEPVZe+OjPAdehiiOl4jAQDALJmZBgjX8Hyn/3PQPBoFR2HhLMTM+8HKLdhShWL8+5G/uI5RPRYsDB5qCQ7MFONajJhsELl/aHdxACgYHkxriN3d5glJ5emV1baMSB7AT890Xa6g7OYbBAIkMCgA6Zm5QCwAkM4wnMI7ncGUKMhCzVMiHjnq4pCXeFLJ8oahQV5x3UVylrZHRxOx+vomo0A6Wg+/DEP74TXMtOdPLWC+fiBw+TWyaqGwAQozB35s0r6it76b17d2bPzP/Cn37x7/7k5c9+6MxKAGR0f6uftNpJq510RoIG4HJweUF3TkjPaYUiWQdMFWeXAwCvzBBNXBZyvXD+5DA199+4HiTXUmtkbxc1hAwX5qu1N/qLP7EIF5kZuTvb3bPnl9fb496dnVNxa/GzP3n/W69Xg2p1penSrGTbkRXhfAe6rAAAcK6BrZ3WN+/2ozDI8jJkinm5iOBcCsaBxCQXSRSUtPcDcNUwyI0F8te4VBtnrSNA5tkPRABjXZIVOai58S41iAicIefCuWImtrBF81SJlyoWBpPIEGkyWlWsmMYU7kbOOef80sI5l0IY6xwCATlriUgKwZCkELn2fmXF9Km3nDRaI2N8QsRb5xBA8NJ9Ez0RxDm31hptHBHz+d3WXQhFferbw9kHU8t4qfuhVuoh5t2fPedeQ149WG3TBNktgnXkIwn9OscJb0J2N6S4Ej8O3HPtdjv9D18++df/5Esfe/7izm7rm6/fuP6gtbHX3dnrCSnCQAqGubFSqbOrs/U4cI60dZZAIBDj9+4/vHL59D/5v/0iDlrPX1z+T/7UR9548+6rb9194/bO964/GKd5GAbcy2kn3/8CLgU/NkfTkeQco0Cl+gC4lxfYkSbwTDVsVgJiPJa8XokrAXdMAUBnmGa5cYB+mMgBhtxPQxyninEaAI72VMtmr+DSEAoGXDLFhAK9Gks7Niunq52ddEgYjHXOGSieG1ptBDe3RiyMBQfrUHEWKxdJljmohbIeM0ZZNQoDyaeT+YwlX5DmebY/yoTEhDTGhEEQK8aElFJESkRKEDrfiQVrPOK/T7ccL5UpwJ2pQ93UKQWxcQTTyJ474AiW9vGd4z64+78W/4solRiN8+sPWkyGMxUeB7JRje40wt+X7Zm+XmYhANxyoyG4FZRNOCy06pBh1gaEvmz3Upk+cx2bKwDfTa0Cy3F/OHbIYNOl32XZJRKVXGShqpxfioRZ+H/cq1oKZRDVzfhylD/zjHlB1K7u3Hsg/v18dqcK2TPVH3p24ee/eOWHPnRmrS5H3SQbpjq3Ore++pZRLAOxj9rTX6TgwAZ0WoTOVEQkyDo/akSF2y3MnlhOtttf/cq1cy9/8sTP/w/Zt3/p2gO9dL4xltjfzE595oXwZvte3teqslTj31kfnOBw+qf/vGqE1//gq4vzcyIKPaCXfdTJWu4OKmyjj83Yr9zN1ntJLEUUKCU4IgjOBEPBkLMipsnzMH6uh4i44J7I9rHdRMCFIKIoEMC4MS431rsvGGsCKaUQfnCJIcuNMdY5InKGAIuGp6/W/WTplPd6IWLZjyihomyfODKWoI+I1pG/H98s9eJ0a50U3HuEMc5LPTs5V6p9kDGtNQIgn6RhIVpjjLW+B+sH1hhnzjmtzdOxOlStv/+GqhfMLHL+eHA/1FCdFsz46W4iaEPOgREBZwdIJ044BP0uPU4NydHqU8uzf/fPvvyZF87fWt995Y2be72RVCpQIpYcAHa649fvdb5/c+PVmzs3Nrq9Qbrd1xIt5zxgkDl4+97eX/mPfuyv/Y2/8Mv/9F/OLy3OzTZ/76tXH7ZG33rz/s31llQKGffCJvJUGpZm/Y8Ed2v1MEk9I3csJ3MI3CtSVKsVgSAQhBSCoSPIDG3s7I1TE0giB754T432enOzH7FyANxRxgHoaXz3JMy0Il4wKHYPOq9L19f29Fq1s5PmfL+KTLK0mlO1Hj8cpLMzFWut4BAEsbWaAdfEyAEy5bvBZYaRmaLOvVrGCyI9oVQkxQgp0TlAic7L5/0r8ojPmYsCpZgAph4jmylJpwLcda4d8eMyNPz86vRbVZbnha057nMy5V/L6p6sY4IjZ1u73VtbvdbY1CrxiWaAcf0PZbrd6p7DoEu6rFwOgbsC6KLjRA0QpVQmQ/JDUoqgGE8lGJFRyJgQHZvfpHQT7Ych9PL25FyF/tn3T6RqyDFAFtXN4NnFXFSvrfd+pf3gzTPsiU+f/4s/++SPvHTu4rJSWTbs5Pn4MH8mpXuMMoGJx32HPab7t8KjPACQMbNrq+PdjRXZkrGA7u3hIEmy7MInn3H/9tZu0J49wc4m1W/c32w24/UUkt7oGbrWkGb9zg4Bmzuz6DK3z7YDMAFE/GjXT4b81Tfufm99XK9EDLFRkUEQjNKsKGC9qMWRoWJSFXxkKhE5H1vk9Y4FpwGESjIPmsi4sS4OlAMiAsaFYOBNHzNjgIhzMUlJ9ZpL7o0BSiqmnFcq6HU/euoj8RjzcsaCb/HiGVcMTHl8N35IFtE6n+BR3B0RBVJ414Eyq8RZUlLARKWpjTHW+gyPYmFj6JzTxp6uBedHB7qXfkfx/sF9gE5pVoX3C+7+ZhHugzsx6JH28kc/mOqJmrJy34L8bWkfB+5/7+c/89f+448/eNj+vVff6fTHUim/ruo8v7fb/ebbG6/d2d1u9RPjAGCc6Xvbg9sb7dfv7F27u3Nnu3djs5Nn2YXl2tf+4JWTJ08kg9533rzd6o1/81s3O+MsjoPS9AMZAhFyRtaV+P4ocJ/go1ZMeLp5mkLxnIwSKuTooS2QVItCmMQV+VnpVm/skd1L5h1garQSiiN5mc1RcEcuq0prCL3aPVBxBXNB2qIqZ1zLOdswCDImajQMOC/BHQBwpFE7zcgFarbCs1F2e4CLMyGaHHgwTo1SQcB1RdogqhS0CYpHTI0Jr7ThSH63EUWhNwf2exE4OMSSm1wJ5WdZPXUjGFTiwGP9Idm7r9wnP10lUMeSMx70j20mTeP4oa2U36WVkjuvWEeGg1HS6g6F4NWALdSDhzPhd0bdcaargCcwlIAa4Si+a3AOKJx8T3ZJa3IzxIYMtDMFviMDgAG4h5TshVZptoICAFhA/GOXRKU7dxNDIWdOpF9rj/8DjV979Q0atT73iUs//8Urnzi/KDiOukmegIxindu4FshATJ+PRXYeyBKsDx5J8nAFPcH36RvzMIiWm1//7Zvu+mvhpUtufefth6OGcO7J+qv/6/1zL9b47/e2ZfX1PFttVG61xm5n/MJnPrSyUr1+/8Hi8inOSofhaXLmSMqzsDu74996ux0Ggc90tdaRIzvhzh2AtwR2BI6AIzgH2pKxzofz+UF/REzznDMWB8o6h4wDOSJSgvtbApEXsxCgttZTrvuZIawQ16Jnt8sS3kf1TgmafQFOE/mjtznz864e9EuOhXszy3KRQPSy91LIi4gOwRrrnAsC5XFdG6O19t0ELJzuiTFmiYyxp2vBk4ODnx3+IODupe7vCe6bpMvblODuy/Zs8lEGsJ9bW6A8ggB4/BwT/6tf+uyvf/l7d7faJawDwP3t1jeubb71oJOkhjOmJAMUvuauhiwKeKS44GiJhOC9Qfqd65t/6Wc+ubG+c+vBzvWHnS9/57axLpSCvAuEKxw7/ZLqZw4fA+5pts93Z8b4L5WZ+NJwyWZjzoCX0BZImms0S2Qvwb3d61mHXIS5ttMzon6S6NgNQVXpYS49BR+AFqRRxsilIRxrI7gMOQUB89xIrBwDTuNRPeCNWO62c9QOFEftqCJ9dEBu6MRsuL3THdqgVg/GSSo4hIESQgIP9snx48AdKUUwXiPv1wNiqrR9P4Ts5QLgy3m/L0ktGkJtCpQ/hO/T06q+iBOcH8V3z7k/Ct8fdZpm5Kf2RVZwRo7avYE2rl6N52tR3hCv6WRuRE9OppEVAHEBjAFjOOGSu+gSJK9/33IZAFSAlZV7eXqXRgBw15hlYP47wwKKPn6xB3il273e0/8+gGun3HOXTv2fvvjcj3zqqYurs8pQz+kAWAHiAP7n+zntT/8fhnX3qPp9//YoybpqpdIebaYj8+RnP0snzzZ27naS9NzF2g4nuYv5UvDcg/E3aABxmBHobPjhZVdZO49372yQXF5u2sQhA7KaSQ4AdHCX5l1oANU5Pnznfudmr3BnJALnyBhLjizZXDvryDlnrfU6F20MAVggxpgSGCghhfTVuiPinCPzwE5hIHNtiEgK7hCRigBrj8XGubIAL7CJsUJxiOiAPPXvtTG+wnfOeVDASd8VJ9F3fGIp46UyvvIvuB0vl7TWESFngvEyO8yPtnLpveZt5gt2xhjjRewToe+ggnVPx2q6Zi8JGX/6oOB+EdX7JGQmTaPCYaYNeTZ1CPnivVxprKOQ2HvOMfGGtMS4h/WAQXeQfvPNe6/dbY1zowRHhghoiiYIwpQ5jLEQKwFE1Uj+k7/zs3fubbeHyY0H7d977Q5yxjgzzgn0y/t+Apmv3JGhZ2xjyX1nbxrijQVj96/xTHeWj4GpIGAVKQSHShwDaesQACpxPFMLaepLLhiOEp1kqeCAYDzlXQpmUqO9vtBjdDniBAC55X79qIXSctFNdAAanBakwyAOAlYLpafO/TfUOnSjwVwsluaizVE6JnDOSMdA8SllJ602gusP2xrDmYZC9BMDxjoGAEJIa3UYqNISp0R2wtBfD6QBBYKpxREBF8xwEfrWq2BGcPC/WmtLxEcmPCnPmVMCvemYt1uYNko73nDmIL5zsI8p3h/N9+1TN/tfEkdF/AXnnXHWGyYztYgz3phpfs+NzCB5llc0OY2gfCCUNdP1O5IDwQPCTcxrKNXUPQ8ZKIIhgy7pTdLvMu05GQ/u4iNnZxfmv3Fr8/pz0U/85OX/5Cee/egzayoUNtOeAQ/gAzTKjufZ90v1R2qhmZSIE8At9lqcrFuenVXDHTfcmD93WenNd94ZiiR78uLMV//5vWd+tN4VKnxjfK3JmpVgq6fPLAa1vKNq4fhBb/bECqLzXUd/Prqc+NdoeIWb4b9/d4DIEMAYm+R5qk2a59o4o21ujRSisGx0jjEmOZNcMPRuxswSkXOMcx8hLf18PzKOYJ1jXHAkwZCQfPeSc7C2MEMuK2uaKDD9xD9DluV5SbMUdthFTq9zzniXSn/iE6sA3yD160FhEzZ54Y4oUAongFM43jjnh1e1sTRpqHrrmHKKNsu1QHgiko9XxXxQcF9B8Z41+zS4Z+CqIBJw2ZGjKAMXM+Hrd87QIih6jzkm/sMfOsvICYRQiWt3t//w6oPNXq6kUN44GcDS1I4H9ukRR6AES9L8H/6tL/U6ve3O8K1b27/16k3krOyKWELB2TS4F20ThooBRyDnwoB7NC/PJcSXs5SI2hPfSqB2jgEPlBRCBkoC6fmZhm8N+bN1IBh2hqm12nPcAFDiu3d3ma8JMGnmUDvHOB46A4BnexAYcolc1iIIg6gWor8f67AE9+E4Wa1wNb/Q7QwBwBE64WYdBNbp1JYof3YuvLfTS10wV68AZrkWShrOnXUsjrAA+snYp+AohBQcq6ECzGYCHOYMUBToPzli/AKAYPwaUK1W4ii0FiqRMlo78JPfnDMecjRA1TDgzDmS1mq/oPp323vOpLkWnKe5DpWsxjydkjpyRP0DiXyn8Z2s2zdtJOCIo9w8bI+roZJSzjVrV6UbtnvP8opEdgjZYVLLB8ju2SQnipFPg3uOkGNxWK6H+a51l0ABgKhZAFj8wrO/8+q7a8+e+D//uRdXGyFZ5/IC1j8omhc9UhmKUCLnBcdd6BFdCeJHcdZDsLdy9JjLhOfHHRMccfyHf7izpLZN3377Rns1C2afqITAxy2qvdE/Fclv0EBW464LsN/73Bc/G/7QX73+ym/oTjp3ZtEmhzcKHtAp65NOweXjEQGAbe9++dYocah1bpyzDtI8Z4X+ApUUQoj92U5EBAdEgZSArIBFxoRXlTgHyGiSW+SBspC7ADlHkjMfXweADmG6E4icF5YvjAmGjHEg4kIIKctJImetdU5JUahsJhOkAFDY8xKZafLdOz5yXnIPfnLVLwaWCl2N19GXbmUA4G3hcm3qgn/G8vp7TYD/bwvuQ3B+TtVfKHuq04TM9ClCPqE/CqboLZb1asGjvLz4xy4VEuBvvn33uzdbmSMlBUOyVKx/iJBbpq31tQHnkjPwQtFeN/mbf/rj59bm3rzxcJykv/K1d73j86G6D6Zs3kr+3ffiHAFHftTQahrfvTPBpEdM5MgAkXWBkgDQrFaiiWo+M+TxHQBGqbZWG8dxEo0leHFmwK1DZMrb8CqhFI0DGXpAL67kDAACyQPJF6qEIigx3eO7B/d+Zt1wWA9pYXG2t9P1Sx9nUPEsMMeyv4ojfXIx2t7rdtKkUgk5dwDgIR4AOHf+HKkQMPOgDwC5sZEKHapxZrzKc7q695guhFTSRCoMlVCCVWNlAeMoJEejLOWM5yb3L8prQJVARxJRT+kgDzAzADBMNACEShaGkc4cbat+IHznCNaRpgMEpAMg5zbbo2oURIGcqUZXYTzsjZ5k0diZwwcsYwCQkXtISQYOEetTWQIe2buge6S/7tITTqygEDUbD8KXVtS/sun55fAv/YmPpVs7o24iAwFmuK9lPPqEw5jxg4oXGTI+sXBBXsZJIQMizgQgA+QcuXey5MeCe7HCmSFTEWV9IlFSNKo6d/OtB/fujT70i3/j1Fw+eHtbBFk8j9/8V5unIgkAN+bNds7qcdDf6zVZ79TTz4y+89rNnd1zZ04iA/9wJaZ7QNeGS+n8/BQAVPL2O7vp6xsjDqxWieJAepNXKYSUgjMf0c0FB4aAwCaCAywm/RnzenPf0/TOXOS17kUblpyjNDeOCJAcoc9R9Y1Qj0mCF1l3fuaozNbwwnY3MZIsRkwBPWwDK6hdKaUv8FnRzmWiyI/CMjzEY7qxdiKAKZ6eF+Uw5sOjCkMx7ZyxdqmmPvo+BOkPYzyp2f+24H60reoR/FhwV+ThpbB/4AzfgHTUfDS4f/jyaqjEN9++++bdnoHCBdARMiREyI1NciLnlJIBZ4DMGZMamxuX5PbMibm/+NMvffetu3Eof+lbb+9sjlQo9g9iIiASQhYd+YNeP0DkDXtzY7V2gvPp+nEa3ytxHPJC2V12U7VzHt8XG2GJOB7WJQNHBbiHLLPEACAI4jhCNLklVlI0yISiseASp77kyEQ41RwMJPl7KGt2bxeTabS+8De5IJiphukwQcEkJ4AC3IeaPAsPAP7naiOgLN8c5lJVPYJz7nItPNYDgAGJoAEgUiEx7qzNjc2NFZOn5PHdA301VErwOAqqYagk95VoINBZ1x2kfgLFS/v92TprtUs0hJxCWViklc7GB3zErCt/gjM5KA77Taof7GQdsYMD6LZIv4RWZzBTDaoBq9XrV2Fc7SXPYtxFpw50IBww1nJ5Bq4OkggE2y/etTPA2KZLAeBtyk8vN+HTlcr9dCVT/zqk6Ez4N/7Mi7rTIetkIMaDTBsuo9i3Q4+W5zwMmJBMSLIIyJnkOLHrYgLIwTTP7y87rZHzojLV+nGyGZ0SCWDKo3zJjC/K8ULV1tdW1HgUBMPWXhoGeD+kk3sEAKP75prSzXrQI/aR03Ft+81qgw+MrfEKR6KsP+pbr9rUhmvDpydji9dlMyL35euDKAzjUJ2cr261hkpKr1ohAIZAgM6BdYRAgFTAYtHTJCCyfo7UOa8Q55w754x1QGCdzb1zDYGXoTjr/GRpOSnq7cOKSnuibecMCdAz/sD201BLzTtSMYxa+MngfmSSQ9+/BWttZowXrRc3myQreYDH/d5+oXrMtREIT0Xq8uh9HdZ9eQy4N0NMj5MQTxTx9JiG6qPAvfeI5CbPzJSzsgyx5cydCjQqgT3OCZx/6qnV/jj9xlsbmSNH3g4NASDJbGYoUnyhES3P1ZeqollR9Vk1H4UqiMIwGgyT/+ynnq+EQWcwvr3Z/fIr92QogQDJTcfiuIlB/iF8R86kteQN58iXHtwDSnmuxlwIEFxOS2XIUcmczNUroeK+MHQEkhVUb6IpzXWdGwwDxMAvMJy7gCC1+/w7RwoDmVo+3ZwsOq5UtF59aeWhfIqYLu4kzcxeZ7wyFy42onSYqAABoJ3B7nBEAd8ajLuObQz13kjvjXSALpDixGxYx3xzuzO0Qa2CPkCqBHcEnWsRqbCQjXPurD1Ci2OzFltAgVCJpHXgmaiSkiJkyFmeG86FElwJrm1RuTOOnCiKQkKXZBp4JZDHsPCHmHeP7NqRZB+4ePey90y7o9okOxEvI2PbrcHppWbEbKXW+Free27MG0z6hipx4X92QRNB2VnyzIxn23Ne4P4m6Y26nH1xhs8s6tzodHDtlPsHf/XHabhjxyMPqdrwuBZMJxlN6154GE1hsW8RFXJDX7DjcdUbTlUkjyrbJ4WNADPkUWXUt4JjqaJx1L850LXhuh6232mN3r7Rnwnl/Fi9+nbnVCRPRfJqNc+QGQLbH71wYSaszW/c2G7lvZXZyjSI78uczAFYoaTvkux37qapIWdcb5Tbwp8L/OyPI0AizpCQcc692y75/dXUR+cLbQJgQvgJIykEIRIgZ0wxv1gUTVTpnSSRkHFrLbFivAin5pX8MkIl4zBx8S3MDyaKSQ/ZFggJSsqFnLPGeoccmLJeKrTzQDhZSdhkRJYB+IK9Lvj5QDyKZC/lj48H9/SxHrKPV8uU9mErKEt+5vGt/Ah5OaHKEO9Q/qDOq3F4LLizzIFUqlkLk9QyJAAw1qSZqcXBpbW5p04vn5ifKa1jRAZhXKkrqgTswlLl0pmV2+u7APCtN+9ba8FaDg4ANBxw4t6XQh56XxgveV3tKM11YVkDECpZ2hKEx4VrV6SoV6NmRR7R7RXVq5JGBTxGp6TxZwAwSgbBgYGuTKPXn3jF5L40+MiVgaTyvP8SLALAqZmKy1IA0BZvbyXvbqXXu7g7pF4CI0sAME7NZje/upO/da/z7s4oCsLPXJpp2N7t9ZFvrgKA4pOMbGky/yoYIB0zjuQN0QJWqIMCgYHAydwA+p9LNbk8dyDL1qsklVBRFHoyKlAx2NGhiScfJeg/gsNy6WJjtP/z0J+OPXnxu9dBHgQ5M3VscA241e6cWpkLmJ1bnP9/15J9qh2AuBg70znGu2F/dsknkG2B44tWBcUI878G+iu/8FOCtE00iCoPZImDh5B9sDccDzIeRnSQ6y8ZmCPJ3gemvqYvMykPMeDH7GMyHUd6PMiKv5phWJundvaHf7iTz55cqi7Yrw9v7Zj5y/tfouZWnIyykMG17fzaxiC89Pzqyx/rtrN0sHfI5+CI7QEAgKjzVtt1hxkAGKLMWMYwy3PrnGAoBUqBgeRccI5oXCGCzLTLteOskKP4DLvCD2Di0eavd85prb3IgbFiQkpypoTgrMjBkJ5icY6I/Nir51KM1q7U1UzyPRhjDotpprI16ow1xnhp42T2tSCPpsGYvAsNFItM2V8FgNw5TvRMrD5h2NqYHsZ4CNP9Gf73P22SvvuCuPM0vf+Q1UP+Ns0Qbb5/5B2KMuUffWIVAE7NV4MwMlq3BqnWbm2hutIIq5V4aEcunRLPBZCTjoNKqz+4fHr1xWfObu+0OoPkd9+4L4uocM6goEK9sB0Qi7RZgkOdVf9t359mJCiHaASfUtEwVRIy5CiKwsXYAsNmtRIqDgCMUU1QLMjwgKNhIuBoBFk/UqwP+utw7vVexZUjbUrveI/gB6Q1+dgY7UAdgv7SAqw9HM4y/dTp2fF4aDXd2Bm3DaszmxGTztSqofcp08YBY1luheSDfro5NJl1z65WG5je2+6quBmpMLdjz8Jz7hB0kpMn3D0FX7LwAKAEL8w3OBMMJTuGLXEEgmEUKl/CgzPaOW+blZvcOssZB2u8OPKoS/AkgoofK470H1PJwvuP/jEVvV/C9wkQMoAMkNny20gUC77TSZZnqkrwQOCG02c72QyqsTNeOdMnExxsZ+Xo2KSt2iUzAgsAW2DlaXVifn6QDF55fffv/Fdf/OiTa1lrj0cVT3ALjgeUjmYITI26SafdWbl4Cgq2d7ooYcimp/uPEDIGPF3jyZmjnHvZPvU/ybrCvQDApju5iXRupXTpYI+Hs7fubi9Wo9qZBagOtjvJTCiTpfD6td6pSI76ycYcRvXKyOHFGr94YSknMb51d3Exzl2jnLSS0k1fKOt3dMPhIPmttwedzEhZMNVCYD0K0VPmBNYL240pZoUmwnMidETGGG/2UlAr/rtHhQdvOZ0EhZcvMPTjRa5gihnFYQAIXneHEyWM5+7L8I2CkwEgIm2M9yrwHLoryH+GiMVoUyF49AQSAgDuK25wupL3Rpfa2BpnvmB/GGNf4nTlfgjTD1XudQ1DRu/fgWCdmVXiNeSbpKdbppuTkb2bz5O5kuCKDa/zMpPv8br46a9Aj3RX2FtaV05am4eVtc2Vc4PRyNq80IkVR7lU6vlzc8+fm9tqDZIk7eWs2+3287GS3K8LIdowrkyhmzu9EJt0nGb5Vms4GOtKpMBaYywXj1j0yACKokfDsKzpjlZ/vmY85NtVVRoAWFypVwOAgHIXi5wxAQC1WEw2QRZAUJYCB4jifq8LADG68cHPI2A2CCAr0vvE0bLdU+rKjV48VT9Zc9+43b+XsCg6xsPBDpLZBVWtx52t1o1W2sloJrCdjABMwrAUoIZkUxBWm1QFIBQ42Orm/dSdmql88kzw9bvr2exMrapyLdLcpTkDgIuLrhZWbrYGhHHAILdjX+B7GqdU9I8SDQCV6HjnuUAggBgMC1c1TVC6TiY6LXzTjrMdnn7zp0v4cmt19FM7ai7mMV0d/S6g0ICSNEwJEHPnmOBv3d15+sxi5nijFv9arfOLo/3i/eip43JgAEwCQOKcjw++D/rTKwv3ut2tjc7f+wc//eFLK3lr88Dc0BQbs35v68Tp5fEg67Q7Z5+99AMUX4URY+FbAYByusCfrtltpqcfuvSJZGYTAADmnViZq2+eXY3n6im0HxTqfuPOL4rvAADAy7PxqzRKAg0juHp/8IXOTrCz2QNo9cOZ2WOe2yGuxomVuYb+P35K/70vP2RMSo7OWg480TrXjmA/7HvCEIKHVG/gZZ2TQhSGkr5S9sOfE0tehlgEGE0i94wpdJAMkQEB+uEpQIDcmHJ0CCZ5Gr4WLEaQnENEMbGA50Kgb4NOZJFu4lfpJ0t9XY8TBhhKYwP/0znjHDoqBpQMwREvsPes1gvX3w9ySkOC7HC1vvU8plfSravIogAgBYDN8wBAK61quDV6X+w/6DtLCkB1tzK7KOM1iqEzGxIARKHMB5O9ms7zNHc+sk4qdXqhBlADgMzNDYZpZzRqjyAdH3jIgJMEmq1IrXUYqFGmgQiOUMMHKzUBKPyFcnteDqxPb+qnoaT0pOWSMVFxZuRROMvGYRCHUVzC+jF8ViysibU2eZ7H6ABgH+JlDfSglL3nJtekqsqW0J85rtzoF7/04uUFOdrZfHZW/PLV9mvd8enIAUBNIAgYGOqnDgAWKhIAbrTS9ZTFaAGAS2EnRvMVjsymgygIUzMGyHILAIHicSgA4J3N3nJTffJM7et3O4sgf+hcvTW0w9QCwJ95aRUArm3wq/eGb7YykPujCpkD0CZzMKPyF8/XFlj/G2+10sZyGCg7saovJ7QCgctz1fubrYJrEio3eekhXLrAH4PvuT6WnHn8adr53X+4pfP7gZsBAYpD5bBibL0zatSGM9UA4vhm2LozGJ2jgADGx/ne1EFaR2MwMRN90DNMvWazhzF++04nnlv4H/+vP7dUY8nG/WPGRwF4IO9fLwB058798x95CgDIGuTiA8D6MRWM9ih/PBUz6kww95Hv6vKptbfefHjx0y88/Qzc2bjfarvTFwT/ZBXedp6Z2Y4dAFzdyUc7mwDQ3hjrxiA+UR0ncpqEOZ4C5qNLAWdMGOck54CYGZtr7UdGPY1bwquPs8aJSp0TBUoRQJ7nSkpHJBCL5CNEIVhRjxdzQ0XhbwsGpiizc52zyWNB6WYzmV3yJwAQQnDOoSjPCzqoNJ/xXdx91TwhATmkfQsaYM6navvNhLXaurrgpyKxNnhv/asXorwfVuQ9T92UNuHwh5JeSeeioHUl9cgOAPihHACupcnqr7iV97rP15fw9edHuudevBMCwMp5MRvuf3mTVA/tqAqgmlq8/Nz5zmC01xm0R1rnRWEmlQKA+Xo4Xw+FFLc2Ol/+9u2VxbwWKq+D1oCZIWMcQFECM8GccUyw0rHZzysd2EcTU2DIiWn69RBd6++/rB89vlvtHI6YqABQlo1LnpoyXShXpr7A5eVmPaZM7w3Lh889vitp/OvMNJ6fw48vyNbQvLLn/AvJHJ/Tgz/7pZc8sg83ugDwpSuzT7SNabu5WdYUrGscAHx7vf/6A5irx5t73Zs9iAIYE+cO68x2AFBJZlPHQwCoQeYI4kqQ5TZQPGQFEY9RuNVN+6n70Iq8tp23N8YfOlXtGg4A6++0G3V2CoBqrjLQO7TjOf2Boe0+k7XK5z93+kdPNuTMou7snIK3f/36Zp+tBHFstCGbwYRZygyVe5FpfD/WH7h8w8MAAKTvghxYbpU8Wry/n57q8XQ8uvzgpoqIeoNxHMcAEMxFd/rJWV0ZO5M8NiWh5fI6SL8RBoCPPnX2P/+PPiZIpzuDRyE7AGwPd584dWn93tbi2VNHqfaDZYo5FscPTDCRfiTJbobHYrqv2U3fijovq+y5evpW210EaH74h8+++UutdvHCv9YevzwbXxwn91wMAEPH3npz76Ofv3LumUGr3TsDK+/ngwirtXW37Sm1TOeScU90aK1zbZSQIBgSFVpyACUlQ7AEnnVJssw5FwaBI7LGuIkMUTGyxJx13hnG5yiVSwVMcq59SZ1rfSjb2mvYvSm8R/ZSF1/aziMAThTuXleDiJaIFfwOMACfZUM+fHViHeys8+zfzPtD9ukSftpf9/8/p2aIm6mGR7vAA0B3eSxrIUCyOWeiLZCN5NANlk73ZS0EAPGPf+P7z5+bO7XUOLGovFqu1Rv3Rll3MNYA1VD97ndvv3an9Zd/6oW/+Rd/ptt/ePXqxpu3N//NN++MMiMEA4DZiEWMMUAH4IyDCS1zVGSmJqPzZUzH0UZcXdj8uLomoaByqHRyOASoHkT2Q980DGRoMU32VzaR605OAQMAuDJv//RFCcBgVmC/v0PF2/QX/tj5yoK0ifbI7k/PzgqYhXtt45EdAG5vJQBQqwZvPWhP+qsUawsBcikAwPFwZKkeRpQmABAyygBCRnEpGE1SAGiP7Tg1Ty2pr2yNd8j86Olmwan1HQA0BTu7Gp8tgazt5i9ET63WKosFzTra2ayuNv/MavPXv7X9/a1A8Tgry3a2z9goFeR55jOe8uMP6grA4V2hR/P3j++PmXVChocEM9PIribf9vLOq7wCkKA1jwkl4AzBAWeoHP6W7bt68A//2kuffPFc3uvpI06NB2TIe8NZG3baHQBorMw8BtmPqdmPKh0nx5vnXg4h+7FSluKPfTsN9P50flGo9oNu+8HpWQFgAOAZWX0diiIl7Y3DRpyO8x7AaGfTZwkcLduPfdC9njs9r+qRSI0h51Ay796IiFEYeFevcibFQxsiCvT8DDJELgQWOdIFcDuizIL3GCtSWhEZgHXOTWEuThj5Il8JEQgBCu6+cAAGcM7L5wrinpWkOoAr2H8q9wdYuBBOpmoBvCMNOQIEr3UHgEBJbW0nMfA+5pAfU7b/AJbu0/wMvcDwNRemuPxwRl88Rigxc80CwJ2naeekfu77lbPbx3xN36XxveVcQihr4c7JVKdBXBMABXC100g2kqUFaqcwGybiezc3vvPueiNkzVq4MDtzfrGyPFe9uDYfKJnl+n/61VeGTv2r//bnv/ilL9594/sA8KlPfvSHfyT8+Iev/t//+e/9xS+99GCnuzxXFZFwQKxQLBbuMSW458RUkdsocucUGGaAK6EdeXWd/+kRZBrZ01wDSIAxqDgE5/+SaawH+1/FEYSQQQXSAuJRAmnKdF3oidxCQhR7fI/R5QAzChciXAoI+/lX3izewXoYQprWw/DTn16sLK74Pe/R0+lZca9dPPrG0EYBr9bjze7WPtxIAWDrzE4fSY6HLKIYAMCUyH7gs3d4bTt/akld284XcfjCqQNCl6Zgnn7F2eDTz9T80xvtbFYWV3RnBwCGG93qavOnPraEX77/yt4eAKyeWZOxG/fc9k4rc3yY89yMVqrw5MmZ21v9/tiFfF/tU7IGh2IFQyV9CX8oumR/azXB/RKRp/M9/AXPyZA9Rgp5sLp3ijE8OAr7Rpp/notHeRFPtsnYcflrlJ3+mYv/5R+7VCfefbhbm68+7guc6U670+bpEtROXTpZahyPZWbeE/cP1en7vxawLg/pzY+FeFHfb5Td2jFds3d6VvT67uq9UVMcMA+x2lCSAcA76/1nZ4Vf7137IZxYehSmT5/ONRoXapuvbmeLzVpuSArGiU+m8D0uE+PCJ0cTQG4sQwLkCBM3dkBjja+maSKYmcjHJwGtAFIIbwygGDhixpJz1lu3e6NgIucXEioNfotJtaJm945mnt8nLzClYrCphHjP8TNW2MSWx45Hdsn3HYBH1j2M+XsC9P9OOpn+C1H8sqArw+4rCJ2kcuQG7TSit1N8LsZnRksA1z6VhL/ijtbvd54mX5UXp8V9pqSdRnqQylrokX17F0U95ABgibcG+XZn481bwAQLlVxthGFcaaX47V/+2zPP/hgN7jbml+7f3fjOd78+zvJA8psPW1evbjRiFUq+2ggftsaBQC9NKRyr+VT7m4rQHDURHnhAf4yQTrkUVPEyAjcCHo+0ARBFKqkW3ZGerYkS4qtgAYDScV3oD8/yKk998XuPXCuxYybjSDdyhKItyiCHMmOtHob9NJ1djb/w+StyZjHdWPdwWV1tThfv0/j+7fU+AMxXRd/IQU5RwAAg5BgoDsaikiHZkRUA4Kn5Qpo2QXbPyfjK3Rf1Jb7/1kYCAGdX4+aUvN9vFz7y/CVfqh99u/wT/skfOTX75l57Y1xP+yJm0IB3hkmrlzzRiBZRfPaZ+vzltZtD+KVffeW77dDnOnmIP0q7lyGrh5H9SEbVoUL++NgmYOTsoeJdMZYfkYRPHwwPY4QMckbHsjKeZ/++HW49jz/3xU88vVyDvoEan66gyzZmWVDbTIMZbt1/2AP4yIdOTmscH0+4l7a6j9c4TiO7r6YfBbhOrAA8PHr9+UXx62+3Lv/QuV6/V5WoN0GuwN7pJgzyl2fjX4V+ltswVre3ErgCp2fFnY3+scX7o06fOBO/up1Z6wCc4EJbV4I7EVmyxpEhx6gQDjnCIjKjkELS/pARYzChvz0/71uvjkhMxOnGQhHPUaZaT8koiYp2rAd0ZAyL0baJsH0Seld6BoD3HfO7d0KGBMCsc0hkyWnjXQIxULKM5OaImtwPULNPMzM/AEuzzkxTSQCIrqTUA2xUq1+A8ddMK+nNRUEr2f8ijR/i/JXK3Ed0KwEAmA2TdHkWtnPfg50mambDpCjSa6Gskf910kwMZ8OknUbtNAJIeagkY8CQGAMhmAqU4Fwbao/Se9u9qoLr127cevX32w8enDy18sSP/fnnXnwitjtf/c7tr37/waW1+s/9zBdPLgWS6Mvfuxsp7mBKyONTURgiIkcCZMgwZqCdk4yJI/7XxjrfbV+sEDe5C0OmU4tCCMgchlKSI4mplNISE5TmeZJYF0tZ4zq3Ntcu104xeGIuW2DZ0FYU02GAoYaVkJN0aghilrEIXUIAIGZZMtD1MAyE6KcpAHzxR64wyV062n3r+r22WVyMK4sr1eWF0daef4b32qYZMQBoRmwnY1+/M16qstXluXfv78VoNTAA4EBNhQIo0U44h/J4vNDGpbn1DJb/aQgFwsjihRl5bXv0qVP1Rp2FAWYZ+Zr9ox9/yiP7cKObD1JVC/VoqCo1Van5Z5gP0nyQLkXs7k4WCHG2xsHRM7PRyxcbTy9FZxYDAHj7xk7Ubp9sqGF3byd14HQ/N9bq0Vgftec0tqDgp80hjvWSPKqYPPQtKB1mEBGmreHBWkDFmJdXWqLZajhfDwTSMLPz64NnIczp+G9UzMQ1O7rzNP23/+kXFqvBRL1qawszo84wiBVMpSPttzRdng72Xvn+3uc+9aGoUaFJkCcAADkgd0gKWXZ9vaGut10sHccehezpYI9YzRsASOkOzROVIvR8UPBgLiMWMF/FjwbZ9b3k/Lm1mSvnbr35IFVstsJuPjB7W4NTkfwPLGOcQZafXKp89sWVfJD2BT/RiCqzERwZXCo5H2K1Truj2y2mgt99MHzj/kBKQUBCCI+GtG+/hUTEvFLRT/P7puhE78g5t0Tea9e7d3m2pKRfyqXCW8DDREuzT6cgMs45K9yrPJdTuEVOqPkJOeQI9pkZfwPGeeEiicAYR2TGWmusc+SjAaXgQgo2sQsuLBMcLcrHucc8qmYvjz5v5/KB7GUAYJHzMEWqx3SuOETlKTYeJrEUsRTJ5OuUWNM8l/tf56JgfajkKykA3QTzrTN4uwmjE/bkLjcsulVPqxVIjCyB3p8iYSJh2mk0aSwJHgfSmzgzBohoLDoHHK3gTDDmyGWZfuvOzpe/+dav/vbXvvYbvy5G7U/88S996PLqN1998zvvrP+ZH/+4VNWTJ8JXXrvzoJ3ER3SQ++AODhmXCAa5dnBsOrbgXLn0QuyYEg+6NmAkSxKDKcEgt7wScgAQqqpCnmvhCJELZ/O6ZIrBcwvjWRtuMVevz6QJJcOsV5dZwIPE6ghN281EqCOciTAEmKnJ1RqfrbCtXg4A507Kzo2HyIyqhYuLMQCoSg0AokaTBU7Vwtjk1dWmqoWqFra66ddvDU/OBYtrJ965vSmRJJIGJpytKZYiR84NMq41GXsI4sepAQAZhzBJg8qCEIytR6I9tgHDQIm3utmLq9H85QsLF5ZHD/aefenJArxGw3yQAsDM+bP+6Y12Nv01++RdKO+1xuOMrdZ4o85KBn97ZAEgZBgyvLJU2+70lurqh89Vz71Um43C4QCzg+lUJdwf6/xTFvJFaN/Btum0EY0fUp2ktRSHhEd5jRxoPyTEOHdysVkPWBSoOzuDZ7rmWV5JpkKgpucG33HjV+v4d//mZ5cqThveaXeiKAIAwUkG4oC5LoDN9KibaMNtuvPvvnz/9IeeeuK5k3acAfLDE6dT+O45Ga9kJ6sB3FFYP+xhYIbpYM+Jlckqzo+Cexxpf73D1GWTajRgALCzY0nngtSTl4J6rZK48c17g9OzwWaeyHXtwd0GARozG8uPvvxcJPIHO+MTjcjImfKBmNm03R4lfX92GVHSH/Yy0nknSf/Jt1o7o1xJ7qmSAj1hEkBK5Ec+XTGwdBCyAThj5FyolA9XKiMyxETEMgm+YD48z4+k+gueTGETsn7ysNyTLdP+YhNpZpHENB3cYZ3zd8IYJyKtte+aEgBHlFIwJsrcjsJwwDlH7wHuDN8XuL9/qXsJ7kYADAN7ZoRhYagReW6jUY2s84BenTA1c5FfA9KdMd+cpXcup6amTU3vBGZ2l4VdfXdBmVjMhkliZCTMNLHjEV8PUpcblxtejyVjhUk/TRYlAobgDBERLi/MCKnCMExT/WCn+x++9uav/drvrDbCl66c/Uf/5hU96jx1od7aSy8sN3/ru7eBCoOX/beMs7KPGnOWEEZImoBxPJr7Y6xbaihptRTMWicYcmst964UOpSSS9YM6KIaz8AosaISUCNyTTteqMmAuSfmslkbtnk6a0MeBrOh2UAHAN125vc/LMIM4LRgHuBChp7x6A70Z5+pe4j0RfFwoztz/iwA2ETvvXszH6Q37g2bEfPVsaqF3789+N6D0XJDPnX51Dtv3wWAMXEAkEgCAbwngHWSY60aZuNsGt+1b8kag1GB71IJo20kGVnXzuh0U9zbGtXPn3nmk58Y3HyjPh95HPfrzWhrr7raVJXaaGezc+NhiewevnuJW2ryM4vBuxujlYYKA+z1XZYRAKSu+Jk6ChmenKuIxDZQzhGcDuBMDXdTt9t3fnysNOk81hl4upAvxs0eXbyXIXzeVy6QTHD0PmLkik00AGTWBpyfX52JAgUAb93fu5RQCO4uZQohAM4Z/p4d/PN4/PqS/V0zHkbi7//Xn7m8NDPq27gW1JtVn4dXzijtF+yZHg8yZjbRDd96c6870D/xEx+244xJebyXQFm8kwN4JKwfFg6YIbh8nEhitYO7NH5k38b9T3RDD+57PVdtcAAY9l09MpttO5LuxPLctWsbG9fhtBAPdS7X9f1E78ySsWSDgJLkTEMv1ILXv793Ya1OST8fjJLddd3bywepyXOhgh5UQtA9qAx7mR0N7hl3497oy3eHo9xKDpxzR+iIyDljbW5Mic4wyVkFxnAiOmSMlbaLRWKGnyZFQECvYCl08RPy3RJN2QyUEEmlFBIAGMOphFXrqKDyOQNExpHBBCiIrDc58CdtjC6CU8EX7NwboEFpZLsf0Gqdi0KxkNMfEdwZvneS6jozgwnoKc2Cj3D7UwqyvAR3DItfMVQlvhcgKQUAVOabW2a0xQ/0VDMhsE3tAKGaVStwCNmnqg3hcrPTM1wwBsgEB0/O0KQNyJCI0Bi7OFsDKKTugnOlZJbrV968jtY82Om9e2/r4uLsTLMqwkpDwR++tR4FkvmeauHuW5i0AArJQCIkhIioyDF+zHvUS90oc4JjbgEAagoT4ABQF4RckqMGjS9FsoJsscHnpDtTpUZAEeQpqpnIJcx4fB/l41auPbJP338DwGN6SXq8/XB0djVeOz9bomQ+SD16AsDuW9eLrmbEen0XBlhdbQKAr9yXG/LM6dWrb9/3sK6BSaRoavtihQDOUAqXZGUJ3wz4WBf4PsEFU48EAEjByLr22F5ail+/tXclveuXk9HWHjLjAV3VQt9TLfsB1dVmPkizjFJHTcGyjMIAZ0Lpy/aS2+kBvL7e10M7U5P+lisNxQIIAUIAN4ST0q5ExqXpgjSfPRf8yWcbPOnd7IlH2XZOU/BHJTTHMjN+x5Y7CASSdZZIFRGXOEz0xVNLS40QANqJu3F7u78afSvU786Id+r61mL+mrZfrWLtRKWfq2cvVv6nv/6ZtRPzJslKNJeB0LmVgfDevN5j3Y46aW8D3dD07ead7le+lf3J//TjlahCxkwbwuwj+zTzTs5p/R4kzKR4T3sb5aToe57iSEvp0r3BXs+NMwKAEMFlNM4oJwUsv/pO//IJ/vVXd7ex/3Sl5sEdAHJT2aohAJyruY8048FeMs5YFIXMDE2+jwVDWxln5LJ8nJFutzpJmjraGNrd3vhrD7OcgDMmuDQmt9ZZS4AgfKoR5wiA4PzMZ2kGMNlskVcuFjebYksmuz1hJv66ZW0OU7f06dVFUGrJrU8moTwL423CkPzkaYHpBWr75Gvncq1zbWiyTQwCNZXHVFq1T+ZWvUWwg5MOfzBw5wxPONEDdwjc059oNj6X3+uRWEH7Y3pnzPvdA9vfOrFsnqnzqkR2AKDesIB4AMhyT9H4s7/BjS2ztXt4YmpQMRsnDfZlT2ZgeXWqLRsJ48t2f1poaLCc1ypRqnVqSFvngHHGOBYmM5zjMLVxpEKeld/tMAARVNJUZybvjGE0Tq/e2nzixKwSeGZlNmL0nRtblVgVhMw+JwMAziA3RcdVG+Rq0jAsrGVL4QSwTo4cnSEYG/KAmDnMjJlj2aLUFPAKsgZKX+z408rsJFiWHXhzL0WYRTKMxKUIQ10g+z3j0sTdTxw4mqnJpmAszzx2F+ttLaysnR/cv+kRvyx+s4zq89Fwo3ttV7+9k8wwe/FM483bLXLOV+4aWF0QKgn+FdmCeSfPbBqLUpyos92RBQCMQs+8P7WkHGJnqLVxqUNDGDBUDK9vjJ5dq3zlzf7dnayibRjZkpyZRnb/hFme4QRg/bMtX06W0baj1tDeWertNDK1zjy+++2Lr+jjCGdq8rmlysdP1X/smebTS1GoIcZonPQfjI/H95KRP1YcebT5VPiAOlAMMu3AmZI6yYytRuqFcwvFpMat9XFuTy3FcSzPrMzXm7WllYWHyMdZBpifkPa//9lnF08ukHNl5HSJ776aJuvIFFSMR/a9nvverfbKx04+vTgz2OsLjlxJ5AdmqZALssYzM2SNM2CzjMuMHmHo5GGdrBsPskMFe4ng2nDPw0wz4Dbd2d5zw95USy2j8YSiSbIsbKqTi/GZKmy3yIV8kBsP7m0pxzWTEy4q+8MvrG2g29oYPnuhIVQgVNBNZE4qGWakc3/2sF40qDeT1Nrv7eSphVBJAiQCNomqKy0TPXeipGRInvqg/c8UrdG+j+nJFgQosNl7OO8bLxYpqaWkfXKrwh9gvytbpil5WC9vz8rrWWn+5a0IdK49vc4RkTPP/JSinVK/U+4YkDGyThMF8SOZmUeBO5vwRXViR8G98bkcG9XZVX0X9JnzczQzHL4O6olo5sf0ektFA1cnBlvEzgX+6KDeELLJGuxr+eyw5PFGh60/HAJAtBmb2pGZ8KHsYTZT3wf37V0cjZEHBVcDAK27am87FkuzVUONLNdZlowzM8pyX7aHQkgBQsDWXq+5VoWpeVGwozCutPujXq+vAQfj9L//F1/7Wz/3crNR/eGPXBxl+ne+d7cRq9w5Z2wgD79lEVLCJQDY3HAlvDAmPa5N8exKWINsOzWpwyYaAFirKxVHADDUBJDSMJirHv5Hamc4G8zasMpHYbUm6vwpANO3797v3B5af/s/4FvYqALA4lV3IarCLDSAlfS0F59UFnem9ealZKX75h4ArG/2Y7SJRiPqK031cNfEaD2+dzKa8ba9kiXaAYCbtMUbEfSSrAUQh8F4YigXh+KJE/XfutZNp8qK3ZFebqrvbum1NwtRzz3jfvu3by80Kp87FZSYXupkhhvd8nkeOt1rmx5Aa2jfbOz6a3bInJ16RV5OBwBzs6xRZ+U9A3TnDPtYWju5YP/F2+m0CLI8GFSeOUfTH18phJ+eVj2gg/Kj5o4AhQQCAA2IiFcurBUY1Bpu7oxmGmGawepC5fRCLXMwGKatnb25avTnPn325z68BgD3rz84cXr5WDG7J2E88e0l5Hs91+r1Ho6yT4aV8SCrLczwKYcZX62TNYeEjzYdA4DVwT7xIqqH5DeTMSV5FNkPXfBPxokV136403MwmV20owGvHF4YLp9aqyzOmL6tyr5v+B+joB0Oum0z1LTXc+VdlZ/p4VGvtgOAtUpwrpG20gwmeXVYTupPspCQMZjYuRCzJeFeysyJoeB80g6lwoAXkQOQH1Td57UKM3c/cwSTByo4+ska4Lf4Jfkz6aTuUyvFq7M6y4ydCGA459PjkOic7xw663xFOe0ezDjTxg54ucTAtCjrB9aw23FVNAAAnjql9rZaANBbU3PPAADUn9H2IT2oc3UC0732EtL88tz7uU89oRBCjsnRnYQhNqyUB8/2Lo7u1f0QxHpzCDCkbmFGwRdnqgxJCYwCVa+ElTBQUgGB0SY11hhw4Eap7Sf5OHOOBaGgYmqDVyzw7fagXgm3+8l33ln/6OWVWjU+vzqrGLzzYA8Q2SSzdGoVRAMYIXnM98xM5g7zMzUwf/ypyqVILoRBXMHzkTrXCJqhCjmf4byCLHegOJ6bCzKA1tCuLkeNvs4CPmvDxYptANXroVBBqUPY2bFvtca9M6oTszeyTWxU/RJ6Xw0f3MdRnj+9FB0hXo2naLJJPeUroFbbffdhd6Bzb7ggKDGpfjBwnpYpi/dIsmfmq47pbuLmq5gZaEQAAFoGOQgAMFJ5tl2n+dub48EUG+iVkQyRA20N0qcWGpkx9/pJq5dsnRptxrX/0F2f09FCLfD1u6qF+SD19Mtv3+u+086CmgJHvcShBl+zz1V5bRA9KetnqHq+HjQFW2py1JA6urMxXl1UT56QzWga2SEfpM2I3d3JmMUAMsUBnclAAADTaUB2KcJx7tqaH2qcHC3ej3oFT6eOpLm9cmZxJgRrbS9nr737wCE+c3bx5Ssn/85f+RNRGN9+sF0PxZ/54Sf/7o9e+Phzp4NKJJv1WiTX72015hqHORMzzHY2XUYY1ZnZbPXD/k7S6vW+9UrOFoI/8enL8Vwd2X7j9BDDPk3IFPdcJnsw5TF9ms0vtTFHiXVv3TVOZFm2E6u59sO9nptvsLJOZyqwo4H/STpnKgisfvWtzScvLl196+G3/jCdX2G333DtUTbHWXuUbdfBMb6o7KVmteeo19O10CVZlmRZuQ87etruJLmD3MHXNrKBQSUEIgEymqLFfajFvv8XFBpIa622FgGEEIBccFYKE7UxbtI1Le6BIRIYa93kfn0rFcsKfD/goxBc4ZSWplxpSmdgP6OUa53lpuiaCiHk/qB76VFT0jLlguCh3d+Vd7Y5ysz0Jdb1Iyv3aYJlyMhfgOd55Y/h4Km8Eruy9PbUuam6hYb2PdLhKtJJa5pG96J+W5p33N4dmDlN2Kj6//K0u7/cSrJYimv3851eUWFEI5VW9iuDxYaohGyrwwFg4ayKhNneRd2LeOhapmPHaIZSmPr+tnJx5sC4B+cYSFaNVL0aNatxNQrnGpU4DIRQDtxglLQHuXVQCXmaamK8PUwlhzBQW+3Ru7c2zqzOzNSiMyuzq3PVdx+0hmMdTlfuk/G38jqLOCPdWgU7OU5POV6alys1fr83yiysKKUKA3dUEw9JxdErwW/3zbkqPx1hGGCJ6SbP/fl2blu53h3kCTPMupkxdWI2CMhzXv7zqJ+As9BkFrzM0fPX99omNrnnZDy4QYTdpQAA/QBJREFUlwVRHOHpuegjK/Vv3h8AgBTYXF24dqcbC/DgnloSglcFKAEB54lxoYRQQk2q3FnJZS8xHtkpSVGKNLc2DKNAmEmaq0Cogu1orEdivZs/v1RdXVR6aCngo4ZuRPV+Ong3651rCU+85IO013fXHuhX9/rXFjrtavK27T1Q6bts+DoMzlD1yVicbvKzDbEUsaWINSPm/zEMEDU8cTL0HYUsI5Znvp9cdiBQ8PHYPLXQOFtlz84FVTE+W7UvP7X6xNNn7z/caycWRWAeQUl7z8jSRXJaP1MWZZmxl04tnVmoWmuHVr7y5u3MUCCwUWE73ex3vvo6muxnPvfkn/7oicsrdcFp1BkKTpzxUWeYJmm1Gh+q2bOdolS/f+++bqd7nR57qH/13taWTf8vv/B5HkgfN4qce+3jvjzmoBSanPPBSZMXkwNTh+KwKesDwLFUu59dmu6m+o6uyygO0fMw+39SAQCQzv3PrnFO8wb1mhF7Jx1WXk3bowwA5jh76wwNeQAAi8qenKtc38t7o/T0XDRdfxx76g604vh72+lX7w3jICCyggsiZ1xh51v2P621QGALaXtBuHPOvduMIyc4d85YR8Zaz+n4ZGo3yUf1gF7y8m4iXd9HgtLSa1K6lw9E+yqaAuu1MWmunSOOKAT3sL7P5zjyvMzRRylbBUXqp3UBYxiyQ8zM+wd33yatE0u/kE9T5CWYzEUBU8aLXmIpFhp8t2cBgIdmZReFs+PcbXO9EFqvlvFEjcf6G+8E2zuslaUAMBo6pfAQssta6HKTy/zECVho6O1dlLVwaTGpz2rJRS5zWTUYJhgmkEbHgPthSnECppxjXGNNqVQY7fWzrW4Wx1GIdpAZo+1sVXHOOmP9xo2H8414caa2OFO7uNrcbg/Wd8ZcCc6KuEhkPJrU8j5kei2wTUlb2X7xPiPdqYicNTWp1irBMQM7mi6frPhDuZPT2VhkGe0EotvWrV4634g8/9jaS9ORgcTe3s2ZdQ2AEODVbHOa5EqM/eh45XOngl7ifN16bWPwv/YevMuGr2T9l8K6B/dGnd1dW1s+sZKbAST26Wfm6/PR+u7o+m4eBKLerDzcHuhJL9oQhGAFgpIud3YhVrmzvQT6mc0MGM61mejfjUEpjLZgrLDGEAJAltuXl+KfuTL36t2uIcwJz1bZyx9fWY1oLQpsL7xJWwCwdD/+8KnYsy7mPvAa8JWgKsWTvPkkb75te4mx/ryj0p948vTM+bPIzMz5s1653+u7b90YoODnn5rz4s76fMTyrFwqsoyyjIZ3qdLArV4eCPHUarjSUFeWaifnKnxkz67YWclfWx+P9CMBxds4LwZuZA9QNN6ViBxlxn743MLaXBUAUkPfvHp3ZBxoqtdCxUW73f/4Mv78S6srEc/HqeDEwzioRGT0w1sPBlu786vL0/6940Hm2sVY0PffaW93kvmxut4b/dp66+Z1+Id/84fjubpJMt9rLQOVRH0eWeZyc4h/N0m2j+yiWpoGHxhicvmjZpSOimSI1Wy3N02yT00HD2hi+sYrtWt3OieeqJ1YbeSD9P6ukeu6XatAms9x9v3QkZTpOL+yGn3yTOX1jcGKUjO19xhMvbMxHmpSHP/N9XEnc4EQjkAb6wgckcdxbe3EId03MgvGXHobr4livUi4pmLWnzOmBGOMMwLGmeDodwM4Ccfw9u6+X1pQ7YhuIpkvtvMeghmyonFaILuxNs+1sU4ylFIKKWBK4HhgqQDgjPnVqFDyTITz+1sK5zTRwhFB5AcCd+uoAVy8wQdP5YfA3f96CPSZMqMxAoDtqgBpcNbs9Eyt7irzzZJ5hyy/dj9vZWkKE+O/nFQx1g+LDTHK3LmTuFbjuz1bCdnSArXTyJPsnpkBgErIyvMYRxgm7wHuByf0mEASSNUZmSTQGYxXZ1WuXT+z8xUVK66JxobevLOTpPnSTNysxk+cmiNmb633Mm2jUCHj02U7OiLGugmNDeTA6sI2JFyq2hMVtlZX5+sxQ674ccOrHMujmSnWc3S7bzo9zRTLAMQor9bCdDjIMvK7VKYYAIQAPYBPP/PiF+erXzj31MnGGXdzFI1rp5tiKWKXP/40MvPvvnz/3e3hqFF8+MlNQMGXmhwAfmXr7Td2747j6sqY/HwTtnrvbA11ZoJaNU/S1sBYBK0pkkwDA8Z07oYZKekAIDOQaGeF0MbFoTDIAMBDvC/YT0S2Kd3OiLSQF6r89GzwzfuDvsaVpnrQGX90UflC+2xDROP4Oao+Mxt5VQxquPT5S0s//rOnz5+5eGHpzEq12mtTu5LeycMTPJZC3ojNtq7nHT/3pEdDD+WrEa2dP+AV61G+ZHgAgNcAAKKKSBKarbCucXwbdYXiCO/cGmBmI5kTgXVuaI7RtnLEurCGIHNsunJ3iJk2lugjT56ZqxXymK9dvT9IrWKYESw3AsF5Vdj/6meen5mdAYBOuzPoDXutztubA72+zsPg1OXTkqe+oB4PMp1bZjahcqKb2N7G3m/d2t5L8391r/ePv9dbH9B/959/4tITa3owLHgVuS9vJ5OTLSaYymFUZOBy7V3XPc9+jI4i6z9qbuioqt21H+5udX3NfhTcS2QHgE6SPmzno1b6wsef+Oa1rbd+o+XZmIuKA8C7FUdSDlPz8vnmxz5zhVHa2UnfE9wftnO/YbrZybbHwDgrSRWjDZWDnoxxnGgNueAMOWPeyb3gzScp1cgYTeI1YJJm53WN/pvtDQwK9fzBIKfpLiUA+Ni80rpgsjSaPMu1sQwxkEIqdaicn763Se4SlCOpJVM/oXfIW0wa5xb/aOBezjFpK+JT+//SSrLKfPNogzSWYuO+4qExTdOFwGWy3nCjMS6E1qtlWt3B+BXehcAju4fytQX5kUvhmSVZq7vRGEeZW5plsRS7Pbu0QOXIUiGpqEDOIzeV2uEh/gOAOwAYYAaYM6wSyr3++Kmza7VQ3NnsRpFfZdAZqwnubPfub3Ya1eDMytxnPnT58lpzc7e30R4BQiUU0+Srv5xaWI7hpWW83FTnm/FirELObw2GjQkhc+we02meJNTtJGNkc1We5BSrohVjR/k0lxJOkP1Hf/zTyxcucpsknZ1Tly8+9/z5T3z4wsWnzkXNePv7b++uj1caatA32OOjhl66H//cj545+8x5X+pG4/gMVc+G6nSE+SBFZmKTf+VGHwCcNcur8/c2B5FkxlJDumcXmSCQHI2jYUbDjIwjAOhrBMbIuliAmaCL0faZBvuFTyzzPHxjb8yduzPQb28N2oYBQC3kWyO3yIKV2QJEPK9STK5qaNQZC1xw6mnWfdB993U9Gu6ujyOBFxeql6l6maqzJOdmGWqYplzyQXofeDRIVC1sXn6Oc6ZHw2mIH+wlUz0A7IwcC6Cyy+5zE0cIADM1OVOTszyuVNy8NHsJZY6FSh4SvAeM+oYfouCHSd6I1YuXVpfqSnDcGdqvv3mnP9b1SI5z16yIWAnB+UjT01yvNQwl/WrdJZnQvcHZk4sLpxZnlmZ86sU4kTq3rv2Qkn4niwdbu7rd+v++sfmPXx1/7WH2Tktnji6uzfz1L1zM27dE1BRROD2V6gwgukOEDJPCacc4MBUxFZU5G2XB7hUy/tG9JMarYrwS5tBoqE13tu91Bu0+U0EJ7mULtAR0L14CgPU9O8jNTpqfF+NQw5v3aE6btqU5zm7k9l6NG20Fw89dqrXu7Fx9p798slK6jTSnZjjKc+poqanGY5M72Bymt3ukpMi1ZojOOsZZoYFkjHMuJg7s5ayZj8MuzAmM5YL7RiVD5Iw5Z/aV4IxZRz7Qo7CRYQygGCVVggnOnCMEx6DswmKZqIeI4MgYk+VaW8v2SRg2CfbwWwLct26fcC8lsc6KaNYiRISz/TEsIGcmaveHMZYQ/4OB+07L9EZyEzOmTFGtH6d+uXY/52EBuzw05eWFBsdQUW+4/lU2fFcHIQwq5soFfub83JkGLUx0gJX5JqOxblf7benHdaYVkPPLc14mHwlzFOLfl3t1iDYl7n+W18SSf+qZlZXZ+nevbw5G+VxNQZGM6jTg7d3B+u9cffGJ/i/88Y/9yGeeOLnY/PrVe1+5ur6x162HMpCMGesHmhLC1QpcqMEhEqYm1YPR8GSlWj2otzm7Gp+eFaVcZLjR9WqQuSqfJj49rN/ZGNfD0OtAvvD5KzyWMCwUIw9//w+qq83K4goAbH//7VJq8oysjhbc00+egydhuNE1fZsOB+BdIQEAbKlR6fVdJNnG0HZ2x09ePntybvdBK48CNhO4mlS9JPdSmUiytbq60Ur7jnu/39QhpAaj/Td/yHmv7661epeadG8sAGA7s4Hi3v+9EbJrrd6HLiw8Sg8z3OhWbnyNzyz6/mqjzk6szvp3ptV2N5PhtRv2UxdnoA8A3Tfa5g/4lj/sPgfNLwEMN4q3wrvWHLXT8W9gq+2aK2zOHO5+L6JYbNZqMvvKet5/rOhAMhxmlqxem609fWbRpwjc3Ox/9/qmAZqNBYADgPlq4GU5oZK/fLtz6ewMAEDPzTcsO3sqrgXlXBKA9P1JOxoAgN7s3efmV69v/+q7KZOsAgwAuon+k09UmNkMZ87IanzIH6a87GM3mJTIBa80Abo2LdUsnXEi4yMeA6USZpxIZjZd37I6L23CvEqHmc2tB9rrYeYbh9+6QzoZXqm1ej2vjfnUxZnv3cznZln1krlxPYJ8uN9/tnRhRvjDuyrxXKPhX/6jTk3B7hk31NTN86vb1pLN89z7+srS75PIU+c4KX5hQmqXlgC+bLdE4BxOvBh9oQ+luzqA77WWL5UxUSwMPm7dWi4EHaTFvRJGm31nGCl4WaR76Gfe45cBQyTGvCMCRxQcGTBNtqRrJjr6cmoKiSwRY5yDNqU95B9FJAMAc3+W5iLXSg7cgyfQy5ZeK8lKDskbv8xFwY0OK/Uw1+7n6xvw1HPVEy/p2YR7Oc30PVBvuL2L6aYNVzgA+LJ9+uGmDWoKLdykH/u+KncDrPw56fjR2LjV2epsLbi70X7YHjcr0jqyRIDIiIwhALy/0/n9V9+lzHzu5Uunl+ZPzYYLtWC7PWj3U0KKOfMszTNNmK/iUhTtpDlD7nv6IecEkFq7Pk4irpZPVl46HZ1ZDDwzribWaPkgXTs/y9ppc1KnLDX59ZHNAEKABxntpOPFpfDTn78CAC4duXTkIawcDvLGLJ6IaNRZPI9+EtUTFK29dHtkfa+1FLz7sc9GnXX7dLVjJFJjtvbclUuvv/2wIV1qYZxb46jveIB0diYY6Nw67Ke2FvKQbApMYMHJpA5CZxzg9e3u7siGEnqaAYDgzJu/k3VxKLa66bm5yvqeZQGEDLvGre/ZOMKQoX8+o609l/f8c+713WAvOf3SU6MHe6/u9QGghvLuKB30DQr+Zb5VsoG7lfQF1wwD9G+Ff0+mlfL7uLOND/JxVBFH1XWBEKuLymU0GwLT6cMp/7G6sP0p1mKQmFoonjh38vRCNVQszd3rt7bfurdngJTggrNMu1osY8W3+2mWZWDc3d1sfa/9xIIMrB4NsuHObufhZr8z7G63R91ef/3haJCRzvUm3E3Mv9rp/qNv7X1zI63Hwmd49hNzshr8/S9dWTh9lsmw5NkPU466mEHlSoraLACQTskYm+lk73b37ga3mWrOFrKZSUheAbWDPdvtFS4ClROlAYDpW5fRzo71/dJpZPerUdk+JZ1vOwoBkixrtV1mTO5g+VztiVl2e93c+YMepLnvpv4BR1sBremlZfUf/6mPDkWDOoO5mYipYJrYOXq6emcIAP/mxujNvSQKFGNsEmf3aItmROecsdYrF33HUkopWJGBTRMEJbJlynbBkBAhFUTNVHyHtY7YlK7GSyWNdXmW58Y6R5IzKYUX0SGim3gPlKOzOHnmthiD4gz3BXmlKQ3t+1WwUinPAA05hYhh8Vn44v19Vu6+m/ogwpOawfO8+VyjnD8q3jGvgZmq3NeHypfSSwt0cq0RV2MM1VxTMhp7zv3/x9t/B1mW5tlh2PnMdc+/l7YyszLLZFV3VXXOtJnp7pnpmR2PxawDEBQIgVgaAATAYIABhkhBwUBQJqSQgiFRUogMSiCwEkUIFHYXSyyAnXXYnR633dMz02bKdHX59PZ5c91n9Md37333vcyq6d0l9SIj4+bL5835znd+53d+j74jhyX68hdUItmbq6e30PTD+3edrebIG1lWCPfCRN5A5s8xHaq9tjSNqU91y3zMEyc6Umqv5Z+0O/1RfNQLPJsRRqmG1NrUVUQi6ukf3t27+dH+5cXa8sLMXK144+Jc0bGaPb85CDXRq1V+tUHOF0sAAildxkoWiRQ6UWRsuXOuYzPylc+cm//Ua16tQKjIhIX7m4OVy43BXsd1SCYTuw459NW32YHV92xOi6791ZfnTW9nPBy07++YhWEqjyXf8pM4zXdHBu5rHt1sia6vfu9B52E3+KNqa3TknHNZGGoh2O2jPoCDg/bFsvZ7/UAaboWYcgAO0b5QHV+1BNVK1W1UPXRjygkKHDMugmF4fcH+15+r3zwcdCUbCsoJhCYG2QEMQ8Wgd4doEKK17PTjg2704pp3rsGM6eXOdlzgxAC0eVKzF+vnrl8CMLM2/8I5yw+kHIkioTvD8IP5bva5MflE8ZG4seBlmWimk2tqixDv41Y8AHCx7mQraM2j5xqswEl7qEwDVIk4CnLoh8dREgTmUG18rrHSSuPCucbz52c9iwA4aPbeubuzezTSSmtGXEoIJULqC3Pldn/0QlsuhqiP1Esht47x2w9HIx5xbZd7VA0gWhFxomgr6nvqw53htzabf/+j3q/cbH/v8SDUpF7gAFyLDCP9yQX31/72a6tXz8swptyi/GxkN0oLcyzCmBaRjgMZ+HLYHmxvj5o9AO5sgXs1nJrQHfRPskx2XmGZJmMKp5n2MsXZR6GewuLmifR97fvaLJZv7XXO190Fj/7B/dbRw/ihEqsx74V6zyGyCCH1F683zjPx5gdbF2d4wXWnVPuJVblYfrA72h6MAim/8yToRtLiBuiIKXViynSotTR5YVKKWMRSCmOHpxSp5TEfEZym8I5PFtVMS8qpaXfXWqbZvcm8asPHhZQijsNYSqk0YHFmcU4oT3KFU+ukTh04CX/PgFtpQsAS2UXpJBgYNB0YkuVKGuZOjU1ZSZuQKqPI5bN/THBP6B3H+ZjiQPfhePOTr3kO1o2v8fA4POqKokuHIzKfM1sXSgXDu2/d1Gsb8Vz1jLKNoeTGCdN1oqAYX5ifaCM0YTIG7j0ujCYzDNWfFtwFqG1Zh60B09p1cNQLKEHRZopSKZM1lhGYAAPO2e5x7w9//OCg2ap4dq1UuLo69/LVxdlayQ8DJuVSEVXbLlmEEtaJol4sAykNsldcd2neXgmczhPfLffi4eD2rZMtP+kv3RvIezvDvsShrw599agn9gP1pCt/6B0BOHJH82HxF15fKM6fk34sopERlKeKh8b7aHDNGEjM5oBGoYH7n7TEsKXefHz0pOCp8wNzy7LrepwUPHL3YLA7JGWP+1G0vljbbo6yUB0Aoaa9QAbS9P5SwXgoCScIFJm34tdm68yRza7fGWA3JnHqthSa8DSbISC8QPVhT56vkIrNAby0WsqvQx/tDQ+60ZOjsMfZ5csN8wSzLJriyuUr1y8NRsfbu/5x4KuF8ZrvC7lSZsNqvHlffPd+Z7Mvq7ZltgJG19o9ke2hahQpK+Nc1X7+vJtfQbMV8VyDdX1lTKIq1GWXBEF0HNG6pXqCyUhIQuYa9cuL1dmyB2AYxvd3mu/dO+5FOtJaAAWHMyCMVbVgF13rwgC/FLllTV6Be47wc4RXQrm3Gb+55/+zVu/BqP9Ou//r94b/Yqf3377b+d2t0Tt74sAXlPFagbs2ZZZVLVhCyBvzzq/9R1+bPz8HgFqu8TrmmTthXEWhSe41JVPCmIpCLUT/ZBAe7Z90VaRtm8aVpZXTyD7yrbz7hTrUgDsV+6a14kxkz0SkvIR42PYdzo38ddj2V8rOYtnq+ur2Ye9Bj64E5FqFHRHVPKd6IWZc/fOvz//Wj/dG/fDlS4tTJdmOUG6utefB7miv77uMuYy9tev3pba4ldnAM+nDGGWEEMn8eK2V0gA4ZxbnFudCyqyLNTUXKkqZxQilLDObu0xTAkmYVFluAU2RnQOQSkkh41jEUhozFSXEti2S1ON1PlJYp3nCOf8e0ymCQ6eqDqHIBZaRtEV17KkHISCaQEgZKz1nMTMg+4/F3DNwp1JVNOXbYS9AcaNsvOrZj4F48/0ytdCiSwEcH/lZETWB706/hejSeeILWTgVH5vFRpaKWGjQhQbNAN0XluHpKhKZBO9xYe7O/DkcKI4/xanksd328Prq3GwpOBkE1YJtU2g+DivgDAzE/EkY/d6dgx/eO7q+Ovepq4tXVmY/t7H22rXz97cO7m+f3Ns9rlB5Zcat2TaAThStFJ2LSxM653e+c9QLgiMtAByujkxSzAvdpGH92+wAqeieiVa/8PpC7blPxu0j5llF7xwAM+Pi8P0Pp7LaDVfdGYY3We9nWoufXRrf793d3qMDv+oBM8dAUhW4VT2ekYutvdGVGfdBNwCwczyquHRlrrBzbNoahZnHZH4bGg7AtKG6VPfhvHXcZxY5DNjmKHCTAFS4Wi4UYJT3CcNDL7IL7LXlSr6TFoCuOLv7vX4c/cdfX810c5M8U1qq1ZI5fLJ6ufyPfzJW6NLwOQC4M9c+BNlEaO3qP7NWyxz9Rmc3d7fZEr97s+M57tqs3dobmXEi2SMpHtPhnMp6IPtz0ZNtYgSZpXMz82WrUvKCSA3D+KAbPdg5HA1iZREIACimr4yAdh0WHPQ2lGUyrPf1hK3hjo4uO3Y7lN95EkaEuA4vOFbNoUbNHwqtpbIdj6iw2Y8+MW//47/zVTO1g1oWzpp6qqXIAt9lGFulgopjOWwH/RPVkxnvzjd2fVz20zsb2c+wBojkdesFgakP7QzDz1+pm7EBPz7CkQg3XAtAJ9B1hwD6jfVSpxU2u/43ri+U2HAgi4ahJwp72qTaBbY2h50o6scRgIOe2htGnuPkJfJYSiWlksr0nTJCCKWcTQTwUkqzuJhMsoGWZqyeNDnqKRz7wvw3mZGdMH1opUkUx9l0JEaIRQlMaLDSALSSOrXcmLTw5I6UAqWMMRNMNqkcwSg2LK335i+QW4ckIUxpScAopSJtQv4TC+7LKWx6t/Ux+mStSjqqegkd0syMiQtzE/K3UWbyYrr5Dm6sh+abOPWvCUntgZyvcnNT89VgSlg/6mJjnWWyProDg+wft6D6tFPR87q+/MmTZr1cwCAw3zFY1GReh2byLaMug5YqCKXJcL/16ODO1vHlxeKLV1ZfvLz4iefWrl1a2j7q3H54+PbxoSWGV2v6Wq18calgvBnj3usYBtnnCZ/frhhcu5TGD/xSde03u5v5XJ5fqq4BiNtHU9MtpB+fWTZ8eCRWis7KtoMlmEJrNkD1TdLbGYaHCIyakQfW5Yqz3gzaoXjtYnn7eHRjra78cG8gDb7XHdJTDECNiICwDNlhputRXXB5weWuH2Yd/AFh1bRs61J9ocEOOhKAH6t1r2R2Eqbj1NR4v7TqYHUuKw5nJeL08X+QVVm/cX3hu/fbdoGZpTFfijGFmuftSrVCq6DZalebp+bAAJAfBoCdLbrmXx2hMIcap7V5CpTe2xp0fQBYmKmuzJRM1TSI1MOj4fb+SXcUAaAWVdC21tRmACzoUGiXcyrkZ0fcPTVY7wDqN8vilQvlElU/2FHn5osWJbBcl0gAbqEIAMMAQK3oHnVwpSr/y3/zFYPs2XzUKU0mm5aXMXeD7IPdw2DQN4hp0Fnxc+DO2POe3ULrjFEbqrWjUkEmQ3bTknombTewDqDiumZCLwDScEpL5Vqvtd9XlwJcKbH7kdyuMBbKa3Psb//y5z46jr9/5/Dx3ujmpu6Stg5FV9H+IPBj1Q51MyD9VtxnJIAOhVax8pVSGo7DOSNKw4zUkFIatww3tDEdkwQgn9NifI22lXNbaq3SzaVSwuJcqox1SwKGNMNdaymFllKaLgdGCCOEUpKFvyilpdZM6yxGUEpJCCWMJEOxKYVSlHNFiFZaEiMMaEapVGa8B1VKUcqN2UEple0wABANqc1MP4qPM2fvp52mlgTvtsbtDoDgj3BccQFY8zJeF4fHZGFOz1f5VP1zvPZUSwBmcrCeHZgvppnmMeM5yyv03t1esUTzJVMD3yn6Y2OdHR6ToxTZzYWT++buWM0RAfv4T3WpUWr1hifdHo11EEordYBEmk5lOLgO01KFgtiMEsoeHgzv79x6892HGxdmv/Lp57762uWvvnb5o8fNDx/tbR72N/f2a/v9F2anrTIFwTbWitmI6mz+XI3ThVLhl5Dg+/n68qUTuQo52OvkQXzhxWtWfb7z0QcZNlUrdPduK+OqxopTWqoZcDTgVa3Qi0sFPXDa3kRh+jeiTdiY8Zwb54tXv/jCz3/iymFfPfzRH/lhsPdgwCwuY2EgvlB0iq/GRYjdH1gAWv2IWfwXPzFDeuHb+33qOdRzDF62RhLAvQ5xbLhUf3GxAKDnKiC+MuNenufvduJb1eNkj9Ja/ERqHDKYPt5UpVai/NNfa3Bcqdc4rVYamy3xg+OeQXl+k5Qt+xNX6p/I2ZCAzrsPIkMnL8/zl9ftl9GY2uhkrHNV8hjYYuIHB8e3B3ZI669cHcP6TnPwcK/VGYScM9dhQSgB0Fhzj1MQIWQMEmntcfL5I72YfgGz0TP7Ov6jggiF3mqLodBz1bQbUyND9mA0dAncQrEzDFg0+pV//9Or63VDxrPJeQbizbEM/Cw8ALwEMTB8LuifGHOUgWZeYYqfK3hxtmPLazLTsM7PUbF/JrI/TZAxq+Yg1ktljzfoT06i37998heu1Kq9+F/e2vqN+x02EDds634kb0fxuxY+Df786mz3wc7/+Vfv/H8/HAGDrDUsazKQT6mRWowyZkmlc/ybWLZlSpRT7aNjhg5IpYxX0hRFlSZaaxMbIJVilCXGV6VBQCnX6QSPWKrs8VCWlGHyJVySruJSSGobjKYJGadJ46tWCoRIpThjcRwDVOskdsZkC2eLCiVESIVUiEm6UqEpSa6QdTadmTCTsOlPFma/6o6+J5681b3wmeqobh998xgAX7fkETvfk1t4aiQ8HYSq5MTrwiq7xg+zMKcNkT/qioU5ltW6AKzQ6nZ790zcz+ijObhSV7slmkH2491peXA4UDcf5Dh3ugzwWtHtdDqdgTSNDLbj2Ra4K7nJcdVPBXruSrMMzM+7PHR7EdlrtssetygJmQUhST64mVEtFWHUTrJEYgpi2/Zx1//tH2/90Qc765cWvvLS2msvrr/y4uVRONzd7t9+tHv70SO936p6Y5fkUtnLhs/VeBr11UNHKOx1Vyv0b1dXuj1VVWQTePNW74svVCbiNd7/cOHF8Z/VCs1XDi/P82qFrnzpZ+L2UYaJm0I1t3J4mltgs0FZf/XPXKo9dyVuHzWAhS+9AXzv0YG/NxCFolMsMBIInPOyoJ8wkq9dLH/+xdnrS2UAL91tffdh/9bJIEhmWJEwkjIWo1i4ZdvsVAC8cZ6uFJ3f3ewkehTQ9MNvewdoLX72hdkzNlW5MbBmDdtsibUGN5v9Kuhag681GkCj21P4xFhgyUsQvSB4e7//+jm8t4WXVkt5Oci8dDVO0cDjvdHvDMMHfdkkZWY15uaKxgnT7IcHrfZxN+qOIi2VwwmghEw/eR63GdFSMU5CoWyCT7YFYP2YRunAswiAKjnbIhoU7QWLwnKXyzIb8mdoe4LsKcT3T/r/x7/x8up6XfqxVasjF+GbHWRqTELGxcDAenKzpbLpjTDITsU+MGtamfLk3eD4+OtQYQoQOTEn72Q3QH+mYbEXBNvDwY+a/ru/O/ooiJeK9r+94XYr1jud6DtPwr8kHLjoBHqzgDmJ/+jPX6z24r/7q3d+7V4oCVFSWZxloopBLstMHzXWtQn3S27sJSGcMc1Y5nfMADFtQNV5LzlLAwaM2sEoMtXFlFsZNdP4oJTKtJcxVU8DwKfNOVkMidZMKUqpyXrMdg+WZUkzOURKM79JKWVbllIiC5gcBwwQnTRnTcRYjpsa9Lir4Oxh2VLp2g13hVZ33ujOr8PzgkKV3/+JvV7F3DfKYh/BP+oB2KVi+ZSgvV1h6rOChw4rk2yW6ZW6apWTiMebD+R8NQJIq0yv1FWG7E9TY+5sRdnYvKxVNa/zTOF7HtaTz+T/83/7V370wztCqHZ/eG+n9eHmyd5+8/gk9ly75DBeBg8hnDPofHaOCBgnsmLrPeN18zhhNMuHNZiO3EhVQojDidZaSUE5c5kOgVuPDn58b7/2W+/9zMbqVz995fXPvPDpz786avUfPnrQD/TJ4dFHDx/sPdxdrPR7QTmbL5pBs3G+GxQzQGb2uW/e6k2h0pkDSGucLixVq+srVn1+ipwaeT2/mZo0sabK6UcfpOvBh6vA/+JrywD+7z9qfXQQVD/lA0MzGvHFi7N/6YqbB9Bqhf78S9WNVvGbdw43R9yl+uU19/nlitH6n3SVtxGM/PDT0UqjxG6mLsZs/f82O/ja/Eb+qRkKn097N08/P5F1syXM0tjtKcO+X67YGf031+32VL7m8d7WIOswyMTiH+z2Hh34XbfoFha8Bfq8a4cKzVZ3pxkfNrv9URBpahPlMB6mQy1GsYwjwRizY6HSaVwqVgB2CuxukUpSkjJyLGpxx7Yod2WNNWqpLfz0+NZAB6YxKBgNt497f+/PXvjGp9blsM2K9fzk6ylBxujsBtPd8qyZnWSc6flZ1eac3NdlAt95hWXauhFkplqTMmTvohh3+0YZz0N8R6hvbXV/byv2fekrBeCvvVSaadDrS+XVheHnVa/mEgD+DfJXztfmqsVVyG914t/biosFz5aqNxgCsDiLhVRSJYORnhIvw3NjBoyvMQNcBchUpMpXL7M+/ix1IAsIg9IgKoqi06tIto0Yyy/ZEpLbEABQgMVZUeueKcsRQjUUQbpRgNKKEkI5N/Ves3rFwrTUJpOjxrsKUKP2mwmuWksNmgzxgzISPZ5ZNZ27YfNz2FFd0x+UCC/nOVkfAeDnsF1h6J3B3P0bRJ0PF+Y00DXTTbPvacPF7pQDvTsASiY5wBBEo6rf2GhMYf3uzmAXAAYZbc+rMROVm44h+2Ee3/lw0PrUp69XZxdy7q7g3Q/u/Pe/987tJ0fNdhSEsda6UirbFjWEnYfIdzMZgu8SWSm4zVFQ9rhNoYiKNCWEIIfpWcVjnBmUo/YuQxCL33zr/u/88MH5X/v+V1659JlXrj+3Vll/6UXY5fbe/t6TD2/e3Lv1aP+dO4/KCE1/k8FuUx1dfr5hUMlMjq/N02ql0u2pDMvOzgDZx8or1er6ihHos54mo9W09ka8Q8SGzpbZn5GLa5xuCtWM5K3q8QvdOQOjmy3xKCeFA/hbn2r86s3Wkwf2KBAznxZ/Y/lTq+v1/AKT4e9ag/97byy/eat3pMVf3GgYYf1wdeSlu7NvY2eGOfmNm1larh/XTXF4YhnPIXt+FcmOv3nnEMBM1Vv3SkZ42WyJNXSytSHfMvZ4b5TlkzRbriGbH3b6myMeuJV6Y3al4nKLD0Oxedw/aLW3j3wT+etaxMxDN1OwQ6GHoWCMzVQcLdX5ucqFc3Vzyz+8u0co4bNuDeCh4c0AtFtwp2x9wDDbULpEvnJ1+eHR8Kgzao7a7a7/i88X/+qff02GMXiJphpxJsskC0TgT2kpQX8/r6v8NBdwgu8f68LAbJWedBXQz9c8M1Hx5ubwNz8K6h6fs1mf8b/4gr1SdB7vjR7vbXW+1b1hW7ejeNPFf/jCsomq/uu/sfvuXgBmQypCiM15JASxuGVbiGKpNeS0SsMIkVpbnHFuZ9+4OOXCY+tL0p+fDmACSBbVYryPKUEWcQxAExJOhvgngM5owsTNS5r2KlMKCTBCzDffaDJSKZuQVZvdElKavT60xTilVCuVhY5RSjkhZougtRZKEaUtRrMYGXJ24AzLbT4ooIxzH4Cv1E6BnS6oFiveGXJWdfyBmful4N1/StZOBTCTl6MMQA3Xbrh+4UH1cTW4vmrPV6M8484D9J2t6PFuDOAIwnoyulJXU1W9/OnxbtTpOLVa+DE1c/Jb/4dfbnX6rcO9fjAksYWCc2l1+dq1xWKpIfz+3mG/H+g7dx9+80dbD3eP+kFcdq1ysWQoVfJpT+8r0OyjzaOleqHs8aHQQRhjnP1P8t1opzkCUmZHGHUYAxBKqaVqeNarL6x9/pMXLq4tXHnu2twMA7Cz19p6sre339ra21cHmwCWOXtptbT8fONpDZZ5Jp5XY56G+JnafprnGva68OK1PEZ/ayvMCP4L3TkTuZ7R5C7wtS9vTO0eph6nuZeOUPma59NOL3TnTEdus6VmGjS/fcnU9qlnkX9q//gn+10fKxX781fq5hYMrzeXnEqHf3gk9vr+9nDQ9bEjbWIVPM8tOla55DoUJml9pznYOe50+oEJdKSc2ZQi1ZT6Mfqj2LFppeCWHWpR8vza/MtXFk0d77u39h8ftGtFNxgNT8uAmfYycWahCKBqq9la+e27O51+IEEXpfq1v/tZY2m3JqMiM819oogqBllzqfG3ZEw8T94BuOVZ8JIpulLLMr54iMFg99DExD+3Wj+dKHDmKctbr3H68Ej85r1Dz6Lbj9CpqDfO029cX1h64/Xv/+of/uffPjnPnW0RPlJEEzLPdcHj+/3Il7A4TzQQQCk19ANGiO3YWuvY4PspEi219lzH5lSqxGCu0hbTxOd+1jc0jgVllDNmjJKmPdVMK50CdAA0ZfPJd/nUBiJfRM0Ed6FViZDPK/ZdKntCOrZFGaOEaCWENLM7ANBsmWGMKaWiMOIW55ybxBuTC6+UysoAmbCTHJtprloTQox5nxI851oG3HcKxJRJ+bpVdwitlmc+96x38O1fG1SehNk07WXFd6ngz7nyBWQ6OwD9rk1s63BhZP68+UBmsN7pOD/7RTXjOXe2ose7UTGnp2fyy+l20+FATSG7uWLG3Gu1cEqWIf/Xf+dVAANJlDIRDgj8URRFMwvLrsWW5hvcLQAou6ReYu/e3ts6aN7fPrm/1+1FJBYhALN9NkaFR/vNVi9YXyiadsRQSkKIEpIwmi/UTOX+5M/JsrkpZw5nWukgikOhq5yeXym/eGX1tWvnNzaWli5cqy+dQ9RvnwwMo98+bOl+jw33C4IZRp/HtYzbmvJpRuTzUJhdsvbKV+Pt23kINoJP/oVbePHaO3948/He6OJSoWuMmLnTL8rFTClafr6RmS+z8Xh5rT+7ZYPvm0IBqAI/OYmeLLROf7wWtgqvLVcyhSTbZEzUISYXs/zV30ynf2T2jPwF8phuGPphwJqkzCxaLxZdm9qWABDFvNkPD7rRcattMF1Au9z4oUAIsSkllGgZN30pBOoly6Y0iGLXIp++tnp5qS5iUfSs9550723uzTXqAzlMJD5XlljiVHGYLhQKDY+WS26jaLWG8ebxqN33g9GwH0Q9Pw6FshlxGGt3g//dX7j8V3/phowd5haYw6fGbkzYY4btrChqkP1gOwbQ7HZnqlVTR51i94WykyaOWeZ2+icD1dr5aKsN4LnV+mlkz0yKGawjFxxd4/S/+sH+C7OlpbK31/c31opmh3RxqfArb+//f+76jm0TSjihhqsqqZlFaQ4wjd07CMNYSEPMCZQQMspNOTfIDsC2uOdYUiV5vDqH46aViVFIGStNjBgdCxELaeTyMwGdEhMMSZVUxkOZkfQM2TUlLLHWTIC7sehYnEutHSn/knD+qCBujSLXsU1O5FgjIsQMZlLpzE5KSBRFJgnHzNvL9zoRSoUQmdfTPFOe3oJJM9aEFLRetZnBdAPuF5b41T9fyVQRY2U5fdLdwe//o2hlpBkll/9ygxUG9/9QySOmPhvmi6hJhe84eb7XV+03b47ytP3nPlN68+Yow/rTuJzh+2lwz2N6sUSNEH+25r7VkWY3vduOACzX7RevrK4uzLkWU1L95KPNH3+0d2uzdX7e+1//zV94+cbSyzeW2gO5t99q94cn7f5he5jVzXZ934IOYtHyZcNjrsMiX2mtSW5W6hR5P12gN5ObIk2VkD2hANiM1os2gO3D/v2dW7/2rVu1snt1bemXXr90cW3h+sYLNz775RtfsCGi9t5+9+Rw68ne483D3273u61Dfa/VcDBP+MWWMDaYzOqXnaYY9GCvA/yr4vy5p5Ffsx4Mj/bXGnytUen2VA34GbH4bXbwM3LRoHyNJzT/xguzxmh/WiTp9pTp/MyqAgavPwH65q1edanwC1cLQMFINPnFY65afLw3WmtUZp9bP/noQbVC0Ttjg3LmrsX0QBmdfVVyHAPnxkvXm7d6O8OwH0eHAQsdV7KyxbzKgnfRtgHEUdQb+L1RdNjxj7u+WXQpN6GAmsZa8SSDzyYKoH4Q9WNtEzJTpnO14o0L8zcuL1y9vFZ2CYDVC0u37+7+xtu//dd+7hUAIhbd4cR+cxiK/iAA0PKVa0ebg+DHj5tx6Pf82A+E6a8p29x1WHcU/eyNyr/19atmZBLlmEL204Q9MV95MTA72D1sdrtmnV48byl+Tk2q7cYtk5jl49jcTqawz1SrZ8L6ZkvUeBIdM1VKrXH63tbgdx9GwMB0Yt94Ye3x3tbb+/3fuN/5V5uRZ9umDVCmw+QYJ9DjfXAWnGtbVixkLCR0SBkz/DqP7I5tWZwrJUBYLMJMuc6SwUw5FIAGF1JIEWVQLrWWQk5o6Gner+HlGaCbA4P44wcAKKUpNUNTVQLrlHCLp9MzpOcx9LEW4BYgpaScKSENpmsgSR1LW2eTNqe0WQn5SdjGupOTf01dgeamvEZCEFBKCeT0drCQplo9DdYzFcWQ/QtLnJ8DULry5cEHN+nKnAZ8uE9R8m6SrBba6Tgv3dBNP9zdsZ5WFJ0yUGb/qtXCi8v2wpxuBaV7d3tmDViY01a5ZNaVqXIrcW1LSuk4DEAkEMWi5ll/8+dfWp6rFBz7hx9u/ebbD7RUf+5zVxfqxaEfA4jkyGaF1OpuzVYY454U/klPtobxmzd3P9o6fu5cGcAglEEszrBYTco1NlEAQkUAOLnRWSYqNJRJscUmijDLTFgOgjCItWuRuVr5wrn6q9dXXrlx4fKl9UKjXLbjk5MBgGbr4MGDZqc7OGr3u8Mw6jWtqF+S0hhvMtdjHt/P7GyaYr6lpVrtuU/mKqhj7aWVytONpUIVWGvwhRevTanh+T9377bOlIa6PXW6gHn6EeaPT28Fuj318EisSg7AOpecn13F2BwNlHd9BISFjutrp2hx23YMQ7dZYRBEQaTaw2GrNzzuRhlJ5yCUUwBKKBUraplJ3Cyj7UEUD4UqcvrqC5f+2i+9fmHFa8xcNODY6e00T4KZWffmzb3/9L/51kzBDjSLYhWLUEsVJe0XIv0MSKFoHEWU09lqxbbo0Pf7wwgAg3JtayRAVfxP/taVT7/8svHAZMb2Z8B6xtwLXvyHb939yf32StH5+a+vGp4+YYlJaTtzvUyvN3b4w71uR6iZajVP0o3I3ux2a5xmIvsUbQfwn/zu/s1mqDQpW6ThWWwQy5K13Q8DAdOqmg2yQBqemnYP6exAAYSSOIxM3pZjW0aDllJmCVzFYiGrb2UDMTKaZeZxJHqLHHcYUUZhkt1zkoumhBkazmhm0cmquJm3fKqgSxmllIpYUEaNEJTtGCIpl132Z/oMwK96ccePi54rlMryZEjql8/juPHP2LadmXsyEYYzJpXKP0edNlIZQcZ2bKW1I+Wqzabc6/pniSlpPuP0/vf8ow/8l784O7PSy5aB2zdbOBXpZZi7QduNoIIXhpky83OfKd3Zin74fcJrMJD9NE3G4PV8lRv74+svjteDt9+PiyWatS+ZOlx+itNwoHityClzbYogFgEDZ6Tjxz+6d1Cyyb1+/E+//2CmbP+5zz1fLToAXMfuDkOgEMmR2ZhHIjFdNgrMcQqWbb9yceajreO+L4wfWSsdputkHtAzo6RB9rEvXgstAcJNQwUAN3U8aEVDIUMhDcrXXAqgOYqOP9z67k82XfxRueouzFTXz1Vq5cK5RmmmVm7UyvW1hZdvLEVB2B6STq/f6vT2e/3AH310HFX3fdz2qUq+sRnBzzH0M+R70xl02m8DoaqpvWRs5jlV7cwbWk6r4ZkksjMMB5u6xst5ZcngcnaQX11Or0ClJVQrnZOPlCkabzHBBW3d2toZhju96DAkMbeIVfC8RrFheTadSxujIznqD4Jmn7UHJzvHnYwpA6CcUk7M5ZRQ6TnUgo5BErcrUUEkJeiFxfoXN5a/+tlP3Hu4+d//3mF7+M1hoMNopPwAQK3sPD4MBiGEUlIGAMwse4sTAIzZnAqhuERkUVjcAWBb1CWyH0sj/ghJD3vhZ1e9rz537vnVq9lc06mS6Zmwnkf2f/DtvVeXvJ99fXnatiz2M9purDVZO2vQPznpKqPvTckvJ11173F7pvEsZP+Vt/dvHwTctQAEmmwPlCJM9yWhlmthPDnawLrJzzIwZxp4lDKhWtBaS00pZURJrUUsXNfRAOXc4LXrOklfD9FKQ6TfRKO5a62jWJxpdMlrLCpFa5LONc3+a1Yd89uAvhnPkakxmZmdcTae+JELlSxLCqC2WL7GB2/txAagobUpqGLsdJTpsyecMSmEEdm11kZoQm5iKtJh3OYuNCCEiGJhcWb+NdC6z8i1vsoEdwALhwVs/PQqZZ+R2RsKGBP8uOu10T/qYnkl8cDkkfqoK3Zc/UnPAUbDgbq4bJNq6fHuQRBbbocafD8T0McV3bJ79XnX+CnNqRV4QLy8UgL8Mzl+smNo9iOJCIBrMUp5HEsAjw47/9Mvv/BPvv19AH/uc8/P1IpxMEyMj7GI5AiAbYlzDdYfMACDiLVG0bDVA+Ay/dzq3EebR2WPGzYX+comKtI0v6JOPSabqFCbojwzhTitNLQgzDIGfACEEocyY5nXSgfGFkd4BvSx0g/3Wg+2DwEUOC+WPNfBYqO+Nle+uja3fnHpuYsz1F1UQRwFYRTHoT8CcNINWwPR6fXf6/R+8MSvPuqVObGYnn+6Nn26Zrv8fKO618n0jTyPzhPtvBdl6kaytiCjvZoG9KlFpdtTQKe0VJtaMPIifpJ1fGsLwJEWza7f9REWioEC9kF50bFcZ7Fw3raL6QyjYSjiKNo87rcHYbc/6gfTDJ1yajzpmT2Cgph8cwXTKjLuWQsVkSDPry3Uy17R4f+3/+4Pw2hU9TzPc+0SQlVADQAaHj0aHp2EPk+s0gmsm0+ZlGbrPNGvEYd+nGjxrDkKi5z+B280/p0vXl9eLoE7Gfg+DdlN21EWyVvw4h+/dfePfqv/b39m8erFeqazZ5O1ExbPnXwjq5HaDYJfnuesWB5MbvGb3W6m1Zw2ttc4/RcfNn/zo0Blg3YARsGhNSNKJ209SpnhGIxAaJ2YWGkar2i+QsjWAEK4xalSSqoojk3irus4mXYBQEgdBOGZ/U2MkCk5ZWJrP/mPp12MUiKNScboRSoZ3EEoNZg+7Z5IH9vKSBu758aO/hElcRQzj2V7fDNEhBCidOLhMTsOY3jX6WhWlUaGmfKpseRnfD8KE6GJ0vHAWGN1zxtmCu7Ha9e30sF42RVXdHsHw4GK+0ELnnG8GFA2akkbfaAwX+WPB9H1VVt3B52OU5ob10XNZKV4Msow4+DJgrFSAnxjpDk8Di4u21MLyf02PeqKi8t2JsFzI42ldtS4VvLq5cIrFyqtgb91MPjElXqRR+GIMMvhFo+DIbc4UBgEkcH3csmOYh7GfgS4yTx0XJp3907sg254Ya6EKHYdyzhnzkR2Y4Ueb7u0AElfZcINpp9hqqGEMCervoaxAmBiD4x0wygJorgf6GZz74cfigLnMzPeYqO+OFNuFK3Zenl1dcUfhvNztYsV8ZzrREEIoN/rnnRDAF1fDsJEY9npjYbHIwDYV7rfkbEGUKXKLjDD9wFcbAnjf5iKO++01Glp5UxRpVqhJx+px/HIyOKntZqsX3SmdQKgCzQH8rg7jEayq+hQagC6UEydSzXTIFpasMvAomdZFFqFAo7R1gZBtNXqxpq2B+HOcScIpdHQM4bucDiJu0xLUC2VTGfam8GjyAF9/s9BKF68vLxYtX1/+P1bJ45daFSKObDwZawADKlrPHlCOVMgfubJpghC6TqMUNIZhF9ctv/6zyx99oVZt1xKGpF4ibkF8zHOKPaUwj7yrQzZ3/3o8TfvHH7j5xaeW61PVVATQOzJ0nIMkSS2q9aOsavLYf+9rUHFdfNR7BmyN1vq8jx/GrI/PBK/+qN+yJiltEzbJjkjUic1QEYhdZKxBYBRy0wSz6QVMgmRJkLLKBEAjP5uUaIMTVZKaR3H4nSVdWx0SYuipw3yz3DNT/1XKZ31OzFAQTPGjA6T4WyS0Ygk52Cq9lZzyZJlb/ZDrQShPI2SB5IhTYoQPpaVCFFSjseoas0oNfnAZFIEVkrln6xOUf501vGTt7pOxzMTF2a/erZ8/skN+ckNa0qXv3qhsLszMNJK3A/uw224ppoaZOTdiPXFEj1fX/7dDx4vrwgAuzvWSzf0whyb8RzAP+yT08rMfJUD2lwgz+WnkN2sAY11ZkrIjwcRAM7StZ1SbjP13PnZetm7v3fyW29/JyLk7/zrX15fn9nfHZ60ult7+4E/EsKO5ChMwi0LAHoDP9YUALOo+d4CuL62+IM7W/2ybVFS5ETFNJoMeHOoNlzeoTqVZaC1jkBtMgnxT/ts5cb9EEZdJZXrUCFHIg4kguR8yyNwXUcBzabfbPq376cfcZu7tlUtF+bL1kyjulC2NjaulQsz8wUUubBdB0CU65kxTL8f6lBwiFHXl1EU62C0L4kU0X5H92I/Csko7XEgo2SvU0Z2I7vEfTTxFCYFhG7614edPoB+ruXdJzxQ8LUDyOLxuPjsOPNWzS46fJ4T17EBlBwJYBAyLUMAvQAiFoftYRCpk06/6/udfiwjMRIiiHUezS3ASblzDMQgSigjuQCIcUbHtoH1PLIHoZwpOL/8lee7o+iff+8mWBHQMlbMGq9V+c+JkELKSCrKqDIIHqlpTM864AhDz49tof5nbzT+2hurpeWFkW8BKRMvIzXJWHLY7vctM0njDJop9n/81sl377e/cX1hcXWFNurIlU+Ngd14Ik2ibzDopxujrqlFm0iG00XULmAEmbzlEWlCRkeof/gHx/ciBQLFNNFJiUImBhaTzjge6KyUAHjWFCKVyvTlBOVT0qq1NtcxKBYrrdKPbiaj50GZ5V5ko7GcCeLPQPb8f43czghhyQRtbVIExl2ok5hLckuUc82LV+f8Xnf+LXItUJuAEJo7IFOT+QjPxBytFCUEjI17a9PXwbhispqqVApa1zxrGAppZn0kgbXkzCD7h5sJd/7yDZefO+spn1VuPTlo5hE57gcZTGdSyQcf0lqdfeNfa+Rl9FotPOrS66uFvLXm9CkLmck3RmWdLmeq/Em2DGVGYtNKCcrYuw/24lhCa8dhMlL/l1//weeuLbx4dXljY2ljY0kF8f5xsHNw/GivfXhy0hv4SgwH0RnzGxer9sp8ebc9ev5cLYhiI87kpfZI02lZRqVPTwsQHillEwWMZZlnnFw13hsXOM99USmETKc+JZg+0d/Y7B42gScnAP7Jt+8auK+XnJmyUysXqkUnCCPXsUsFp14uep4LAof74PblqnlIiVOiH+owSOjnMGIAhIwARJGhycpAbShIKLRIhU4+O34wDidTHRTmT4uCWba5em4xc/LnKEUGkR76Q+M6bw+Hw0B3+6MgimOlTfF5Esenj2Mgtb6Md5/gBNCEUSaVwhlvgToF94HQn796vjuKbj88DEK4BYTRCHahaAGARRS4HYmIWTQSUaCZ0kQrSbQAuGNRUMdRoVm5Dcqb31rEQtFhGL2+7P4HX1x4/cUNQ8On4Ns42eWwDV4CQtN9ehrZb986efud6Pp6daZaNQNaJ55Ua0flyPvhXndKMTdqTEbM0wyZ8iB1Q2bIPnX6lbf3vz8KbNtWSgihOdfZ12FsH5woeLKk7Akgpb3ZBVRK243ThYBQRhNhJH2zDI7nK6JE6WdD9sRr9XS5JqPDxuOYeRO1lsaymGExAJ1LMlA5Kw4DCjNzI+IFnhMsNlcPVIWrgVa2RvYcE9MnpXEcIxnZCkqIlFIAFkvkAkPe8whjaHvRZlVOh2GSLZy0ZTGGU5OYuiv29RkbwJ37w49OWjfONXR3cL9NG66fdauePn3re0enRfPT6vlRPzp3DSt0xaQO5MueBqOPuvLMG7HKbtP3p9qazJ9n4nveQ8mV1JQRA/FCw+aMEg2AM64s+c5Hu2/d3qLkh9WiszhbvbhYv75SubIy+5lXrpdd0u4MO91Ba+BvHXabrW5vFAWSZOLMCxeXfv9HD447/blaGVHscGZqoRFovmSUobxpHc7w3abcWG5/KrID8DXBqWwnZnNEwqD5mf4mmf7XTYeNjeEekJGYujXXtlwHABy74DLNLFq0OIBKybMtoUnBoeAWdzixKCjVJNdTSpjDLW495ZEkSxQNB6Hx+UaxSlo6k4aSKAoiFUVhnL5cvh8EkoTRKAiRgHgoI6WUkHE22SsHvoaVGz4e5t3SnJjLO3yCm5vaRrZDoiAMylzSlE+n1BgLeijUYs1dmys83D6+/eQIwO5JG4BNo/XFajsID5vdvi8ipUKhLGgXJI5lnyQO5UBoSgMLwo/1KBRaa0aIy0nVo0tFDuDKpeJ/+Or88vMNt+xAxHlkp2IfYjYeZO71J4XybNDHFL4bZP/u/fYnXq1fqlbnL66elmLypVGkgQGGgE+NxMsc8YqfMwmRoqXQGKfadYTKjjOpHUpTykFiJaVBGcM8M6NBHhYZhRTagL/WUkkNEwmQqjHJ1akZapomq2idjyIYe23Un3yq3BSmM0JYOgkvK2ka64rWKpuSkVdjdFrn1KmIBK1lvwWn4trl7otztfex2hO3RpFSgnE7ccsQEA2lFOPcOGFSpSEdBaUUgSKEKq2TbixCoLWQkmhd5QyAR2lPSEDaFtdKiaSOPNbi5l8qXv+qC2CFVle+3s14esNvHh6TGW9wvr5sYglWaNUcPKMEOi7FrZQarn/UpYyQjXVqePfGOnv7/eSje/X5yoynmn74NGM7MGjkLDHP6F895djhPBbSAuM86XnjBGA8EqYbTRcc7pUsoahW8slB86Ot42++rSlB0eELdW9lrnZtbXbj4twXX173HLs3GD7ePbn5YM+2HQAzNv3ap9Z//0cPyoUYQMlhWsZGismLYnnne1LBB7WJypSZZzD3qX9RIaewW3FmajtWerEMxwHYXPbE+Jz5ou45lsHKKY4/hv6EnXdPo//pq+TvKznnqe8L8qkp5gGY2/c1MbUEAEGs87A7vWecTGczl4lBDBaPX6Uccz+9BpypeiWvJygFFHRWPp26ZSFweakBYK8rzJO9VK51+6PmKOr6/s5J0Aviss1DofrD6CuKM4qyy7ci866FS5oZN8KFGt+YtajnLFm6Ztsli1RctxcEL62WFpaqbnl2yv3SbrXjbjxbPQQOS8sLBQ+DXRngxC3PDnYPUUY21PSPbp385H77E1fql6rVxfOWUWOy8mk+9ssQ89Oq+vhFq5Z5JRjXYNNSahZZmu9Xem9r8A/fGwhOqY4BrpSYMG7rCWTPm8qkSrZHylj+2Lg3Z+obZI6pycAFlBbqTw3l+RswMbqMsmzikrlrpZSSKqmapsmLmZSUTx+bbE9NJrLWPgiri0H3xXJmSbzDqFRgWmfInrhfkjtVCecjLBIh55xSGkUKUJyn/n2tY6WkkGWXl6UG0Aaev1j0Fv1bP9QgZGbFAoBm8vR2CoT3o5muINXSFHDPLs7MLqZ2yVOwbgSZPCjnIX5hzgxZxcY6m6+S2cVGdnUjm2yssxlPZRc2osrujiU6mL0QAhAd7MLaWFenkd0c5/88DfScWxxaCwFAR5DcYpwAnAGgjERCUkLN2GKX86yeLDQ2j0cP9vt/8MEWgEbZWaq6CzPVesl59frqw+3jIFIArq9U9g9rHzxpPrdUAeC6TuTH+bLqVIk1lzXKoQW0AKxnMPfsX2bQtuLM4Ht2YH5PSTEGc20VGPy1VUA9FwCxClULy9UY4P1h3BOk04+f8dE/jf6nF4NT55yxJOT3HxmOZ6dQkWyXTRg5E9afAc1WisL4U58UtAWTD5D8NiuHWUJCoV1O6iUnjqLRaATgL37pxd3j3m+99ZFNEYQIhay4FoBIyOdca3XEdyHWAqylBGp5xAFsV9j/ZKN8calgwoSz08WlAiuWaWMFucxV02Iad2MAh3tdViwDh7zCaGNFtHZG3MouI3rye+837zS7n79Sx6kZGkZnPx3JawZYT6V9GWSv55R6o96YNqgzi6j/+bdPjpWmYCBEQyuhCaVaaakUozTv4gBAiYTmGpozIoU2YD/1HZgeTJGqz3TsRTF10j/G+5sXYQxDN79NaZRRaqZeiDSUZlyc5CDpcLvxVxtIsicBrbXNSRArBbB0OJ/MlPfOoDRQQ6nR8VdhlYjyjVedUqKUzlrnAZL4Z0xZOJ5dsmhft0fywrW4WKK3f6Qzn3sUiwpnVU4hdZ+RpfPun/0aIdX54eCgWKJf3LAA/M4/0zvpZ6kZkHgruvF0K+SO6q7Qanawo7q3b7Ye78ZTTaFPo/DXV+38YrCxzk7j8sKcPupidCILs8wEgfGcJ24KvvNXbwUe4GUl1sNjYow6nFHzpiY0YRTLgsUo0WqiLA+lCcyZqVXW5cR1HADmwjudcKe5L6BDxa6vVB7utdvDaL/dv3Cuvtn097rBpbnyaecMnvaR1eKn41fqlcxkmQzWqZDM5rHS5uA05rq2FdHpgvhhx3cdAN6sG9fmS6FiW9FxIPXpS57G7ngqSSP3AKbt1SJ5zGZBMgcjcykd52vLKUbrPFU/HbE5sToymlSTGEUayflx1oPTF5s6h0EBVIIwqIzIZ4/Ngg6BhbpnEdUb+KEk1XJh97h36+G+a1uDfgBEfiBsT/VjXCD0syO+S894i7cQb9xgJq3MsHVjRU0KOect14vzeA2TLFgtx93+wyNxeb5/OMQCqrSRZPDyChOtHQX8+nd3OlFkkH2mWp2yx1CxbxIIMhyfAvQpCm+U+qz0etJVD49ExXXzkwYeHgkATaj/1e/uPIgV51BaQ0khtSk8GmLLkunPJrZQE81BLYPsACQ0Sat/lGhCmBQidS2N7R8ZnmbNq4SCMksKkUkxedPImU6YieZSQiijnFLjLKTJVDua+S+zoF1KCFKqnm8d0mlV0+Y0FqLqsCrRQ5BOIDilBCD5SIMHtPpqVde6tc6gbvFeP2RMWlnvktZK68R1oxThXGv5xhfp9VXrfpu+83Z49flKw/V3d+jgWHkW7Q5iixLPYwE0GAGwtMgBqbuDn/tMKZNcPv1nmgAefNdZv16ZvfHTvyPb7d1MnDE4PoXsmI4N4DOrYyA+M7F9qhw6HCibn1HCzJD9TIhvuP7hMbm5IzNzzu7tsFaLmFJaKSilQSjRWmo4nBIQBWitolhJiVhoBU0ppUSb3iJNaOK0pVRLBa05o47NKq59Z+solvQLG8s7J12zj1soWx/udBhBtehQrZSGVBpnBYcZh5TWWoGypFZEp5YBLWNCU6WSTnxFba2I0szmlFEZCU1pknUyKZUUSMy0kIRn/J1YHACNAy1EBLQDFfoRJapYtCkhw5gYKOds4tY4Y9mPVqro2FqpcYC18ZyR6a+QRalFIEAsAnMg0vnC0Mq8YgySE3ACzogyT5aSrKvrqQB9er3MYl1/+lKpT++KknvMGCW0BqHpJkACFrTLIQmNNWKlbEqrRVtAK6UPm92eL5o9P4him9NWL+CUCIXIl5+IaUVTM0s+f6poOqD65edqR934KIge9foes2eLSZl5qcxiu0777ag/1H5PheMHHMJWYdTsBGbi67AfFnmE4jIA2ekGg/4/+8FxHtkBlNKRxKIntd/L5p0CqHgiDPWD3dFmcxQVed09Y2n3dJ9ZQ9npqlAf7nUf7I56QVCctzOADJQ2Y1H/Tz88vN2XFuMKmhAqlaZmEGguRNcAKyEA4WbatNYSoFKqPEPXIATmO2IuT7LtbwasJsh3rNIQAmK+2eNOzuT9PetzQRmllDGLmVMmqVPKAEXMU5CKMVCjcY819yRul+S6SSkxkrgCEMSYLfF/b2WOD8VeFIEyqZRHyBu25QZElGyy7GI3RBBtQR7FkkBTxkwBOZLSpqxia1CqoJVUUuPiJUJt4XGxfkGbIdGNRbe5pRkl3hwrEt71pY5VROBS4oVYuUJItZTNOCWu7Un1ZF+tXhOzlzzdHSCMsgGnK7RaIW7209OhuYo5ML+fbA2HA3V8ZPd7rFJR81VuZqVaZVdFojZXmKvGZg5qYrMJI1/IrBBq5qbmwfrxvowjHZ2ajrd+4alfYT/ljqUiIJm504UG9YWII804JUpD66QqQkAsixAQJSVl3LaYkEoBUuk4lrE0sRKKUgpKOaMgaSMaJQADITKW5+dKMxXvpDsEIJV0HadWIHd3erWC5doWJVqKWOY2mgmsU5IHqRTclUHwDNPPgHulKWfQ2kxtSkJH07LPdMVMKoeOybjlci2EFiJUnJnmKSFCxeMwHEhKpOz0w2GsOWNCKvMzBfEZhRdSubYlJvmvAfrTPzYfH5gfQgnn3AYRhJgmIcIYQBOgp5xTyolSk0+fnPILJ3w/hXWSzknIDj7OKR8HRChxOYSCBM1ou5HaGcAZEUIrEKk0Z5QSQpkVRiOA7XWGVCvXttqDaBhKTklrGP+MZOe1ZaDc4LvxWJvpB32iZpf5py9V1mY8HtN3jwahEnMFF0CjSEW/Hyi74JJ8zXMUauY6KoxAI9/X7aGiDgBn2OmS/l7zJPj1909cxj59qdJsqYJHCq4LYNBTGPZbHTYK9SiceFluPRr+k1uHoRIrlVI9vfz09ivU3f3ubtu/93i02Rw5nDuc173xA2u2VCjEP7zT/sFuYHGukY25oCpNSDe9pkYhp5SlLkHD2amQUo/buRmy2AFCp+yFeSMKeVo1a2yseQqmM+rYNmPMrAT5GlhqRqRGAJdaE0IpIYxIpbN1JanGTz6q5IeAgJDBMPr8XOWrnyqfa1nvhaNIY97jnxoxb6MRjKT0/Bnmnh9Ee5Q9CCMCWIwFQsRSXrPZv7++8FxsPYiDQawqi+wzrxGr7BpMz04rZbbVG/ma/ewXVamB3W0dCMU1Xl2x1mvMXobB7vOFub6jATQ7/eGIDEfk+MifqzJSLRlM7+mwQibe9Azf82r7UUvHkXZd6brStolBdgAqEgCYw1fKbMJAGUZP9lWpOEZkf2pbL9mTbX6qJBtfX/bMpOxnf2dLRfTaMpmXLVmnL1nB4xanhkpAa0apxSkxZiYphVY2JZbFbc4si1OiCIEQMDAXCaWhKeOgVIMEsbCgrq1Wl2qFk34oU3uiVLJaLIHxj3bbtQIHwDWUllITA0MTUJKNY9eEjzN/xiT9NJZl+9Y8uCfBRvoMfCfcyWE9DKZLkoA7gAzlg0hqoantJAHltmWQPc/i8+KMWQM+vsoZK50Zk7MKgQCBTssJGiAUhCZdH5RxSpmWUpOfSsMTNB8bkPQz8H3qX+betVSUUYfqUJnkvQlkN+AuCYXWDPAj7dmMEGilzOewYDEh1X5r2B/EhJHmML7u2S/E1i4VFU0Nvlc07UJRQsw5faK2W+Tcmle3ab1sbSyVbh/2qKYXzjmB0i4lOo4CZRtEzkA5bjXbfgDA97X5XbOFjqM72/HvPDy8XCk8d75oFPxCDqwjbWfCOrWd2Srtt3rfudvsR+Ir1+qfXCjOzVdPI7sc9tt+4Ifh7on0fZ20lTVowZt4Rw7b/m/c73xrM7RtS+e2qDrXfJS5PgyNJlAG3yUhRq6hqTxtqom5j3uSA5B8WXJVyinE16nl3JQawSjVmpD0YVDCKGWcGWXcFEWVnsbo3NZh/F0DIUoTPe6uUjQvFk3ObzAPTBDy1lH3Oiv9/AuluKLf3Qtet9yZenH2kt4piqV+AcDu8dAZqtuWjqWKhDhftP5GbebVldp3NttvRsPDQEopP329uHGVAtOp6gWLCw3miIUGjZh31FL9rnAofXHBmi0RtZCAuyHj3U5zd2Azhxss7ihrpmb1dNjtNBFGVa+SSe0G6/MUXncH79yNANg2WZmz6hWWIftY44rEcVeaNcNcpemHEfOmFqQpdH7whJg6qgoQDOTcUvzKdV6w+P02/eCWf+uu9eAJ8YVYaNC8mFNKewTNWjUcEZNFw+rlMqfUouCc2ZQwy4KUFoUEYqWUJixVNhhjjMDmdsEmnFHOiYYWApzoYRCHkfzEav0XP3NlZbYaxYFWIJTn8b1e5H4g9rp+rWBTRiljkVBa6VBoRpCn7dl3IQV3NSW/PO1ktA4DSYwQpccmGWM+Mbifp95GljFE3uA79VxHS2MKp54LJYexzli/+TElWQPxeTT/YyE70nS9KadaAu6EZGCQQK3S0IBG9NP4d6KlnMbxZzD3vGqfOYt4sn8SYuLWGGBs75xRLVUMwgAJPQqUVJoxOJwFUbzfGh4PI0KpY5HmMF4rO1d9GLbeJ8qg+S4VWsNweaPCq0D83uP+wXB093C03RmWLfs724MyoQs12zWvQxxlPwZng/QVLHjEAO6P9vr3TvxjP3xpvrE0byew7hEAjoyp7UyVTAF85/29H+31L9VKL573iuVK/jJ5WA+U7gJueoP1smVutsapS4l5JM2W+u8+PPnOk5BY1ukYVJJvvUnDx9M3WxNCKQi0pKBGKCUgWmsohTHgglJGUss4zcky2TqulJxI+0gQXVPGCKWABmMWS1YQpOXQPEBPxXFnC8l4sl2m8qf13kx5l1JmD4mM/TY0UnqvN4xPyOevlTe7wfkVft4rxkNWS3tlgpbvcvKeEkLjF69V/uNXF5fP2//sveZv9/pDnYwQGXR1UwVWoTgFlL6QRp2ImNdw/QdPyLAnFSGtEdnaF4NjvrAUGWmlp8Nmp99rS5W6G1Qkbt/vP9kajkL98oXVDNmNRAPgDx/tP24PGiQkrk1ce9QNh6ECMAXrVtk1C4ZVdq89V8l0HqPJmAd8eEyGIzIF9DOeszuwd3dkrRbeuMGWV7F6gTx/mQJ45250944OgoTU93usXEQG6I/35VFLG7h/vC/vPWRBHKVckyoKBUosICR0EMScEQideN04NweUaCgT+SLBQChzOWGUt4JREOuLi5UvXF9ZWygftoe9gX+qto+ixWca1Xqx+JvvPNppjlZmChYlFc/q9KVhglQah85EE0dmgbdlbIqQH9fwnhLhmLPMB3mmZyZfLDVAH4SA48BPeEFEXWPPyAA9O8j/eaY35tmc/VRzjTTVYI9o3xSpTXlDpcJX2gGQNicSbToaGX2arqL/mItN/uRQnXiWnm6+NMhu3sEipyH0IBCBEDYPhS+URYqcAvqwH1U4e2E48ZTNIMrTfg5GyVqA49tZIEEA4LePBp0o+oVrE70krFheY8NsUuCHg2HHV/1BUPVwvlhaKnszjTNemY5QtUnry73H7R8cHJct+/NX6qfze093JFVP+WHyub41Tr95cPidJ6HgfFzuNLm1SEg40jZ645NJxWtqpsEl7anQFEQjTWQytFopSqnR55XUmozJkM5wnRCpZWabSaiSBqHJOCUAjHOtSbYhMLt2pA/MKOUZ0OfXJ2raPpHcUAbfOu89zyoBab9okv0CUIJbo+g8H9UfOJ8XpQOEV9b5/QcCwEnVn+16bkACV//sjcpLqvyVi+4fPAi+s9n+/mjkWlxpgIBS2gvk4H06ZQDPw6vJeGGD2KKEUdoUsvGisqpo+no2bTGd8ZxWmU7FuWSz7qa8j7/7wWPDhe8BwODnPlO6vmo/fis6XVAFkpEdDdc3Dfx5+DYT9ZL7QtCCl14STT+M+2R5RWysWzOendVOD4/J7o5lLDTZTb13m9RqkQkHNjEyZkD2cKCyaR6djsMdi4YxYqE5VYzyAk+i/gwR9cO44PDELQNT4gNlnAK9URBGaqFR/NonV59bnZFxNDiLUtrcnik7AN5/1Hy4ewSgH4i9brBUdS1KPNeOg9h8lCMJC3rKB5LuoKn9zD5VnUN/x6JhrDyiDVYqzozhPWPxGQrbKphywpg/gxBJ8KEfBGJCfnFtK7u6Of5jYXqurErip/jUfE0yNM/DeiqVpKxfSMLomcg+rmSkoPzxPTMGLEwmROZZcqgOJhW/KW+lEio2cTScSFAhJPe4uUzLlxXOPivo1ERiM8Im1fAxZZ5hU+/1IPzVH4X3m8GXVquZeWavv7cZiKP26L3H8XnufOZFe821S+Wy0UkMgwZwGuJNGACAh0fiTrO704tee272UolNIfvpNEdzm7xBM4jPI7u52fe2Bv/vW2HIGEsd2QbfkYreJInWUsjFFuoEtSkBTDWVEKKUyMZ+GqBECuXS5P3mPDM0HVdk7oLQ6Sl0CSGQEkkr6TQrNyiskgIYzYxwGfc3j0GZrVtW1JkcnGl+Z7b3vERj3NVMEABX1vneQoxbDi4kT6E/CNgxxWKx9rL7Z5fqevfo19/p/v1uK9SUcK6VggalREm9ei1+/UUr34J02uLdCtAPYo9SyslrP0Our7rIhQcY40rDHce5ZBbGe09GK5eqAN7fezTjOefry9vt3WxekgHNN2+OvvTGfLE02t2xhoMwn8A+tVpMnVqBNxz0kIw8jecRZNNWzcM2UQRTz+Vnv6h/5002he+djtPpYHcHtVoC69n54y/R+kKl7HJGNUBAiNaglNqcWpyHsSCEWCzp+SIElHJCrcAP+r64vlz7c28898Ubi42y0w8EIYRTQkBCgUBoBWIRZTOqQD7cPPnurd29ds98EqoFq9MPg0hWCpYZeR5lkf8gUoMR5D8oqX8mmagydiwQLTIDeE63UYR4UJnV3XhmpsT3CpeScJmLrzFAb6vAnGlk94i6p4WXrGpqjv+4Ontek7FoYqUxDzUvy4zZFkkkeC1jgGYLaH6pm96Vm4Jq6nh5hmfGSO2JFKM1ocShmie2jaS/IXniChO6jdYxiBFnTASNUW+kgkXBzQgeoBsoF/i8YvRU5cPoM9seqcQY0J+iNC0rfj6m+8fx7+75bz7s/bjtv7U3vHUSNlnFq1a9qne72Zsv4sWFqsN5LwhUzIxEYwSZKaLtUvLwSHx/q/3eYf+NF2Z//vXnLX9wGtk7QmWCT7OlDtv+TivSWloxox4JARcIlHZkrOMIgEvJdx/2//dvtU5Co29MTZVTBGRqbwpAilyfaoKwSZCfJmMLvJ4ah5AWVZEGaZlSJ7Q2Hx6jtJPcKpJsCDIXI8a5iaebTlJtPf1caUIpGSd/nVX9opNfz7xtBuMbIpbF7wxHN1vRpxecpWUaCkGWC9GJqGvvhyf955dK5WXXOmkf7vDfODgJOXEYIkXGH3hCX/okKxWf+lExWofHRTcSx8fk819mxmNutJFEJwkjo9FTWzzel8NQZeisIvHwsPPwsHPrfnx/J+qx+OaDoW2TDD1dVx4f2RvnZWw7uzvSdWUc6VjrokuPumIYKvNz1NJlOyik4x6NS+fmg+HxkR0EfHQi3ZKsVxhzeCbOTPkj8xXUchHNIRUdGC5aq4WmkOu6E5wrj+y1WsgunStyjqLLbMYjpZCETxCipYLJizBMinNmDYJwOAqun6//rV946euvPle0okGglQZPgabosFEkquXC6lxpEMi72613Hx/vdwPLohZlBEQKxRkpFdxWPwxjWXYYs5lUOr89lxpUqbwKnwQnac0pNZhuTOJ5fM/LxwJEKs0sxjlLMD2WiYsmEpRRU1PNoNwI7ua3rYIM2c0x4c7ThHUjwf8JkD2e7AvXlBKlFWeBhJYxiBlAqoDEeWi27dBC6AmL0ZluyAzTCf1pTU8pfzMQ74xBVo2RnXAT3p7J8eY2M2R3OGFGlwcoHy+z/VhbSn9esWXFTxsfjU+mZ5FKDEp+SsKE0eirYDqWPYt8dcjW7FLtE8urc+Vywb3acOdm+PZt/yfD/qUqNwZ5Wrbqqc6e18Q/3Bn+aK9/7IcrRef6XPVimdU3LrU2D/wwNDBtpPxA6RqngdKP90a3DgbHfrg78qu2bTPicE49IlrK97Xx57SH6vbB8J/eOfmvftwdgNIcpI6FcpAMWPPjkAx5IWmoQOqcSTQQpfPl2BxW5mubSfhjMpUiv9JPHWRsKS+z6Nyjyt9+ou4ncJ9kEefrtHnj4+k+c+QyzrIPsNZKRBGj9HAQbYyKn36lpGJWujAX1AoXiuG556rRibCY3963Xn/VvjZjfXW10N6WD8OYMZruANAekcZiYpVpBd7UwXhzyXgnYMwR5YryhTTWQ4QRwihfgx2Feko3P+qKo2ZyU82T0GQzxzlZorVDvLp6fpFun/idjhMEvFJRRZcOQ2XMkYyK4yP7pBNdmUtWFBNT0+9FjIqZWX3tOVavsIU5PYXsxqxpfjyp8k5HXwgTWgUgCPgUrBdL1LYJo8JI80acSaAtCNEPIj+IstVCAC6HkCCUAxiGURiKb7z+3OdfOHeuUWl3O/cePiTW9ALKLPvaWnEUxt//yZO37h8NAmlzuBYDIDSyBiibYqFRPO6Mtvvh+bIzU7RPBmEkxy9fpsJPbfq0jP1UfvGIfloDjhFqQliwaCa453ua8n1Mtgp6gpUhMneOgXUjwWcKzJ9AWP9jyTKKszBWWsaJ0j0Ziml0p1BQLeVUH9NUFfpjNi7lRXnXIjkrBzKpPTsOlVELJm45UWY4AWBSyfLpNC1feoBB9rEI86c77VKx45K1ALDROejTrhxgseTaJ4PBp37Y/hTIbxyx/zrorle7V2Zc7KG6VMhCGbMx32XLvj5T5Q0qWqoXBJuiwD54NFOtNrvdfGBAJtoAuD5TNdpOFxDpPPGHUHt9vxNFO73o5omq9ShAIwNzebxLVXeVSuAJ0c587mlxMn0HaeZrNFoNIUSp5BqZyJN8HRQU0SRRPBJXuNFnMFFK1ThzXjFAKRVxnBpzSF7kGasxhGRWzikZZ+oGp/Bd5mz4AJQSYRQDsCjWyg46g2arCGBhZQ3YRBe61Qes4aEF4PHe6HCH31HNd3XMONdQqZNHH23H/+pAVhbZ6EQCo8Isq9XCYknuYmJchlV2a7XecJDo0fNVPrMKUi1lU1IN4E5pIDOegy0cYfxZzY+/SNmxfLwb3dhoXFyOvv9AFmbZxjoD9FE34c5m2Gmn49zZSgLczYwkc1MbSTDvGe2mU0nxeT1nvhrs7iAD7tPNU6apqliKs08R3zkJIoUgik0uPgCa48K2zTvDcBTEL1xc+Dt/7pWLawv3H20bWM8jeyh0ySblUnEUxn/4/sMf3Nk/GcSOwwucgLEExKQEY0KKXmDmMqJcsLqD6LEI1+ZYtWB3+kE+qCRV4RXlLPuqRJrYBv7YpK37DPCyAARBGDLLI5rZ3KIENs/CwjKYDsAA9MHNG5rhuBYaQGx7/0MB+ml8n1SVpVY6wXTCxw6Z9OlopacG0p7eHZsLZCic72vNjieg/KeGsmkRxJow8rRF1CSRYSIumHQHkcVZ3WWbUstRfIaG/idCdqnGffg1l+A9v/P8Ji5csT4YbPfUOWJ94YXy0ZJ1/+H+bz8K+q3+hSVedwiAk23aqah/d6P6jesLmcxiel9beyMjxzzeG5mh6hms12zbwHo3J9/X5nlHqH/xYfOt9xMCeL4nP79YvgIfwB2XbY9i17KkAsiYlCBHhJPNpdY80b5zSVjp01NSUkaEyrJZEpTNNltKKZV0tJpuPooMiDM1Pe8/PxOFtZaTU/dSfZ88zTCT13CmthT5G88GtGot4yhWOkkernC2arPz3NkWoRsQAPXrl+KTkwe/twug8MoKDg8BtI9DwPnOZvv3/ZARBohx3Vhri9FIqeaOlFo3yk42WdSIGTm49DN0NgMxkJt/fXLQzFJ2jeCepW6ZGID8dc2acfOBNOhcmGWdDtPdwfVV+73Z+NXXHRP+lZdEzO+FOQvAna3o8W7U6TiiYxIFnkq88sh+Oi4mz9Ozx2YOpqanJm6Zk0EAYhldheYkbIuTUSg6ncELFxf+xp/deOPlC/vHwa33b+0NiZPCuuFrFRcLjfIwUt+7tf3Du3t7Hd+yWNnE0DCWL8sEoZBKMc4VtMFQt2F1huGD/f5Ko1Aru81+NJUiG4NYQpqhP+bdDTVxqPB10sFv+LuRaPxT7u9xOEEozSUVZ1lU5JmnxAaTrR7/4yD71GkQyoSzI0k8Hv+ZVlZDKZ+irEx7ZjJqn2HxJEPHGQw9+3PyzIyzT91pKLTDyVTmuzm/40fn6t711TmTWLkTxf1REMTa92XdS4Kc8lGrHx/3zVA0sxVIvkV3VbzQNW/Vvo49wHbYlcvnrgCt/tAfhucObXQG16/U3xadb211Ta01n1pTcd1mS728bndReG9rMIh1xu6zquxMgyI9/m6z/c6erzzvja9dqjDf/Z0DVDhGvugzXpbXib0pQ1hJ9TQHjkkJM2sysiYVajoZr8gYybwneZs5cmEDLN0BjOU1pUwSAGByYEg+tTH708Saj6+Yl1YASqmCymT9PJRPpenmziRay2w4KgARxyBEE2LSrV2LF7X+XKFwvidrs+XOQV9Dn6/Q+w/EFTzqzySm8kE/6h6HN0cjALbw7+jIYpbSUio9VTxlhEiKq9f11eedhqtOTxowyJhVQfPs2ABoPj99d8ear2rjZjFXXF4p5cfamd3AxjoD2OGxNkh9Zyu6sdF49fVRNnrJAHomfF9ctmcXG/eejN67TWo11GphB06tFgLW1AM4RGQ2DfldRT7RN+4H790mZs3IAB1p2sHjQZQB/QS4c8YBTdNKvtCgjCkpj7vBxaW5/82/+cYXPnuld9x+9/aekFFolYBh/uu90ChJTd75cO/tuzvbLR9A0WYm8YuDGLauNDGwblmMWw6jUForKVyLA1ioee1BtNkcLtbcmfI0fwcQakqFyhtpQkUcTPD3M5H9TJekJyRygY7PQPkKlz3B/seGdRmJxB6Tjp3SEoQSnUGYFvkozSm3YqgIIQTpK3Mmyk8j+xSm50h63iGTIvsZO6QYhHISn3LOhEL3A3FhrmSyIaueV/UAeEAFQNf3TeJm3xcfMtEVSsUKEeCylZFmNGlSfZp6k9H2Wq5D1Q0IPhjU55x2Z2CYYBQmS2CjXES5WFdx7TDqAK9ev/jBg61/+AfH5y/hhdlSKbfODWL9g+8df3gsAXz9QvUb1xcyMQcpqd8Zhu/s+c2AFGZmPvXS5aWiLh/uHu7wzOvAy/JkrbY6T9gfDswgUJXmveikhpFEWmeTSymjVtriD0BLM0wLmSFlSipJl/lxpXZq2jWygC0yraLk02CQpp9nEWDTXCFXOE1HayRLhUkIzwfaaK0pJVImlV0tZZA+uxKwulJdm680wpZ3W9cKBWMO3K6wHSHuRxLH4X0AD1rt47A+59B77Zuj0bYIAWATAQOI8YOazi2lTHsjwLT+5KvYWLdODxGdqMOvlO7d7eXdLHkFxsDrUVcAlolNz/57pa7iPs+m1k1dEbCPSrFxthhkN0PyDOBmsokp5N672zOGlgzxD4/PeKiHxwRzYZZCM0XbrbK7vDIYDnAawY+6otNxllfO4KDj50xBLE5GvhgNgrlq8T/7d7/053/us/2Tww9vPgJQLBSGIwwGTQBDPy561vKMxxj/ycPDN3+ytd3yKdE25wCEFDDInqj5E7AuZSyVBS18WFJrThVRqHncYsXj7igIZa3kIIim8D2JIBfS4cTY9UIFQBLKMz7uCfk0fM+ze+RSxgBkjD4P9P//gfUJZM8ZYMxuwzjck3GyZ22EDfhqqZDLCMtDcKbPTFRKp+j52Mlu5QMp87CeXy20VKHQdDzsFA4nLkgA7ftyKNX6ufLKXG0aL+JRTxA7Cm2C+bqNOgfQE8RUevpB+B4DgFuQeV5vGP2UWL8y0nDRCbRB+cDV9TnnyXLlAuDfbLXvN63jUvzJEgA67LEH1D8Y1og1u9k5ulp/SZXbUbPzvv7tyqBTGZN3z6EL5+YLxdad+8PfQ/eH+73sX+1QNwPSb8Xz55zzaxc+uzozXy+HUSg/uiPfGU7NAdHnSUHyesk56Qe8wJFzLo7NKlJaFru0vKREvNcahFEUC2lxRtNxoCDQiighiGkaT10ouXYkTXKS/cT+YKpPTRMjVU/bWlIBNnOgK6WyJJlplY8Qs8wkoE+pTkv8yOX6aqUiKdKvD1u12VqAG5ZVr1eP5izrgxIWxw9gW4RbkbxZcL4wN+EPaR+H2yIsN6x+K/5GpX5zNPp94TuWlRQAiIbUUmui9DPkxMNj8t5tYkD24jK5uGy/d5sMB+HCnM7P3JhdnJnxBne2ovkqB+K4r5EzRZt5pMOByovveXy3yqW8uhL3g6k1oFiiRvwx+nsmxAN2atYcD021yu7uzsAql7IEYPNEMqWo4fpxlU89mGKJmojgWi1EzmicjAfpCs4JCGWMSCFx0g2qReevfn3jr//F14qlxo/e+tEwYo2KHQaREMqxLdexQxFeWW0Qwt79aPf7t7a3DgbKIgbWs3opBxHQQsDAuuvYGkTKWKbZh5xxi1GpBMChdAxwqhqVQmfgD1ujpapFFBnXV3NyRCg0hbaQAFkQC011gXP6dGQfc/bJcI082U8uYEIhbG6Q/X9YfI+VnmqX9TXRCoRiDK9TXv4Uf50E3fQZ05AoAXSkKXJV1nx/UwbrZs3IGgISv3zK06eQ/XRvlOlXUkLnV1yz1gZSdQMVS2Ueu8t0INOlXZIwGik/1EIbXuSHQc4sjxmbuJ4NILKdjNe/x5IHMyexCWF4vdFkSMU1w5ky/n5S9YHKk3lSXSyiM3APhugMUCuhMzJcvvNCGQDxO7ObnVpo84r8NLC9Q4LFYvzJ0mypVCobq1zjk+vRBw+2dgfCqybr0/Lt5nUXV2wXx6h/Ijgs2oNRQBkdHlpTY7P8V4vaq80WnOfXxPdubSKdd2ow0RQ5zbiiS+cataJ11IkrHpNOMYyjziCweQKajDGdBuPq3AhsTOa95G2LprJKKDWdzTnEz+zpULmmJBCtNM3qOZQQdSp5+7RMP27Gyo9Vkiqbzprp6ed70qBQJ9D7qhke2M7M2KBysk37jHyuUPjC2vQMLCPI9Fvxee4A2CgUvj8ahUJJLU1qfKbJMEofv08AuZH2MbWCJPPWIHuD850Hcu+BuvKiWl7B7o7z9vvhz33m7HKlQcPsFgxYz1d51q7WCiZmlhpcfnNHfHEDpFqCH56WvJdXxuKPgfXllXi+ao95es7kblA+7geo26el9lbgATjqDqaQPdso5Ol8fo9CLJZ0ScyU7X/ra5/4+udu1EvssBnZDjva3wMvQIwACLhDfwig6BVvPdr/rR9tPthpUkZs01cqJRjLUDgQWkrJGHMdbjEmlVCaGHzX4A7Xrm3FQsdSmtHo0lSQiGaUD8NoFMQ1z3IdFkmtxNnFB6PzGnLqWuR0/2qGVuSUu2aavD+F6WcmFutPXQw8DfRBEE7wZcITJ/vTNJOPfcoSg3O+xjGy52X9iSUkZfFBrLNWpjxbz7/yBtbzUgylZKlqmWF+n7s2JmnZrCgrOmP73E83juWUkpDcnkAL3Ynga6KD2OwMANQ9vlTlnkNXKmxx30FnUL8y82S5UtD+iHjV94/dg+HEW7nRUFfrAMJ/+vAcsfZ18qk4X6EA2OdKvdXn6cMPAXQXVgG0Tk4AzJZKoe16t/Zrt/pGcjGSevTLn46FpowOv3tvdrMzBqy1WvFzFwNJXabu7fX/i3/+ruPYLAeRSimttM05KBFxHMTC5KRrrWolL5ay50eOZRlx3PzmnJv3USjFU7f7VCKYYQNmIJ8hkpTSvKkm4+F5l8vEALxcN8nEm27OnxRrTEuteXhaaQPrFiXPuZZZgFVpzMQ3CoXT2G0kl29U6vU5B8DCijjc4WkFNQH3bRGe585GpAB8dxZ7XXF53l6psILLl0uMFb2iViWXAfi2vZNhnwHHuOsBWFkfZZLLcKAuLtsATIvp6y9aRss+PE4CWPIlyqys2gq83Z2BqaOenmZnlgHTa/qlN+bvPRkZgT7T9y8u26bT9VvfO9rdsZZX4uWVUtwPzD1mj8eUalPdf7C7Y736upOtIjcfJEtX1tR65ilv5smeRcLcf+kz6+1B6DK9Ml/99I0Ld+9vSU2W5htDcxdiBAC8wMVottF4tHv8D/7l929tdwBwDj5Jq8FYJGQcS0Jp0eEmblcraaqppjOHQLi2C8DixOI8EFqaVjPGAIwiSYm+ujLXHw5OukG5aBsoOaMDSKiYU0gNEMTaRVzgfCTGCkMGZ9nxSIhsvGq+2JhBeYb4+Sh2Ks6oY/7UMR15hm48jqfq4jwRXlJUTUT2PxGyGxUlQ3ObTEw8za984zudRPYg1iZlYUqEmWLrecKupfJ92RPSosQjBDFci/i+7Pp+1fMMeXeZhl0IwlEfvAxhfueRvZzbafbBy2L8ZydCzUYNuu+4hUiMQAAE0B82IxWr2x4DRq5FltrNOobEKlQK42CAc8QynN0gey/29WJxP8X9c8QCpFHbR2FcLFqjR4jn0tVr2Gt5VfhxcL/pa3KOWKKf0EP7v/2h97mSf+maulr3F2LvnaH51+xmZ/TKyBt1VaG6ULbO1b2jTsBdJxNPlFKMEBABDcpIgVkAlNQgtD8KSy7nlEqhKCMGVIVKSi46V/ycyu4f63gTsDw91u60pD6VEpP3XWES3JOpeEoRSpXWOhZmQYqlMgy6yOhnBV0d8dpiGUB97qmTxtrH4UahsIFCdpnF1xoHP2hNIXvy1leUPk+v1cp/dqkAgDQcALoVdoFq+menFV7frd+Za2fixsVu5dWafaTFt479jEob7WK+yq8+X9ndGdx8IIeDgaG9T+5yAJyR0hwFwtl+CdUIyZjpwXyVZ8EAT/MmPt6NdHfQcMN7A2WEb2NJzI+7e+mGBvi9u729B1xp67mXpFV2793tmRbT4aBnrD73Bmp0It95O3zpBjH1gOFAHR7zZ8O6Kd7myftwoB4P0myZ66sN4zyNFb7945/YrFD0rMEoLBUcAI7FCq4bjsJatfrmuw/+wW//RAEll41HeRjoy8O6zUy/YjoejAgpOOOQ0uaMUZ5Z3bUyI5gRKaLiOBKyVnSurcwXXSJj985ed+uwb3HmcvJUiNcEUoZmEpCSDuPQIuPs5iCDtvzgbFdJH+RM0cYjOlY6jBVAvFMxqXkBJ39mpo+fBfDIhopk7sa043TauBIq4lD9MRl6/ns+geyZe1LGmMxmyGq2+UfbjwGQfMnaDGJVacTQRBXXSDGhHIYiVtpilFEaAU0hi6CmZ6JRoS6UKaKaTgKbQ4sJKM8fG8KeIXsnwsgXAEZ+1nSRvnEgLieFsm1WawCPunHYjICeUf/LBb0WYFmp2mK5erWuXBemnvs5L/ynD7PbEX0Wf8UdrKzrfm/A67iKUOiKCoMPBgAl53jt7kEttM1nZF/HgauvgAGQ3x+o8napXB3es6w+M6T+ZK2GHx/ObnZO1oLKKwsXinS/rXP1Rjr+uGYfXZk2khIdCGFzjCJpg+f5tQkhOCWMnNbEaWajTyMKzDg6TPUZ5RE888OOg8CUyhmRAakIJZRSRYgSQisttZZCZAoMgPPc2SgU6nPOlfXxl8tkxUydpnD/xb/yxU7rsH28f+Zn+xvXSv/Gi4lo0+2pLqBbIYDmQN5sjZYG8lKJVYHXlivPo3IXvVaIWrWwUCXohc2uP+VSNz7I2cWCodsGB4sleuF5sfeAF2bTocTnRutzzDD6nLfyjJMZjmEqq8aHUyxJINxYt4zbPT+dI5XFceVFNRyo4QAG2Y2vptNxjkoxwDsdpzALw+gf746Lpc9AgE7HGZ3IpfWJmSH5JlU+9McQU3ArZrsdhFE2o/lco2Rx4vvWb/1oO4hFreRSJFH/5sMaacR+RAi1LGZzxgkUxoOcKNGccUo0s21OFaDsLLyXEodRLVUQRQC5dK5xad6VsRoGcBk21urLdfvWk+4wkkWAc6agjfHOAL35bf5UQgUCEdcOpzalGcTnWXyemxvUzs9CmiDCsfKekn49db4p0p6ejTfB0Skx5qeMLI+hdjxNMLGhgCX4PoXyxhVjE2UwfcpWbJOf0rKUfxG0HO9yjJCSlqmpyep9GqybV1uCDIYiiIVFifE7Jf+KdQgN4MF+96QflByWzROnnlvhGkAwSjiFHyrCiWkWm4J4PblRgNkkTa6mBvoz237SmhCJALrPyI6jVBzSblz9vU656tbKVtXzKgX7/GLRPRieIxYvy0Lf3Tq0sIKcq/JgdrMzD9yPpDkWqRnrHLH2g9jkDRX67smHQeGV6uxmB2UYuabwykLhNz4q9N3ZzQ42Oxs9/RYgE5mbKqWMo7zgFRjR/VFo5tFTllhpjLjCElauCSHsrK7UCac5IUiXDaXGrsfU7Z6o7fkPSeKznFwbslam/CWllDSJgNdSyExVdy2+btHzaWL2F9bqeUx/GqyPLSjrfLc6s9xt1q9fQm/vyTfv1eccQ9vzp5WR3j4eAfVuLxlF222FzYEkvXBg8/snoQ4FzlVIL7liQbBIRu3DZhvo+vihN8yrz9Yxv1ZiwtOmiIoHR/mWn6V10emwFBPDw2Nu8PTxbnTUpRvrz4qvMb+zrqjMbbmxnjywO1uR0UzGans1UYryjsndHct0J5lLAnSqbco82tOcXXQyNJ+Q3TO7Dufp91PEQsRCxCh6VianilhESlNNR0HwhefnwtDXSg77ka8UCLEsJoSmBAXPSfNQIDQioZTUnMOzHQAMsMz3VmHKg+EHUbVgXyqX3UKxaqthoAHiMg1AxmqxUQ9CvPe42Q+ExbWh8E+T4A3E+0KFnNqMEEJsoTTGbvG8zm6OzW/CqJ/zcQeUIf0zM9hMEfzTN/UsYDXf3UxbzyP7dF8TnBykRprmUdsg+4QkasaYnaLq5sYnAN1sF9KlbiTiUJFIaiU05dSMZo1AkHQkpW8lNJ+crB0J6QdS6oSwn90oIHSr7bfMVSzKOSvazHVY2bVdx7Gj0C3YbgHBKJoKmjNY3wdPqLrNC2ways+qYIypvQviAuAUBds01gZdf6c5UnE74Y9lXpbR2gA3HIljUu335n//sRHN/ZstQSxelqiVjpYsoGYE97xGD2BUDkrXatIpn6zVarf6vCxHf+E57ZT9V4viD5JU1ppLKoINY+E4NknyejUlMP3fBtnP2IPmMZcQrTRlT+0Syhh8Xj3Pro9TI1ymp54lu4LknZ5Q4aXkjMSRiFL5zqJkqWhfnrfXy6gdFG6ORhuFwqufKa5KDoktJn4qrJvTR7T8XLfZufB8LOSTb344QUIP+kgHH5KK+0f3wv+y1Ly+XCK9cGcY9uOxON7qy/sR2emlLCFWAI7OJx/7PGc/6or6UXHtoew+kPDZ5mLr+qpttG+r7M4jMCZCAGYgdbFEjQ5ueP18lQN6aiD1mRINqZbmq1EmhpirnBw0j7rSyOsTjsYydncGU/CdA2WaSecGxNM9RILvBtZrtdC45pGuTGlj6sTyMMYXbnERC25xUz1rhcKhmKkVXYsxorWWn//khc9unA9jedLu39lqHbTaD/YHB53A4iyIBAAr/SzanHMLhDJOlVD5mT4sg3UVy0ipN26cv7xU/9G9A0CPVVqja1v0oBvd22pTAsdhYaT6gfZcZnOWkfcpuSaRg4QKBCinChoxgNi1SNbzeRaTnXihXSVBMG2kOQXxE5sAzkfybLk86SxVOi+MPEvDmZBZzlBd8l9Xc5m8/DIhphNu1hWP6JEWWoIwy1w4iHUoFOXUvGIG5U9TdY6xICagw2FkIhPyhB2ArXWUgxJb67qXxlpAh0K2/RjAPobUog4nLiLiWiWHufbk0hb5GihDJJXKyBR8UPB4gu82R/TxahKRAOBAw7ayewmieAjSpeSJI76NsDiMG98drPWiV+Gc3+xsG/mlUKzPOSdeVV2VfLOTqe0na4l/pvDKgnbK5qADeJ9dj5QWYYyVdfLCptHfO4EGh9RapqBpvlxRHNMU3KcgnhKdY+IKWutcG5RQiptwodR+l7YcqXEyx+QUU+TE+LwyQ5MIQDPidKy/mxwbKaWSSsY6q5SuBVhWHJfZSsW+3wy2R6MvrNW/ctHtX19tVpbs3h7uPALwlYsugC0mnoHy9F77PnAFd7PLtI9Ds1RsV6Y58p2fBHd+Erxw45S845DFCu2m5XnPopuL4Zl6dLFEC0SaZGk/VsbJHveJ0VVa8JAy7tkLoUHhbG3IxxjgrMml2Tn5wABzcHLQNPieGVeMK6bh+saVv3sGphuApnmzTdwPjiCssgv4Bt9NH5PZB5hkY9NOhVy3arYpAUD+07/8ekbS8yhf9KxGJelEpYzaHIQwRplUklFWtCWA1kActgabh/2HR8PjVnu3PQpDCUKKNrNsm1NFKNNKYjK10VRZl+vFK0vVSsnbOeoGkrg5ktKNaDAaBlG80xwNQ0EYs3linA+Elko5NjUunQzZp+A+/2fWaJP4Agk3ePdxSPezT9mNGBfKtIx+unCaeVSegux5Kea0LJP9OcXoz6Dtkzq+KTbkdZjTm56n7YfSxVIHsXAtzjmEgJTSNJRblIAQj5CIEFtralEVKwCe99T9bCi0SsvLCdZbxDxCU6Y2WvxeVxhYB8AGcd9A4ccH9wzkOVVCurn9R8Hj+Xp4cxgN+9HnCoW/AHK/4FU/t0jvtTsX3YrlEb8z9722wXdelkap77xQ9j67nnyoOInTF3MUxrrfo/fas5ud+5H8Jo23Iumn440AREIwgFF6mrnbJDWYWVZmhwchLG3wlgr52dMpK6cgOl841ZPTq6dMMqcl+8zKI7WO01Qpi9GlgnWtr1ZhLZoiiqvrV2beFp1oVxsppn79UmSQ3ZRPbm5l/D0Tak6jvOlUmjonY+6n8T1B3vNqMd02GUyvpi7Ug546Oh9nab3xfadA5GjOaqOf+V6MbSYT0DNJ3Vwru25G9g1KfnGjkMWpG8q8sc5mPOd+m96727u4bFvlsTlydnHm9s3W493ob33jue32rlkMzP3mYB2ZsX2Kg2deSXOzuzsD8+CNCyi77uluLHPj+U7aKUMkz5qSqsWigfVSwfnCZ6882fF3t7eHkRKxKDlSEi+rR4ZROPIFY1xKYVEszpTWFsqhWDhoDtrDYb1YfHg03DlsdgYi0sJo7hbTlm1DxUqKasF+7vzMuXq5N/Af7PdCSYPRcDsioT8aCQCIo0hAG+Y4U3EyWTnS1NU6COUwkmE0hvg8yufhfnLvTiBNWE1MGNU0kSkMB0+Uk2dGxj/NHT+B4PnmoMzQpybdjZPdQ6fYel5p1RmUm39lyvuZqnr+NjOsL3Bulp9+jKf5jp6ldMVqKJXU2rW463CHKOJQgBt/pIHpoVQAqMPtj4G2jpkJkAK970vfRxsiIsTWgZnv4YIUvPGHuJ+h4R8L2W2OSNhCTXlGWn7cyPmdZoq21vr3uoP5L11bWyj3hBZVX4VWz3EqXu3oazV6r53pM7wsiwtx/6RZnqvpYCRCwClTInUwWjzcDX/HN5ViAGsB+kU+GMVW2ihkcx5HMaGQscwgnoIBCISIheQWz3zpjPMsikAl+WOaUSiMnTE0maKoM3siJnMop8QcKSXS2dxm8nHmezE10uWGOzM/u8R6Fw5txEnHLwA3IHdUM9qlf+0rcwD0pQUAdm+veO5ce0hmvv+2QfZVyVcvcmTesvUJfM8je3ZsaDuA2mJ5O+eWyZ9Otml7Xi6VmBFhPGsM9EaNyTC6QCSAwnFsrfOsCShfF20F3sKc/3jXDLtQqGK+yg0FnvSfhHe2ooU53Hwgd3cswFpeiQ1bv3c37nSc9zpYXpkYFbIwp4+6NH9HVvmUfJhGCGQM3RwPB8poKZOoPWGr390ZnNlnm1fk81KP0YjI3/2Lr83UigC+e2v/1mbTogj90frKzLW12Y2Lc6tLC0M/ABDHsRBq6A+jcGT88YNA7bWGcRQFkYqi0LYd16aWbTeKlvHeDP34pBfsNAeHzW6s9EEvHo2Ci0uz87VCMBoCCDQ7aXcDAUo0BTEZkDalACKl8kKhkDDVVKMPKE2E1GZ8jGNTU7A9E7AyIn8a0YxTnnJmsNLoJ3nTdwb0RsMx5r/TUTbZ8jBhGJ+UR6ZTHj+G3zEzw5ji6hT0T5P3p7vjQ0WCUH4cMJxS2AW0H0gAlBLLYpRoU1ejjFCiOYgpw9ZtVix5J/1gtzlsFK3MjR5gYovg5AzsZ56fZ/S+1ozSqksbafkns7H+FP39VCXWfJDsqQXM5mWPA3Btqx9EYay2T4arC+Vf/tI1Jwpah3uqWLErMxWV8Mru9w+ujHzTqYSrN3DvNmmUZX2FhH3tlCmR3j9+z/B6I8Hv/s7W7aP2potbo6jgWoZ3m0JlSswVpYRQasaLR0JYnCUDLiYblLIwXjM4W4NKKcdxwbn218yZTtPw3qlwGClELNVUHGnNs1YIWQtww7bin1lszM4O+m39ThedgYF1AAdQtcXyq59J9vGrkquvvwZguL8PoH3n0ao8A3SeJtFkyH66lHrzKfielD0ujY/3BjJeF8+uduaZb0bhDdt95+3QzL5YXok31pm5pOky3d2xzlTDLy7bj3ejvQfcXCvTbVqBZxIIDo/JjY2GSQ6YuuvxE0yjxzAZEXP1+UrD9Q21P+qKfCHXIPtUd1L+dBrZAew94EoT/uLV5d9566Nv/niz0x8BcBzGGf/+nb03f7J9fra4Mus6dmH9XOXGpcXV1ZXZRlUp1RsMu/1+t9kb9DthTAAYZDeke3OQLIOuTdcWyi9dWRyF8Td/8OFh27+0WJ6rFRymqzWvUrBt22nPu63esNOPs+4eY1YhYKNRKHKumxwZ4YTA4qCUgrAoivwgLDJKLZrJCHnyPoXsebkmFBpChKYfSom8JAJIJ29Bk7FxvIxSX+MUfzeWmIkuoZzmPuF9zKF8vuEob23UUiGlQIEEoAmjSYwMYBM1XUSdRPYg1nEatv5TQfzMimgskqqpZbHEt8fG8YJKk0DqQGhADULx2rkZALvNoUFto7+7IK5HEGfKuz6N8kgTisxvl3Mjm9RsPOrG3UCFIjpXtvM21ozR/3SUjwRxLRs0lDJMC+xGqMl2GP0gokJqhSKjrUHs3dqf3ex0C576JEScmWVQ/dwifv8xgOGhVbyKfnW+3DpCHUZ8V5oFP7sIQLf60cqKdsrk1Sr+ZXstwBZnI6l5Gp+bDNUTQmotpWZKm459i9GsZWkClDWhnBCAUSpVMteJUqomo/zz7imtlE4L3blwGB1HscllNJ3SS0X7Wl/N3bCrl58rvLPrjoYBNB32Ol519nFggnoCVxtNplZLkN2Adf0XL2F/H0BUWaoXNYB+Ks70N1bNwR88Dp7mdj/TC9856Bun/JmnjULh5mi0/Qgv3EiUmZagfldkkOduuhUqycvRlGHxjOp7PwCwvCJ2YdVqxrwIU2I1VdbMuDJlOnyMEICJFx4OsLuTMHfTVmqG9j3jrs3SkofgPMpnlz/tfUx6ZZ8C6FNRM2YfYEKJKdH8f/nffO/x3onjMMdhYSgBcIKCyyh4ZxCeDAKg84N7e/zbH1U9OlcrXzhXv77auLK6+JlXVvrtdrs/3NxrnfSCIFIAyiUXiAAEkQoitXnY3zzs335y9Pf+xs+LYPT9t34s0kDdKOZhOLK57dg6Vp0glKGUkdSRkDlAJ/mKk07LvwbWHYsxQmYrbt+Ph34YBYHFGeewOaMgGdOfAvdsAcjKiXnRBkkMlk5RNf8yR2l4iyZKTMsjGXeebPhM4N6kPKa0PZfckoQEBLEGzubXE11F41zMRLHRsdBSIxe9mylaT/uqPONfw0gqM36WEidvczwlEyeqAtFC4Mf39h1OPEpVrKhF40DsjRSjlAvYnNmMeJbVILrlx6GYVvyniHyK2rzhWUDcGsYjTvMSTV46T9bap2s1WukCA8AipWxKYdNEqDFERGlzC/1IKItAxu3jcBZwD4b1OafzPIeafkdK11wpValsowujxhC3oDST9RUApNAf9KMS+hXLA7Cs+KqLO6FIkxoTGs4si+aC3bOJHFODMsaT8FL4NhdjlGpKTBpMTjZPB+wRZpyRRnuRakJ4qXv8Wl+tKmuxT88Ra/923F/pGgQHoIoV+N32cVi/MtO+30zCGwL99RyyA3jnn9+7ss4v/dyXS9WaFJHtOlEQGhaf6e9PU95PI/uZbsin4fut23jhBg56yj+XoGH/rv1CjVRruuvT4Jm3kKfz6A6WV+KN9aRbdWFOA77B3+WV+EzybmC00xlDcysYF11JtdTwm/mhqZnCbjqSTCgC4OTVmLwxJq+VG/zJh8+cKambnr0sJn7i2zHLRAf88UHLcVjekpU0H0Fzzlw2Fu+Gse7ud+/ud37n3cdFTmtld2Wudm1t9nMba0Ko9z/aLnrWYXui+btcct989+GnrsyszvKNr/8b3C3817/6B4cdvx9EPT/2AxEIrQCeIoXShBCeh7nxFEfwrPTPOHcYK7jJB2i2WpitFk66o1avF/gKEK7FCy5z0+elpZKgyfPKwbpZA/IHJqEsX4ad1LXHCboaCLNkLkKMuexsv/lTchazVK9nD9Yw/zVMPHs8Q2mejlJCGSZuppEa4H42MT8trGdU3bBIRqnhkQnTF8YzC5yCeKUJZRDQLmPUGusqpgsmjFQq7ESzFWeu6h13/dPgPt4xIDHdB35suL9H6d4wWvf4s10xz/iv71oFpgllOoiRq6MaAtv3RXcUUU7LruUHIv5k6ai06N1rt+83a+eJ9mrZ5Y/fqBfOX46UtgHtlAlgpJiTtZr32XUSJqJ8qWxrp6zi5Ftwnju3RpHhJKft6mM55RQBTy5P9VTuWBYJwDnPF1fHPncllZRRTniZqxbXZry5k3AjUoiR1ZZNEoP1waB3UVbeAwA67PFGvfqyqwEclwKgc9C/uDE7hdFX1nnx9TdK1RoAxu1S1R6gM5ysrK5Kbg6eccrDuqHtBsFPX9JI8+a/39tWwfkxL/7cOfKXP3GOFctv/mTvtyYXCVOTnCpmWmXE/WB3x3rphgZ0ZnppBV4W3mISFvP9nxeXbZPwnh+UsbszuDdQF5ftph/OVkvGIZP31RiRZ3nFgK8zdfW83/HwOCn/GtWoFYw3GfmSwLRxuuwCmEeQuTAnYilr4I412X+cQzojdmcgA8DNLQPNfnTY3v/Oze1/9Ps3Ldtem/H+wheuffrazPsPD+IoMrLM1mGzOYwGEft//PrbN9598l/88w8e7p5QMxqJUspIutvWOSiXU/BBCNNaZrzVwKPUOoiEUpBat4ehlNqx2NXzSarJ7km/MxoSpT2XFd1CoQgtlVY6UkpBA6lqkekM2QPgNK/exGehfAxCQRhUsmZITQEGJUE1I7k1IM6AW6bVEoZkXLVDdUSS2L88vk8tQlMWoJzYIjOBhYOAMaSZfD8d2RmjRJtVwbgbHdspVwoApNRxHMo4jgUogWll4FzTWCOG4sRINBmRz5becZLUZNACTdWDk24AoOFZ+/3oaS4ah5NMtGl4lhFelMbIF4Wn43tC4c9UaVI0dywawtJKR5zaQhUYiq590g+6owhA2eYAFCfUq5Jy8WhpYN1H5w9Pal+GwXfidwBESotY2I5lgsNMe+rsZmf0Sl87ZRL2C7/xkdHl2cq6KjnoyY1C4V8NBkIpi7HEt5iDY5Umi+XR2bykRsMxAU1TA5J0Lkk4aU3SAIHOkXSLktmqu1wv3rgwP1txG0x2v3/g9oaBqwNXZ5XSZ5yqn1vc3tutoXxlnU8he/36paXV2sSGplo7rCz1N9C+88gg+08ur9ee3P045vePqcxk+P7NVltYnrfoA/gqir/8masXrp8DL612u9htLsxp3CrqKDa11nwQGNLwRUPMj7piYY5l6J8BqPnv8kpsphplpDgJhxlEOXC3OgcSiMxEDuODfPv92CTGZHeU3cJUwle+hHtUihfm2Gn56GnIbs7P/pUtQnlxBgDPBjAJAWgdxzIg2hicgcTXYOqZFElSo5npwRls2ykUnCgScRQ92I/+k//Xd//mz75w+fzcnQebppvko+02gPYgBPD3/v63fKXKLhe5yTDTNJDoDC9yWoTM4EMDjLIwinwptQLj3HEsTmnFZQXPuXIuSf03B/f3e5sH7ZNOnxIUHV4rOa5lwbG0VK7SkVImOjHjxdljyHtvDLBmKE9BAK2gFYgFne1yFAiQCDtjNUlqgGQjUMzFKIiSWkhiRiKcqv3qMwsGU+UEE8XDs9gbKZGGcWa/8/Tc5DkbgAhCKWLlKwVK3ULp8mw5NUHFUiohtJLU6GNhpMJQmIJqXpAx+G7KqtFZPTJG/M0GQTBKpZQnvdCuWka6eQa+h0Ibnb3ti4h8rC3Is/V3XxMHKDksVjroxwXPKpa84cDvBYJzVrR0gWEkRCj07MMTdVXOlkpmDg/Z1gTtoyUL4LOlknEJAyAnW6Y9Nfea0OGPD+0+42XpvTMc2FsAdqmoAUtFe3sUE8ZUrlJqKqJ0cvRoOsDaDKNPqLqU0pD0vA9Sa62kVJgAdOSzdm2rvjLTeX7R+JtbkmFdBZ1pWDdqTOVxajkrVgAcS7570DoZtJxjfGGtfhrZDWFPVk+nDsAfHtq9va3Dk9HSxU9vbwP4xMMHWx8jUzWv0uTJ+/mePO2MNPh+njvbh+Eyc6/NMQCPut3L3uo3393852/v4zz0uzYQk5ejhVPyyGllY8azAd8w7laZzsNcLL7/PjWKfMavj7piY86fqTv5rDFDHvYecLyIzPOOpOM0HJ1QQBZm2WlkN/4Wg7/5tICPiexm05AX4rMkA/OYs+WEWRYjBEIgiAUBsW3OuSW1DCMttA6FjqUCoYSAINkS6kQHJARKa6U0KKWOzUDQDzXXytQMhdS3tnqAfG6lcdCNtpv9gmcLPTZ46cnYouxPk2xLic4ibpXUQikhRDJYEsqxeMEitmNVC26l6FoWB9AahDPl8Yv1P/8rP1Oz1Xyjur4yu9eJDlv9/iiSQoGAU2rZ3OKMM2pxZhNl8u440QoT0Vrm2DQi6ckgaZVKJeoUWTYTBigIyf3LvIBmSrhKb5Bymsyzzua7P/1kLqkJTV4fQkGTH6UVTRcSzpljUctitm15XtFzXZuqOBKjoegFgjkF5tgLjcpcvXJpvjSK0k1D7CP2GRQncDgvcJRd5jg8EloIaXGSvS/p7B4oQINoEIdTRiCEVhYRInX05WBLaRQoJZQIYVq6iIoVOaXzSIWqRy1Kd1sBAAZI6HLJecpygFgoy6LxU9ycYJQQQhi1pJSEACh7VsFz+kF00A1tioLNC5wCiDUNY/nKbry02x1erofHkduJxZEvjnw9xKwiesbzigVGCH34offt9lh4HHr64QF9ebn07YfUSTvdiLvjDNFW80VPC/Uwjm3G9cRHfSzUTAU0Tg2bVlJRRgkhlGilTPSqimIhlJJKKa0tSkqMfUnxL8N9w7Y2fP4K3EAoa8FzTwZRTSliF3hU3VXYm0YKLogQEVwbQYRaSS3aHx6EO/vN64vOQoEv9u1PfNJt5aZWrb+x3r7zqF1fqRVZFAa26zLuRWF7d7+z15Mrly+tLRTv2ZXZk5PMKnNlnc80aP5G8sVVr8gBeEUejMb79aM47jlnv99HcbxRKARS6yGdn0fXx/394Z37B+/d2j32FWvRQKJ/UZRyo5177fEtq0gMQ7V+nr54Q5eKMOOnzeDsVkAOjgMz5HpmUbe3WOeElBvKTMcGAMnmV6u7B6NsUnYQ8HikR5Einr64Wlyh1cftk1t3LQCjE5lVXzsdx3VlHtkBHDWFmawtOqAu1s/T4Ygwh38cZDdXf7LNgziqVxiATl+audhTU7MZozQWKhLSYrRStIsOI4S6nHgO44wTAqF0EIooVpHUSkNpRQgjBBZLPpqMEg3W6gfQ5JWry/UiE1IDGIbx44N2weH1gvXhTisUkulxAIFGsmOA5objZfhOSAIZcSyFMBwFFqeeY3kWdSxedLkJICNah2EQq/HgUwrlOcnxex/tfOLSLNHqX/vaK7/4xvMzBTpXrx5241Zv1B3Fo1BCa4sSypljccdi1OKcUZtSygiD5pQQymDwVGVzcHT2QyhRQpm1b5q3To6izZ+vU4zOMP0MKRy5tNj0m26WQ23mWxm8pJQSTQgYIZxS26K2Y1sWL7qWZRe4ZUspBoNRszsYxqRRr9brldeeX76wUImEXqy6BZudDGLD2ePRQCsNkvVAJm8UJ7As5ocSoIwl74u500zJM+AOrUcSlEJJLdIXyYRSxVJVPavmsKHQ2WIJwIB7hvIqVrUSK3BukD0RBrUue9YzwP2pyJ6CO7SWjFlSlgpuqcDaw+i4H9oUjdzNWhSxUi9QOsPoaIkE+4IPkgI4H8QDSr05Ebtlx7HQPLZ2x81ikS0AzMyE8RLV2wmtI8+xh50QbTUfywWpf6CEJhPjkPLIPiXL5LocTFC7ZqZ3VMhYqlgoqRSAkutenC98ct7+Sot9VdnL4CUQLgiAARSAAaV41CvbljvnCKKtZjjojQSHmC1lT83gOx/EguOmEj09+nRd/eIrsxuXKz++2zznlfKgPPfVFzoxczsnl49aXVsHnY4kJAr7g273qOW/+MJKrVaWUtSKfFBgwXG71VJX1rl/dcNqHp0J7sFIGnA3x2Ot3LLMz1Ecn4nvALZFWC7Q2RIJBQ67oVDa4+TSJhFzJFqxPS7yHpWxO/NdK46s567JGc/xc4qzL6THxVFLG3AHUJtXbknmVZRhqC5UdWw7zZMwD+4WI25JfvnqMoAPHnUOjOGyQOORnluKzcVcV9o2ma/yYaiKLjVwPDjgwUBKpeeW4nqFPd6NZmYdswKdRvajrjBXTHY8FRbEUafjBHHU6cvTsoxtE9smzJCsgstc2+KMK020kpokuY+uzapFu+xy17Eo0UqrMFJhJOJYKsDm1GEsiFV3GD63OvfLX742V3E6g9AI7p0AO0edssdbg7DTDzTRFEQBHESl+UVKEzMqIMN0KRELpZRWUoEQ12GNklP0HNfmnGoNBsC0Z6dfA6qUHIUCWlsWH0Uqz9+JVqsL1ffubl06v3Dp/MLLz6/MuqpaLs1Wi5ry1iDoDcPeMApGIlAaWjMQQgmnlFNqWdyixGH0/1fbn8ZIlp1Zgti521tsN989wj08Vo/cIhcGM4tMZrHIKrLJ6arqarEXqTVToylWS+gBJEg1AqTGAAPoV0OakTQDARrM/OjSDwGzoEYlVQnNUjc51VRVkswimUwytlxi8fAI323f3noX/bjPnj8394hMckYGQ8DC3OzZfu655zvf+VxGPcEoI4JTe+aMMAIGEJrN0HkWjhfPyhAzNbFpqe3aUFwtjDaGUDPdI2lzoiWFEUIJGGOUgHHhuVxwWhLM5cx1ucOIJhRAkshhGPcGk+E4SDRbW5n/tRfO/zt/66V/899480KTPzka90ZhyWEALLIHYYw0hJGJsWM5aXa2+J7aUiqLYkmn9gwL8cfTnkEsvzGpJhrSGDJdv5Qx2pjlqrNUdlKpPUqIIJoQz6U6N4dMWfy5hptqfdRPEkKIIIYRohEq7XHiC/YscH9udSGb6ulyUil5novWIGmNYgqycErEjwy+/I3NyZUmhBffPrBAmeO7vB8KlYhFXvreGUGG0VZALzj0ghO+PJe8en5MvO3bA5KoJca8iLR807KGyBOTNAqT82ZoAaVWkNFKK2OmJB01zq55YvP62pc2F95+Zf2ltbmXzzXmOJVHYeQZyTHznAGMh4G3OcdBzbzvbc7567S4bq0SMYY+gH50Ed94a/73rtcuXmu4obr1NEw/pjnyWgIeNRYajz8CUDfUPRq4R4NxiTHfn+zvn9tYrjXXkngoHGGMGerS6vYeX8AFxd3VUtTqnUnei8cvgvsMjp9dEqD8425SLVGpDYBebC5vEwCPXkt1IhPmh1L4XE4CkovUcUuET2NdYecvqCKy58uARV6L77s7Ioo4o/KYuQOp4855YW+MtUXRHynPU4oKUaIvXmFXV5o7enD3/ohRaUm0vT41ZjRk8wvm/FpFJxlAHw1kmpgEPA0MgJULOOrIcoVeXFKhFJa/M5czl+upXyBHdlH17JX2yOMDnkw9hHYVye3zaWJ4tewC2dxUpSUoZ9OoAKOV0cQoEEarAg4VhLll35+EYRgliTLdieRMrc/5/6OvvnRhuf7waaszistT4kx0OG1FREFnP3F5RnOPY5nhFyOUGIczzxEORSyV1FRpTWFspMFMnoHDNNVxEIIx6jri/v7Qyu7brQDAheU86BvzjfJGLDcWS82qf36uBKBZ9e/vD4+6w1EopYqV1tYu4nHuONyhmRnRAzvTx5IzeovalpOmIOakkc4YowwzBPb5M8cBwJzMGJSnwjIruZhEauoQRQhFHt5ABZ/W05hJFHGUMYlOjVZxlAaRUlqDEB8o12pffT1THf/w975gL3zycPuv7+zf3x8uVIRF9jhJTRqSaab88de46JoXJ+rJVmc//QmmIA4jVFjze1aM1dowQhYqwhMkl8U9EJzEVZ1q32dzvgik7A1tq2qmdIVan/ZKHkP3OAX7TKltdtxKf5S2RrGAmTuF7IGCyxip1kqu2H68PYnMCoiFv3y+BwAaDGyn0mxRd+Q92eGLX3tFBVEQp+WFavXSk+Evotwzcy+ewLaGWofMdCJ2XqIhxKpckNJIHIcBeIIve6yqzNsBb3DiBcS93hhSNxfTF57Tr7BSbi66+Xc0djz/E1McZrLlJvfWzIuL7NcuLFyuMDLnmm5M5ty77x82cGLUxse0ev3xR2d4Z/f392T5ytKlJO4x7iiZ7V1GNy70A6dZSrYCpzFdHn6p+upnOX2wlQKozokbO7hWY3+1rnLNWlS9buQDxxJHqcXXuXuvneRDMGZ6i2zyuxXNZd+mvLnW+2gV83QUwct0FRtgYP+6vGguNs8/fbRbtCSeX0sBbrtPb1xltx+Mz+xCKi1kU1ZsTlneS2UPVcwdmw4eyUwyNhiHN87wa+Y+H25hXU9Lc3YuEgMsgMYaJpVUcw2TghiZzpccr+TsxulgHDcr7m+/efnmC+fGQXz34WGSxGX3WPLuTrLC/URm7f1FUJipmmpDgigVjLoOBcABznnFs02GiDWFltpklJYVkF1wkuMvQ2pSHesY1L2z3XEdcW21tt0KtlvB5pUNe/vNKxvA9pPDgYX13ijcWCxtLJa2WzUA/+0HD5WG0jqNzNhIRgjjjDPiELicUM4cSgkl9uFcQad6NQgDAIfaGXCwSbeFJ+lOHXhQSjOSgj5zrIGgSKUxShvNrCKUaGWHNkgNrWQkkUilVaSUIowJITzHW2yycskDsFARf+eLlzevbHzvh7fyVe17P7y13Qp6o3ChIixhnwQRVTE5KTrZlk4rHhzbOtPZHqgzdSSXmuhY7GN2NGjdMo6TR7BuPJsPfIzsoeyF0nouLbLHsbKGxfq0qjxjm1EVgfBTrJAln5crnu1XmiK7eNbNVZqM0mShUhErVRxMcr+gBUpvnQyVv1Q9g2MG1Wjl186N4oTEozJgIPyyO8TY3pEsSn17pLmhUyMjsTX3Kb7LJCGUKZW5UQGUPLE+518emxuJ9kYk94oCGPyLB81r8+0rC1yPAfTudzyQvFJq0yufDrV/Y87dbBbZsptkn49/Y67Xiu8e9V74fP0fX69vcDqoiX43RjcG8NHt1t5YXTppSM8yvwoBv0+YvHD7yRMm5956O3v3ZBJOAmu6T2rnVis6Ahr3flg0vP9SEP8sZ2TxtM5duhe/WfMA+IIe58zk40kfcEAKcHXE+jXtC35+zZ0Zq326t4g3YAMXG424/djda/PSAgMyT4sNlrHmSAALK/OPe7udMM5LmrY9qht55UrWbnomsmtDGo14qe4sXzXdyHvv50Mg7ffdPCH8qJIW72h7qcoVmbt6zlhuC25IbufbWajVhkBLWDmbsgzrDVPSGJq9/tYg3OsFjLG//YXr/+PffLHV6X6y002TxHMo4NocgulWa0IZB2DnEFnHnpw69mZcMXEsBWfWl8kZ9zjsfRONVBpomZXyiuUgqgllFtnzmZ+E0TilkQwE41Kq+9M99D/9z/7V//6f/K0c3zev4Hs/vGX/u90KXlqr9Ubhzx8cArCri004YEyUfVdqrZQZpjIchTYQURnDiC1dgoNwzgQnhDINMx1yTZ8F3ABV6gyVwZYWjDFBKpVMpAGUykfRwhjKDaVgIJyzsssq5dL5uVKzejzLszcKm1V/Y7H05HDw5PDWheW6XdJyZG+P094wZBTCJApEgYiTcTrWQXQikDJFzAiUmTE1zX5NTyzb0EVkByIY72QFouRzhDKCmbPG3jC1uQV6aszNkH262P+KJ4eXK77nZpzdYaT5jBFahBITpfzWvt5sdhVjpyiwNc+U3p4Hts5YRH7/Tc25jlK41dF4UsPIN9J2AJVfq6xL2fCH/TCpeJ7GcRCj1lprnZF0LfMJGBsvLF9aWzwnO9F3OqeHKXkR6d3v6HNC+nUArFFBgYy3NxoL2/31GsV2/2jzeEip9jwaRXqz6W42d1N2L7j/e7+78rubJQBPwC5AXZjjP3uQ3OsM7neipvsp+yHrYbf/Ukq7R1tJFANwPPewk3jjg6R2jlK6e9AuMsuZ8Pfnnz4V1gGMGDHDKPc4vPmI7C15u4jytJl04AukTZe0n9J4EZ3SBMDuDs1jYQ5bJB34wKBIfvt9NBpxeS0zFC5cjPt9t3ugAPGVG+IQic0Oy2F0jdaRDcOjljJvvlADQjvV+rBlufZsdbTRiIM2t4m+3cj/8XvxjBfeOho/2CG5H8bie95IdZaLRhR9+jyv1AEQxFQ8MUmMmkI8O/72M4eiP47bifq1ly78/m+9AOCnd7fHUbYRi6YkdhKnADzHtUx2BsCKm/oc322bjCsIZ5wy5lI7pFElYFrJVGXmQosp7BjWj3+DOZgGMaRWZdctcQnIcDRIIfqTkHHnn/5n/+rbX7+eU/ivvf3qJw+3Lbj/l3/1sD0YeoIqw1Mp7QO5rm+bYKtl13XEbnu0XHUu10Xq+F6p3J4Kl3GStgeTIExTmRzb2nSWJ2KyLdHI8lnKiH52FKVW2mhlmK0rnJgIrIxZrpSunasdF1Wq/sZiKZeecmS3bD1/mf/8z96zUkx7nPaGkzgMEoOSYI7DjVaxMVAwStOpgjabLSzgwhSbdelZY0y01Ann2QAfY2qc+R6daVAq4rtVaeZ8wRzeGoSDSHNBANDUALBRZRbZ+ckQsV8K2RfrGbIfDGIB03zucMSB1OHtrg/MbTYHQO4Ht35B72CyEISTt5H8/psAnP/7T45f2jdXjCFplAIg8agmAMCv1YFBwyPNvbTXir8ovL8I03EUUUaJNjlDF5RYTM9VFwB+SsKyIHeeN5CLToa8Ng/A/epFb3BAnhoAjTsj+8PPtSNSrak0oVFk1y0Af7PTf3R7/x9+vnqe8u/fGc6dK706h8FQf/BkbJPTe7H5kr/wHIptnTAWqS8oPhru9YaIKivzVZJEsTPcjyor82XTm5DG44/ybqZfCtkBnOmGPN31Zi/8ZCjfrHEAv3fE/8r1McQSBIYA5OoOAdB2sFMa5Qh446peWJn/5HHw0Y/jKA3rFzMktbJGblssDqG2yNsJ4+VFbO0iz4Jfq9QB7OhBwRGfXmuKTjhrbSyqKxamz12NX7pQ6YTxJx8Ni82rRQu87IM3znZMnj5NF4bsyXNbJXOp9lxR5gSAK8ww1ISSqksTjShOCWWpNMMkfv3K+b/zxcuXzy/uHRzefdw5QSgcGiU6NbTsipX5ikzlKMr69fWUreed8UV8B6C0dl3uT0c1WVk5UYaeVAAY5dasncO6Ig4zhSD/ceq6btlhjKSJRpxSZUiUyiCKgfhRFP3xd/G1w8HX3n41p/B/fee9f/X+FjGqVHIBcFAQJpVyHMGnOrjriPYgYIysz9eQhBZYc2y18Gp5sUnGdqditO2T4rXqCe1yMAowjaPKywa1as3KKc2q//3bu65gVV8EkeyMRty2hgLakN5o1B77CxURBZPV5QX76F97+9V//mfvWWT/9VdWc0zPkf3OdieIZG8YIp0QRn2Pc2kGk9iVssxpCiKynilV2PqDMOpati6ORRWtDH32L9QhOgQ4R82w50T+Fsk7c/hOJ4ikyWcSJYTYXlkbL3xmv9JnsrcLWGS3FVQB43tOINMS58+S5rOfx50R3+6Td5r9n8EyYi8iOJjYsaskHskYvFwLvnXdtiyxL1Xo4rqt69o+VdvQtLSXfgigUem1Yu9g8iZAqbPt4UmiQmLW5so3mmau6qzsu97BZFUJECDGPlL/xlz/hZX8p2yHweaBwwC2lp3moquXmzEnmdtn6YLBk+ZfDAHYsd12eCyp1gDQKFr67tbTofaBD+iIJOqPfvf8fIUBuITS1l7w/T2MU/N0Mh6ECFOtjhg2ThgWcze6xfQi6NswGQDe+OB+v+x/crt/8YVLOEB1td0d+J8Zyk+HENicyOdDvAeyU8LbAd+lspGQaw4D8O9Pqu92AwD3kxMCGh2XdWUCQPZx+4FaanW3dhPAbS4IvyJP6zMzKrblzjauIAf9oK1KXzDW4d5+7CZSnbsqb1wVeZ/qUSEAZ+YhGo34t79YIfXK7dtB+7HLG3krrDyhmzd+iRVxpkmK133mUFQ9H0CUpJZNzJcdIPMXRr7/+KBzcWX+3/7aWzeurodB76jbbQ+iiucAmGHuG4tVLviHTw5//PHhOJbnm6VUm6SwqT+zHAdjyq4jODE6KzwqLbUhOkN/wglEoX3xGO5NknP23jjxHLfkijiVNvMp0QYgcZJMtw2y3el+71ZGdX/9ldU//u7HHz3eq/icM1crRRlTSmvAL1QOmjW/PQiqvnhlY743ClUS5jT5wnLdavc5yvf7BIBwmX3rvFLZyiYvrdUmsdxuBb2K6Pf7EJ5Hjr95q8sZH99YLL12ce4Xj7sL9RIAZSpBGHJGrJbFGXm4c6hX5q6vL1iGbqHcPnpeOC2WT+9sd3aP+krJxbpLOLNdMIKT+ZrbGcYcxOVZ61CxNApAqOn4u/QMoZCSZ5JKDiLFM3lWTt4tTOfIzm2kFyFRKhkhNc40B01NrtKwcaoqwv5bxPpnNabmyH7YC21k/PNHISKRnDP/xhzf7rc3GsZvDC/tAmXL2S3CyhEL3j9cXpPDC1Vaqgfful493A0vv5hmNWTl/+nHAIJvXafBILzdPYYtwDuY/I4pI8SWmxx9cbnpEPGLMcZoLrrhwcQq+6tErBLRWz/je16s4noHk/Bg4gPezY3KzgP/x5PwrfKovsSrWfR8e6MRvrJaqZQAOJSE7/fkiK0S9sHt9ue+WfmHN5bt+Lrsl1dz/+bjdt3HwfAErj2LtufSefaju/eof/EF66Lxp3XXHvBR3yzvbZ1Oi/zsgns+m2kG35/K2SCapzUGsNsAEvUHK9XRq7V3bsHi+7F8n+h+ig7Q77uJVLs7YvsOqsItce6tnNDf53tlAFFlNvlrqqeLYlOow9nmxZJl9FEKT7DNF0rzvs7B3QpEZ45Ctch+93Z3+47gjWwU3wyynybmp6/Pr8wHOeWpNbzs+0WgKTBxIV0cHkxczv69v3vzN37tJaJ6h0eHrufUfdaiAJCoAOAW1lfmK/Wye/vB3o8+PjzoR3aO9kwh7pmd8YRwqgEmNVVaAjIzYnK4jKcgz9Fdrdo+DtVaw4XwuuPEihhSG0qhlMlirAmhlAhOwtHg/VHguuJ7H2zLJKpXfEa0zTxQSqdSCuHZIwCwkTUL9dLXXl3ZbgXNqt/DQhpMctr+tbdfzbV7i+Otbk9QYpfJ1WXfgu8klvlt+v0+gMgwAB5Rq8sLObLbh2iWnd4wbNZ81xE9QsZhSKaoyjnf2mtfX5/PNx8zlpiiK6bXH0/iIJFSMCoV8hwwq6pXy85okthA/5y/W2OMxffilShU/6a59+ZZVVaaGjxnCy5QLXkqkbvdKCGEc9BUa0FsGx0jxHW5JsYiO02N61NbO51B9qyHSJnRjGGmgOytUWyR/TMCSvvKQvjK6vE691rFNqamg6PJoVjY7jfujMbL3jFvXT6fT3yd/GBLjBiA4P3D0s3l9drB+2MCoF0PcWXdSzpbP4suHSaXYqfZlpbOAwgPJrM/hafG9SMAerPpA8VpUBbf10HbGw292SSATUGYHIrylfngW07w/iEA+eoqNNJul37SYy965eWUb6ufDOXlb1b+4Y25wVAPagKA6ca3tyf9JAlTnc9R7sUG0zDe50R6FYdyNKYumo/pcc/u8t5WUZ3/1NPpB7LMfYa2rw/VOnjDI2hU9ufHuzUOAHc1ADqO4YgfvUiRjr84g8uReVpj85562HcBVFxuS0RhGecMyH4pXA1yZG8MKYCHJwMXrRDf77ukXpkHJuOx3QHwBqzgftgiidLX30jnPN0JkQ/nO0SyuyPOr6XFBMd+333rC+56c/Vpb/eDu2SK7Pz547BzLb4YUGOfm41JyI9vNxaTseYnkF14SCOL7J0gOdwLf+uNK//e/+xNf4Ktp3uu57ieA8D1HLdUKutg3ONRolfmK5fPNR/t9f70rz6887RvJyVJCYcRWxHVUmcJB3gm45OaQhtL2C2CeI6wupBbAPHT7kN7ZYljY6n2wXbPgEscx9MwRiiljGhKCYzRUiUc7eGQUVrxuFMup9JwilSaSGYPnRcYGSG77dH5haqtxFrQbFZ9TGuYljhb/p5DM4D+JPKI8kplC9lFgr/dChqNRr/ft9S+iOz563rt8uKPPjrI9w3KmPF4TBmgtaHUp/T7t3f/8PeQ22B+/qiz3Xovr6m2x+kkiGQaTuI01/dtY0AecxZruJwEjEXSeJxoqVFgixbTi8geS6O1YRT5pzOD79qQxFDKoaVOCPGfi+yjUPYGEQDHGKTQgsSJTpW2yG4Pm3N2S/ZzZLdU/VkqfMnPKqjHnN0Rz5mOcuIbaI5dJUPqmvoKHR+iUgEwWL6AZbRubpD3t3W9KbRxoAmyyF8ryBQHahu32t5o4O5B/2B0aXGhvYBBebnxucP970xWiQhvd72TD51rLxa1j5trXlltA+Ht7ioRlrwfff2S9rxqpRzEaY74lRe9UZwCHm5u2Ln2gsLOGOHb/eZvLfy4pBs3zb/9xY3DvQGA+jAd1MTWXtBPknwY6S97yjl4jvL0kx4AXOX2r3bw3rMSxJ6V/TtTUL1RKtkkfQDvzJUwd3yDP5n3esvpizvm23NlAO+CAPjoXw8AKOfEkrB3FbHBjh80fADow2004vaUAjefJHPcCwzzYm2R3aJ8B9m6G++6c9fT06w5kWpjLYOjrd1kbsW9cZUAKI5d3dpNGw0AtIjs59fSzYvNHT34/u1A9sXGKyeQ/TRtz9Hc3jcn+M+Skgrb6CJbJ8qrin7E7u11L6ws/hf/u2+9dGVh+/4nW4PYPTnvsuazw1Za8ZxXrzRTaf78r+/96P5RECnOwacWQGt3MUoXMX1GluGMJ1LBmOKW33OEK6hl67m5MC+c5vieo/A4kq9dXooUgpT4AgoghhhiGCGEQHCupbTxJhOp40kqHF71fUY1gLJDJgmNZDxT5xSMjKPk/ELdIvvnXnspYyKHA6vq5KfNKxtPDm8VqXeRyOdlW7sMnL6BFYjske0R/vD3vgC896OPDhbqpThJq76QupTEIQBorYRIgvE//j/8v/43f/+Nom/9/v5wOAqECUE4oyQ1Rhuip4JYIpXLhZkyd6M0GK17tD1ObYq69ZKfFgQyRUUaZYyYwvrMe5VnXeXRNzNSz9SyTc6V+F4oe4OcsxsAObL7HsPJqozvs5LPWaGj8vkJYvPzvvWzHyN7IiE+Hdn3Jsmlcwt2NLx1kV/cHfbuB/RaT282aRRpzzOjodlsirk5Gx+G3iFpwrhVyo5r0LyqLDpb7TvjpFcgU2n8hn/DoDB0G4V7AWi908TSBYyG2vP4rX0A7mYz5++YznFlwrHIXkYUAOFbZVPKDK9mNKSA8DxL/C3rv/9AHqzG3/78eYvs2R7lQThOTT54uhcb65DpRKTxq6J8DvTFa4rI/hk1mRzW/8AjAOCVTt/m3W7wgxcijFCdTjx6Z64E4B0gF9zvJqmuuGxJfeIHOUy75+PMJthAoxGjxwGcewCbxLdLY11xATSGtDGs9mt61E1jD+GBj8rEGmOeYpyDr7U57ugBgDdePoa1+z0654V5f2xeQbVk/6vvLAG4e7u7u/MpyD4NB0Y+sOm0pfJ0GFlO3tnl1TJ3yzJNPRec48H+OErV//x3XvsP/slXPR3f+2griNUMslddst+Jh5Poi69fvX1/74//4v3bT4cM4IJTSrXRALRG3eecEaVNUMhlte2PeZ8qpVRpo5V2BYUxriAV3ymJE6EjFqBcTpRBmZMUJF8MsoKtVtfX5rb3u8MEwhK/LKMGglIQxElKCVHaxKluVNyyy2AUYGDMONZBlGptwxCoMSCECUYnsXSJfO3KckWo+bnG/mELwPxcQybRk6Px/f0ho/RzL6zZp3F5fVkm0ZuvXa8I9eRo7LtipxvaLtnPvbBm71WveJtXNrrd7iBIfVdEifRdsbFY+vtfvzk/15ifazx6elh2+d/56hv2Xj+886Q3DAWnQSSVMUanIDauwHiuk6bR9z7Y1YRZG0x3HIejAYMGoSmIMrbtyySp4pQwxkCIy4kdywZjMtsoJakCVcZzqdKwoV1KI9Ym1SbVRsU6ITAacaq0AZ02fGZQUmhSVQouA6ck1iaV2mGUn0xW8BxRLTmdQXI4SYkgXBnDiGEkktpaHouBo/br0eSs5osc2Y1zRmGNJjqhZAbZdzoB56yUD1zVgDXyEn5mjMFuN4qB3765sewYrqRrVPlBN7zd5ZKMKfUuVAAQKZe+uxUqeBfmHRUQlZT+Yld82FGlAVtYpI7Lbu3phLZ/52J5YZ7EI/Fh56NE1gz1ZDpP4C26AAY1hB8PbF9oztnH0Olmc/zWqq42jFaGc9Y7iH7QlUfhud1B+VE/aHiTG35IPLtsENflgvs6GI8SM++ni6uJUhUqvaBT/1c75Uf9KJaoC+15wUY1Zvqe7vy9N5fdUEXaeLaZS+qHR0E/SZ7004UKGccmUvA5AdCN4cVkWQgUukbzVtI8DeZZp25X552ol5snOPvHtEo6x6aRKFD27Jd5UZPpH4w2CN5h9Peqzxva+DfXkZyLJwH5Xz+szPzpgi8u+OKNiltS5kNgS8FU0kvnndSYZuiqPWIcjyROqLXnqdBP+yVvN5HwxQaBk9J6bOx56NJSJ6l5bouqEdekw+vnzGsb88NodPuBBiBK9O+/fQnAo/293hhvbnq28fXxvtaJvHhl/u79kQ2isTEyQVspbf6dv+eulxYH/c6P74XzC2YG2duPXR2BTnd2NrcgTYyNE8hyaQafaY10nOlUIM/Fbi9pDYK/98XNP/r2b+go/fD2I6vAnGEvjc18o3phpdzqDf4vf/4BoawkCBg7y9ZNRvpECS6n7faCVBIg2oAz+J5T1NYTDYeieuoJpDpJcEKfiWJVdoXnCEZSBdhxkpRmDkJfiECwOJbKmP/Jb77U7o8eHAxsa9VhP1QajBGtjFYG1EBrJaOh5Eal5xZL+4ftPx+FzTv7uemwNwqjYEKC8CcfB/iz93Kx20o0f/R/+s83/9N/9s//7L39zujaau3XpwLujP/yj7/7cZykttXIbgt+9ot7uYxubenf/vr1//C/+SCIJKbTLwXnBDY103DmMqYfPj3oVPxS/nMzMjHUoXSSqESqNNXKGME5AO8kqll9xqXGMSbUmoMDJpZmRjfTgmhDJDGMMW3UfEUACFOTTK01xU/WCj40VIzSGdrue07FZdbyaI0xVk/PLY9lhx0bqFJj25pOeGgrZ1dpbR9TyeeX1+YAbB8NdzqBy4nnsM84cHW3G02U/tbbVzeWq90wZe/tXgvC9kYj700lYd/4Das5lG4uw47We/hh9tJ+PAnWhnPL53pvlf0fTypVxwDjUVICzmsO4FLsbN3vXNvu3y/5jc955Mbc/u2u1WFOSO3VGtKECaeMqPOdTl5HtZuA1npzYbuP7X57o1FePpocitJ2vwRM/tHngzitMBO8f5jvFRa2+0ebzZrQvLHwk+6oHPmYGrk7R3LgGDKMAfx4L8z97E2XWLX9tK2+KJ5sXyQfD/pf4I2iLv+sN3ZmGBNF70yFvTgju7FS/aOLNQCjV2u4NQTwx6sTAC82ql/88IT44JQYgKWnZ38r3u0Gn7xsBg0spPrGQ9yrlbofUR9OfUjmImA7BXCp4vYN7zQnujJJKuj3BNpoeCSX6deH6mnNpeO46iEsk1GKF+rcii2NRrr3gL/1evli8/zj3i6A82sVQNuReLs74ptf0WYwPi2YfOV3SuvN1R09uPcksTNRZzg7b0CesrHbwdnPyRE7zfqz3QlYOQomD/YHaytz/9E/+ebVq/OP7u90h6rsAEAcJTm+Fy+XPV11yYMgSbWpuDaQNtuVc5BIGhtv5DnC+bQBnloZSkm95MxMd5wvOfVqCUCcBACiGLYOaUE/Vkg0XIY41ZNYTuK0Xi2pdo8xNnUwQhljE7xKvhdEo821xZsvnHMF+/77D1JD/z8/29IKjOWqNKjWlBGloVW8UHOjKB6GqTMIO0fYP/S9UjkKJrZSyhzeRPrzh0f//M/eKxoQ/8V/+s+s+9BDfGe7s7FY2rwy+3r/+s7+cBSIJPzzHz36O8DmlY2f/eLeTC302mrtyeFgoV7aPugt1kthAsY4YAyIwyAVpFEEcB06iZMSd+wMPzu0L0rSSGopkSotOLMJvcKmfxdELaM0FEkI0cZ2WuPM8eAWu1OpXJfbZQNK1TxmjxAbmnelEULmy05vnPKTDpw5XzCHtQZhGCoujmf1FZEd0xj6xKDsZ6NTc85uq6lnQnwQymrdu9DkJ5FdHIsw4lOQPTTm3/rqi5tN0Q3ThYft8GAiicgSfYcA0P9Z1FzsATj6+iUCr4yIxCP/x8eF0OD9w7m/fa4iiAJKf/pxe6Nhv4ANj/Qjs29SLyL3oZobblhfiXnP3Df7UZrj+3qNHm027Zul0mQivGilbMutVq5pbzTIU/PUulludxe2qRgxGzjMejul5tq4PVzaPgEJlaoDoH/Qbj89+Me/ce7VuWz9fzLH7v3Nwc4wqZ+silhkDwy7exB8qVQ6UxzfrgSTtQTr+OCT0Ru6+vzq6HNA/8wibf9g9GaNv+MRAPU/WK8Dh6vw/uXwxUb1vzbtWyb+cNX99v5x2OO/Rh8tIuLZGt6PXqQ7k3inYcKh9gX98lMGB9eOcD9Rt6IENe9lR1zLt4BD9pOF6oMRekuT3hj9yOTgnlXdlpSCuw60+nEi9fIiwTSMrLTAXruhrCZz2CJA9C8+SoqmmuLUDlt9vfa6/s3LqwDaB52t3fS0nGJl/UQqDjZVYJyiU34mKNg2K83+ItrK4azdd3kDvD+JHuz0v/TSuf/of/G3Hu0Mf/CjT1zHLTtTROalOAryOuoMf798fvGdVzbevbMNSEaI4MwGs0Sp9AQnjI6iJEqtjY9bFChyvfyyxeMc2aueU6+WPGYilSF7btP0HHglJ0rSGDBaxSmMVovNcm8cv7ixcOtxJ++70lrZnBalDCPUE3x93v+rX2wDeOeVjf/mBw/HoSx5ouDGNCBEKyOlalbcvPk+0ZoKEQWJNw4trGcmUUeUgZza5/XM3W5g0rBU9nQcfO/WwXYrKBZLt1vBne3OnG/gezuHnT/+bnrtznEQVW8UWsP71kFv6+l+rB2j0mGUUkJySq0MKzsYxMo6sbQhrUlS97NkmFjqRGqrYgtGGSFaGc/lhGFm3pMnCFIopew8jSzI/tk2R4ezThDHiRaCyVjavlxOMO1+UmEkR1J7nEgYzrPEDNumtNMJdKotW8+NMQA8wbPbg9jN3GKJVUveFNOPHZBnPqUc2WNaPjwaZMguSDaO3JnOaTo9oLzA2f/Q+BtNMaTufHi4sN1HjcqCKm59kDwIbSUTaTKmpMJm36Kd73ywsD3OnfLpb3nYBmykuyO8iKBRATAJ03K56f62D6D/SS+83V2v0YPffZEJR6UJE9nvq/HNTfL+dni7295olG4u+25178/uwjPNa/NmnRz5DfpJb2G7L0ds/GFUujnKKplTst9/Jeut+MWDJ/+Dm8tvv7Kw+1E3d8jYmx0MtaXtB0N9LLgPtPUa3pgGy8wM0JjqyOUZ2j6D5mci+3Nm6fUPRpawZ2/m+wMA1VtDAF/8UH+46t6qx7fq8T8b6n9/UgXwJxfO+D786EX6YX90uBAt9726jzcfsbwA+243uOYwwLk7jq9VvHfmSu92A/alyiuigu8fvAn8lec/SFFE9oZH7q2ZrqT16Y8lBXv93MVcFWk04vXmxce9XZvhvrWb5NkDl847875z78mJSvXCxfj3v3wdwNPe7u0HJ/iu5e/27o1GfH6Nnl8rAa4NmTnxjd0Rdp2wbGzSmLX0AHHQ5raiIPtgiVTzJfJ//F/93v7ReG9/Z6Hmp4qmijr2G0wFdKqk4vyE6hJHCees5qqbm8uvXVpem6ukoEEQBYmSNpK05NQ9BmAUSW20nmb9ktm5T9AaSutyyVEGHiPzNWe+6rsuDdNjZLfraJgqozVnTFInVUoZYrTyXLFcddvDyZvXlkeTUWuUcsoMQM30AYxRMFrLKEweHw2etoZlR/zo3o402ZygrOpICAFSqXyP1V2SGKqQZbSWHKYMJKGpRqJMnOowVSZNY22M1tCKUaRpSuM+mGiWxVzVX627bqlcYlGUkoNemJ+jRNZ84Xme53kONRro9/r9UEaTSbs3iKJoFIT9SRSH8UQamcac0tEkFFMBmwBaSmXguTxVWZompXQcSiGYUXoc6ThRUhs7LU9p7QjCGaFWZy+M1OCaRDBhqkEIZ8dJ+meOx5DSSKVhCOc0Mz4ZkmqjjFbazhyEBkaJkRoOJVqbCqU1XwDY60cW2QEYdgLZOT/OF9bAvF9A9kRanT3n7DOae5Gz73XD1iDklHiOyMIsCQWmUnt+jZFiuq3Lkf0N4kYXjahU2f2Rs5NS1+iE6oRS15QT3vbUYglyxGKm9XIVgDHEZWYQqNIg2yaXBlF+ub3RiJZc/tr14ShYHyd3o3SZsyxW9yjUj9vqghDlKvVLarHkQo3fWqV+KUP2oydGEyupexfmbbucOFeZ9MfehYq3OafONwnh2vNQF6FCJQyDhhdXHdI5fgLUNaVBJD7sPN4OUI3/3d+5JIeKk7QOU4d5EurDbjSMlZwSKcvZreBOiDEBAETKWNn9PlXLQlhZPG6aHZUM74jXRr4te240/By18/zeM3X5M5G9uehGgUJ//O+u1YrXu4exe3h8+zfGzp7Qh57aQvKXVXpYTX5aDZYXzSQgD8MonCdvjJ0/uZD+hegfeqpSxuqo9G/tehcKst4FXzwJ03lGX3D4T4ZSaQXgSxOeLLvXhvqCL8ihqoxmF+xWDaEmkTDXWvqIaH9J3Hy5tqMHj59M0sRcOu9cXWkCGEaju0/i1pFjeXejEX/pFb8Txlv7qpj8/vf/7mKNeADe+6TzyUNm1XYAZY9aPj6/YNYWRbPGyh49aEUHe9Hjp7xW0ye7OKXnqQRclChJaIITuZWW1CsqqIdGI07AuY7S9fXmlctXf/qzX4CIScIA5Mzd5RLciaMEwCSiHJHw6/3BeK7mVF0CoFFjFY++cW3l5gvn2r3RvSfdg0Hy0fbhTGrjczqYOEcU6tEkeWGt4joljxkAk8gAcJ3SDHNPtUmjRLh+mROjEOuMkCYaf3n74OWNlZ3247GUlDKL7Cqr7uos4YAzwujdx0dBquzgVovs+rh4a8o8m1VPCDFKu4LEJ0fHWfEiNASpjoHxse5EgOzZDgpSWGQY0gii4H9LIwCjUCZaE8qceDIuNEnaMC8HMKCOkJFDwzgtuTx3d0oDoVXdZaNEUhBKwDk6wxiE2Lk8ObILwThj2kARwpQu2o3swFJtIFiWpfOspiQb9GiTMnPZ7Ix4GUMAwzkkTJnTat1TiXw6igFg6mucQfYTzSMltzp1wqiCXG6lmJkmJovsy/P1GDjsDFqDMNuLFC0x9nJ6PGwvJ+/7oyTUGbLvm9T1GzSKzDrh28qKIXLEsr6hxIZwNcw6sd2e2vMm8Mo3l3FSCQnfKpu1Nd99nl7hRcTfivRmRG7t082mublBAIvslqqvkqE1RE42m1ZpaQOYmiNpFOX/6s3m0WazUnXGzxhb2D8Y/dpvLAP4+ElvANQBMuc+2R7kDhkAMXeYViqVU8EdF89xdfS87uLGkOZ5kTOQnf83J/LPn3zda8Xoj/9gujMYvVrLCfvM6dv75X821FgHEN6aDkfd2h0C+H8f6IPyiMrsIFe3a//giRi9Wps5jmXrAN6s8TyrIL/NO3MldINiR2s/MgCMND2BpzW2NkzZRd8qKlYVeemLwgrunTAuauvFHMfcv/jNr2hrh3/a27VtsZOxPkKWcbZU58VR13lwWN6UdKbhvQ93qs8chyXYTzXvaaJakP4o/enPfvGlX/81xngQTqRKLMRbhh5La5XjvUF/ECpqwka94np1AAmpPdpJtg9GD/b7dx8ddCfpxmL1G6+tvLBW4VSL6X6fM27PFtmtl86iSSKzYBkAdd+3yB4pUuTsUYz+KJ1Ik2gY6gpKkEaeI6zlI9GIkrTMydP99vufHFRc5lAznRtvs2iyhC9CiXVVdoJEq5OTr42hgK0TTKSOUmNjEW3/i1Fp3t9YDFD0bQTNKQfGKEpGUdIJErsgIY1SbdI4PD5roxIJIx2iBaYzngr+/ewaI2NNKi6nWeW5ACWpoYKdq3vWoM1BGGNWivEEtzKX67qCc3OyRGamEA9gEst8xqkdcHga2SeJUkpVPe5x8vzeVIfA4wRAmdPFuj+OVYbsx/Q/a1MqeeJMZM8xnTncnnMdzGL6DLJjBtnTQj/tM4yPgZT7o6Qfpl+rVCyyH78zfiP65kreDsqr6n6i+pGJVsp6s2n8hkV260G0najWm5hXPm3wQKZ6v+gBYJRYmMi+yZ6xfvDGndHSd7dw9MRaG81ouLDdz/tgG3dG9JNefnCbInDm6VnInp/u3mkDqAMD4NGdXj9Jijp7u6Q/5MPHeyfeq5kW0NtBYDHa1vaf5Vw8XYN9PrIDyJF99Gqt/gfrF77+8oWvv2wh/vRptVPJWz1t3dIOltOVyW6NPzWht+19ZXfFIvuZR7BeSSu5/GQoZ1pYZwHUI+ceYN4zzRTxIgZrzua1qAiv683zueBeDIN86YLTCePDFrESSr/vvvGyef3cZYvs954kef7XzCNu7Sbbd8TeA24LqmcOXD0T6GduVq5Qe2W5Qrk2pDNJ/pP/+i+5V/pbX//Ck8d7o8i0D48GoUriwHFLnMWu4wXjwHW9xYYDgJoQcCRrxEHvyUEHgEvhek6sEWscjtLdXmK35InOxnsmJuN6HIQLJjjxXAHgsB+mqWKEBKkahGHd95mgcTiZqaOm2ljDO9FxCsSpHscq0Vk8S2eSzJedqs/boyhKZb3kxKkaS1JUfzjjRYDTAAW0MnpK0o9xM1IxUYxpjxOXkyxlpVCXy6YIURKa57U+Zj59HUV4BhWamq9nQncBxEpJBc6ItbWUPBZEijNAKetKosQMJvH8YnW+aoZhSly3KehgEo+CaW+LEIxCaTAKAyKNAaE2St4WMHvjNNVGcHq6fHq86YgloaxW4gAiKZ8zBDAXzSsuX6i4oyDqDSUKraFZGYAS12V5TdXey+WkxJDj+DFnf4bdZXGxutzwAbN9NMyQ3VZQxVnvsJBFwX0Q6n6Y2obG/alIRT/plW4uD1NqDo8sslvlGq0YB8cCvPa8+uGTUX1pImplRDQY5AYVXlXJ2hoAXq7JydDGzjyLrl4LQlsOXXy3d/T1BqnW7ABu+7jHjpevX7LcfFLI/1r67pYVf6wt0i42lZvL4XJarPG2Nxq43Z6vsOsXmtF4BGAw1Lcm8f1OBMDP6ciRvnTNGY0cIJPgHwzOQG17gTbcM5H9Rqn02eX14mH/z1NkX7tZp3NrAEqFGZm2NDpKk8OIeUaFqc5b+ZcQTcaa9I1pEAB3dqJGI37daXZLve8uV84x+fIHzwPuaw67D3U/Ue98GnSqIza/pDqRnvfMenPNQvlkrL/wurjYPJ+9hQMJCOsr33yhZlWAo4GUfbHX5ueuxt947bpdBu49SbZ2E9l385bU/Ai7O0L2XVunlf0zIPu08Sbj7wXmfvpmnBKTSvPwYPK//A//y9eurXzt5rWXN9cv3twoV+aePN47avWH46DX74OIkl+OJXe5tLRda90dKpcb+52KNYgJHFbKfBQKolI28UTCeJx7DC5jeRJ6FKejSSINHALqUJuv+9MH/ZVGtFD1rDVz5mS1EWuSOeGMlEZpbfHdFbQ9lokyi1UX0MPE6gkEACcgjGY2ScBorZHPx8iTyyEYJZQqqdJURunx8CNPEs+V7tTuSSjxibHgTqUq1HtFlKT5MzzTVZ1oeFppzjDN0LckvSgdGKU1iFEmuyyNUiqRxDlZ+XjcGr92eWkwCuyjO1U3iBQAz82sNXnwsAFJDYhSdZeVGHa70VAqwehzwHoSy7LL7QD0s21O5pj12z3ZvM9KnLXH8ThWJ5D9ZH5vvhJYZCeMBlJWC8iuEpkD/QzElyv+csO3tOAY2Z/TqUQ4EmlNB4Mg6YepJ7iVhnKzo/UOsmptVF9aqm5ZnF3Y7vdKfmOlSt6qD6nrcuLf2hd3oqXqVvCt68atagA4yMHUd6skHqmHO1WR9XxXJ/55LXepXNHO80GkMiXUeUCYpe2kWptMu5PgeRbKp+ZIAoCioT0vFhV/rgpMivC69mX/7VcW5FDZJJm+1E6JoWNFdm3tj4hVClRfSPCAW2QfdbMhdngGPPZr+vbw08N4P/X0remGcuE6BVDy0yAU7bs/r04dkLdMjBKOBhL2RftYAi9GtRBG643ImkaW6s4Ak1vALcSXDmp/sxpXhdNwHLvg5Zz9BL4n6t1uYP/07klNJifvGKq9JQC49psUgBmM7UNbJv64t9s+6NhMMduDeq2p7cZiMh5Gqa4sst/55oJFduuQ6fdd27WUd49u7SZ7D7jDTwSE9ftuuZKeqLhCntmJmk/Etvg+M2+PA+AMqTSGkXfvHfzNvf3Fur88X//85sorl1fPrc5dvzRPPdFpRwCO9vf2+5LzZLHhTCL64dbBcRmEAijFGi7Fq5fn3713EMvhlfNLhPWiOAUwSZQ0kErazkl63KdEHM7KLlNa9kN5NBrYcT+eyzzBXUGLkrfRRkzDrVKZxRVQgjA1nUniuYIzHkvs9tN5ny6W2SjWiTZKacs6BYxDMSy4M2nBKgNjhMMpMRKMAUYpbZBqo42KUsOibEoU53A4izl1iAbhM7zcc8Q4jqxo4zk+tLJ+fzt3ItXG0ypfq6yAQJgwmh+LCUbG0khomZqEEKWUNlDG6FhacLf8moIMgqRUKn1+c+W/+su7VZ8LSkoei1Jt0dzSduuzsS/PF8TWEodSCUoYpcocJzIWUXuSyLmy8BwRJYmezt2ekWWKlzlIveSUGLphOjk5+i5H9qKZPdvDcWZtPDFoUavOkT3TZPJhYwVkf9was+dw9lMmGYvsNc4oJ9H0hzNVQkDCPqo17XkWVRe2+0+Hurnh9i95dgXy7+wXAwasCDP5R5+vPflI/WBcedFTQPD+YeNOdPhKdflLFfWD8agcYghV2JN5Ecn39naeBqnWzGjo/3iSR4PJEds3adSKGzdrKk3cUsk9euj8+chmD7Q3Go07IwDkqem14uZij9w8kQPKvlQZb1zrv/ezt68te9WF9t4DAIOaQDcuSWZ7UJvucSk1HfhrV4OdgUArHXWf1xlQ7qpg0yNc4+QYjTPJ+6d0nyb6nanUHv9JH/8A0cej9sc6R/bDiL0KF8DmXc+2m36Hph95ZO56aptCD1v8qJLkknQ68Eut9FyF1X1s3k0AgoJId6YCc81hPxnK+8nomvO8GsO5B8BVs95csw73yVgXVXVri7S0/QuvC1KvtA86uzuq33fTNP03/w3XSu1mMLYOmTdeNqJayR3rH9wl/YNZZLfx8cWsGLui5FGUBcPlbJNqnpGQjRyxPhFCKSHaepMPBvFOZ/8nd3epoI2Ku7bgXVldevnK8uaVjRdvXO60oyhMwziZhF1k2WGwhD3TAaPk2ur8XmvSCZKdw84wSrUhFtMBUAJKDC2U5hzOfEFSqSiIw+ELboyRClGshpHKxXGPE8qpwwhl3KGI0uOcdws0sTRSKwNCkGpN9oem6dFG1QNwmBr+7E9QGUMIoYwoBYfA90QqjZRKciYlhNXidaYOpVoySUIoAJQSRhXncEIpYDxBCsVVhIboKBGU5S7PVBtL80OT29KpMQZaGqVtDxFNpZ0tZwH9+EdLbIlCWXy3Q6nKvvOTDx9//Y13Fuv+KEoEJS6n0XTZsLzcau6M6KpAYsjhMI6kYoQQxjRACCkG+XKQxCCO5WLddZkt2NIsEoBxqBPCvy2Pa0McgtWqozk7HMXJM5DddehMcpzLCWAT22CULrL10xCvEllE9qetIWfUZeKMCupJyctCv0X2is/zqeXm5WofZRvbwqvK+A2dJrZQafVuH2hfWdDhYGkvla8eC+tyxMajpOwiiFMu+PDCC5NSp9ycn7Q7S9t9VFFeTscpJhuNhe1+wyNPouNo+Kw3veR7BxP/xlzp5rJxhU1tzLV7u5loLroGsObI4BE6Jl0diaXvbuVCvA2oCQ8m7mZTVmt90eQbUeVFTzXX7ALamHOjUXusyn05QDeecbUfj+M40t01X9TD4MgFngfuwSQGeLgaGOlb8n5abc+vORPu87/+wcqJsnP8J30A+VUvNqrfzluW5gDgHeBaN/hTaXTdAOawRbZ2EwtqWU3yqfzyEX9HltBHMX+m2NZ0prDej8x9qOco7/3IvLReKfjZ8dIFx9L2p73do4G0wGrtj2YwtrcZt/Rvfp1bXd5K7XmttYjs3QPlnSw+ZdExlfTMUmqO7DMie/GyDTizjkmeSEhNGSkiCSinnDMN0x/H7XH088f9P/vR/br/w8VGdXV54aW12rW1hZVzayvn1sLRoNUbDQaj/iTN438BXFxtdh4euoJ6WiSJFI6rtNRSy9OZsUrl0CsVAEMoIxSeC2oYAK2U1CTRUobKGM2otBNWZ5R0bYhWShV6arqhmshgsV7y+HTY/FmyMTvp/nM5c6hJONFSxTAShoNmQ0WUMVrDGG1ACbQ2gIak0kJ2aBKiKCNpqnLz/hlridb2r0qndtegn1GktE+MUmKdKlJCK0NFYWwWEIzT736w47lo9eOhobHUWhlwG9FAABAYTiA4jVLVDWKb4sKmbzgtNBxwkEAaJdXaXAmAteIUeXpyEp0tDfcEXay6kOqwF85YocLomcnsuRE+n6IVhLJUAPRicbWI7NtHw4NBzAD3rI7oE5ie65UpschefPJElNjNKza2pb3R0J6X6uNBdO0rC1xwpNJxWa81xn/7uPE5b6vlXDpMrEZPqg7gOZRM2p28b8jWY3VzDUBlbsda3UnNa240Z1o6w4NJ3nEa3u42pqVUXlX+xpzebPoL84k2MpUOJeFUsZEjlu8e8h6oXthHtQbA3NwYAWXbQOu7c8oD0GWRVdFlVwdcAbhahy/Y3jhDtBJR6UiKqrdVGjrTlpl17j6V8Tqf1UbTUbRU59sHaHxaTRXPHqX0rWdEw0bfqNVrNP6T/kwzal4O/WR1sr1fNk+TJUDEHABCpHV5oorwy5yuOewn0ae0MYcvk8rnT2gypJ4FHuQ+mXKFWsTvhPHRQE3G+vob+MZr1+ySYK88XT4dt4RF9lxrzYV465mZ6VHKxRnL2YvTRU53QmW/MiVVmiTc43ZERj4W3KZiUk49EAZNGI01HrfGj1qjv/65djlZrPuXzzdevLB8frG2ujS/CoyDaDSe9CcpgI3F6kfbRxNpqi4dgWslOaeGEZvtbrn8tLPJFjyzh7ZFPwAJjKUSlMARjMFRLuwkVamJ1lJKEycJoZQCnIMxQWDsMSkxoIRRKjU57IcAGmU3r4XmU+d1AeAKOw+pp4mTYBRK5quRw4Ep0Gtl2BSsLY7bMCyPs6EySiobxVhYe0BJtl9Rxmht8ll9BQAFCLGvyMpWMxVOfXr2rCBbBz2kaSdUDoeWWmldhHX7zRlFqYVawSgIMVqT6UxuOzyJckwSBWBzsRSoWWTXMBSZ4m+vlwZQsuLyesmJU90exzPCjs17mEF2S945Zwy66N6x1kwU8L2I8vPzft3PkH1vEDmMZJydfPpwn0lKeuO4cdbc1DgI8OrqwaurAIrInj3VVHLBEQP9sReR6DsTeMZ2DFqNnlQ9C/S2tmncqpr6ICmjulQHDryIwEG7Hs4tn6tvgn7SC293/RtzkWcykn67a6V//8ZceTntH4rSzWUABnAocVwR/vDBwnZfEiFH2DcphlglJyZ02z0HjSIF1MTxzBBrlbn25Te6v3jUZRHmcO9vBkXOnkcOjD5yrv56eOm889EuqRa8PTP4ro4YrkpR9fyVcT/18wDFz2ihyZaNoXrn4hlultGrtYUatRfOdEP+x40JQryz6H39wYkl50+C9H4n2ovVTy6zd/rPfD65FfI0N7+bpC87Z/cx9yOzUmOrtG6B20KqVVpyIt/vu194XecqjQXc3//ytYwlHHSsc+b8WprPdz0ayL0HPP9p25bUN142VkfZ2k3aj93TPUq5OHNmoXXm+kYj7sPlyph+mE4SVfYdj2dYIBUpTsVUyDbughOAGEakwt4g2uns/c29fU+Qaslbnq+vzVcWat58I+sS/srnrnz3pw8SDVdQDRYrRQjJBS5JOAD706eMG63s9t8ie7a0IHsaWilMhWbGmGAAHOXCzvVOpJLSxElsGbEG+BQZCWEAUimP88opwXQIeP5+FAoA0DZHgbFEKivon+n/s9NTLbk8QUCkdDg043oaJW/tOnaqlLUeUlgd6Fj3p4yccq2YovrBQcDNmaXNNA4TDT5NZJuB9ShWk0RpbWy5GNkOZvaXGUZKcHap6QZSDpIzdzgZrGerr1JVT8yXnVEoO8Fpy2MKoOSJ/K3LX0UR2WcMmhFM6WRB1SL7XK2sUm05u4DxhDgxeYOcKFcUD2u9MZWzgiT1g/7Kg0HrnaZqrhTbGNrjsWjFc5tqSF0ANeEPpi5GLyIgyIGVCz5pdyhQXphPtHEoIfHIJqoDKC+nANZr9CcwR71gYZCtAatE8O0+rs3vTxUhQPkbc6Wby5GolNbGmGYY+G9fDX/4oHFnlAv9M1OZrApvQ2nyWiuACbyQ8E+2egtX/XplblRvYRwBcEqsExHA9GKVQ/zjPWkNpsuL5ui67N4RVWUAVOfE3kDOQLx4wOe+GKZ1foTw8UP/YvRL8+XGSvWz3GwG4t/tBvVVfHu/jP7sL/EfPBGA+I8bk73xcYH0s2gyOXm/m6R3k/S85jPZAwCe1lj5hsmhfOqHgSXyudMxz/i1Ko0NfQTw871H1o/faGCp7uS32b4jAOVwZhtNz12Vl87TnNHbhJnnY3d+ZX4Du6jk8TLZFKf/7T946wd3Ht15PBhN4r7JOhspIw5nnIBBKxAGbRQIo6ZARSkI5UwBscZkEB8Mju48OvAcUfV5oyrqvr/QqF5dqQ/CMIoRJWky0ek0M5szcAZCiD2gQ2FAwY9vYGE9h3jk6VSUGa0skQRlNr+EC6ZdlgM9lElTpbWhlBAqKaWcESqYRRA7GWpmS58XeG0VdxxJ+0RmIsvtNQ7PxnznUwNz18dJKT97qjNc24CQs+YOFm9mL+dJYQ4Ayh0t80bf3BPJcdxjZd8uQqgrHK1VFCeRNEopRQixE1zJCVjV0+UtSmXDF8tNvzuKJlJzxq3GRTm1gE5PbqU1jO/x+bLTmSSjKD1tZrfI7hDI6at7DrLPxPQ/C9n3BpGA8RwxK2M9g8JHqRlFckaNsZ8UI4SOY1Q88tSgCQBuEg1+cABgadHtASTsV5ortl0IjUrUH2M6h9rq4/STHr4wZ2m7Rfbcx5I9zPasO7C+Cb3ZtH/Wm83ofgdxlhbAvnBlkspyOo5FRe4+6gz1+nY/uDnK+6qKbnqcHMyEqTSPqV2GCx5O4geh3lTNwbib3+yF87V3H4w7EZn3TE7eH08p50sXnKV6MrkY46HTnzZGznjeA8PmplVKU8Zj6IaD51P4WTANwjMjfKu3hrieQVr9D9abc2v65s7g//Y0593v7D/vsH/ULz8L2T/1dF7zXSp3qdxNUKTw/cisvwCrm7cPOlZasXOXcgWm0dDLiyK/BsBX31nK+5UOW+RoMC52NlnXo62cFZDdKXYwFWdhFy0xZ1e5CyZI66w/QUBfubx6abV2/0l3HCUP9of3nrSkpqlSkzCBMSCk7DBwVsTi4lY9B2uLybFS8Vi1BiEwJKxVLzlVz/FK5XrVLM9jMApGURLFKlYqUSb/UhhmCCUOqGGqOJMvM2nAUBBCmdLS8voMyKbx4doQKEUZ00o5nOUZ9baKm6aSiucVxG20llVOpk1JHECUYhzLGULNGafE+I7LiMrG1ltInVJvqQobnlyAQpaamQ3MO9mpK08tAJgS8NwYA63kzG2UopwmMDOLijF6FIZpqhTAjFGEMEKoYMYYfYKGZ/iepFIwWiq5rVGcSM1Bco+mLdvOfNZKy6rDPTfLAitaHvM2JZvMLosLGOOWK5x+mccB/YUXciay+55jVArCn+l6tH0DTIRR0h6nvscssutU06ksSzmjJLWRjVZgEZ43+MGBdzCJPNPrjwFE35l4fxuquUKjyE7Cs8hu55c27owWtvut9UcEEHNzDiWUKG3O/o7R8fFsNu158Sur1iNb/+2r+/+Ph/6NOXNzQ6bSMm6k0swv+zdMG2CigiWv9a0L5P3thUI3bF7Xnf2dI7IHsUdLAlVhE/r48XyNHY5hW5leXGTvPtVFkfriOd6V5Gggv9G81AkfHQ3o5EqyZ/UZRloMi2pWn3npgpPe9rEyAtAZ635S/owU/lmaTLZn+lgDWLtZr1+/oaKALd7AHyDH9089/WrIbpWZ3WmtsEjh967i2lsnaPul885aFjZzrMBYFd6WUr9yo5Qje66/F901uzsiaGcctLRg08GcHPTzeqm9DYBEwuFoNFD0Oz4b5WfHiTAG/Wh/IJXxffeV9XqzUmqW2IX58sJcY6HMhcOiWHYnyTiSYawMsdmChFIwSiwaagNtQClIfqLZ9n8UyV6QDMaT4ThK05QzVq/Vlhp+vVqpOsQTBIRoozWgtLGuFUbAKAHhttBIQJQhIIYYYy/YUgBypKKcUEoo1cpaZQoLFyOcEcE5o9R3GIyBAed0HKSpBs3yCQzJu1mN4ZyVXa4JCcM4TrUVOrQhBsRyds44JZRTTQhhlHDOGQGnJG+DovTYCGStn1Z3glIwhoJQxjFNvT/GJZLZWigx+WVjNCHM2OeALPk3q9NSCmOMNhooewJAFEvbDJVKLaXWVpAihDPGGcsrDRQgU4+RMiaVyhO84vPEtjlRKo3t8LKbCU2O6w/E1hBqnvAc1h9FYaj0yTalRCpBiePy/GOwqf0W2a02pUANiAGhp4IoKKMaJI1lEsuVlXIR2SlISWD6oWugGBrDs8uEglDCWBglh6Ok7ot8QcqXXpcTV2OUqjeMOO/S+yXf2VwAkGz1+TjlkkiOu0l6zrDVwzjYqAJoucrsjrkkACpfrqmLq4lJgoZHhtCbTb9cYr0d///5QK9pksb9lJcGUfhWWexmDHcUQS6R6n5SAtHLVRFHzoctejjGxWWhEr3ZJK5L3t82VSoqZa01oZxvLOjlmtaaC64G/eb/t0VdA0AnNLfDU9d0N+u4uGypuq+D0p9+PAhU6dKi4Gyn0/N19OaFmkwSp+rd3x7tPRzplFFD77TjEkd1Gq69VqetkETl1IjBYYscdSQAXlNqTk36LAxVnVEAu0RHSpavOKGSi3VWP3LTenp5nQjG41KilPDCT59luNGsvMGfeTP3MK592Z+/8XkARqaUC1Gp7nW7xZyZX+30JHze+NyuMq3CxnFEtJPSh1qeXxdXXjkP4NH+3ta+ah05X/utuVfnrvSj0dPebmug+iO1tig2FlziOffuj5cXzfWljayI2h/ZN7NcoWXvWHLp7hCHM6VNaYG98bK5vE4mAZk2MSEaqzQwaVDogXeYO0c9T6WJ2bkv/KrKk2RsibXs0Ums7eXUmNHwxJLPy64AMInTdn/0RFAAkSIA6o6eK5dfLi8t1LxxlOz3RnutyaPWqDvtKfcEL3nMYSRn9PbfIsF3GDFKS0WkUqNEApHDxta9XvWcRqOxzOwsniCKkZN6qaAhHUakgobhJIOjY5FESxQ4+7Hcgcyvjul4oKIj+8R23mQLgS1p6qnVfTBO7HbJMj7KqU+5pauMck41TnLPfCeBLHkMxphp3cKOriPHy2hBTHc401JbsUIWnvBpK5E1gBJCDGdJpE6sywBXyrpNClcet5JyISjJ4s/s09Mm2zAprbU2DV9QTotvlLU8gjGu1Em9RVFO62XXoWiN4iDSXBw/2zyHUohTg3OnyG6LN8/5mWmpbF/v4mI1R/Zp1uMpeR0nu5YIB1Bi6IbJ4Shp+MLOHpkRZAijdvjL0xq7tNGobzYRRfSTnjedZepFBBQH0Oug1npIryw0r6X9S15N+JHjxYlxX1mNJ73GVrT03a32Rm95TSqgPBqPUwOI4FvXJ/CAB3nLqH/XwCO9VkwSUwMWtvv3S359NFSvrtYPn/jf3ZIjxrf7rXf65KlZ2O63NxqYutdt4mPWMQs0poOc8ixJGkUpoD7plYCF7X64/CGZqzbK7qAzeWLF+r1RY861hHN+rvx0Mv6wpWzk74ctFaYkUmQy1rcf4MZVtrwo8szC8ityd0e0+mZRwQrxPYyWwF8ZLF743RvfefyXnTAWVW8J0RECoDQ8Sk4bbD6LJnNCbW/1qotN5pUABKO4ems4erW2cJ3mLvhf9vT8mIEzT7tUds+J618vWw5uWfMbL5s1Wrfp7ZaV24QZ621fXsw6m2y/Uq6/522otlkp5+xvvGxsQs7RYGyRPSls+R3OctndqjRBW812j4/1ESTOmsGdCzs8SWIAZddNZDIp5mAoAmUm0bjdHy00qtdW51+/vOK5ThQn24ejh/tHDw8m7UFkHdyO4BWPuZw6lCZ6duttzTY5zI0jOYxMaxRTjB2HV11a9RzPRb3amHLAAKy8c9iJIKNYa8AwzogG5VQr/YxBrBbTc2Q/qxJIikp30ehiUZ5yGkRpGClKEFjmmyghtCcoBWFEAYRQZmuz+fhWo02idSpNUV7PBoGa2RkmuXBPQcApt/g+xdMTqy7JxS5IBSmlDfACx8yNi2oGJdNFi3NKDJkiuzHGphHY4m0cSwDrC+UolVF8fLRsscwPPl2QtNQuJ42qC+CwFyYG1gOTIfvUzJ4jew76RWSftYSCnlZpoiRdrPvLDT/n7C4nlLMoVc+cc201dyNLnHfDNEd2i+Y5vueTnhJOtQG92pAvrgKgUdS73/EKurxVbH4ylG8QF8AcUxbZh9SFNDUdD/71AfrjMCKSiMadkdpW7EuVcWomh6K8nBqgjGhyKCYbjfJyiu9NO/r742TYQaUiR6y54UrPo1FUbF9q/sUQgAQLb3fdzebpSBn2hSt8+/2iIMNv7S+czC/zfzwBJhvvNH84Vv2pvf03v/jCzz7eMt24wenffmn54L39QQiL773Y7A6ltfnM++568/y8v/v920EOE5SXR21pwX2pzpcXTfPlSy9cWh7Rt/7z7787HXKHcDWQxEfnvxPFjv+k3371rk0j0N2dnfcHVcAiO6bJYnhGuNiZsP6pWs3pxlQA2x7Ov5Ku0bo1MlpXzMs35mxSmB2qZydyWGTvRr4Nasc0Wcze5TSy5+XT5UVjFflcqCnC+ozI3mjEgAugXNE5ms+4aIr9q8dWSMc5sdh6zFjmXkT5nc54pzOOk8CWSVfmKzc3Fx1HDEP15HDw5LBze7v35HBkvX2+xyouP05rmUJPTjA5O+azWsnWyAI9EXziuaLMyfJ8/cWN+StL5d5kMonMYBR0gmQcqlSpLLyVGAv0yDH0FDgeI6zUOUzO1uKsMpPNFWEAtOCW0hJj9NSzKCWjBNZczyEppy6nLmVlTrySV8/Ss08OFUnSiczCAyz6OzazHsSuDbbJ1vDsc00J0zg2iQKQgE6JTb+ZPvnpUnTylRo7pPCEvsEYpXYvQmwsGiFSWZslgih1OD+/UIritIjsxTptth9S1rkEl5NG1Us0eoNQwlByDN+nkT1/5x3O6MnyDIPOyXuO7BblFaiUam2+tDxfjxQOO4O8ghoX9xAnqXrO5QkT3TBpj9OKzy2yZ2uezLY+rjIxI64yENOifRRZXlzsMLKOjttBQMdxwyE2j7EmfAA1HXcVow+Pw9OP0wJ2MgU/uHk984/fXCY7O6P6UmNF3z3qNSC8iOAXY7qY7pvUWyf5o88US3lVrY5E/5OeuVmTqawsp7amqjebJpWtd5p2DbBF1Blkz/Blo1G/dJVt9bbbScVjlyssGrVfOlfdHab1Gq2DfvVC/U/v9+s+m2GCnTD+9cs2MuV+bqxGJQT8Udu2AZtu5D/u7TZErTtKiy05APyV8FMtkp96qt4aDm4NR69mke6jV2vRUJ/20nxGiP/stF1pY3NKtj1U58TLN6q5JeZoIItqu203Pb+mFlaWrNPxG69lyP60t9uNfABHg/EMsmtDPEE3XkmX6o6oeoet6IO7JGjTvDJXWaSNRnxmH1kO1rml8swogtNhZLw3mcxA+cwtLNx7zHi+b4H+4f6RRXkAK/OVr9289o++Vp0E8f2d9k8/Obj3pHXUj2xPVC7dzBDM4sn+1SidShrLuCf1487k/U/2GxV3oerVq6Vzi+WLvJnIpDtBfxKNx5NxJGWSJIQzSggMzXwgBeKMYytnYo6ngFvynudQ5qkyQmSd8XbAd86vtSFKwxijtFYahFIJ4zKaSqNlEkZQiHl3bJtmXUGtz9JzBKbBYaA00XAVyZeWFEQrKRVs65OtpspCGZkQorWGMYRSQgiMoVnDD5mF4MIu5JjfUaqNMYVcTMvcOWNK6yBKS55YbvhhlMwie2HZoJxqqe2/nst8z4miuBOqGfi23nlHcM6Otyz23XM4s8Ja0WxzpixjUZ5Br6zMLdfcOAlag6Q1ii2y240gnTY9nUD2KdwTJsaR7I3TqsfzCVCEEC2V/YK5ygCw/yYmj8KEHXkRzv5KxjcaFZRK6WsVXTke0Rk73sKd/fB2F56xNsccjnOQrR7uDi+8YJ3mZm2Nvn/YPxjZFx15Bv0xFl33712JHM+/s1+0ORZRft+kvqX/8PSVF0N8ODkUdlQIW7rQ/dYQgBBcvffw9Jv5dKjdzSbnvDS/eHf76JWFCrkwB6C8tOoNve0nOwPg0rnSW9MQseLpsEVs42UOTPbC1ngStR27uUlH0b/8xdbTC7vWPZnPgM7QY33WIpkXY80wQs3/7BD/rOutS/JZ0Y+/FKxb2m7dkB9WaVWZESMRzOe+mqxNve1F2p43JQH4yo2SRfaXb2QdsfZPcx6K70nO2deupZfOO9apYUfx2ZFJVo2ZIvunn55VVj2zoMpXm9Wdo4FNZPTYGfhukT0HegCe7wNo90cAdjrjH9x5VPf9taX6xkrzn/4PXx/FZr8dHHbHP7i3b4HetucIh1t7ZTEJwKicytmRPkSCcYAzDKO0H0rsDyinniPmfNaoio2mz5Y8AJPIHA7j8XgySUzO6I/xpbh4EDgOzy0ZNtUrV2M4y5STGb9KMaLLljct/iopwygNCWznlMMJQJJEBgZyLIsHkcrM5E2e9LSYXKYHCsYhQhgFozRPrMw9i8rWCU5K4fwZ/X6EEGOUBiNGAZQQoqSMUlnx+ULFHUxibQjlVEt15vBbC/RaKt/jNV8Mw3QUzUjwSGXWgHqiS8AQSozHed6V9kyuBGr1OvvRrC/W6lU3VmS3l/TGiUuOkf0M2n7CSSmiVPbGcdXjlNNYaqut27fOc5l7Mt7ZztjyfS92vPZGY2G7vzoSxexfLyI4mEQr5YVKJXa8vLkpv+BF5AAaDmZ4N6+qcXrisRa2+72CGQPA0TlRdTwA1uZ42vSSWyf1KCFVL4hTrF1Vy4n1ZSqAVWsA4iBY2e7nGZb5HVcJ63/SawOvLFfevXVU98fnHvg4V33yoHfwZMcqRANgrez+eC9UR4wtqSg1Yd9tNOKt3eRfYmt50SwvnkCocoXiYjJ86h0Npu/Sk6wLP18DcqFALU+ePsz+NGIkYoCMR4xUSwS//Kl6a4hb8ArO9+K//z2eIhgwEsG8/Iq/sOLnavvWbmJpu1XbrSvG5tvcfqBye0xRkMmblWw7ksOxcDGecUMWPTM42VZ6GuULAZBZDKS9bMPFnuOiYf/B//S3X7uystSsUMY4Zfu9gVIpZ8JCOaeQhkhD+DM2W5zCEyJSZL/bu/2o/eHT7v3tzkEvbFTczbX5L9248MblxTCMGSEaJozVJEqDWKUK0mgQYjGdUhCjYQyMUQCHgTGcUU7BOTWGpEoNJslRP37aHh/2g3GYukLXS/65hnf1fLNZ8ZiRlJBEqVQpOxuIEEYItCG+y843SpSY1PbkGzOOpNKaEmKVltydciayY2ovYRSMgnMqOOWcEVANE6U6TnWYyFQqGEJodkBBiCGE0ezQ2RGY9fUQWGMKwFh2A8qIndFhSaVF9qxMYTV0Ruy+IxvKlHchGeNyxjmdRNLemaRaEsIoBQyZOt+V1lGSeoLXfB6kKh+qlx1HKcpIbtexbhYoVSq5NY8Pw/RMM7sBZpA9L8m6whZvYT/cXAwjlGWbCcpgDGNEKlCY9cWaVbcOOv12P6SMCM7yQAybrX8mbSeUxFJ1hnHF45RTu2Gyo7rtmuHlYDud0QTOR1F68+ryynxVLZaiWEZLrjyape98nDqcsMYJ73CnUdH96BJV511qMT33sViQHZV9sT5HVILeIfyK+LBjzRhLeVXjYsX1SwAY5eVH/XzwE68qndB9k46hAVQvVXFxWaUJtWUPxpDEJOwTwjUlRismnDCIvaMkt9AcL05HSf9e2+FkUgsqLhnGcq1Se3DU8ufct1+/1gtGbqjmNirLZffeg6DHcDBRcaCrcxpAf6QE45UyKmVMguyTtRaa0LB87s8k1kFs7A1E1dOJtLYNCzRRRXaHrBMrIogHMqSYSFMj5AuUX/DFrwa+v6xn5rRD5n6i5k+KB11lbGrYR4nccyCBOV+88xtmvbQIYKvXvv1ApYl550vZECVrg6mUMe+7954kb25669Pg36e93VCqbuQftKIisvMG1q+mly5Xmct1Ii2yj1uaEDicuXO00YijiEcRD9oqDYydr2Sv8bwT5CiKsq/9+IBHY0USKkrScUiaGHsu3gYAHRH2s4/3dlqj803/pYsrL18998L6YtlzB5PJOAhiKWMpORMeM89/KzkFqOO5YhwEsWLDMHmwe/TDe3vv3dsdjEdSoeyJ1Tl3ruw1y8ITTCkdxipKVJSoKLVxLSCUURgGEEYJJVJlJksABIRSKigMpcqgHyQH/eiwM26NwsEkMlpXSqxWrS82Kit11vA9V1ClVJpqaXQidZRKwRkj4Iw0y67v0n4oBZ/O+StUQS0u46xYGIt6OdxzwThnnHLOCSXMopZUWimjlJGGwBTTBwqikDIghFFYg6G9jQYxBlobGGgQuwwQSijjVigHoLUx0w7bHJQBeCIDd+tZTDJUZcZogBJCpVJxkpY84TpcahiQopXIijxGaXtMu9RRYmqeKLtsECTDSBW3H8VpSmcgOwgoxfSDy32bGcQf4zW1oToMen2xttzwJ5IedPqdUUIpFTbInh6PxGK2Qk54ZnnM1BgWS3XUjzyP2TGQtp5BGdVSEUY9c7JlSwAMiUEQyxsXFyse1wbcnfQfxtVL1fEw4PLEy5FHocNJtNrk06Yzn5pSlO6mZD6Vli/n0AyAuoZcZyh7AKhRo4iGCtiL9onKwZ0NUD7vKca5ksE5Mrm+Wt3p2oPY3cMqEWNoseybKiVSEteFjfwF6FZo5n3qlyzimyo96IbNyRn7oyphlTAsN+cOVFRz2UE7UIF84fKF5nJ5pV47CEamG8+t+NUa/dHd4ZMwTaRmrmvRpFljGwtuSfDFOmsN1NFAWuCwf82teLnDz8KWvaZZY5NYOw6hJakmwhMk0iYMldGGOuzLJAP3d7vBr4zyv7JDpqtMEdytJmOvseAO4Mu/o8oLjRrxLFhvPVGbL9Rem1uwdxn0O6FUhy3SGqiXLjhFZLdazYPHsX0fLLIvXIxfvMIaiyUrZ+WWR2+eiBKl3gnIJglV2jCaXX+av3uesjeOxll0lR2zd+YCQEfEKM2kMQ/2Ot//xdN3bz/+ZKcP6EurjXdev/balXPLjYrDeRBGgzCMpQR1+LOLJbbFxlJ+ABWHM2biVPdDFaYqTFWcqESqsuvM18VSw1uolppl0ag4xOgwMeNYxqmKpIE0ygDkmNGbaSuTnmKrRwmhlFCiDMZBejSO2v24OwrCMEqkcTm7sFBZX6oKSisuE45I47QTJINQRpEMUhmnitDjEzPGECMIodNs2yK455heZPcGBEYbk/kaKWUZqRfcEYxSQwiR2hhjlNI6D7QhlNp4XWLpsTEGlBH7F0ZBKWOcc8ZsxAwhVBuTDTcFokQKRrngMCZ7hsYA8F3uCzoMU0tdtdFKgTFmR66mSaqULvu8OP3oxE4lB+CpYk6JqZddV9D+KBqEitBjbSmRiLM2JXE6o0BwDkqhlCKMEEMpP9nim/cf2AcCZ1hfqC43/EgRi+wABM9GlOSPegzuhfmohLEola1B7HvM+kpdQelxvgJxqcmougCsYm9HghAzitSNi4uNiusm0dL394NOwn79XAnkNH8Xy75cqopxO5+SaOZ9f1GGxKuE4W6s1I3GPoH6yvrkSjNUEC+cA0B2dhAmzmLT0f3gUVIEd0RJCdMNgfC050Wx9I4SAOpGY0xpNI4ArEZx+VE/VDBViiQe/IsHcStx31jUnkeCCRkcolwnrutdnY9VGC25lTDsbtYrYZgT+e5m3dzc6B8cLDSdg1HQjpI3rp6zSQxNV7Wl6nfjjRKbnyP3u3IQqmRimoumXKGWlVNHlhca/dD4RPdHKi/ZjYaMUZkmJjXG4vtiPX3n2uWrK82Hh30LbRblaV1qT3oNpSYiUOCc/CbhT8LUTjT9/x+4n4nsFsq7ytjzPKNdZXJwvxulW1q//kb58ks1K7NY2u445O++fpyoPIxGoVRb+6rI2S2dz9qaYr1U5xbZN17JCHuO7JOx9jxVamQY3WjEnqfsOYq4jsAotVYZz1PlCs1HsM7guzXCe5T4iqgRH+tjju95inS4SMEJpAYvCUBwiz53Hu79/OEugMV66fJy48WNhZcvr3zl5jUAT4/6D5+2rDrvOqVcf3+mhjUV7qfdEshH3CGAQzMGulh31hYb1ufeGoSDIEkM0kTpSFJKhGAOAeVmpkyaFtMKOXWmloxBkHQCAwSPWiOXU0LZnM/mS875pmN9LFGSjmMVRomcSvCccTDGpyy4aPoumhdP2S4z5JiGL+pc8TcgNqvS4UxqAmMTj43RWkupp9EuJNNtrLmFEELt7psSmo0SsaQVADQhTGktGD3G5+mzTaQy2qQnXUBKqVQSrbVWmlLiey6nJz+sZ5iLcmR3KDqjJEhNcW6qNbMzQlz3jHb/Yy2LMWI7n7SyeGrBuqjCK8M4U2tzFYvsO60Cspus59YY41IDidzfcuxzJzyW6qAfeYJnyM4zI7+to1I+nfdkMSQ9vpBMGYqgoJ/YuF39rK+xWSe51G7NLXqzabPUsdFwN5saqL7qaYAJp3Qzm2i69ONJe6NRWsPYcSLPoKC5W2eO9jx+a9+sE1a9YDMJeq24+upqPYoGPzi4FoR5rLxNjmxemwdg3ZNL3916OtT+DeO/fTWIU//tq5N252izSaq11jqJvtNZJcJGGmS/u0BVhbMzTD5+sgOsnT9fAbBZKX3cjbf2giXC//CVyv/1A9Mep/mMiKOBBDjQSUfHeeW5NDxVh2PUcTSQolqp8SUA33gNP997lIv11myzuyPQQA0s7eN+oq45zILvr5wW8CsUUWf8jqcD3HdK5Nyy99oNlYeC2evzlJi8XmoF9xzZc6k9tyQeDaSdyHF+LcttF1Wv6G8ZPvVQNcVZS1n2+kkHZPOoPCmNTr+WRiOmIw+AO/1F+xPEE9ev866U/gQASpw3HOwNJPNd1/6kCSGCU89xXMHTNH16NPz5xwffv/Xkpx893evF55v+W69cfuP6+oWletUXMonjVJ1m7ie0GibCKI4U7N69WNZSBqlGkur2WA7H4SjWSinOacUXdV+US47nCjvaIkpVFKs4sZnqmuizY3tz3YNRaoulqUKqdHcS98fxYJyEiSm5vFJii43aUrOyWGUeY8IR0EobY5SWMBTEkGfuTY7FaBSnW5CzPfcgAGHEEMo4JZwzRzCHEsoIpRQGxkK40sYQGORNRsZore2ewC4Y01ZTaK1NoyRkqsAy5dp2qAohKg4dhmmmuWtIpSkhnFNHEM8Rs2+YLcmekp4MCCeoHSN71jdhDZV5m5JTSF3PtzUz9WeS/RWUwqrqhB6r8FKBU7M2V6lXS9KQnVa/NYoNIE6KPIQQBSIJNKiCJe8a0CA80fqoH7mCl7wM2WnudjWGUGLvy7TJ3Cjs2JqTM/cFYRZ/dqATqm40cHHZVOlkq1tUZvwbc4NzK65REB4J+9EPuqtRHCqEt7t8nI6Hgbc5lyd2UcbSoz0io8pcTVYj90J5RH1AxPe7LaWdlNoBs5LDny/Rw/HCdr/8JAqDWJ1voi68CxXDOfVL/mBcGkRBwwMQNLzO00AehWLZB6CXq+xeq/M0WCWidzjRF71yrRLEKZKYftIzVRqXG94FXT0Mxm+tMt9Pu13yYRzXoiu10s44cVMiSeRQr+TKoyO1sx9GJTY/73LXYXHUC4mKTHWp4KRWLFdgcvIeRVz2QT1EEWeuXKrzg1bk0fjF9RUt/XHSahXibcseZa60bZPUw/Iq3SgYJf97JO/vdoNntaEWkf2awyxtz6+0l+8T/flvZoKMlV8e7+vL62Sztprf1165vJgNRC1K7VkdtSOt9m2lmNwketCKLHz3+253h/AmmZmilyYmiviMDlNL3fPEC2vpaf7u1qVbl2PNReEVy1jn/1306Kibugas5DBttNGgOfU0hjIuBHc8IQQfh+mDvfb3frb9r396//7eIArjjXPNL71+9cJSbRIlw0n8LHAfjIJBrHLmrswZWEy1Tg1hMKE0iTIwxhb7OCNVj1mgdwWlQCx1lKhUmVRqA0KNeQ7KW+2YEDBKCSVSmnEi++O4PU57o3AUpVrqRlUs1qv1Eqm6bsllnDEQyFQdix4n0Wqao3vinGnU03+nXVREqZRROlU/yFRnJpRSRinn1BVEcE4pjLHNolopZSdjT2UbaosN2hillDUEba7Wg1RG6XEerwZckcky9g1JtQZoyWOUUm00zV+OUlYzOaHGFDd9HM2KkyaqM4ojdTwv24AkaYbsrkNn6q62UEEplTr7QMgx9GdSuwHRBRWeUlhkjxXZ74XdYWimzcwofKxFWaZYUE0M2oOIUFLxufVrisLSki+TABQl01WhWIzVFtznfdb9ebdKWLTk4lxDU1KWyioz0Uq5eql6dE4wt+R/3CadyKw0J70k6CS5NM8lcTgha/O2vGlGQ7oVkiHEuQpqNSO8ZJJoz0v2g9YkqpkM3AFEmkV7g2CCYWzEso+6wHQaKgkm/fd2gwnGlPplbtbJeET5OM3wvS76Hw34OK0SViUsZtqcb2qt6Z0Dqxcpxnk83nsw8TbnDBf0zsF6e9ydlBZWKSge9MJ50ECHq577Vz/fi6W8cq3m+XyuLi7P+y8t+1EQHZhkbdG2rGt7ttpLakyuvAd9riNQD4zK1BgAox4NZN+vqLpfG+tewnyrwlsyW6tpi+/zIC9MaLHm+d9Rn7GY/px0gRnObqWY7hSJLIV/NNH0ncqFzUoxFqZSRhHE81Lqwsq8XQCKggwAm0/gecq6YvQ0vjWPA0taIg1hK6gz5hYL7lZa6fddW02tga66GkvH7/xpiUaNjmlWlBrOyPmaWCrxutBORcwvl/5/abxYI7oLvZ8AAAAASUVORK5CYII=";
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
function CustomerApp({ menu, planConfig, orders, ordersHistory = [], kitchenOpen, poll, onPlaceOrder, onSubmitRating, onSubmitPollResponse, onOwnerAccess }) {
  const [step, setStep] = useState("home");
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
  const [planChoiceModal, setPlanChoiceModal] = useState(null); // "gold" | "mini" | null
  const [specialInstructions, setSpecialInstructions] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [showInvalidPhone, setShowInvalidPhone] = useState(false);
  const [activeOrder, setActiveOrder] = useState(null);
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
  // Poll popup: holds the just-placed order while the poll modal is shown.
  const [pollOrder, setPollOrder] = useState(null);

  // Read remembered phone on mount (no-op if browser storage isn't available)
  useEffect(() => {
    try {
      const p = typeof window !== "undefined" ? window.localStorage.getItem("htLastCustomerPhone") : "";
      if (p) setRememberedPhone(p);
    } catch { /* private mode / storage disabled — silently ignore */ }
  }, []);

  // Find the most recent unrated DELIVERED order for the remembered customer.
  // Looks in both todayOrders (in case they had an earlier meal today) and
  // ordersHistory (previous days, up to ~100 days retained).
  const unratedOrder = (() => {
    if (!rememberedPhone || ratingCardDismissed) return null;
    const candidates = [
      ...(orders || []),
      ...(ordersHistory || []),
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
    { id: "extra-raita", name: `${planConfig.raita} (Raita of the Day)`, price: planConfig.prices.raita },
    { id: "extra-salad", name: `${planConfig.salad} (Salad of the Day)`, price: planConfig.prices.salad },
    { id: "extra-sweet", name: `${planConfig.sweet} (Sweet of the Day)`, price: planConfig.prices.sweet },
  ] : [];

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

    // Show the feedback poll once, if it's live and this device hasn't
    // already answered/dismissed it. Small delay so the tracking screen
    // renders first and the popup feels like a natural follow-up.
    if (isPollLive(poll) && !getSeenPolls().includes(poll.id)) {
      setTimeout(() => setPollOrder(order), 550);
    }
  };

  const trackOrder = () => {
    const trimmed = lookupPhone.trim();
    const found = orders.find(o => o.phone === trimmed && o.date === todayStr());
    if (found) { setActiveOrder(found); setStep("track"); }
    else setShowInvalidPhone(true);
  };

  useEffect(() => {
    if (step === "track" && activeOrder) {
      const updated = orders.find(o => o.id === activeOrder.id);
      if (updated) setActiveOrder(updated);
    }
  }, [orders]);

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
    const live = orders.find(o => o.id === activeOrder.id) || activeOrder;
    const isRejected = live.status === "rejected";
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

          {!isRejected && (
            <div className="ht-card slide-in" style={{ padding: 20, marginBottom: 16 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: C.ink, marginBottom: 12 }}>Your Order</h3>
              {live.items.map(item => (
                <div key={item.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${C.border}`, fontSize: 14 }}>
                  <span style={{ color: C.inkMid }}>{item.name} × {item.qty}</span>
                  <span style={{ fontWeight: 600, color: C.ink }}>₹{item.price * item.qty}</span>
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 10, fontWeight: 700, fontSize: 15 }}>
                <span>Total</span>
                <span style={{ color: C.saffron }}>₹{live.total}</span>
              </div>
            </div>
          )}

          {!isRejected && (
            <div className="ht-card slide-in" style={{ padding: 20, marginBottom: 20 }}>
              <p style={{ fontSize: 13, color: C.inkMid }}>
                Delivering to <strong style={{ color: C.ink }}>{live.tower}, Flat {live.flat}</strong>
              </p>
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
          {plansAvailable && (
            <div style={{ marginBottom: 16 }}>
              <h2 style={{ fontSize: 14, fontWeight: 800, color: C.ink, marginBottom: 10 }}>🍽️ Meal Plans</h2>
              <div className="ht-card slide-in" style={{ padding: 0, marginBottom: 10, overflow: "hidden" }}>
                <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 800, color: C.ink }}>✨ Homely Gold</div>
                      <div style={{ fontSize: 12, color: C.inkMid, marginTop: 4, lineHeight: 1.5 }}>
                        Choice of 2 sabjis + Choice of breads + Rice for the day + Choice of sides + Salad for the day
                      </div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontSize: 15, fontWeight: 800, color: C.saffron, marginBottom: 6 }}>₹{planConfig.prices.gold}</div>
                      <button className="ht-btn btn-primary btn-sm" onClick={() => setPlanChoiceModal("gold")}>+ Add</button>
                    </div>
                  </div>
                </div>
                <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                    <div>
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
                <div style={{ padding: "16px 20px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                    <div>
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
          {plansAvailable && (
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
    ? (orders || []).find(o =>
        o.phone === rememberedPhone &&
        (o.status === "pending" || o.status === "preparing" || o.status === "dispatched")
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

          <button onClick={() => setStep("order")} disabled={!kitchenOpen || !menuAvailable} style={{
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

      {/* Rating card — returning customer with an unrated delivered order */}
      {unratedOrder && (
        <div style={{ maxWidth: 420, margin: "18px auto 0", padding: "0 14px" }}>
          <RatingCard
            order={unratedOrder}
            onSubmit={handleSubmitRating}
            onSkip={() => setRatingCardDismissed(true)}
            submitting={ratingSubmitting}
          />
        </div>
      )}

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
                  {trackActiveOrder.status === "pending" && "Order received, aunty starting soon 🍳"}
                  {trackActiveOrder.status === "preparing" && "Aunty is cooking your tiffin 🍲"}
                  {trackActiveOrder.status === "dispatched" && "On its way to you 🛵"}
                </div>
                {/* Progress dots — 4 stages */}
                <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 8 }}>
                  {["pending", "preparing", "dispatched", "delivered"].map((stg, idx, arr) => {
                    const rank = { pending: 0, preparing: 1, dispatched: 2, delivered: 3 };
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
    ? planConfig
    : defaultPlanConfig();
  const [sabjis, setSabjis] = useState(base.sabjis.map(s => ({ ...s })));
  const [rice, setRice] = useState(base.rice || "");
  const [salad, setSalad] = useState(base.salad || "");
  const [raita, setRaita] = useState(base.raita || "");
  const [sweet, setSweet] = useState(base.sweet || "");
  const [prices, setPrices] = useState({ ...defaultPlanConfig().prices, ...(base.prices || {}) });
  const [saved, setSaved] = useState(false);

  const setSabjiName = (i, name) => setSabjis(prev => prev.map((s, idx) => idx === i ? { ...s, name } : s));
  const setPremium = (i) => setSabjis(prev => prev.map((s, idx) => ({ ...s, premium: idx === i })));
  const setPrice = (key, val) => setPrices(prev => ({ ...prev, [key]: val === "" ? "" : parseInt(val) || 0 }));

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
        gold: prices.gold || 0, standard: prices.standard || 0, mini: prices.mini || 0,
        raita: prices.raita || 0, salad: prices.salad || 0, sweet: prices.sweet || 0,
      },
    });
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  };

  const isPublishedToday = planConfig && planConfig.date === todayStr();

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

      {/* Prices */}
      <div className="ht-card" style={{ padding: 20, marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 12 }}>💰 Prices</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 4 }}>Homely Gold ₹</label>
            <input className="ht-input" type="number" value={prices.gold} onChange={e => setPrice("gold", e.target.value)} />
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
const STATUS_FLOW = { pending: "preparing", preparing: "dispatched", dispatched: "delivered" };
const STATUS_LABEL = { pending: "Accept & Prepare", preparing: "Mark Dispatched", dispatched: "Mark Delivered" };

// ─────────────────────────────────────────────
// KOT (Kitchen Order Ticket) printing
// Opens a print-ready window laid out for an 80mm thermal
// printer. It also prints cleanly on a normal A4 printer via
// the browser's print dialog, so no special hardware is required.
// Ticket shows: customer name, delivery address, ordered items,
// and special instructions (only when present).
// ─────────────────────────────────────────────
function printKOT(order) {
  if (!order) return;

  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const address = `${order.tower} · Flat ${order.flat}`;
  const hasNote = order.specialInstructions && order.specialInstructions.trim().length > 0;

  const itemRows = (order.items || [])
    .map(i => `<tr><td class="qty">${esc(i.qty)}×</td><td class="name">${esc(i.name)}</td></tr>`)
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
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .center { text-align: center; }
  .divider { border-top: 1px dashed #000; margin: 6px 0; }
  .row { font-size: 13px; line-height: 1.55; word-break: break-word; }
  .label { font-weight: 700; }
  table { width: 100%; border-collapse: collapse; }
  td { font-size: 14px; padding: 3px 0; vertical-align: top; }
  td.qty { width: 34px; font-weight: 800; }
  td.name { font-weight: 600; }
  .note { font-size: 13px; font-weight: 700; border: 1.5px solid #000; padding: 5px 6px; margin-top: 6px; line-height: 1.4; }
  .note-label { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
</style>
</head>
<body>
  <div class="row"><span class="label">Name:</span> ${esc(order.customerName)}</div>
  <div class="row"><span class="label">Deliver to:</span> ${esc(address)}</div>
  <div class="divider"></div>
  <table>${itemRows}</table>
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
  const canReject = order.status === "pending" || order.status === "preparing";
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
        <div style={{ fontSize: 18, fontWeight: 800, color: C.saffron }}>₹{order.total}</div>
      </div>

      <div style={{ background: C.cream, borderRadius: 8, padding: "8px 12px", marginBottom: hasInstructions ? 8 : 12 }}>
        {order.items.map(i => (
          <span key={i.id} style={{ fontSize: 12, color: C.inkMid, marginRight: 8 }}>{i.name} ×{i.qty}</span>
        ))}
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
          {(order.status === "preparing" || order.status === "dispatched") && (
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
    dispatched: todayOrders.filter(o => o.status === "dispatched").length,
    delivered:  todayOrders.filter(o => o.status === "delivered").length,
    rejected:   todayOrders.filter(o => o.status === "rejected").length,
  };

  const activeCount = counts.pending + counts.preparing + counts.dispatched;

  const STATUS_CONFIG = [
    { key: "pending",    label: "Pending",    emoji: "🕐", badgeCls: "badge-pending",    border: "#856404", bg: "#FFF3CD" },
    { key: "preparing",  label: "Preparing",  emoji: "👨‍🍳", badgeCls: "badge-preparing",  border: C.saffron, bg: C.saffronLight },
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
function AnalyticsPanel({ todayOrders, ordersHistory, customers, onResetAllData }) {
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

function CreditLedger({ credit, todayOrders = [], ordersHistory = [], onAddCredit, onResetCustomer, onDeleteCustomer, onReconcile }) {
  const [selected, setSelected]       = useState(null);
  const [showPayModal, setShowPayModal] = useState(false);
  const [payAmt, setPayAmt]           = useState("");
  const [payNote, setPayNote]         = useState("");
  const [search, setSearch]           = useState("");

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
            <button className="ht-btn btn-green" onClick={() => setShowPayModal(true)}>
              + Payment Received
            </button>
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
              <div style={{ display: "grid", gridTemplateColumns: "72px 1fr 72px 72px 72px", padding: "10px 14px", background: C.cream, borderBottom: `1px solid ${C.border}`, fontSize: 10, fontWeight: 700, color: C.inkMid, textTransform: "uppercase", letterSpacing: "0.3px" }}>
                <span>Date</span><span>Details</span>
                <span style={{ textAlign: "right", color: C.red }}>Debit</span>
                <span style={{ textAlign: "right", color: C.green }}>Credit</span>
                <span style={{ textAlign: "right" }}>Balance</span>
              </div>

              {entries.map((e, i) => {
                running += e.type === "debit" ? e.amount : -e.amount;
                const isDebit = e.type === "debit";
                return (
                  <div key={e.id} style={{ display: "grid", gridTemplateColumns: "72px 1fr 72px 72px 72px", padding: "11px 14px", borderBottom: i < entries.length - 1 ? `1px solid ${C.border}` : "none", background: isDebit ? "#FFFAF8" : "#F8FFFA" }}>
                    <div style={{ fontSize: 11, color: C.inkLight, paddingTop: 2 }}>
                      {new Date(e.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                    </div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{e.note}</div>
                      {e.orderDetails && <div style={{ fontSize: 11, color: C.inkMid, marginTop: 2 }}>{e.orderDetails}</div>}
                    </div>
                    <div style={{ textAlign: "right", fontSize: 13, fontWeight: 700, color: C.red }}>{isDebit ? `₹${e.amount}` : ""}</div>
                    <div style={{ textAlign: "right", fontSize: 13, fontWeight: 700, color: C.green }}>{!isDebit ? `₹${e.amount}` : ""}</div>
                    <div style={{ textAlign: "right", fontSize: 13, fontWeight: 800, color: running > 0 ? C.red : running < 0 ? C.green : C.inkMid }}>
                      ₹{Math.abs(running)}
                    </div>
                  </div>
                );
              })}

              {/* Balance footer */}
              <div style={{ display: "grid", gridTemplateColumns: "72px 1fr 72px 72px 72px", padding: "12px 14px", background: C.ink }}>
                <div style={{ gridColumn: "1 / 5", fontSize: 13, fontWeight: 700, color: "rgba(255,255,255,0.7)" }}>Net Balance</div>
                <div style={{ textAlign: "right", fontSize: 15, fontWeight: 900, color: balance > 0 ? "#FF8A80" : balance < 0 ? "#B9F6CA" : "rgba(255,255,255,0.5)" }}>
                  {balance > 0 ? `₹${balance} ↑` : balance < 0 ? `₹${Math.abs(balance)} ↓` : "Settled"}
                </div>
              </div>
            </div>
          )}
        </div>

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
function BackendApp({ menu, planConfig, todayOrders, ordersHistory, customers, credit, kitchenOpen, poll, pollResponses, onSaveMenu, onSavePlanConfig, onAdvanceOrder, onRejectOrder, onLogout, onAddCredit, onResetCreditCustomer, onDeleteCreditCustomer, onReconcileCredit, onToggleKitchen, onResetAllData, onSavePoll, onTogglePoll, onClearPollResponses }) {
  const [tab, setTab] = useState("orders");
  const pendingCount = todayOrders.filter(o => o.status === "pending").length;
  const creditAlert = credit.filter(c => c.entries.reduce((s, e) => e.type === "debit" ? s + e.amount : s - e.amount, 0) > 0).length;
  const tabs = [
    { id: "orders",   label: "📦 Orders" },
    { id: "menu",     label: "🍽️ Menu" },
    { id: "plans",    label: "🍛 Plans" },
    { id: "credit",   label: "📒 Credit" },
    { id: "analytics",label: "📊 Analytics" },
    { id: "feedback", label: "🗳️ Feedback" },
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
        {tab === "credit"    && <CreditLedger credit={credit} todayOrders={todayOrders} ordersHistory={ordersHistory} onAddCredit={onAddCredit} onResetCustomer={onResetCreditCustomer} onDeleteCustomer={onDeleteCreditCustomer} onReconcile={onReconcileCredit} />}
        {tab === "analytics" && <AnalyticsPanel todayOrders={todayOrders} ordersHistory={ordersHistory} customers={customers} onResetAllData={onResetAllData} />}
        {tab === "feedback"  && <FeedbackPanel poll={poll} pollResponses={pollResponses} onSavePoll={onSavePoll} onTogglePoll={onTogglePoll} onClearResponses={onClearPollResponses} />}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// OWNER LOGIN SCREEN
// ─────────────────────────────────────────────
const OWNER_USER = "Homelytiffins8";
const OWNER_PASS = "Homely@098";

function OwnerLogin({ onSuccess }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [shaking, setShaking] = useState(false);

  const handleLogin = () => {
    if (username === OWNER_USER && password === OWNER_PASS) {
      onSuccess();
    } else {
      setError("Incorrect username or password.");
      setShaking(true);
      setTimeout(() => setShaking(false), 500);
    }
  };

  const handleKey = (e) => { if (e.key === "Enter") handleLogin(); };

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
            <label style={{ fontSize: 12, fontWeight: 600, color: C.inkMid, display: "block", marginBottom: 5 }}>Username</label>
            <input
              className="ht-input"
              placeholder="Enter username"
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

          <button className="ht-btn btn-primary btn-full btn-lg" onClick={handleLogin} style={{ marginTop: 4 }}>
            Sign In →
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

  const [menu, setMenu] = useState(null);
  const [planConfig, setPlanConfig] = useState(null); // daily thali plan config (Gold/Standard/Mini)
  const [todayOrders, setTodayOrders] = useState([]);
  const [ordersHistory, setOrdersHistory] = useState([]); // archived past orders (~100 days)
  const [customers, setCustomers] = useState([]);
  const [credit, setCredit] = useState([]);      // permanent credit ledger
  const [kitchenOpen, setKitchenOpen] = useState(true); // owner-controlled
  const [poll, setPoll] = useState(null);               // owner-defined customer poll
  const [pollResponses, setPollResponses] = useState([]); // customer poll submissions (owner-only)
  const [loaded, setLoaded] = useState(false);

  // Listen to hash changes so back/forward browser nav works
  useEffect(() => {
    const onHash = () => {
      const r = getRouteFromHash();
      setRoute(r);
      if (r === "customer") setOwnerAuthed(false); // auto-logout when navigating away
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // ── BOOT: load storage + handle daily rollover ──
  useEffect(() => {
    (async () => {
      const [m, td, cust, lastDate, cred, ko, hist, pl, pr, pc] = await Promise.all([
        load(KEYS.menu),
        load(KEYS.todayOrders),
        load(KEYS.customers),
        load(KEYS.lastDate),
        load(KEYS.credit),
        load(KEYS.kitchenOpen),
        load(KEYS.ordersHistory),
        load(KEYS.poll),
        load(KEYS.pollResponses),
        load(KEYS.planConfig),
      ]);

      if (m) setMenu(m);
      if (pc) setPlanConfig(pc);
      if (cust) setCustomers(cust);
      if (cred) setCredit(cred);
      if (hist) setOrdersHistory(hist);
      if (ko !== null && ko !== undefined) setKitchenOpen(!!ko);
      if (pl) setPoll(pl);
      if (Array.isArray(pr)) setPollResponses(pr);

      const today = todayStr();

      if (lastDate && lastDate !== today && td && td.length > 0) {
        setTodayOrders([]);
        // Archive the previous day's orders into history (dedup by id, keep last ~100 days)
        const storedHistory = hist || [];
        const seen = new Set(storedHistory.map(o => o.id));
        const cutoff = (() => { const d = new Date(); d.setDate(d.getDate() - 100); return d.toISOString().split("T")[0]; })();
        const archived = [...storedHistory, ...td.filter(o => !seen.has(o.id))].filter(o => o.date >= cutoff);
        setOrdersHistory(archived);
        // Drop settled (zero balance) credit customers on daily rollover
        const storedCredit = cred || [];
        const getBalance = (entries) => entries.reduce((s, e) => e.type === "debit" ? s + e.amount : s - e.amount, 0);
        const rolledCredit = storedCredit.filter(c => getBalance(c.entries) !== 0);
        setCredit(rolledCredit);
        await Promise.all([
          save(KEYS.todayOrders, []),
          save(KEYS.ordersHistory, archived),
          save(KEYS.credit, rolledCredit),
          save(KEYS.lastDate, today),
        ]);
      } else {
        // Defensive: only orders dated today belong in todayOrders.
        // Guards against yesterday's orders leaking in if a device stayed
        // open across midnight and never got the rollover.
        const currentToday = (td || []).filter(o => o.date === today);
        setTodayOrders(currentToday);
        if (td && currentToday.length !== td.length) {
          await save(KEYS.todayOrders, currentToday);
        }
        await save(KEYS.lastDate, today);
      }

      setLoaded(true);
    })();
  }, []);

  // ── Real-time sync via Supabase: instantly updates all devices when data changes ──
  useEffect(() => {
    if (!loaded) return;
    const channel = supabase
      .channel("app_data_changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "app_data" }, async (payload) => {
        const changedKey = payload.new?.key || payload.old?.key;
        if (!changedKey) return;
        const newVal = payload.new?.value;
        if (changedKey === KEYS.menu)        setMenu(newVal);
        if (changedKey === KEYS.planConfig)  setPlanConfig(newVal);
        if (changedKey === KEYS.todayOrders) {
          const incoming = newVal || [];
          // Empty payload = authoritative wipe (daily rollover / manual reset).
          // Apply as-is so resets propagate to all devices.
          if (incoming.length === 0) {
            setTodayOrders([]);
          } else {
            // Non-empty: merge with local using status precedence so a
            // late-arriving realtime message with an OLDER status can't
            // overwrite a newer one we already have. Also strip stale-day
            // orders defensively.
            const today = todayStr();
            const filtered = incoming.filter(o => o.date === today);
            setTodayOrders(current => mergeOrders(current, filtered));
          }
        }
        if (changedKey === KEYS.ordersHistory) {
          const incoming = newVal || [];
          if (incoming.length === 0) {
            setOrdersHistory([]);
          } else {
            setOrdersHistory(current => mergeOrders(current, incoming));
          }
        }
        if (changedKey === KEYS.customers)   setCustomers(newVal || []);
        if (changedKey === KEYS.credit)      setCredit(newVal || []);
        if (changedKey === KEYS.kitchenOpen) setKitchenOpen(!!newVal);
        if (changedKey === KEYS.poll)        setPoll(newVal || null);
        if (changedKey === KEYS.pollResponses) {
          // Union-merge by id so a late realtime message can't drop responses
          // this device already knows about.
          const incoming = newVal || [];
          setPollResponses(current => {
            const byId = new Map(current.map(r => [r.id, r]));
            incoming.forEach(r => { if (r && r.id) byId.set(r.id, r); });
            return Array.from(byId.values());
          });
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [loaded]);

  // ── New order alert sound ──
  useOrderAlert(todayOrders, route === "owner" && ownerAuthed);

  const handleSaveMenu = useCallback(async (newMenu) => {
    setMenu(newMenu); await save(KEYS.menu, newMenu);
  }, []);

  const handleSavePlanConfig = useCallback(async (newConfig) => {
    setPlanConfig(newConfig); await save(KEYS.planConfig, newConfig);
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
  // Append-only, concurrency-safe: fetch latest → union-merge by id → append.
  const handleSubmitPollResponse = useCallback(async (response) => {
    if (!response || !response.id) return;
    const server = (await load(KEYS.pollResponses)) || [];
    const byId = new Map(server.map(r => [r.id, r]));
    // fold in what this device already has, then the new one
    pollResponses.forEach(r => { if (r && r.id) byId.set(r.id, r); });
    byId.set(response.id, response);
    let merged = Array.from(byId.values());
    if (merged.length > MAX_POLL_RESPONSES) merged = merged.slice(-MAX_POLL_RESPONSES);
    setPollResponses(merged);
    await save(KEYS.pollResponses, merged);
  }, [pollResponses]);

  const handleClearPollResponses = useCallback(async () => {
    setPollResponses([]);
    await save(KEYS.pollResponses, []);
  }, []);

  const handlePlaceOrder = useCallback(async (order) => {
    // ── Concurrency-safe write (fetch → merge → write) ──
    // Read the latest server state, merge with our local view using
    // status precedence, then prepend the new order. This prevents this
    // device's possibly-stale local state from overwriting status
    // advances that other devices (owner dashboard, family members)
    // have already committed to Supabase.
    const today = todayStr();
    const serverOrders = ((await load(KEYS.todayOrders)) || []).filter(o => o.date === today);
    const localToday = todayOrders.filter(o => o.date === today);
    const merged = mergeOrders(localToday, serverOrders);
    const newTodayOrders = [order, ...merged.filter(o => o.id !== order.id)];
    setTodayOrders(newTodayOrders);
    await save(KEYS.todayOrders, newTodayOrders);
    setCustomers(prev => {
      const next = [...prev];
      const idx = next.findIndex(c => c.phone === order.phone);
      if (idx >= 0) {
        next[idx] = { ...next[idx], totalOrders: next[idx].totalOrders + 1, totalSpent: next[idx].totalSpent + order.total, lastOrderDate: order.date, tower: order.tower, flat: order.flat };
      } else {
        next.push({ name: order.customerName, phone: order.phone, tower: order.tower, flat: order.flat, totalOrders: 1, totalSpent: order.total, firstOrderDate: order.date, lastOrderDate: order.date });
      }
      save(KEYS.customers, next); return next;
    });
  }, [todayOrders]);

  const handleAdvanceOrder = useCallback(async (orderId, nextStatus) => {
    // ── Concurrency-safe write (fetch → merge → validate → write) ──
    const today = todayStr();
    const serverOrders = ((await load(KEYS.todayOrders)) || []).filter(o => o.date === today);
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
      await save(KEYS.todayOrders, base);
      return;
    }

    const updated = base.map(o => o.id === orderId ? { ...o, status: nextStatus } : o);
    setTodayOrders(updated);
    await save(KEYS.todayOrders, updated);

    // When delivered → auto-debit credit ledger.
    // Idempotent: each order can only be credited ONCE, no matter how many
    // times handleAdvanceOrder is called with nextStatus="delivered".
    // This prevents duplicate debits from stale-UI re-clicks, rapid taps,
    // realtime retries, or the historical status-regression bug.
    if (nextStatus === "delivered") {
      const orderDetails = order.items.map(i => `${i.name}×${i.qty}`).join(", ");
      setCredit(prev => {
        const idx = prev.findIndex(c => c.phone === order.phone);
        // ── Idempotency guard ──
        if (idx >= 0 && prev[idx].entries.some(e => e.orderId === order.id)) {
          return prev; // this order is already credited; do nothing
        }
        const next = [...prev];
        const entry = {
          id: genId(),
          orderId: order.id, // ← key to idempotency
          date: new Date().toISOString(),
          type: "debit",
          amount: order.total,
          note: "Order delivered",
          orderDetails,
        };
        if (idx >= 0) {
          next[idx] = { ...next[idx], entries: [...next[idx].entries, entry] };
        } else {
          next.push({ phone: order.phone, name: order.customerName, tower: order.tower, flat: order.flat, entries: [entry] });
        }
        save(KEYS.credit, next);
        return next;
      });
    }
  }, [todayOrders]);

  const handleRejectOrder = useCallback(async (orderId) => {
    // ── Concurrency-safe write (fetch → merge → validate → write) ──
    const today = todayStr();
    const serverOrders = ((await load(KEYS.todayOrders)) || []).filter(o => o.date === today);
    const localToday = todayOrders.filter(o => o.date === today);
    const base = mergeOrders(localToday, serverOrders);
    const order = base.find(o => o.id === orderId);
    if (!order) return;

    // Don't reject an order another device already dispatched or delivered.
    // The reject click came from a stale UI — sync to reality and bail.
    if (order.status === "dispatched" || order.status === "delivered") {
      setTodayOrders(base);
      await save(KEYS.todayOrders, base);
      return;
    }

    const updated = base.map(o => o.id === orderId ? { ...o, status: "rejected" } : o);
    setTodayOrders(updated);
    await save(KEYS.todayOrders, updated);
  }, [todayOrders]);

  // ── Submit customer rating ──
  // Order might live in todayOrders (rated same day) OR ordersHistory (rated
  // on a later visit). Locate it, attach the rating, and write back using the
  // concurrency-safe fetch→merge→write pattern so no concurrent update loses
  // the rating.
  const handleSubmitRating = useCallback(async (orderId, rating) => {
    if (!orderId || !rating) return;
    const today = todayStr();

    // First check today's orders
    const inToday = todayOrders.some(o => o.id === orderId);
    if (inToday) {
      const serverOrders = ((await load(KEYS.todayOrders)) || []).filter(o => o.date === today);
      const localToday = todayOrders.filter(o => o.date === today);
      const base = mergeOrders(localToday, serverOrders);
      const target = base.find(o => o.id === orderId);
      if (!target) return;
      // Idempotency: don't overwrite an existing rating
      if (target.rating) return;
      const updated = base.map(o => o.id === orderId ? { ...o, rating } : o);
      setTodayOrders(updated);
      await save(KEYS.todayOrders, updated);
      return;
    }

    // Otherwise it's in history
    const serverHistory = (await load(KEYS.ordersHistory)) || [];
    const base = mergeOrders(ordersHistory, serverHistory);
    const target = base.find(o => o.id === orderId);
    if (!target) return;
    if (target.rating) return;
    const updated = base.map(o => o.id === orderId ? { ...o, rating } : o);
    setOrdersHistory(updated);
    await save(KEYS.ordersHistory, updated);
  }, [todayOrders, ordersHistory]);

  const handleAddCredit = useCallback(async (phone, entry) => {
    setCredit(prev => {
      const next = prev.map(c => c.phone === phone
        ? { ...c, entries: [...c.entries, { id: genId(), date: new Date().toISOString(), ...entry }] }
        : c
      );
      save(KEYS.credit, next);
      return next;
    });
  }, []);

  const handleResetCreditCustomer = useCallback(async (phone) => {
    setCredit(prev => {
      // Keep the customer record but clear all entries (balance becomes 0)
      const next = prev.map(c => c.phone === phone ? { ...c, entries: [] } : c);
      save(KEYS.credit, next);
      return next;
    });
  }, []);

  const handleDeleteCreditCustomer = useCallback(async (phone) => {
    setCredit(prev => {
      const next = prev.filter(c => c.phone !== phone);
      save(KEYS.credit, next);
      return next;
    });
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
      id: genId(),
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
    await save(KEYS.credit, newCredit);
  }, [credit, todayOrders, ordersHistory]);

  const handleResetAllData = useCallback(async () => {
    // Wipe transactional data; keep menu + kitchen settings
    setTodayOrders([]);
    setOrdersHistory([]);
    setCustomers([]);
    setCredit([]);
    await Promise.all([
      save(KEYS.todayOrders, []),
      save(KEYS.ordersHistory, []),
      save(KEYS.customers, []),
      save(KEYS.credit, []),
      save(KEYS.lastDate, todayStr()),
    ]);
  }, []);

  const handleOwnerLogout = () => {
    setOwnerAuthed(false);
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

      {route === "customer" && (
        <CustomerApp
          menu={menu}
          planConfig={planConfig}
          orders={todayOrders}
          ordersHistory={ordersHistory}
          kitchenOpen={kitchenOpen}
          poll={poll}
          onPlaceOrder={handlePlaceOrder}
          onSubmitRating={handleSubmitRating}
          onSubmitPollResponse={handleSubmitPollResponse}
          onOwnerAccess={() => setRoute("owner")}
        />
      )}

      {route === "owner" && !ownerAuthed && (
        <OwnerLogin onSuccess={() => setOwnerAuthed(true)} />
      )}

      {route === "owner" && ownerAuthed && (
        <BackendApp
          menu={menu}
          planConfig={planConfig}
          todayOrders={todayOrders}
          ordersHistory={ordersHistory}
          customers={customers}
          credit={credit}
          kitchenOpen={kitchenOpen}
          poll={poll}
          pollResponses={pollResponses}
          onSaveMenu={handleSaveMenu}
          onSavePlanConfig={handleSavePlanConfig}
          onAdvanceOrder={handleAdvanceOrder}
          onRejectOrder={handleRejectOrder}
          onLogout={handleOwnerLogout}
          onAddCredit={handleAddCredit}
          onResetCreditCustomer={handleResetCreditCustomer}
          onDeleteCreditCustomer={handleDeleteCreditCustomer}
          onReconcileCredit={handleReconcileCredit}
          onToggleKitchen={handleToggleKitchen}
          onResetAllData={handleResetAllData}
          onSavePoll={handleSavePoll}
          onTogglePoll={handleTogglePoll}
          onClearPollResponses={handleClearPollResponses}
        />
      )}
    </div>
  );
}
