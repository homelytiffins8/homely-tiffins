import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Same Staging Supabase project the rest of the app uses.
const SUPABASE_URL = "https://ktwaesobvvqzzhadrdoa.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_dwkOUIJJ4oU2xIR0l6kDHg_zw9rHkIQ";
// Service role key bypasses RLS — required because push_subscriptions has no
// authenticated owner session backing it (same reasoning as reminder-cron's
// use of a service key for the orders table).
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:owner@homelytiffins.example",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Body shapes:
//   Automatic (single customer):  { phone, title, body, url? }
//   Owner broadcast:              { target: "all" | "today", title, body, url?, secret }
export async function POST(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { phone, target, title, body, url } = payload;
  if (!title || !body) {
    return Response.json({ ok: false, error: "title and body are required" }, { status: 400 });
  }

  // Broadcasts (target: all/today) are owner-only. The owner dashboard sends
  // its real Supabase Auth access token (the same session used to log in as
  // owner) — verify it server-side rather than trusting a client-supplied flag.
  if (target) {
    const authHeader = request.headers.get("authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data: userData, error: authErr } = await authClient.auth.getUser(token);
    if (authErr || !userData?.user) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  let query = supabase.from("push_subscriptions").select("*");
  if (phone) {
    query = query.eq("phone", phone);
  } else if (target === "today") {
    const today = new Date().toISOString().split("T")[0];
    const { data: orders, error: ordersErr } = await supabase
      .from("orders")
      .select("phone")
      .eq("date", today);
    if (ordersErr) return Response.json({ ok: false, error: ordersErr.message }, { status: 500 });
    const phones = [...new Set((orders || []).map(o => o.phone).filter(Boolean))];
    if (phones.length === 0) return Response.json({ ok: true, sent: 0, failed: 0 });
    query = query.in("phone", phones);
  } else if (target !== "all") {
    return Response.json({ ok: false, error: "Provide phone, or target: all|today" }, { status: 400 });
  }

  const { data: subs, error } = await query;
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

  const payloadStr = JSON.stringify({ title, body, url });
  const staleEndpoints = [];
  let sent = 0, failed = 0;

  await Promise.all((subs || []).map(async (sub) => {
    const subscription = { endpoint: sub.endpoint, keys: sub.keys };
    try {
      await webpush.sendNotification(subscription, payloadStr);
      sent++;
    } catch (err) {
      failed++;
      // 404/410 = the browser/OS has invalidated this subscription
      // (uninstalled, permission revoked, etc.) — clean it up.
      if (err.statusCode === 404 || err.statusCode === 410) {
        staleEndpoints.push(sub.endpoint);
      }
    }
  }));

  if (staleEndpoints.length) {
    await supabase.from("push_subscriptions").delete().in("endpoint", staleEndpoints);
  }

  // Logged so a "no notification arrived" report can be checked against
  // Vercel's runtime logs directly — a 200 response alone doesn't say
  // whether any subscription actually matched or any push actually sent.
  console.log(`[send-push] phone=${phone || "-"} target=${target || "-"} matched=${(subs || []).length} sent=${sent} failed=${failed} staleRemoved=${staleEndpoints.length}`);

  return Response.json({ ok: true, sent, failed });
}
