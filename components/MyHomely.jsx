import { useState, useEffect, useCallback } from "react";

// ─────────────────────────────────────────────────────────────
// MY HOMELY — customer account
// Phone + password login (first time / forgot password: SMS OTP), then the
// customer's own profile, orders, favourites, rewards and credit ledger.
//
// Every read/write goes through the my_* RPCs (supabase/migrations
// …customer_accounts_00*.sql). The database identifies the customer from the
// verified phone on their Supabase Auth login — nothing here sends a phone or
// customer id that the server trusts.
// ─────────────────────────────────────────────────────────────

// Same palette as the home page (HC in App.jsx).
const HC = {
  orange: "#E0731A", orangeDeep: "#C4620F", cream: "#F6EFE1", card: "#FCF8F0",
  peach: "#F6E6D0", brown: "#3B2A1A", brownMid: "#6E5B44", brownSoft: "#B8A484",
  dash: "#E6C7A2", green: "#2E7D32", greenBg: "#E8F5E9", red: "#C0392B", redBg: "#FDEAEA",
};
const SERIF = "'Playfair Display', Georgia, serif";

const STATUS_LABEL = {
  pending: "Placed", preparing: "Preparing", ready: "Ready", dispatched: "On the way",
  delivered: "Delivered", rejected: "Not accepted",
};
const SIDE_LABEL = { raita: "Raita", sweet: "Sweet", rice: "Rice" };
const DAY_LABEL = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

// ── helpers ──
const fmtINR = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
const fmtD = (d) => {
  if (!d) return "";
  const dt = new Date(String(d).length <= 10 ? d + "T00:00:00" : d);
  return isNaN(dt) ? String(d) : dt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: String(d).length <= 10 ? undefined : "Asia/Kolkata" });
};
const firstName = (n) => (n || "").trim().split(/\s+/)[0] || "";
const shortId = (id) => "#" + String(id || "").slice(-6).toUpperCase();
// Meal name without the day's dish list: "Homely Gold (Large) — 4 Ghee…" → "Homely Gold (Large)"
const mealTitle = (name) => String(name || "").split(" — ")[0];
const mealDetail = (name) => String(name || "").split(" — ").slice(1).join(" — ");
const errText = (e) => {
  const m = (e && e.message) ? e.message : String(e || "");
  return m.replace(/^(INVALID_PROFILE|INVALID_ORDER|NOT_FOUND):\s*/, "") || "Something went wrong. Please try again.";
};
async function callRpc(supabase, fn, args) {
  const { data, error } = await supabase.rpc(fn, args || {});
  if (error) throw new Error(error.message || "Request failed");
  return data;
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    try {
      const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); const ok = document.execCommand("copy"); document.body.removeChild(ta); return ok;
    } catch { return false; }
  }
}

// "+91 98765 43210", "098765 43210", "9876543210" → "9876543210" (or null).
export function normalisePhone(input) {
  let d = String(input || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

// Owner/staff sessions share the same Supabase Auth client — only a phone
// login without the staff role is a customer.
export function isCustomerSession(session) {
  const u = session?.user;
  return !!(u && u.phone && u.app_metadata?.role !== "staff");
}

// Rewards the customer can use on this cart (shared with checkout).
export function cartVariant(itemId) {
  const id = String(itemId || "");
  if (id.startsWith("gold:large:")) return "goldLarge";
  if (id.startsWith("gold:")) return "goldMedium";
  if (id.startsWith("goldmini:")) return "goldMini";
  if (id.startsWith("plan-standard")) return "standard";
  if (id.startsWith("mini:")) return "mini";
  return null;
}

// ── session + profile hook ──
export function useCustomerAccount(supabase) {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState(null);
  const [rewards, setRewards] = useState(null);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => { if (alive) { setSession(data?.session || null); setReady(true); } });
    const { data: listener } = supabase.auth.onAuthStateChange((_e, s) => setSession(s || null));
    return () => { alive = false; listener?.subscription?.unsubscribe(); };
  }, [supabase]);

  const customer = isCustomerSession(session);
  const userId = customer ? session.user.id : null;

  const refresh = useCallback(async () => {
    if (!userId) { setProfile(null); setRewards(null); return; }
    try { setProfile(await callRpc(supabase, "my_profile")); } catch { /* shown as signed-in without details */ }
    try { setRewards(await callRpc(supabase, "my_rewards")); } catch { setRewards(null); }
  }, [supabase, userId]);

  useEffect(() => { refresh(); }, [refresh]);

  const signOut = useCallback(async () => {
    try { await supabase.auth.signOut(); } catch { /* already signed out */ }
    setProfile(null); setRewards(null);
  }, [supabase]);

  const phone = profile?.phone || (customer ? String(session.user.phone).slice(-10) : null);
  return { ready, signedIn: customer, phone, profile, setProfile, rewards, refresh, signOut };
}

// ── tiny UI kit ──
function Card({ children, style, onClick }) {
  return (
    <div onClick={onClick} style={{
      background: HC.card, border: `1.5px solid ${HC.dash}`, borderRadius: 16, padding: 16, marginBottom: 12,
      cursor: onClick ? "pointer" : "default", ...style,
    }}>{children}</div>
  );
}
function SectionTitle({ children, sub }) {
  return (
    <div style={{ margin: "4px 0 12px" }}>
      <h2 style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 800, color: HC.brown, margin: 0 }}>{children}</h2>
      {sub && <div style={{ fontSize: 12.5, color: HC.brownMid, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
function Busy({ text = "Loading…" }) { return <div style={{ padding: 28, textAlign: "center", color: HC.brownMid, fontSize: 13 }}>{text}</div>; }
function ErrorNote({ error, onRetry }) {
  return (
    <div style={{ background: HC.redBg, color: HC.red, borderRadius: 10, padding: "10px 12px", fontSize: 13, marginBottom: 12 }}>
      {error} {onRetry && <button onClick={onRetry} style={{ marginLeft: 6, border: "none", background: "none", color: HC.red, fontWeight: 800, textDecoration: "underline", cursor: "pointer" }}>Retry</button>}
    </div>
  );
}
function Field({ label, children, hint }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ fontSize: 12, fontWeight: 700, color: HC.brownMid, display: "block", marginBottom: 4 }}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 11, color: HC.brownSoft, marginTop: 3 }}>{hint}</div>}
    </div>
  );
}
function PrimaryBtn({ children, onClick, disabled, style }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      width: "100%", border: "none", borderRadius: 12, padding: "13px 16px", background: HC.orange, color: "#fff",
      fontFamily: "inherit", fontWeight: 800, fontSize: 15, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1, ...style,
    }}>{children}</button>
  );
}
function SmallBtn({ children, onClick, disabled, tone = "orange", style }) {
  const solid = tone === "orange";
  return (
    <button onClick={onClick} disabled={disabled} style={{
      border: solid ? "none" : `1.5px solid ${HC.dash}`, borderRadius: 10, padding: "8px 14px",
      background: solid ? HC.orange : "#fff", color: solid ? "#fff" : HC.brown, fontFamily: "inherit",
      fontWeight: 800, fontSize: 13, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1, whiteSpace: "nowrap", ...style,
    }}>{children}</button>
  );
}
function LinkBtn({ children, onClick, style }) {
  return <button onClick={onClick} style={{ border: "none", background: "none", padding: 0, color: HC.orangeDeep, fontWeight: 800, fontSize: 13, cursor: "pointer", fontFamily: "inherit", ...style }}>{children}</button>;
}
function Pill({ children, tone = "neutral" }) {
  const t = { neutral: [HC.peach, HC.brown], green: [HC.greenBg, HC.green], red: [HC.redBg, HC.red], orange: ["#FFF1E3", HC.orangeDeep] }[tone] || [HC.peach, HC.brown];
  return <span style={{ background: t[0], color: t[1], borderRadius: 999, padding: "2px 9px", fontSize: 11, fontWeight: 800, whiteSpace: "nowrap" }}>{children}</span>;
}
function Shell({ title, onBack, backLabel = "← Back", children }) {
  return (
    <div style={{ minHeight: "100vh", background: HC.cream, fontFamily: "'Nunito', system-ui, sans-serif", color: HC.brown }}>
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "16px 16px 40px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <button onClick={onBack} style={{ border: `1.5px solid ${HC.dash}`, background: "#fff", borderRadius: 10, padding: "7px 12px", fontFamily: "inherit", fontWeight: 800, fontSize: 13, color: HC.brown, cursor: "pointer" }}>{backLabel}</button>
          {title && <div style={{ fontFamily: SERIF, fontWeight: 800, fontSize: 18, color: HC.brown }}>{title}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

const inputStyle = {
  width: "100%", boxSizing: "border-box", border: `1.5px solid #EAD8C0`, borderRadius: 10, padding: "11px 12px",
  fontFamily: "inherit", fontSize: 15, color: HC.brown, background: "#fff", outline: "none",
};

// ─────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────
export function MyHomelyLogin({ supabase, onSignedIn, onClose }) {
  const [step, setStep] = useState("phone"); // phone | otp | password
  const [phoneInput, setPhoneInput] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [otp, setOtp] = useState("");
  const [newPass, setNewPass] = useState("");
  const [newPass2, setNewPass2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn(s => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const phone = normalisePhone(phoneInput);
  const e164 = phone ? "+91" + phone : "";

  const loginWithPassword = async () => {
    setError(""); setInfo("");
    if (!phone) { setError("Enter your 10-digit mobile number."); return; }
    if (!password) { setError("Enter your password, or tap \"Get OTP\" below."); return; }
    setBusy(true);
    const { error: err } = await supabase.auth.signInWithPassword({ phone: e164, password });
    setBusy(false);
    if (err) {
      setError(/invalid login/i.test(err.message)
        ? "That password doesn't match. New here or forgot it? Use \"Get OTP\" below."
        : err.message);
      return;
    }
    onSignedIn();
  };

  const sendOtp = async () => {
    setError(""); setInfo("");
    if (!phone) { setError("Enter your 10-digit mobile number."); return; }
    setBusy(true);
    const { error: err } = await supabase.auth.signInWithOtp({ phone: e164 });
    setBusy(false);
    if (err) { setError(/rate|seconds/i.test(err.message) ? "Please wait a moment before requesting another OTP." : err.message); return; }
    setOtp(""); setStep("otp"); setResendIn(30);
    setInfo(`We've sent a 6-digit code to +91 ${phone}.`);
  };

  const verifyOtp = async () => {
    setError("");
    if (!/^\d{6}$/.test(otp.trim())) { setError("Enter the 6-digit code from the SMS."); return; }
    setBusy(true);
    const { error: err } = await supabase.auth.verifyOtp({ phone: e164, token: otp.trim(), type: "sms" });
    setBusy(false);
    if (err) { setError(/expired|invalid/i.test(err.message) ? "That code is wrong or has expired. Try again or resend." : err.message); return; }
    setInfo(""); setStep("password");
  };

  const savePassword = async () => {
    setError("");
    if (newPass.length < 6) { setError("Use at least 6 characters."); return; }
    if (newPass !== newPass2) { setError("The two passwords don't match."); return; }
    setBusy(true);
    const { error: err } = await supabase.auth.updateUser({ password: newPass });
    setBusy(false);
    if (err) { setError(err.message); return; }
    onSignedIn();
  };

  return (
    <Shell onBack={onClose} backLabel="← Menu">
      <div style={{ textAlign: "center", margin: "8px 0 18px" }}>
        <img src="/logo.png" alt="" style={{ width: 64, height: 64, borderRadius: "50%", border: `2px solid ${HC.brown}`, objectFit: "cover" }} />
        <h1 style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 800, margin: "10px 0 2px" }}>My Homely</h1>
        <div style={{ fontSize: 13, color: HC.brownMid }}>Your orders, favourites and rewards in one place</div>
      </div>

      <Card style={{ padding: 20 }}>
        {error && <ErrorNote error={error} />}
        {info && <div style={{ background: HC.greenBg, color: HC.green, borderRadius: 10, padding: "10px 12px", fontSize: 13, marginBottom: 12 }}>{info}</div>}

        {step === "phone" && (
          <>
            <Field label="Mobile number">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ ...inputStyle, width: "auto", background: HC.peach, fontWeight: 800 }}>+91</span>
                <input style={inputStyle} type="tel" inputMode="numeric" autoComplete="tel-national" placeholder="10-digit mobile number"
                  value={phoneInput} onChange={e => { setPhoneInput(e.target.value); setError(""); }} />
              </div>
            </Field>
            <Field label="Password">
              <div style={{ position: "relative" }}>
                <input style={{ ...inputStyle, paddingRight: 60 }} type={showPass ? "text" : "password"} autoComplete="current-password"
                  placeholder="Your password" value={password}
                  onChange={e => { setPassword(e.target.value); setError(""); }}
                  onKeyDown={e => { if (e.key === "Enter" && !busy) loginWithPassword(); }} />
                <button onClick={() => setShowPass(s => !s)} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", border: "none", background: "none", color: HC.brownMid, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>{showPass ? "Hide" : "Show"}</button>
              </div>
            </Field>
            <PrimaryBtn onClick={loginWithPassword} disabled={busy}>{busy ? "Please wait…" : "Log in"}</PrimaryBtn>
            <div style={{ textAlign: "center", marginTop: 16, paddingTop: 14, borderTop: `1px dashed ${HC.dash}` }}>
              <div style={{ fontSize: 13, color: HC.brownMid, marginBottom: 8 }}>New to My Homely, or forgot your password?</div>
              <SmallBtn tone="plain" onClick={sendOtp} disabled={busy}>Get OTP on SMS</SmallBtn>
            </div>
          </>
        )}

        {step === "otp" && (
          <>
            <Field label="6-digit code">
              <input style={{ ...inputStyle, letterSpacing: 6, fontSize: 20, textAlign: "center", fontWeight: 800 }} type="tel" inputMode="numeric"
                autoComplete="one-time-code" maxLength={6} placeholder="••••••" value={otp}
                onChange={e => { setOtp(e.target.value.replace(/\D/g, "").slice(0, 6)); setError(""); }}
                onKeyDown={e => { if (e.key === "Enter" && !busy) verifyOtp(); }} />
            </Field>
            <PrimaryBtn onClick={verifyOtp} disabled={busy}>{busy ? "Checking…" : "Verify"}</PrimaryBtn>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 14, fontSize: 13 }}>
              <LinkBtn onClick={() => { setStep("phone"); setError(""); setInfo(""); }}>← Change number</LinkBtn>
              {resendIn > 0
                ? <span style={{ color: HC.brownSoft }}>Resend in {resendIn}s</span>
                : <LinkBtn onClick={sendOtp}>Resend code</LinkBtn>}
            </div>
          </>
        )}

        {step === "password" && (
          <>
            <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 4 }}>Phone verified ✓</div>
            <div style={{ fontSize: 13, color: HC.brownMid, marginBottom: 14 }}>Set a password so next time you can log in instantly with just your number.</div>
            <Field label="New password" hint="At least 6 characters">
              <input style={inputStyle} type="password" autoComplete="new-password" value={newPass} onChange={e => { setNewPass(e.target.value); setError(""); }} />
            </Field>
            <Field label="Confirm password">
              <input style={inputStyle} type="password" autoComplete="new-password" value={newPass2}
                onChange={e => { setNewPass2(e.target.value); setError(""); }}
                onKeyDown={e => { if (e.key === "Enter" && !busy) savePassword(); }} />
            </Field>
            <PrimaryBtn onClick={savePassword} disabled={busy}>{busy ? "Saving…" : "Save password & continue"}</PrimaryBtn>
            <div style={{ textAlign: "center", marginTop: 12 }}>
              <LinkBtn onClick={onSignedIn} style={{ color: HC.brownMid, fontWeight: 700 }}>Skip for now</LinkBtn>
            </div>
          </>
        )}
      </Card>
      <div style={{ fontSize: 11.5, color: HC.brownSoft, textAlign: "center", lineHeight: 1.5 }}>
        Use the same number you order with — your past orders show up automatically.
      </div>
    </Shell>
  );
}

// ─────────────────────────────────────────────
// MY HOMELY (signed in)
// ─────────────────────────────────────────────
export function MyHomely({ supabase, account, towers = [], canOrder, kitchenState = "open", onClose, onOrderAgain, onOpenPrefs, notif }) {
  const [view, setView] = useState("home");
  const [fav, setFav] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [loadErr, setLoadErr] = useState("");

  const load = useCallback(async () => {
    setLoadErr("");
    try {
      const [f, l] = await Promise.all([callRpc(supabase, "my_favourites"), callRpc(supabase, "my_ledger")]);
      setFav(f); setLedger(l);
    } catch (e) { setLoadErr(errText(e)); }
    account.refresh();
  }, [supabase]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  // Every section opens at the top, not wherever the previous screen was scrolled.
  useEffect(() => { try { window.scrollTo(0, 0); } catch { /* not in a browser */ } }, [view]);

  const p = account.profile || {};
  const back = () => setView("home");

  if (view === "profile") return <ProfileView supabase={supabase} account={account} towers={towers} notif={notif} onBack={back} />;
  if (view === "orders") return <OrdersView supabase={supabase} canOrder={canOrder} onOrderAgain={onOrderAgain} onBack={back} onRegularChanged={load} regularId={p.regularOrderId} />;
  if (view === "favourites") return <FavouritesView fav={fav} canOrder={canOrder} onOrderAgain={onOrderAgain} onBack={back} />;
  if (view === "rewards") return <RewardsView rewards={account.rewards} onBack={back} />;
  if (view === "ledger") return <LedgerView ledger={ledger} onBack={back} />;

  const regular = fav?.regular;
  const loy = account.rewards?.loyalty;
  const vouchers = (loy?.vouchers || []).filter(v => v.status === "available");
  const due = Number(ledger?.balance || 0);
  const hasAddress = !!(p.tower && p.flat);
  const ks = KITCHEN_STATE[kitchenState] || KITCHEN_STATE.closed;
  const totalOrders = Number(p.totalOrders || 0);

  return (
    <div className="mh-dash" style={{ minHeight: "100vh", background: HC.cream, fontFamily: "'Nunito', system-ui, sans-serif", color: HC.brown, overflowX: "hidden" }}>
      <style>{DASH_CSS}</style>
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "10px 16px 40px" }}>

        {/* 1 · Header */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <button className="mh-tap mh-back" onClick={onClose} style={{ justifySelf: "start", display: "flex", alignItems: "center", gap: 8, minHeight: 44, padding: "0 6px 0 0", border: "none", background: "none", fontFamily: "inherit", fontSize: 15, fontWeight: 700, color: HC.brown, cursor: "pointer" }}>
            <Icon name="arrowLeft" size={22} /> Menu
          </button>
          <div style={{ fontFamily: SERIF, fontWeight: 800, fontSize: 22, color: HC.brown, whiteSpace: "nowrap" }}>My Homely</div>
          <div aria-label={p.name ? `Signed in as ${p.name}` : "Signed in"} role="img" style={{ justifySelf: "end", width: 44, height: 44, borderRadius: "50%", background: HC.peach, color: HC.brown, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 15, letterSpacing: 0.5 }}>
            {initials(p.name) || <Icon name="user" size={20} />}
          </div>
        </div>

        {/* 2 · Greeting */}
        <h1 style={{ fontFamily: SERIF, fontSize: 34, lineHeight: 1.15, fontWeight: 800, color: HC.brown, margin: "0 0 6px", overflowWrap: "anywhere" }}>
          Hi{firstName(p.name) ? `, ${firstName(p.name)}` : ""}
        </h1>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <Icon name="pin" size={20} color={HC.brownMid} />
          <span style={{ flex: 1, minWidth: 0, fontSize: 15.5, color: hasAddress ? HC.brownMid : HC.orangeDeep, fontWeight: hasAddress ? 600 : 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {!account.profile ? "…" : hasAddress ? `${p.tower} · Flat ${p.flat}` : "Add your tower and flat"}
          </span>
          <button className="mh-tap" onClick={() => setView("profile")} style={{ minHeight: 44, minWidth: 44, padding: "0 4px", border: "none", background: "none", fontFamily: "inherit", fontSize: 15, fontWeight: 800, color: HC.orangeDeep, cursor: "pointer" }}>
            {hasAddress ? "Edit" : "Add"}
          </button>
        </div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "6px 14px", borderRadius: 999, border: `1.5px solid ${ks.color}`, color: ks.color, background: ks.bg, fontSize: 14, fontWeight: 700, marginBottom: 16 }}>
          <Icon name="store" size={18} /> {ks.badge}
        </div>

        {loadErr && <ErrorNote error={loadErr} onRetry={load} />}

        {/* 3 · Your regular */}
        <section className="mh-card" style={{ position: "relative", overflow: "hidden", background: "#FFFCF6", padding: "18px 16px 16px", marginBottom: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12, alignItems: "start" }}>
            <div style={{ paddingTop: 4, minWidth: 0 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: HC.brownMid, letterSpacing: 2.2, textTransform: "uppercase" }}>
                {fav?.regularIsPinned ? "My regular" : "Your regular"}
              </div>
              {!fav ? (
                <div style={{ fontSize: 14, color: HC.brownMid, marginTop: 10 }}>{loadErr ? "Couldn't load your regular." : "Loading…"}</div>
              ) : regular ? (
                <>
                  <div style={{ fontFamily: SERIF, fontSize: "clamp(20px, 5.8vw, 27px)", lineHeight: 1.15, fontWeight: 800, color: HC.brown, margin: "8px 0 6px", overflowWrap: "anywhere" }}>
                    {regular.items.map(i => `${mealTitle(i.name)}${i.qty > 1 ? ` ×${i.qty}` : ""}`).join(" + ")}
                  </div>
                  <div style={{ fontSize: 15, color: HC.brownMid }}>
                    {fav.regularIsPinned ? "Pinned by you" : fav.regularCount > 1 ? `Ordered ${fav.regularCount} times` : `Last ordered ${fmtD(regular.date)}`}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontFamily: SERIF, fontSize: 22, lineHeight: 1.2, fontWeight: 800, color: HC.brown, margin: "8px 0 6px" }}>Your usual, one tap away</div>
                  <div style={{ fontSize: 14, color: HC.brownMid, lineHeight: 1.45 }}>Once you've ordered with us, your regular meal shows up here.</div>
                </>
              )}
            </div>
            {/* Anita Aunty — the app logo as a round badge, same ring as the home page logo */}
            <img src="/logo.png" alt="" aria-hidden="true" style={{ display: "block", width: "clamp(84px, 27vw, 112px)", height: "auto", aspectRatio: "1 / 1", borderRadius: "50%", border: "2px solid #4A2C1F", objectFit: "cover" }} />
          </div>
          {fav && (regular ? (
            canOrder
              ? <button className="mh-tap" onClick={() => onOrderAgain(regular)} style={{ ...ctaStyle, background: HC.orange, color: "#fff" }}>Order again</button>
              : <button disabled style={{ ...ctaStyle, background: "#E8E2D8", color: "#6F6253", cursor: "not-allowed" }}>{ks.wait}</button>
          ) : (
            canOrder
              ? <button className="mh-tap" onClick={onClose} style={{ ...ctaStyle, background: HC.orange, color: "#fff" }}>See today's menu</button>
              : <button disabled style={{ ...ctaStyle, background: "#E8E2D8", color: "#6F6253", cursor: "not-allowed" }}>{ks.wait}</button>
          ))}
        </section>

        {/* 4 · Shortcuts */}
        <div className="mh-shortcuts" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 12, marginBottom: 14 }}>
          <DashTile icon="receipt" title="My Orders" sub={!account.profile ? "…" : totalOrders ? `${totalOrders} order${totalOrders === 1 ? "" : "s"}` : "No orders yet"} onClick={() => setView("orders")} />
          <DashTile icon="heart" title="Favourites" sub="Your saved meals" onClick={() => setView("favourites")} />
        </div>

        {/* 5 · Rewards */}
        <DashRow icon="gift" onClick={() => setView("rewards")} style={{ background: "#FCEFD6", borderColor: "#F2DCB4" }} divider="#EBCF9F"
          title="Homely Rewards"
          value={!account.rewards ? "…" : loy?.enabled ? `${loy.balance} point${loy.balance === 1 ? "" : "s"}` : "Refer & earn"}
          note={loy?.enabled && loy.balance > 0 ? `≈ ${fmtINR(Math.floor(loy.balance * loy.pointValue + 1e-9))}` : null}
          sub={vouchers.length ? `${vouchers.length} free meal${vouchers.length > 1 ? "s" : ""} ready · View rewards` : loy?.enabled ? "View points & rewards" : "View your referral code"} />

        {/* 6 · Credit */}
        <DashRow icon="wallet" onClick={() => setView("ledger")}
          title={!ledger ? "Credit" : due > 0 ? "Amount due" : due < 0 ? "Advance with Homely" : "All settled"}
          value={ledger ? fmtINR(Math.abs(due)) : loadErr ? "—" : "…"}
          valueColor={due > 0 ? HC.orangeDeep : HC.green}
          sub="View credit ledger" />

        {/* 7 · Account */}
        <h2 style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 800, color: HC.brown, margin: "22px 2px 12px" }}>Your account</h2>
        <div className="mh-card" style={{ padding: 0, overflow: "hidden" }}>
          <AccountRow first icon="user" title="Profile & address" sub="Delivery details and instructions" onClick={() => setView("profile")} />
          {onOpenPrefs && <AccountRow icon="utensils" title="Food preferences" sub="Spice, oil, likes & dislikes" onClick={onOpenPrefs} />}
          <AccountRow icon="logout" title="Log out" onClick={async () => { await account.signOut(); onClose(); }} />
        </div>
      </div>
    </div>
  );
}

// ── Dashboard pieces ──
// What the kitchen-status badge and the disabled "Order again" button say.
const KITCHEN_STATE = {
  open: { badge: "Kitchen open", color: HC.green, bg: "#F1F8F1", wait: "" },
  nomenu: { badge: "Menu coming soon", color: HC.orangeDeep, bg: "#FFF7EE", wait: "Ordering opens when today's menu is up" },
  paused: { badge: "Kitchen on a short break", color: HC.orangeDeep, bg: "#FFF7EE", wait: "Ordering resumes after the short break" },
  closed: { badge: "Kitchen closed", color: HC.orangeDeep, bg: "#FFF7EE", wait: "Ordering resumes when kitchen opens" },
};
const ctaStyle = {
  display: "block", width: "100%", minHeight: 52, marginTop: 14, border: "none", borderRadius: 12, padding: "12px 16px",
  fontFamily: "inherit", fontWeight: 700, fontSize: 16, cursor: "pointer",
};
const DASH_CSS = `
  .mh-dash .mh-card { background: #FFFDF8; border: 1px solid #EEDFC8; border-radius: 18px; box-shadow: 0 1px 2px rgba(59,42,26,.04), 0 6px 18px rgba(59,42,26,.05); }
  .mh-dash .mh-tap { -webkit-tap-highlight-color: transparent; transition: background-color .15s, transform .1s; }
  .mh-dash .mh-tap:active { transform: scale(0.985); }
  .mh-dash .mh-tap:focus-visible { outline: 3px solid ${HC.orange}; outline-offset: 2px; }
  .mh-dash button.mh-card.mh-tap:hover, .mh-dash .mh-row:hover { filter: brightness(0.985); }
  @media (max-width: 359px) { .mh-dash .mh-shortcuts { grid-template-columns: 1fr !important; } }
`;
const initials = (n) => (n || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase();

// Outline icons (Lucide shapes), drawn inline so no icon library is needed.
const ICONS = {
  arrowLeft: <><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></>,
  pin: <><path d="M20 10c0 4.99-5.54 10.19-7.4 11.8a1 1 0 0 1-1.2 0C9.54 20.19 4 14.99 4 10a8 8 0 0 1 16 0" /><circle cx="12" cy="10" r="3" /></>,
  store: <><path d="M3 9.5 5 4h14l2 5.5" /><path d="M3 9.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" /><path d="M5 12.3V20h14v-7.7" /><path d="M10 20v-5h4v5" /></>,
  receipt: <><path d="M6 2h12a1 1 0 0 1 1 1v18l-2.33-1.5L14.33 21 12 19.5 9.67 21l-2.34-1.5L5 21V3a1 1 0 0 1 1-1z" /><path d="M9 7h6M9 11h6M9 15h4" /></>,
  heart: <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />,
  gift: <><rect x="3" y="8" width="18" height="4" rx="1" /><path d="M12 8v13" /><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" /><path d="M7.5 8a2.5 2.5 0 0 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 0 1 0 5" /></>,
  wallet: <><path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" /><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" /></>,
  user: <><circle cx="12" cy="8" r="5" /><path d="M20 21a8 8 0 0 0-16 0" /></>,
  utensils: <><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" /><path d="M7 2v20" /><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" /></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>,
  chevron: <path d="m9 18 6-6-6-6" />,
};
function Icon({ name, size = 24, color = "currentColor", stroke = 1.75 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, display: "block" }}>
      {ICONS[name]}
    </svg>
  );
}
const tapReset = { width: "100%", textAlign: "left", fontFamily: "inherit", color: HC.brown, cursor: "pointer" };

function DashTile({ icon, title, sub, onClick }) {
  return (
    <button className="mh-card mh-tap" onClick={onClick} style={{ ...tapReset, display: "flex", alignItems: "center", gap: 8, minHeight: 76, padding: "14px 10px 14px 12px" }}>
      <Icon name={icon} size={26} color={HC.orangeDeep} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontFamily: SERIF, fontWeight: 800, fontSize: 17, color: HC.brown, lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</span>
        <span style={{ display: "block", fontSize: 13, color: HC.brownMid, marginTop: 2, lineHeight: 1.3 }}>{sub}</span>
      </span>
      <Icon name="chevron" size={20} color={HC.orangeDeep} stroke={2} />
    </button>
  );
}

function DashRow({ icon, title, value, valueColor = HC.orangeDeep, note, sub, onClick, style, divider = "#EEDFC8" }) {
  return (
    <button className="mh-card mh-tap" onClick={onClick} style={{ ...tapReset, display: "flex", alignItems: "center", gap: 14, padding: "16px 14px 16px 16px", marginBottom: 14, ...style }}>
      <span style={{ display: "flex", alignItems: "center", alignSelf: "stretch", paddingRight: 14, borderRight: `1px solid ${divider}` }}>
        <Icon name={icon} size={32} color={icon === "gift" ? HC.orange : HC.brown} stroke={1.6} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontFamily: SERIF, fontWeight: 800, fontSize: 19, color: HC.brown, lineHeight: 1.2 }}>{title}</span>
        <span style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", columnGap: 8, margin: "2px 0" }}>
          <span style={{ fontWeight: 800, fontSize: 27, lineHeight: 1.2, color: valueColor }}>{value}</span>
          {note && <span style={{ fontSize: 13, color: HC.brownMid, fontWeight: 600 }}>{note}</span>}
        </span>
        <span style={{ display: "block", fontSize: 14, color: HC.brownMid }}>{sub}</span>
      </span>
      <Icon name="chevron" size={22} color={HC.orangeDeep} stroke={2} />
    </button>
  );
}

function AccountRow({ first, icon, title, sub, onClick }) {
  return (
    <button className="mh-tap mh-row" onClick={onClick} style={{ ...tapReset, display: "flex", alignItems: "center", gap: 16, minHeight: 64, padding: "12px 16px 12px 18px", border: "none", borderTop: first ? "none" : "1px solid #F1E5D3", background: "transparent" }}>
      <Icon name={icon} size={26} color={HC.brown} stroke={1.6} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontFamily: SERIF, fontWeight: 800, fontSize: 18, color: HC.brown, lineHeight: 1.25 }}>{title}</span>
        {sub && <span style={{ display: "block", fontSize: 14, color: HC.brownMid, marginTop: 2 }}>{sub}</span>}
      </span>
      <Icon name="chevron" size={20} color={HC.orangeDeep} stroke={2} />
    </button>
  );
}

// ── Profile ──
function ProfileView({ supabase, account, towers, notif, onBack }) {
  const p = account.profile || {};
  const [form, setForm] = useState({ name: p.name || "", tower: p.tower || "", flat: p.flat || "", instr: p.deliveryInstructions || "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const set = (k) => (e) => { setForm(f => ({ ...f, [k]: e.target.value })); setSaved(false); setError(""); };

  const save = async () => {
    if (!form.name.trim()) { setError("Please enter your name."); return; }
    if (!form.tower) { setError("Please choose your tower."); return; }
    if (!form.flat.trim()) { setError("Please enter your flat number."); return; }
    setBusy(true); setError("");
    try {
      const next = await callRpc(supabase, "update_my_profile", {
        p_name: form.name.trim(), p_tower: form.tower, p_flat: form.flat.trim(), p_delivery_instructions: form.instr.trim(),
      });
      account.setProfile(next);
      setSaved(true);
    } catch (e) { setError(errText(e)); }
    setBusy(false);
  };

  const towerOptions = towers.includes(form.tower) || !form.tower ? towers : [form.tower, ...towers];

  return (
    <Shell title="Profile" onBack={onBack}>
      <Card style={{ padding: 20 }}>
        {error && <ErrorNote error={error} />}
        <Field label="Name">
          <input style={inputStyle} value={form.name} onChange={set("name")} placeholder="Your name" maxLength={80} />
        </Field>
        <Field label="Phone number" hint="Verified with OTP — this is your login, so it can't be changed here.">
          <input style={{ ...inputStyle, background: HC.peach, color: HC.brownMid }} value={`+91 ${account.phone || ""}  ✓`} readOnly />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Tower">
            <select style={inputStyle} value={form.tower} onChange={set("tower")}>
              <option value="">Select</option>
              {towerOptions.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Flat no.">
            <input style={inputStyle} value={form.flat} onChange={set("flat")} placeholder="e.g. 402" maxLength={20} />
          </Field>
        </div>
        {p.society && <div style={{ fontSize: 12, color: HC.brownMid, margin: "-4px 0 12px" }}>Society: {p.society}</div>}
        <Field label="Delivery instructions" hint="Shown to our delivery staff with every order.">
          <textarea style={{ ...inputStyle, resize: "vertical", minHeight: 70 }} value={form.instr} onChange={set("instr")}
            placeholder="e.g. Leave with the guard, don't ring the bell" maxLength={300} />
        </Field>
        <PrimaryBtn onClick={save} disabled={busy}>{busy ? "Saving…" : saved ? "Saved ✓" : "Save"}</PrimaryBtn>
        <div style={{ fontSize: 11, color: HC.brownSoft, marginTop: 8, textAlign: "center" }}>Past orders keep the address they were delivered to.</div>
      </Card>

      {notif && (
        <Card>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 800, fontSize: 14 }}>Order updates on this phone</div>
              <div style={{ fontSize: 12, color: HC.brownMid }}>
                {notif.status === "granted" ? "On — we'll notify you as your order moves along."
                  : notif.status === "denied" ? "Blocked in your browser settings."
                  : notif.status === "unsupported" ? "Not supported in this browser."
                  : "Get a notification when your order is prepared, sent and delivered."}
              </div>
              {notif.error && <div style={{ fontSize: 11, color: HC.red, marginTop: 4 }}>{notif.error}</div>}
            </div>
            {notif.status === "granted"
              ? <SmallBtn tone="plain" onClick={notif.onDisable} disabled={notif.busy}>Turn off</SmallBtn>
              : notif.status !== "unsupported" && notif.status !== "denied" && <SmallBtn onClick={notif.onEnable} disabled={notif.busy}>{notif.busy ? "…" : "Turn on"}</SmallBtn>}
          </div>
        </Card>
      )}
    </Shell>
  );
}

// ── Orders ──
function OrderSummary({ o }) {
  return (
    <>
      {o.items.map((i, idx) => (
        <div key={idx} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "5px 0", fontSize: 13 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700 }}>{mealTitle(i.name)} <span style={{ color: HC.brownMid }}>×{i.qty}</span></div>
            {mealDetail(i.name) && <div style={{ fontSize: 11.5, color: HC.brownMid, lineHeight: 1.35 }}>{mealDetail(i.name)}</div>}
          </div>
          <div style={{ fontWeight: 700, whiteSpace: "nowrap" }}>{i.price != null ? fmtINR(i.price * i.qty) : ""}</div>
        </div>
      ))}
      {o.discount > 0 && (
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: HC.green, fontWeight: 700, paddingTop: 4 }}>
          <span>{o.promoLabel || "Discount"}</span><span>−{fmtINR(o.discount)}</span>
        </div>
      )}
    </>
  );
}

function OrdersView({ supabase, canOrder, onOrderAgain, onBack, onRegularChanged, regularId }) {
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState("");
  const [more, setMore] = useState(false);
  const [busyMore, setBusyMore] = useState(false);
  const [pinned, setPinned] = useState(regularId || null);
  const PAGE = 20;

  const loadPage = useCallback(async (offset) => {
    const rows = await callRpc(supabase, "my_orders", { p_limit: PAGE, p_offset: offset });
    setMore((rows || []).length === PAGE);
    return rows || [];
  }, [supabase]);

  useEffect(() => { loadPage(0).then(setOrders).catch(e => setError(errText(e))); }, [loadPage]);

  const loadMore = async () => {
    setBusyMore(true);
    try { const rows = await loadPage(orders.length); setOrders(o => [...o, ...rows]); } catch (e) { setError(errText(e)); }
    setBusyMore(false);
  };
  const pin = async (id) => {
    try { await callRpc(supabase, "set_my_regular", { p_order_id: id }); setPinned(id); onRegularChanged && onRegularChanged(); }
    catch (e) { setError(errText(e)); }
  };

  return (
    <Shell title="My Orders" onBack={onBack}>
      {error && <ErrorNote error={error} />}
      {!orders ? <Busy /> : orders.length === 0 ? (
        <Card><div style={{ fontSize: 14, color: HC.brownMid }}>No orders yet — your orders will show up here.</div></Card>
      ) : orders.map(o => (
        <Card key={o.id} style={{ background: "#fff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
            <div>
              <div style={{ fontWeight: 800, fontSize: 14 }}>{fmtD(o.date || o.createdAt)}</div>
              <div style={{ fontSize: 11.5, color: HC.brownSoft }}>Order {shortId(o.id)}</div>
            </div>
            <Pill tone={o.status === "delivered" ? "green" : o.status === "rejected" ? "red" : "orange"}>{STATUS_LABEL[o.status] || o.status}</Pill>
          </div>
          <OrderSummary o={o} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: `1px dashed ${HC.dash}`, marginTop: 8, paddingTop: 10, gap: 8 }}>
            <div style={{ fontWeight: 800, fontSize: 16, color: HC.orangeDeep }}>{fmtINR(o.total)}</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {o.status === "delivered" && (pinned === o.id
                ? <span style={{ fontSize: 11.5, color: HC.green, fontWeight: 800 }}>★ My Regular</span>
                : <LinkBtn onClick={() => pin(o.id)} style={{ fontSize: 12 }}>☆ Set as regular</LinkBtn>)}
              <SmallBtn onClick={() => onOrderAgain(o)} disabled={!canOrder}>Order Again</SmallBtn>
            </div>
          </div>
        </Card>
      ))}
      {orders && more && <SmallBtn tone="plain" onClick={loadMore} disabled={busyMore} style={{ width: "100%" }}>{busyMore ? "Loading…" : "Show older orders"}</SmallBtn>}
      {!canOrder && orders && orders.length > 0 && <div style={{ fontSize: 12, color: HC.brownMid, textAlign: "center", marginTop: 10 }}>Order Again works while the kitchen is open and today's menu is up.</div>}
    </Shell>
  );
}

// ── Favourites ──
function FavouritesView({ fav, canOrder, onOrderAgain, onBack }) {
  if (!fav) return <Shell title="My Favourites" onBack={onBack}><Busy /></Shell>;
  const empty = !fav.deliveredOrders;
  const maxMeal = Math.max(1, ...(fav.meals || []).map(m => m.count));
  return (
    <Shell title="My Favourites" onBack={onBack}>
      <div style={{ fontSize: 12.5, color: HC.brownMid, marginBottom: 12 }}>
        Worked out from your delivered orders — updates automatically as you order.
      </div>
      {empty ? (
        <Card><div style={{ fontSize: 14, color: HC.brownMid }}>Your favourites appear here after your first delivered order.</div></Card>
      ) : (
        <>
          {fav.usualMeal && (
            <Card style={{ background: "#fff" }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: HC.orangeDeep, letterSpacing: 1, textTransform: "uppercase" }}>Most ordered meal</div>
              <div style={{ fontFamily: SERIF, fontSize: 21, fontWeight: 800, margin: "4px 0" }}>{fav.usualMeal.label}</div>
              <div style={{ fontSize: 12, color: HC.brownMid }}>{fav.usualMeal.count} of {fav.deliveredOrders} orders</div>
              {(fav.meals || []).length > 1 && (
                <div style={{ marginTop: 12 }}>
                  {fav.meals.map(m => (
                    <div key={m.variant} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, margin: "5px 0" }}>
                      <span style={{ width: 130, flexShrink: 0, color: HC.brownMid }}>{m.label}</span>
                      <span style={{ flex: 1, background: HC.peach, borderRadius: 6, height: 8, overflow: "hidden" }}>
                        <span style={{ display: "block", height: "100%", width: `${(m.count / maxMeal) * 100}%`, background: HC.orange, borderRadius: 6 }} />
                      </span>
                      <span style={{ width: 22, textAlign: "right", fontWeight: 800 }}>{m.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          {(fav.topSabjis || []).length > 0 && (
            <Card>
              <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8 }}>Favourite sabjis</div>
              {fav.topSabjis.map((d, i) => (
                <div key={d.name} style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, padding: "5px 0" }}>
                  <span>{["🥇", "🥈", "🥉"][i] || "•"} {d.name}</span><span style={{ color: HC.brownMid }}>{d.count}×</span>
                </div>
              ))}
            </Card>
          )}

          {(fav.topSides || []).length > 0 && (
            <Card>
              <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8 }}>Favourite sides</div>
              {fav.topSides.map(d => (
                <div key={d.category} style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, padding: "5px 0" }}>
                  <span><span style={{ color: HC.brownMid }}>{SIDE_LABEL[d.category] || d.category}:</span> {d.name}</span>
                  <span style={{ color: HC.brownMid }}>{d.count}×</span>
                </div>
              ))}
            </Card>
          )}

          {(fav.preferredSlot || fav.favouriteDay) && (
            <Card>
              <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 6 }}>Your routine</div>
              <div style={{ fontSize: 13.5, color: HC.brownMid, lineHeight: 1.6 }}>
                {fav.preferredSlot && <>Mostly <b style={{ color: HC.brown }}>{fav.preferredSlot === "dinner" ? "dinner" : "lunch"}</b>. </>}
                {fav.favouriteDay && <>Favourite day: <b style={{ color: HC.brown }}>{DAY_LABEL[fav.favouriteDay] || fav.favouriteDay}</b>.</>}
              </div>
            </Card>
          )}

          {fav.regular && (
            <Card style={{ background: "#fff", borderStyle: "dashed" }}>
              <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 4 }}>{fav.regularIsPinned ? "My Regular" : "Your usual combination"}</div>
              <OrderSummary o={{ ...fav.regular, discount: 0 }} />
              <PrimaryBtn onClick={() => onOrderAgain(fav.regular)} disabled={!canOrder} style={{ marginTop: 10 }}>{canOrder ? "Order Again" : "Kitchen closed right now"}</PrimaryBtn>
            </Card>
          )}
        </>
      )}
    </Shell>
  );
}

// ── Rewards ──
function RewardsView({ rewards, onBack }) {
  const [copied, setCopied] = useState(false);
  if (!rewards) return <Shell title="Rewards" onBack={onBack}><Busy /></Shell>;
  const ref = rewards.referral || {};
  const loy = rewards.loyalty || {};
  const code = rewards.referralCode;
  const shareText = ref.enabled === false
    ? `Try Homely Tiffins — ghar jaisa khana! https://homelytiffins.com`
    : `Try Homely Tiffins — ghar jaisa khana! Use my code ${code}${ref.referredDiscount ? ` for ₹${ref.referredDiscount} off` : ""} your first order: https://homelytiffins.com`;

  const copy = async () => { if (await copyText(code)) { setCopied(true); setTimeout(() => setCopied(false), 1800); } };
  const share = () => { if (navigator.share) navigator.share({ text: shareText }).catch(() => {}); else copy(); };

  const milestones = loy.milestones || [];
  const nextMs = milestones.map(m => {
    const n = loy.deliveredSinceStart || 0;
    const left = m.repeat ? (m.orders - (n % m.orders)) : (m.orders - n);
    return { ...m, left };
  }).filter(m => m.left > 0).sort((a, b) => a.left - b.left)[0];
  const msText = (m) => m.type === "points" ? `${m.points} bonus points` : m.type === "cashback" ? `${fmtINR(m.amount)} cashback` : `a free ${m.variantLabel || "meal"}`;
  const earnText = loy.earn?.mode === "per_order" ? `${loy.earn.pointsPerOrder} points on every delivered order`
    : loy.earn?.mode === "per_amount" ? `${loy.earn.pointsPerStep} point${loy.earn.pointsPerStep === 1 ? "" : "s"} for every ₹${loy.earn.rupeesStep} you spend` : null;
  const vouchers = loy.vouchers || [];

  return (
    <Shell title="Rewards" onBack={onBack}>
      {/* Loyalty */}
      {loy.enabled && (
        <Card style={{ background: "#fff" }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: HC.orangeDeep, letterSpacing: 1, textTransform: "uppercase" }}>Homely Points</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "4px 0" }}>
            <span style={{ fontFamily: SERIF, fontSize: 34, fontWeight: 800 }}>{loy.balance}</span>
            <span style={{ fontSize: 13, color: HC.brownMid }}>points ≈ {fmtINR(Math.floor(loy.balance * loy.pointValue + 1e-9))}</span>
          </div>
          <div style={{ fontSize: 12.5, color: HC.brownMid, lineHeight: 1.55 }}>
            {earnText && <>You earn {earnText}. </>}
            {loy.minOrder > 0 && <>Orders of {fmtINR(loy.minOrder)} or more count for rewards. </>}
            {loy.redeemOn === "sides"
              ? <>Use them at checkout to pay for your Sweet or Raita of the day{loy.minRedeem ? ` (from ${loy.minRedeem} points)` : ""}.</>
              : <>Use them at checkout{loy.minRedeem ? ` (from ${loy.minRedeem} points)` : ""}{loy.maxRedeemPct < 100 ? `, up to ${loy.maxRedeemPct}% of an order` : ""}.</>}
          </div>
          {nextMs && (
            <div style={{ marginTop: 12, background: HC.peach, borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
              🎯 <b>{nextMs.left} more order{nextMs.left === 1 ? "" : "s"}</b> to get {msText(nextMs)}
            </div>
          )}
        </Card>
      )}

      {vouchers.length > 0 && (
        <Card>
          <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8 }}>Free meals</div>
          {vouchers.map(v => (
            <div key={v.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", fontSize: 13.5 }}>
              <span>🍱 {v.label}</span>
              {v.status === "available" ? <Pill tone="green">Ready to use</Pill> : <Pill>Used {fmtD(v.usedAt)}</Pill>}
            </div>
          ))}
          {vouchers.some(v => v.status === "available") && <div style={{ fontSize: 11.5, color: HC.brownMid, marginTop: 6 }}>Add that meal to your cart and pick the reward at checkout.</div>}
        </Card>
      )}

      {/* Referral — the code is always shown; the offer text only while the programme is on */}
      {(
        <Card style={{ background: "#FFF6EC", borderColor: HC.orange }}>
          <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 4 }}>🎁 Refer a friend</div>
          <div style={{ fontSize: 12.5, color: HC.brownMid, lineHeight: 1.5, marginBottom: 10 }}>
            {ref.enabled === false
              ? "Share Homely with friends using your personal code."
              : <>
                  {ref.referredDiscount ? `Friends save ₹${ref.referredDiscount} on their first order` : "Share Homely with friends"}
                  {ref.referrerReward ? ` and you get ₹${ref.referrerReward} credit when it's delivered.` : "."}
                </>}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <code style={{ flex: 1, textAlign: "center", fontSize: 18, fontWeight: 800, letterSpacing: 1.5, background: "#fff", color: HC.orangeDeep, padding: "9px 12px", borderRadius: 10, border: `1.5px dashed ${HC.orange}` }}>{code}</code>
            <SmallBtn tone="plain" onClick={copy}>{copied ? "Copied ✓" : "Copy"}</SmallBtn>
            <SmallBtn onClick={share}>Share</SmallBtn>
          </div>
          {ref.count > 0 && <div style={{ fontSize: 12, color: HC.green, fontWeight: 700, marginTop: 10 }}>You've earned {fmtINR(ref.earned)} from {ref.count} referral{ref.count === 1 ? "" : "s"} 🎉</div>}
        </Card>
      )}

      {/* History */}
      {loy.enabled && (loy.history || []).length > 0 && (
        <Card>
          <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 6 }}>Points history</div>
          {loy.history.map(h => (
            <div key={h.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "7px 0", borderTop: `1px solid ${HC.peach}`, fontSize: 13 }}>
              <div>
                <div style={{ fontWeight: 700 }}>{h.note || h.kind}</div>
                <div style={{ fontSize: 11, color: HC.brownSoft }}>{fmtD(h.date)}{h.orderId ? ` · ${shortId(h.orderId)}` : ""}</div>
              </div>
              <div style={{ fontWeight: 800, color: h.points >= 0 ? HC.green : HC.red, whiteSpace: "nowrap" }}>{h.points >= 0 ? "+" : "−"}{Math.abs(h.points)} pts</div>
            </div>
          ))}
        </Card>
      )}
    </Shell>
  );
}

// ── Credit ledger ──
function LedgerView({ ledger, onBack }) {
  if (!ledger) return <Shell title="Credit Ledger" onBack={onBack}><Busy /></Shell>;
  const bal = Number(ledger.balance || 0);
  return (
    <Shell title="Credit Ledger" onBack={onBack}>
      <Card style={{ background: "#fff", textAlign: "center" }}>
        <div style={{ fontSize: 12, color: HC.brownMid, fontWeight: 700 }}>{bal > 0 ? "Amount due" : bal < 0 ? "Advance with Homely" : "Balance"}</div>
        <div style={{ fontFamily: SERIF, fontSize: 34, fontWeight: 800, color: bal > 0 ? HC.red : HC.green }}>{fmtINR(Math.abs(bal))}</div>
        <div style={{ fontSize: 12, color: HC.brownMid }}>{bal > 0 ? "Please pay Homely when convenient" : bal < 0 ? "Will be adjusted against your next orders" : "All settled — thank you!"}</div>
      </Card>
      {(ledger.entries || []).length === 0 ? (
        <Card><div style={{ fontSize: 14, color: HC.brownMid }}>No entries yet.</div></Card>
      ) : (
        <Card style={{ padding: "6px 16px" }}>
          {ledger.entries.map((e, i) => (
            <div key={e.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "10px 0", borderTop: i ? `1px solid ${HC.peach}` : "none" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5 }}>{e.note || (e.type === "debit" ? "Order" : "Payment")}</div>
                {e.orderDetails && <div style={{ fontSize: 11.5, color: HC.brownMid, lineHeight: 1.35 }}>{e.orderDetails}</div>}
                <div style={{ fontSize: 11, color: HC.brownSoft }}>{fmtD(e.date)}</div>
              </div>
              <div style={{ fontWeight: 800, whiteSpace: "nowrap", color: e.type === "debit" ? HC.brown : HC.green }}>
                {e.type === "debit" ? "" : "+"}{fmtINR(e.amount)}
              </div>
            </div>
          ))}
        </Card>
      )}
      <div style={{ fontSize: 11.5, color: HC.brownSoft, textAlign: "center" }}>Orders are added when delivered; payments and credits reduce what you owe.</div>
    </Shell>
  );
}
