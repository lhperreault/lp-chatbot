// ─── Ops UI: Kanban data endpoint ────────────────────────────────────────
// Returns Jobs for a chosen view, plus the linked Clients resolved into
// {name, phone} so the frontend can render cards without a second round
// trip.
//
// Query params:
//   view  = "2026" | "all" | "booked" | "contacted"   (default "2026")
//   key   = <DASHBOARD_KEY>   required if env var set
//
// View layouts:
//   2026 / all  → kanban (jobs grouped by Pipeline stage)
//   booked      → list   (jobs with Pipeline stage = 📅 Booked, sorted by Booking date asc)
//   contacted   → list   (jobs with Pipeline stage = 📞 Contacted, sorted by Last touch asc — oldest first)

const AT_JOBS    = "Jobs";
const AT_CLIENTS = "Clients";

const KANBAN_STAGES = [
  "🆕 New lead",
  "💬 Quoted",
  "📞 Contacted",
  "📅 Booked",
  "✅ Job done",
  "❌ Lost",
];

const VIEW_CONFIGS = {
  "2026": {
    layout: "kanban",
    label:  "2026 Jobs",
    filter: `IS_AFTER({Create date}, '2025-12-31')`,
  },
  "all": {
    layout: "kanban",
    label:  "All Jobs",
    filter: null,
  },
  "booked": {
    layout: "list",
    label:  "Booked Calendar",
    filter: `{Pipeline stage}='📅 Booked'`,
    sortField: "Booking date",
    sortDirection: "asc",
  },
  "contacted": {
    layout: "list",
    label:  "Waiting for Client",
    filter: `AND({Pipeline stage}='📞 Contacted', {Customer responded}=BLANK())`,
    sortField: "Last touch",
    sortDirection: "asc",
  },
};

// Job fields we always return — all useful fields; frontend picks which
// to show on cards. Read-only and editable both included.
// Note: "Source channel" was renamed to "Lead origin" earlier — only
// "Lead origin" exists on the schema now.
const JOB_FIELDS = [
  "Job ID", "Client", "Service type", "Property snapshot", "Quote",
  "Quote amount", "Quote date", "Booking date", "Completion date",
  "Lead status", "Concerns", "Lead origin", "Pipeline stage",
  "Last touch", "Notes from Luke", "Outreach attempts",
  "Customer responded", "Create date",
];

function airtableUrl(table) {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`;
}
function airtableHeaders() {
  return { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` };
}

async function fetchAll(table, params = {}) {
  const records = [];
  let offset = null;
  do {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) v.forEach(item => qs.append(k, item));
      else qs.append(k, v);
    }
    if (offset) qs.set("offset", offset);
    const r = await fetch(`${airtableUrl(table)}?${qs.toString()}`, { headers: airtableHeaders() });
    const data = await r.json();
    if (data.error) throw new Error(`Airtable ${table}: ${data.error.message || data.error.type}`);
    records.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return records;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  res.setHeader("Cache-Control", "no-store");

  const expectedKey = process.env.DASHBOARD_KEY;
  if (expectedKey && req.query?.key !== expectedKey) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!process.env.AIRTABLE_BASE_ID || !process.env.AIRTABLE_API_KEY) {
    return res.status(500).json({ error: "airtable not configured" });
  }

  const viewKey = (req.query?.view || "2026").toString();
  const view = VIEW_CONFIGS[viewKey];
  if (!view) {
    return res.status(400).json({ error: `unknown view '${viewKey}'. Try one of: ${Object.keys(VIEW_CONFIGS).join(", ")}` });
  }

  try {
    // ── Fetch jobs ──────────────────────────────────────────────────────
    const params = { "fields[]": JOB_FIELDS };
    if (view.filter) params.filterByFormula = view.filter;
    if (view.sortField) {
      params["sort[0][field]"]     = view.sortField;
      params["sort[0][direction]"] = view.sortDirection || "asc";
    }
    const rawJobs = await fetchAll(AT_JOBS, params);

    // ── Resolve linked Client names + phones in one batched call ───────
    const clientIds = new Set();
    for (const j of rawJobs) {
      const linked = j.fields["Client"] || [];
      if (linked[0]) clientIds.add(linked[0]);
    }
    const clientMap = {}; // id → { name, phone, address }
    if (clientIds.size) {
      const ids = [...clientIds];
      // chunk to 50 to stay under Airtable formula length limits
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const formula = `OR(${chunk.map(id => `RECORD_ID()='${id}'`).join(",")})`;
        const clients = await fetchAll(AT_CLIENTS, {
          filterByFormula: formula,
          "fields[]": ["Name", "Full name", "Phone", "Address"],
        });
        for (const c of clients) {
          clientMap[c.id] = {
            name:    c.fields?.["Full name"] || c.fields?.["Name"] || "(unnamed)",
            phone:   c.fields?.["Phone"]   || "",
            address: c.fields?.["Address"] || "",
          };
        }
      }
    }

    // ── Reshape jobs for the frontend ───────────────────────────────────
    const jobs = rawJobs.map(j => {
      const f = j.fields;
      const linked = f["Client"] || [];
      const clientId = linked[0] || null;
      const client = clientId ? clientMap[clientId] : null;
      return {
        id:               j.id,
        jobId:            f["Job ID"]            || "",
        clientId,
        clientName:       client?.name           || "(no client)",
        clientPhone:      client?.phone          || "",
        clientAddress:    client?.address        || "",
        serviceType:      f["Service type"]      || "",
        propertySnapshot: f["Property snapshot"] || "",
        quote:            f["Quote"]             || "",
        quoteAmount:      f["Quote amount"]      || null,
        quoteDate:        f["Quote date"]        || null,
        bookingDate:      f["Booking date"]      || null,
        completionDate:   f["Completion date"]   || null,
        leadStatus:       f["Lead status"]       || "",
        pipelineStage:    f["Pipeline stage"]    || "",
        leadOrigin:       f["Lead origin"]       || "",
        lastTouch:        f["Last touch"]        || null,
        notesFromLuke:    f["Notes from Luke"]   || "",
        outreachAttempts: f["Outreach attempts"] || 0,
        customerResponded:f["Customer responded"]|| null,
        createDate:       f["Create date"]       || null,
        concerns:         f["Concerns"]          || "",
      };
    });

    // ── Group for kanban, leave flat for list ───────────────────────────
    let payload;
    if (view.layout === "kanban") {
      const buckets = {};
      for (const stage of KANBAN_STAGES) buckets[stage] = [];
      const other = [];
      for (const j of jobs) {
        if (buckets[j.pipelineStage]) buckets[j.pipelineStage].push(j);
        else other.push(j);
      }
      // Within each bucket, sort newest first by Create date (or fall back to Quote date)
      for (const stage of KANBAN_STAGES) {
        buckets[stage].sort((a, b) => {
          const ax = a.createDate || a.quoteDate || "";
          const bx = b.createDate || b.quoteDate || "";
          return ax < bx ? 1 : ax > bx ? -1 : 0;
        });
      }
      payload = {
        layout: "kanban",
        viewKey,
        viewLabel: view.label,
        columns: KANBAN_STAGES.map(stage => ({
          stage,
          count: buckets[stage].length,
          jobs:  buckets[stage],
        })),
        unstaged: other,
      };
    } else {
      payload = {
        layout: "list",
        viewKey,
        viewLabel: view.label,
        sortField: view.sortField,
        jobs,
      };
    }

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      ...payload,
    });
  } catch (err) {
    console.error("[ops-data] error:", err);
    return res.status(500).json({ error: err.message || "ops-data failed" });
  }
}
