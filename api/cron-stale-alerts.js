// ─── Stale-conversation alerter ─────────────────────────────────────────────
// Runs on a schedule (Vercel cron, Make.com, or cron-job.org). For every
// active website-chat conversation that's gone quiet for 3+ minutes WITHOUT
// reaching a quote, fires a 🕒 Stale Telegram ping with the partial
// transcript so Luke can decide whether to follow up manually.
//
// Marker strategy (no schema changes needed):
//   After alerting we write a Conversations row with a recognizable marker
//   string in {Message}. On the next tick, we skip any client that already
//   has a marker row in the look-back window. This avoids pinging the same
//   stale chat over and over.
//
// Look-back window is 30 min — anything older we treat as a dead lead and
// don't bother pinging (Luke's already moved on by then).

const AT_CLIENTS       = "Clients";
const AT_CONVERSATIONS = "Conversations";
const SOURCE_CHANNEL   = "Website chatbot";
const STALE_MARKER     = "__STALE_ALERT_SENT__";

// How long a chat has to sit idle before we ping (minutes).
const STALE_AFTER_MIN  = 3;
// Don't ping for chats older than this (minutes) — assume Luke has moved on.
const LOOKBACK_MIN     = 30;

function airtableUrl(table) {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`;
}
function airtableHeaders() {
  return { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" };
}

function htmlEscape(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendTelegramNotification(text) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    if (!data.ok) console.log("[cron-stale telegram] send error:", data);
  } catch (err) {
    console.error("[cron-stale telegram] threw:", err);
  }
}

// Page through Airtable to fetch all matching rows. filterByFormula is
// applied server-side; we sort/group in JS.
async function fetchConversationsSince(isoSince) {
  const formula = `AND(IS_AFTER({Timestamp}, '${isoSince}'), {Channel}='${SOURCE_CHANNEL}')`;
  const rows = [];
  let offset;
  do {
    const url = `${airtableUrl(AT_CONVERSATIONS)}?filterByFormula=${encodeURIComponent(formula)}&pageSize=100${offset ? `&offset=${encodeURIComponent(offset)}` : ""}`;
    const res = await fetch(url, { headers: airtableHeaders() });
    if (!res.ok) {
      console.error("[cron-stale] Airtable fetch failed:", res.status, await res.text().catch(() => ""));
      break;
    }
    const data = await res.json();
    rows.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return rows;
}

async function fetchClient(clientId) {
  try {
    const res = await fetch(`${airtableUrl(AT_CLIENTS)}/${clientId}`, { headers: airtableHeaders() });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function logStaleMarker(clientId) {
  try {
    await fetch(airtableUrl(AT_CONVERSATIONS), {
      method: "POST",
      headers: airtableHeaders(),
      body: JSON.stringify({
        fields: {
          "Client":    [clientId],
          "Channel":   SOURCE_CHANNEL,
          "Direction": "Outbound",
          "Author":    "AI bot",
          "Message":   `${STALE_MARKER} (system marker — alerted Luke at ${new Date().toISOString()})`,
          "Timestamp": new Date().toISOString(),
        },
      }),
    });
  } catch (err) {
    console.error("[cron-stale] failed to log marker:", err);
  }
}

function buildTranscript(rows) {
  // Sort ascending so the transcript reads top-to-bottom in chronological order.
  const sorted = [...rows].sort((a, b) =>
    new Date(a.fields.Timestamp || 0) - new Date(b.fields.Timestamp || 0)
  );
  const lines = [];
  for (const r of sorted) {
    const msg = r.fields.Message;
    if (!msg) continue;
    if (typeof msg === "string" && msg.includes(STALE_MARKER)) continue; // skip our own markers
    const role = r.fields.Direction === "Inbound" ? "👤 Customer" : "🤖 Bot";
    // Strip any leftover [QR: ...] markers
    const clean = String(msg).replace(/\[QR:[^\]]*\]/g, "").trim();
    if (!clean) continue;
    lines.push(`${role}: ${clean}`);
  }
  let out = lines.join("\n\n");
  // Telegram <pre> block + surrounding text caps at 4096 chars total. Leave headroom.
  if (out.length > 2400) out = "… earlier turns trimmed …\n\n" + out.slice(out.length - 2400 + 30);
  return out;
}

export default async function handler(req, res) {
  // Optional bearer check so randos can't trigger Telegram spam by hitting
  // the public endpoint. Vercel cron passes Authorization: Bearer $CRON_SECRET
  // automatically when CRON_SECRET is set in env.
  if (process.env.CRON_SECRET) {
    const auth = req.headers?.authorization || "";
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  if (!process.env.AIRTABLE_BASE_ID || !process.env.AIRTABLE_API_KEY) {
    return res.status(500).json({ error: "Airtable not configured" });
  }

  try {
    const now = Date.now();
    const lookbackIso = new Date(now - LOOKBACK_MIN * 60 * 1000).toISOString();
    const rows = await fetchConversationsSince(lookbackIso);

    // Group by Client (linked-record field is an array of one ID).
    const byClient = new Map();
    for (const r of rows) {
      const cid = r.fields.Client?.[0];
      if (!cid) continue;
      if (!byClient.has(cid)) byClient.set(cid, []);
      byClient.get(cid).push(r);
    }

    const alerted = [];
    const skipped = [];

    for (const [clientId, clientRows] of byClient.entries()) {
      // Find newest timestamp among CUSTOMER-FACING rows (skip our own marker
      // rows so a recent marker doesn't fool us into thinking the chat is fresh).
      const realRows = clientRows.filter(r => {
        const msg = r.fields.Message;
        return !(typeof msg === "string" && msg.includes(STALE_MARKER));
      });
      if (realRows.length === 0) { skipped.push({ clientId, why: "only marker rows" }); continue; }

      const latestTs = realRows.reduce((max, r) => {
        const t = new Date(r.fields.Timestamp || 0).getTime();
        return t > max ? t : max;
      }, 0);
      const ageMin = (now - latestTs) / 60000;

      if (ageMin < STALE_AFTER_MIN) { skipped.push({ clientId, why: `still active (${ageMin.toFixed(1)}m)` }); continue; }
      if (ageMin > LOOKBACK_MIN)    { skipped.push({ clientId, why: `too old (${ageMin.toFixed(1)}m)` });    continue; }

      const hasInbound = realRows.some(r => r.fields.Direction === "Inbound");
      if (!hasInbound) { skipped.push({ clientId, why: "no customer messages" }); continue; }

      const gotQuote = realRows.some(r => r.fields.Intent === "quote_sent" || r.fields.Intent === "booking_confirmed");
      if (gotQuote) { skipped.push({ clientId, why: "already quoted/booked" }); continue; }

      const alreadyAlerted = clientRows.some(r => {
        const msg = r.fields.Message;
        return typeof msg === "string" && msg.includes(STALE_MARKER);
      });
      if (alreadyAlerted) { skipped.push({ clientId, why: "already alerted" }); continue; }

      const transcript = buildTranscript(realRows);
      if (!transcript) { skipped.push({ clientId, why: "empty transcript" }); continue; }

      // Pull client info for the header line.
      const client = await fetchClient(clientId);
      const cf = client?.fields || {};
      const firstName = cf["Name"]    || "Unknown";
      const phone     = cf["Phone"]   || "no phone";
      const address   = cf["Address"] || "no address";

      const parts = [
        `🕒 <b>Stale chat — ${htmlEscape(firstName)}</b>`,
        `📞 ${htmlEscape(phone)}`,
        `📍 ${htmlEscape(address)}`,
        `<i>Quiet for ${Math.round(ageMin)} min · no quote reached yet.</i>`,
        "",
        `<b>🗨 Partial transcript:</b>`,
        "",
        `<pre>${htmlEscape(transcript)}</pre>`,
        "",
        `<i>Want to recover this lead? Text/call them now.</i>`,
      ];

      await sendTelegramNotification(parts.join("\n"));
      await logStaleMarker(clientId);
      alerted.push({ clientId, firstName, ageMin: Math.round(ageMin) });
    }

    console.log("[cron-stale] tick", { alertedCount: alerted.length, skippedCount: skipped.length });
    return res.status(200).json({ ok: true, alerted, skippedCount: skipped.length });
  } catch (err) {
    console.error("[cron-stale] handler error:", err);
    return res.status(500).json({ error: err.message });
  }
}
