import crypto from "crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Supabase Auth "Send SMS" hook → MSG91.
//
// Supabase generates and verifies the OTP itself; this route only delivers
// it by SMS through MSG91 (cheaper in India and DLT-registered). Supabase
// signs every call with the hook secret (Standard Webhooks), so nobody else
// can use this endpoint to send texts.
//
// Environment (Vercel, per environment):
//   SEND_SMS_HOOK_SECRET   — from Supabase → Authentication → Hooks → Send SMS ("v1,whsec_…")
//   MSG91_AUTH_KEY         — MSG91 auth key
//   MSG91_OTP_TEMPLATE_ID  — MSG91 OTP template id (DLT-approved, with an ##OTP## variable)
//
// Supabase test phone numbers (Authentication → Providers → Phone) never
// reach this hook, so staging can be tested without MSG91 configured.

function verifySignature(rawBody, headers) {
  const secret = process.env.SEND_SMS_HOOK_SECRET || "";
  const id = headers.get("webhook-id");
  const ts = headers.get("webhook-timestamp");
  const sigHeader = headers.get("webhook-signature") || "";
  if (!secret || !id || !ts || !sigHeader) return false;
  // Reject replays older than 5 minutes.
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.replace(/^v1,/, "").replace(/^whsec_/, ""), "base64");
  const expected = crypto.createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest("base64");
  return sigHeader.split(" ").some(part => {
    const sig = part.split(",")[1] || "";
    const a = Buffer.from(sig), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

function hookError(status, message) {
  // Shape Supabase Auth expects from a failing hook; the message reaches the app.
  return Response.json({ error: { http_code: status, message } }, { status });
}

export async function POST(request) {
  const rawBody = await request.text();
  if (!verifySignature(rawBody, request.headers)) {
    return hookError(401, "Invalid hook signature");
  }

  let payload;
  try { payload = JSON.parse(rawBody); } catch { return hookError(400, "Invalid JSON"); }
  const phone = String(payload?.user?.phone || "").replace(/\D/g, "");
  const otp = String(payload?.sms?.otp || "");
  if (!/^91\d{10}$/.test(phone) || !/^\d{4,8}$/.test(otp)) {
    return hookError(400, "Only Indian mobile numbers are supported");
  }

  const authKey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_OTP_TEMPLATE_ID;
  if (!authKey || !templateId) {
    console.error("[sms-hook] MSG91_AUTH_KEY / MSG91_OTP_TEMPLATE_ID not configured");
    return hookError(503, "SMS is not set up yet. Please try again later.");
  }

  const url = new URL("https://control.msg91.com/api/v5/otp");
  url.searchParams.set("template_id", templateId);
  url.searchParams.set("mobile", phone);
  url.searchParams.set("otp", otp);
  url.searchParams.set("otp_expiry", "10"); // minutes, informational on MSG91's side

  try {
    const res = await fetch(url, { method: "POST", headers: { authkey: authKey, "Content-Type": "application/json" }, body: "{}" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.type === "error") {
      console.error(`[sms-hook] MSG91 failed status=${res.status} msg=${body.message || ""}`);
      return hookError(502, "Couldn't send the SMS. Please try again.");
    }
  } catch (err) {
    console.error("[sms-hook] MSG91 request threw:", err.message);
    return hookError(502, "Couldn't send the SMS. Please try again.");
  }

  // Never log the OTP itself.
  console.log(`[sms-hook] OTP sent to ******${phone.slice(-4)}`);
  return Response.json({});
}
