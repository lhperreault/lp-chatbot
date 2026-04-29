// ─── Funnel-event tracker ──────────────────────────────────────────────────
// Lightweight write-only endpoint the widget calls on page-view, CTA-click,
// form step transitions, etc. Logs each event as a row in the "Funnel events"
// Airtable table so the marketing dashboard can compute stage-by-stage drop-
// off and per-source conversion rates.
//
// Anonymous: no PII required (sessionId is a client-generated UUID, not a
// fingerprint). When the same visitor later identifies via the form, the
// estimate.js handler links them by Client record.
//
// CORS open — the widget is embedded on luke's wordpress site.

const AT_FUNNEL = "Funnel events";

const ALLOWED_EVENTS = new Set([
  "Ad click",
  "Page view",
  "CTA click",
  "Form step 1",
  "Form step 2",
  "Form submitted",
  "Chat engaged",
  "Quote sent",
  "Booked",
]);

function airtableUrl(table) {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`;
}
function airtableHeaders() {
  return { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" };
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Short, human-grep-friendly id like "20260429-1715-r9k2".
function makeEventId() {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, "");
  const hm  = d.toISOString().slice(11, 16).replace(":", "");
  const r   = Math.random().toString(36).slice(2, 6);
  return `${ymd}-${hm}-${r}`;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  if (!process.env.AIRTABLE_BASE_ID || !process.env.AIRTABLE_API_KEY) {
    return res.status(200).json({ ok: false, skipped: "airtable not configured" });
  }

  try {
    const { event_type, attribution = {}, sessionId, notes } = req.body || {};
    if (!event_type || !ALLOWED_EVENTS.has(event_type)) {
      return res.status(400).json({ error: `event_type must be one of: ${[...ALLOWED_EVENTS].join(", ")}` });
    }

    const fields = {
      "Event ID":     makeEventId(),
      "Event type":   event_type,
      "Timestamp":    new Date().toISOString(),
      "UTM source":   (attribution.utm_source   || "").slice(0, 200),
      "UTM campaign": (attribution.utm_campaign || "").slice(0, 200),
      "Referrer":     (attribution.referrer     || "").slice(0, 500) || undefined,
      "Landing URL":  (attribution.landing_url  || "").slice(0, 500) || undefined,
      "Session ID":   (sessionId                || "").slice(0, 64),
    };
    if (notes) fields["Notes"] = String(notes).slice(0, 1000);

    // Strip any undefined values so Airtable doesn't choke.
    Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);

    const r = await fetch(airtableUrl(AT_FUNNEL), {
      method: "POST",
      headers: airtableHeaders(),
      body: JSON.stringify({ fields }),
    });
    const data = await r.json();
    if (data.error) {
      console.error("[track] Airtable error:", data.error);
      return res.status(200).json({ ok: false, error: data.error.message });
    }
    return res.status(200).json({ ok: true, id: data.id });
  } catch (err) {
    console.error("[track] handler error:", err);
    return res.status(200).json({ ok: false, error: err.message });
  }
}
