import { useState, useEffect, useMemo, useCallback, createContext, useContext } from "react";

// ─────────────────────────────────────────────────────────────
// CUSTOMER HUB
// Customer profiles, confirmed preferences, reactivation, the customer-facing
// preference form and the customer insights report.
//
// All data access goes through Supabase RPCs (see supabase/migrations). Staff
// functions refuse non-staff callers inside the database (not just here), and
// the customer form only ever talks to token-checked RPCs.
// ─────────────────────────────────────────────────────────────

const DEFAULT_C = {
  saffron: "#E8781A", saffronLight: "#FDF0E4", saffronMid: "#F4A455",
  green: "#2D6A4F", greenLight: "#ECF7F2",
  cream: "#FDFAF6", ink: "#1A1208", inkMid: "#5C4A2A", inkLight: "#A89070",
  white: "#FFFFFF", red: "#C0392B", redLight: "#FDEAEA",
  border: "#E8DDD0", shadow: "0 2px 12px rgba(26,18,8,0.08)",
};
const ThemeCtx = createContext(DEFAULT_C);
const useC = () => useContext(ThemeCtx);

// ── labels ──
const BUCKET_LABEL = {
  active_0_6: "0–6 days", inactive_7_13: "7–13 days inactive",
  inactive_14_plus: "14+ days inactive", no_delivered: "No delivered orders",
};
const VARIANT_LABEL = {
  mini: "Homely Mini", standard: "Homely Standard", goldMini: "Homely Gold Mini",
  goldMedium: "Homely Gold (Medium)", goldLarge: "Homely Gold (Large)", extra: "Extras only", unknown: "Unknown",
};
const SOURCE_LABEL = {
  staff: "Staff", customer_form_staff_link: "Customer form (link shared by staff)",
  customer_form_order_link: "Customer form (from order page)", merge: "Carried over by merge",
};
const FIELD_LABEL = {
  fav_dishes: "Favourite sabjis / dals", fav_sides: "Favourite sides", disliked_dishes: "Disliked dishes",
  spice: "Spice level", oil: "Oil", bread_pref: "Roti / paratha / rice", portion_pref: "Portion",
  usual_meal: "Usual meal", reason_stopped: "Reason for stopping orders", away_until: "Away until", follow_up_date: "Preferred follow-up date",
};
const OPTIONS = {
  spice: [["mild", "Mild"], ["medium", "Medium"], ["spicy", "Spicy"]],
  oil: [["less_oil", "Less oil"], ["regular", "Regular"]],
  bread_pref: [["roti", "Roti"], ["paratha", "Paratha"], ["rice", "Rice"], ["no_preference", "No preference"]],
  portion_pref: [["smaller", "Smaller"], ["regular", "Regular"], ["larger", "Larger"]],
  usual_meal: [["lunch", "Lunch"], ["dinner", "Dinner"], ["both", "Both"]],
};
const optLabel = (field, v) => (OPTIONS[field] || []).find(o => o[0] === v)?.[1] || v;
const CATEGORY_LABEL = { sabji: "Sabji", dal: "Dal", rice: "Rice", raita: "Raita", sweet: "Sweet", salad: "Salad", bread: "Bread", other: "Other" };

// ── helpers ──
const fmtINR = (n) => n === null || n === undefined || n === "" ? "—" : "₹" + Math.round(Number(n)).toLocaleString("en-IN");
const fmtD = (d) => {
  if (!d) return "—";
  const dt = new Date(String(d).length <= 10 ? d + "T00:00:00" : d);
  return isNaN(dt) ? String(d) : dt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: String(d).length <= 10 ? undefined : "Asia/Kolkata" });
};
const fmtTs = (t) => t ? new Date(t).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) + " IST" : "—";
const firstName = (n) => (n || "").trim().split(/\s+/)[0] || "there";
const errMsg = (e) => (e && e.message) ? e.message : String(e || "Something went wrong");
async function callRpc(supabase, fn, args) {
  const { data, error } = await supabase.rpc(fn, args || {});
  if (error) throw new Error(error.message || "Request failed");
  return data;
}
function nowLocalInput() {
  const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    try {
      const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); const ok = document.execCommand("copy"); document.body.removeChild(ta); return ok;
    } catch { return false; }
  }
}

// ── tiny UI kit (matches the app's existing look) ──
function Card({ children, style }) { return <div className="ht-card" style={{ padding: 16, marginBottom: 12, ...style }}>{children}</div>; }
function H({ children, sub, right }) {
  const C = useC();
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 10 }}>
      <div>
        <h3 style={{ fontSize: 15, fontWeight: 800, color: C.ink, margin: 0 }}>{children}</h3>
        {sub && <p style={{ fontSize: 11.5, color: C.inkLight, margin: "3px 0 0", lineHeight: 1.45 }}>{sub}</p>}
      </div>
      {right}
    </div>
  );
}
function Pill({ children, tone = "neutral", style }) {
  const C = useC();
  const tones = {
    neutral: [C.cream, C.inkMid, C.border], green: ["#E8F5E9", "#2E7D32", "#A5D6A7"], amber: ["#FFF3CD", "#856404", "#F3D98B"],
    red: [C.redLight, C.red, "#F2B8B5"], blue: ["#E3F2FD", "#0D47A1", "#B6D4F5"], saffron: [C.saffronLight, C.saffron, "#F4C79A"],
  };
  const [bg, fg, bd] = tones[tone] || tones.neutral;
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 9px", borderRadius: 999, fontSize: 11, fontWeight: 700, background: bg, color: fg, border: `1px solid ${bd}`, whiteSpace: "nowrap", ...style }}>{children}</span>;
}
const bucketTone = (b) => b === "active_0_6" ? "green" : b === "inactive_7_13" ? "amber" : b === "inactive_14_plus" ? "red" : "neutral";

// ── delete / copy inactive customers (7–13 and 14+ days) ──
// Server re-checks the bucket and archives the profile (customer_archive) before deleting;
// orders and credit ledger are kept.
const isInactive = (c) => c && (c.bucket === "inactive_7_13" || c.bucket === "inactive_14_plus");
const DELETE_WARNING = "\n\nThis removes their customer profile, notes, contact log, preferences and form links (a backup copy is archived). Their past orders and credit ledger are kept. They reappear automatically if they place a new order.";
async function deleteInactive(supabase, rows, label) {
  rows = (rows || []).filter(isInactive);
  if (!rows.length) return null;
  const q = rows.length === 1 ? `Delete ${rows[0].name || "this customer"} (${rows[0].days_since}d inactive)?` : `Delete ${rows.length} customers from "${label}"?`;
  if (!window.confirm(q + DELETE_WARNING)) return null;
  const out = { deleted: 0, skipped: 0 };
  for (const b of ["inactive_7_13", "inactive_14_plus"]) {
    const ids = rows.filter(c => c.bucket === b).map(c => c.id);
    if (!ids.length) continue;
    const r = await callRpc(supabase, "staff_delete_inactive_customers", { p_bucket: b, p_ids: ids });
    out.deleted += r.deleted || 0; out.skipped += r.skipped || 0;
  }
  return out;
}
const deleteResultText = (r) => `Deleted ${r.deleted} customer(s)${r.skipped ? `; ${r.skipped} skipped (order in progress or no longer inactive)` : ""}.`;
const inactiveListText = (title, rows) => `${title} (${rows.length})\n` + rows.map(c => [c.name || "(no name)", c.phone || "", [c.tower, c.flat].filter(Boolean).join(" "), `${c.delivered_orders} orders`, fmtINR(c.net_spend), `last ${fmtD(c.last_delivered)} (${c.days_since}d)`].join(" | ")).join("\n");

// "Copy list" + "Delete all" for a list of inactive customers. onDone(text, changed) reports the result.
function InactiveListActions({ supabase, rows, title, onDone }) {
  const [busy, setBusy] = useState(false); const [copied, setCopied] = useState(false);
  rows = (rows || []).filter(isInactive);
  const copy = async () => {
    const ok = await copyText(inactiveListText(title, rows));
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000); } else onDone && onDone("Could not copy automatically.", false);
  };
  const del = async () => {
    setBusy(true);
    try { const r = await deleteInactive(supabase, rows, title); if (r) onDone && onDone(deleteResultText(r), r.deleted > 0); }
    catch (e) { onDone && onDone("Delete failed: " + errMsg(e), false); }
    setBusy(false);
  };
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      <button className="ht-btn btn-ghost btn-sm" disabled={!rows.length} onClick={copy}>{copied ? "✓ Copied" : `Copy list (${rows.length})`}</button>
      <button className="ht-btn btn-ghost btn-sm" style={{ color: "#B3261E" }} disabled={!rows.length || busy} onClick={del}>{busy ? "Deleting…" : `Delete all (${rows.length})`}</button>
    </div>
  );
}
// Per-customer delete button; renders nothing for customers that are not inactive.
function DeleteCustomerBtn({ supabase, c, onDone, label = "Delete", style }) {
  const [busy, setBusy] = useState(false);
  if (!isInactive(c)) return null;
  const del = async (e) => {
    e.stopPropagation(); setBusy(true);
    try { const r = await deleteInactive(supabase, [c], ""); if (r) onDone && onDone(deleteResultText(r), r.deleted > 0); }
    catch (err) { onDone && onDone("Delete failed: " + errMsg(err), false); }
    setBusy(false);
  };
  return <button className="ht-btn btn-ghost btn-sm" style={{ color: "#B3261E", ...style }} disabled={busy} onClick={del} onKeyDown={e => e.stopPropagation()}>{busy ? "Deleting…" : label}</button>;
}
function Stat({ label, value, sub }) {
  const C = useC();
  return (
    <div style={{ background: C.cream, border: `1px solid ${C.border}`, borderRadius: 10, padding: "9px 11px", minWidth: 0 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: C.inkLight, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 800, color: C.ink, marginTop: 2, wordBreak: "break-word" }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: C.inkLight, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
function StatGrid({ children }) { return <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(135px, 1fr))", gap: 8 }}>{children}</div>; }
function Note({ children, tone = "neutral" }) {
  const C = useC();
  const bg = tone === "warn" ? "#FFF8E6" : tone === "error" ? C.redLight : C.cream;
  const bd = tone === "warn" ? "#F3D98B" : tone === "error" ? "#F2B8B5" : C.border;
  return <div style={{ background: bg, border: `1px solid ${bd}`, borderRadius: 10, padding: "9px 12px", fontSize: 12, color: C.inkMid, lineHeight: 1.5, marginBottom: 10 }}>{children}</div>;
}
function Field({ label, children, hint }) {
  const C = useC();
  return (
    <label style={{ display: "block", marginBottom: 10 }}>
      <span style={{ display: "block", fontSize: 12, fontWeight: 700, color: C.ink, marginBottom: 4 }}>{label}</span>
      {children}
      {hint && <span style={{ display: "block", fontSize: 11, color: C.inkLight, marginTop: 3 }}>{hint}</span>}
    </label>
  );
}
function Sheet({ title, onClose, children, wide }) {
  const C = useC();
  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-sheet" style={{ maxWidth: wide ? 640 : 520 }}>
        <div style={{ width: 40, height: 4, borderRadius: 2, background: C.border, margin: "0 auto 16px" }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ fontSize: 17, fontWeight: 800, color: C.ink, margin: 0 }}>{title}</h3>
          <button className="ht-btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
function Busy({ text = "Loading…" }) { const C = useC(); return <div style={{ padding: 28, textAlign: "center", color: C.inkMid, fontSize: 13 }}>{text}</div>; }
function ErrorBox({ error, onRetry }) {
  return (
    <Note tone="error">
      <strong>Something went wrong:</strong> {errMsg(error)}
      {onRetry && <> <button className="ht-btn btn-secondary btn-sm" style={{ marginLeft: 8 }} onClick={onRetry}>Try again</button></>}
    </Note>
  );
}

// ── WhatsApp drafts (never sent automatically — copy only) ──
function buildDraft(c) {
  const name = firstName(c.name);
  const s = c.suggestion || {};
  if (s.draft === "reminder") {
    let dishLine = "Our menu is up on the app whenever you're ready.";
    if (s.dish && s.menu_date) {
      dishLine = s.dish_basis === "confirmed"
        ? `You told us you love ${s.dish}, and it's on our menu on ${fmtD(s.menu_date)}.`
        : `${s.dish} is on our menu on ${fmtD(s.menu_date)}.`;
    }
    return `Hi ${name}, this is Homely Tiffins 🙏 It's been a few days since your last tiffin. ${dishLine} Shall we keep one aside for you? (Reply STOP if you'd rather not get messages like this.)`;
  }
  return `Hi ${name}, this is Homely Tiffins. We've missed having you with us! We'd really like to know how your last meals were and whether there's anything we could do better. Your honest feedback helps us a lot 🙏`;
}

// ═════════════════════════════════════════════════════════════
// STAFF: CUSTOMERS SECTION
// ═════════════════════════════════════════════════════════════
export function CustomersSection({ supabase, C = DEFAULT_C, openCustomerId, onOpened }) {
  const [sub, setSub] = useState("list");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState(null);
  const [selected, setSelected] = useState(null);
  const [delNote, setDelNote] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await callRpc(supabase, "staff_customer_overview")); }
    catch (e) { setError(e); }
    setLoading(false);
  }, [supabase]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (openCustomerId) { setSelected(openCustomerId); setSub("list"); if (onOpened) onOpened(); } }, [openCustomerId]); // eslint-disable-line

  const refreshAll = async () => {
    setRefreshing(true); setRefreshMsg(null);
    try {
      const r = await callRpc(supabase, "staff_refresh_analysis", {});
      setRefreshMsg(r.ok ? `Refreshed ${r.customers_refreshed} customers with no errors.` : `Refreshed ${r.customers_refreshed} customers; ${r.errors} had errors (see below).`);
      await load();
    } catch (e) { setRefreshMsg("Refresh failed: " + errMsg(e)); }
    setRefreshing(false);
  };

  const tabs = [["list", "👥 Customers"], ["reactivation", "💬 Reactivation"], ["duplicates", "🧩 Duplicates"], ["dishes", "🍛 Dishes"]];

  return (
    <ThemeCtx.Provider value={C}>
      <div style={{ padding: "16px 0" }}>
        {selected ? (
          <CustomerProfile supabase={supabase} id={selected} onBack={() => { setSelected(null); load(); }} onOpen={(id) => setSelected(id)}
            onDeleted={(text) => { setDelNote(text); setSelected(null); load(); }} />
        ) : (
          <>
            <div style={{ display: "flex", gap: 6, marginBottom: 12, overflowX: "auto" }}>
              {tabs.map(([k, l]) => (
                <button key={k} onClick={() => setSub(k)} className="ht-btn btn-sm"
                  style={{ background: sub === k ? C.ink : C.white, color: sub === k ? C.white : C.inkMid, border: `1.5px solid ${sub === k ? C.ink : C.border}`, whiteSpace: "nowrap" }}>{l}</button>
              ))}
            </div>
            <Card style={{ padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div style={{ fontSize: 12, color: C.inkMid, lineHeight: 1.5 }}>
                  {data ? <>As of <strong>{fmtD(data.as_of)}</strong> (IST) · last full refresh {data.last_run?.finished_at ? fmtTs(data.last_run.finished_at) : "—"}
                    {data.last_run?.trigger ? ` (${data.last_run.trigger.replace(/_/g, " ")})` : ""}</> : "Loading analysis…"}
                </div>
                <button className="ht-btn btn-secondary btn-sm" disabled={refreshing} onClick={refreshAll}>{refreshing ? "Refreshing…" : "↻ Refresh analysis"}</button>
              </div>
              {refreshMsg && <div style={{ fontSize: 12, marginTop: 8, color: C.inkMid }}>{refreshMsg}</div>}
              {data?.errors?.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <Note tone="error">
                    <strong>{data.errors.length} processing error(s) need attention.</strong> Analysis for these customers/orders may be out of date.
                    {data.errors.slice(0, 5).map(e => (
                      <div key={e.id} style={{ marginTop: 4, fontSize: 11.5 }}>• {e.context}{e.order_id ? ` (order ${e.order_id})` : ""}: {e.error} <span style={{ color: C.inkLight }}>— {fmtTs(e.created_at)}</span></div>
                    ))}
                  </Note>
                </div>
              )}
            </Card>
            {error && <ErrorBox error={error} onRetry={load} />}
            {loading && !data && <Busy />}
            {delNote && (sub === "list" || sub === "reactivation") && <Note>{delNote} <button className="ht-btn btn-ghost btn-sm" style={{ padding: "0 6px" }} onClick={() => setDelNote(null)}>✕</button></Note>}
            {data && sub === "list" && <CustomerList supabase={supabase} data={data} onOpen={setSelected} onDeleted={(text, changed) => { setDelNote(text); if (changed) load(); }} />}
            {data && sub === "reactivation" && <Reactivation supabase={supabase} data={data} onOpen={setSelected} onChanged={load} onDeleted={(text, changed) => { setDelNote(text); if (changed) load(); }} />}
            {sub === "duplicates" && <Duplicates supabase={supabase} onOpen={setSelected} onChanged={load} />}
            {sub === "dishes" && <DishCatalog supabase={supabase} onChanged={load} />}
          </>
        )}
      </div>
    </ThemeCtx.Provider>
  );
}

// ── customer list ──
function CustomerRow({ c, onOpen, extra }) {
  const C = useC();
  return (
    <div className="ht-card" onClick={() => onOpen(c.id)} style={{ padding: 12, marginBottom: 8, cursor: "pointer" }} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(c.id); }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.ink }}>{c.name || "(no name)"}</div>
          <div style={{ fontSize: 12, color: C.inkMid, marginTop: 2 }}>
            {c.phone} · {c.tower || "tower ?"}{c.flat ? `, flat ${c.flat}` : ""}{c.society ? ` · ${c.society}` : ""}
          </div>
        </div>
        <Pill tone={bucketTone(c.bucket)}>{c.bucket === "no_delivered" ? "No deliveries" : c.days_since === null ? "—" : `${c.days_since}d ago`}</Pill>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8, fontSize: 11.5, color: C.inkMid }}>
        <Pill>{BUCKET_LABEL[c.bucket]}</Pill>
        <span>{c.delivered_orders} delivered</span><span>·</span><span>{fmtINR(c.net_spend)}</span>
        {c.last_delivered && <><span>·</span><span>last {fmtD(c.last_delivered)}</span></>}
        {c.complaints > 0 && <Pill tone="red">{c.complaints} open complaint{c.complaints > 1 ? "s" : ""}</Pill>}
        {c.possible_duplicate && <Pill tone="amber">possible duplicate</Pill>}
      </div>
      {extra}
    </div>
  );
}
function CustomerList({ supabase, data, onOpen, onDeleted }) {
  const C = useC();
  const [q, setQ] = useState("");
  const [bucket, setBucket] = useState("all");
  const customers = data.customers || [];
  const counts = useMemo(() => {
    const m = { all: customers.length, active_0_6: 0, inactive_7_13: 0, inactive_14_plus: 0, no_delivered: 0 };
    customers.forEach(c => { m[c.bucket] = (m[c.bucket] || 0) + 1; }); return m;
  }, [customers]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase(); const digits = t.replace(/\D/g, "");
    return customers.filter(c => {
      if (bucket !== "all" && c.bucket !== bucket) return false;
      if (!t) return true;
      return (c.name || "").toLowerCase().includes(t) || (digits.length >= 3 && (c.phone_norm || c.phone || "").includes(digits))
        || (c.society || "").toLowerCase().includes(t) || (c.tower || "").toLowerCase().includes(t) || (c.flat || "").toLowerCase().includes(t);
    }).sort((a, b) => (a.days_since ?? 1e9) - (b.days_since ?? 1e9));
  }, [customers, q, bucket]);
  const chips = [["all", "All"], ["active_0_6", "0–6 days"], ["inactive_7_13", "7–13 inactive"], ["inactive_14_plus", "14+ inactive"], ["no_delivered", "No delivered orders"]];
  return (
    <>
      <input className="ht-input" placeholder="Search name, phone, society or tower…" value={q} onChange={e => setQ(e.target.value)} style={{ marginBottom: 10 }} aria-label="Search customers" />
      <div style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 12 }}>
        {chips.map(([k, l]) => (
          <button key={k} className="ht-btn btn-sm" onClick={() => setBucket(k)}
            style={{ background: bucket === k ? C.saffron : C.white, color: bucket === k ? C.white : C.inkMid, border: `1.5px solid ${bucket === k ? C.saffron : C.border}`, whiteSpace: "nowrap" }}>
            {l} ({counts[k] || 0})
          </button>
        ))}
      </div>
      <Note>Days since last delivery use Asia/Kolkata calendar dates. Rejected / never-delivered orders are not counted. Customers with no delivered orders are shown separately, not as “inactive”.</Note>
      {(bucket === "inactive_7_13" || bucket === "inactive_14_plus") && shown.length > 0 && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
          <InactiveListActions supabase={supabase} rows={shown} title={`${bucket === "inactive_7_13" ? "Inactive 7–13 days" : "Inactive 14+ days"}${q.trim() ? ` matching “${q.trim()}”` : ""}`} onDone={onDeleted} />
        </div>
      )}
      {shown.length === 0 && <Busy text="No customers match." />}
      {shown.map(c => <CustomerRow key={c.id} c={c} onOpen={onOpen}
        extra={isInactive(c) && <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}><DeleteCustomerBtn supabase={supabase} c={c} onDone={onDeleted} /></div>} />)}
    </>
  );
}

// ═════════════════════════════════════════════════════════════
// CUSTOMER PROFILE
// ═════════════════════════════════════════════════════════════
function CustomerProfile({ supabase, id, onBack, onOpen, onDeleted }) {
  const C = useC();
  const [p, setP] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [catalog, setCatalog] = useState([]);

  const load = useCallback(async () => {
    setError(null);
    try { setP(await callRpc(supabase, "staff_customer_profile", { p_customer: id })); }
    catch (e) { setError(e); }
  }, [supabase, id]);
  useEffect(() => { setP(null); load(); }, [load]);
  useEffect(() => { callRpc(supabase, "staff_dish_catalog").then(setCatalog).catch(() => {}); }, [supabase]);
  const say = (m) => { setToast(m); setTimeout(() => setToast(null), 3500); };

  if (error) return <><button className="ht-btn btn-secondary btn-sm" onClick={onBack}>← Back</button><div style={{ height: 10 }} /><ErrorBox error={error} onRetry={load} /></>;
  if (!p) return <Busy text="Loading profile…" />;
  const s = p.summary;
  const act = async (fn, args, okMsg) => {
    setBusy(true);
    try { const r = await callRpc(supabase, fn, args); if (okMsg) say(okMsg); await load(); return r; }
    catch (e) { say("Error: " + errMsg(e)); }
    finally { setBusy(false); }
  };
  const copyLink = async () => {
    setBusy(true);
    try {
      const r = await callRpc(supabase, "staff_create_form_link", { p_customer: s.id, p_days: 90 });
      const url = `${window.location.origin}/#/prefs/${r.token}`;
      const ok = await copyText(url);
      say(ok ? "Secure link copied. It works for 90 days and can be revoked." : "Could not copy automatically — link: " + url);
      await load();
    } catch (e) { say("Error: " + errMsg(e)); }
    setBusy(false);
  };

  return (
    <div>
      <button className="ht-btn btn-secondary btn-sm" onClick={onBack} style={{ marginBottom: 10 }}>← All customers</button>
      {toast && <div style={{ position: "sticky", top: 8, zIndex: 50, background: C.ink, color: C.white, padding: "9px 14px", borderRadius: 10, fontSize: 12.5, marginBottom: 10 }} role="status">{toast}</div>}

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 800, color: C.ink, margin: 0 }}>{s.name || "(no name)"}</h2>
            <div style={{ fontSize: 13, color: C.inkMid, marginTop: 3 }}>{s.phone}</div>
            <div style={{ fontSize: 13, color: C.inkMid }}>{s.tower || "Tower not recorded"}{s.flat ? `, flat ${s.flat}` : ""}</div>
            <SocietyEditor s={s} onSave={(v) => act("staff_set_society", { p_customer: s.id, p_society: v }, "Society saved")} />
          </div>
          <div style={{ textAlign: "right" }}>
            <Pill tone={bucketTone(s.bucket)}>{BUCKET_LABEL[s.bucket]}</Pill>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          <button className="ht-btn btn-primary btn-sm" disabled={busy} onClick={copyLink}>🔗 Copy preference form link</button>
          {p.active_form_links > 0 && (
            <button className="ht-btn btn-secondary btn-sm" disabled={busy} onClick={() => { if (window.confirm(`Revoke ${p.active_form_links} active link(s)? Anyone holding them will lose access.`)) act("staff_revoke_form_links", { p_customer: s.id }, "Links revoked"); }}>
              Revoke {p.active_form_links} active link{p.active_form_links > 1 ? "s" : ""}
            </button>
          )}
          <button className="ht-btn btn-secondary btn-sm" disabled={busy} onClick={() => act("staff_refresh_analysis", { p_customer: s.id }, "Analysis refreshed")}>↻ Refresh this customer</button>
          <DeleteCustomerBtn supabase={supabase} c={s} label="🗑 Delete customer"
            onDone={(text, changed) => { if (changed && onDeleted) onDeleted(text); else say(text); }} />
        </div>
        {p.merged_records?.length > 0 && (
          <div style={{ fontSize: 11.5, color: C.inkMid, marginTop: 10 }}>
            Includes merged record(s): {p.merged_records.map(m => `${m.phone} (merged ${fmtD(m.merged_at)} by ${m.merged_by})`).join("; ")}
          </div>
        )}
      </Card>

      {p.errors?.length > 0 && <Note tone="error"><strong>Processing errors for this customer:</strong>{p.errors.map(e => <div key={e.id}>• {e.context}: {e.error}</div>)}</Note>}
      {s.complaints > 0 && <Note tone="error"><strong>{s.complaints} unresolved complaint(s)</strong> — resolve before sending any promotional message.</Note>}

      <Overview p={p} />
      <PatternCard s={s} />
      <DishAnalysis p={p} />
      <PreferencesCard p={p} catalog={catalog} act={act} busy={busy} />
      <FeedbackCard p={p} act={act} busy={busy} />
      <NotesCard p={p} act={act} busy={busy} />
      <ContactCard p={p} act={act} busy={busy} />
      <OrdersCard p={p} act={act} busy={busy} />
      <DuplicatesCard p={p} supabase={supabase} onOpen={onOpen} onChanged={load} />
    </div>
  );
}

function SocietyEditor({ s, onSave }) {
  const C = useC();
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(s.society || "");
  if (!edit) return (
    <div style={{ fontSize: 13, color: C.inkMid }}>
      {s.society ? `Society: ${s.society}` : "Society not recorded"} <button className="ht-btn btn-ghost btn-sm" style={{ padding: "2px 8px" }} onClick={() => setEdit(true)}>edit</button>
    </div>
  );
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
      <input className="ht-input" value={v} onChange={e => setV(e.target.value)} placeholder="Society name" style={{ maxWidth: 200 }} />
      <button className="ht-btn btn-primary btn-sm" onClick={() => { onSave(v); setEdit(false); }}>Save</button>
      <button className="ht-btn btn-ghost btn-sm" onClick={() => setEdit(false)}>Cancel</button>
    </div>
  );
}

function Overview({ p }) {
  const C = useC();
  const s = p.summary; const cov = s.coverage || {};
  return (
    <Card>
      <H sub={`Analysis as of ${fmtD(s.as_of_date)} · last refreshed ${fmtTs(s.refreshed_at)}`}>Delivered-order summary</H>
      <StatGrid>
        <Stat label="First delivered" value={fmtD(s.first_delivered)} />
        <Stat label="Last delivered" value={fmtD(s.last_delivered)} />
        <Stat label="Days since last delivery" value={s.days_since === null ? "—" : s.days_since} sub={BUCKET_LABEL[s.bucket]} />
        <Stat label="Delivered orders" value={s.delivered_orders} />
        <Stat label="Total spending" value={fmtINR(s.net_spend)} sub={s.discount_amount > 0 ? `after ${fmtINR(s.discount_amount)} discounts` : "no discounts"} />
        <Stat label="Average order value" value={fmtINR(s.avg_order_value)} />
      </StatGrid>
      <details style={{ marginTop: 10, fontSize: 12, color: C.inkMid }}>
        <summary style={{ cursor: "pointer", fontWeight: 700 }}>How is spending calculated?</summary>
        <div style={{ marginTop: 6, lineHeight: 1.55 }}>
          <p>{p.notes_about_metrics.spend}</p>
          <p style={{ marginTop: 6 }}>Gross before discounts: {fmtINR(s.gross_amount)} · Discounts: {fmtINR(s.discount_amount)} · Net spending: {fmtINR(s.net_spend)}.</p>
          <p style={{ marginTop: 6 }}>{p.notes_about_metrics.dates}</p>
          <p style={{ marginTop: 6 }}>This matches the Sales dashboard, which also sums order totals and excludes rejected orders; here only <em>delivered</em> orders are counted.</p>
        </div>
      </details>
      <div style={{ fontSize: 12, color: C.inkMid, marginTop: 10, lineHeight: 1.55 }}>
        <strong>Data coverage:</strong> {cov.delivered_orders ?? 0} delivered order(s) analysed — full contents known for {cov.snapshot_full ?? 0}, partly known for {cov.snapshot_partial ?? 0}, unknown for {cov.snapshot_none ?? 0}.
        Menu-availability record exists for {cov.orders_with_menu_record ?? 0}.
        {cov.estimated_date_orders > 0 && ` ${cov.estimated_date_orders} order(s) have no delivered timestamp, so the order date was used.`}
        {cov.orders_without_any_date > 0 && ` ${cov.orders_without_any_date} delivered order(s) have no usable date and are excluded.`}
      </div>
    </Card>
  );
}

function CountList({ obj, labelFn, order }) {
  const C = useC();
  const entries = Object.entries(obj || {});
  if (entries.length === 0) return <span style={{ color: C.inkLight }}>unknown</span>;
  if (order) entries.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  else entries.sort((a, b) => b[1] - a[1]);
  return <span>{entries.map(([k, v], i) => <span key={k}>{i > 0 ? " · " : ""}{labelFn ? labelFn(k) : k} <strong>{v}</strong></span>)}</span>;
}
function PatternCard({ s }) {
  const C = useC();
  const w = s.windows || {}; const d30 = w.d30 || {}; const pr = w.prev30 || {}; const d90 = w.d90 || {};
  const shiftText = { up: "Moved to a higher-tier variant", down: "Moved to a lower-tier variant", same: "Same dominant variant", insufficient_data: "Not enough orders in both windows to compare variants" }[s.variant_shift] || "—";
  const delta = (a, b) => { const d = (a || 0) - (b || 0); return d === 0 ? "no change" : (d > 0 ? `+${d}` : `${d}`); };
  return (
    <Card>
      <H sub="Observed from delivered orders only.">Usual ordering pattern</H>
      <div style={{ fontSize: 13, color: C.inkMid, lineHeight: 1.8 }}>
        <div><strong>Usual meal variant:</strong> {VARIANT_LABEL[s.usual_variant] || "unknown"} <span style={{ color: C.inkLight }}>(<CountList obj={s.variant_counts} labelFn={k => VARIANT_LABEL[k] || k} />)</span></div>
        <div><strong>Portion size (Gold only):</strong> {s.usual_size ? s.usual_size : "not recorded"} {s.size_counts && Object.keys(s.size_counts).length > 0 && <span style={{ color: C.inkLight }}>(<CountList obj={s.size_counts} />)</span>} <span style={{ color: C.inkLight }}>— other variants have a fixed portion</span></div>
        <div><strong>Meal slot (inferred from delivery time):</strong> <CountList obj={s.slot_counts} /> <span style={{ color: C.inkLight }}>— the app has no lunch/dinner field</span></div>
        <div><strong>Ordering weekdays:</strong> <CountList obj={s.weekday_counts} order={["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]} /></div>
        <div><strong>Frequency:</strong> about {s.orders_per_week ?? "—"} orders/week while active{s.median_gap_days !== null && s.median_gap_days !== undefined ? ` · typical gap ${s.median_gap_days} day(s)` : ""}</div>
      </div>
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.ink, marginBottom: 6 }}>Change in ordering (as of {fmtD(s.as_of_date)})</div>
        <StatGrid>
          <Stat label={`Last 30 days`} value={`${d30.orders ?? 0} orders`} sub={`${fmtD(d30.from)} – ${fmtD(d30.to)} · ${fmtINR(d30.spend)}`} />
          <Stat label="Previous 30 days" value={`${pr.orders ?? 0} orders`} sub={`${fmtD(pr.from)} – ${fmtD(pr.to)} · ${fmtINR(pr.spend)}`} />
          <Stat label="Last 90 days" value={`${d90.orders ?? 0} orders`} sub={fmtINR(d90.spend)} />
          <Stat label="Frequency change" value={delta(d30.orders, pr.orders)} sub="orders, last 30 vs previous 30" />
        </StatGrid>
        <div style={{ fontSize: 12, color: C.inkMid, marginTop: 8 }}>
          Variant change: {shiftText}. <span style={{ color: C.inkLight }}>Last 30d: <CountList obj={d30.variants} labelFn={k => VARIANT_LABEL[k] || k} /> · Previous 30d: <CountList obj={pr.variants} labelFn={k => VARIANT_LABEL[k] || k} /></span>
        </div>
      </div>
    </Card>
  );
}

// ── dish & side analysis ──
function DishAnalysis({ p }) {
  const C = useC();
  const s = p.summary; const [win, setWin] = useState("lifetime");
  const stats = (p.dish_stats || []).filter(x => x.win === win);
  const range = win === "lifetime" ? `${fmtD(s.first_delivered)} – ${fmtD(s.last_delivered)}` : `${fmtD(s.windows?.[win]?.from)} – ${fmtD(s.windows?.[win]?.to)}`;
  const mains = stats.filter(x => x.role_group === "main");
  const sides = stats.filter(x => x.role_group === "side");
  const breads = stats.filter(x => x.role_group === "bread");
  const rice = sides.filter(x => x.category === "rice");
  const raitaSweet = sides.filter(x => x.category === "raita" || x.category === "sweet");
  const otherSides = sides.filter(x => x.category !== "rice");
  const lifetime = (p.dish_stats || []).filter(x => x.win === "lifetime");
  const raitaChosen = lifetime.filter(x => x.category === "raita").reduce((a, x) => a + x.explicit_orders, 0);
  const sweetChosen = lifetime.filter(x => x.category === "sweet").reduce((a, x) => a + x.explicit_orders, 0);
  const wins = [["lifetime", "Lifetime"], ["d30", "Last 30 days"], ["d90", "Last 90 days"], ["prev30", "Previous 30 days"]];

  const table = (rows, opts = {}) => rows.length === 0 ? <div style={{ fontSize: 12, color: C.inkLight, padding: "6px 0" }}>None in this period.</div> : (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead><tr style={{ textAlign: "left", color: C.inkLight }}>
          <th style={{ padding: "4px 6px" }}>Dish</th><th style={{ padding: "4px 6px" }}>Delivered in</th>
          {opts.qty && <th style={{ padding: "4px 6px" }}>Qty</th>}
          <th style={{ padding: "4px 6px" }}>Chosen</th><th style={{ padding: "4px 6px" }}>Fixed menu</th>
          <th style={{ padding: "4px 6px" }}>Last delivered</th><th style={{ padding: "4px 6px" }}>Last chosen</th>
        </tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.dish_id} style={{ borderTop: `1px solid ${C.border}` }}>
              <td style={{ padding: "6px", fontWeight: 700, color: C.ink }}>{r.name}
                {r.eligible_orders !== null && r.eligible_orders !== undefined && (
                  <div style={{ fontWeight: 500, color: C.inkMid, fontSize: 11 }}>selected {r.selected_of_eligible}× across {r.eligible_orders} eligible order(s) where offered</div>
                )}
              </td>
              <td style={{ padding: "6px" }}>{r.delivered_orders} order{r.delivered_orders > 1 ? "s" : ""}</td>
              {opts.qty && <td style={{ padding: "6px" }}>{Number(r.qty)}</td>}
              <td style={{ padding: "6px" }}>{r.explicit_orders}</td><td style={{ padding: "6px" }}>{r.fixed_orders}</td>
              <td style={{ padding: "6px", whiteSpace: "nowrap" }}>{fmtD(r.last_date)}</td>
              <td style={{ padding: "6px", whiteSpace: "nowrap" }}>{r.last_explicit_date ? fmtD(r.last_explicit_date) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  const chosenMains = [...mains].filter(x => x.explicit_orders > 0).sort((a, b) => b.explicit_orders - a.explicit_orders);
  const chosenSides = [...raitaSweet].filter(x => x.explicit_orders > 0).sort((a, b) => b.explicit_orders - a.explicit_orders);
  const cov = s.coverage || {};
  return (
    <Card>
      <H sub={`Each dish is counted once per delivered order; quantity is tracked separately. Period: ${range}. As of ${fmtD(s.as_of_date)}.`}>Dishes &amp; sides</H>
      <div style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 10 }}>
        {wins.map(([k, l]) => <button key={k} className="ht-btn btn-sm" onClick={() => setWin(k)} style={{ background: win === k ? C.saffron : C.white, color: win === k ? C.white : C.inkMid, border: `1.5px solid ${win === k ? C.saffron : C.border}`, whiteSpace: "nowrap" }}>{l}</button>)}
      </div>
      <Note>
        <strong>How to read this.</strong> “Delivered in” counts orders that contained the dish. <strong>Fixed menu</strong> = the dish came with the plan (the customer had no choice). <strong>Chosen</strong> = the customer picked it from options at checkout — the app records the submitted selection but cannot tell an actively chosen option from an untouched default. “Most delivered” is not the same as a favourite: confirmed favourites are shown under Preferences.
        Contents are known for {cov.snapshot_full ?? 0} of {cov.delivered_orders ?? 0} delivered orders.
      </Note>
      <div style={{ fontSize: 13, fontWeight: 800, color: C.ink, margin: "6px 0 2px" }}>Most delivered — main dishes (sabjis &amp; dals)</div>
      {table([...mains].sort((a, b) => b.delivered_orders - a.delivered_orders || (b.last_date > a.last_date ? 1 : -1)), { qty: true })}
      <div style={{ fontSize: 13, fontWeight: 800, color: C.ink, margin: "14px 0 2px" }}>Frequently selected — mains the customer chose</div>
      {table(chosenMains)}
      <div style={{ fontSize: 13, fontWeight: 800, color: C.ink, margin: "14px 0 2px" }}>Most delivered — sides (raita, sweet, salad)</div>
      {table([...otherSides].sort((a, b) => b.delivered_orders - a.delivered_orders), { qty: true })}
      <div style={{ fontSize: 13, fontWeight: 800, color: C.ink, margin: "14px 0 2px" }}>Frequently selected — raita / sweet the customer chose</div>
      {table(chosenSides)}
      <div style={{ fontSize: 12, color: C.inkMid, margin: "8px 0" }}>Lifetime raita vs sweet picks (Gold / Gold Mini / extras): Raita chosen in <strong>{raitaChosen}</strong> order(s), Sweet in <strong>{sweetChosen}</strong>.</div>
      <div style={{ fontSize: 13, fontWeight: 800, color: C.ink, margin: "14px 0 2px" }}>Roti / paratha / rice (quantities)</div>
      {table([...breads, ...rice].sort((a, b) => b.delivered_orders - a.delivered_orders), { qty: true })}
      <div style={{ fontSize: 11.5, color: C.inkLight, marginTop: 8, lineHeight: 1.5 }}>
        Selection rates (e.g. “selected 4× across 6 eligible orders”) appear only where the published menu in effect at order time was recorded and the variant offered a sabji choice. Menu history is recorded from {fmtD(p.next_menu?.date) !== "—" ? "now on" : "the day this feature was installed"}; older orders show counts only.
      </div>
    </Card>
  );
}

// ── confirmed preferences ──
function PreferencesCard({ p, catalog, act, busy }) {
  const C = useC();
  const s = p.summary; const conf = s.confirmed || {};
  const get = (f) => conf[f]?.value;
  const meta = (f) => conf[f];
  const observedMains = (s.top_mains || []).map(x => x.name); const observedSides = (s.top_sides || []).map(x => x.name);
  const favNames = (get("fav_dishes") || []).map(x => x.label.toLowerCase());
  const favSideNames = (get("fav_sides") || []).map(x => x.label.toLowerCase());
  const differs = (get("fav_dishes") && observedMains.length && !observedMains.some(n => favNames.includes(n.toLowerCase())))
    || (get("fav_sides") && observedSides.length && !observedSides.some(n => favSideNames.includes(n.toLowerCase())));
  const dishOptions = catalog.filter(d => ["sabji", "dal"].includes(d.category)).map(d => d.name);
  const sideOptions = catalog.filter(d => ["rice", "raita", "sweet", "salad", "bread"].includes(d.category)).map(d => d.name);

  return (
    <Card>
      <H sub="Stated by the customer or recorded by staff. Automatic analysis never overwrites these.">Confirmed preferences</H>
      {differs && <Note tone="warn">Confirmed and observed differ: the customer says they like {(get("fav_dishes") || []).concat(get("fav_sides") || []).map(x => x.label).join(", ")}, but what has mostly been <em>delivered</em> is {observedMains.concat(observedSides).join(", ")}. Both are shown; neither replaces the other.</Note>}
      <div style={{ fontSize: 12, color: C.inkMid, marginBottom: 10 }}>
        <strong>Observed (not confirmed):</strong> Most delivered — {observedMains.join(", ") || "n/a"}{observedSides.length ? ` · sides: ${observedSides.join(", ")}` : ""}
        {(s.chosen_mains || []).length > 0 && <> · Frequently selected — {(s.chosen_mains || []).map(x => x.name).join(", ")}</>}
      </div>
      <DishListPref label="Favourite sabjis / dals" field="fav_dishes" value={get("fav_dishes")} meta={meta("fav_dishes")} options={dishOptions} act={act} busy={busy} custId={s.id} />
      <DishListPref label="Favourite sides" field="fav_sides" value={get("fav_sides")} meta={meta("fav_sides")} options={sideOptions} act={act} busy={busy} custId={s.id} />
      <DishListPref label="Disliked dishes" field="disliked_dishes" value={get("disliked_dishes")} meta={meta("disliked_dishes")} options={dishOptions.concat(sideOptions)} act={act} busy={busy} custId={s.id} />
      {["spice", "oil", "bread_pref", "portion_pref", "usual_meal"].map(f => (
        <SelectPref key={f} field={f} value={get(f)} meta={meta(f)} act={act} busy={busy} custId={s.id} />
      ))}
      <TextPref field="reason_stopped" value={get("reason_stopped")} meta={meta("reason_stopped")} act={act} busy={busy} custId={s.id} />
      <DatePref field="away_until" value={get("away_until")} meta={meta("away_until")} act={act} busy={busy} custId={s.id} />
      <DatePref field="follow_up_date" value={get("follow_up_date")} meta={meta("follow_up_date")} act={act} busy={busy} custId={s.id} />
      <details style={{ marginTop: 8, fontSize: 12, color: C.inkMid }}>
        <summary style={{ cursor: "pointer", fontWeight: 700 }}>Change history ({(p.pref_log || []).length})</summary>
        {(p.pref_log || []).map(l => (
          <div key={l.id} style={{ padding: "5px 0", borderTop: `1px solid ${C.border}`, lineHeight: 1.45 }}>
            <strong>{FIELD_LABEL[l.field]}</strong> — {l.action === "remove" ? "removed" : (Array.isArray(l.value) ? l.value.map(x => x.label).join(", ") : optLabel(l.field, String(l.value)))}
            <div style={{ color: C.inkLight }}>{SOURCE_LABEL[l.source]} · {l.set_by} · {fmtTs(l.set_at)}{l.note ? ` · ${l.note}` : ""}</div>
          </div>
        ))}
      </details>
    </Card>
  );
}
function PrefShell({ label, meta, children }) {
  const C = useC();
  return (
    <div style={{ padding: "10px 0", borderTop: `1px solid ${C.border}` }}>
      <div style={{ fontSize: 12.5, fontWeight: 800, color: C.ink }}>{label}</div>
      {children}
      <div style={{ fontSize: 10.5, color: C.inkLight, marginTop: 4 }}>{meta ? `${SOURCE_LABEL[meta.source] || meta.source} · ${meta.by} · ${fmtTs(meta.at)}` : "Not confirmed yet"}</div>
    </div>
  );
}
function DishListPref({ label, field, value, meta, options, act, busy, custId }) {
  const C = useC();
  const [items, setItems] = useState(value || []);
  const [txt, setTxt] = useState("");
  useEffect(() => { setItems(value || []); }, [JSON.stringify(value)]); // eslint-disable-line
  const dirty = JSON.stringify((items || []).map(i => i.label)) !== JSON.stringify((value || []).map(i => i.label));
  const add = () => { const t = txt.trim(); if (!t) return; if (!items.some(i => i.label.toLowerCase() === t.toLowerCase())) setItems([...items, { label: t }]); setTxt(""); };
  const listId = "dl-" + field;
  return (
    <PrefShell label={label} meta={meta}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "6px 0" }}>
        {items.length === 0 && <span style={{ fontSize: 12, color: C.inkLight }}>None recorded</span>}
        {items.map(i => <Pill key={i.label} tone="saffron">{i.label} <button aria-label={`Remove ${i.label}`} onClick={() => setItems(items.filter(x => x.label !== i.label))} style={{ border: "none", background: "transparent", cursor: "pointer", color: C.saffron, fontWeight: 800 }}>×</button></Pill>)}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input className="ht-input" list={listId} value={txt} onChange={e => setTxt(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }} placeholder="Add dish (pick or type another)" aria-label={`Add to ${label}`} />
        <datalist id={listId}>{options.map(o => <option key={o} value={o} />)}</datalist>
        <button className="ht-btn btn-secondary btn-sm" onClick={add}>Add</button>
      </div>
      {(dirty || txt) && (
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <button className="ht-btn btn-primary btn-sm" disabled={busy} onClick={() => { const t = txt.trim(); const next = t && !items.some(i => i.label.toLowerCase() === t.toLowerCase()) ? [...items, { label: t }] : items; setTxt(""); act("staff_set_pref", { p_customer: custId, p_field: field, p_value: next, p_note: null }, "Saved"); }}>Save</button>
          <button className="ht-btn btn-ghost btn-sm" onClick={() => { setItems(value || []); setTxt(""); }}>Reset</button>
        </div>
      )}
    </PrefShell>
  );
}
function SelectPref({ field, value, meta, act, busy, custId }) {
  const C = useC();
  return (
    <PrefShell label={FIELD_LABEL[field]} meta={meta}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
        {OPTIONS[field].map(([v, l]) => (
          <button key={v} disabled={busy} className="ht-btn btn-sm" onClick={() => act("staff_set_pref", { p_customer: custId, p_field: field, p_value: v, p_note: null }, "Saved")}
            style={{ background: value === v ? C.saffron : C.white, color: value === v ? C.white : C.inkMid, border: `1.5px solid ${value === v ? C.saffron : C.border}` }}>{l}</button>
        ))}
        {value && <button className="ht-btn btn-ghost btn-sm" disabled={busy} onClick={() => act("staff_set_pref", { p_customer: custId, p_field: field, p_value: "", p_note: null }, "Removed")}>Remove</button>}
      </div>
    </PrefShell>
  );
}
function TextPref({ field, value, meta, act, busy, custId }) {
  const [v, setV] = useState(value || "");
  useEffect(() => { setV(value || ""); }, [value]);
  return (
    <PrefShell label={FIELD_LABEL[field]} meta={meta}>
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <input className="ht-input" value={v} maxLength={300} onChange={e => setV(e.target.value)} placeholder="e.g. travelling, price, taste…" aria-label={FIELD_LABEL[field]} />
        <button className="ht-btn btn-primary btn-sm" disabled={busy || v === (value || "")} onClick={() => act("staff_set_pref", { p_customer: custId, p_field: field, p_value: v, p_note: null }, v ? "Saved" : "Removed")}>{v ? "Save" : "Clear"}</button>
      </div>
    </PrefShell>
  );
}
function DatePref({ field, value, meta, act, busy, custId }) {
  const [v, setV] = useState(value || "");
  useEffect(() => { setV(value || ""); }, [value]);
  return (
    <PrefShell label={FIELD_LABEL[field]} meta={meta}>
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <input className="ht-input" type="date" value={v} onChange={e => setV(e.target.value)} aria-label={FIELD_LABEL[field]} style={{ maxWidth: 200 }} />
        <button className="ht-btn btn-primary btn-sm" disabled={busy || v === (value || "")} onClick={() => act("staff_set_pref", { p_customer: custId, p_field: field, p_value: v, p_note: null }, v ? "Saved" : "Removed")}>{v ? "Save" : "Clear"}</button>
      </div>
    </PrefShell>
  );
}

// ── feedback & complaints ──
function FeedbackCard({ p, act, busy }) {
  const C = useC(); const s = p.summary;
  const [kind, setKind] = useState("feedback"); const [body, setBody] = useState("");
  const [resolving, setResolving] = useState(null); const [resolution, setResolution] = useState("");
  const rated = (p.orders || []).filter(o => o.rating && (o.rating.feedback || o.rating.taste)).slice(0, 5);
  return (
    <Card>
      <H sub="Visible to staff only.">Feedback &amp; complaints</H>
      {(p.feedback || []).length === 0 && <div style={{ fontSize: 12, color: C.inkLight, marginBottom: 8 }}>No feedback recorded.</div>}
      {(p.feedback || []).map(f => (
        <div key={f.id} style={{ padding: "8px 0", borderTop: `1px solid ${C.border}`, fontSize: 12.5, color: C.inkMid }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <Pill tone={f.kind === "complaint" ? "red" : "neutral"}>{f.kind}</Pill>
            <Pill tone={f.status === "open" ? "amber" : "green"}>{f.status === "open" ? "unresolved" : "resolved"}</Pill>
            <span style={{ color: C.inkLight, fontSize: 11 }}>{SOURCE_LABEL[f.source]} · {fmtTs(f.created_at)}</span>
          </div>
          <div style={{ marginTop: 4, whiteSpace: "pre-wrap", color: C.ink }}>{f.body}</div>
          {f.resolution && <div style={{ marginTop: 3 }}><strong>Resolution:</strong> {f.resolution} <span style={{ color: C.inkLight }}>({f.resolved_by}, {fmtTs(f.resolved_at)})</span></div>}
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            {f.status === "open"
              ? <button className="ht-btn btn-secondary btn-sm" onClick={() => { setResolving(f.id); setResolution(""); }}>Resolve…</button>
              : <button className="ht-btn btn-secondary btn-sm" disabled={busy} onClick={() => act("staff_save_feedback", { p_id: f.id, p_customer: s.id, p_kind: f.kind, p_body: f.body, p_status: "open", p_resolution: f.resolution }, "Re-opened")}>Re-open</button>}
            <button className="ht-btn btn-ghost btn-sm" disabled={busy} onClick={() => { if (window.confirm("Remove this entry?")) act("staff_remove_feedback", { p_id: f.id }, "Removed"); }}>Remove</button>
          </div>
          {resolving === f.id && (
            <div style={{ marginTop: 6 }}>
              <input className="ht-input" value={resolution} onChange={e => setResolution(e.target.value)} placeholder="How was it resolved?" />
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button className="ht-btn btn-primary btn-sm" disabled={busy} onClick={() => { act("staff_save_feedback", { p_id: f.id, p_customer: s.id, p_kind: f.kind, p_body: f.body, p_status: "resolved", p_resolution: resolution }, "Marked resolved"); setResolving(null); }}>Save resolution</button>
                <button className="ht-btn btn-ghost btn-sm" onClick={() => setResolving(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      ))}
      {rated.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: C.inkMid }}>
          <strong>Order ratings:</strong> {rated.map(o => `${fmtD(o.date)} — taste ${o.rating.taste}/5, delivery ${o.rating.delivery}/5${o.rating.feedback ? `, “${o.rating.feedback}”` : ""}`).join(" · ")}
        </div>
      )}
      <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 10, paddingTop: 10 }}>
        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          {[["feedback", "Feedback"], ["complaint", "Complaint"], ["other", "Other"]].map(([v, l]) => (
            <button key={v} className="ht-btn btn-sm" onClick={() => setKind(v)} style={{ background: kind === v ? C.ink : C.white, color: kind === v ? C.white : C.inkMid, border: `1.5px solid ${kind === v ? C.ink : C.border}` }}>{l}</button>
          ))}
        </div>
        <textarea className="ht-input" rows={2} value={body} maxLength={2000} onChange={e => setBody(e.target.value)} placeholder="What did the customer say?" aria-label="New feedback" />
        <button className="ht-btn btn-primary btn-sm" style={{ marginTop: 6 }} disabled={busy || !body.trim()} onClick={() => { act("staff_save_feedback", { p_id: null, p_customer: s.id, p_kind: kind, p_body: body, p_status: "open", p_resolution: null }, "Saved"); setBody(""); }}>Add</button>
      </div>
    </Card>
  );
}
function NotesCard({ p, act, busy }) {
  const C = useC(); const [note, setNote] = useState("");
  return (
    <Card>
      <H sub="🔒 Private staff notes. Never shown to customers and never returned by any customer-facing function.">Internal notes</H>
      {(p.notes || []).map(n => (
        <div key={n.id} style={{ padding: "7px 0", borderTop: `1px solid ${C.border}`, fontSize: 12.5 }}>
          <div style={{ whiteSpace: "pre-wrap", color: C.ink }}>{n.note}</div>
          <div style={{ fontSize: 11, color: C.inkLight }}>{n.created_by} · {fmtTs(n.created_at)} <button className="ht-btn btn-ghost btn-sm" style={{ padding: "1px 8px" }} disabled={busy} onClick={() => act("staff_remove_note", { p_id: n.id }, "Removed")}>remove</button></div>
        </div>
      ))}
      <textarea className="ht-input" rows={2} value={note} maxLength={2000} onChange={e => setNote(e.target.value)} placeholder="Add a private note" aria-label="New internal note" style={{ marginTop: 6 }} />
      <button className="ht-btn btn-primary btn-sm" style={{ marginTop: 6 }} disabled={busy || !note.trim()} onClick={() => { act("staff_add_note", { p_customer: p.summary.id, p_note: note }, "Note added"); setNote(""); }}>Add note</button>
    </Card>
  );
}

// ── contact log ──
const OUTCOME_TXT = { yes: "Yes", no: "No", window_open: "Window still open" };
const OUTCOME_TONE = { yes: "green", no: "neutral", window_open: "amber" };
function ContactCard({ p, act, busy }) {
  const C = useC(); const s = p.summary;
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <H sub="Outcomes are observed, not proof that a message caused an order." right={<button className="ht-btn btn-primary btn-sm" onClick={() => setOpen(true)}>+ Log contact</button>}>Contact history</H>
      {(p.contacts || []).length === 0 && <div style={{ fontSize: 12, color: C.inkLight }}>No contact recorded.</div>}
      {(p.contacts || []).map(c => (
        <div key={c.id} style={{ padding: "8px 0", borderTop: `1px solid ${C.border}`, fontSize: 12.5, color: C.inkMid }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <strong style={{ color: C.ink }}>{fmtTs(c.contacted_at)}</strong><Pill>{c.channel}</Pill><span>by {c.staff_name || c.created_by}</span>
          </div>
          {c.message && <div style={{ marginTop: 3, whiteSpace: "pre-wrap" }}>“{c.message}”</div>}
          {c.offer && <div><strong>Offer:</strong> {c.offer}</div>}
          {c.customer_response && <div><strong>Response:</strong> {c.customer_response}</div>}
          {c.inactivity_reason && <div><strong>Reason for inactivity:</strong> {c.inactivity_reason}</div>}
          {c.next_follow_up && <div><strong>Next follow-up:</strong> {fmtD(c.next_follow_up)}</div>}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 5, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: C.inkLight }}>Observed outcome:</span>
            <Pill tone={OUTCOME_TONE[c.ordered_within_7d]}>Delivered order within 7 days: {OUTCOME_TXT[c.ordered_within_7d]}</Pill>
            <Pill tone={OUTCOME_TONE[c.ordered_within_30d]}>Ordered again within 30 days: {OUTCOME_TXT[c.ordered_within_30d]}</Pill>
            {c.next_delivered_date && <span style={{ fontSize: 11, color: C.inkLight }}>next delivered order: {fmtD(c.next_delivered_date)}</span>}
          </div>
          <button className="ht-btn btn-ghost btn-sm" style={{ padding: "1px 8px", marginTop: 4 }} disabled={busy} onClick={() => { if (window.confirm("Remove this contact entry?")) act("staff_remove_contact", { p_id: c.id }, "Removed"); }}>remove</button>
        </div>
      ))}
      {open && <ContactForm custId={s.id} onClose={() => setOpen(false)} act={act} busy={busy} />}
    </Card>
  );
}
export function ContactForm({ custId, onClose, act, busy, initialMessage = "" }) {
  const [f, setF] = useState({ at: nowLocalInput(), channel: "whatsapp", message: initialMessage, offer: "", staff: (typeof localStorage !== "undefined" && localStorage.getItem("htStaffName")) || "", response: "", reason: "", next: "" });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try { if (f.staff) localStorage.setItem("htStaffName", f.staff); } catch { /* ignore */ }
    await act("staff_save_contact", {
      p_id: null, p_customer: custId, p_contacted_at: new Date(f.at).toISOString(), p_channel: f.channel, p_message: f.message, p_offer: f.offer,
      p_staff_name: f.staff, p_response: f.response, p_reason: f.reason, p_next_follow_up: f.next || null,
    }, "Contact logged");
    onClose();
  };
  return (
    <Sheet title="Log a contact" onClose={onClose}>
      <Field label="When"><input className="ht-input" type="datetime-local" value={f.at} onChange={set("at")} /></Field>
      <Field label="Channel">
        <select className="ht-select" value={f.channel} onChange={set("channel")}>
          {["whatsapp", "call", "sms", "in_person", "email", "other"].map(c => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
        </select>
      </Field>
      <Field label="Message sent"><textarea className="ht-input" rows={3} value={f.message} onChange={set("message")} /></Field>
      <Field label="Offer (if any)"><input className="ht-input" value={f.offer} onChange={set("offer")} /></Field>
      <Field label="Staff member"><input className="ht-input" value={f.staff} onChange={set("staff")} placeholder="Defaults to your login" /></Field>
      <Field label="Customer response"><input className="ht-input" value={f.response} onChange={set("response")} /></Field>
      <Field label="Reason for inactivity"><input className="ht-input" value={f.reason} onChange={set("reason")} /></Field>
      <Field label="Next follow-up date"><input className="ht-input" type="date" value={f.next} onChange={set("next")} /></Field>
      <button className="ht-btn btn-primary btn-full" disabled={busy} onClick={save}>Save contact</button>
    </Sheet>
  );
}

// ── orders + snapshot correction ──
function OrdersCard({ p, act, busy }) {
  const C = useC(); const [open, setOpen] = useState(null); const [fix, setFix] = useState(null);
  const orders = p.orders || [];
  const statusTone = (st) => st === "delivered" ? "green" : st === "rejected" ? "red" : "amber";
  return (
    <Card>
      <H sub="Contents come from an immutable snapshot taken when the order was placed (older orders: read from the stored order lines). Later menu edits never change them.">Order history ({orders.length})</H>
      {orders.map(o => (
        <div key={o.id} style={{ padding: "8px 0", borderTop: `1px solid ${C.border}` }}>
          <div onClick={() => setOpen(open === o.id ? null : o.id)} style={{ cursor: "pointer", display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }} role="button" tabIndex={0} onKeyDown={e => { if (e.key === "Enter") setOpen(open === o.id ? null : o.id); }}>
            <div style={{ fontSize: 12.5, color: C.ink }}><strong>{fmtD(o.date)}</strong> · #{o.id.slice(-6).toUpperCase()} · {fmtINR(o.total)}</div>
            <div style={{ display: "flex", gap: 6 }}>
              <Pill tone={statusTone(o.status)}>{o.status}</Pill>
              {o.coverage && o.coverage !== "full" && <Pill tone="amber">contents {o.coverage === "none" ? "unknown" : "partly known"}</Pill>}
              {o.needs_review && <Pill tone="red">needs review</Pill>}
            </div>
          </div>
          {open === o.id && (
            <div style={{ fontSize: 12, color: C.inkMid, marginTop: 6 }}>
              {(o.items || []).map((it, i) => <div key={i}>• {it.name} × {it.qty} — {fmtINR(it.price * it.qty)}</div>)}
              {o.needs_review && <Note tone="warn">{o.review_reason}</Note>}
              <div style={{ marginTop: 6, fontWeight: 700, color: C.ink }}>Recorded contents (snapshot v{o.snapshot_version}{o.corrected_by ? `, corrected by ${o.corrected_by}` : ""}{o.menu_recorded ? ", published menu recorded" : ""})</div>
              {(o.components || []).length === 0 ? <div style={{ color: C.inkLight }}>Unknown — no dishes could be identified.</div> : (
                <ul style={{ margin: "4px 0 0 16px" }}>
                  {o.components.map((c, i) => <li key={i}>{c.label || "(unknown)"}{c.unit_qty > 1 ? ` ×${Number(c.unit_qty)}` : ""} <span style={{ color: C.inkLight }}>— {c.category || "unclassified"}, {c.selection === "chosen" ? "chosen by customer" : c.selection === "fixed" ? "fixed menu" : "unknown"}</span></li>)}
                </ul>
              )}
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button className="ht-btn btn-secondary btn-sm" onClick={() => setFix(o)}>Correct contents…</button>
              </div>
            </div>
          )}
        </div>
      ))}
      {fix && <SnapshotFix order={fix} act={act} busy={busy} onClose={() => setFix(null)} />}
    </Card>
  );
}
function SnapshotFix({ order, act, busy, onClose }) {
  const C = useC();
  const [rows, setRows] = useState((order.components || []).map(c => ({ line_index: c.line_index, role: c.role, category: c.category || "other", label: c.label || "", selection: c.selection, unit_qty: c.unit_qty })));
  const [reason, setReason] = useState("");
  const upd = (i, k, v) => setRows(rows.map((r, j) => j === i ? { ...r, [k]: v } : r));
  const save = async () => { await act("staff_correct_order_snapshot", { p_order_id: order.id, p_components: rows, p_reason: reason }, "Correction saved and audited"); onClose(); };
  return (
    <Sheet title={`Correct contents — #${order.id.slice(-6).toUpperCase()}`} onClose={onClose} wide>
      <Note>Corrections are saved as a new version; the previous contents are kept in an audit trail with your name and reason. The original order lines are never altered.</Note>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, padding: "8px 0", borderTop: `1px solid ${C.border}` }}>
          <input className="ht-input" value={r.label} placeholder="Dish name" onChange={e => upd(i, "label", e.target.value)} style={{ gridColumn: "1 / -1" }} aria-label="Dish name" />
          <select className="ht-select" value={r.category} onChange={e => upd(i, "category", e.target.value)} aria-label="Category">{Object.entries(CATEGORY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <select className="ht-select" value={r.role} onChange={e => upd(i, "role", e.target.value)} aria-label="Role"><option value="main">Main</option><option value="side">Side</option><option value="bread">Bread</option></select>
          <select className="ht-select" value={r.selection} onChange={e => upd(i, "selection", e.target.value)} aria-label="Selection"><option value="fixed">Fixed menu</option><option value="chosen">Chosen by customer</option><option value="unknown">Unknown</option></select>
          <div style={{ display: "flex", gap: 6 }}>
            <input className="ht-input" type="number" min="0" value={r.unit_qty} onChange={e => upd(i, "unit_qty", e.target.value)} aria-label="Quantity per portion" />
            <button className="ht-btn btn-ghost btn-sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>
          </div>
        </div>
      ))}
      <button className="ht-btn btn-secondary btn-sm" onClick={() => setRows([...rows, { line_index: rows[0]?.line_index ?? 0, role: "main", category: "sabji", label: "", selection: "chosen", unit_qty: 1 }])}>+ Add item</button>
      <Field label="Reason for correction (required)"><input className="ht-input" value={reason} onChange={e => setReason(e.target.value)} /></Field>
      <button className="ht-btn btn-primary btn-full" disabled={busy || reason.trim().length < 3} onClick={save}>Save correction</button>
    </Sheet>
  );
}

// ── duplicates (per profile + tab) ──
function MergeDialog({ pair, supabase, onClose, onDone }) {
  const C = useC();
  const [keep, setKeep] = useState("a"); const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null); const [result, setResult] = useState(null);
  const a = { id: pair.a, name: pair.a_name, phone: pair.a_phone, orders: pair.a_orders }; const b = { id: pair.b, name: pair.b_name, phone: pair.b_phone, orders: pair.b_orders };
  const into = keep === "a" ? a : b; const from = keep === "a" ? b : a;
  const go = async () => {
    setBusy(true); setErr(null);
    try { setResult(await callRpc(supabase, "staff_merge_customers", { p_from: from.id, p_into: into.id, p_reason: reason })); }
    catch (e) { setErr(e); }
    setBusy(false);
  };
  if (result) return (
    <Sheet title="Merged" onClose={() => { onDone(into.id); onClose(); }}>
      <Note>Merge complete. Orders, preferences, feedback, notes, and contact history are all preserved and now appear on one profile; an audit record was written.</Note>
      {result.preference_conflicts?.length > 0 && <Note tone="warn">Preferences that differed (the surviving record's value was kept): {result.preference_conflicts.map(c => FIELD_LABEL[c.field]).join(", ")}.</Note>}
      <button className="ht-btn btn-primary btn-full" onClick={() => { onDone(into.id); onClose(); }}>Open merged profile</button>
    </Sheet>
  );
  return (
    <Sheet title="Review & merge" onClose={onClose}>
      <Note tone="warn">Matching names or phone numbers are only hints — merge only if you are sure these are the same person. Nothing is deleted: every order, preference, note and contact entry is kept and the merge is logged.</Note>
      <div style={{ fontSize: 12, color: C.inkMid, marginBottom: 8 }}>Why flagged: {pair.reason}</div>
      {[["a", a, pair.a_tower, pair.a_flat, pair.a_last], ["b", b, pair.b_tower, pair.b_flat, pair.b_last]].map(([k, x, t, f, last]) => (
        <label key={k} style={{ display: "flex", gap: 8, padding: 10, border: `2px solid ${keep === k ? C.saffron : C.border}`, borderRadius: 10, marginBottom: 8, cursor: "pointer", background: keep === k ? "#FFF6EC" : C.white }}>
          <input type="radio" name="keep" checked={keep === k} onChange={() => setKeep(k)} style={{ accentColor: C.saffron }} />
          <div style={{ fontSize: 13 }}><strong>Keep: {x.name || "(no name)"}</strong><div style={{ color: C.inkMid }}>{x.phone} · {t || "tower ?"}{f ? `, ${f}` : ""} · {x.orders ?? 0} delivered · last {fmtD(last)}</div></div>
        </label>
      ))}
      <div style={{ fontSize: 12, color: C.inkMid, marginBottom: 8 }}>“{from.name || from.phone}” will be merged into “{into.name || into.phone}”.</div>
      <Field label="Reason (required)"><input className="ht-input" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. same person, new number" /></Field>
      {err && <ErrorBox error={err} />}
      <button className="ht-btn btn-danger btn-full" disabled={busy || reason.trim().length < 3} onClick={go}>{busy ? "Merging…" : "Confirm merge"}</button>
    </Sheet>
  );
}
function DuplicatesCard({ p, supabase, onOpen, onChanged }) {
  const C = useC(); const s = p.summary; const [pair, setPair] = useState(null);
  if (!(p.duplicates || []).length) return null;
  return (
    <Card>
      <H sub="Possible duplicates are only flagged — never merged automatically.">Possible duplicate records</H>
      {p.duplicates.map(d => (
        <div key={d.other_id} style={{ padding: "8px 0", borderTop: `1px solid ${C.border}`, fontSize: 12.5, color: C.inkMid }}>
          <strong style={{ color: C.ink }}>{d.name || "(no name)"}</strong> · {d.phone} · {d.tower || "?"}{d.flat ? `, ${d.flat}` : ""}
          <div style={{ fontSize: 11.5 }}>{d.reason}</div>
          <button className="ht-btn btn-secondary btn-sm" style={{ marginTop: 4 }} onClick={async () => {
            try { const all = await callRpc(supabase, "staff_duplicate_candidates"); const f = all.find(x => (x.a === s.id && x.b === d.other_id) || (x.b === s.id && x.a === d.other_id)); if (f) setPair(f); } catch { /* ignore */ }
          }}>Review &amp; merge…</button>
        </div>
      ))}
      {pair && <MergeDialog pair={pair} supabase={supabase} onClose={() => setPair(null)} onDone={(id) => { onChanged(); if (id !== s.id) onOpen(id); }} />}
    </Card>
  );
}
function Duplicates({ supabase, onOpen, onChanged }) {
  const C = useC();
  const [pairs, setPairs] = useState(null); const [err, setErr] = useState(null); const [pair, setPair] = useState(null);
  const load = useCallback(async () => { try { setPairs(await callRpc(supabase, "staff_duplicate_candidates")); } catch (e) { setErr(e); } }, [supabase]);
  useEffect(() => { load(); }, [load]);
  if (err) return <ErrorBox error={err} onRetry={load} />;
  if (!pairs) return <Busy />;
  return (
    <>
      <Note>Flagged when two records share a normalised phone number, or the same name + tower + flat. They are never merged automatically — you review each pair.</Note>
      {pairs.length === 0 && <Busy text="No possible duplicates found." />}
      {pairs.map(d => (
        <Card key={d.a + d.b}>
          <div style={{ fontSize: 12, color: C.inkMid, marginBottom: 6 }}>{d.reason}</div>
          {[["a", d.a_name, d.a_phone, d.a_tower, d.a_flat, d.a_orders, d.a_last, d.a], ["b", d.b_name, d.b_phone, d.b_tower, d.b_flat, d.b_orders, d.b_last, d.b]].map(([k, n, ph, t, f, o, l, id]) => (
            <div key={k} style={{ fontSize: 13, padding: "4px 0" }}><strong>{n || "(no name)"}</strong> · {ph} · {t || "?"}{f ? `, ${f}` : ""} · {o ?? 0} delivered · last {fmtD(l)} <button className="ht-btn btn-ghost btn-sm" onClick={() => onOpen(id)}>open</button></div>
          ))}
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button className="ht-btn btn-primary btn-sm" onClick={() => setPair(d)}>Review &amp; merge…</button>
            <button className="ht-btn btn-secondary btn-sm" onClick={async () => { try { await callRpc(supabase, "staff_dismiss_duplicate", { p_a: d.a, p_b: d.b }); load(); onChanged(); } catch (e) { setErr(e); } }}>Not the same person</button>
          </div>
        </Card>
      ))}
      {pair && <MergeDialog pair={pair} supabase={supabase} onClose={() => setPair(null)} onDone={(id) => { load(); onChanged(); onOpen(id); }} />}
    </>
  );
}

// ── dish catalogue ──
function DishCatalog({ supabase, onChanged }) {
  const C = useC();
  const [rows, setRows] = useState(null); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false); const [mergeFrom, setMergeFrom] = useState(null); const [mergeInto, setMergeInto] = useState("");
  const load = useCallback(async () => { try { setRows(await callRpc(supabase, "staff_dish_catalog")); } catch (e) { setErr(e); } }, [supabase]);
  useEffect(() => { load(); }, [load]);
  const run = async (fn, args) => { setBusy(true); setErr(null); try { await callRpc(supabase, fn, args); await load(); onChanged(); } catch (e) { setErr(e); } setBusy(false); };
  if (!rows) return err ? <ErrorBox error={err} onRetry={load} /> : <Busy />;
  return (
    <>
      <Note>Every dish name is normalised to one catalogue entry (case, spacing and punctuation are ignored). If two spellings still split one dish, merge them here — original labels on past orders are kept.</Note>
      {err && <ErrorBox error={err} />}
      {rows.map(d => (
        <Card key={d.id} style={{ padding: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input className="ht-input" defaultValue={d.name} style={{ flex: "1 1 160px" }} aria-label="Dish name" onBlur={e => { if (e.target.value.trim() && e.target.value !== d.name) run("staff_update_dish", { p_id: d.id, p_name: e.target.value, p_category: d.category }); }} />
            <select className="ht-select" value={d.category} style={{ width: 120 }} aria-label="Category" onChange={e => run("staff_update_dish", { p_id: d.id, p_name: d.name, p_category: e.target.value })}>
              {Object.entries(CATEGORY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <button className="ht-btn btn-secondary btn-sm" disabled={busy} onClick={() => { setMergeFrom(d); setMergeInto(""); }}>Merge…</button>
          </div>
          <div style={{ fontSize: 11.5, color: C.inkLight, marginTop: 4 }}>{d.orders} order(s) · seen as: {(d.aliases || []).join(" / ") || "—"}</div>
        </Card>
      ))}
      {mergeFrom && (
        <Sheet title={`Merge “${mergeFrom.name}” into…`} onClose={() => setMergeFrom(null)}>
          <select className="ht-select" value={mergeInto} onChange={e => setMergeInto(e.target.value)} aria-label="Merge into">
            <option value="">Choose the dish to keep</option>
            {rows.filter(r => r.id !== mergeFrom.id).map(r => <option key={r.id} value={r.id}>{r.name} ({CATEGORY_LABEL[r.category]})</option>)}
          </select>
          <p style={{ fontSize: 12, color: C.inkMid, margin: "10px 0" }}>All past and future orders using “{mergeFrom.name}” will count as the chosen dish. This re-runs the analysis for everyone.</p>
          <button className="ht-btn btn-primary btn-full" disabled={!mergeInto || busy} onClick={async () => { await run("staff_merge_dishes", { p_from: mergeFrom.id, p_into: mergeInto }); setMergeFrom(null); }}>Merge dishes</button>
        </Sheet>
      )}
    </>
  );
}

// ═════════════════════════════════════════════════════════════
// REACTIVATION
// ═════════════════════════════════════════════════════════════
function Reactivation({ supabase, data, onOpen, onChanged, onDeleted }) {
  const C = useC();
  const all = data.customers || [];
  const [f, setF] = useState({ bucket: "both", society: "", tower: "", freq: "any", minOrders: "", minSpend: "", fav: "", top: "", variant: "", slot: "", missingForm: false, complaints: false, deferred: "any", showAll: false });
  const [showFilters, setShowFilters] = useState(false);
  const [draft, setDraft] = useState(null);
  const [logFor, setLogFor] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));

  const opts = useMemo(() => {
    const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort();
    return {
      societies: uniq(all.map(c => c.society)), towers: uniq(all.map(c => c.tower)),
      fav: uniq(all.flatMap(c => [...(c.confirmed?.fav_dishes?.value || []), ...(c.confirmed?.fav_sides?.value || [])].map(x => x.label))),
      top: uniq(all.flatMap(c => [...(c.top_mains || []), ...(c.top_sides || []), ...(c.chosen_mains || []), ...(c.chosen_sides || [])].map(x => x.name))),
      variants: uniq(all.map(c => c.usual_variant)),
    };
  }, [all]);

  const slotOf = (c) => { const e = Object.entries(c.slot_counts || {}).filter(([k]) => k !== "unknown").sort((a, b) => b[1] - a[1]); return e[0]?.[0] || ""; };
  const deferred = (c) => ["defer", "wait"].includes(c.suggestion?.action);
  const filtered = useMemo(() => all.filter(c => {
    const inactive = c.bucket === "inactive_7_13" || c.bucket === "inactive_14_plus";
    if (!inactive) return false;
    if (f.bucket === "7_13" && c.bucket !== "inactive_7_13") return false;
    if (f.bucket === "14" && c.bucket !== "inactive_14_plus") return false;
    if (f.society && c.society !== f.society) return false;
    if (f.tower && c.tower !== f.tower) return false;
    if (f.freq === "regular" && !(c.orders_per_week >= 1 && c.delivered_orders >= 3)) return false;
    if (f.freq === "occasional" && !(c.orders_per_week < 1 || c.delivered_orders < 3)) return false;
    if (f.minOrders !== "" && c.delivered_orders < Number(f.minOrders)) return false;
    if (f.minSpend !== "" && c.net_spend < Number(f.minSpend)) return false;
    if (f.fav && ![...(c.confirmed?.fav_dishes?.value || []), ...(c.confirmed?.fav_sides?.value || [])].some(x => x.label === f.fav)) return false;
    if (f.top && ![...(c.top_mains || []), ...(c.top_sides || []), ...(c.chosen_mains || []), ...(c.chosen_sides || [])].some(x => x.name === f.top)) return false;
    if (f.variant && c.usual_variant !== f.variant) return false;
    if (f.slot && slotOf(c) !== f.slot) return false;
    if (f.missingForm && c.form_status !== "none") return false;
    if (f.complaints && !(c.complaints > 0)) return false;
    if (f.deferred === "only" && !deferred(c)) return false;
    if (f.deferred === "hide" && deferred(c)) return false;
    return true;
  }).sort((a, b) => (a.suggestion?.priority ?? 99) - (b.suggestion?.priority ?? 99) || b.net_spend - a.net_spend), [all, f]);

  const neverOrdered = all.filter(c => c.bucket === "no_delivered").length;

  const card = (c) => {
    const s = c.suggestion || {};
    const tone = s.action === "resolve_first" ? "red" : ["menu_reminder", "gentle_reminder", "checkin"].includes(s.action) ? "saffron" : "neutral";
    return (
      <div key={c.id} className="ht-card" style={{ padding: 12, marginBottom: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }} onClick={() => onOpen(c.id)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === "Enter") onOpen(c.id); }}>
          <div style={{ cursor: "pointer" }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: C.ink }}>{c.name || "(no name)"}</div>
            <div style={{ fontSize: 12, color: C.inkMid }}>{c.tower || "tower ?"}{c.flat ? `, ${c.flat}` : ""}{c.society ? ` · ${c.society}` : ""} · {c.delivered_orders} orders · {fmtINR(c.net_spend)} · ~{c.orders_per_week ?? "—"}/wk</div>
          </div>
          <Pill tone={bucketTone(c.bucket)}>{c.days_since}d</Pill>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
          {c.complaints > 0 && <Pill tone="red">{c.complaints} unresolved complaint{c.complaints > 1 ? "s" : ""}</Pill>}
          {c.form_status === "none" && <Pill>no preference form</Pill>}
          {(c.confirmed?.fav_dishes?.value || []).slice(0, 2).map(x => <Pill key={x.label} tone="green">Confirmed fav: {x.label}</Pill>)}
          {(c.top_mains || []).slice(0, 1).map(x => <Pill key={x.name} tone="blue">Most delivered: {x.name}</Pill>)}
          {c.usual_variant && <Pill>{VARIANT_LABEL[c.usual_variant]}</Pill>}
        </div>
        <div style={{ background: tone === "red" ? C.redLight : C.saffronLight, borderRadius: 10, padding: "8px 10px", marginTop: 8, fontSize: 12.5, color: C.ink }}>
          <strong>Suggested: {s.label}</strong>
          <div style={{ color: C.inkMid, marginTop: 2, lineHeight: 1.45 }}>{s.reason}</div>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          {s.draft && <button className="ht-btn btn-secondary btn-sm" onClick={() => setDraft(c)}>✍️ Message draft</button>}
          <button className="ht-btn btn-secondary btn-sm" onClick={() => setLogFor({ c, msg: "" })}>Log contact</button>
          <button className="ht-btn btn-ghost btn-sm" onClick={() => onOpen(c.id)}>Open profile</button>
          <DeleteCustomerBtn supabase={supabase} c={c} onDone={onDeleted} style={{ marginLeft: "auto" }} />
        </div>
      </div>
    );
  };

  const sel = (k, label, options, placeholder) => (
    <Field label={label}>
      <select className="ht-select" value={f[k]} onChange={e => set(k, e.target.value)}>
        <option value="">{placeholder}</option>{options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </Field>
  );
  return (
    <>
      <Card style={{ padding: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 6, overflowX: "auto" }}>
            {[["both", "All inactive"], ["7_13", "7–13 days"], ["14", "14+ days"]].map(([k, l]) => (
              <button key={k} className="ht-btn btn-sm" onClick={() => set("bucket", k)} style={{ background: f.bucket === k ? C.saffron : C.white, color: f.bucket === k ? C.white : C.inkMid, border: `1.5px solid ${f.bucket === k ? C.saffron : C.border}`, whiteSpace: "nowrap" }}>{l}</button>
            ))}
          </div>
          <button className="ht-btn btn-secondary btn-sm" onClick={() => setShowFilters(!showFilters)}>{showFilters ? "Hide filters" : "More filters"}</button>
        </div>
        {showFilters && (
          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", columnGap: 10 }}>
            {sel("society", "Society", opts.societies, "Any society")}
            {sel("tower", "Tower", opts.towers, "Any tower")}
            <Field label="Previous frequency"><select className="ht-select" value={f.freq} onChange={e => set("freq", e.target.value)}><option value="any">Any</option><option value="regular">Regular (≥1/week, 3+ orders)</option><option value="occasional">Occasional</option></select></Field>
            <Field label="Min delivered orders"><input className="ht-input" type="number" min="0" value={f.minOrders} onChange={e => set("minOrders", e.target.value)} /></Field>
            <Field label="Min total spend (₹)"><input className="ht-input" type="number" min="0" value={f.minSpend} onChange={e => set("minSpend", e.target.value)} /></Field>
            {sel("fav", "Confirmed favourite dish/side", opts.fav, "Any / none")}
            {sel("top", "Most delivered / frequently selected", opts.top, "Any dish or side")}
            <Field label="Usual variant"><select className="ht-select" value={f.variant} onChange={e => set("variant", e.target.value)}><option value="">Any</option>{opts.variants.map(v => <option key={v} value={v}>{VARIANT_LABEL[v] || v}</option>)}</select></Field>
            <Field label="Meal slot (inferred)"><select className="ht-select" value={f.slot} onChange={e => set("slot", e.target.value)}><option value="">Any</option><option value="lunch">Lunch</option><option value="dinner">Dinner</option></select></Field>
            <Field label="Away / follow-up set"><select className="ht-select" value={f.deferred} onChange={e => set("deferred", e.target.value)}><option value="any">Show all</option><option value="hide">Hide deferred</option><option value="only">Only deferred</option></select></Field>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, color: C.ink, marginTop: 8 }}><input type="checkbox" checked={f.missingForm} onChange={e => set("missingForm", e.target.checked)} /> Missing preference form</label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, color: C.ink, marginTop: 8 }}><input type="checkbox" checked={f.complaints} onChange={e => set("complaints", e.target.checked)} /> Unresolved complaints</label>
          </div>
        )}
      </Card>
      <Note>
        {data.next_menu?.date
          ? <>Dish matches use the published menu for <strong>{fmtD(data.next_menu.date)}</strong>: {(data.next_menu.dishes || []).map(d => d.name).join(", ")}.</>
          : <>No published menu exists for today or later, so dish-based reminders can't be matched yet.</>}
        {" "}Nothing is sent automatically — drafts are copy-only. {neverOrdered > 0 && `${neverOrdered} customer(s) have never had a delivered order and are listed only under Customers.`}
      </Note>
      {filtered.length > 0 && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <span style={{ fontSize: 12, color: C.inkMid }}>{filtered.length} shown — copy/delete apply to exactly these.</span>
          <InactiveListActions supabase={supabase} rows={filtered} title={f.bucket === "7_13" ? "Inactive 7–13 days" : f.bucket === "14" ? "Inactive 14+ days" : "All inactive"} onDone={onDeleted} />
        </div>
      )}
      {filtered.length === 0 && <Busy text="No inactive customers match these filters." />}
      {filtered.map(card)}
      {draft && <DraftSheet c={draft} onClose={() => setDraft(null)} onLog={(msg) => { setLogFor({ c: draft, msg }); setDraft(null); }} />}
      {logFor && <ContactForm custId={logFor.c.id} initialMessage={logFor.msg} busy={busy} onClose={() => setLogFor(null)}
        act={async (fn, args, ok) => { setBusy(true); try { await callRpc(supabase, fn, args); onChanged(); } catch (e) { window.alert("Error: " + errMsg(e)); } setBusy(false); }} />}
    </>
  );
}
function DraftSheet({ c, onClose, onLog }) {
  const C = useC();
  const [text, setText] = useState(buildDraft(c)); const [copied, setCopied] = useState(false);
  const s = c.suggestion || {};
  return (
    <Sheet title={s.draft === "reminder" ? "Gentle reminder draft" : "Check-in draft"} onClose={onClose}>
      <Note tone="warn">This is only a draft — nothing is sent. Copy it, send it yourself, then log the contact.</Note>
      <textarea className="ht-input" rows={7} value={text} onChange={e => setText(e.target.value)} aria-label="Message draft" />
      <div style={{ fontSize: 11.5, color: C.inkLight, margin: "6px 0 10px" }}>{s.draft === "checkin" ? "14+ days: ask for feedback first — suggest an offer only after they reply." : "7–13 days: a gentle nudge with a relevant dish or menu."}</div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="ht-btn btn-primary" onClick={async () => { setCopied(await copyText(text)); }}>{copied ? "✓ Copied" : "Copy message"}</button>
        <button className="ht-btn btn-secondary" onClick={() => onLog(text)}>I sent it — log contact</button>
      </div>
    </Sheet>
  );
}

// ═════════════════════════════════════════════════════════════
// REPORT TAB (plugs into the existing Analytics panel)
// ═════════════════════════════════════════════════════════════
export function CustomerInsightsReport({ supabase, C = DEFAULT_C, onOpenCustomer }) {
  const [days, setDays] = useState(30);
  const [r, setR] = useState(null); const [err, setErr] = useState(null); const [loading, setLoading] = useState(true);
  const load = useCallback(async () => { setLoading(true); setErr(null); try { setR(await callRpc(supabase, "staff_report_customer_metrics", { p_days: days })); } catch (e) { setErr(e); } setLoading(false); }, [supabase, days]);
  useEffect(() => { load(); }, [load]);
  const miss = r?.missing_data || {};
  const [note, setNote] = useState(null); const [showAll, setShowAll] = useState({});
  const onDone = (text, changed) => { setNote({ text }); if (changed) load(); };
  // called as a function (not <List/>) so the action buttons keep their state across re-renders
  const List = ({ title, rows, tone, bucket }) => {
    rows = rows.map(c => ({ ...c, bucket }));
    const shown = showAll[bucket] ? rows : rows.slice(0, 25);
    return (
      <Card>
        <H sub="Sorted by lifetime spend." right={<InactiveListActions supabase={supabase} rows={rows} title={title} onDone={onDone} />}>{title} ({rows.length})</H>
        {rows.length === 0 && <div style={{ fontSize: 12, color: C.inkLight }}>None.</div>}
        {shown.map(c => (
          <div key={c.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "7px 0", borderTop: `1px solid ${C.border}`, fontSize: 12.5 }}>
            <div><strong style={{ color: C.ink }}>{c.name || "(no name)"}</strong> <span style={{ color: C.inkMid }}>· {c.tower || "tower ?"} · {c.delivered_orders} orders · {fmtINR(c.net_spend)} · last {fmtD(c.last_delivered)}</span>
              <div style={{ fontSize: 11.5, color: C.inkLight }}>{c.suggestion?.label}</div></div>
            <div style={{ textAlign: "right" }}><Pill tone={tone}>{c.days_since}d</Pill>
              <div style={{ display: "flex", gap: 2, justifyContent: "flex-end" }}>
                <button className="ht-btn btn-ghost btn-sm" style={{ padding: "1px 6px" }} onClick={() => onOpenCustomer && onOpenCustomer(c.id)}>open</button>
                <DeleteCustomerBtn supabase={supabase} c={c} onDone={onDone} style={{ padding: "1px 6px" }} />
              </div></div>
          </div>
        ))}
        {rows.length > 25 && (
          <div style={{ fontSize: 11.5, color: C.inkLight, paddingTop: 6 }}>
            {showAll[bucket] ? `Showing all ${rows.length}.` : `Showing 25 of ${rows.length}.`} “Copy list” and “Delete all” apply to all {rows.length}.{" "}
            <button className="ht-btn btn-ghost btn-sm" style={{ padding: "0 6px" }} onClick={() => setShowAll(m => ({ ...m, [bucket]: !m[bucket] }))}>{showAll[bucket] ? "Show fewer" : "Show all"}</button>
          </div>
        )}
      </Card>
    );
  };
  const popTable = (rows, cols) => (
    <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
      <thead><tr style={{ textAlign: "left", color: C.inkLight }}>{cols.map(c => <th key={c[0]} style={{ padding: "4px 6px" }}>{c[0]}</th>)}</tr></thead>
      <tbody>{rows.map((x, i) => <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}>{cols.map(c => <td key={c[0]} style={{ padding: "5px 6px" }}>{c[1](x)}</td>)}</tr>)}</tbody>
    </table></div>
  );
  return (
    <ThemeCtx.Provider value={C}>
      <div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: C.inkMid }}>Window:</span>
          {[7, 14, 30, 60, 90].map(d => <button key={d} className="ht-btn btn-sm" onClick={() => setDays(d)} style={{ background: days === d ? C.saffron : C.white, color: days === d ? C.white : C.inkMid, border: `1.5px solid ${days === d ? C.saffron : C.border}` }}>{d} days</button>)}
        </div>
        {err && <ErrorBox error={err} onRetry={load} />}
        {loading && !r && <Busy />}
        {r && (
          <>
            <Note>As of {fmtD(r.as_of)} (IST). Window {fmtD(r.window.from)} – {fmtD(r.window.to)}, compared with {fmtD(r.window.prev_from)} – {fmtD(r.window.prev_to)}. {r.spend_definition}</Note>
            <Card>
              <H sub="Evidence-based, from delivered-order history.">Top 3 priorities</H>
              {(r.priorities || []).length === 0 && <div style={{ fontSize: 12, color: C.inkLight }}>Not enough data for priorities yet.</div>}
              {(r.priorities || []).map((p, i) => (
                <div key={p.key} style={{ padding: "9px 0", borderTop: i ? `1px solid ${C.border}` : "none" }}>
                  <div style={{ fontSize: 13.5, fontWeight: 800, color: C.ink }}>{i + 1}. {p.title}</div>
                  <div style={{ fontSize: 12.5, color: C.inkMid, margin: "2px 0" }}>{p.action}</div>
                  <ul style={{ margin: "2px 0 0 16px", fontSize: 12, color: C.inkMid }}>{(p.evidence || []).map((e, j) => <li key={j}>{e}</li>)}</ul>
                </div>
              ))}
            </Card>
            <Card>
              <H sub={r.new_vs_repeat.definition}>New vs repeat customers ({r.new_vs_repeat.window_days} days)</H>
              <StatGrid>
                <Stat label="New customers" value={r.new_vs_repeat.new_customers} sub={`${r.new_vs_repeat.new_orders ?? 0} orders · ${fmtINR(r.new_vs_repeat.new_revenue)}`} />
                <Stat label="Repeat customers" value={r.new_vs_repeat.repeat_customers} sub={`${r.new_vs_repeat.repeat_orders ?? 0} orders · ${fmtINR(r.new_vs_repeat.repeat_revenue)}`} />
                <Stat label="One-time (lifetime)" value={r.new_vs_repeat.lifetime_one_time_customers ?? 0} />
                <Stat label="Repeat (lifetime)" value={r.new_vs_repeat.lifetime_repeat_customers ?? 0} />
              </StatGrid>
            </Card>
            {note && <Note>{note.text}</Note>}
            {List({ title: "Inactive 7–13 days", rows: r.inactive_7_13 || [], tone: "amber", bucket: "inactive_7_13" })}
            {List({ title: "Inactive 14+ days", rows: r.inactive_14_plus || [], tone: "red", bucket: "inactive_14_plus" })}
            <Card>
              <H sub="Delivered orders only; tower as recorded on each order.">Towers</H>
              {popTable(r.towers || [], [["Tower", x => x.tower], ["Orders", x => x.delivered_orders], ["Revenue", x => fmtINR(x.revenue)], ["Last delivery", x => `${fmtD(x.last_delivery)} (${x.days_since_last}d)`], [`Last ${r.window.days}d`, x => `${x.orders_window} / ${fmtINR(x.revenue_window)}`], ["Prev", x => x.orders_prev_window]])}
            </Card>
            <Card>
              <H sub="Distinct delivered orders; units = quantity ordered.">Popular variants</H>
              {popTable(r.popular.variants || [], [["Variant", x => x.label], [`Orders (${r.window.days}d)`, x => x.orders_window], ["Units", x => x.units_window], ["Orders (lifetime)", x => x.orders_lifetime], ["Units", x => x.units_lifetime]])}
            </Card>
            <Card>
              <H sub="Dish counted once per delivered order. Chosen = picked by the customer from options.">Popular dishes &amp; sides</H>
              <div style={{ fontSize: 12.5, fontWeight: 800, margin: "4px 0" }}>Main dishes</div>
              {popTable(r.popular.main_dishes || [], [["Dish", x => x.name], [`Orders (${r.window.days}d)`, x => x.orders_window], ["Lifetime", x => x.orders_lifetime], ["Chosen", x => x.chosen_orders_lifetime]])}
              <div style={{ fontSize: 12.5, fontWeight: 800, margin: "10px 0 4px" }}>Sides</div>
              {popTable(r.popular.sides || [], [["Side", x => x.name], [`Orders (${r.window.days}d)`, x => x.orders_window], ["Lifetime", x => x.orders_lifetime], ["Chosen", x => x.chosen_orders_lifetime]])}
              <div style={{ fontSize: 12.5, fontWeight: 800, margin: "10px 0 4px" }}>Breads</div>
              {popTable(r.popular.breads || [], [["Bread", x => x.name], [`Qty (${r.window.days}d)`, x => Number(x.qty_window)], ["Lifetime orders", x => x.orders_lifetime]])}
            </Card>
            <Card>
              <H sub={r.variant_changes.basis}>Variant upgrades / downgrades</H>
              <div style={{ fontSize: 12.5, color: C.inkMid }}>Up: <strong>{r.variant_changes.counts.up || 0}</strong> · Down: <strong>{r.variant_changes.counts.down || 0}</strong> · Same: <strong>{r.variant_changes.counts.same || 0}</strong> · Not enough data: <strong>{r.variant_changes.counts.insufficient_data || 0}</strong></div>
              {[["Upgrades", r.variant_changes.upgrades], ["Downgrades", r.variant_changes.downgrades]].map(([t, rows]) => rows.length > 0 && (
                <div key={t} style={{ marginTop: 8, fontSize: 12.5 }}><strong>{t}:</strong> {rows.map(x => `${x.name} (${VARIANT_LABEL[x.from_variant]} → ${VARIANT_LABEL[x.to_variant]})`).join("; ")}</div>
              ))}
            </Card>
            <Card>
              <H sub="Flagged for staff review — never merged automatically.">Duplicate identity candidates</H>
              <div style={{ fontSize: 12.5, color: C.inkMid }}>{r.duplicate_candidates.count} pair(s). {r.duplicate_candidates.pairs.slice(0, 5).map(d => `${d.a_name || d.a_phone} ↔ ${d.b_name || d.b_phone} (${d.reason})`).join("; ")}</div>
            </Card>
            <Card>
              <H sub="Gaps that limit the analysis.">Missing-data indicators</H>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 6, fontSize: 12, color: C.inkMid }}>
                {[
                  ["Customers", miss.customers], ["Customers without tower", miss.customers_missing_tower], ["Customers without name", miss.customers_missing_name], ["Customers without society", miss.customers_missing_society],
                  ["Without confirmed preferences", miss.customers_without_confirmed_preferences], ["Never saw/answered the form", miss.customers_without_preference_form],
                  ["Delivered orders", miss.delivered_orders], ["Delivered without delivered timestamp", miss.delivered_orders_without_delivered_timestamp],
                  ["Delivered, contents not fully known", miss.delivered_orders_snapshot_not_full], ["Delivered, no published-menu record", miss.delivered_orders_without_menu_record],
                  ["Snapshots needing review", miss.snapshots_needing_review], ["Unresolved processing errors", miss.unresolved_analysis_errors],
                ].map(([l, v]) => <div key={l} style={{ display: "flex", justifyContent: "space-between", borderBottom: `1px dashed ${C.border}`, padding: "3px 0" }}><span>{l}</span><strong style={{ color: C.ink }}>{v ?? 0}</strong></div>)}
              </div>
            </Card>
          </>
        )}
      </div>
    </ThemeCtx.Provider>
  );
}

// ═════════════════════════════════════════════════════════════
// CUSTOMER-FACING: PREFERENCE FORM
// ═════════════════════════════════════════════════════════════
function FormQ({ title, hint, children }) {
  const C = useC();
  return (
    <Card><div style={{ fontSize: 14, fontWeight: 800, color: C.ink }}>{title} <span style={{ fontSize: 11, fontWeight: 600, color: C.inkLight }}>optional</span></div>
      {hint && <div style={{ fontSize: 11.5, color: C.inkLight, margin: "2px 0 8px" }}>{hint}</div>}{!hint && <div style={{ height: 8 }} />}{children}</Card>
  );
}
function FormChips({ field, options, a, setA }) {
  const C = useC();
  const [other, setOther] = useState("");
  const sel = a[field] || [];
  const all = [...new Set([...options.map(o => o.label), ...sel])];
  const toggle = (label) => setA(prev => ({ ...prev, [field]: (prev[field] || []).includes(label) ? prev[field].filter(x => x !== label) : [...(prev[field] || []), label] }));
  const addOther = () => { const t = other.trim().slice(0, 60); if (t && !sel.some(x => x.toLowerCase() === t.toLowerCase())) setA(prev => ({ ...prev, [field]: [...(prev[field] || []), t] })); setOther(""); };
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {all.map(l => (
          <button key={l} type="button" aria-pressed={sel.includes(l)} onClick={() => toggle(l)} className="ht-btn btn-sm"
            style={{ background: sel.includes(l) ? C.saffron : C.white, color: sel.includes(l) ? C.white : C.inkMid, border: `1.5px solid ${sel.includes(l) ? C.saffron : C.border}`, padding: "7px 12px" }}>{l}</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <input className="ht-input" value={other} onChange={e => setOther(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addOther(); } }} placeholder="Other (type a dish)" maxLength={60} aria-label={`Other for ${field}`} />
        <button type="button" className="ht-btn btn-secondary btn-sm" onClick={addOther}>Add</button>
      </div>
    </div>
  );
}
function FormRadios({ field, options, a, setA }) {
  const C = useC();
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {options.map(([v, l]) => (
        <button key={v} type="button" aria-pressed={a[field] === v} onClick={() => setA(prev => ({ ...prev, [field]: prev[field] === v ? "" : v }))} className="ht-btn btn-sm"
          style={{ background: a[field] === v ? C.saffron : C.white, color: a[field] === v ? C.white : C.inkMid, border: `1.5px solid ${a[field] === v ? C.saffron : C.border}`, padding: "7px 14px" }}>{l}</button>
      ))}
    </div>
  );
}
export function PreferenceFormPage({ supabase, C = DEFAULT_C, token, onDone }) {
  const [state, setState] = useState("loading"); // loading | invalid | form | saved | skipped
  const [data, setData] = useState(null);
  const [a, setA] = useState({}); const [init, setInit] = useState({});
  const [feedback, setFeedback] = useState("");
  const [saving, setSaving] = useState(false); const [err, setErr] = useState(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await callRpc(supabase, "pref_form_get", { p_token: token });
        if (!live) return;
        if (!r || !r.ok) { setState("invalid"); return; }
        setData(r);
        const base = {
          fav_dishes: (r.answers.fav_dishes || []).map(x => x.label), fav_sides: (r.answers.fav_sides || []).map(x => x.label), disliked_dishes: (r.answers.disliked_dishes || []).map(x => x.label),
          bread_pref: r.answers.bread_pref || "", spice: r.answers.spice || "", oil: r.answers.oil || "", portion_pref: r.answers.portion_pref || "", usual_meal: r.answers.usual_meal || "",
        };
        setA(base); setInit(base);
        setState("form");
      } catch { if (live) setState("invalid"); }
    })();
    return () => { live = false; };
  }, [supabase, token]);

  const shell = (children) => (
    <ThemeCtx.Provider value={C}>
      <div style={{ minHeight: "100vh", background: C.cream, padding: "24px 16px 48px" }}>
        <div style={{ maxWidth: 480, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 18 }}>
            <div style={{ fontSize: 30 }}>🍱</div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: C.ink, margin: "2px 0" }}>Homely Tiffins</h1>
          </div>
          {children}
        </div>
      </div>
    </ThemeCtx.Provider>
  );
  // onDone is set when the form is shown over the order page right after an order:
  // skip and save then return to that page instead of the menu.
  const home = () => { if (onDone) onDone(); else window.location.hash = ""; };
  const backLabel = onDone ? "Back to my order" : "Back to menu";

  if (state === "loading") return shell(<Busy />);
  if (state === "invalid") return shell(
    <Card><h2 style={{ fontSize: 17, fontWeight: 800, color: C.ink, margin: "0 0 6px" }}>This link isn't working</h2>
      <p style={{ fontSize: 13.5, color: C.inkMid, lineHeight: 1.55 }}>It may have expired or been replaced. You can open the form again from the order page in the app, or ask us for a new link. Ordering works as usual.</p>
      <button className="ht-btn btn-primary btn-full" style={{ marginTop: 12 }} onClick={home}>{onDone ? "Back to my order" : "Go to menu"}</button></Card>);
  if (state === "saved" || state === "skipped") return shell(
    <Card style={{ textAlign: "center" }}>
      <div style={{ fontSize: 34 }}>{state === "saved" ? "🙏" : "👍"}</div>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink, margin: "6px 0" }}>{state === "saved" ? "Thank you!" : "No problem"}</h2>
      <p style={{ fontSize: 13.5, color: C.inkMid, lineHeight: 1.55 }}>{state === "saved" ? "Your preferences are saved. You can come back to this same link any time to change them." : "You can fill this in later using the link on your order page."}</p>
      <button className="ht-btn btn-primary btn-full" style={{ marginTop: 12 }} onClick={home}>{backLabel}</button>
    </Card>);

  const Chips = FormChips; const Radios = FormRadios; const Q = FormQ;
  const dirtyKeys = Object.keys(a).filter(k => JSON.stringify(a[k]) !== JSON.stringify(init[k]));
  const canSave = dirtyKeys.length > 0 || feedback.trim();
  const save = async () => {
    setSaving(true); setErr(null);
    try {
      const answers = {}; dirtyKeys.forEach(k => { answers[k] = a[k]; });
      if (feedback.trim()) answers.feedback = feedback.trim();
      const r = await callRpc(supabase, "pref_form_save", { p_token: token, p_answers: answers });
      if (!r || !r.ok) throw new Error("This link has expired. Please ask us for a new one.");
      setState("saved");
    } catch (e) { setErr(e); }
    setSaving(false);
  };
  const skip = async () => {
    try { await callRpc(supabase, "pref_form_skip", { p_token: token }); } catch { /* skipping must never fail */ }
    if (onDone) { onDone(); return; }
    setState("skipped");
  };
  const obs = data.observed || {};
  const confFav = [...(a.fav_dishes || []), ...(a.fav_sides || [])].map(x => x.toLowerCase());
  const obsAll = [...(obs.mains || []), ...(obs.sides || [])];
  const showObs = obsAll.length > 0;
  const obsDiffers = showObs && confFav.length > 0 && !obsAll.some(x => confFav.includes(x.toLowerCase()));

  return shell(
    <>
      {/* Skip at the top too, so customers don't have to scroll past the whole form */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <button className="ht-btn btn-ghost btn-sm" onClick={skip} data-testid="pref-skip-top">Skip for now</button>
      </div>
      <Card>
        <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink, margin: "0 0 4px" }}>Tell us your food preferences{data.first_name ? `, ${data.first_name}` : ""}</h2>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, margin: "0 0 8px" }}>Just one time, and it takes only 30 seconds.</div>
        <p style={{ fontSize: 13, color: C.inkMid, lineHeight: 1.55 }}>Everything here is optional. Your answers help us suggest meals you'll like. They don't guarantee we can customise every order.</p>
        {showObs && <p style={{ fontSize: 12, color: C.inkLight, marginTop: 6 }}>For reference, what we've delivered to you most often: {obsAll.join(", ")}. {obsDiffers ? "Your answers below are different — that's fine, we'll go by what you tell us." : "Tell us what you actually like below."}</p>}
      </Card>
      <Q title="Favourite sabjis & dals" hint="Pick any, or add your own."><Chips field="fav_dishes" options={data.main_options} a={a} setA={setA} /></Q>
      <Q title="Favourite sides" hint="Rice, raita, sweets, salad, breads…"><Chips field="fav_sides" options={data.side_options} a={a} setA={setA} /></Q>
      <Q title="Anything you don't like?"><Chips field="disliked_dishes" options={data.main_options} a={a} setA={setA} /></Q>
      <Q title="Roti, paratha or rice?"><Radios field="bread_pref" options={OPTIONS.bread_pref} a={a} setA={setA} /></Q>
      <Q title="Spice level"><Radios field="spice" options={OPTIONS.spice} a={a} setA={setA} /></Q>
      <Q title="Oil" hint="We'll note it; we can't promise every request."><Radios field="oil" options={OPTIONS.oil} a={a} setA={setA} /></Q>
      <Q title="Portion"><Radios field="portion_pref" options={OPTIONS.portion_pref} a={a} setA={setA} /></Q>
      <Q title="When do you usually eat our tiffin?"><Radios field="usual_meal" options={OPTIONS.usual_meal} a={a} setA={setA} /></Q>
      <Q title="Anything else you'd like to tell us?">
        <textarea className="ht-input" rows={3} maxLength={1000} value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="Feedback, suggestions…" aria-label="Feedback" />
      </Q>
      {err && <ErrorBox error={err} />}
      <button className="ht-btn btn-primary btn-full btn-lg" disabled={saving || !canSave} onClick={save}>{saving ? "Saving…" : "Save my preferences"}</button>
      <button className="ht-btn btn-ghost btn-full" style={{ marginTop: 8 }} onClick={skip}>Skip for now</button>
      <p style={{ fontSize: 11.5, color: C.inkLight, textAlign: "center", marginTop: 10 }}>You can open this link again any time to update your answers.</p>
    </>
  );
}

// ═════════════════════════════════════════════════════════════
// CUSTOMER-FACING: ENTRY CARD (order confirmation + account area)
// ═════════════════════════════════════════════════════════════
export function PreferencePromoCard({ supabase, C = DEFAULT_C, orderId, style, recheck }) {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null); const [hidden, setHidden] = useState(false);
  const [done, setDone] = useState(false);
  // Once the customer has saved the form, the card never shows again.
  useEffect(() => {
    if (!orderId) return;
    let live = true;
    callRpc(supabase, "pref_form_status_for_order", { p_order_id: orderId })
      .then(r => { if (live && r && r.ok && r.completed) setDone(true); })
      .catch(() => { /* if the check fails, keep showing the card */ });
    return () => { live = false; };
  }, [supabase, orderId, recheck]);
  if (!orderId || hidden || done) return null;
  const open = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await callRpc(supabase, "pref_form_token_for_order", { p_order_id: orderId });
      if (!r || !r.ok) throw new Error("Couldn't open the form right now.");
      window.location.hash = "#/prefs/" + r.token;
    } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <div className="ht-card slide-in" style={{ padding: 18, marginBottom: 16, ...style }} data-testid="pref-promo">
      <div style={{ fontSize: 14, fontWeight: 800, color: C.ink, marginBottom: 4 }}>🥘 Tell us your food preferences</div>
      <p style={{ fontSize: 12, color: C.inkMid, lineHeight: 1.5, marginBottom: 10 }}>A quick, optional form — favourite dishes, spice level, portion. It helps our recommendations (it doesn't guarantee customisation).</p>
      {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 6 }}>{errMsg(err)}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="ht-btn btn-primary btn-sm" disabled={busy} onClick={open}>{busy ? "Opening…" : "Open the form"}</button>
        <button className="ht-btn btn-ghost btn-sm" onClick={() => setHidden(true)}>Not now</button>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// CUSTOMER-FACING: AUTO-OPEN AFTER AN ORDER
// Opens the form over the order page once an order is placed, until the
// customer has saved it. Skipping closes it; it opens again after their next
// order. Never blocks ordering: any failure just closes it quietly.
// ═════════════════════════════════════════════════════════════
export function PreferenceAutoPrompt({ supabase, C = DEFAULT_C, orderId, onClose }) {
  const [token, setToken] = useState(null);
  useEffect(() => {
    if (!orderId) { onClose(); return; }
    let live = true;
    (async () => {
      // The order reaches the database a moment after it is placed, so retry briefly.
      for (let i = 0; i < 6 && live; i++) {
        try {
          const s = await callRpc(supabase, "pref_form_status_for_order", { p_order_id: orderId });
          if (s && s.ok) {
            if (s.completed) { if (live) onClose(); return; }
            const t = await callRpc(supabase, "pref_form_token_for_order", { p_order_id: orderId });
            if (t && t.ok) { if (live) setToken(t.token); return; }
          }
        } catch { /* try again */ }
        await new Promise(res => setTimeout(res, 1500));
      }
      if (live) onClose();
    })();
    return () => { live = false; };
  }, [supabase, orderId]);
  if (!token) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 3000, overflowY: "auto", background: C.cream }} data-testid="pref-auto">
      <PreferenceFormPage supabase={supabase} C={C} token={token} onDone={onClose} />
    </div>
  );
}
