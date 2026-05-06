// lib/metaCapi.js
//
// Meta Conversions API (CAPI) helper. Sends server-side events to Meta
// so we can track conversions even when the browser pixel is blocked
// (iOS Limited Tracking, Safari ITP, ad blockers, VPNs).
//
// Used by:
//   - api/booked-webhook.js  → Purchase event when an Airtable Job's
//                              Lead status flips to "Booked"
//
// Setup (one-time):
//   1. Events Manager → your pixel → Settings → Conversions API →
//      "Generate access token". Store it as META_CAPI_TOKEN in Vercel.
//   2. Add META_PIXEL_ID = 897302633330079 to Vercel env vars.
//   3. Test events in Events Manager → Test Events tab. Pass
//      testEventCode in the call to make events appear there
//      without polluting production stats.
//
// Dedupe:
//   Always pass eventId. Meta dedupes browser pixel + server CAPI events
//   that share the same eventId within a 7-day window. For Purchase
//   events fired from the booking webhook, use `lp-booked-${jobId}` so
//   re-firing the Airtable Automation can't double-count.

import crypto from "node:crypto";

const META_API_VERSION = "v21.0";

// SHA-256 hash, lowercase hex. Meta requires this format for PII fields
// (em / ph / fn / ln / etc.) so they can match against ad-click profiles
// without us sending raw PII over the wire.
function sha256(value) {
  if (!value) return null;
  return crypto.createHash("sha256").update(String(value).trim().toLowerCase()).digest("hex");
}

// Normalize a US phone number to E.164 (+1XXXXXXXXXX) before hashing.
// Meta's match rate drops sharply if the format isn't E.164.
function normalizePhoneE164(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;          // assume US
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;                                      // already has country code
}

// Build Meta's `fbc` parameter from the original fbclid + the timestamp
// when the visitor first landed on the page. Format is required:
//   fb.<subdomain_index>.<timestamp_ms>.<fbclid>
// subdomain_index is 1 for top-level (e.g. lppressurewash.com).
function buildFbc(fbclid, firstSeenAtIso) {
  if (!fbclid) return null;
  let ms = Date.now();
  if (firstSeenAtIso) {
    const parsed = Date.parse(firstSeenAtIso);
    if (!Number.isNaN(parsed)) ms = parsed;
  }
  return `fb.1.${ms}.${fbclid}`;
}

/**
 * Send a Purchase event to Meta CAPI.
 *
 * @param {object} params
 * @param {string} params.eventId           - Idempotency key. Reuse across browser+server for dedupe.
 * @param {number} [params.value]           - Booking value in dollars (e.g. 450).
 * @param {string} [params.currency='USD']
 * @param {string} [params.fbclid]          - From original ad click, stored on Client record.
 * @param {string} [params.fbp]             - _fbp cookie value, stored on Client record.
 * @param {string} [params.firstSeenAt]     - ISO timestamp of first landing-page visit.
 * @param {string} [params.email]           - Plaintext; we hash before sending.
 * @param {string} [params.phone]           - Plaintext; we E.164-normalize then hash.
 * @param {string} [params.firstName]
 * @param {string} [params.lastName]
 * @param {string} [params.eventSourceUrl='https://lppressurewash.com/']
 * @param {string} [params.eventName='Purchase']
 * @param {string} [params.testEventCode]   - From Events Manager → Test Events tab. OMIT in production.
 * @param {string} [params.contentName]     - Optional descriptor (e.g. 'house_wash_booked').
 * @returns {Promise<{ok: boolean, status?: number, body?: any, error?: string}>}
 */
export async function sendCapiPurchase(params) {
  const pixelId     = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_CAPI_TOKEN;
  if (!pixelId)     return { ok: false, error: "META_PIXEL_ID not configured" };
  if (!accessToken) return { ok: false, error: "META_CAPI_TOKEN not configured" };

  const {
    eventId,
    value,
    currency = "USD",
    fbclid,
    fbp,
    firstSeenAt,
    email,
    phone,
    firstName,
    lastName,
    eventSourceUrl = "https://lppressurewash.com/",
    eventName = "Purchase",
    testEventCode,
    contentName,
  } = params || {};

  if (!eventId) return { ok: false, error: "eventId is required for dedupe" };

  const user_data = {};
  const emailHash = sha256(email);
  const phoneHash = sha256(normalizePhoneE164(phone));
  const firstHash = sha256(firstName);
  const lastHash  = sha256(lastName);
  if (emailHash) user_data.em = [emailHash];
  if (phoneHash) user_data.ph = [phoneHash];
  if (firstHash) user_data.fn = [firstHash];
  if (lastHash)  user_data.ln = [lastHash];
  const fbc = buildFbc(fbclid, firstSeenAt);
  if (fbc) user_data.fbc = fbc;
  if (fbp) user_data.fbp = fbp;

  const event = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: "website",
    event_source_url: eventSourceUrl,
    user_data,
  };
  if (typeof value === "number" || contentName) {
    event.custom_data = {
      currency,
      ...(typeof value === "number" ? { value } : {}),
      ...(contentName ? { content_name: contentName } : {}),
    };
  }

  const body = { data: [event] };
  if (testEventCode) body.test_event_code = testEventCode;

  const url = `https://graph.facebook.com/${META_API_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(accessToken)}`;

  try {
    const res  = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, body: json, error: json?.error?.message || `HTTP ${res.status}` };
    return { ok: true, status: res.status, body: json };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
