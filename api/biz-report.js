import Anthropic from "@anthropic-ai/sdk";

// ─── Biz-ops report ──────────────────────────────────────────────────────────
// Runs on a Vercel Cron (see vercel.json). Queries the last N hours of Airtable
// Clients + Jobs, aggregates stats, asks Claude Haiku to write a narrative
// summary, and pushes it to Luke's Telegram.
//
// Default window: 48h. Override via ?hours=N if manually triggered.
//
// Required env vars (all already set for the estimate flow):
//   AIRTABLE_API_KEY, AIRTABLE_BASE_ID
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   ANTHROPIC_API_KEY

const AIRTABLE_BASE     = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_KEY      = process.env.AIRTABLE_API_KEY;
const TELEGRAM_BOT      = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT     = process.env.TELEGRAM_CHAT_ID;

function airtableUrl(table) {
  return `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(table)}`;
}

// Fetch every record created in the last `hoursBack` hours from a table.
// Uses Airtable's built-in CREATED_TIME() formula so we don't depend on any
// specific "created" field existing on the table.
async function getRecentRecords(tableName, hoursBack) {
  const cutoffIso = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString();
  const formula = `IS_AFTER(CREATED_TIME(), DATETIME_PARSE('${cutoffIso}'))`;
  const records = [];
  let offset = null;
  do {
    const params = new URLSearchParams({ filterByFormula: formula });
    if (offset) params.set("offset", offset);
    const res = await fetch(`${airtableUrl(tableName)}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
    });
    const data = await res.json();
    if (data.error) throw new Error(`Airtable ${tableName}: ${data.error.message || data.error.type}`);
    records.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return records;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT || !TELEGRAM_CHAT) return;
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[biz-report] telegram error:", res.status, body);
  }
}

export default async function handler(req, res) {
  const hoursBack = Math.max(1, Math.min(168, parseInt(req.query?.hours || "48", 10) || 48));

  try {
    console.log(`[biz-report] querying last ${hoursBack}h`);
    const [clients, jobs] = await Promise.all([
      getRecentRecords("Clients", hoursBack),
      getRecentRecords("Jobs",    hoursBack),
    ]);

    // Attribution breakdown from new Clients (UTM source is only on Clients)
    const bySource = {};
    for (const c of clients) {
      const src = (c.fields["UTM source"] || "").trim() || "direct/unknown";
      bySource[src] = (bySource[src] || 0) + 1;
    }

    // Build job-level summaries for Claude to reason over
    const jobSummaries = jobs.map(j => ({
      service:    j.fields["Service type"]  || "(unknown)",
      quoteText:  j.fields["Quote"]         || "",
      amount:     j.fields["Quote amount"]  || 0,
      status:     j.fields["Lead status"]   || "",
      bookingDate:j.fields["Booking date"]  || null,
      clientName: null, // filled below
    }));

    // Index clients by record ID so we can attach names + sources to jobs
    const clientIndex = {};
    for (const c of clients) clientIndex[c.id] = c.fields;
    // Fetch client names for any jobs whose Client isn't in this window's set
    // (e.g. a quote came in within 48h for a Client created earlier).
    const missingClientIds = new Set();
    for (let i = 0; i < jobs.length; i++) {
      const linked = jobs[i].fields["Client"] || [];
      if (linked.length && !clientIndex[linked[0]]) missingClientIds.add(linked[0]);
    }
    if (missingClientIds.size) {
      const ids = [...missingClientIds];
      const formula = `OR(${ids.map(id => `RECORD_ID()='${id}'`).join(",")})`;
      const r = await fetch(`${airtableUrl("Clients")}?filterByFormula=${encodeURIComponent(formula)}`, {
        headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
      }).then(r => r.json()).catch(() => ({ records: [] }));
      for (const c of (r.records || [])) clientIndex[c.id] = c.fields;
    }
    for (let i = 0; i < jobs.length; i++) {
      const linked = jobs[i].fields["Client"] || [];
      const cf = linked[0] ? clientIndex[linked[0]] : null;
      jobSummaries[i].clientName = cf ? (cf["Name"] || "(unnamed)") : "(no client)";
      jobSummaries[i].clientSource = cf ? (cf["UTM source"] || "direct/unknown") : "unknown";
    }

    const totalQuoted = jobSummaries.reduce((s, j) => s + (Number(j.amount) || 0), 0);
    const bookedJobs  = jobSummaries.filter(j => j.status === "Booked");
    const totalBooked = bookedJobs.reduce((s, j) => s + (Number(j.amount) || 0), 0);
    const unbookedQuoted = jobSummaries.filter(j => j.status !== "Booked" && j.amount > 0);

    const stats = {
      window_hours:        hoursBack,
      new_clients:         clients.length,
      new_quotes:          jobs.length,
      bookings:            bookedJobs.length,
      total_quoted_usd:    Math.round(totalQuoted),
      total_booked_usd:    Math.round(totalBooked),
      leads_to_quote_pct:  clients.length ? Math.round(100 * jobs.length / clients.length) : null,
      quote_to_book_pct:   jobs.length ? Math.round(100 * bookedJobs.length / jobs.length) : null,
      by_source:           bySource,
      all_jobs:            jobSummaries,
      unbooked_quoted:     unbookedQuoted.map(j => ({ name: j.clientName, service: j.service, amount: j.amount, quoteText: j.quoteText, source: j.clientSource })),
    };

    // Hand the raw stats to Claude Haiku for a human-readable narrative.
    const anthropic = new Anthropic();
    const claudeResp = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1200,
      system: `You are writing a biz-ops report for Luke, owner of LP Pressure Wash (a small local pressure-washing business). Your reports go to his Telegram and should be tight, actionable, and human — not corporate.

Format: Telegram HTML (supported tags: <b>, <i>, <u>, <s>, <code>, <pre>). Keep under 3500 chars. Use emojis sparingly (1-3 max).

Structure every report:
1. One-line TL;DR: "N leads, $X quoted, Y booked" — at the top.
2. Bullet stats: new leads · quotes · bookings · $ quoted · $ booked · conversion %.
3. Attribution: which sources sent leads. If ad sources like Yelp underperformed or overperformed, call it out.
4. "⚠️ Worth flagging": 1-3 observations that need Luke's attention. Examples: a quote went out but never booked (name the customer), one source spiked or tanked, conversion dropped.
5. If anyone quoted but didn't book, list them by name so Luke can reach out.

If the window had zero activity, say that in one sentence, suggest checking ad status, and stop. Don't pad.`,
      messages: [{
        role: "user",
        content: `Write the report for this data:\n\n${JSON.stringify(stats, null, 2)}`,
      }],
    });

    const narrative = claudeResp.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")
      .trim();

    const header = `📊 <b>Biz report — last ${hoursBack}h</b>\n\n`;
    await sendTelegram(header + narrative);

    return res.status(200).json({ ok: true, stats });
  } catch (err) {
    console.error("[biz-report] error:", err);
    try {
      await sendTelegram(`⚠️ <b>Biz report failed</b>\n\n${err.message || "unknown error"}`);
    } catch {}
    return res.status(500).json({ error: err.message || "biz-report failed" });
  }
}
