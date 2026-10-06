import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ─────────────────────────────────────────────
// SUPABASE CLIENT — production only (the reminder-call feature runs in
// production only; this route lives on main, not Staging).
//
// Orders live in the `orders` table, whose RLS only lets the signed-in owner
// read/write, so this cron uses the service role key (bypasses RLS). Built
// lazily: Next.js runs a route's top-level code during the build, and
// createClient() throws on a missing key — a module-scope call would fail the
// whole build in any environment without this secret.
// ─────────────────────────────────────────────
const SUPABASE_URL = "https://locesmksvetbdhsvgqip.supabase.co";
let _supabase = null;
function getSupabase() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!_supabase) _supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return _supabase;
}

// ─────────────────────────────────────────────
// REMINDER SCHEDULE — 4 calls total, then stop
// ─────────────────────────────────────────────
const STAGES = [
  { key: 1, afterMs: 30 * 1000, say: "Alert. A new order is pending at Homely Tiffins. Please open your dashboard and respond." },
  { key: 2, afterMs: 90 * 1000, say: "Reminder. Your order is still pending. Please respond now." },
  { key: 3, afterMs: 5 * 60 * 1000, say: "Urgent reminder. An order has been pending for five minutes. Please accept or reject it." },
  { key: 4, afterMs: 15 * 60 * 1000, say: "Final reminder. An order has been pending for fifteen minutes with no response." },
];
// Only orders placed within this window are checked. The last stage fires at
// 15 min, so anything older has either had all its calls or is stale.
const LOOKBACK_MS = 60 * 60 * 1000;

async function triggerTwilioCall(stage) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const to = process.env.TWILIO_TO_NUMBER;

  if (!sid || !token || !from || !to) {
    throw new Error("Missing Twilio environment variables");
  }

  const twimlUrl = `https://twimlets.com/message?Message%5B0%5D=${encodeURIComponent(stage.say)}&Message%5B1%5D=${encodeURIComponent(stage.say)}`;

  const body = new URLSearchParams({ To: to, From: from, Url: twimlUrl });
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${auth}`,
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio error ${res.status}: ${text}`);
  }
}

export async function GET(request) {
  // Simple shared-secret check so random internet traffic can't trigger calls
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = getSupabase();
  if (!supabase) {
    console.error("[reminder-cron] SUPABASE_SERVICE_ROLE_KEY not configured in this environment");
    return Response.json({ ok: false, error: "missing service role key" }, { status: 503 });
  }

  const since = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const { data: orders, error } = await supabase
    .from("orders")
    .select("id, created_at, extra")
    .eq("status", "pending")
    .gte("created_at", since);

  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const now = Date.now();
  const callsFired = [];
  const errors = [];

  for (const order of orders || []) {
    const createdAt = new Date(order.created_at).getTime();
    if (!createdAt) continue;
    const elapsed = now - createdAt;
    const calledStages = Array.isArray(order.extra?.reminderStages) ? [...order.extra.reminderStages] : [];
    let changed = false;

    for (const stage of STAGES) {
      if (elapsed >= stage.afterMs && !calledStages.includes(stage.key)) {
        try {
          await triggerTwilioCall(stage);
          calledStages.push(stage.key);
          changed = true;
          callsFired.push({ orderId: order.id, stage: stage.key });
        } catch (err) {
          console.error("Reminder call failed:", err.message);
          errors.push({ orderId: order.id, stage: stage.key, error: err.message });
        }
      }
    }

    if (changed) {
      // Re-read `extra` just before writing so only reminderStages changes and
      // anything else the owner's app stored there in the meantime is kept.
      const { data: fresh } = await supabase.from("orders").select("extra").eq("id", order.id).maybeSingle();
      const { error: upErr } = await supabase
        .from("orders")
        .update({ extra: { ...(fresh?.extra || order.extra || {}), reminderStages: calledStages } })
        .eq("id", order.id);
      if (upErr) errors.push({ orderId: order.id, error: upErr.message });
    }
  }

  return Response.json({ ok: true, callsFired, errors, checked: (orders || []).length });
}
