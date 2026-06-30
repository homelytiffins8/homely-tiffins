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
};

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

// Tower list N-1 to N-28
const TOWERS = Array.from({ length: 28 }, (_, i) => `N-${i + 1}`);

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
// CUSTOMER APP
// ─────────────────────────────────────────────
function CustomerApp({ menu, orders, kitchenOpen, onPlaceOrder, onOwnerAccess }) {
  const [step, setStep] = useState("home");
  const [cart, setCart] = useState({});
  const [specialInstructions, setSpecialInstructions] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [showInvalidPhone, setShowInvalidPhone] = useState(false);
  const [activeOrder, setActiveOrder] = useState(null);
  const [lookupPhone, setLookupPhone] = useState("");

  const menuItems = menu?.items?.filter(i => i.available) || [];
  const cartTotal = Object.entries(cart).reduce((sum, [id, qty]) => {
    const item = menuItems.find(i => i.id === id); return sum + (item ? item.price * qty : 0);
  }, 0);
  const cartCount = Object.values(cart).reduce((a, b) => a + b, 0);

  const setQty = (id, delta) => setCart(prev => {
    const next = { ...prev, [id]: Math.max(0, (prev[id] || 0) + delta) };
    if (next[id] === 0) delete next[id]; return next;
  });

  const handleConfirmOrder = (order) => {
    setShowModal(false);
    onPlaceOrder(order);
    setActiveOrder(order);
    setStep("track");
    setCart({});
    setSpecialInstructions("");
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

  const menuAvailable = menu && menu.date === todayStr() && menuItems.length > 0 && kitchenOpen;

  // If owner closes the kitchen while customer is browsing the menu, send them home
  useEffect(() => {
    if (!kitchenOpen && step === "order") {
      setStep("home");
      setCart({});
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

          <div className="ht-card slide-in" style={{ padding: 20, marginBottom: cartCount > 0 ? 16 : 80 }}>
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
            menuItems={menuItems}
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

  // ── HOME ──
  return (
    <div style={{ minHeight: "100vh", background: C.cream }}>
      <div style={{ background: `linear-gradient(135deg, ${C.saffron} 0%, #C4620F 100%)`, padding: "48px 24px 64px", textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🍱</div>
        <h1 style={{ fontSize: 32, fontWeight: 900, color: C.white, letterSpacing: "-0.5px", marginBottom: 6 }}>Homely Tiffins</h1>
        <p style={{ color: "rgba(255,255,255,0.85)", fontSize: 15 }}>Fresh, home-style meals · Delivered within the society</p>
      </div>

      <div style={{ maxWidth: 480, margin: "-32px auto 0", padding: "0 16px 40px" }}>
        {!kitchenOpen ? (
          <div className="ht-card slide-in" style={{ padding: 28, textAlign: "center", marginBottom: 16, borderColor: "#FFCDD2", background: "#FFF5F5" }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>🍴</div>
            <h2 style={{ fontSize: 18, fontWeight: 800, color: "#B71C1C", marginBottom: 6 }}>Kitchen is Closed</h2>
            <p style={{ color: C.inkMid, fontSize: 14 }}>We're not accepting orders right now. Please check back later.</p>
          </div>
        ) : menuAvailable ? (
          <div className="ht-card slide-in" style={{ padding: 28, textAlign: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>🥘</div>
            <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink, marginBottom: 6 }}>Today's Menu is Ready!</h2>
            <p style={{ color: C.inkMid, fontSize: 14, marginBottom: 20 }}>{menuItems.length} delicious items available</p>
            <button className="ht-btn btn-primary btn-full btn-lg" onClick={() => setStep("order")}>🛒 Place Your Order</button>
          </div>
        ) : (
          <div className="ht-card slide-in" style={{ padding: 28, textAlign: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>⏳</div>
            <h2 style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 8 }}>Menu Not Published Yet</h2>
            <p style={{ color: C.inkMid, fontSize: 14 }}>Check back soon — today's menu will appear here once it's published.</p>
          </div>
        )}

        <div className="ht-card slide-in" style={{ padding: 20 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: C.ink, marginBottom: 12 }}>🔍 Track Your Order</h3>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="ht-input" placeholder="Your phone number" type="tel" value={lookupPhone} onChange={e => setLookupPhone(e.target.value)} style={{ flex: 1 }} />
            <button className="ht-btn btn-primary" onClick={trackOrder}>Track</button>
          </div>
        </div>

        {/* Discreet owner access link */}
        <div style={{ textAlign: "center", marginTop: 32 }}>
          <a
            href="#/owner"
            onClick={e => { e.preventDefault(); onOwnerAccess(); }}
            style={{ fontSize: 11, color: C.inkLight, textDecoration: "none", opacity: 0.5 }}
          >
            Owner Login
          </a>
        </div>

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
        <p style={{ fontSize: 12, color: C.green, fontWeight: 600 }}>✓ Delivered</p>
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
  // Orders WITHOUT special instructions get pooled together by item name.
  // Orders WITH special instructions are listed separately, never merged.
  const [prepOpen, setPrepOpen] = useState(true);
  let prepPooled = [];
  let prepSeparate = [];
  if (selectedStatus === "preparing") {
    const pool = {};
    filteredOrders.forEach(o => {
      const hasNote = o.specialInstructions && o.specialInstructions.trim().length > 0;
      if (hasNote) {
        prepSeparate.push({ orderId: o.id, items: o.items, note: o.specialInstructions.trim() });
      } else {
        o.items.forEach(i => { pool[i.name] = (pool[i.name] || 0) + i.qty; });
      }
    });
    prepPooled = Object.entries(pool).sort((a, b) => b[1] - a[1]);
  }

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
          {selectedStatus === "preparing" && filteredOrders.length > 0 && (
            <div style={{
              position: "fixed",
              bottom: prepOpen ? 16 : 16,
              left: "50%",
              transform: "translateX(-50%)",
              width: "calc(100% - 32px)",
              maxWidth: 480,
              zIndex: 50,
            }}>
              <div style={{
                background: C.white,
                borderRadius: 16,
                boxShadow: "0 6px 24px rgba(0,0,0,0.22)",
                border: `2px solid ${C.saffron}`,
                overflow: "hidden",
              }}>
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
                  <div style={{ padding: "14px 16px", maxHeight: "45vh", overflowY: "auto" }}>
                    {prepPooled.map(([name, qty]) => (
                      <div key={name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: `1px solid ${C.border}` }}>
                        <span style={{ fontSize: 14, color: C.ink, fontWeight: 600 }}>{name}</span>
                        <span style={{ fontSize: 15, color: C.saffron, fontWeight: 900 }}>×{qty}</span>
                      </div>
                    ))}

                    {prepSeparate.map(sep => (
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

                    {prepPooled.length === 0 && prepSeparate.length === 0 && (
                      <p style={{ fontSize: 12, color: C.inkLight, textAlign: "center", padding: "8px 0" }}>Nothing to prepare</p>
                    )}
                  </div>
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

function CreditLedger({ credit, onAddCredit, onResetCustomer, onDeleteCustomer }) {
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
    </div>
  );
}

// ─────────────────────────────────────────────
// BACKEND SHELL
// ─────────────────────────────────────────────
function BackendApp({ menu, todayOrders, ordersHistory, customers, credit, kitchenOpen, onSaveMenu, onAdvanceOrder, onRejectOrder, onLogout, onAddCredit, onResetCreditCustomer, onDeleteCreditCustomer, onToggleKitchen, onResetAllData }) {
  const [tab, setTab] = useState("orders");
  const pendingCount = todayOrders.filter(o => o.status === "pending").length;
  const creditAlert = credit.filter(c => c.entries.reduce((s, e) => e.type === "debit" ? s + e.amount : s - e.amount, 0) > 0).length;
  const tabs = [
    { id: "orders",   label: "📦 Orders" },
    { id: "menu",     label: "🍽️ Menu" },
    { id: "credit",   label: "📒 Credit" },
    { id: "analytics",label: "📊 Analytics" },
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
        {tab === "credit"    && <CreditLedger credit={credit} onAddCredit={onAddCredit} onResetCustomer={onResetCreditCustomer} onDeleteCustomer={onDeleteCreditCustomer} />}
        {tab === "analytics" && <AnalyticsPanel todayOrders={todayOrders} ordersHistory={ordersHistory} customers={customers} onResetAllData={onResetAllData} />}
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
  const [todayOrders, setTodayOrders] = useState([]);
  const [ordersHistory, setOrdersHistory] = useState([]); // archived past orders (~100 days)
  const [customers, setCustomers] = useState([]);
  const [credit, setCredit] = useState([]);      // permanent credit ledger
  const [kitchenOpen, setKitchenOpen] = useState(true); // owner-controlled
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
      const [m, td, cust, lastDate, cred, ko, hist] = await Promise.all([
        load(KEYS.menu),
        load(KEYS.todayOrders),
        load(KEYS.customers),
        load(KEYS.lastDate),
        load(KEYS.credit),
        load(KEYS.kitchenOpen),
        load(KEYS.ordersHistory),
      ]);

      if (m) setMenu(m);
      if (cust) setCustomers(cust);
      if (cred) setCredit(cred);
      if (hist) setOrdersHistory(hist);
      if (ko !== null && ko !== undefined) setKitchenOpen(!!ko);

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
        setTodayOrders(td || []);
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
        if (changedKey === KEYS.todayOrders) setTodayOrders(newVal || []);
        if (changedKey === KEYS.ordersHistory) setOrdersHistory(newVal || []);
        if (changedKey === KEYS.customers)   setCustomers(newVal || []);
        if (changedKey === KEYS.credit)      setCredit(newVal || []);
        if (changedKey === KEYS.kitchenOpen) setKitchenOpen(!!newVal);
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [loaded]);

  // ── New order alert sound ──
  useOrderAlert(todayOrders, route === "owner" && ownerAuthed);

  const handleSaveMenu = useCallback(async (newMenu) => {
    setMenu(newMenu); await save(KEYS.menu, newMenu);
  }, []);

  const handleToggleKitchen = useCallback(async () => {
    const next = !kitchenOpen;
    setKitchenOpen(next);
    await save(KEYS.kitchenOpen, next);
  }, [kitchenOpen]);

  const handlePlaceOrder = useCallback(async (order) => {
    const newTodayOrders = [order, ...todayOrders];
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
    const updated = todayOrders.map(o => o.id === orderId ? { ...o, status: nextStatus } : o);
    setTodayOrders(updated);
    await save(KEYS.todayOrders, updated);

    const order = todayOrders.find(o => o.id === orderId);
    if (!order) return;

    // When delivered → auto-debit credit ledger
    if (nextStatus === "delivered") {
      const orderDetails = order.items.map(i => `${i.name}×${i.qty}`).join(", ");
      setCredit(prev => {
        const next = [...prev];
        const idx = next.findIndex(c => c.phone === order.phone);
        const entry = {
          id: genId(),
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
    const updated = todayOrders.map(o => o.id === orderId ? { ...o, status: "rejected" } : o);
    setTodayOrders(updated); await save(KEYS.todayOrders, updated);
  }, [todayOrders]);

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
          orders={todayOrders}
          kitchenOpen={kitchenOpen}
          onPlaceOrder={handlePlaceOrder}
          onOwnerAccess={() => setRoute("owner")}
        />
      )}

      {route === "owner" && !ownerAuthed && (
        <OwnerLogin onSuccess={() => setOwnerAuthed(true)} />
      )}

      {route === "owner" && ownerAuthed && (
        <BackendApp
          menu={menu}
          todayOrders={todayOrders}
          ordersHistory={ordersHistory}
          customers={customers}
          credit={credit}
          kitchenOpen={kitchenOpen}
          onSaveMenu={handleSaveMenu}
          onAdvanceOrder={handleAdvanceOrder}
          onRejectOrder={handleRejectOrder}
          onLogout={handleOwnerLogout}
          onAddCredit={handleAddCredit}
          onResetCreditCustomer={handleResetCreditCustomer}
          onDeleteCreditCustomer={handleDeleteCreditCustomer}
          onToggleKitchen={handleToggleKitchen}
          onResetAllData={handleResetAllData}
        />
      )}
    </div>
  );
}
