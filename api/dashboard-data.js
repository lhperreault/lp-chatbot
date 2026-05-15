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
// Old ambiguous values (Phone call / Text / Email) are kept here so the
// dashboard still buckets legacy records sensibly while you reclassify.
const CHANNEL_GROUPS = {
  marketing: ["Website", "Meta ads", "Yelp", "Google", "Angi", "Website chatbot"],
  organic:   ["Referral", "Repeat", "Yard sign / truck", "Door Knocking", "In person", "Manual", "Phone call"],
};

// Channel filter mapping — unifies the different naming conventions used
// across Jobs ("Lead origin": "Meta ads"), Funnel events ("UTM source":
// "meta"), and Clients (UTM source: "meta"). When the dashboard's channel
// dropdown is set, KPIs/funnels are restricted to records matching the
// channel's combined leadOrigin + utmSource buckets.
const CHANNEL_FILTERS = {
  meta:     { label: "Meta (FB/IG)",     leadOrigin: new Set(["Meta ads"]),    utmSource: new Set(["meta", "facebook", "instagram"]) },
  yelp:     { label: "Yelp",             leadOrigin: new Set(["Yelp"]),        utmSource: new Set(["yelp"]) },
  google:   { label: "Google",           leadOrigin: new Set(["Google"]),      utmSource: new Set(["google"]) },
  angi:     { label: "Angi",             leadOrigin: new Set(["Angi"]),        utmSource: new Set(["angi"]) },
  website:  { label: "Website (organic)",leadOrigin: new Set(["Website"]),     utmSource: new Set([""]) },
  referral: { label: "Referral",         leadOrigin: new Set(["Referral"]),    utmSource: new Set([]) },
  repeat:   { label: "Repeat customer",  leadOrigin: new Set(["Repeat"]),      utmSource: new Set([]) },
  other:    { label: "Other",            leadOrigin: new Set(["Yard sign / truck", "Door Knocking", "In person", "Website chatbot"]),    utmSource: new Set([]) },
};
function jobMatchesChannel(j, ch) {
  if (!ch) return true;
  const cfg = CHANNEL_FILTERS[ch];
  if (!cfg) return true;
  const lo = (j.fields["Lead origin"] || "").trim();
  return cfg.leadOrigin.has(lo);
}
function eventMatchesChannel(r, ch) {
  if (!ch) return true;
  const cfg = CHANNEL_FILTERS[ch];
  if (!cfg) return true;
  const utm = (r.fields["UTM source"] || "").toString().toLowerCase().trim();
  // Empty-string match works for the "website" / organic case where UTM is blank
  if (cfg.utmSource.has(utm)) return true;
  return false;
}
function clientMatchesChannel(c, ch) {
  if (!ch) return true;
  const cfg = CHANNEL_FILTERS[ch];
  if (!cfg) return true;
  const utm    = (c.fields["UTM source"] || "").toString().toLowerCase().trim();
  const source = (c.fields["Source"]     || "").toString().trim();
  // Match on EITHER the UTM source tag (raw from URL) or the canonical
  // Source field (now derived/backfilled from fbclid+referrer too). This
  // catches Meta-attributed clients that only had fbclid as the signal
  // (no utm_source param) — they have Source="Meta ads" but UTM source="".
  if (cfg.utmSource.has(utm)) return true;
  if (cfg.leadOrigin.has(source)) return true;
  return false;
}

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

  // When `includeInternal=1` is passed, return everything (Luke's "show me
  // my test traffic" toggle). Default: drop events where Internal=true or
  // Country is set to anything other than "US" — i.e. only count real US
  // visitors so the KPIs aren't polluted by Luke testing from Spain.
  // Events missing both fields (legacy data) are kept — we can't tell
  // them apart and most predate this filter so they're almost certainly
  // real.
  const includeInternal = req.query?.includeInternal === "1" || req.query?.includeInternal === "true";
  function isInternalEvent(r) {
    const f = r.fields || {};
    if (f["Internal"] === true) return true;
    const c = (f["Country"] || "").toString().trim().toUpperCase();
    if (c && c !== "US") return true;
    return false;
  }
  const dropInternal = arr => includeInternal ? arr : arr.filter(r => !isInternalEvent(r));

  // Channel filter — restricts KPIs/cards to a single marketing channel.
  // Pass `?channel=meta` etc. (see CHANNEL_FILTERS above). Empty = no filter.
  const channelKey = (req.query?.channel || "").toString().toLowerCase().trim();
  const channel = channelKey && CHANNEL_FILTERS[channelKey] ? channelKey : "";

  try {
    const cutoffCurr = isoDaysAgo(days);
    const cutoffPrev = isoDaysAgo(days * 2);
    const cutoff12wk = isoDaysAgo(7 * 12);
    const cutoff24h  = isoDaysAgo(1);
    const currMs = Date.parse(cutoffCurr);
    const prevMs = Date.parse(cutoffPrev);

    const [funnelRowsRaw, yelpRows, allJobs, recent24hRaw, formSubmits12wkRaw, coldJobs, recentClients] = await Promise.all([
      // Last 2N days of funnel events covers curr + prev windows
      fetchAll(AT_FUNNEL, { filterByFormula: `IS_AFTER({Timestamp}, DATETIME_PARSE('${cutoffPrev}'))` }),
      fetchAll(AT_YELP,   { filterByFormula: `IS_AFTER({Week ending}, DATETIME_PARSE('${cutoff12wk}'))` }),
      // ALL jobs (limited fields) — needed for channel split, prev-period
      // delta, and repeat-customer detection. Volume is small (<1k rows) so
      // pulling the full table once per request is fine.
      fetchAll(AT_JOBS, {
        "fields[]": [
          "Job ID", "Client", "Service type", "Lead origin",
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
      // Clients created in the current window with a phone number — used to
      // detect "partial leads": someone typed their name+phone on the form,
      // an alert fired, but they never hit Submit (so no Job was created).
      // We filter in JS for missing Jobs link rather than in the formula
      // because empty-linked-record checks across base versions are fiddly.
      fetchAll(AT_CLIENTS, {
        filterByFormula: `AND(IS_AFTER({First contacted}, DATETIME_PARSE('${cutoffCurr}')), NOT({Phone}=BLANK()))`,
        "fields[]": ["Name", "Full name", "Phone", "Email", "Address", "Source", "UTM source", "First contacted", "Jobs"],
      }),
    ]);

    // Drop internal/non-US events from every funnel-event aggregation
    // (KPIs, web funnel, channel mix, leads-by-source, recent activity).
    // The toggle on the dashboard sets ?includeInternal=1 to bypass.
    let funnelRows      = dropInternal(funnelRowsRaw);
    let recent24h       = dropInternal(recent24hRaw);
    let formSubmits12wk = dropInternal(formSubmits12wkRaw);
    const filteredOutCount = (funnelRowsRaw.length - funnelRows.length)
                           + (recent24hRaw.length - recent24h.length)
                           + (formSubmits12wkRaw.length - formSubmits12wk.length);

    // Apply channel filter to event-based aggregations. Jobs + Clients get
    // filtered separately further down where they're used.
    if (channel) {
      funnelRows      = funnelRows.filter(r => eventMatchesChannel(r, channel));
      recent24h       = recent24h.filter(r => eventMatchesChannel(r, channel));
      formSubmits12wk = formSubmits12wk.filter(r => eventMatchesChannel(r, channel));
    }
    const filteredJobs = channel
      ? allJobs.filter(j => jobMatchesChannel(j, channel))
      : allJobs;
    const filteredColdJobs = channel
      ? coldJobs.filter(j => jobMatchesChannel(j, channel))
      : coldJobs;
    // Restrict to clients that actually came through the WordPress widget.
    // Angi-ingested leads, manually-created chat clients, etc. would
    // otherwise inflate the partial-form / landing-leads count and break
    // funnel monotonicity (Partial > CTA clicks).
    //
    // After the attribution backfill (dbacc13), Source is no longer always
    // "Website" — widget visitors who arrived from a Meta ad now have
    // Source="Meta ads", Yelp visitors have Source="Yelp", etc. So we
    // accept any of the known widget-channel Source values. We deliberately
    // exclude "Angi" because that one is ambiguous: it's set both by the
    // widget (when a visitor lands via an Angi referral) and by the email
    // ingest flow at /api/ops?action=ingest-lead. Excluding Angi means
    // widget-from-Angi leads (rare) won't be counted, which is a tradeoff
    // worth taking to keep email-ingested Angi leads out of the landing
    // page funnel.
    const WIDGET_SOURCES = new Set(["Website", "Meta ads", "Yelp", "Google", "Bing"]);
    const widgetSourceClients = (recentClients || []).filter(c =>
      WIDGET_SOURCES.has((c.fields["Source"] || "").toString().trim())
    );
    const filteredRecentClients = channel
      ? widgetSourceClients.filter(c => clientMatchesChannel(c, channel))
      : widgetSourceClients;

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
    for (const j of filteredJobs) {
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
      const ch = j.fields["Lead origin"] || "(unset)";
      const grp = channelGroup(ch);
      groupCurrCount[grp] += 1;
      channelStats[ch] ||= { quoted: 0, booked: 0, dollars: 0 };
      channelStats[ch].booked  += 1;
      channelStats[ch].dollars += Number(j.fields["Quote amount"] || 0);
    }
    for (const j of jobsPrevBooked) {
      const grp = channelGroup(j.fields["Lead origin"] || "(unset)");
      groupPrevCount[grp] += 1;
    }
    for (const j of jobsCurrQuoted) {
      const ch = j.fields["Lead origin"] || "(unset)";
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
    const coldLeads = filteredColdJobs
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
          channel:    j.fields["Lead origin"] || "",
          dollars:    Math.round(Number(j.fields["Quote amount"] || 0)),
          priorCount,
          daysSincePrior,
          bookingDate: j.fields["Booking date"] || null,
        };
      })
      .sort((a, b) => (a.bookingDate < b.bookingDate ? 1 : -1));

    // ── Partial leads (started form but didn't submit) ──────────────────────
    // A Client created in this window with a phone number but NO linked Jobs
    // is, by construction, someone who fired the partial-capture flow in
    // /api/estimate but never hit Submit. We sort newest-first so the most
    // recent abandoners (still warm enough to follow up) are on top.
    // Action-items card: clients who entered name+phone but never submitted
    // (no linked Job). Sorted newest-first, capped at 30.
    const partialLeads = filteredRecentClients
      .filter(c => {
        const jobs = c.fields["Jobs"];
        return !jobs || (Array.isArray(jobs) && jobs.length === 0);
      })
      .map(c => {
        const utm = (c.fields["UTM source"] || "").toString().toLowerCase().trim();
        return {
          id:             c.id,
          name:           c.fields["Full name"] || c.fields["Name"] || "(no name yet)",
          phone:          c.fields["Phone"] || "",
          email:          c.fields["Email"] || "",
          address:        c.fields["Address"] || "",
          source:         c.fields["Source"] || "",
          utmSource:      utm,
          channel:        utm || "direct",
          firstContacted: c.fields["First contacted"] || null,
        };
      })
      .sort((a, b) => (a.firstContacted < b.firstContacted ? 1 : a.firstContacted > b.firstContacted ? -1 : 0))
      .slice(0, 30);

    // ── Web funnel + marketing pipeline metrics ─────────────────────────────
    // The funnel is monotonically decreasing as visitors drop off. We count
    // each stage by UNIQUE SESSIONS, not raw event counts, so a single visitor
    // who clicks 3 times = 1 CTA click in the funnel. To guarantee
    // monotonicity (Sessions ≥ CTA ≥ Partial ≥ Submit ≥ Quote), each stage
    // includes sessions that fired its own event OR any event from a deeper
    // stage. If a session somehow partials without firing a CTA-click event
    // (mobile autofill bypassing focus listeners, etc.), they still count as
    // having "reached CTA" because they obviously got past that point.
    const sBy = { page: new Set(), cta: new Set(), partial: new Set(), submit: new Set(), quote: new Set() };
    for (const r of funnelRows) {
      const t = r.fields["Timestamp"];
      if (!t || Date.parse(t) < currMs) continue;
      const sid = r.fields["Session ID"];
      if (!sid) continue;
      const ev = r.fields["Event type"];
      if (ev === "Page view")        sBy.page.add(sid);
      else if (ev === "CTA click")   sBy.cta.add(sid);
      else if (ev === "Partial captured") sBy.partial.add(sid);
      else if (ev === "Form submitted")   sBy.submit.add(sid);
      else if (ev === "Quote sent")       sBy.quote.add(sid);
    }
    // Stage-roll-up: each lower stage is also "in" the higher stages because
    // they obviously passed through them.
    const submitSessions  = new Set([...sBy.submit, ...sBy.quote]);
    const partialSessions = new Set([...sBy.partial, ...submitSessions]);
    const ctaSessions     = new Set([...sBy.cta, ...partialSessions]);
    const pageSessions    = new Set([...sBy.page, ...ctaSessions]);

    const sessionsCurr  = pageSessions.size;
    const pageViewsCurr = eventCounts.curr["Page view"] || 0;
    const pagesPerSession = sessionsCurr ? +((pageViewsCurr / sessionsCurr).toFixed(2)) : 0;
    const ctaClicksCurr = ctaSessions.size;
    const partialCurr   = partialSessions.size;
    const formSubsCurr  = submitSessions.size;
    const quoteSentCurr = sBy.quote.size;

    // Landing page leads = unique CLIENTS that had a Form submitted OR
    // Partial captured event in the window. This counts both brand-new
    // visitors AND returning customers who came back through the form —
    // matching Luke's mental model of "how many actual landing-page lead
    // interactions did I get this period." The previous client-creation
    // -date approach undercounted returning visitors (their Client record
    // was created in a prior window so they didn't show up).
    //
    // funnelRows is already channel-filtered above, so this naturally
    // respects the dashboard's channel dropdown.
    const landingClientIds = new Set();
    for (const r of funnelRows) {
      const t = r.fields["Timestamp"];
      if (!t || Date.parse(t) < currMs) continue;
      const ev = r.fields["Event type"];
      if (ev !== "Form submitted" && ev !== "Partial captured") continue;
      const clients = r.fields["Client"] || [];
      if (clients.length) landingClientIds.add(clients[0]);
    }
    const landingLeadsCount = landingClientIds.size;

    // Build clientId → jobs index from the (unfiltered) full Jobs set so
    // we can resolve a landing-page client to its actual job outcomes.
    const jobsByClient = {};
    for (const j of allJobs) {
      const cid = (j.fields["Client"] || [])[0];
      if (cid) (jobsByClient[cid] ||= []).push(j);
    }
    let landingQuotedCount = 0;
    let landingBookedCount = 0;
    for (const cid of landingClientIds) {
      const jobs = jobsByClient[cid] || [];
      // A landing-page lead counts as Quoted/Booked if ANY of its jobs has
      // a Quote/Booking date inside the window.
      if (jobs.some(j => inWindow(j.fields["Quote date"],   currMs))) landingQuotedCount++;
      if (jobs.some(j => inWindow(j.fields["Booking date"], currMs))) landingBookedCount++;
    }

    // ── Recent activity (last 24h) ─────────────────────────────────────────
    const recent = recent24h
      .map(r => ({
        time:      r.fields["Timestamp"] || null,
        eventType: r.fields["Event type"] || "?",
        source:    r.fields["UTM source"] || "",
        notes:     r.fields["Notes"]      || "",
        country:   r.fields["Country"]    || "",
        internal:  r.fields["Internal"] === true,
      }))
      .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))
      .slice(0, 100);

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      windowDays: days,
      includeInternal,
      filteredOutCount, // for the dashboard's "N internal events hidden" hint
      channel,          // currently-applied channel filter (echo back for UI)
      channels:         Object.entries(CHANNEL_FILTERS).map(([k, v]) => ({ key: k, label: v.label })),
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
        // Partial-form captures — counted as leads even though they didn't submit.
        // This counts the actionable bucket (didn't yet hit Submit). The
        // inclusive "anyone who entered name+phone" count is in `funnel.partial` below.
        partialLeads: { value: partialLeads.length, prev: null, change: null },
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
      partialLeads,
      // 5-stage web funnel (Sessions → CTA → Partial → Submit → Chatbot quote)
      // and the marketing pipeline (Landing-page leads → Quoted → Booked).
      // All percentages computed client-side from these raw counts.
      funnel: {
        // Web inbound funnel — all counts are UNIQUE SESSIONS, with each
        // lower stage rolled up into higher stages so we're monotonic by
        // construction (a session that submitted but didn't fire a CTA
        // click event still counts as "reached CTA").
        sessions:        sessionsCurr,
        pageViews:       pageViewsCurr,
        pagesPerSession,
        ctaClicks:       ctaClicksCurr,
        partial:         partialCurr,
        formSubmits:     formSubsCurr,
        chatbotQuotes:   quoteSentCurr,
        // Marketing pipeline is record-based: "Landing leads" counts every
        // Client record from the widget (those who entered name+phone),
        // regardless of session tracking. This is the right denominator
        // for "how many leads did the landing page generate" → quoted/booked.
        // For the first week after the Partial-captured event ships,
        // landingLeads can be higher than funnel.partial because legacy
        // partials don't have a tracked session — they'll converge as old
        // data ages out.
        landingLeads:    landingLeadsCount,
        landingQuoted:   landingQuotedCount,
        landingBooked:   landingBookedCount,
      },
    });
  } catch (err) {
    console.error("[dashboard-data] error:", err);
    return res.status(500).json({ error: err.message || "dashboard-data failed" });
  }
}
