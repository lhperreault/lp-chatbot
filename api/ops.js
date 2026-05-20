// ─── Ops API: single endpoint for the Ops UI ────────────────────────────
// Consolidates what used to be three files (ops-data, ops-update, ops-chat)
// behind one handler so we stay under Vercel's Hobby-plan 12-function cap.
// Routes by ?action= query param:
//
//   GET  /api/ops?action=data&view=2026|all|booked|contacted
//        → returns Jobs grouped by view, Clients resolved
//   POST /api/ops?action=update   { jobId, fields }
//        → patches a Job. Whitelisted fields. Auto-stamps companions.
//   POST /api/ops?action=chat     { messages, view, selectedJobId, selectedClientId }
//        → Anthropic Sonnet 4.5 + tools. Returns { reply, toolCalls, usage }.
//
// All actions share auth (DASHBOARD_KEY) and Airtable helpers.

import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";

// ═══════════════════════════════════════════════════════════════════════
// Shared: Airtable helpers + constants
// ═══════════════════════════════════════════════════════════════════════

const AT_BASE     = process.env.AIRTABLE_BASE_ID;
const AT_KEY      = process.env.AIRTABLE_API_KEY;
const AT_CLIENTS  = "Clients";
const AT_JOBS     = "Jobs";
const AT_FUNNEL   = "Funnel events";

function airtableUrl(table) {
  return `https://api.airtable.com/v0/${AT_BASE}/${encodeURIComponent(table)}`;
}
function airtableHeaders() {
  return { Authorization: `Bearer ${AT_KEY}`, "Content-Type": "application/json" };
}
async function airtableGet(table, params = {}) {
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
async function airtablePatch(table, recordId, fields) {
  const r = await fetch(`${airtableUrl(table)}/${recordId}`, {
    method: "PATCH",
    headers: airtableHeaders(),
    body: JSON.stringify({ fields, typecast: true }),
  });
  const data = await r.json();
  if (data.error) throw new Error(`Airtable PATCH ${table}: ${data.error.message || data.error.type}`);
  return data;
}
async function airtablePost(table, fields) {
  const r = await fetch(airtableUrl(table), {
    method: "POST",
    headers: airtableHeaders(),
    body: JSON.stringify({ fields, typecast: true }),
  });
  const data = await r.json();
  if (data.error) throw new Error(`Airtable POST ${table}: ${data.error.message || data.error.type}`);
  return data;
}

const STAGE_TO_LEAD_STATUS = {
  "🆕 New lead":  null,
  "💬 Quoted":    "Quoted",
  "📞 Contacted": "Follow up",
  "📅 Booked":    "Booked",
  "✅ Job done":  "Completed",
  "❌ Lost":      "Lost",
  "🚫 Fake":      "Lost",
};

const todayISO = () => new Date().toISOString().split("T")[0];

// ═══════════════════════════════════════════════════════════════════════
// Action: data — Kanban / list view payload
// ═══════════════════════════════════════════════════════════════════════

const KANBAN_STAGES = [
  "🆕 New lead",
  "💬 Quoted",
  "📞 Contacted",
  "📅 Booked",
  "✅ Job done",
  "❌ Lost",
  "🚫 Fake",
];

const VIEW_CONFIGS = {
  "2026":      { layout: "kanban", label: "2026 Jobs",          filter: `IS_AFTER({Create date}, '2025-12-31')` },
  "all":       { layout: "kanban", label: "All Jobs",           filter: null },
  "booked":    { layout: "list",   label: "Booked Calendar",    filter: `{Pipeline stage}='📅 Booked'`,                                              sortField: "Booking date", sortDirection: "asc" },
  "contacted": { layout: "list",   label: "Waiting for Client", filter: `AND({Pipeline stage}='📞 Contacted', {Customer responded}=BLANK())`,        sortField: "Last touch",   sortDirection: "asc" },
  "done":      { layout: "list",   label: "Job done",            filter: `{Pipeline stage}='✅ Job done'`,                                           sortField: "Completion date", sortDirection: "desc" },
};

const JOB_FIELDS_FOR_VIEW = [
  "Job ID", "Client", "Service type", "Property snapshot", "Quote",
  "Quote amount", "Quote date", "Booking date", "Completion date",
  "Lead status", "Concerns", "Lead origin", "Pipeline stage",
  "Last touch", "Notes from Luke", "Outreach attempts",
  "Customer responded", "Create date", "Conversation log",
];

async function handleData(req, res) {
  const viewKey = (req.query?.view || "2026").toString();
  const view = VIEW_CONFIGS[viewKey];
  if (!view) {
    return res.status(400).json({ error: `unknown view '${viewKey}'. Try one of: ${Object.keys(VIEW_CONFIGS).join(", ")}` });
  }

  const params = { "fields[]": JOB_FIELDS_FOR_VIEW };
  if (view.filter) params.filterByFormula = view.filter;
  if (view.sortField) {
    params["sort[0][field]"]     = view.sortField;
    params["sort[0][direction]"] = view.sortDirection || "asc";
  }
  const rawJobs = await airtableGet(AT_JOBS, params);

  // Resolve linked Client names + phones in one batched call
  const clientIds = new Set();
  for (const j of rawJobs) {
    const linked = j.fields["Client"] || [];
    if (linked[0]) clientIds.add(linked[0]);
  }
  const clientMap = {};
  if (clientIds.size) {
    const ids = [...clientIds];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const formula = `OR(${chunk.map(id => `RECORD_ID()='${id}'`).join(",")})`;
      const clients = await airtableGet(AT_CLIENTS, {
        filterByFormula: formula,
        "fields[]": ["Name", "Full name", "Phone", "Email", "Address", "Source"],
      });
      for (const c of clients) {
        clientMap[c.id] = {
          name:    c.fields?.["Full name"] || c.fields?.["Name"] || "(unnamed)",
          firstName: c.fields?.["Name"] || "",
          fullName: c.fields?.["Full name"] || "",
          phone:   c.fields?.["Phone"]   || "",
          email:   c.fields?.["Email"]   || "",
          address: c.fields?.["Address"] || "",
          source:  c.fields?.["Source"]  || "",
        };
      }
    }
  }

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
      clientFirstName:  client?.firstName      || "",
      clientFullName:   client?.fullName       || "",
      clientPhone:      client?.phone          || "",
      clientEmail:      client?.email          || "",
      clientAddress:    client?.address        || "",
      clientSource:     client?.source         || "",
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
      conversationLog:  f["Conversation log"]  || "",
    };
  });

  let payload;
  if (view.layout === "kanban") {
    const buckets = {};
    for (const stage of KANBAN_STAGES) buckets[stage] = [];
    const other = [];
    for (const j of jobs) {
      if (buckets[j.pipelineStage]) buckets[j.pipelineStage].push(j);
      else other.push(j);
    }
    const sortBucket = arr => arr.sort((a, b) => {
      const ax = a.createDate || a.quoteDate || "";
      const bx = b.createDate || b.quoteDate || "";
      return ax < bx ? 1 : ax > bx ? -1 : 0;
    });
    for (const stage of KANBAN_STAGES) sortBucket(buckets[stage]);
    sortBucket(other);

    const columns = KANBAN_STAGES.map(stage => ({
      stage,
      count: buckets[stage].length,
      jobs:  buckets[stage],
    }));
    if (other.length > 0) {
      columns.push({ stage: "(no stage)", count: other.length, jobs: other });
    }
    payload = { layout: "kanban", viewKey, viewLabel: view.label, columns };
  } else {
    payload = { layout: "list", viewKey, viewLabel: view.label, sortField: view.sortField, jobs };
  }

  return res.status(200).json({ generatedAt: new Date().toISOString(), ...payload });
}

// ═══════════════════════════════════════════════════════════════════════
// Action: update — PATCH a Job from the Kanban edit modal
// ═══════════════════════════════════════════════════════════════════════

const EDITABLE_FIELDS = new Set([
  "Pipeline stage", "Lead status", "Booking date", "Quote amount", "Quote date",
  "Last touch", "Outreach attempts", "Notes from Luke", "Customer responded",
  "Completion date", "Final paid", "Concerns", "Service type", "Lead origin",
  "Property snapshot", "Quote",
]);

const EDITABLE_CLIENT_FIELDS = new Set([
  "Name", "Full name", "Phone", "Email", "Address", "Source",
]);

async function handleUpdate(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { jobId, fields } = req.body || {};
  if (!jobId || !/^rec[A-Za-z0-9]{14}$/.test(jobId)) {
    return res.status(400).json({ error: "invalid jobId" });
  }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return res.status(400).json({ error: "fields must be an object" });
  }

  const incoming = Object.keys(fields);
  const rejected = incoming.filter(k => !EDITABLE_FIELDS.has(k));
  if (rejected.length) {
    return res.status(400).json({ error: `not editable from this UI: ${rejected.join(", ")}` });
  }

  const out = { ...fields };
  if (out["Pipeline stage"] && !("Lead status" in out)) {
    const mapped = STAGE_TO_LEAD_STATUS[out["Pipeline stage"]];
    if (mapped !== undefined) out["Lead status"] = mapped;
  }
  if (out["Pipeline stage"] === "📞 Contacted" && !out["Last touch"]) {
    out["Last touch"] = todayISO();
  }
  if (out["Pipeline stage"] === "✅ Job done" && !out["Completion date"]) {
    out["Completion date"] = todayISO();
  }

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
    console.error("[ops/update] Airtable error:", data.error, "fields:", cleaned);
    return res.status(400).json({ error: data.error.message || data.error.type, fieldsSent: cleaned });
  }
  return res.status(200).json({ ok: true, jobId: data.id, fields: data.fields });
}

// ═══════════════════════════════════════════════════════════════════════
// Action: update-client — PATCH a Client from the Kanban edit modal
// ═══════════════════════════════════════════════════════════════════════

async function handleUpdateClient(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { clientId, fields } = req.body || {};
  if (!clientId || !/^rec[A-Za-z0-9]{14}$/.test(clientId)) {
    return res.status(400).json({ error: "invalid clientId" });
  }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return res.status(400).json({ error: "fields must be an object" });
  }

  const incoming = Object.keys(fields);
  const rejected = incoming.filter(k => !EDITABLE_CLIENT_FIELDS.has(k));
  if (rejected.length) {
    return res.status(400).json({ error: `not editable from this UI: ${rejected.join(", ")}` });
  }

  const cleaned = {};
  for (const [k, v] of Object.entries(fields)) {
    cleaned[k] = v === "" || v === undefined ? null : v;
  }

  const r = await fetch(`${airtableUrl(AT_CLIENTS)}/${clientId}`, {
    method: "PATCH",
    headers: airtableHeaders(),
    body: JSON.stringify({ fields: cleaned, typecast: true }),
  });
  const data = await r.json();
  if (data.error) {
    console.error("[ops/update-client] Airtable error:", data.error, "fields:", cleaned);
    return res.status(400).json({ error: data.error.message || data.error.type, fieldsSent: cleaned });
  }
  return res.status(200).json({ ok: true, clientId: data.id, fields: data.fields });
}

// ═══════════════════════════════════════════════════════════════════════
// Action: search-clients — typeahead lookup for the new-job modal
// ═══════════════════════════════════════════════════════════════════════

async function handleSearchClients(req, res) {
  const query = (req.query?.query || "").toString().trim();
  const limit = Math.min(parseInt(req.query?.limit || "20", 10) || 20, 50);
  const fieldsList = ["Name", "Full name", "Phone", "Email", "Address", "Source"];

  let records;
  if (!query) {
    // No query → return most recent clients (by First contacted desc)
    records = await airtableGet(AT_CLIENTS, {
      maxRecords: limit,
      "fields[]": fieldsList,
      "sort[0][field]": "First contacted",
      "sort[0][direction]": "desc",
    });
  } else {
    const safe = query.replace(/'/g, "\\'");
    const digits = query.replace(/\D/g, "");
    const lower = safe.toLowerCase();
    const clauses = [
      `SEARCH(LOWER('${lower}'), LOWER({Name}&''))`,
      `SEARCH(LOWER('${lower}'), LOWER({Full name}&''))`,
      `SEARCH(LOWER('${lower}'), LOWER({Email}&''))`,
      `SEARCH(LOWER('${lower}'), LOWER({Address}&''))`,
    ];
    if (digits) clauses.push(`SEARCH('${digits}', REGEX_REPLACE({Phone}&'', '\\\\D', ''))`);
    records = await airtableGet(AT_CLIENTS, {
      filterByFormula: `OR(${clauses.join(",")})`,
      maxRecords: limit,
      "fields[]": fieldsList,
    });
  }

  return res.status(200).json({
    matches: records.map(r => ({
      id: r.id,
      name:    r.fields["Full name"] || r.fields["Name"] || "(unnamed)",
      phone:   r.fields["Phone"]   || "",
      email:   r.fields["Email"]   || "",
      address: r.fields["Address"] || "",
      source:  r.fields["Source"]  || "",
    })),
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Action: create-job — create a new Job for an existing Client
// ═══════════════════════════════════════════════════════════════════════

async function handleCreateJob(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { clientId, fields = {} } = req.body || {};
  if (!clientId || !/^rec[A-Za-z0-9]{14}$/.test(clientId)) {
    return res.status(400).json({ error: "invalid clientId" });
  }

  const serviceType = (fields["Service type"] || "").trim();
  if (!serviceType) return res.status(400).json({ error: "Service type required" });

  const pipelineStage = fields["Pipeline stage"] || "🆕 New lead";

  // Derive a Job ID label from the client's first name + service type if not provided
  let jobLabel = fields["Job ID"];
  if (!jobLabel) {
    try {
      const cr = await fetch(`${airtableUrl(AT_CLIENTS)}/${clientId}`, { headers: airtableHeaders() });
      const cd = await cr.json();
      const first = (cd?.fields?.["Name"] || cd?.fields?.["Full name"] || "").split(/\s+/)[0];
      if (first) jobLabel = `${first} – ${serviceType}`;
    } catch {}
  }

  const out = {
    "Client":         [clientId],
    "Service type":   serviceType,
    "Pipeline stage": pipelineStage,
    "Create date":    todayISO(),
  };
  if (jobLabel)                          out["Job ID"]            = jobLabel;
  if (fields["Lead origin"])             out["Lead origin"]       = fields["Lead origin"];
  if (fields["Property snapshot"])       out["Property snapshot"] = fields["Property snapshot"];
  if (fields["Quote"])                   out["Quote"]             = fields["Quote"];
  if (fields["Quote amount"] != null && fields["Quote amount"] !== "") {
    out["Quote amount"] = Number(fields["Quote amount"]);
  }
  if (fields["Quote date"])              out["Quote date"]        = fields["Quote date"];
  if (fields["Booking date"])            out["Booking date"]      = fields["Booking date"];
  if (fields["Notes from Luke"])         out["Notes from Luke"]   = fields["Notes from Luke"];
  if (fields["Concerns"])                out["Concerns"]          = fields["Concerns"];

  // Auto-stamp companion fields for the chosen stage
  const mapped = STAGE_TO_LEAD_STATUS[pipelineStage];
  if (mapped !== undefined && mapped !== null) out["Lead status"] = mapped;
  if (pipelineStage === "💬 Quoted" && !out["Quote date"]) out["Quote date"] = todayISO();
  if (pipelineStage === "📞 Contacted" && !out["Last touch"]) out["Last touch"] = todayISO();
  if (pipelineStage === "✅ Job done" && !out["Completion date"]) out["Completion date"] = todayISO();

  const data = await airtablePost(AT_JOBS, out);
  return res.status(200).json({ ok: true, jobId: data.id, fields: data.fields });
}

// ═══════════════════════════════════════════════════════════════════════
// Action: backfill-2025-to-done — one-shot migration to flip every Job
// with a Create date in 2025 or earlier to Pipeline stage = ✅ Job done.
//
//   POST /api/ops?action=backfill-2025-to-done&dryRun=1   → count only
//   POST /api/ops?action=backfill-2025-to-done            → actually update
//
// Skips jobs already in Job done / Lost so the operation is idempotent and
// preserves anything Luke already marked. Auto-fills Lead status=Completed
// and a Completion date (uses Create date as proxy when Completion is blank
// so the historical sort order makes sense).
// ═══════════════════════════════════════════════════════════════════════

async function handleBackfillToDone(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const dryRun = req.query?.dryRun === "true" || req.query?.dryRun === "1";
  const cutoff = "2026-01-01"; // anything before this is a 2025-or-earlier job

  // Two ways a Job qualifies as "2025 or earlier":
  //   1. Create date < 2026-01-01  (the obvious case)
  //   2. Job ID encodes a year < 2026, e.g. "2024-062 Sue McElhaney" — Luke's
  //      legacy records from imports often have a blank Create date but the
  //      job-ID prefix is reliable.
  // Either path makes it a target; we still exclude already-Done and Lost.
  const formula = `AND(
    {Pipeline stage}!='✅ Job done',
    {Pipeline stage}!='❌ Lost',
    OR(
      IS_BEFORE({Create date}, '${cutoff}'),
      AND(
        REGEX_MATCH({Job ID}&'', '^20[0-2][0-9]-'),
        VALUE(LEFT({Job ID}&'', 4)) < 2026
      )
    )
  )`.replace(/\s+/g, " ");

  const records = await airtableGet(AT_JOBS, {
    filterByFormula: formula,
    "fields[]": ["Job ID", "Pipeline stage", "Create date", "Lead status", "Completion date"],
  });

  // For each record, figure out the best Completion-date proxy
  function completionProxy(r) {
    if (r.fields["Completion date"]) return null; // already has one — leave alone
    if (r.fields["Create date"])     return r.fields["Create date"];
    const jobId = r.fields["Job ID"] || "";
    const m = jobId.match(/^(20[0-2][0-9])-/);
    if (m) return `${m[1]}-12-31`; // end of the year encoded in the Job ID
    return todayISO();
  }

  if (dryRun) {
    // Bucket by why each record qualifies so Luke can sanity-check
    const buckets = { byCreateDate: 0, byJobIdYear: 0 };
    for (const r of records) {
      if (r.fields["Create date"] && r.fields["Create date"] < cutoff) buckets.byCreateDate++;
      else buckets.byJobIdYear++;
    }
    return res.status(200).json({
      ok: true,
      dryRun: true,
      wouldUpdate: records.length,
      bucket: buckets,
      sample: records.slice(0, 20).map(r => ({
        id: r.id,
        jobId: r.fields["Job ID"] || "",
        currentStage: r.fields["Pipeline stage"] || "(none)",
        createDate: r.fields["Create date"] || "",
        completionDate: r.fields["Completion date"] || "",
        proxyCompletion: completionProxy(r),
      })),
    });
  }

  // Real run: PATCH in batches of 10 (Airtable's limit per request)
  let updated = 0;
  const errors = [];
  for (let i = 0; i < records.length; i += 10) {
    const chunk = records.slice(i, i + 10);
    const body = {
      records: chunk.map(r => {
        const proxy = completionProxy(r);
        return {
          id: r.id,
          fields: {
            "Pipeline stage": "✅ Job done",
            "Lead status":    "Completed",
            ...(proxy ? { "Completion date": proxy } : {}),
          },
        };
      }),
      typecast: true,
    };
    const r = await fetch(airtableUrl(AT_JOBS), {
      method: "PATCH",
      headers: airtableHeaders(),
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (data.error) {
      console.error(`[ops/backfill-to-done] chunk ${i} error:`, data.error);
      errors.push({ chunk: i, error: data.error.message || data.error.type });
    } else {
      updated += chunk.length;
    }
  }
  return res.status(200).json({
    ok: errors.length === 0,
    updated,
    skipped: records.length - updated,
    errorsCount: errors.length,
    errors,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Action: setup-tracking-fields — one-shot: ensure the "Funnel events"
// table has Country (singleLineText) and Internal (checkbox) fields so
// the dashboard can filter out Luke's test traffic.
//
//   POST /api/ops?action=setup-tracking-fields
//
// Idempotent — checks existing fields first and only creates what's
// missing. Requires the PAT to have schema.bases:write scope.
// ═══════════════════════════════════════════════════════════════════════

async function handleSetupTrackingFields(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // 1. Find the Funnel events table ID via the Meta API
  const tablesRes = await fetch(`https://api.airtable.com/v0/meta/bases/${AT_BASE}/tables`, {
    headers: { Authorization: `Bearer ${AT_KEY}` },
  });
  const tablesData = await tablesRes.json();
  if (tablesData.error) {
    return res.status(400).json({ error: `Meta API: ${tablesData.error.message || tablesData.error.type}` });
  }
  const funnel = (tablesData.tables || []).find(t => t.name === AT_FUNNEL);
  if (!funnel) return res.status(404).json({ error: `Table "${AT_FUNNEL}" not found in base` });

  const existing = new Set((funnel.fields || []).map(f => f.name));
  const created = [];
  const skipped = [];
  const errors = [];

  // 2. Create Country (singleLineText) if missing
  if (existing.has("Country")) {
    skipped.push("Country");
  } else {
    const r = await fetch(`https://api.airtable.com/v0/meta/bases/${AT_BASE}/tables/${funnel.id}/fields`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AT_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Country", type: "singleLineText", description: "ISO-2 country code from Vercel x-vercel-ip-country (e.g. US, ES, GB). Used to filter out internal/test traffic from dashboard KPIs." }),
    });
    const d = await r.json();
    if (d.error) errors.push({ field: "Country", error: d.error.message || d.error.type });
    else created.push("Country");
  }

  // 3. Create Internal (checkbox) if missing
  if (existing.has("Internal")) {
    skipped.push("Internal");
  } else {
    const r = await fetch(`https://api.airtable.com/v0/meta/bases/${AT_BASE}/tables/${funnel.id}/fields`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AT_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Internal", type: "checkbox", options: { color: "redBright", icon: "check" }, description: "Set when the visitor's device opted out via the dashboard 'Mark internal' button. Filtered out of KPIs by default." }),
    });
    const d = await r.json();
    if (d.error) errors.push({ field: "Internal", error: d.error.message || d.error.type });
    else created.push("Internal");
  }

  return res.status(200).json({
    ok: errors.length === 0,
    tableId: funnel.id,
    created,
    skipped,
    errors,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Action: event-origins — diagnostic. Groups Funnel events over the last
// N days by country, UTM source, referrer domain, and internal flag so
// Luke can audit where his "775 page views" really came from.
//
//   GET /api/ops?action=event-origins&days=7&type=Page%20view
// ═══════════════════════════════════════════════════════════════════════

async function handleEventOrigins(req, res) {
  const days = Math.max(1, Math.min(180, parseInt(req.query?.days || "7", 10) || 7));
  const evType = (req.query?.type || "Page view").toString();
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();

  const safeType = evType.replace(/'/g, "\\'");
  const formula = `AND({Event type}='${safeType}', IS_AFTER({Timestamp}, DATETIME_PARSE('${cutoff}')))`;
  const records = await airtableGet(AT_FUNNEL, {
    filterByFormula: formula,
    "fields[]": ["Timestamp", "Event type", "UTM source", "UTM campaign", "Referrer", "Landing URL", "Session ID", "Country", "Internal", "Notes"],
  });

  const byCountry  = {};
  const bySource   = {};
  const byReferrer = {};
  const sessionsBySource   = {};
  const sessionsByReferrer = {};
  let internalTrue = 0;
  let countryBlank = 0;
  const sessions = new Set();

  for (const r of records) {
    const f = r.fields || {};
    const country = (f["Country"] || "").trim();
    const cKey    = country || "(blank — pre-fix data)";
    const source  = f["UTM source"] || "(no UTM source)";
    const ref     = ((f["Referrer"] || "").replace(/^https?:\/\//, "").split(/[/?#]/)[0]) || "(no referrer)";
    const sid     = f["Session ID"] || "";

    byCountry[cKey]   = (byCountry[cKey]   || 0) + 1;
    bySource[source]  = (bySource[source]  || 0) + 1;
    byReferrer[ref]   = (byReferrer[ref]   || 0) + 1;
    if (f["Internal"] === true) internalTrue++;
    if (!country) countryBlank++;
    if (sid) sessions.add(sid);

    if (sid) {
      (sessionsBySource[source]   ||= new Set()).add(sid);
      (sessionsByReferrer[ref]    ||= new Set()).add(sid);
    }
  }

  const sortTopCounts = (obj, n = 20) =>
    Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ key: k, count: v }));

  const sortTopSessions = (obj, hitsObj, n = 20) =>
    Object.entries(obj)
      .map(([k, s]) => ({ key: k, sessions: s.size, hits: hitsObj[k] || 0, hitsPerSession: +(((hitsObj[k] || 0) / s.size)).toFixed(2) }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, n);

  return res.status(200).json({
    days,
    eventType: evType,
    total: records.length,
    uniqueSessions: sessions.size,
    avgHitsPerSession: +((records.length / Math.max(1, sessions.size)).toFixed(2)),
    internalFlagged: internalTrue,
    countryBlank,
    byCountry:  sortTopCounts(byCountry),
    bySource:   sortTopCounts(bySource),
    byReferrer: sortTopCounts(byReferrer, 25),
    sessionsBySource:   sortTopSessions(sessionsBySource,   bySource),
    sessionsByReferrer: sortTopSessions(sessionsByReferrer, byReferrer, 25),
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Action: sessions-list — list unique Funnel-event sessions with their
// attributes (source, referrer, page count, country, etc.) so Luke can
// identify his own test sessions and purge them.
//
//   GET /api/ops?action=sessions-list&days=7&minHits=2
//
// Sorted by hits desc by default — likely test sessions float to the top
// (Luke clicking around the site = lots of internal-nav page views in
// one session, while real ad-click visitors view ~1.5 pages).
// ═══════════════════════════════════════════════════════════════════════

async function handleSessionsList(req, res) {
  const days     = Math.max(1, Math.min(180, parseInt(req.query?.days || "7", 10) || 7));
  const minHits  = Math.max(1, parseInt(req.query?.minHits || "1", 10) || 1);
  const limit    = Math.max(1, Math.min(500, parseInt(req.query?.limit || "200", 10) || 200));
  const cutoff   = new Date(Date.now() - days * 86400 * 1000).toISOString();

  const records = await airtableGet(AT_FUNNEL, {
    filterByFormula: `IS_AFTER({Timestamp}, DATETIME_PARSE('${cutoff}'))`,
    "fields[]": ["Timestamp", "Event type", "UTM source", "UTM campaign", "Referrer", "Landing URL", "Session ID", "Country", "Internal"],
  });

  const sessions = new Map(); // sid -> { ...stats }
  let noSessionId = 0;
  for (const r of records) {
    const f = r.fields || {};
    const sid = f["Session ID"];
    if (!sid) { noSessionId++; continue; }
    let s = sessions.get(sid);
    if (!s) {
      const ref = ((f["Referrer"] || "").replace(/^https?:\/\//, "").split(/[/?#]/)[0]) || "";
      s = {
        sessionId:  sid,
        firstSeen:  f["Timestamp"] || null,
        lastSeen:   f["Timestamp"] || null,
        source:     f["UTM source"] || "",
        campaign:   f["UTM campaign"] || "",
        referrer:   ref,
        landingUrl: (f["Landing URL"] || "").slice(0, 120),
        country:    f["Country"] || "",
        internal:   f["Internal"] === true,
        hits:       0,
        eventTypes: {},
        airtableIds: [], // record IDs so the delete endpoint can wipe them
      };
      sessions.set(sid, s);
    }
    s.hits++;
    s.eventTypes[f["Event type"] || "?"] = (s.eventTypes[f["Event type"] || "?"] || 0) + 1;
    s.airtableIds.push(r.id);
    if (f["Timestamp"]) {
      if (f["Timestamp"] < s.firstSeen) s.firstSeen = f["Timestamp"];
      if (f["Timestamp"] > s.lastSeen)  s.lastSeen  = f["Timestamp"];
    }
    // Capture any non-empty values across the session in case the first
    // record was missing them (shouldn't happen since first-touch sticks,
    // but defensive)
    if (!s.source   && f["UTM source"])   s.source   = f["UTM source"];
    if (!s.referrer && f["Referrer"])     s.referrer = ((f["Referrer"] || "").replace(/^https?:\/\//, "").split(/[/?#]/)[0]) || "";
    if (!s.country  && f["Country"])      s.country  = f["Country"];
    if (f["Internal"] === true)           s.internal = true;
  }

  const list = [...sessions.values()]
    .filter(s => s.hits >= minHits)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map(s => ({ ...s, airtableIds: undefined, eventCount: s.airtableIds.length }));

  return res.status(200).json({
    days,
    totalSessions: sessions.size,
    eventsWithoutSessionId: noSessionId,
    returned: list.length,
    sessions: list,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Action: delete-sessions — bulk-delete all funnel events that belong to
// the given Session IDs. Use this to purge Luke's test traffic from
// historic data after sessions-list helps him pick the targets.
//
//   POST /api/ops?action=delete-sessions
//   body: { sessionIds: ["abc-1234...", "..."], days: 30 }
//
// `days` (optional, default 30) scopes the search window — bigger numbers
// fetch more events but cost more Airtable round-trips.
// ═══════════════════════════════════════════════════════════════════════

async function handleDeleteSessions(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { sessionIds, days = 30, dryRun = false } = req.body || {};
  if (!Array.isArray(sessionIds) || !sessionIds.length) {
    return res.status(400).json({ error: "sessionIds must be a non-empty array" });
  }
  const sidSet = new Set(sessionIds);
  const cutoff = new Date(Date.now() - Math.max(1, Math.min(180, days)) * 86400 * 1000).toISOString();

  // Fetch funnel events in the window then filter client-side — Airtable
  // formulas with long OR(...) lists get unwieldy.
  const records = await airtableGet(AT_FUNNEL, {
    filterByFormula: `IS_AFTER({Timestamp}, DATETIME_PARSE('${cutoff}'))`,
    "fields[]": ["Session ID", "Timestamp", "Event type"],
  });
  const toDelete = records.filter(r => sidSet.has(r.fields?.["Session ID"]));

  if (dryRun) {
    return res.status(200).json({
      ok: true,
      dryRun: true,
      sessionIdsRequested: sessionIds.length,
      eventsFound: toDelete.length,
      sampleEvents: toDelete.slice(0, 10).map(r => ({
        id: r.id,
        sessionId: r.fields["Session ID"],
        eventType: r.fields["Event type"],
        timestamp: r.fields["Timestamp"],
      })),
    });
  }

  // Airtable delete supports up to 10 record IDs per request via the
  // records[] query-param batch endpoint.
  let deleted = 0;
  const errors = [];
  for (let i = 0; i < toDelete.length; i += 10) {
    const chunk = toDelete.slice(i, i + 10);
    const qs = new URLSearchParams();
    chunk.forEach(r => qs.append("records[]", r.id));
    const r = await fetch(`${airtableUrl(AT_FUNNEL)}?${qs.toString()}`, {
      method: "DELETE",
      headers: airtableHeaders(),
    });
    const data = await r.json();
    if (data.error) {
      console.error("[ops/delete-sessions] chunk error:", data.error);
      errors.push({ chunk: i, error: data.error.message || data.error.type });
    } else {
      deleted += (data.records || []).length;
    }
  }
  return res.status(200).json({
    ok: errors.length === 0,
    deleted,
    eventsFound: toDelete.length,
    sessionIdsRequested: sessionIds.length,
    errorsCount: errors.length,
    errors,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Action: telegram-audit — every notify* call writes a "Telegram alert"
// funnel event with the outcome. This endpoint lets Luke verify what
// actually pinged him over a window vs what was attempted.
//
//   GET /api/ops?action=telegram-audit&days=7
// ═══════════════════════════════════════════════════════════════════════

async function handleTelegramAudit(req, res) {
  const days = Math.max(1, Math.min(180, parseInt(req.query?.days || "7", 10) || 7));
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();

  const records = await airtableGet(AT_FUNNEL, {
    filterByFormula: `AND({Event type}='Telegram alert', IS_AFTER({Timestamp}, DATETIME_PARSE('${cutoff}')))`,
    "fields[]": ["Timestamp", "Notes", "Session ID", "UTM source"],
    "sort[0][field]": "Timestamp",
    "sort[0][direction]": "desc",
  });

  // Parse "[type] summary → status" out of the Notes field
  const parsed = records.map(r => {
    const notes = r.fields["Notes"] || "";
    const m = notes.match(/^\[([^\]]+)\]\s*(.*?)\s*→\s*(ok|FAILED)(?:\s*—\s*(.*))?$/);
    return {
      id: r.id,
      timestamp: r.fields["Timestamp"] || null,
      sessionId: r.fields["Session ID"] || "",
      utmSource: r.fields["UTM source"] || "",
      type:      m ? m[1] : "?",
      summary:   m ? m[2] : notes,
      status:    m ? m[3] : "?",
      error:     m && m[4] ? m[4] : null,
      raw:       notes,
    };
  });

  // Summary stats
  const byType = {};
  const byStatus = { ok: 0, FAILED: 0, "?": 0 };
  for (const p of parsed) {
    byType[p.type] ||= { ok: 0, FAILED: 0, "?": 0 };
    byType[p.type][p.status] = (byType[p.type][p.status] || 0) + 1;
    byStatus[p.status] = (byStatus[p.status] || 0) + 1;
  }

  return res.status(200).json({
    days,
    totalAlerts: parsed.length,
    successes:   byStatus.ok,
    failures:    byStatus.FAILED,
    unparsed:    byStatus["?"],
    byType,
    alerts:      parsed.slice(0, 100),
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Action: backfill-attribution — fix the historic "everything is Website"
// bug. Reads each Client's UTM source / Referrer / fbclid and rewrites
// Client.Source to the correct channel. Then propagates the new Source to
// every linked Job's "Lead origin" so the dashboard's channel filter works
// for past data too.
//
//   POST /api/ops?action=backfill-attribution&dryRun=1   → preview counts
//   POST /api/ops?action=backfill-attribution            → execute
//
// Skips records where Source / Lead origin is already non-Website (so
// manually-corrected records and Angi-ingested rows stay untouched).
// ═══════════════════════════════════════════════════════════════════════

// Mirror of estimate.js / chat.js — keep in sync.
function deriveOriginFromAttribution(attr) {
  if (!attr) return "Website";
  const utm = (attr.utm_source || "").toString().toLowerCase().trim();
  const ref = (attr.referrer   || "").toString().toLowerCase();
  if (utm === "meta" || utm === "facebook" || utm === "instagram") return "Meta ads";
  if (attr.fbclid) return "Meta ads";
  if (/(facebook|fb\.com|instagram)/.test(ref)) return "Meta ads";
  if (utm === "google") return "Google";
  if (attr.gclid) return "Google";
  if (/^https?:\/\/(www\.)?google\./.test(ref) || /google\.com/.test(ref)) return "Google";
  if (utm === "yelp") return "Yelp";
  if (/yelp\.com/.test(ref)) return "Yelp";
  if (utm === "angi") return "Angi";
  if (/(angi|homeadvisor)\.com/.test(ref)) return "Angi";
  if (attr.msclkid) return "Bing";
  return "Website";
}

async function handleBackfillAttribution(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const dryRun = req.query?.dryRun === "true" || req.query?.dryRun === "1";

  // Pull every Client with attribution data (UTM source / Referrer / fbclid)
  // AND Source = "Website" (the wrong default).
  const clients = await airtableGet(AT_CLIENTS, {
    filterByFormula: `AND({Source}='Website', OR(NOT({UTM source}=BLANK()), NOT({Referrer}=BLANK()), NOT({Meta fbclid}=BLANK())))`,
    "fields[]": ["Name", "Full name", "Source", "UTM source", "Referrer", "Meta fbclid", "Jobs"],
  });

  const clientPatches = [];
  const jobIdsToUpdate = new Map(); // jobId -> newOrigin
  const stats = { meta: 0, yelp: 0, google: 0, angi: 0, bing: 0, website: 0 };

  for (const c of clients) {
    const derived = deriveOriginFromAttribution({
      utm_source: c.fields["UTM source"] || "",
      referrer:   c.fields["Referrer"]   || "",
      fbclid:     c.fields["Meta fbclid"] || "",
    });
    if (derived === "Website") continue; // nothing to change
    clientPatches.push({ id: c.id, derived });
    stats[derived.toLowerCase().split(" ")[0]] = (stats[derived.toLowerCase().split(" ")[0]] || 0) + 1;
    // Propagate to all of this client's Jobs
    const jobs = c.fields["Jobs"] || [];
    for (const jid of jobs) jobIdsToUpdate.set(jid, derived);
  }

  if (dryRun) {
    return res.status(200).json({
      ok: true,
      dryRun: true,
      clientsToUpdate: clientPatches.length,
      jobsToUpdate:    jobIdsToUpdate.size,
      bucket:          stats,
      sample:          clientPatches.slice(0, 20).map(p => ({
        clientId: p.id,
        newSource: p.derived,
      })),
    });
  }

  // Patch Clients in batches of 10 (Airtable cap)
  let clientsUpdated = 0;
  const errors = [];
  for (let i = 0; i < clientPatches.length; i += 10) {
    const chunk = clientPatches.slice(i, i + 10);
    const r = await fetch(airtableUrl(AT_CLIENTS), {
      method: "PATCH",
      headers: airtableHeaders(),
      body: JSON.stringify({
        records: chunk.map(p => ({ id: p.id, fields: { "Source": p.derived } })),
        typecast: true,
      }),
    });
    const data = await r.json();
    if (data.error) errors.push({ section: "clients", chunk: i, error: data.error.message });
    else clientsUpdated += chunk.length;
  }

  // Patch Jobs in batches of 10
  const jobsArr = [...jobIdsToUpdate.entries()];
  let jobsUpdated = 0;
  for (let i = 0; i < jobsArr.length; i += 10) {
    const chunk = jobsArr.slice(i, i + 10);
    const r = await fetch(airtableUrl(AT_JOBS), {
      method: "PATCH",
      headers: airtableHeaders(),
      body: JSON.stringify({
        records: chunk.map(([jid, origin]) => ({ id: jid, fields: { "Lead origin": origin } })),
        typecast: true,
      }),
    });
    const data = await r.json();
    if (data.error) errors.push({ section: "jobs", chunk: i, error: data.error.message });
    else jobsUpdated += chunk.length;
  }

  return res.status(200).json({
    ok: errors.length === 0,
    clientsUpdated,
    jobsUpdated,
    bucket: stats,
    errorsCount: errors.length,
    errors,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Action: log-outreach — one-tap "I tried contacting them" button on
// every Kanban card. Reuses the same tool logic the chat agent uses, so
// the side effects are identical: increment Outreach attempts, set
// Last touch=today, append a dated note, bump Pipeline stage to
// 📞 Contacted (only if currently New lead / Quoted / Contacted / blank),
// log a Funnel event.
//
//   POST /api/ops?action=log-outreach   body: { jobId, note? }
// ═══════════════════════════════════════════════════════════════════════

async function handleLogOutreach(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { jobId, note } = req.body || {};
  if (!jobId || !/^rec[A-Za-z0-9]{14}$/.test(jobId)) {
    return res.status(400).json({ error: "invalid jobId" });
  }
  // Kanban-card "Tried" button: only bump stage when leaving Quoted.
  //   New lead + Tried   → stays in New lead (pre-quote clarification call)
  //   Quoted + Tried     → moves to Contacted ("I'm now following up on quote")
  //   Contacted + Tried  → stays in Contacted (already in the follow-up loop)
  const result = await logOutreach({ jobId, note, bumpFrom: ["💬 Quoted"] });
  if (result.error) return res.status(400).json(result);
  return res.status(200).json({ ok: true, ...result });
}

// ═══════════════════════════════════════════════════════════════════════
// Action: draft-messages — generate 3 first-text-message drafts for a
// New-lead Job, in Luke's voice, based on the Job's context (client,
// services, conversation log if any, attribution).
//
//   POST /api/ops?action=draft-messages   body: { jobId }
//   → { drafts: [ { label, text }, ... ] }
//
// Only intended for use on Jobs in "🆕 New lead" stage — the UI gates the
// button so this endpoint is rarely (if ever) called on later stages.
// ═══════════════════════════════════════════════════════════════════════

const DRAFT_VOICE_PROMPT = `You are drafting outbound text messages for Luke Perreault, owner of LP Pressure Washing (Bucks/Montgomery/Lehigh counties, PA). This is the FIRST text to a new lead. Luke prefers calling first but sometimes needs to text.

VOICE RULES (non-negotiable):
- Warm, casual, neighborly, confident. Solo-operator vibe — not corporate.
- NO emojis, NO markdown, NO bullet points, NO bold/italic in the message text. Plain text only.
- Day-of-week always paired with dates ("Friday, May 22nd" not "May 22nd").
- Single final dollar amount per line. Never reveal internal math or pre-discount totals.
- If first contact / formal: open with "Hi [Name], This is Luke Perreault from LP Pressure Washing." or "This is Luke from LP Pressure Washing."
- Reference how they got in touch when relevant ("Glad we could speak earlier today", "Thanks for clicking on our ad", "I saw you left a voicemail", "I got your contact info from Angi").
- Close: "Let me know if you have any questions," then sign "Luke" or "Luke / LP Pressure Washing".

EXAMPLES of Luke's voice (study these carefully — they are the gold standard for tone, structure, and word choice):

EXAMPLE 1 (full quote with multiple services, Memorial Day Special):
Hi Mike, This is Luke from LP Pressure Washing. Glad we could speak earlier today.

Here is the estimate below for the house and windows:

House wash: which includes everything from the outsides of the gutters, soffits, siding, windows, doors we can do for $570

Windows (exterior): $182 (Memorial Day Special 30% off when paired with house wash)

Total: $752

We use a soft wash system that's low pressure cleaning which is much safer on your siding and landscaping than traditional pressure washing. We pair it with a safe bleach-based soap that kills mold, mildew, and algae without damaging your plants or home (wide soap to water ratio). We make sure to water down any plants before and after to protect them.

I have availability on June 5th or 9th. If you really need it sooner, I could also fit you in on May 25th (Memorial Day). Let me know what works best for you.

If you'd like anything else done, walkway, concrete around the pool, etc. just let me know and I can give you an estimate.

Let me know if you have any questions.

Luke / LP Pressure Washing

EXAMPLE 2 (small partial-wash quote):
Hi Anthony, This is Luke from LP Pressure Washing. Nice talking with you earlier.

For the 2ish sides of your house, I can get that soft washed for $210. We use the soft wash system that's low pressure cleaning which is much safer on your siding and landscaping than traditional pressure washing.

The windows get washed during the process but they don't dry perfectly spotless as if professionally cleaned. But they look great.

We can do it the 28th or June 2nd.

Let me know if you have any questions.

EXAMPLE 3 (pool patio + fence with caveat about pool):
Hi Dominic, This is Luke from LP Pressure Wash. Nice talking with you earlier.

For your pool patio and white fence in Perkasie, I can get that done for $360 total. The patio is $210 and the fence around it is $150.

Quick heads up on the pool — we'll do our best to spray away from it and keep the water and small sand particles out, but it's typically pretty inevitable that some gets in. Just wanted to set that expectation up front.

I could do it the 5th or 9th of June. If you wanted it before we could fit it in if necessary.

Let me know if you have any questions.

EXAMPLE 4 (intro after ad click — quote coming, asking for timeline):
Hi Susan,

This is Luke Perreault from LP Pressure Washing. Thanks for clicking on our ad.

I see you're interested in the house and the inside of the backyard wooden fence.

I'll take a look at it now and send over an exact estimate. When are you wanting this done ideally?

EXAMPLE 5 (voicemail follow-up):
Hi Shiva,
This is Luke from LP pressure washing. I saw you left a voicemail the other day and I just left one on your answering machine. We are starting cleaning homes in May. If you want to get an estimate now and schedule something for then that would be perfect? Let me know what you think. Have a nice weekend.

EXAMPLE 6 (clarification after voicemail, asking discovery questions):
Hi Sharon,

This is Luke Perreault from LP Pressure Washing. Thank for clicking on our ad.

I left a voicemail but I just wanted to confirm your looking for the house including outsides of gutters, deck, then the patio below the deck?

Is the deck trex, composite?

EXAMPLE 7 (post-visit full estimate with soft-wash explainer, windows note, single date proposal):
Hi Regina,

It's Luke Perreault from LP Pressure Washing. It was nice talking to you earlier and I took a look at your house.

Here is the estimate broken down.

Here's what we can do for you:

To wash your house including all sides, up to peaks, outside of gutters, soffits, windows, doors and garage door we can do for $330. (You can decide if you want the whole thing done later if you want)

For the back patio we can do for $130 (normally $180 but we discount when doing both the house and patio together).

So it would be $460 total.

We use the soft wash system—that's low pressure cleaning—which is much safer on your siding and landscaping than traditional pressure washing. We pair it with a safe bleach-based soap that kills mold, mildew, and algae without damaging your plants or home. We make sure to water down any plants before and after to protect them.

The windows get washed during the process but they don't dry perfectly spotless as if professionally cleaned. But they look great.

How would the Saturday the 16th work?

Let me know if you have any questions,

EXAMPLE 8 (Angi lead, voicemail full, discovery question):
Hi Adam,

This is Luke Perreault from LP Pressure Washing. I got your contact info from Angi. I just called and you was going to leave a voicemail but your inbox is full.

I see your wanting your siding washed. Do you want all 4 sides minus the brick?

Feel free to respond here or give me a call,

EXAMPLE 9 (driveway, asking scope question + timeline):
Hi David,

This is Luke Perreault from LP Pressure Washing. I see that you're wanting your 22 by 18 driveway pressure washed. We can for sure help with that.

I was looking online and see that would be like 2/3rds of the full 3 lot driveway pretty much. Would you also want the sidewalk of your property and the walkway to your front door included?

It would affect the price ever so slightly.
Also when are you ideally wanting this done?

Luke,

PRICING / CONTEXT (use when generating drafts):
- House wash (4 sides, up to peaks, outsides of gutters, soffits, windows, doors): $330–$570 depending on size/stories
- Driveway: $130–$210 depending on size
- Deck: $130–$210 (often discounted when paired with house)
- Patio: $130–$210
- Windows (exterior, separate): $182 (Memorial Day Special 30% off when paired with house wash, active through May 31, 2026)
- Soft wash system explainer (only include when relevant — house wash, deck, fence): "We use the soft wash system that's low pressure cleaning which is much safer on your siding and landscaping than traditional pressure washing."
- Windows note (only when house wash includes windows): "The windows get washed during the process but they don't dry perfectly spotless as if professionally cleaned. But they look great."
- Pool warning (only when there's a pool): "Quick heads up on the pool — we'll do our best to spray away from it and keep the water and small sand particles out, but it's typically pretty inevitable that some gets in."

OUTPUT FORMAT — return STRICT JSON only, no preamble, no markdown:
{
  "drafts": [
    { "label": "Discovery — confirm scope before quoting", "text": "Hi [Name],..." },
    { "label": "Quote-ready estimate", "text": "Hi [Name],..." },
    { "label": "Voicemail follow-up", "text": "Hi [Name],..." }
  ]
}

The three drafts should be DIFFERENT angles — pick the 3 most appropriate to the available context. If we have detailed services + scope but no quote yet, lean into Quote-ready. If we have only a name and partial info, lean into Discovery. If they came via voicemail or didn't pick up, do the Voicemail follow-up. Each draft should be self-contained and immediately sendable — no placeholders, no [brackets]. Use the customer's actual first name from the context. Today's date: ${todayISO()}.`;

async function handleDraftMessages(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "Anthropic API key not configured" });
  const { jobId } = req.body || {};
  if (!jobId || !/^rec[A-Za-z0-9]{14}$/.test(jobId)) {
    return res.status(400).json({ error: "invalid jobId" });
  }

  // Fetch the Job + linked Client (parallel)
  const jobRes = await fetch(`${airtableUrl(AT_JOBS)}/${jobId}`, { headers: airtableHeaders() });
  const job = await jobRes.json();
  if (job.error) return res.status(400).json({ error: job.error.message });
  const linkedClientId = (job.fields["Client"] || [])[0];
  let client = null;
  if (linkedClientId) {
    const cr = await fetch(`${airtableUrl(AT_CLIENTS)}/${linkedClientId}`, { headers: airtableHeaders() });
    const cd = await cr.json();
    if (!cd.error) client = cd;
  }

  // Parse the conversation log if present so we can give the AI a clean
  // transcript instead of raw JSON.
  let convoTranscript = "";
  const rawConvo = (job.fields["Conversation log"] || "").trim();
  if (rawConvo) {
    try {
      const parsed = JSON.parse(rawConvo);
      if (Array.isArray(parsed)) {
        convoTranscript = parsed.map(m => {
          const role = m.role === "assistant" ? "Bot" : m.role === "user" ? "Customer" : (m.role || "System");
          const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          return `${role}: ${content}`;
        }).join("\n");
      }
    } catch {}
  }

  // Build context for the AI
  const ctxLines = [
    `JOB CONTEXT:`,
    `Job ID: ${job.fields["Job ID"] || "(unset)"}`,
    `Service type: ${job.fields["Service type"] || "(not specified)"}`,
    `Property snapshot: ${job.fields["Property snapshot"] || "(not provided)"}`,
    `Pipeline stage: ${job.fields["Pipeline stage"] || "(unset)"}`,
    `Lead origin: ${job.fields["Lead origin"] || "(unset)"}`,
    `Existing quote text: ${job.fields["Quote"] || "(none yet)"}`,
    `Existing quote amount: ${job.fields["Quote amount"] != null ? "$" + job.fields["Quote amount"] : "(none yet)"}`,
    `Concerns / notes: ${job.fields["Concerns"] || job.fields["Notes from Luke"] || "(none)"}`,
    "",
    `CLIENT CONTEXT:`,
    client ? `Name: ${client.fields["Full name"] || client.fields["Name"] || "(unknown)"}` : "Name: (no linked client)",
    client?.fields?.["Phone"] ? `Phone: ${client.fields["Phone"]}` : null,
    client?.fields?.["Email"] ? `Email: ${client.fields["Email"]}` : null,
    client?.fields?.["Address"] ? `Address: ${client.fields["Address"]}` : null,
    client?.fields?.["Source"] ? `Source / channel: ${client.fields["Source"]}` : null,
    client?.fields?.["UTM source"] ? `UTM source: ${client.fields["UTM source"]}` : null,
    client?.fields?.["Sqft"] ? `Sqft (estimated): ${client.fields["Sqft"]}` : null,
    client?.fields?.["Stories"] ? `Stories: ${client.fields["Stories"]}` : null,
    client?.fields?.["Material"] ? `Material: ${client.fields["Material"]}` : null,
    "",
    convoTranscript ? `CHATBOT CONVERSATION (most recent on bottom):` : "CHATBOT CONVERSATION: (none — they didn't engage the chatbot)",
    convoTranscript,
  ].filter(Boolean).join("\n");

  // One-shot Anthropic call to generate the drafts
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const anthropic = new Anthropic();
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 2500,
    system: [
      { type: "text", text: DRAFT_VOICE_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      { role: "user", content: `Generate the 3 drafts based on this context. Return STRICT JSON only.\n\n${ctxLines}` },
    ],
  });

  const rawReply = response.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  // Strip any code fences the model might add even when told not to
  const jsonText = rawReply.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    console.error("[draft-messages] JSON parse failed:", err, "raw:", rawReply.slice(0, 500));
    return res.status(500).json({ error: "AI returned invalid JSON", raw: rawReply.slice(0, 800) });
  }
  const drafts = Array.isArray(parsed?.drafts) ? parsed.drafts.slice(0, 3) : [];
  if (!drafts.length) {
    return res.status(500).json({ error: "AI returned no drafts", raw: rawReply.slice(0, 500) });
  }

  return res.status(200).json({
    drafts,
    usage: response.usage,
    clientPhone: client?.fields?.["Phone"] || "",
    clientName:  client?.fields?.["Full name"] || client?.fields?.["Name"] || "",
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Action: delete — DELETE a Job (called from the Kanban modal's two-step button)
// ═══════════════════════════════════════════════════════════════════════

async function handleDelete(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { jobId } = req.body || {};
  if (!jobId || !/^rec[A-Za-z0-9]{14}$/.test(jobId)) {
    return res.status(400).json({ error: "invalid jobId" });
  }
  const r = await fetch(`${airtableUrl(AT_JOBS)}/${jobId}`, {
    method:  "DELETE",
    headers: airtableHeaders(),
  });
  const data = await r.json();
  if (data.error) {
    console.error("[ops/delete] Airtable error:", data.error);
    return res.status(400).json({ error: data.error.message || data.error.type });
  }
  return res.status(200).json({ ok: true, jobId, deleted: data.deleted });
}

// ═══════════════════════════════════════════════════════════════════════
// Action: ingest-lead — webhook for Angi (and other) email→CRM automations
// ═══════════════════════════════════════════════════════════════════════
//
// POST body shape (one of these two):
//   { source: "angi", raw: "<full email body>" }     ← server parses
//   { source: "angi", parsed: { name, phone, email, address, service, comments, jobNumber } }
//
// Behavior:
//   1. Dedupe Client by phone — reuse if exists, create if new (Source = "Angi")
//   2. Create Job in 🆕 New lead with Service type, Notes from Luke, Lead origin = "Angi"
//   3. Telegram ping to Luke (📥 New Angi lead — name / phone / address / service)
//   4. Log Funnel event (Event type = "Form submitted", UTM source = "angi")
//   5. Returns { ok: true, clientId, jobId, isNewClient }

function parseAngiEmail(text) {
  if (!text || typeof text !== "string") return {};
  const lead = {};
  const norm = text.replace(/\r\n/g, "\n").replace(/ /g, " ");
  // Name: line right after "Customer Information"
  const nameM = norm.match(/Customer Information\s*\n+\s*([A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+){0,3})/);
  if (nameM) lead.name = nameM[1].trim();
  // Phone: first 10-digit US number
  const phoneM = norm.match(/\(?(\d{3})\)?[\s.\-]*(\d{3})[\s.\-]*(\d{4})/);
  if (phoneM) lead.phone = `(${phoneM[1]}) ${phoneM[2]}-${phoneM[3]}`;
  // Email: first non-Angi email address
  const emailMatches = norm.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g) || [];
  for (const e of emailMatches) {
    if (!/angi\.com$/i.test(e) && !/lhppressurewashing/i.test(e)) {
      lead.email = e.toLowerCase();
      break;
    }
  }
  // Address: street + city/state/zip
  const addrM = norm.match(/(\d+\s+[A-Za-z0-9 .'\-]+(?:AVE(?:NUE)?|ST(?:REET)?|RD|ROAD|DR(?:IVE)?|LN|LANE|BLVD|CT|COURT|PL(?:ACE)?|WAY|HWY|HIGHWAY|PKWY|PARKWAY|TER(?:RACE)?|CIR(?:CLE)?|TRL|TRAIL)\.?,?\s+[A-Za-z][A-Za-z .\-]+,?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?)/i);
  if (addrM) lead.address = addrM[1].trim().replace(/\s+,/g, ",");
  // Service: line right after "You have a new lead!"
  const serviceM = norm.match(/new lead!\s*\n+\s*([^\n]+)/i);
  if (serviceM) lead.service = serviceM[1].trim();
  // Comments: after "Comments:"
  const commentsM = norm.match(/Comments:\s*\n*\s*([^\n]+)/i);
  if (commentsM) lead.comments = commentsM[1].trim();
  // Job number — Angi uses unicode dashes
  const jobM = norm.match(/Job\s*#:?\s*[‒–—­\-\s]*(\d+)/i);
  if (jobM) lead.jobNumber = jobM[1];
  return lead;
}

async function sendTelegramText(text) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error("[ops/ingest-lead] telegram error:", err);
  }
}

async function handleIngestLead(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { source = "angi", raw, parsed } = req.body || {};
  let lead = parsed || {};
  if (raw && (!parsed || Object.keys(parsed).length === 0)) {
    lead = parseAngiEmail(raw);
  }

  // Need at least a phone OR an email — without one we can't dedupe or contact
  if (!lead.phone && !lead.email) {
    return res.status(400).json({
      error: "Could not extract a phone number or email from the email body",
      parsedFields: lead,
    });
  }
  if (!lead.name) lead.name = "Angi Lead";

  const phoneClean = (lead.phone || "").replace(/\D/g, "");
  const firstName = lead.name.split(/\s+/)[0];
  const escapedFirst = firstName.toLowerCase().replace(/'/g, "\\'");

  // ── 1. Dedupe Client ──────────────────────────────────────────────────
  let clientId = null;
  let isNewClient = false;
  const dedupeClauses = [];
  if (phoneClean) dedupeClauses.push(`SEARCH('${phoneClean}', REGEX_REPLACE({Phone}&'', '\\\\D', ''))`);
  if (lead.email) dedupeClauses.push(`LOWER({Email})=LOWER('${lead.email.replace(/'/g, "\\'")}')`);
  if (dedupeClauses.length) {
    const formula = dedupeClauses.length === 1 ? dedupeClauses[0] : `OR(${dedupeClauses.join(",")})`;
    const existing = await airtableGet(AT_CLIENTS, {
      filterByFormula: formula,
      maxRecords: 1,
      "fields[]": ["Name", "Phone"],
    });
    if (existing.length) clientId = existing[0].id;
  }
  if (!clientId) {
    isNewClient = true;
    const clientFields = {
      "Name":            firstName,
      "Full name":       lead.name,
      "Phone":           lead.phone || "",
      "Email":           lead.email || "",
      "Address":         lead.address || "",
      "Source":          "Angi",
      "UTM source":      "angi",
      "First contacted": todayISO(),
    };
    Object.keys(clientFields).forEach(k => clientFields[k] === "" && delete clientFields[k]);
    const c = await airtablePost(AT_CLIENTS, clientFields);
    clientId = c.id;
  }

  // ── 2. Create Job ─────────────────────────────────────────────────────
  const serviceType = lead.service || "Powerwash";
  const notes = [
    lead.comments ? `Angi comments: ${lead.comments}` : null,
    lead.jobNumber ? `Angi Job #${lead.jobNumber}` : null,
  ].filter(Boolean).join("\n");
  const jobFields = {
    "Client":         [clientId],
    "Job ID":         `${firstName} – ${serviceType}`,
    "Service type":   serviceType,
    "Pipeline stage": "🆕 New lead",
    "Lead origin":    "Angi",
    "Property snapshot": lead.address || "",
    "Create date":    todayISO(),
  };
  if (notes) jobFields["Notes from Luke"] = notes;
  const j = await airtablePost(AT_JOBS, jobFields);

  // ── 3. Telegram ping ──────────────────────────────────────────────────
  const tgLines = [
    `📥 <b>New Angi lead</b>`,
    `<b>${lead.name}</b>${isNewClient ? "" : " (existing client)"}`,
    lead.phone ? `📞 ${lead.phone}` : null,
    lead.email ? `✉️ ${lead.email}` : null,
    lead.address ? `🏠 ${lead.address}` : null,
    `🛠 ${serviceType}`,
    lead.comments ? `\n<i>${lead.comments}</i>` : null,
    lead.jobNumber ? `\nAngi Job #${lead.jobNumber}` : null,
  ].filter(Boolean).join("\n");
  await sendTelegramText(tgLines);

  // ── 4. Funnel event ───────────────────────────────────────────────────
  await airtablePost(AT_FUNNEL, {
    "Event ID":   `${todayISO().replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6)}-an`,
    "Event type": "Form submitted",
    "Timestamp":  new Date().toISOString(),
    "UTM source": "angi",
    "Notes":      `Angi lead intake${lead.jobNumber ? " — Job #" + lead.jobNumber : ""}`,
    "Client":     [clientId],
    "Job":        [j.id],
  }).catch(err => console.error("[ops/ingest-lead] funnel event failed:", err));

  return res.status(200).json({
    ok: true,
    clientId,
    jobId: j.id,
    isNewClient,
    parsed: lead,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Action: chat — Anthropic Sonnet 4.5 + tools
// ═══════════════════════════════════════════════════════════════════════

// ─── Tool implementations ─────────────────────────────────────────────

async function searchClients({ query, limit = 10 }) {
  if (!query) return { error: "query required" };
  const safe = String(query).replace(/'/g, "\\'").trim();
  const formula = `OR(
    SEARCH(LOWER('${safe.toLowerCase()}'), LOWER({Name}&'')),
    SEARCH(LOWER('${safe.toLowerCase()}'), LOWER({Full name}&'')),
    SEARCH('${safe.replace(/\D/g, "")}', {Phone}&''),
    SEARCH(LOWER('${safe.toLowerCase()}'), LOWER({Email}&''))
  )`.replace(/\s+/g, " ");
  const records = await airtableGet(AT_CLIENTS, {
    filterByFormula: formula,
    maxRecords: limit,
    "fields[]": ["Name", "Full name", "Phone", "Email", "Address", "Source", "First contacted"],
  });
  return {
    matches: records.map(r => ({
      id: r.id,
      name: r.fields["Full name"] || r.fields["Name"] || "(unnamed)",
      phone: r.fields["Phone"] || "",
      email: r.fields["Email"] || "",
      address: r.fields["Address"] || "",
      source: r.fields["Source"] || "",
      firstContacted: r.fields["First contacted"] || null,
    })),
  };
}

async function searchJobs({ clientName, clientId, pipelineStage, leadStatus, activeOnly = false, recentDays, limit = 25 }) {
  const clauses = [];
  if (clientId) {
    clauses.push(`SEARCH('${clientId}', ARRAYJOIN({Client}))`);
  } else if (clientName) {
    const safe = clientName.toLowerCase().replace(/'/g, "\\'");
    clauses.push(`SEARCH(LOWER('${safe}'), LOWER({Job ID}&''))`);
  }
  if (pipelineStage) clauses.push(`{Pipeline stage}='${pipelineStage.replace(/'/g, "\\'")}'`);
  if (leadStatus)    clauses.push(`{Lead status}='${leadStatus.replace(/'/g, "\\'")}'`);
  if (activeOnly)    clauses.push(`AND({Pipeline stage}!='✅ Job done', {Pipeline stage}!='❌ Lost')`);
  if (recentDays) {
    const n = parseInt(recentDays, 10);
    if (Number.isFinite(n) && n > 0) clauses.push(`IS_AFTER({Create date}, DATEADD(TODAY(), -${n}, 'days'))`);
  }
  const formula = clauses.length ? `AND(${clauses.join(",")})` : null;
  const params = {
    maxRecords: limit,
    "fields[]": [
      "Job ID", "Client", "Service type", "Quote", "Quote amount",
      "Quote date", "Booking date", "Completion date", "Pipeline stage",
      "Lead status", "Last touch", "Outreach attempts", "Customer responded",
      "Notes from Luke", "Lead origin", "Create date", "Concerns",
    ],
  };
  if (formula) params.filterByFormula = formula;
  const records = await airtableGet(AT_JOBS, params);

  const clientIds = new Set();
  for (const r of records) {
    const linked = r.fields["Client"] || [];
    if (linked[0]) clientIds.add(linked[0]);
  }
  const clientMap = {};
  if (clientIds.size) {
    const ids = [...clientIds];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const cs = await airtableGet(AT_CLIENTS, {
        filterByFormula: `OR(${chunk.map(id => `RECORD_ID()='${id}'`).join(",")})`,
        "fields[]": ["Name", "Full name", "Phone"],
      });
      for (const c of cs) {
        clientMap[c.id] = {
          name: c.fields["Full name"] || c.fields["Name"] || "(unnamed)",
          phone: c.fields["Phone"] || "",
        };
      }
    }
  }

  return {
    matches: records.map(r => {
      const f = r.fields;
      const linked = f["Client"] || [];
      const cid = linked[0];
      const c = cid ? clientMap[cid] : null;
      return {
        id: r.id,
        jobId: f["Job ID"] || "",
        clientId: cid,
        clientName: c?.name || "(no client)",
        clientPhone: c?.phone || "",
        serviceType: f["Service type"] || "",
        pipelineStage: f["Pipeline stage"] || "",
        leadStatus: f["Lead status"] || "",
        quote: f["Quote"] || "",
        quoteAmount: f["Quote amount"] ?? null,
        quoteDate: f["Quote date"] || null,
        bookingDate: f["Booking date"] || null,
        completionDate: f["Completion date"] || null,
        lastTouch: f["Last touch"] || null,
        outreachAttempts: f["Outreach attempts"] || 0,
        customerResponded: f["Customer responded"] || null,
        leadOrigin: f["Lead origin"] || "",
        createDate: f["Create date"] || null,
        notesFromLuke: f["Notes from Luke"] || "",
        concerns: f["Concerns"] || "",
      };
    }),
  };
}

async function getJob({ jobId }) {
  if (!jobId) return { error: "jobId required" };
  const r = await fetch(`${airtableUrl(AT_JOBS)}/${jobId}`, { headers: airtableHeaders() });
  const data = await r.json();
  if (data.error) return { error: data.error.message };
  const linked = data.fields["Client"] || [];
  let clientInfo = null;
  if (linked[0]) {
    const cr = await fetch(`${airtableUrl(AT_CLIENTS)}/${linked[0]}`, { headers: airtableHeaders() });
    const cd = await cr.json();
    if (!cd.error) clientInfo = {
      id: cd.id,
      name: cd.fields["Full name"] || cd.fields["Name"] || "",
      phone: cd.fields["Phone"] || "",
      email: cd.fields["Email"] || "",
      address: cd.fields["Address"] || "",
    };
  }
  return { job: { id: data.id, ...data.fields }, client: clientInfo };
}

async function getClient({ clientId }) {
  if (!clientId) return { error: "clientId required" };
  const r = await fetch(`${airtableUrl(AT_CLIENTS)}/${clientId}`, { headers: airtableHeaders() });
  const data = await r.json();
  if (data.error) return { error: data.error.message };
  const jobIds = data.fields["Jobs"] || [];
  let jobs = [];
  if (jobIds.length) {
    const formula = `OR(${jobIds.map(id => `RECORD_ID()='${id}'`).join(",")})`;
    const js = await airtableGet(AT_JOBS, {
      filterByFormula: formula,
      "fields[]": ["Job ID", "Service type", "Pipeline stage", "Quote amount", "Quote date", "Booking date"],
    });
    jobs = js.map(j => ({ id: j.id, ...j.fields }));
  }
  return { client: { id: data.id, ...data.fields }, jobs };
}

async function createClient({ firstName, fullName, phone, email, address, source, utmSource }) {
  if (!firstName || !phone) return { error: "firstName and phone are required" };
  const cleanPhone = phone.replace(/\D/g, "");
  const existing = await airtableGet(AT_CLIENTS, {
    filterByFormula: `SEARCH('${cleanPhone}', REGEX_REPLACE({Phone}&'', '\\\\D', ''))`,
    maxRecords: 1,
    "fields[]": ["Name", "Phone"],
  });
  if (existing.length) {
    return { existing: true, clientId: existing[0].id, name: existing[0].fields["Name"], note: "Phone already on file. Reusing existing Client." };
  }
  const fields = {
    "Name":            firstName,
    "Phone":           phone,
    "First contacted": todayISO(),
  };
  if (fullName)  fields["Full name"]   = fullName;
  if (email)     fields["Email"]       = email;
  if (address)   fields["Address"]     = address;
  if (source)    fields["Source"]      = source;
  if (utmSource) fields["UTM source"]  = utmSource.toLowerCase();
  const data = await airtablePost(AT_CLIENTS, fields);
  return { existing: false, clientId: data.id, fieldsWritten: fields };
}

async function createJobTool({ clientId, jobIdLabel, serviceType, pipelineStage = "🆕 New lead", quote, quoteAmount, propertySnapshot, sourceChannel = "Manual", concerns, lastTouch }) {
  if (!clientId) return { error: "clientId required" };
  if (!serviceType) return { error: "serviceType required" };
  const fields = {
    "Client":         [clientId],
    "Service type":   serviceType,
    "Pipeline stage": pipelineStage,
    "Lead origin":    sourceChannel,
    "Create date":    todayISO(),
  };
  if (jobIdLabel)          fields["Job ID"]            = jobIdLabel;
  if (quote)               fields["Quote"]             = quote;
  if (quoteAmount != null) fields["Quote amount"]      = Number(quoteAmount);
  if (propertySnapshot)    fields["Property snapshot"] = propertySnapshot;
  if (concerns)            fields["Concerns"]          = concerns;
  if (lastTouch)           fields["Last touch"]        = lastTouch;
  if (pipelineStage === "💬 Quoted") {
    fields["Quote date"]  = todayISO();
    fields["Lead status"] = "Quoted";
  }
  const mapped = STAGE_TO_LEAD_STATUS[pipelineStage];
  if (mapped !== undefined && mapped !== null && !fields["Lead status"]) fields["Lead status"] = mapped;
  const data = await airtablePost(AT_JOBS, fields);
  return { jobId: data.id, fieldsWritten: fields };
}

async function updateJobTool({ jobId, fields }) {
  if (!jobId) return { error: "jobId required" };
  if (!fields || typeof fields !== "object") return { error: "fields object required" };
  const out = { ...fields };
  if (out["Pipeline stage"] && !("Lead status" in out)) {
    const mapped = STAGE_TO_LEAD_STATUS[out["Pipeline stage"]];
    if (mapped !== undefined) out["Lead status"] = mapped;
  }
  if (out["Pipeline stage"] === "📞 Contacted" && !out["Last touch"]) out["Last touch"] = todayISO();
  if (out["Pipeline stage"] === "✅ Job done" && !out["Completion date"]) out["Completion date"] = todayISO();
  const data = await airtablePatch(AT_JOBS, jobId, out);
  return { jobId: data.id, fieldsWritten: out };
}

async function updateClientTool({ clientId, fields }) {
  if (!clientId) return { error: "clientId required" };
  if (!fields || typeof fields !== "object") return { error: "fields object required" };
  const out = {};
  const rejected = [];
  for (const [k, v] of Object.entries(fields)) {
    if (EDITABLE_CLIENT_FIELDS.has(k)) out[k] = v === "" ? null : v;
    else rejected.push(k);
  }
  if (rejected.length) return { error: `not editable on Client: ${rejected.join(", ")}. Allowed: ${[...EDITABLE_CLIENT_FIELDS].join(", ")}` };
  if (!Object.keys(out).length) return { error: "no editable fields supplied" };
  const data = await airtablePatch(AT_CLIENTS, clientId, out);
  return { clientId: data.id, fieldsWritten: out };
}

async function logOutreach({ jobId, note, bumpFrom }) {
  if (!jobId) return { error: "jobId required" };
  const r = await fetch(`${airtableUrl(AT_JOBS)}/${jobId}`, { headers: airtableHeaders() });
  const data = await r.json();
  if (data.error) return { error: data.error.message };
  const current = data.fields["Outreach attempts"] || 0;
  const newCount = current + 1;
  const existingNotes = data.fields["Notes from Luke"] || "";
  const stamped = `[${todayISO()}] Outreach #${newCount}${note ? " — " + note : ""}`;
  const newNotes = existingNotes ? `${existingNotes}\n${stamped}` : stamped;
  const stage = data.fields["Pipeline stage"];
  const updateFields = {
    "Outreach attempts": newCount,
    "Last touch":        todayISO(),
    "Notes from Luke":   newNotes,
  };
  // Stage-bump policy is controlled by the caller via `bumpFrom`:
  //   - undefined / null   → legacy auto-bump (chat agent's [OUTREACH] tool)
  //                          bumps from New lead / Quoted / Contacted → Contacted
  //   - an array of stages → bumps to Contacted ONLY if the current stage is
  //                          in that array. Lets each call site express its
  //                          own intent.
  //
  // Luke's mental model:
  //   🆕 New lead   = haven't acted, or gathering info pre-quote
  //   💬 Quoted     = sent them a quote
  //   📞 Contacted  = following up AFTER the quote
  //
  // Kanban "Tried" button passes bumpFrom=["💬 Quoted"]: a Tried tap on a
  // Quoted lead means "following up on my quote" → bump to Contacted.
  // A Tried tap on a New lead just logs the attempt — stage stays put
  // because Luke could be just clarifying scope before quoting.
  const defaultBumpFrom = ["🆕 New lead", "💬 Quoted", "📞 Contacted"];
  const allowedStages = bumpFrom === undefined ? defaultBumpFrom : bumpFrom;
  if (Array.isArray(allowedStages) && (allowedStages.length === 0 ? false : allowedStages.includes(stage || ""))) {
    updateFields["Pipeline stage"] = "📞 Contacted";
    updateFields["Lead status"]    = "Follow up";
  }
  await airtablePatch(AT_JOBS, jobId, updateFields);
  const linked = data.fields["Client"] || [];
  await airtablePost(AT_FUNNEL, {
    "Event ID":   `${todayISO().replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6)}-or`,
    "Event type": "Outreach attempt",
    "Timestamp":  new Date().toISOString(),
    "Job":        [jobId],
    ...(linked[0] ? { "Client": [linked[0]] } : {}),
    ...(note ? { "Notes": note } : {}),
  }).catch(() => {});
  return { jobId, outreachAttempts: newCount, fieldsWritten: updateFields };
}

async function logResponse({ jobId, note, alsoBookForDate }) {
  if (!jobId) return { error: "jobId required" };
  const r = await fetch(`${airtableUrl(AT_JOBS)}/${jobId}`, { headers: airtableHeaders() });
  const data = await r.json();
  if (data.error) return { error: data.error.message };
  const updateFields = {};
  if (!data.fields["Customer responded"]) updateFields["Customer responded"] = todayISO();
  if (alsoBookForDate) {
    updateFields["Booking date"]   = alsoBookForDate;
    updateFields["Pipeline stage"] = "📅 Booked";
    updateFields["Lead status"]    = "Booked";
  }
  if (Object.keys(updateFields).length) await airtablePatch(AT_JOBS, jobId, updateFields);
  const linked = data.fields["Client"] || [];
  await airtablePost(AT_FUNNEL, {
    "Event ID":   `${todayISO().replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6)}-cr`,
    "Event type": "Customer responded",
    "Timestamp":  new Date().toISOString(),
    "Job":        [jobId],
    ...(linked[0] ? { "Client": [linked[0]] } : {}),
    ...(note ? { "Notes": note } : {}),
  }).catch(() => {});
  return { jobId, fieldsWritten: updateFields };
}

async function bookCalendar({ jobId, date, time = "08:30", durationHours = 2, notes }) {
  if (!jobId)  return { error: "jobId required" };
  if (!date)   return { error: "date required (ISO YYYY-MM-DD)" };
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return { error: "Google Calendar not configured" };
  const jobRes = await fetch(`${airtableUrl(AT_JOBS)}/${jobId}`, { headers: airtableHeaders() });
  const job = await jobRes.json();
  if (job.error) return { error: job.error.message };
  const linked = job.fields["Client"] || [];
  let client = {};
  if (linked[0]) {
    const cr = await fetch(`${airtableUrl(AT_CLIENTS)}/${linked[0]}`, { headers: airtableHeaders() });
    const cd = await cr.json();
    if (!cd.error) client = cd.fields;
  }
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  const calendar = google.calendar({ version: "v3", auth });
  const start = new Date(`${date}T${time}:00-04:00`);
  const end = new Date(start.getTime() + Number(durationHours) * 3600 * 1000);
  const customerName = client["Full name"] || client["Name"] || "Customer";
  const summary = `${job.fields["Service type"] || "Service"} — ${customerName}`;
  const description = [
    `Customer: ${customerName}`,
    `Phone: ${client["Phone"] || "—"}`,
    `Email: ${client["Email"] || "—"}`,
    `Address: ${client["Address"] || "—"}`,
    `Service: ${job.fields["Service type"] || "—"}`,
    `Quote: ${job.fields["Quote amount"] ? "$" + job.fields["Quote amount"] : (job.fields["Quote"] || "—")}`,
    notes ? `\nNotes: ${notes}` : "",
  ].filter(Boolean).join("\n");
  const event = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
    requestBody: {
      summary,
      description,
      start: { dateTime: start.toISOString(), timeZone: "America/New_York" },
      end:   { dateTime: end.toISOString(),   timeZone: "America/New_York" },
    },
  });
  const updateFields = {
    "Booking date":   date,
    "Pipeline stage": "📅 Booked",
    "Lead status":    "Booked",
  };
  await airtablePatch(AT_JOBS, jobId, updateFields);
  await airtablePost(AT_FUNNEL, {
    "Event ID":   `${todayISO().replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6)}-bk`,
    "Event type": "Booked",
    "Timestamp":  new Date().toISOString(),
    "Job":        [jobId],
    ...(linked[0] ? { "Client": [linked[0]] } : {}),
    "Notes":      `Booked ${date} ${time}, calendar event ${event.data.id}`,
  }).catch(() => {});
  return {
    jobId,
    eventId: event.data.id,
    eventLink: event.data.htmlLink,
    bookingDate: date,
    time,
    fieldsWritten: updateFields,
  };
}

const TOOLS = [
  { name: "search_clients",
    description: "Find Clients by name, phone, or email. Always run this BEFORE creating a new client to avoid duplicates. Returns up to 10 matches with name/phone/email/address/source.",
    input_schema: { type: "object", properties: { query: { type: "string", description: "Name, phone digits, or email substring" }, limit: { type: "number" } }, required: ["query"] } },
  { name: "search_jobs",
    description: "Find Jobs by client name, client ID, pipeline stage, lead status, recency, or active-only. Use this BEFORE updating a Job. If 2+ matches, ASK Luke which one before mutating anything.",
    input_schema: { type: "object", properties: { clientName: { type: "string" }, clientId: { type: "string" }, pipelineStage: { type: "string" }, leadStatus: { type: "string" }, activeOnly: { type: "boolean" }, recentDays: { type: "number" }, limit: { type: "number" } } } },
  { name: "get_job",       description: "Fetch a single Job by ID. Returns the full record + the linked Client info.",
    input_schema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] } },
  { name: "get_client",    description: "Fetch a single Client by ID with all of their linked Jobs.",
    input_schema: { type: "object", properties: { clientId: { type: "string" } }, required: ["clientId"] } },
  { name: "create_client", description: "Create a new Client. Auto-dedupes by phone — if the phone is already on file, returns { existing: true, clientId } and does NOT create a duplicate.",
    input_schema: { type: "object", properties: { firstName: { type: "string" }, fullName: { type: "string" }, phone: { type: "string" }, email: { type: "string" }, address: { type: "string" }, source: { type: "string" }, utmSource: { type: "string" } }, required: ["firstName", "phone"] } },
  { name: "create_job",    description: "Create a new Job linked to an existing Client. Pipeline stage defaults to '🆕 New lead'. If you set Pipeline stage = '💬 Quoted', Quote date is auto-set to today.",
    input_schema: { type: "object", properties: { clientId: { type: "string" }, jobIdLabel: { type: "string" }, serviceType: { type: "string" }, pipelineStage: { type: "string", enum: ["🆕 New lead", "💬 Quoted", "📞 Contacted", "📅 Booked", "✅ Job done", "❌ Lost"] }, quote: { type: "string" }, quoteAmount: { type: "number" }, propertySnapshot: { type: "string" }, sourceChannel: { type: "string" }, concerns: { type: "string" }, lastTouch: { type: "string" } }, required: ["clientId", "serviceType"] } },
  { name: "update_job",    description: "Update fields on a Job. Auto-stamps companion fields on stage changes.",
    input_schema: { type: "object", properties: { jobId: { type: "string" }, fields: { type: "object" } }, required: ["jobId", "fields"] } },
  { name: "update_client", description: "Update Client fields (Name, Full name, Phone, Email, Address, Source). Use this when Luke says to update a customer's contact info. Pass the clientId (recXXXXXXXXXXXXXX) and a fields object with only the keys you want to change.",
    input_schema: { type: "object", properties: { clientId: { type: "string" }, fields: { type: "object", description: "Allowed keys: Name, Full name, Phone, Email, Address, Source" } }, required: ["clientId", "fields"] } },
  { name: "log_outreach",  description: "Log a manual outreach attempt on a Job. Increments Outreach attempts, sets Last touch=today, appends '[YYYY-MM-DD] Outreach #N — note' to Notes from Luke, moves Pipeline stage → '📞 Contacted' (only if stage is empty/New lead/Quoted/Contacted), and creates a Funnel event.",
    input_schema: { type: "object", properties: { jobId: { type: "string" }, note: { type: "string" } }, required: ["jobId"] } },
  { name: "log_response",  description: "Log that the customer replied. Sets Customer responded=today (only if blank). If the customer is locking in a date, set alsoBookForDate.",
    input_schema: { type: "object", properties: { jobId: { type: "string" }, note: { type: "string" }, alsoBookForDate: { type: "string" } }, required: ["jobId"] } },
  { name: "book_calendar", description: "Create a Google Calendar event AND update the Job with Booking date + Pipeline stage='📅 Booked' + Lead status='Booked'. Default 08:30 ET, 2-hour duration. Logs a Booked funnel event.",
    input_schema: { type: "object", properties: { jobId: { type: "string" }, date: { type: "string" }, time: { type: "string" }, durationHours: { type: "number" }, notes: { type: "string" } }, required: ["jobId", "date"] } },
];

const TOOL_IMPL = {
  search_clients: searchClients,
  search_jobs:    searchJobs,
  get_job:        getJob,
  get_client:     getClient,
  create_client:  createClient,
  create_job:     createJobTool,
  update_job:     updateJobTool,
  update_client:  updateClientTool,
  log_outreach:   logOutreach,
  log_response:   logResponse,
  book_calendar:  bookCalendar,
};

const SYSTEM_PROMPT = `You are Luke Perreault's personal CRM operator for LP Pressure Washing (Bucks/Montgomery/Lehigh counties, PA, est. 2026). Luke is the OWNER. You are running INSIDE his Ops UI on his phone — when he tells you something happened on a phone call or text, you mirror that into Airtable + Google Calendar so his data stays accurate without him having to manually verify.

Today's year is 2026. Season starts May 16, 2026 — never propose a date before that. Default booking time 8:30 AM unless Luke says otherwise.

═════════════════════════════════════════════
CONFIRMATION DISCIPLINE (CRITICAL — never skip)
═════════════════════════════════════════════
After EVERY tool call that mutates Airtable or Google Calendar, state in plain English EXACTLY what you wrote, using human-readable values (not field IDs). Examples Luke expects:

"OK — updating Sarah's Job:
• Pipeline stage: 📅 Booked
• Lead status: Booked
• Booking date: 2026-05-22
• Created Google Calendar event for Thursday May 22, 8:30 AM"

"Logged outreach #3 for John. Last touch updated to today, Pipeline stage moved to 📞 Contacted, note appended to his record."

"Created new Client (Sarah Smith, 215-555-1234) and a New lead Job (Sarah – House wash). Source = Yelp. Sitting in 🆕 New lead."

This confirmation is what saves Luke from manually checking. Don't skip it. Don't summarize — itemize the changes.

═════════════════════════════════════════════
SCHEMA (memorize these)
═════════════════════════════════════════════

PIPELINE STAGES (singleSelect — use EXACT values with emoji + space):
🆕 New lead  /  💬 Quoted  /  📞 Contacted  /  📅 Booked  /  ✅ Job done  /  ❌ Lost

LEAD STATUS (legacy singleSelect — limited options):
Quoted, Booked, Completed, Lost, Follow up, Cold (or blank)

STAGE TRANSITION MATRIX — when Luke says X, you map to:
"new lead", "add ___"                  → 🆕 New lead, Lead status blank
"reached out", "texted", "called"      → 📞 Contacted, Lead status Follow up, Last touch=today, append note
"quoted", "sent quote at $X"           → 💬 Quoted, Lead status Quoted, Quote/amount/date set
"booked for [date]"                    → 📅 Booked, Lead status Booked, Booking date=ISO
"done", "finished", "paid $X"          → ✅ Job done, Lead status Completed, Completion date=today, Final paid
"lost", "ghosted", "passed"            → ❌ Lost, Lead status Lost, note reason
"cold", "haven't heard back"           → keep Pipeline stage, Lead status Cold

(The update_job and log_outreach tools handle most of this auto-stamping. You don't need to manually set Lead status when you change Pipeline stage — the tool does it.)

DATES: ISO YYYY-MM-DD. "May 15" → "2026-05-15" (next future May 15). "Tomorrow" → tomorrow's ISO date.
CURRENCY: numbers, not strings. 385 not "$385".
LINKED RECORDS: array of recIds.

═════════════════════════════════════════════
WORKFLOWS
═════════════════════════════════════════════

ALWAYS search before creating. Phone = Client dedupe key. Job ID + Client link = Job lookup.
If a search returns 2+ matches, ASK Luke which one. Never silently pick.
After EVERY mutation, confirm in plain English (see above).

USE PRELOADED CONTEXT WHEN AVAILABLE — if a "CURRENTLY SELECTED JOB" or "CURRENTLY SELECTED CLIENT" block is in the system context, those record IDs are confirmed-correct. Use them directly. DO NOT call search_jobs/search_clients to find what's already in front of you. That wastes a tool call and frequently misses (search uses name fragments — if Luke says "Sarah", the preloaded Sarah is the answer, not whatever search returns).

UPDATING CLIENT INFO — to change a customer's phone, email, address, name, or source, use update_client with the clientId. NEVER use update_job for these — those fields don't exist on Job. If Luke says "update Sarah's phone to ___" and you have a selected clientId in context, call update_client immediately with { clientId, fields: { Phone: "___" } }.

NEW LEAD ("add Sarah, 215-555-1234, wants house wash, came from Yelp"):
1. search_clients by phone first (dedupe)
2. create_client if no match (returns existing if dedupe hit)
3. create_job with Pipeline stage="🆕 New lead", serviceType, source channel
4. CONFIRM: "Created Client (Sarah, 215-555-1234) and Job (Sarah – House wash). 🆕 New lead. Source = Yelp."

CONTACTED ("texted John, no response yet" or "left voicemail for Mike"):
1. search_jobs activeOnly with clientName
2. If 2+ matches, ASK
3. log_outreach with the note Luke gave
4. CONFIRM: "Logged outreach #2 for John – House wash. Pipeline stage → 📞 Contacted. Last touch updated. Note appended."

QUOTED ("sent John a quote at $370"):
1. search_jobs activeOnly with clientName
2. update_job with { "Pipeline stage": "💬 Quoted", "Quote": "$370", "Quote amount": 370, "Quote date": "today's ISO" }
3. CONFIRM the changes itemized.

BOOKED ("Sarah booked for May 22" — Luke's primary win):
1. search_jobs with clientName
2. book_calendar with { jobId, date: "2026-05-22" } — this both creates the Calendar event and flips the Job to 📅 Booked
3. CONFIRM with the Calendar event details + the Job changes.

DONE / PAID ("finished John's house wash, paid $400"):
1. search_jobs with clientName, activeOnly
2. update_job with { "Pipeline stage": "✅ Job done", "Final paid": 400 } — Completion date auto-set
3. CONFIRM.

CUSTOMER REPLIED ("Sarah called back, asked for Friday" or "Mike said yes, book Friday"):
1. search_jobs with clientName
2. log_response with { jobId, note: "...", alsoBookForDate: "2026-05-XX" if a date was committed }
3. If alsoBookForDate was set, also call book_calendar to make the Calendar event.
4. CONFIRM.

═════════════════════════════════════════════
WORKFLOW TRIGGERS (UI buttons)
═════════════════════════════════════════════

Luke's chat UI has workflow buttons that auto-send these short triggers. When you see one as the WHOLE user message, treat it as starting a guided flow — DON'T act yet, ASK for the missing info conversationally. Don't call any mutating tool until you have what you need.

"[NEW CLIENT]" — Reply: "OK, new client. What's their first name and phone number?"
After Luke gives that, also gather: services they want, source (Yelp / referral / phone / etc.), address if relevant. Once you have enough:
1. search_clients by phone (dedupe)
2. create_client + create_job with Pipeline = "🆕 New lead"
3. Draft a first-quote text in Luke's voice (next section). If you don't have enough info to quote a real number (no sqft / stories / material), draft a SHORT introductory text instead that sets the call/visit and asks for the missing details.
4. CONFIRM with itemized changes + the message text + offer to log it as Contacted via log_outreach.

"[NEW JOB]" — This is for adding a NEW JOB to an EXISTING client (repeat customer, another property, follow-up service). It is NEVER for new clients. Reply: "OK, new job for an existing client. Who's it for, and what service?"
1. search_clients by name/phone to find the existing client. If 2+ matches, ASK Luke which one.
2. If NO match found, STOP and ASK: "No match for [name]. Want to make them a new client instead? (use [NEW CLIENT])" — DO NOT call create_client. Wait for Luke to confirm.
3. Once you have the client + service type (and optionally quote, source, etc.), call create_job ONLY — never create_client — with Pipeline = "🆕 New lead" (or whatever stage Luke specifies). Lead origin defaults to "Repeat" for repeat customers unless Luke says otherwise.
4. CONFIRM with itemized changes.

REPEAT-CUSTOMER LANGUAGE (treat these as [NEW JOB], not [NEW CLIENT]):
• "another job for [name]"  • "[name] wants us back"  • "[name] booked us again"
• "new job for [existing customer]"  • "[name] from last year wants ___"
• Any phrasing that names someone Luke has worked with before — when in doubt, search_clients first. If you get a hit, it's [NEW JOB]. Never silently create_client when Luke gives a name without a phone — search first.

"[BOOKED]" — Reply: "Which lead and what date? Default time 8:30 AM, you can override."
Once you have lead + date:
1. search_jobs (or use selectedJobId from CUSTOMER CONTEXT if set)
2. book_calendar — this updates the Job (Pipeline → "📅 Booked", Lead status → Booked, Booking date) AND creates the Google Calendar event in one shot
3. CONFIRM with itemized Job changes + Calendar event details (title, date, time)

"[QUOTED]" — Reply: "Which lead, quote amount, and service?"
1. search_jobs
2. update_job with Pipeline = "💬 Quoted", Quote, Quote amount, Quote date = today
3. Draft the quote text in Luke's voice
4. CONFIRM

"[OUTREACH]" — Reply: "Which lead and what happened? (texted / called / voicemail / etc.)"
1. search_jobs
2. log_outreach with the note
3. CONFIRM (Pipeline auto-bumps to 📞 Contacted unless already further along)

"[DRAFT MESSAGE]" — Reply: "Who and what kind of message? (first quote, follow-up, booking confirmation, etc.)"
1. search_jobs if needed for context
2. Draft in Luke's voice
3. Offer to log_outreach with note "Sent ___ text via Ops chat" if Luke confirms he sent it

If a job/client is already in CUSTOMER CONTEXT (selectedJobId / selectedClientId), assume the workflow refers to it unless Luke names someone different.

═════════════════════════════════════════════
MESSAGE DRAFTING
═════════════════════════════════════════════

When Luke asks for a draft text/email to a customer, write it AS LUKE — not as a chatbot replying to a customer. Voice rules:
• Warm, casual, neighborly, confident. Solo-operator vibe. Not corporate.
• NO emojis, NO markdown, NO bullets in the message text. Plain text.
• Single final dollar amount per line. Never reveal internal math.
• Day-of-week always with dates: "Friday, May 22nd" not "May 22nd".
• If first contact / formal: open with "Hi [Name], This is Luke from LP Pressure Wash. Nice talking with you earlier."
• If ongoing thread: open with "Hi [Name]," or skip the formal intro entirely.
• Close: "Let me know if you have any questions," (no name) for casual; sign "Luke" or "Luke / LP Pressure Wash" for formal.

CURRENT PROMOTION (must mention on first quote):
Memorial Day Special, active through May 31, 2026:
• 30% off all additional services when paired with a house wash. (House wash itself is at standard pricing — no separate house-wash discount.)
• If customer asks "is the discount included?" / "how much without it?" → reply EXACTLY: "The LP team needs to verify the pricing of everything before moving forward." Do not reveal pre-discount math.

SOFT-WASH EXPLAINER (include with house-wash quotes unless Luke says "already covered"):
"We use the soft wash system — that's low pressure cleaning — which is much safer on your siding and landscaping than traditional pressure washing. We pair it with a safe bleach-based soap that kills mold, mildew, and algae without damaging your plants or home. We make sure to water down any plants before and after to protect them."

WINDOWS HARD-WATER NOTE (include with house wash unless Luke says "already covered"):
"The windows get washed during the process but they don't dry perfectly spotless as if professionally cleaned. But they look great."

FORMAT RULES for message drafts: return JUST the message text, no preamble, no markdown fences. After delivering it, ask: "Want me to mark [Name]'s Job as 📞 Contacted and log this as a sent text?" If yes → log_outreach with note "Sent quote text via Ops chat".

═════════════════════════════════════════════
GUARD RAILS
═════════════════════════════════════════════

• Never invent prices, dates, or names. If you don't know something, ASK or call a search tool.
• Never claim a tool succeeded without calling it. Confirmations describe ACTUAL writes.
• If a search returns no matches, ask Luke if he wants to create the record, don't auto-create.
• If a tool errors, surface the error to Luke verbatim — don't paper over it.
• Never discuss other customers' data unsolicited (this is Luke's CRM but customer data should still be handled with care).
• If Luke pastes raw notes with no clear ask, summarize what you understood and ASK what to do (draft, log, both?).
`;

async function handleChat(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "Anthropic API key not configured" });

  const { messages = [], view = null, selectedJobId = null, selectedClientId = null } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: "messages array required" });
  }

  // Pre-fetch the selected job + client so the model never has to guess what
  // a record ID points to. Luke's UI shows the card in front of him — the AI
  // should see the same details, not just an opaque rec ID.
  let selectedJobInline   = null;
  let selectedClientInline = null;
  if (selectedJobId && /^rec[A-Za-z0-9]{14}$/.test(selectedJobId)) {
    try {
      const jr = await fetch(`${airtableUrl(AT_JOBS)}/${selectedJobId}`, { headers: airtableHeaders() });
      const jd = await jr.json();
      if (!jd.error) {
        const linked = jd.fields["Client"] || [];
        let cd = null;
        if (linked[0]) {
          const cr = await fetch(`${airtableUrl(AT_CLIENTS)}/${linked[0]}`, { headers: airtableHeaders() });
          const cdr = await cr.json();
          if (!cdr.error) cd = cdr;
        }
        selectedJobInline = {
          jobRecId:       selectedJobId,
          jobIdLabel:     jd.fields["Job ID"]        || "",
          serviceType:    jd.fields["Service type"]  || "",
          pipelineStage:  jd.fields["Pipeline stage"]|| "",
          leadStatus:     jd.fields["Lead status"]   || "",
          quoteAmount:    jd.fields["Quote amount"]  ?? null,
          quoteDate:      jd.fields["Quote date"]    || null,
          bookingDate:    jd.fields["Booking date"]  || null,
          lastTouch:      jd.fields["Last touch"]    || null,
          clientRecId:    cd?.id || null,
          clientName:     cd?.fields?.["Full name"]  || cd?.fields?.["Name"] || "(no client)",
          clientPhone:    cd?.fields?.["Phone"]      || "",
          clientEmail:    cd?.fields?.["Email"]      || "",
          clientAddress:  cd?.fields?.["Address"]    || "",
          clientSource:   cd?.fields?.["Source"]     || "",
        };
        if (cd && !selectedClientId) selectedClientInline = { ...selectedJobInline, fromJob: true };
      }
    } catch (e) { console.error("[ops/chat] preload job failed:", e.message); }
  }
  if (selectedClientId && /^rec[A-Za-z0-9]{14}$/.test(selectedClientId) && !selectedClientInline) {
    try {
      const cr = await fetch(`${airtableUrl(AT_CLIENTS)}/${selectedClientId}`, { headers: airtableHeaders() });
      const cd = await cr.json();
      if (!cd.error) {
        selectedClientInline = {
          clientRecId:   selectedClientId,
          clientName:    cd.fields["Full name"] || cd.fields["Name"] || "(unnamed)",
          clientPhone:   cd.fields["Phone"]   || "",
          clientEmail:   cd.fields["Email"]   || "",
          clientAddress: cd.fields["Address"] || "",
          clientSource:  cd.fields["Source"]  || "",
        };
      }
    } catch (e) { console.error("[ops/chat] preload client failed:", e.message); }
  }

  const ctxLines = [
    `Today's date: ${todayISO()}`,
    view ? `Luke is currently viewing: ${view} (in his Kanban)` : null,
  ];
  if (selectedJobInline) {
    ctxLines.push(
      "",
      "═════ CURRENTLY SELECTED JOB (Luke is looking at this card right now) ═════",
      `Job ID label: ${selectedJobInline.jobIdLabel || "(unlabeled)"}`,
      `Service type: ${selectedJobInline.serviceType || "—"}`,
      `Pipeline stage: ${selectedJobInline.pipelineStage || "—"} · Lead status: ${selectedJobInline.leadStatus || "—"}`,
      `Quote: ${selectedJobInline.quoteAmount != null ? "$" + selectedJobInline.quoteAmount : "—"}${selectedJobInline.quoteDate ? " (quoted " + selectedJobInline.quoteDate + ")" : ""}`,
      `Booking date: ${selectedJobInline.bookingDate || "—"} · Last touch: ${selectedJobInline.lastTouch || "—"}`,
      `Linked Client: ${selectedJobInline.clientName}${selectedJobInline.clientPhone ? " · " + selectedJobInline.clientPhone : ""}${selectedJobInline.clientEmail ? " · " + selectedJobInline.clientEmail : ""}`,
      selectedJobInline.clientAddress ? `Address: ${selectedJobInline.clientAddress}` : null,
      "",
      `🔑 USE THESE RECORD IDs DIRECTLY — DO NOT SEARCH:`,
      `   jobId    = ${selectedJobInline.jobRecId}`,
      selectedJobInline.clientRecId ? `   clientId = ${selectedJobInline.clientRecId}` : null,
      "",
      `When Luke says "this job", "this client", "update Sarah's phone", "for them", etc., he is referring to the records above. Call update_job / update_client / log_outreach / log_response / book_calendar with these IDs immediately — DO NOT call search_jobs or search_clients first.`,
      "════════════════════════════════════════════════════════════════════════",
    );
  } else if (selectedClientInline) {
    ctxLines.push(
      "",
      "═════ CURRENTLY SELECTED CLIENT (Luke is looking at this client right now) ═════",
      `Name: ${selectedClientInline.clientName}`,
      `Phone: ${selectedClientInline.clientPhone || "—"} · Email: ${selectedClientInline.clientEmail || "—"}`,
      selectedClientInline.clientAddress ? `Address: ${selectedClientInline.clientAddress}` : null,
      `Source: ${selectedClientInline.clientSource || "—"}`,
      "",
      `🔑 USE THIS RECORD ID DIRECTLY — DO NOT SEARCH:`,
      `   clientId = ${selectedClientInline.clientRecId}`,
      "",
      `When Luke references "this client", "them", or names a field to update, use this clientId with update_client / create_job / etc. directly — DO NOT call search_clients first.`,
      "═══════════════════════════════════════════════════════════════════════════════",
    );
  }
  const dynamicContext = ctxLines.filter(l => l !== null).join("\n");

  const anthropic = new Anthropic();
  const toolCalls = [];
  let conversation = messages.map(m => ({ role: m.role, content: m.content }));
  let finalText = "";
  let usage = null;
  const MAX_TOOL_LOOPS = 8;

  for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1500,
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        { type: "text", text: dynamicContext },
      ],
      tools: TOOLS,
      messages: conversation,
    });
    usage = response.usage;

    if (response.stop_reason === "end_turn" || !response.content.some(b => b.type === "tool_use")) {
      finalText = response.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      break;
    }

    const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
    const toolResults = [];
    for (const block of toolUseBlocks) {
      const impl = TOOL_IMPL[block.name];
      if (!impl) {
        toolCalls.push({ name: block.name, input: block.input, error: "unknown tool" });
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Error: unknown tool ${block.name}`, is_error: true });
        continue;
      }
      try {
        const result = await impl(block.input || {});
        toolCalls.push({ name: block.name, input: block.input, result });
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
      } catch (err) {
        console.error(`[ops/chat tool ${block.name}] error:`, err);
        toolCalls.push({ name: block.name, input: block.input, error: err.message });
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Error: ${err.message || "tool failed"}`, is_error: true });
      }
    }
    conversation.push({ role: "assistant", content: response.content });
    conversation.push({ role: "user", content: toolResults });
  }

  return res.status(200).json({ reply: finalText || "(no response)", toolCalls, usage });
}

// ═══════════════════════════════════════════════════════════════════════
// Main entry: route by ?action= param
// ═══════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  res.setHeader("Cache-Control", "no-store");

  // Auth
  const expectedKey = process.env.DASHBOARD_KEY;
  if (expectedKey && req.query?.key !== expectedKey) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!AT_BASE || !AT_KEY) {
    return res.status(500).json({ error: "airtable not configured" });
  }

  const action = (req.query?.action || "").toString();
  try {
    switch (action) {
      case "data":           return await handleData(req, res);
      case "update":         return await handleUpdate(req, res);
      case "update-client":  return await handleUpdateClient(req, res);
      case "search-clients": return await handleSearchClients(req, res);
      case "create-job":     return await handleCreateJob(req, res);
      case "backfill-2025-to-done":   return await handleBackfillToDone(req, res);
      case "setup-tracking-fields":   return await handleSetupTrackingFields(req, res);
      case "event-origins":           return await handleEventOrigins(req, res);
      case "sessions-list":           return await handleSessionsList(req, res);
      case "delete-sessions":         return await handleDeleteSessions(req, res);
      case "telegram-audit":          return await handleTelegramAudit(req, res);
      case "backfill-attribution":    return await handleBackfillAttribution(req, res);
      case "log-outreach":            return await handleLogOutreach(req, res);
      case "draft-messages":          return await handleDraftMessages(req, res);
      case "delete":         return await handleDelete(req, res);
      case "chat":           return await handleChat(req, res);
      case "ingest-lead":    return await handleIngestLead(req, res);
      default:
        return res.status(400).json({ error: `unknown action '${action}'. Use ?action=data|update|update-client|search-clients|create-job|delete|chat` });
    }
  } catch (err) {
    console.error(`[ops/${action}] error:`, err);
    return res.status(500).json({ error: err.message || "ops handler failed" });
  }
}
