// ─── Ops UI: Job update endpoint ─────────────────────────────────────────
// PATCH a single Job. Whitelist guards which fields can be edited from the
// Kanban modal — everything else has to go through the chatbot or Airtable
// directly. Pipeline stage transitions also auto-stamp companion fields
// (Lead status, Last touch) per Luke's CLAUDE.md transition matrix.
//
// POST body:
//   {
//     jobId:   "rec...",
//     fields: { "Pipeline stage": "📅 Booked", "Booking date": "2026-05-22", ... }
//   }
//
// Query params:
//   key   = <DASHBOARD_KEY>   required if env var set

const AT_JOBS = "Jobs";

// Only these fields are editable from the Kanban modal. Sending anything
// else fails the request.
const EDITABLE_FIELDS = new Set([
  "Pipeline stage",
  "Lead status",
  "Booking date",
  "Quote amount",
  "Quote date",
  "Last touch",
  "Outreach attempts",
  "Notes from Luke",
  "Customer responded",
  "Completion date",
  "Final paid",
  "Concerns",
  "Service type",
]);

// Map Pipeline stage → Lead status. Auto-applied on stage moves so the
// legacy Lead status field stays in sync. Lifted from CLAUDE.md.
const STAGE_TO_LEAD_STATUS = {
  "🆕 New lead":  null,        // leave blank
  "💬 Quoted":    "Quoted",
  "📞 Contacted": "Follow up",
  "📅 Booked":    "Booked",
  "✅ Job done":  "Completed",
  "❌ Lost":      "Lost",
};

function airtableUrl(table) {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`;
}
function airtableHeaders() {
  return {
    Authorization:  `Bearer ${process.env.AIRTABLE_API_KEY}`,
    "Content-Type": "application/json",
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  const expectedKey = process.env.DASHBOARD_KEY;
  if (expectedKey && req.query?.key !== expectedKey) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!process.env.AIRTABLE_BASE_ID || !process.env.AIRTABLE_API_KEY) {
    return res.status(500).json({ error: "airtable not configured" });
  }

  try {
    const { jobId, fields } = req.body || {};
    if (!jobId || !/^rec[A-Za-z0-9]{14}$/.test(jobId)) {
      return res.status(400).json({ error: "invalid jobId" });
    }
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      return res.status(400).json({ error: "fields must be an object" });
    }

    // Validate every field is in the whitelist
    const incoming = Object.keys(fields);
    const rejected = incoming.filter(k => !EDITABLE_FIELDS.has(k));
    if (rejected.length) {
      return res.status(400).json({ error: `not editable from this UI: ${rejected.join(", ")}` });
    }

    // Auto-stamp companion fields based on Pipeline stage transitions
    const out = { ...fields };
    if (out["Pipeline stage"] && !("Lead status" in out)) {
      const mapped = STAGE_TO_LEAD_STATUS[out["Pipeline stage"]];
      if (mapped !== undefined) {
        if (mapped === null) {
          // leaving Lead status blank — Airtable accepts null to clear
          out["Lead status"] = null;
        } else {
          out["Lead status"] = mapped;
        }
      }
    }
    // Move to 📞 Contacted should bump Last touch to today if not provided
    if (out["Pipeline stage"] === "📞 Contacted" && !out["Last touch"]) {
      out["Last touch"] = new Date().toISOString().split("T")[0];
    }
    // Move to ✅ Job done should set Completion date to today if not provided
    if (out["Pipeline stage"] === "✅ Job done" && !out["Completion date"]) {
      out["Completion date"] = new Date().toISOString().split("T")[0];
    }

    // Convert empty strings to null so Airtable clears the field rather than
    // storing "". Numeric/date fields get coerced.
    const cleaned = {};
    for (const [k, v] of Object.entries(out)) {
      if (v === "" || v === undefined) {
        cleaned[k] = null;
      } else if (k === "Quote amount" || k === "Final paid" || k === "Outreach attempts") {
        cleaned[k] = v == null ? null : Number(v);
      } else {
        cleaned[k] = v;
      }
    }

    const r = await fetch(`${airtableUrl(AT_JOBS)}/${jobId}`, {
      method: "PATCH",
      headers: airtableHeaders(),
      body: JSON.stringify({ fields: cleaned, typecast: true }),
    });
    const data = await r.json();
    if (data.error) {
      console.error("[ops-update] Airtable error:", data.error, "fields:", cleaned);
      return res.status(400).json({ error: data.error.message || data.error.type, fieldsSent: cleaned });
    }

    return res.status(200).json({ ok: true, jobId: data.id, fields: data.fields });
  } catch (err) {
    console.error("[ops-update] error:", err);
    return res.status(500).json({ error: err.message || "ops-update failed" });
  }
}
