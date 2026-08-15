import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ─────────────────────────────────────────────
// SUPABASE CLIENT (same project/key as the main app — this key is already
// public in the client bundle, so reusing it here is not a new exposure)
// ─────────────────────────────────────────────
const SUPABASE_URL = "https://locesmksvetbdhsvgqip.supabase.co";
const SUPABASE_KEY = "sb_publishable_A24gDavt6HAX7sreGI9vQA_ol2PO1Yb";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const ORDERS_KEY = "ht_orders_today";

// ─────────────────────────────────────────────
// REMINDER SCHEDULE — 4 calls total, then stop
// ─────────────────────────────────────────────
const STAGES = [
  { key: 1, afterMs: 30 * 1000, say: "Alert. A new order is pending at Homely Tiffins. Please open your dashboard and respond." },
  { key: 2, afterMs: 90 * 1000, say: "Reminder. Your order is still pending. Please respond now." },
  { key: 3, afterMs: 5 * 60 * 1000, say: "Urgent reminder. An order has been pending for five minutes. Please accept or reject it." },
  { key: 4, afterMs: 15 * 60 * 1000, say: "Final reminder. An order has been pending for fifteen minutes with no response." },
];

function todayStr() {
  return new Date().toISOString().split("T")[0];
}

async function triggerTwilioCall(stage) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const to = process.env.TWILIO_TO_NUMBER;

  if (!sid || !token || !from || !to) {
    throw new Error("Missing Twilio environment variables");
  }

  const twiml = `<Response><Say voice="alice">${stage.say} ${stage.say}</Say></Response>`;

  const body = new URLSearchParams({ To: to, From: from, Twiml: twiml });
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

  const { data, error } = await supabase
    .from("app_data")
    .select("value")
    .eq("key", ORDERS_KEY)
    .maybeSingle();

  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const orders = (data && data.value) || [];
  const today = todayStr();
  const now = Date.now();
  const callsFired = [];
  const errors = [];
  let changed = false;

  for (const order of orders) {
    if (order.status !== "pending" || order.date !== today) continue;

    const createdAt = new Date(order.createdAt).getTime();
    if (!createdAt) continue;
    const elapsed = now - createdAt;
    const calledStages = Array.isArray(order.reminderStages) ? order.reminderStages : [];

    for (const stage of STAGES) {
      if (elapsed >= stage.afterMs && !calledStages.includes(stage.key)) {
        try {
          await triggerTwilioCall(stage);
          calledStages.push(stage.key);
          order.reminderStages = calledStages;
          changed = true;
          callsFired.push({ orderId: order.id, stage: stage.key });
        } catch (err) {
          console.error("Reminder call failed:", err.message);
          errors.push({ orderId: order.id, stage: stage.key, error: err.message });
        }
      }
    }
  }

  if (changed) {
    await supabase
      .from("app_data")
      .upsert({ key: ORDERS_KEY, value: orders, updated_at: new Date().toISOString() }, { onConflict: "key" });
  }

  return Response.json({ ok: true, callsFired, errors, checked: orders.length });
}
