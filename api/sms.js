import crypto from "crypto";

// ─── Twilio inbound SMS → Telegram forwarder ────────────────────────────────
// Scoped MVP from the full "Twilio SMS + Brain Phase 1" handoff:
// just forwards incoming SMS (to (844) 904-0754) into Luke's Telegram
// so he knows someone texted the business number. Replies for now are
// sent from the Twilio Console or the Twilio mobile app.
//
// Env vars:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  — already set (estimate flow)
//   TWILIO_AUTH_TOKEN                     — from Twilio Console (add in Vercel)
//
// Twilio webhook URL (set in Twilio Console → Phone Numbers → (844) 904-0754
// → Messaging → "A message comes in"):
//   https://chatbot-t1bk.vercel.app/api/sms   (HTTP POST)

function htmlEscape(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendTelegram(text) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    console.log("[sms] telegram not configured; skipping ping");
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) console.error("[sms] telegram send failed", res.status, await res.text().catch(() => ""));
  } catch (err) {
    console.error("[sms] telegram threw:", err);
  }
}

// Twilio signs webhook requests with HMAC-SHA1 over the full URL followed
// by the form params concatenated in alphabetical order. If the signature
// header is missing or wrong, someone is forging a webhook to spam our
// Telegram — reject it. https://www.twilio.com/docs/usage/webhooks/webhooks-security
function verifyTwilioSignature(req, params) {
  const signature = req.headers["x-twilio-signature"];
  if (!signature || !process.env.TWILIO_AUTH_TOKEN) return false;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host  = req.headers["host"];
  const url   = `${proto}://${host}${req.url}`;
  const sortedKeys = Object.keys(params).sort();
  let signed = url;
  for (const k of sortedKeys) signed += k + params[k];
  const expected = crypto.createHmac("sha1", process.env.TWILIO_AUTH_TOKEN).update(signed).digest("base64");
  // Constant-time comparison to avoid timing attacks
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  // Vercel auto-parses application/x-www-form-urlencoded into req.body as
  // an object; fall back to manual parse if it came in as a string.
  let body = req.body || {};
  if (typeof body === "string") {
    try { body = Object.fromEntries(new URLSearchParams(body)); } catch { body = {}; }
  }

  const from     = body.From        || "";
  const to       = body.To          || "";
  const text     = body.Body        || "";
  const name     = body.ProfileName || "";
  const numMedia = parseInt(body.NumMedia || "0", 10);

  // Signature check (skipped only if TWILIO_AUTH_TOKEN env var isn't set,
  // so Luke can smoke-test with curl before wiring it).
  if (process.env.TWILIO_AUTH_TOKEN) {
    const valid = verifyTwilioSignature(req, body);
    if (!valid) {
      console.warn("[sms] invalid Twilio signature; rejecting");
      return res.status(403).send("Forbidden");
    }
  } else {
    console.warn("[sms] TWILIO_AUTH_TOKEN not set — accepting unsigned requests (INSECURE)");
  }

  console.log("[sms] inbound", { from, to, textLen: text.length, numMedia, hasName: !!name });

  // Build the Telegram ping
  const parts = [
    `💬 <b>Incoming SMS</b>`,
    name ? `👤 ${htmlEscape(name)} · ${htmlEscape(from)}` : `📞 ${htmlEscape(from)}`,
  ];
  if (text) {
    parts.push("");
    parts.push(htmlEscape(text));
  }
  if (numMedia > 0) {
    parts.push("");
    parts.push(`📎 <i>${numMedia} attachment${numMedia > 1 ? "s" : ""} — view in Twilio Console</i>`);
  }
  parts.push("");
  parts.push(`<i>Reply from the Twilio Console (Messaging → Logs) or the Twilio mobile app. Full approve-by-one-tap loop coming in Phase 1 of the SMS project.</i>`);

  await sendTelegram(parts.join("\n"));

  // Empty TwiML response — we send any reply out-of-band, not via TwiML.
  res.setHeader("Content-Type", "text/xml");
  return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}
