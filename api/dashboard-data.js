// ─── Marketing dashboard data endpoint ────────────────────────────────────
// One read-only GET that aggregates everything the dashboard needs:
//   - KPI counts (with prev-period comparison)
//   - Funnel drop-off counts by event type
//   - Form submits by UTM source over the last 12 weeks
//   - Yelp weekly trend
//   - Cold leads list (outreach >=2, no response, still active)
//   - Recent activity (last 24h)
//
// Query params:
//   days  = 7 | 30 | 90      (default 7)
//   key   = <DASHBOARD_KEY>  required if DASHBOARD_KEY env var is set
//
// Reads from Airtable tables: Funnel events, Yelp stats, Jobs.

const AT_FUNNEL = "Funnel events";
const AT_YELP   = "Yelp stats";
const AT_JOBS   = "Jobs";

const FUNNEL_ORDER = [
  "Page view",
  "CTA click",
  "Form step 1",
  "Form step 2",
  "Form submitted",
  "Chat engaged",
  "Quote sent",
  "Outreach attempt",
  "Customer responded",
  "Booked",
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
    const qs = new URLSearchParams(params);
    if (offset) qs.set("offset", offset);
    const r = await fetch(`${airtableUrl(table)}?${qs.toString()}`, { headers: airtableHeaders() });
    const data = await r.json();
    if (data.error) throw new Error(`Airtable ${table}: ${data.error.message || data.error.type}`);
    records.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return records;
}

// ISO date for `daysBack` days ago at 00:00 UTC.
function isoDaysAgo(daysBack) {
  return new Date(Date.now() - daysBack * 86400 * 1000).toISOString();
}

// Monday-anchored week key, e.g. "2026-04-27".
function weekKey(iso) {
  const d = new Date(iso);
  const day = d.getUTCDay();              // 0 Sun .. 6 Sat
  const diff = (day + 6) % 7;             // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

function pctChange(curr, prev) {
  if (!prev) return curr ? null : 0;      // null = "no prior data"
  return Math.round(((curr - prev) / prev) * 100);
}

export default async function handler(req, res) {
  // CORS so the preview iframe (served from a different origin) can fetch
  // a deployed backend during development. Same-origin requests in prod are
  // unaffected.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  res.setHeader("Cache-Control", "no-store");

  // Auth gate (optional — only enforced if DASHBOARD_KEY is set in env)
  const expectedKey = process.env.DASHBOARD_KEY;
  if (expectedKey && req.query?.key !== expectedKey) {
    return res.status(401).json({ error: "unauthorized" });
  }

  if (!process.env.AIRTABLE_BASE_ID || !process.env.AIRTABLE_API_KEY) {
    return res.status(500).json({ error: "airtable not configured" });
  }

  const days = Math.max(1, Math.min(180, parseInt(req.query?.days || "7", 10) || 7));

  try {
    const cutoffCurr = isoDaysAgo(days);
    const cutoffPrev = isoDaysAgo(days * 2);
    const cutoff12wk = isoDaysAgo(7 * 12);
    const cutoff24h  = isoDaysAgo(1);

    // Pull last `days*2` of funnel events (covers current + previous period in one shot)
    const [funnelRows, yelpRows, coldJobs, recent24h] = await Promise.all([
      fetchAll(AT_FUNNEL, {
        filterByFormula: `IS_AFTER({Timestamp}, DATETIME_PARSE('${cutoffPrev}'))`,
      }),
      fetchAll(AT_YELP, {
        filterByFormula: `IS_AFTER({Week ending}, DATETIME_PARSE('${cutoff12wk}'))`,
      }),
      fetchAll(AT_JOBS, {
        filterByFormula: `AND({Outreach attempts}>=2, {Customer responded}=BLANK(), NOT(FIND('Lost', {Pipeline stage}&'')), NOT(FIND('done', LOWER({Pipeline stage}&''))))`,
      }),
      fetchAll(AT_FUNNEL, {
        filterByFormula: `IS_AFTER({Timestamp}, DATETIME_PARSE('${cutoff24h}'))`,
      }),
    ]);

    // Also pull form submits for the last 12 weeks (separate call so we get
    // trend data beyond the current `days` window).
    const formSubmits12wk = await fetchAll(AT_FUNNEL, {
      filterByFormula: `AND({Event type}='Form submitted', IS_AFTER({Timestamp}, DATETIME_PARSE('${cutoff12wk}')))`,
    });

    // ── Bucket funnel events into curr / prev windows ───────────────────────
    const cutoffCurrMs = Date.parse(cutoffCurr);
    const counts = { curr: {}, prev: {} };
    for (const r of funnelRows) {
      const t = r.fields["Timestamp"];
      const e = r.fields["Event type"];
      if (!t || !e) continue;
      const bucket = Date.parse(t) >= cutoffCurrMs ? "curr" : "prev";
      counts[bucket][e] = (counts[bucket][e] || 0) + 1;
    }

    const kpiFor = (eventType) => {
      const c = counts.curr[eventType] || 0;
      const p = counts.prev[eventType] || 0;
      return { value: c, prev: p, change: pctChange(c, p) };
    };

    // ── Yelp KPIs (most recent week) ────────────────────────────────────────
    const yelpSorted = [...yelpRows].sort((a, b) => {
      const ax = a.fields["Week ending"] || "";
      const bx = b.fields["Week ending"] || "";
      return ax < bx ? 1 : ax > bx ? -1 : 0;
    });
    const yelpLatest = yelpSorted[0]?.fields || {};
    const yelpPrev   = yelpSorted[1]?.fields || {};
    const yelpKpi = (field) => ({
      value: Number(yelpLatest[field] || 0),
      prev:  Number(yelpPrev[field]   || 0),
      change: pctChange(Number(yelpLatest[field] || 0), Number(yelpPrev[field] || 0)),
    });
    const yelpCpl = (() => {
      const spend = Number(yelpLatest["Ad spend"] || 0);
      const leads = Number(yelpLatest["Leads"]    || 0);
      const prevSpend = Number(yelpPrev["Ad spend"] || 0);
      const prevLeads = Number(yelpPrev["Leads"]    || 0);
      const curr = leads ? spend / leads : 0;
      const prev = prevLeads ? prevSpend / prevLeads : 0;
      return { value: Math.round(curr * 100) / 100, prev: Math.round(prev * 100) / 100, change: pctChange(curr, prev) };
    })();

    // ── Reply rate ──────────────────────────────────────────────────────────
    const outreachCurr = counts.curr["Outreach attempt"] || 0;
    const responsesCurr = counts.curr["Customer responded"] || 0;
    const outreachPrev  = counts.prev["Outreach attempt"]  || 0;
    const responsesPrev = counts.prev["Customer responded"] || 0;
    const replyRateCurr = outreachCurr ? Math.round((responsesCurr / outreachCurr) * 100) : null;
    const replyRatePrev = outreachPrev ? Math.round((responsesPrev / outreachPrev) * 100) : null;

    // ── Funnel chart (counts in current window, in canonical order) ─────────
    const funnel = FUNNEL_ORDER.map(name => ({
      stage: name,
      count: counts.curr[name] || 0,
    }));

    // ── Form submits by source over last 12 weeks ───────────────────────────
    // Shape: { weeks: ["2026-02-23", ...], series: { yelp: [n,n,...], facebook:[...] } }
    const weeksSet = new Set();
    const sourceWeeks = {};
    for (const r of formSubmits12wk) {
      const t = r.fields["Timestamp"];
      if (!t) continue;
      const wk = weekKey(t);
      const src = (r.fields["UTM source"] || "direct").trim() || "direct";
      weeksSet.add(wk);
      sourceWeeks[src] ||= {};
      sourceWeeks[src][wk] = (sourceWeeks[src][wk] || 0) + 1;
    }
    const weeks = [...weeksSet].sort();
    const series = {};
    for (const [src, byWeek] of Object.entries(sourceWeeks)) {
      series[src] = weeks.map(w => byWeek[w] || 0);
    }

    // ── Yelp weekly trend (last 12 weeks, ascending) ────────────────────────
    const yelpTrend = [...yelpSorted].reverse().map(r => ({
      weekEnding:   r.fields["Week ending"] || null,
      leads:        Number(r.fields["Leads"]         || 0),
      adSpend:      Number(r.fields["Ad spend"]      || 0),
      profileViews: Number(r.fields["Profile views"] || 0),
      phoneCalls:   Number(r.fields["Phone calls"]   || 0),
    }));

    // ── Cold leads list ─────────────────────────────────────────────────────
    const coldLeads = coldJobs
      .map(r => ({
        jobId:       r.fields["Job ID"]          || r.id,
        service:     r.fields["Service type"]    || "(unknown)",
        attempts:    Number(r.fields["Outreach attempts"] || 0),
        lastTouch:   r.fields["Last touch"]      || null,
        notes:       r.fields["Notes from Luke"] || "",
        clientLink:  r.fields["Client"]          || [],
        pipeline:    r.fields["Pipeline stage"]  || "",
      }))
      .sort((a, b) => {
        // oldest last-touch first
        const ax = a.lastTouch || "9999";
        const bx = b.lastTouch || "9999";
        return ax < bx ? -1 : ax > bx ? 1 : 0;
      })
      .slice(0, 25);

    // Resolve client names for cold leads (single batched lookup)
    const coldClientIds = [...new Set(coldLeads.flatMap(j => j.clientLink))];
    if (coldClientIds.length) {
      const formula = `OR(${coldClientIds.map(id => `RECORD_ID()='${id}'`).join(",")})`;
      const clients = await fetchAll("Clients", { filterByFormula: formula });
      const idx = Object.fromEntries(clients.map(c => [c.id, c.fields?.["Name"] || "(unnamed)"]));
      coldLeads.forEach(j => { j.clientName = j.clientLink[0] ? (idx[j.clientLink[0]] || "(unknown)") : "(no client)"; });
    } else {
      coldLeads.forEach(j => { j.clientName = "(no client)"; });
    }

    // ── Recent activity (last 24h, newest first, 20 rows) ──────────────────
    const recent = recent24h
      .map(r => ({
        time:      r.fields["Timestamp"] || null,
        eventType: r.fields["Event type"] || "?",
        source:    r.fields["UTM source"] || "",
        notes:     r.fields["Notes"]      || "",
        client:    r.fields["Client"]     || [],
      }))
      .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))
      .slice(0, 20);

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      windowDays: days,
      kpis: {
        pageViews:    kpiFor("Page view"),
        ctaClicks:    kpiFor("CTA click"),
        formSubmits:  kpiFor("Form submitted"),
        chatEngaged:  kpiFor("Chat engaged"),
        quotesSent:   kpiFor("Quote sent"),
        outreach:     kpiFor("Outreach attempt"),
        responses:    kpiFor("Customer responded"),
        replyRate:    { value: replyRateCurr, prev: replyRatePrev, change: pctChange(replyRateCurr, replyRatePrev) },
        booked:       kpiFor("Booked"),
        yelpSpend:    yelpKpi("Ad spend"),
        yelpLeads:    yelpKpi("Leads"),
        yelpCpl,
      },
      funnel,
      leadsBySource: { weeks, series },
      yelpTrend,
      coldLeads,
      recentActivity: recent,
    });
  } catch (err) {
    console.error("[dashboard-data] error:", err);
    return res.status(500).json({ error: err.message || "dashboard-data failed" });
  }
}
