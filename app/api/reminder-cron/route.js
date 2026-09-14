import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ─────────────────────────────────────────────
// SUPABASE CLIENT — uses the SERVICE ROLE key (server-only, never exposed to
// the client bundle) because the `orders` table's RLS now restricts access
// to the `authenticated` role. This route runs entirely server-side, so a
// service-role key here is safe and necessary.
// ─────────────────────────────────────────────
const SUPABASE_URL = "https://locesmksvetbdhsvgqip.supabase.co";
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ─────────────────────────────────────────────
// REMINDER SCHEDULE — 4 calls total, then stop
// ─────────────────────────────────────────────
const STAGES = [
  { key: 1, afterMs: 30 * 1000, say: "Alert. A new order is pending at Homely Tiffins. Please open your dashboard and respond." },
  { key: 2, afterMs: 90 * 1000, say: "Reminder. Your order is still pending. Please respond now." },
  { key: 3, afterMs: 5 * 60 * 1000, say: "Urgent reminder. An order has been pending for five minutes. Please accept or reject it." },
  { key: 4, afterMs: 15 * 60 * 1000, say: "Final reminder. An order has been pending for fifteen minutes with no response." },
];

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
  try {
    // Simple shared-secret check so random internet traffic can't trigger calls
    const url = new URL(request.url);
    const secret = url.searchParams.get("secret");
    if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return Response.json({ ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY env var" }, { status: 500 });
    }

    // No date filter here on purpose: the `date` column is set using local
    // (IST) calendar date while this server runs on UTC, which caused a
    // timezone mismatch that silently hid orders placed late at night.
    // Per-order reminderStages tracking already prevents old orders from
    // re-triggering calls they've already had, so filtering by date is
    // unnecessary.
    const { data: orders, error } = await supabase
      .from("orders")
      .select("id, created_at, extra")
      .eq("status", "pending");

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
      const existingExtra = order.extra || {};
      const calledStages = Array.isArray(existingExtra.reminderStages) ? existingExtra.reminderStages : [];
      let updatedStages = calledStages;

      for (const stage of STAGES) {
        if (elapsed >= stage.afterMs && !updatedStages.includes(stage.key)) {
          try {
            await triggerTwilioCall(stage);
            updatedStages = [...updatedStages, stage.key];
            callsFired.push({ orderId: order.id, stage: stage.key });
          } catch (err) {
            console.error("Reminder call failed:", err.message);
            errors.push({ orderId: order.id, stage: stage.key, error: err.message });
          }
        }
      }

      if (updatedStages.length !== calledStages.length) {
        const { error: updateError } = await supabase
          .from("orders")
          .update({ extra: { ...existingExtra, reminderStages: updatedStages } })
          .eq("id", order.id);

        if (updateError) {
          errors.push({ orderId: order.id, error: `Failed to save reminder state: ${updateError.message}` });
        }
      }
    }

    return Response.json({ ok: true, callsFired, errors, checked: (orders || []).length });
  } catch (err) {
    console.error("reminder-cron top-level error:", err.message);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
