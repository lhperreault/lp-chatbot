// api/booked-webhook.js
//
// Receives a webhook from Airtable Automation when a Job's Lead status
// flips to "Booked", looks up the original ad-click identifiers stored
// on the linked Client record, and fires a Purchase event to Meta CAPI.
//
// This is what closes the loop on cost-per-booked-job in Ads Manager.
//
// ─── Airtable Automation setup ────────────────────────────────────────
//
//   Trigger:
//     "When record matches conditions" on the Jobs table
//     Condition: Lead status = "Booked"
//
//   Action:
//     "Send webhook" → POST to https://chatbot-t1bk.vercel.app/api/booked-webhook
//     Headers: { "Content-Type": "application/json", "x-webhook-secret": "<META_WEBHOOK_SECRET>" }
//     Body (JSON):
//       {
//         "jobId":   "{{trigger record id}}",
//         "secret":  "<same META_WEBHOOK_SECRET>"
//       }
//
//   You can pass the secret in the body OR the header — webhook accepts
//   either. Header is slightly more standard; body is easier in Airtable.
//
// ─── Env vars required ────────────────────────────────────────────────
//   AIRTABLE_API_KEY, AIRTABLE_BASE_ID         (already set)
//   META_PIXEL_ID = 897302633330079
//   META_CAPI_TOKEN = <Events Manager → Settings → Conversions API>
//   META_WEBHOOK_SECRET = <random string, also paste into Airtable>
//
// ─── Dedupe behavior ──────────────────────────────────────────────────
//   event_id = `lp-booked-${jobId}`. Re-firing the same Airtable
//   Automation will hit the same event_id, and Meta dedupes within
//   7 days. Safe to retry.

import { sendCapiPurchase } from "../lib/metaCapi.js";

const AT_CLIENTS = "Clients";
const AT_JOBS    = "Jobs";

function airtableUrl(table, recordId = "") {
  const base = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`;
  return recordId ? `${base}/${recordId}` : base;
}
function airtableHeaders() {
  return { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" };
}

async function getRecord(table, recordId) {
  const res  = await fetch(airtableUrl(table, recordId), { headers: airtableHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Airtable ${table} fetch failed: ${res.status}`);
  return data;
}

// Pull a numeric quote amount from whatever field the Job uses. Different
// versions of the schema have stored this as "Quote amount" (number) or
// embedded inside the "Quote" string. Prefer the numeric field.
function extractQuoteAmount(jobFields) {
  if (typeof jobFields["Quote amount"] === "number") return jobFields["Quote amount"];
  const text = String(jobFields["Quote"] || "");
  const match = text.match(/\$?\s*(\d{2,5}(?:\.\d{1,2})?)/);
  if (match) return Number(match[1]);
  return undefined;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-webhook-secret");
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  // ─── Auth ────────────────────────────────────────────────────────────
  const expected = process.env.META_WEBHOOK_SECRET;
  if (!expected) return res.status(500).json({ error: "META_WEBHOOK_SECRET not configured" });
  const provided = req.headers["x-webhook-secret"] || req.body?.secret;
  if (provided !== expected) return res.status(401).json({ error: "Unauthorized" });

  const { jobId, testEventCode } = req.body || {};
  if (!jobId) return res.status(400).json({ error: "jobId required" });

  try {
    // ─── Look up Job + linked Client ───────────────────────────────────
    const job = await getRecord(AT_JOBS, jobId);
    const jf  = job.fields || {};
    const clientIds = Array.isArray(jf["Client"]) ? jf["Client"] : [];
    if (!clientIds.length) return res.status(400).json({ error: "Job has no linked Client" });

    const client = await getRecord(AT_CLIENTS, clientIds[0]);
    const cf     = client.fields || {};

    // Skip if this booking pre-dates the fbclid storage rollout — no
    // ad-click identifier means Meta can't attribute. Log and move on.
    const fbclid = cf["Meta fbclid"] || "";
    const fbp    = cf["Meta fbp"]    || "";
    if (!fbclid && !fbp) {
      console.log("[booked-webhook] no fbclid/fbp on Client", clientIds[0], "— skipping CAPI (organic / direct lead)");
      return res.status(200).json({ ok: true, skipped: "no_meta_attribution" });
    }

    const value = extractQuoteAmount(jf);
    const result = await sendCapiPurchase({
      eventId:        `lp-booked-${jobId}`,
      value,
      currency:       "USD",
      fbclid,
      fbp,
      firstSeenAt:    cf["Meta first seen at"] || "",
      email:          cf["Email"] || "",
      phone:          cf["Phone"] || "",
      firstName:      cf["Name"]  || "",
      lastName:       "",
      eventSourceUrl: "https://lppressurewash.com/",
      eventName:      "Purchase",
      contentName:    `booked:${jf["Service type"] || "estimate"}`.slice(0, 100),
      testEventCode,
    });

    if (!result.ok) {
      console.error("[booked-webhook] CAPI send failed:", result);
      return res.status(502).json({ ok: false, error: result.error, body: result.body });
    }

    console.log("[booked-webhook] CAPI Purchase sent", { jobId, value, fbclid: fbclid ? "yes" : "no", fbp: fbp ? "yes" : "no" });
    return res.status(200).json({ ok: true, eventId: `lp-booked-${jobId}`, value });
  } catch (err) {
    console.error("[booked-webhook] error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
