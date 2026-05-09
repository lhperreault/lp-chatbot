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
];

const VIEW_CONFIGS = {
  "2026":      { layout: "kanban", label: "2026 Jobs",          filter: `IS_AFTER({Create date}, '2025-12-31')` },
  "all":       { layout: "kanban", label: "All Jobs",           filter: null },
  "booked":    { layout: "list",   label: "Booked Calendar",    filter: `{Pipeline stage}='📅 Booked'`,                                              sortField: "Booking date", sortDirection: "asc" },
  "contacted": { layout: "list",   label: "Waiting for Client", filter: `AND({Pipeline stage}='📞 Contacted', {Customer responded}=BLANK())`,        sortField: "Last touch",   sortDirection: "asc" },
};

const JOB_FIELDS_FOR_VIEW = [
  "Job ID", "Client", "Service type", "Property snapshot", "Quote",
  "Quote amount", "Quote date", "Booking date", "Completion date",
  "Lead status", "Concerns", "Lead origin", "Pipeline stage",
  "Last touch", "Notes from Luke", "Outreach attempts",
  "Customer responded", "Create date",
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
  "Completion date", "Final paid", "Concerns", "Service type",
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

async function logOutreach({ jobId, note }) {
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
  if (!stage || ["🆕 New lead", "💬 Quoted", "📞 Contacted"].includes(stage)) {
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

  const dynamicContext = [
    `Today's date: ${todayISO()}`,
    view ? `Luke is currently viewing: ${view} (in his Kanban)` : null,
    selectedJobId ? `Job currently selected: ${selectedJobId} — assume questions reference this job unless Luke names another` : null,
    selectedClientId ? `Client currently selected: ${selectedClientId} — assume questions reference this client unless Luke names another` : null,
  ].filter(Boolean).join("\n");

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
      case "data":   return await handleData(req, res);
      case "update": return await handleUpdate(req, res);
      case "chat":   return await handleChat(req, res);
      default:
        return res.status(400).json({ error: `unknown action '${action}'. Use ?action=data|update|chat` });
    }
  } catch (err) {
    console.error(`[ops/${action}] error:`, err);
    return res.status(500).json({ error: err.message || "ops handler failed" });
  }
}
