import { useState } from "react";

// ── Homely Tiffins color palette (matches the live app) ──
const C = {
  saffron: "#E8781A", saffronLight: "#FDF0E4", saffronMid: "#F4A455",
  green: "#2D6A4F", greenLight: "#ECF7F2",
  cream: "#FDFAF6", ink: "#1A1208", inkMid: "#5C4A2A", inkLight: "#A89070",
  white: "#FFFFFF", red: "#C0392B", redLight: "#FDEAEA",
  border: "#E8DDD0",
};

// ── Mock data (this is what the owner would publish from the Plans tab) ──
const planConfig = {
  sabjis: [
    { id: "s1", name: "Dal Tadka", premium: false },
    { id: "s2", name: "Aloo Gobi", premium: false },
    { id: "s3", name: "Paneer Butter Masala", premium: true },
  ],
  rice: "Jeera Rice",
  salad: "Kachumber Salad",
  raita: "Boondi Raita",
  sweet: "Gulab Jamun",
  prices: { gold: 199, standard: 120, mini: 80, raita: 30, salad: 20, sweet: 30 },
};

const menuItems = [
  { id: "m1", name: "Extra Roti", price: 10 },
  { id: "m2", name: "Papad", price: 8 },
];

const BREAD_CHOICES = [
  { id: "chapati4", label: "4 Ghee Chapati" },
  { id: "paratha3", label: "3 Ghee Paratha" },
];

const btnStyle = (variant) => {
  const base = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: 8, fontWeight: 700, cursor: "pointer", border: "none", transition: "all 0.15s", letterSpacing: 0.2 };
  if (variant === "primary") return { ...base, background: C.saffron, color: C.white };
  if (variant === "secondary") return { ...base, background: C.white, color: C.ink, border: `1.5px solid ${C.border}` };
  if (variant === "ghost") return { ...base, background: "transparent", color: C.inkMid };
  return base;
};

function Card({ children, style }) {
  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 14, boxShadow: "0 2px 12px rgba(26,18,8,0.06)", ...style }}>
      {children}
    </div>
  );
}

function QtyStepper({ qty, onDec, onInc, size = 32 }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <button onClick={onDec} style={{ ...btnStyle("secondary"), width: size, height: size, padding: 0, borderRadius: "50%", fontSize: 18 }}>−</button>
      <span style={{ fontSize: 15, fontWeight: 700, minWidth: 20, textAlign: "center", color: C.ink }}>{qty}</span>
      <button onClick={onInc} style={{ ...btnStyle("primary"), width: size, height: size, padding: 0, borderRadius: "50%", fontSize: 18 }}>+</button>
    </div>
  );
}

function PlanChoiceModal({ plan, onAdd, onClose }) {
  const sabjis = planConfig.sabjis;
  const isGold = plan === "gold";
  const [bread, setBread] = useState(BREAD_CHOICES[0].id);
  const [sabjiSel, setSabjiSel] = useState([]);
  const [sweetOrRaita, setSweetOrRaita] = useState("raita");
  const [miniSabji, setMiniSabji] = useState(sabjis[0].id);

  const toggleSabji = (id) => {
    setSabjiSel((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return prev;
      return [...prev, id];
    });
  };

  const goldValid = sabjiSel.length === 2;
  const miniValid = !!miniSabji;

  const handleAdd = () => {
    if (isGold) {
      if (!goldValid) return;
      const breadLabel = BREAD_CHOICES.find((b) => b.id === bread).label;
      const chosen = sabjis.filter((s) => sabjiSel.includes(s.id));
      const srLabel = sweetOrRaita === "raita" ? planConfig.raita : planConfig.sweet;
      const id = `gold:${bread}:${sabjiSel.slice().sort().join("+")}:${sweetOrRaita}`;
      const name = `Homely Gold — ${breadLabel}, ${chosen.map((s) => s.name).join(" + ")}, ${planConfig.rice}, ${srLabel}, ${planConfig.salad}`;
      onAdd(id, name, planConfig.prices.gold);
    } else {
      if (!miniValid) return;
      const sabji = sabjis.find((s) => s.id === miniSabji);
      const id = `mini:${miniSabji}`;
      const name = `Homely Mini — 4 Chapati, ${sabji.name}, ${planConfig.salad}`;
      onAdd(id, name, planConfig.prices.mini);
    }
  };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(26,18,8,0.45)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 200 }}
    >
      <div style={{ background: C.white, borderRadius: "20px 20px 0 0", padding: "20px 20px 28px", width: "100%", maxWidth: 480, maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ width: 40, height: 4, borderRadius: 2, background: C.border, margin: "0 auto 20px" }} />
        <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink, marginBottom: 4 }}>{isGold ? "✨ Homely Gold" : "Homely Mini"}</h2>
        <p style={{ fontSize: 13, color: C.inkMid, marginBottom: 18 }}>Customize your thali</p>

        {isGold && (
          <>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: C.ink, display: "block", marginBottom: 8 }}>Choose Bread</label>
              {BREAD_CHOICES.map((b) => (
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
              {sabjis.map((s) => {
                const disabled = !sabjiSel.includes(s.id) && sabjiSel.length >= 2;
                return (
                  <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", fontSize: 14, color: C.ink, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1 }}>
                    <input type="checkbox" checked={sabjiSel.includes(s.id)} disabled={disabled} onChange={() => toggleSabji(s.id)} style={{ accentColor: C.saffron, width: 16, height: 16 }} />
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
            <div style={{ background: C.cream, borderRadius: 8, padding: "10px 12px", fontSize: 12, color: C.inkMid, marginBottom: 16 }}>
              Also includes: {planConfig.rice} &amp; {planConfig.salad}
            </div>
          </>
        )}

        {!isGold && (
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 12, fontWeight: 700, color: C.ink, display: "block", marginBottom: 8 }}>Choose 1 Sabji</label>
            {sabjis.slice(0, 2).map((s) => (
              <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", fontSize: 14, color: C.ink, cursor: "pointer" }}>
                <input type="radio" name="miniSabji" checked={miniSabji === s.id} onChange={() => setMiniSabji(s.id)} style={{ accentColor: C.saffron, width: 16, height: 16 }} />
                {s.name}
              </label>
            ))}
            <div style={{ background: C.cream, borderRadius: 8, padding: "10px 12px", fontSize: 12, color: C.inkMid, marginTop: 8 }}>
              Also includes: 4 Chapati &amp; {planConfig.salad}
            </div>
          </div>
        )}

        <button style={{ ...btnStyle("primary"), width: "100%", padding: "14px", fontSize: 15, opacity: (isGold ? !goldValid : !miniValid) ? 0.5 : 1 }} disabled={isGold ? !goldValid : !miniValid} onClick={handleAdd}>
          Add to Cart · ₹{isGold ? planConfig.prices.gold : planConfig.prices.mini}
        </button>
        <button style={{ ...btnStyle("ghost"), width: "100%", padding: "10px", fontSize: 13, marginTop: 8 }} onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

export default function OrderScreenPreview() {
  const [cart, setCart] = useState({});
  const [planCartMeta, setPlanCartMeta] = useState({});
  const [planChoiceModal, setPlanChoiceModal] = useState(null);

  const sabjis = planConfig.sabjis;
  const standardItem = {
    id: "plan-standard",
    name: `Homely Standard — 4 Chapati, ${sabjis[0].name} + ${sabjis[1].name}, Steamed Rice, ${planConfig.salad}`,
    price: planConfig.prices.standard,
  };
  const extraItems = [
    { id: "extra-raita", name: `${planConfig.raita} (Raita of the Day)`, price: planConfig.prices.raita },
    { id: "extra-salad", name: `${planConfig.salad} (Salad of the Day)`, price: planConfig.prices.salad },
    { id: "extra-sweet", name: `${planConfig.sweet} (Sweet of the Day)`, price: planConfig.prices.sweet },
  ];

  const allSellableItems = [
    ...menuItems,
    ...extraItems,
    standardItem,
    ...Object.entries(planCartMeta).map(([id, m]) => ({ id, name: m.name, price: m.price })),
  ];

  const setQty = (id, delta) =>
    setCart((prev) => {
      const next = { ...prev, [id]: Math.max(0, (prev[id] || 0) + delta) };
      if (next[id] === 0) delete next[id];
      return next;
    });

  const addPlanToCart = (id, name, price) => {
    setPlanCartMeta((prev) => ({ ...prev, [id]: { name, price } }));
    setCart((prev) => ({ ...prev, [id]: (prev[id] || 0) + 1 }));
    setPlanChoiceModal(null);
  };

  const cartTotal = Object.entries(cart).reduce((sum, [id, qty]) => {
    const item = allSellableItems.find((i) => i.id === id);
    return sum + (item ? item.price * qty : 0);
  }, 0);
  const cartCount = Object.values(cart).reduce((a, b) => a + b, 0);

  return (
    <div style={{ minHeight: "100vh", background: C.cream, padding: "24px 16px", fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
      <div style={{ maxWidth: 480, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <button style={{ ...btnStyle("ghost"), padding: "8px 10px", fontSize: 13 }}>← Back</button>
          <h1 style={{ fontSize: 20, fontWeight: 800, color: C.ink }}>Today's Menu</h1>
          <span style={{ marginLeft: "auto", fontSize: 12, color: C.inkLight }}>19 Jul 2026</span>
        </div>

        {/* MEAL PLANS */}
        <div style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 14, fontWeight: 800, color: C.ink, marginBottom: 10 }}>🍽️ Meal Plans</h2>
          <Card style={{ padding: 0, marginBottom: 10, overflow: "hidden" }}>
            <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: C.ink }}>✨ Homely Gold</div>
                  <div style={{ fontSize: 12, color: C.inkMid, marginTop: 4, lineHeight: 1.5 }}>
                    Choice of 2 sabjis · Choice of bread (4 chapati / 3 paratha) · {planConfig.rice} · Choice of {planConfig.raita} or {planConfig.sweet} · {planConfig.salad}
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: C.saffron, marginBottom: 6 }}>₹{planConfig.prices.gold}</div>
                  <button style={{ ...btnStyle("primary"), padding: "8px 14px", fontSize: 13 }} onClick={() => setPlanChoiceModal("gold")}>+ Add</button>
                </div>
              </div>
            </div>
            <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: C.ink }}>Homely Standard</div>
                  <div style={{ fontSize: 12, color: C.inkMid, marginTop: 4, lineHeight: 1.5 }}>
                    4 Chapati · {sabjis[0].name} + {sabjis[1].name} (fixed) · Steamed Rice · {planConfig.salad}
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: C.saffron, marginBottom: 6 }}>₹{planConfig.prices.standard}</div>
                  <QtyStepper size={28} qty={cart[standardItem.id] || 0} onDec={() => setQty(standardItem.id, -1)} onInc={() => setQty(standardItem.id, 1)} />
                </div>
              </div>
            </div>
            <div style={{ padding: "16px 20px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: C.ink }}>Homely Mini</div>
                  <div style={{ fontSize: 12, color: C.inkMid, marginTop: 4, lineHeight: 1.5 }}>
                    4 Chapati · Choice of 1 sabji (of 2) · {planConfig.salad}
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: C.saffron, marginBottom: 6 }}>₹{planConfig.prices.mini}</div>
                  <button style={{ ...btnStyle("primary"), padding: "8px 14px", fontSize: 13 }} onClick={() => setPlanChoiceModal("mini")}>+ Add</button>
                </div>
              </div>
            </div>
          </Card>

          {Object.entries(planCartMeta).filter(([id]) => cart[id]).length > 0 && (
            <Card style={{ padding: 20 }}>
              <h3 style={{ fontSize: 12, fontWeight: 700, color: C.ink, marginBottom: 10 }}>Your Selections</h3>
              {Object.entries(planCartMeta).filter(([id]) => cart[id]).map(([id, m]) => (
                <div key={id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ flex: 1, paddingRight: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{m.name}</div>
                    <div style={{ fontSize: 12, color: C.saffron, fontWeight: 700 }}>₹{m.price}</div>
                  </div>
                  <QtyStepper size={28} qty={cart[id] || 0} onDec={() => setQty(id, -1)} onInc={() => setQty(id, 1)} />
                </div>
              ))}
            </Card>
          )}
        </div>

        {/* EXTRAS */}
        <div style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 14, fontWeight: 800, color: C.ink, marginBottom: 10 }}>🥗 Today's Extras</h2>
          <Card style={{ padding: 20 }}>
            {extraItems.map((item) => (
              <div key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>{item.name}</div>
                  <div style={{ fontSize: 13, color: C.saffron, fontWeight: 700 }}>₹{item.price}</div>
                </div>
                <QtyStepper qty={cart[item.id] || 0} onDec={() => setQty(item.id, -1)} onInc={() => setQty(item.id, 1)} />
              </div>
            ))}
          </Card>
        </div>

        {/* À LA CARTE */}
        <div style={{ marginBottom: cartCount > 0 ? 90 : 20 }}>
          <h2 style={{ fontSize: 14, fontWeight: 800, color: C.ink, marginBottom: 10 }}>🍛 À la carte</h2>
          <Card style={{ padding: 20 }}>
            {menuItems.map((item) => (
              <div key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 0", borderBottom: `1px solid ${C.border}` }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>{item.name}</div>
                  <div style={{ fontSize: 13, color: C.saffron, fontWeight: 700 }}>₹{item.price}</div>
                </div>
                <QtyStepper qty={cart[item.id] || 0} onDec={() => setQty(item.id, -1)} onInc={() => setQty(item.id, 1)} />
              </div>
            ))}
          </Card>
        </div>
      </div>

      {/* Sticky cart bar */}
      {cartCount > 0 && (
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: C.white, borderTop: `1px solid ${C.border}`, padding: "14px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "0 -4px 20px rgba(0,0,0,0.08)", zIndex: 100 }}>
          <div>
            <div style={{ fontSize: 13, color: C.inkMid }}>{cartCount} item{cartCount > 1 ? "s" : ""}</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: C.ink }}>₹{cartTotal}</div>
          </div>
          <button style={{ ...btnStyle("primary"), padding: "12px 22px", fontSize: 15 }}>Proceed to Order →</button>
        </div>
      )}

      {planChoiceModal && (
        <PlanChoiceModal plan={planChoiceModal} onAdd={addPlanToCart} onClose={() => setPlanChoiceModal(null)} />
      )}
    </div>
  );
}
