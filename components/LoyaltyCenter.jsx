import { useState, useEffect, useCallback } from "react";

// ─────────────────────────────────────────────────────────────
// LOYALTY CENTER (owner)
// Homely Points rules, milestone rewards (points / cashback / free dish),
// customer balances and manual adjustments.
// All reads/writes go through staff_loyalty_* RPCs, which refuse non-staff
// callers inside the database. Awards are made by the database when an
// order is marked delivered — nothing here needs to run for them to happen.
// ─────────────────────────────────────────────────────────────

const DEFAULT_C = {
  saffron: "#E8781A", saffronLight: "#FDF0E4", green: "#2D6A4F", greenLight: "#ECF7F2",
  cream: "#FDFAF6", ink: "#1A1208", inkMid: "#5C4A2A", inkLight: "#A89070",
  white: "#FFFFFF", red: "#C0392B", redLight: "#FDEAEA", border: "#E8DDD0",
};

const fmtINR = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
const fmtTs = (t) => t ? new Date(t).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
const errMsg = (e) => String((e && e.message) || e || "Something went wrong").replace(/^INVALID:\s*/, "");
async function callRpc(supabase, fn, args) {
  const { data, error } = await supabase.rpc(fn, args || {});
  if (error) throw new Error(error.message || "Request failed");
  return data;
}

const KIND_LABEL = { earn: "Earned", milestone: "Milestone", redeem: "Used", refund: "Returned", reversal: "Reversed", adjust: "Adjusted" };

export function LoyaltyCenter({ supabase, C = DEFAULT_C }) {
  const [data, setData] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [openPhone, setOpenPhone] = useState(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const d = await callRpc(supabase, "staff_loyalty_get");
      setData(d);
      setCfg(JSON.parse(JSON.stringify(d.config || {})));
    } catch (e) { setError(errMsg(e)); }
  }, [supabase]);
  useEffect(() => { load(); }, [load]);

  const card = { background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 12 };
  const label = { fontSize: 12, fontWeight: 700, color: C.inkMid, display: "block", marginBottom: 4 };
  const input = { width: "100%", boxSizing: "border-box", border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 10px", fontSize: 14, fontFamily: "inherit", color: C.ink, background: C.white };
  const num = (v) => (v === "" || v === null || v === undefined ? "" : Number(v));

  if (error && !data) return <div style={{ ...card, marginTop: 16, color: C.red }}>{error} <button className="ht-btn btn-sm" onClick={load}>Retry</button></div>;
  if (!data || !cfg) return <div style={{ padding: 28, textAlign: "center", color: C.inkMid }}>Loading…</div>;

  const earn = cfg.earn || {};
  const setEarn = (k, v) => setCfg(c => ({ ...c, earn: { ...(c.earn || {}), [k]: v } }));
  const milestones = cfg.milestones || [];
  const setMs = (i, k, v) => setCfg(c => ({ ...c, milestones: c.milestones.map((m, j) => j === i ? { ...m, [k]: v } : m) }));
  const variants = data.variants || [];

  const save = async () => {
    setSaving(true); setError("");
    try {
      const saved = await callRpc(supabase, "staff_loyalty_save", { p_config: cfg });
      setCfg(saved); setSavedAt(Date.now());
      load();
    } catch (e) { setError(errMsg(e)); }
    setSaving(false);
  };

  const t = data.totals || {};
  const customers = (data.customers || []).filter(c => {
    const q = search.trim().toLowerCase();
    return !q || (c.name || "").toLowerCase().includes(q) || (c.phone || "").includes(q) || `${c.tower} ${c.flat}`.toLowerCase().includes(q);
  });

  return (
    <div style={{ paddingTop: 16 }}>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink, marginBottom: 4 }}>🎁 Homely Loyalty</h2>
      <p style={{ fontSize: 12.5, color: C.inkMid, marginBottom: 14 }}>
        Customers see their points in My Homely and can use them at checkout. Rewards are added automatically when you mark an order delivered.
      </p>

      {/* Totals */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8, marginBottom: 12 }}>
        {[
          ["Points outstanding", `${t.outstanding || 0}`, cfg.pointValue ? `≈ ${fmtINR((t.outstanding || 0) * cfg.pointValue)}` : ""],
          ["Points earned", `${t.earned || 0}`, ""],
          ["Points used", `${t.redeemed || 0}`, ""],
          ["Free meals waiting", `${t.vouchersAvailable || 0}`, ""],
          ["Cashback given", fmtINR(t.cashbackGiven), "on credit ledger"],
          ["My Homely accounts", `${t.accounts || 0}`, ""],
        ].map(([l, v, s]) => (
          <div key={l} style={{ ...card, marginBottom: 0, padding: 12 }}>
            <div style={{ fontSize: 11, color: C.inkMid, fontWeight: 700 }}>{l}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.ink }}>{v}</div>
            {s && <div style={{ fontSize: 11, color: C.inkLight }}>{s}</div>}
          </div>
        ))}
      </div>

      {/* Settings */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: C.ink }}>Loyalty programme</div>
            <div style={{ fontSize: 12, color: C.inkMid }}>
              {cfg.startedAt ? `Running since ${fmtTs(cfg.startedAt)} — only orders placed after this earn.` : "Orders placed after you first switch this on will earn."}
            </div>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 800, fontSize: 13, color: cfg.enabled ? C.green : C.inkMid, cursor: "pointer" }}>
            <input type="checkbox" checked={!!cfg.enabled} onChange={e => setCfg(c => ({ ...c, enabled: e.target.checked }))} style={{ width: 18, height: 18, accentColor: C.saffron }} />
            {cfg.enabled ? "On" : "Off"}
          </label>
        </div>

        <div style={{ fontSize: 13, fontWeight: 800, color: C.ink, margin: "6px 0 8px" }}>1. Points on every order</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {[["per_order", "Per order"], ["per_amount", "Per ₹ spent"], ["off", "No points per order"]].map(([k, l]) => (
            <button key={k} className="ht-btn btn-sm" onClick={() => setEarn("mode", k)}
              style={{ background: earn.mode === k ? C.saffron : C.white, color: earn.mode === k ? C.white : C.ink, border: `1px solid ${earn.mode === k ? C.saffron : C.border}` }}>{l}</button>
          ))}
        </div>
        {earn.mode === "per_order" && (
          <div style={{ maxWidth: 220, marginBottom: 10 }}>
            <label style={label}>Points per delivered order</label>
            <input style={input} type="number" min="0" value={num(earn.pointsPerOrder)} onChange={e => setEarn("pointsPerOrder", e.target.value)} />
          </div>
        )}
        {earn.mode === "per_amount" && (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 10, flexWrap: "wrap" }}>
            <div style={{ width: 110 }}><label style={label}>Points</label><input style={input} type="number" min="0" value={num(earn.pointsPerStep)} onChange={e => setEarn("pointsPerStep", e.target.value)} /></div>
            <div style={{ paddingBottom: 9, color: C.inkMid, fontSize: 13 }}>for every ₹</div>
            <div style={{ width: 110 }}><label style={label}>Amount</label><input style={input} type="number" min="1" value={num(earn.rupeesStep)} onChange={e => setEarn("rupeesStep", e.target.value)} /></div>
            <div style={{ paddingBottom: 9, color: C.inkMid, fontSize: 13 }}>paid</div>
          </div>
        )}

        <div style={{ fontSize: 13, fontWeight: 800, color: C.ink, margin: "14px 0 8px" }}>2. Using points at checkout</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginBottom: 6 }}>
          <div><label style={label}>1 point = ₹</label><input style={input} type="number" min="0.01" step="0.01" value={num(cfg.pointValue)} onChange={e => setCfg(c => ({ ...c, pointValue: e.target.value }))} /></div>
          <div><label style={label}>Minimum points to use</label><input style={input} type="number" min="0" value={num(cfg.minRedeem)} onChange={e => setCfg(c => ({ ...c, minRedeem: e.target.value }))} /></div>
          <div><label style={label}>Max % of an order</label><input style={input} type="number" min="0" max="100" value={num(cfg.maxRedeemPct)} onChange={e => setCfg(c => ({ ...c, maxRedeemPct: e.target.value }))} /></div>
        </div>

        <div style={{ fontSize: 13, fontWeight: 800, color: C.ink, margin: "14px 0 4px" }}>3. Milestone rewards</div>
        <div style={{ fontSize: 12, color: C.inkMid, marginBottom: 8 }}>Counted on delivered orders. Cashback is added to the customer's credit ledger.</div>
        {milestones.map((m, i) => (
          <div key={m.id || i} style={{ border: `1px dashed ${C.border}`, borderRadius: 10, padding: 10, marginBottom: 8, background: C.cream }}>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ width: 90 }}><label style={label}>Orders</label><input style={input} type="number" min="1" value={num(m.orders)} onChange={e => setMs(i, "orders", e.target.value)} /></div>
              <div style={{ width: 150 }}>
                <label style={label}>Reward</label>
                <select style={input} value={m.type || "points"} onChange={e => setMs(i, "type", e.target.value)}>
                  <option value="points">Homely Points</option>
                  <option value="cashback">Cashback (₹)</option>
                  <option value="free_dish">Free dish</option>
                </select>
              </div>
              {(m.type || "points") === "points" && <div style={{ width: 100 }}><label style={label}>Points</label><input style={input} type="number" min="1" value={num(m.points)} onChange={e => setMs(i, "points", e.target.value)} /></div>}
              {m.type === "cashback" && <div style={{ width: 100 }}><label style={label}>₹</label><input style={input} type="number" min="1" value={num(m.amount)} onChange={e => setMs(i, "amount", e.target.value)} /></div>}
              {m.type === "free_dish" && (
                <div style={{ width: 190 }}>
                  <label style={label}>Dish</label>
                  <select style={input} value={m.variant || ""} onChange={e => setMs(i, "variant", e.target.value)}>
                    <option value="">Choose…</option>
                    {variants.map(v => <option key={v.variant} value={v.variant}>{v.label}</option>)}
                  </select>
                </div>
              )}
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: C.inkMid, paddingBottom: 9 }}>
                <input type="checkbox" checked={!!m.repeat} onChange={e => setMs(i, "repeat", e.target.checked)} style={{ accentColor: C.saffron }} />
                Every {m.orders || "N"} orders
              </label>
              <button className="ht-btn btn-ghost btn-sm" style={{ marginLeft: "auto", color: C.red }} onClick={() => setCfg(c => ({ ...c, milestones: c.milestones.filter((_, j) => j !== i) }))}>Remove</button>
            </div>
          </div>
        ))}
        <button className="ht-btn btn-secondary btn-sm" onClick={() => setCfg(c => ({ ...c, milestones: [...(c.milestones || []), { orders: 10, type: "points", points: 100, repeat: true }] }))}>+ Add milestone</button>

        {error && <div style={{ background: C.redLight, color: C.red, borderRadius: 8, padding: "8px 10px", fontSize: 13, marginTop: 12 }}>{error}</div>}
        <button className="ht-btn btn-primary btn-full" style={{ marginTop: 14 }} onClick={save} disabled={saving}>
          {saving ? "Saving…" : savedAt ? "Saved ✓ — Save again" : "Save loyalty settings"}
        </button>
      </div>

      {/* Balances */}
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.ink }}>Customer points</div>
          <input style={{ ...input, width: 200 }} placeholder="Search name / phone / flat" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <AdjustForm supabase={supabase} C={C} input={input} label={label} onDone={load} />
        {customers.length === 0 ? (
          <div style={{ fontSize: 13, color: C.inkMid, padding: "10px 0" }}>No points or rewards yet.</div>
        ) : customers.map(c => (
          <div key={c.phone} style={{ borderTop: `1px solid ${C.border}` }}>
            <button onClick={() => setOpenPhone(p => p === c.phone ? null : c.phone)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "10px 0", border: "none", background: "none", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: C.ink }}>{c.name || "—"} {c.hasAccount && <span style={{ fontSize: 10, color: C.green, fontWeight: 800 }}>● My Homely</span>}</div>
                <div style={{ fontSize: 12, color: C.inkMid }}>{c.phone}{c.tower ? ` · ${c.tower}` : ""}{c.flat ? ` · ${c.flat}` : ""}</div>
              </div>
              {c.vouchers > 0 && <span style={{ fontSize: 11, fontWeight: 800, color: "#6A1B9A" }}>🍱 {c.vouchers}</span>}
              <div style={{ fontWeight: 800, fontSize: 15, color: C.saffron, minWidth: 60, textAlign: "right" }}>{c.balance} pts</div>
            </button>
            {openPhone === c.phone && <CustomerHistory supabase={supabase} C={C} phone={c.phone} onChanged={load} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function AdjustForm({ supabase, C, input, label, onDone, phone: fixedPhone }) {
  const [phone, setPhone] = useState(fixedPhone || "");
  const [points, setPoints] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const submit = async (sign) => {
    const n = Math.abs(parseInt(points, 10) || 0);
    if (!n) { setMsg("Enter the number of points."); return; }
    setBusy(true); setMsg("");
    try {
      const r = await callRpc(supabase, "staff_loyalty_adjust", { p_phone: phone, p_points: sign * n, p_note: note });
      setMsg(`Done — new balance ${r.balance} pts`);
      setPoints(""); setNote("");
      onDone && onDone();
    } catch (e) { setMsg(errMsg(e)); }
    setBusy(false);
  };
  return (
    <div style={{ background: C.cream, borderRadius: 10, padding: 10, marginBottom: 10 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        {!fixedPhone && <div style={{ width: 140 }}><label style={label}>Phone</label><input style={input} type="tel" maxLength={10} value={phone} onChange={e => setPhone(e.target.value)} /></div>}
        <div style={{ width: 90 }}><label style={label}>Points</label><input style={input} type="number" min="1" value={points} onChange={e => setPoints(e.target.value)} /></div>
        <div style={{ flex: 1, minWidth: 140 }}><label style={label}>Reason (shown to customer)</label><input style={input} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Sorry for the late delivery" /></div>
        <button className="ht-btn btn-primary btn-sm" disabled={busy} onClick={() => submit(1)}>+ Add</button>
        <button className="ht-btn btn-secondary btn-sm" disabled={busy} onClick={() => submit(-1)}>− Deduct</button>
      </div>
      {msg && <div style={{ fontSize: 12, color: C.inkMid, marginTop: 6 }}>{msg}</div>}
    </div>
  );
}

function CustomerHistory({ supabase, C, phone, onChanged }) {
  const [h, setH] = useState(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    callRpc(supabase, "staff_loyalty_history", { p_phone: phone }).then(setH).catch(e => setErr(errMsg(e)));
  }, [supabase, phone]);
  useEffect(() => { load(); }, [load]);
  const setVoucher = async (id, status) => {
    try { await callRpc(supabase, "staff_voucher_set", { p_id: id, p_status: status }); load(); onChanged && onChanged(); }
    catch (e) { setErr(errMsg(e)); }
  };
  if (err) return <div style={{ color: C.red, fontSize: 12, paddingBottom: 10 }}>{err}</div>;
  if (!h) return <div style={{ color: C.inkMid, fontSize: 12, paddingBottom: 10 }}>Loading…</div>;
  return (
    <div style={{ padding: "0 0 12px 8px" }}>
      {(h.vouchers || []).length > 0 && (
        <div style={{ marginBottom: 8 }}>
          {h.vouchers.map(v => (
            <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "3px 0" }}>
              <span style={{ flex: 1 }}>🍱 {v.label} · <b>{v.status}</b> {v.used_order_id ? `(order #${String(v.used_order_id).slice(-6).toUpperCase()})` : ""}</span>
              {v.status === "available" && <button className="ht-btn btn-ghost btn-sm" onClick={() => setVoucher(v.id, "used")}>Mark used</button>}
              {v.status === "available" && <button className="ht-btn btn-ghost btn-sm" style={{ color: C.red }} onClick={() => setVoucher(v.id, "void")}>Cancel</button>}
              {v.status !== "available" && <button className="ht-btn btn-ghost btn-sm" onClick={() => setVoucher(v.id, "available")}>Make available</button>}
            </div>
          ))}
        </div>
      )}
      {(h.history || []).map(l => (
        <div key={l.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5, padding: "3px 0", color: C.inkMid }}>
          <span>{fmtTs(l.created_at)} · {KIND_LABEL[l.kind] || l.kind}{l.note ? ` — ${l.note}` : ""}{l.order_id ? ` (#${String(l.order_id).slice(-6).toUpperCase()})` : ""}</span>
          <b style={{ color: l.points >= 0 ? C.green : C.red, whiteSpace: "nowrap" }}>{l.points >= 0 ? "+" : ""}{l.points}</b>
        </div>
      ))}
    </div>
  );
}
