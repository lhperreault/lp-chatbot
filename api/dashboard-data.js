// ─── Marketing dashboard data endpoint ────────────────────────────────────
// Channel-aware aggregation across Funnel events + Jobs + Yelp stats.
//
// Read sources:
//   Funnel events (web widget) → top-of-funnel only: Page view, CTA click,
//     Form step 1/2, Form submitted, Chat engaged, plus Outreach attempt /
//     Customer responded events logged manually
//   Jobs (truth)                 → Quoted, Booked, $ booked, channel mix
//   Yelp stats                   → weekly trend
//
// Query params:
//   days  = 7 | 30 | 90      (default 7)
//   key   = <DASHBOARD_KEY>  required if DASHBOARD_KEY env var is set

const AT_FUNNEL  = "Funnel events";
const AT_YELP    = "Yelp stats";
const AT_JOBS    = "Jobs";
const AT_CLIENTS = "Clients";

// Edit these to reclassify a channel without touching anything else.
// Anything not listed falls into "other".
const CHANNEL_GROUPS = {
  marketing: ["Website chatbot", "Phone call", "Email"],
  organic:   ["Text", "In person", "Repeat"],
};

// Funnel chart — web-inbound only, ends at Quote sent. Post-quote stages
// (Outreach, Booked) live in the channel-breakdown table since they happen
// across all channels.
const WEB_FUNNEL_ORDER = [
  "Page view",
  "CTA click",
  "Form step 1",
  "Form step 2",
  "Form submitted",
  "Chat engaged",
  "Quote sent",
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

function isoDaysAgo(daysBack) {
  return new Date(Date.now() - daysBack * 86400 * 1000).toISOString();
}

// Monday-anchored week key, e.g. "2026-04-27".
function weekKey(iso) {
  const d = new Date(iso);
  const day = d.getUTCDay();
  const diff = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

function pctChange(curr, prev) {
  if (curr == null && prev == null) return null;
  if (!prev) return curr ? null : 0;
  return Math.round(((curr - prev) / prev) * 100);
}

function channelGroup(channel) {
  if (!channel) return "other";
  if (CHANNEL_GROUPS.marketing.includes(channel)) return "marketing";
  if (CHANNEL_GROUPS.organic.includes(channel))   return "organic";
  return "other";
}

// Whether a date string falls in [cutoffMs, now]
function inWindow(iso, cutoffMs) {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= cutoffMs;
}
// Whether a date falls in the *previous* window [prevCutoffMs, currCutoffMs)
function inPrevWindow(iso, prevCutoffMs, currCutoffMs) {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= prevCutoffMs && t < currCutoffMs;
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

  const days = Math.max(1, Math.min(180, parseInt(req.query?.days || "7", 10) || 7));

  try {
    const cutoffCurr = isoDaysAgo(days);
    const cutoffPrev = isoDaysAgo(days * 2);
    const cutoff12wk = isoDaysAgo(7 * 12);
    const cutoff24h  = isoDaysAgo(1);
    const currMs = Date.parse(cutoffCurr);
    const prevMs = Date.parse(cutoffPrev);

    const [funnelRows, yelpRows, allJobs, recent24h, formSubmits12wk, coldJobs] = await Promise.all([
      // Last 2N days of funnel events covers curr + prev windows
      fetchAll(AT_FUNNEL, { filterByFormula: `IS_AFTER({Timestamp}, DATETIME_PARSE('${cutoffPrev}'))` }),
      fetchAll(AT_YELP,   { filterByFormula: `IS_AFTER({Week ending}, DATETIME_PARSE('${cutoff12wk}'))` }),
      // ALL jobs (limited fields) — needed for channel split, prev-period
      // delta, and repeat-customer detection. Volume is small (<1k rows) so
      // pulling the full table once per request is fine.
      fetchAll(AT_JOBS, {
        "fields[]": [
          "Job ID", "Client", "Service type", "Source channel",
          "Quote amount", "Quote date", "Booking date", "Completion date",
          "Pipeline stage", "Lead status", "Last touch", "Outreach attempts",
          "Customer responded", "Notes from Luke",
        ],
      }),
      fetchAll(AT_FUNNEL, { filterByFormula: `IS_AFTER({Timestamp}, DATETIME_PARSE('${cutoff24h}'))` }),
      fetchAll(AT_FUNNEL, { filterByFormula: `AND({Event type}='Form submitted', IS_AFTER({Timestamp}, DATETIME_PARSE('${cutoff12wk}')))` }),
      fetchAll(AT_JOBS, {
        filterByFormula: `AND({Outreach attempts}>=2, {Customer responded}=BLANK(), NOT(FIND('Lost', {Pipeline stage}&'')), NOT(FIND('done', LOWER({Pipeline stage}&''))))`,
        "fields[]": ["Job ID", "Client", "Service type", "Pipeline stage", "Last touch", "Outreach attempts", "Notes from Luke"],
      }),
    ]);

    // ── Funnel events: bucket by curr/prev for top-of-funnel + outreach ─────
    const eventCounts = { curr: {}, prev: {} };
    for (const r of funnelRows) {
      const t = r.fields["Timestamp"];
      const e = r.fields["Event type"];
      if (!t || !e) continue;
      const bucket = Date.parse(t) >= currMs ? "curr" : "prev";
      eventCounts[bucket][e] = (eventCounts[bucket][e] || 0) + 1;
    }
    const evKpi = (name) => {
      const c = eventCounts.curr[name] || 0;
      const p = eventCounts.prev[name] || 0;
      return { value: c, prev: p, change: pctChange(c, p) };
    };

    // ── Jobs: build curr / prev maps keyed on Booking date and Quote date ──
    const jobsCurrBooked = [];
    const jobsPrevBooked = [];
    const jobsCurrQuoted = [];
    const jobsPrevQuoted = [];
    for (const j of allJobs) {
      const f = j.fields;
      if (inWindow(f["Booking date"], currMs))                        jobsCurrBooked.push(j);
      else if (inPrevWindow(f["Booking date"], prevMs, currMs))       jobsPrevBooked.push(j);
      if (inWindow(f["Quote date"], currMs))                          jobsCurrQuoted.push(j);
      else if (inPrevWindow(f["Quote date"], prevMs, currMs))         jobsPrevQuoted.push(j);
    }

    const sumDollars = (arr) => arr.reduce((s, j) => s + (Number(j.fields["Quote amount"] || 0)), 0);

    const bookedCurrCount  = jobsCurrBooked.length;
    const bookedPrevCount  = jobsPrevBooked.length;
    const bookedCurrDollar = Math.round(sumDollars(jobsCurrBooked));
    const bookedPrevDollar = Math.round(sumDollars(jobsPrevBooked));
    const quotedCurrCount  = jobsCurrQuoted.length;
    const quotedPrevCount  = jobsPrevQuoted.length;

    // ── Channel split for booked Jobs in current window ─────────────────────
    const groupCurrCount  = { marketing: 0, organic: 0, other: 0 };
    const groupPrevCount  = { marketing: 0, organic: 0, other: 0 };
    const channelStats = {}; // { [channel]: { quoted, booked, dollars } }
    for (const j of jobsCurrBooked) {
      const ch = j.fields["Source channel"] || "(unset)";
      const grp = channelGroup(ch);
      groupCurrCount[grp] += 1;
      channelStats[ch] ||= { quoted: 0, booked: 0, dollars: 0 };
      channelStats[ch].booked  += 1;
      channelStats[ch].dollars += Number(j.fields["Quote amount"] || 0);
    }
    for (const j of jobsPrevBooked) {
      const grp = channelGroup(j.fields["Source channel"] || "(unset)");
      groupPrevCount[grp] += 1;
    }
    for (const j of jobsCurrQuoted) {
      const ch = j.fields["Source channel"] || "(unset)";
      channelStats[ch] ||= { quoted: 0, booked: 0, dollars: 0 };
      channelStats[ch].quoted += 1;
    }

    const channelBreakdown = Object.entries(channelStats)
      .map(([channel, s]) => ({
        channel,
        group: channelGroup(channel),
        quoted: s.quoted,
        booked: s.booked,
        convPct: s.quoted ? Math.round((s.booked / s.quoted) * 100) : null,
        dollars: Math.round(s.dollars),
      }))
      .sort((a, b) => b.booked - a.booked || b.dollars - a.dollars);

    const channelMix = channelBreakdown
      .filter(c => c.booked > 0)
      .map(c => ({ channel: c.channel, count: c.booked }));

    // ── Repeat customers: window-booked Jobs whose Client has a *prior* Job ─
    // Build "first booking date" per client across ALL jobs.
    const clientFirstBooking = {}; // clientId → earliest Booking date iso
    for (const j of allJobs) {
      const linked = j.fields["Client"] || [];
      const bd = j.fields["Booking date"] || j.fields["Completion date"];
      if (!linked.length || !bd) continue;
      const cid = linked[0];
      if (!clientFirstBooking[cid] || bd < clientFirstBooking[cid]) {
        clientFirstBooking[cid] = bd;
      }
    }
    const repeatJobs = jobsCurrBooked.filter(j => {
      const cid = (j.fields["Client"] || [])[0];
      const first = cid ? clientFirstBooking[cid] : null;
      // a job qualifies as a "repeat" if their first booking predates this window
      return first && Date.parse(first) < currMs;
    });
    const repeatPrevJobs = jobsPrevBooked.filter(j => {
      const cid = (j.fields["Client"] || [])[0];
      const first = cid ? clientFirstBooking[cid] : null;
      return first && Date.parse(first) < prevMs;
    });
    const repeatCurrCount = repeatJobs.length;
    const repeatPrevCount = repeatPrevJobs.length;

    // ── Outreach + replies (Funnel events only) ─────────────────────────────
    const outreachCurr  = eventCounts.curr["Outreach attempt"]   || 0;
    const responsesCurr = eventCounts.curr["Customer responded"] || 0;
    const outreachPrev  = eventCounts.prev["Outreach attempt"]   || 0;
    const responsesPrev = eventCounts.prev["Customer responded"] || 0;
    const replyRateCurr = outreachCurr ? Math.round((responsesCurr / outreachCurr) * 100) : null;
    const replyRatePrev = outreachPrev ? Math.round((responsesPrev / outreachPrev) * 100) : null;

    // ── Yelp ────────────────────────────────────────────────────────────────
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
      const cs = Number(yelpLatest["Ad spend"] || 0);
      const cl = Number(yelpLatest["Leads"]    || 0);
      const ps = Number(yelpPrev["Ad spend"]   || 0);
      const pl = Number(yelpPrev["Leads"]      || 0);
      const c = cl ? cs / cl : 0;
      const p = pl ? ps / pl : 0;
      return { value: Math.round(c * 100) / 100, prev: Math.round(p * 100) / 100, change: pctChange(c, p) };
    })();
    const yelpTrend = [...yelpSorted].reverse().map(r => ({
      weekEnding:   r.fields["Week ending"] || null,
      leads:        Number(r.fields["Leads"]         || 0),
      adSpend:      Number(r.fields["Ad spend"]      || 0),
      profileViews: Number(r.fields["Profile views"] || 0),
      phoneCalls:   Number(r.fields["Phone calls"]   || 0),
    }));

    // ── Web inbound funnel (events) ─────────────────────────────────────────
    const webFunnel = WEB_FUNNEL_ORDER.map(name => ({
      stage: name,
      count: eventCounts.curr[name] || 0,
    }));

    // ── Form submits by source over last 12 weeks ───────────────────────────
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

    // ── Cold leads list ─────────────────────────────────────────────────────
    const coldLeads = coldJobs
      .map(r => ({
        jobId:      r.fields["Job ID"]          || r.id,
        service:    r.fields["Service type"]    || "(unknown)",
        attempts:   Number(r.fields["Outreach attempts"] || 0),
        lastTouch:  r.fields["Last touch"]      || null,
        notes:      r.fields["Notes from Luke"] || "",
        clientLink: r.fields["Client"]          || [],
        pipeline:   r.fields["Pipeline stage"]  || "",
      }))
      .sort((a, b) => {
        const ax = a.lastTouch || "9999";
        const bx = b.lastTouch || "9999";
        return ax < bx ? -1 : ax > bx ? 1 : 0;
      })
      .slice(0, 25);

    // ── Resolve client names for cold leads + repeat activity in one batch ─
    const clientIdsToResolve = new Set([
      ...coldLeads.flatMap(j => j.clientLink),
      ...repeatJobs.flatMap(j => (j.fields["Client"] || [])),
    ]);
    const clientNames = {};
    if (clientIdsToResolve.size) {
      const ids = [...clientIdsToResolve];
      // Airtable has formula-length limits; chunk into 50-id batches.
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const formula = `OR(${chunk.map(id => `RECORD_ID()='${id}'`).join(",")})`;
        const clients = await fetchAll(AT_CLIENTS, { filterByFormula: formula, "fields[]": ["Name"] });
        for (const c of clients) clientNames[c.id] = c.fields?.["Name"] || "(unnamed)";
      }
    }
    coldLeads.forEach(j => { j.clientName = j.clientLink[0] ? (clientNames[j.clientLink[0]] || "(unknown)") : "(no client)"; });

    // ── Repeat / past-customer activity rows ───────────────────────────────
    const repeatActivity = repeatJobs
      .map(j => {
        const cid = (j.fields["Client"] || [])[0];
        const first = cid ? clientFirstBooking[cid] : null;
        const daysSincePrior = first ? Math.floor((currMs - Date.parse(first)) / 86400000) : null;
        // Count this client's prior bookings (everything pre-window)
        let priorCount = 0;
        for (const other of allJobs) {
          if (other.id === j.id) continue;
          const otherCid = (other.fields["Client"] || [])[0];
          if (otherCid !== cid) continue;
          const ob = other.fields["Booking date"] || other.fields["Completion date"];
          if (ob && Date.parse(ob) < currMs) priorCount += 1;
        }
        return {
          clientName: cid ? (clientNames[cid] || "(unknown)") : "(no client)",
          service:    j.fields["Service type"]   || "",
          channel:    j.fields["Source channel"] || "",
          dollars:    Math.round(Number(j.fields["Quote amount"] || 0)),
          priorCount,
          daysSincePrior,
          bookingDate: j.fields["Booking date"] || null,
        };
      })
      .sort((a, b) => (a.bookingDate < b.bookingDate ? 1 : -1));

    // ── Recent activity (last 24h) ─────────────────────────────────────────
    const recent = recent24h
      .map(r => ({
        time:      r.fields["Timestamp"] || null,
        eventType: r.fields["Event type"] || "?",
        source:    r.fields["UTM source"] || "",
        notes:     r.fields["Notes"]      || "",
      }))
      .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))
      .slice(0, 20);

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      windowDays: days,
      kpis: {
        // Business (Jobs)
        booked:         { value: bookedCurrCount,  prev: bookedPrevCount,  change: pctChange(bookedCurrCount,  bookedPrevCount)  },
        bookedDollars:  { value: bookedCurrDollar, prev: bookedPrevDollar, change: pctChange(bookedCurrDollar, bookedPrevDollar) },
        quoted:         { value: quotedCurrCount,  prev: quotedPrevCount,  change: pctChange(quotedCurrCount,  quotedPrevCount)  },
        marketingBooked:{ value: groupCurrCount.marketing, prev: groupPrevCount.marketing, change: pctChange(groupCurrCount.marketing, groupPrevCount.marketing) },
        organicBooked:  { value: groupCurrCount.organic,   prev: groupPrevCount.organic,   change: pctChange(groupCurrCount.organic,   groupPrevCount.organic)   },
        repeatBooked:   { value: repeatCurrCount,  prev: repeatPrevCount,  change: pctChange(repeatCurrCount,  repeatPrevCount)  },
        // Web funnel
        pageViews:    evKpi("Page view"),
        ctaClicks:    evKpi("CTA click"),
        formSubmits:  evKpi("Form submitted"),
        chatEngaged:  evKpi("Chat engaged"),
        // Outreach + replies
        outreach:     evKpi("Outreach attempt"),
        responses:    evKpi("Customer responded"),
        replyRate:    { value: replyRateCurr, prev: replyRatePrev, change: pctChange(replyRateCurr, replyRatePrev) },
        // Yelp
        yelpSpend:    yelpKpi("Ad spend"),
        yelpLeads:    yelpKpi("Leads"),
        yelpCpl,
      },
      webFunnel,
      channelBreakdown,
      channelMix,
      leadsBySource: { weeks, series },
      yelpTrend,
      repeatActivity,
      coldLeads,
      recentActivity: recent,
    });
  } catch (err) {
    console.error("[dashboard-data] error:", err);
    return res.status(500).json({ error: err.message || "dashboard-data failed" });
  }
}
