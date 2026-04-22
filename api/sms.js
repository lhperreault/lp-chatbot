import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";

// ─── Inbound Twilio SMS → Claude draft → Telegram approval prompt ─────────
// When a customer texts the business number:
//   1. Verify Twilio's signature (reject forged webhooks)
//   2. Upsert the Client in Airtable by phone
//   3. Fetch recent Conversation history for context
//   4. Ask Claude Haiku to draft a reply using the LP sales voice
//   5. Write a Conversations row (Status=pending_approval, Draft_Message, ...)
//   6. Send a Telegram message to Luke with the draft + inline buttons
//      [ ✅ Approve & Send ]  [ ✏️ Edit ]  [ ❌ Reject ]
//   7. Store the Telegram message_id on the Conversation row so
//      api/telegram-webhook.js can find it when Luke taps a button.

const AT_BASE        = process.env.AIRTABLE_BASE_ID;
const AT_KEY         = process.env.AIRTABLE_API_KEY;
const AT_CLIENTS     = "Clients";
const AT_CONVERSATIONS = "Conversations";

function atUrl(table)        { return `https://api.airtable.com/v0/${AT_BASE}/${encodeURIComponent(table)}`; }
function atHeaders()         { return { Authorization: `Bearer ${AT_KEY}`, "Content-Type": "application/json" }; }
function htmlEscape(s)       { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function normalizePhone(p)   { return String(p || "").replace(/\D/g, ""); }

// ─── Twilio signature verification ───────────────────────────────────────
function verifyTwilioSignature(req, params) {
  const signature = req.headers["x-twilio-signature"];
  if (!signature || !process.env.TWILIO_AUTH_TOKEN) return false;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host  = req.headers["host"];
  const url   = `${proto}://${host}${req.url}`;
  const sortedKeys = Object.keys(params).sort();
  let signed = url;
  for (const k of sortedKeys) signed += k + params[k];
  const expected = crypto.createHmac("sha1", process.env.TWILIO_AUTH_TOKEN).update(signed).digest("base64");
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ─── Airtable helpers ────────────────────────────────────────────────────
async function findClientByPhone(phone) {
  const digits = normalizePhone(phone);
  if (!digits) return null;
  // Last 10 digits, stripped of all non-digits from {Phone}, compared.
  const last10 = digits.slice(-10);
  const strippedPhone = `SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE({Phone}, '-', ''), ' ', ''), '(', ''), ')', ''), '+', '')`;
  const formula = `FIND('${last10}', ${strippedPhone})`;
  try {
    const url = `${atUrl(AT_CLIENTS)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
    const res = await fetch(url, { headers: atHeaders() });
    const data = await res.json();
    return data.records?.[0] || null;
  } catch { return null; }
}

async function upsertClientByPhone(phone, fallbackName = "(unknown)") {
  const existing = await findClientByPhone(phone);
  if (existing) return { id: existing.id, fields: existing.fields, isNew: false };
  // Create a minimal stub Client row for this phone — Luke can fill in details later.
  const res = await fetch(atUrl(AT_CLIENTS), {
    method: "POST",
    headers: atHeaders(),
    body: JSON.stringify({
      fields: {
        "Name":            fallbackName,
        "Phone":           phone,
        "Source":          "Website", // match existing SOURCE_CLIENTS option
        "First contacted": new Date().toISOString().split("T")[0],
      },
      typecast: true,
    }),
  });
  const data = await res.json();
  if (data.error) { console.error("[sms] upsertClient create error:", data.error); return null; }
  return { id: data.id, fields: data.fields, isNew: true };
}

async function getRecentConversations(clientId, limit = 10) {
  if (!clientId) return [];
  try {
    const formula = `SEARCH('${clientId}', ARRAYJOIN({Client}))`;
    const url = `${atUrl(AT_CONVERSATIONS)}?filterByFormula=${encodeURIComponent(formula)}&sort%5B0%5D%5Bfield%5D=Timestamp&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=${limit}`;
    const res = await fetch(url, { headers: atHeaders() });
    const data = await res.json();
    return (data.records || []).reverse(); // oldest first for chat context
  } catch { return []; }
}

async function createConversationRow(fields) {
  const res = await fetch(atUrl(AT_CONVERSATIONS), {
    method: "POST",
    headers: atHeaders(),
    body: JSON.stringify({ fields, typecast: true }),
  });
  const data = await res.json();
  if (data.error) { console.error("[sms] createConversation error:", data.error); return null; }
  return data;
}

async function updateConversationRow(id, fields) {
  const res = await fetch(`${atUrl(AT_CONVERSATIONS)}/${id}`, {
    method: "PATCH",
    headers: atHeaders(),
    body: JSON.stringify({ fields, typecast: true }),
  });
  return res.json();
}

// ─── Telegram send ────────────────────────────────────────────────────────
async function sendTelegram(payload) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...payload,
    }),
  });
  const data = await res.json();
  if (!data.ok) console.error("[sms] telegram send error:", data);
  return data;
}

// ─── Claude drafting ──────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are drafting a personal SMS reply on behalf of Luke, the owner-operator of LP Pressure Wash (a small local soft-wash / pressure-washing business in the Doylestown, PA area).

Tone: warm, direct, casual — you're Luke texting back a customer from his cell. Not corporate. No markdown, no bullet lists, no links. Like a real person would text.

Rules:
- Keep replies under 320 characters (2 SMS segments max).
- Don't make up prices. If a quote is needed, ask a qualifying question instead of giving a number.
- Business is insured (Hiscox general liability), uses soft-wash methods safe for plants/pets.
- Season starts May 16, 2026; Luke and his brother are finishing college.
- If unsure about scheduling, say "I'll double-check my calendar and confirm."
- End with a friendly sign-off or a question that keeps the conversation moving.
- Never mention "bot", "AI", "system", or anything that suggests the reply was drafted by software.

You will receive: the customer's current message, the client record (name, last quote if any), and up to ~10 prior Conversation entries for context. Draft one reply — no preamble, no "here's your draft:", just the SMS text.`;

async function draftReply(clientRecord, recentConvos, incomingText) {
  const anthropic = new Anthropic();
  const clientName = clientRecord?.fields?.["Name"] || "there";
  const historyLines = recentConvos.map(c => {
    const dir = c.fields?.Direction || "?";
    const msg = c.fields?.Message || c.fields?.["Final_Message"] || c.fields?.["Draft_Message"] || "";
    return `[${dir}] ${msg}`;
  }).join("\n");

  const userMsg = `Client name: ${clientName}
${historyLines ? `Prior conversation history:\n${historyLines}\n\n` : ""}Customer just texted (this is what you're replying to):
"${incomingText}"

Draft Luke's SMS reply.`;

  const resp = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMsg }],
  });

  return resp.content.filter(b => b.type === "text").map(b => b.text).join(" ").trim();
}

// ─── Handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  let body = req.body || {};
  if (typeof body === "string") {
    try { body = Object.fromEntries(new URLSearchParams(body)); } catch { body = {}; }
  }

  const from     = body.From        || "";
  const to       = body.To          || "";
  const text     = body.Body        || "";
  const name     = body.ProfileName || "";
  const numMedia = parseInt(body.NumMedia || "0", 10);

  if (process.env.TWILIO_AUTH_TOKEN) {
    if (!verifyTwilioSignature(req, body)) {
      console.warn("[sms] invalid Twilio signature; rejecting");
      return res.status(403).send("Forbidden");
    }
  } else {
    console.warn("[sms] TWILIO_AUTH_TOKEN not set — accepting unsigned (INSECURE)");
  }

  console.log("[sms] inbound", { from, to, textLen: text.length, numMedia, hasName: !!name });

  // Quick ack so Twilio doesn't time out; do the heavy work async-ish.
  // (Vercel holds the function until the handler returns, so we still await.)

  try {
    // 1. Upsert Client
    const client = await upsertClientByPhone(from, name || "(unknown)");

    // 2. Recent history
    const convos = client ? await getRecentConversations(client.id, 10) : [];

    // 3. Claude draft (fire-and-forget would lose the result, so we await)
    let draft;
    try {
      draft = await draftReply(client, convos, text);
    } catch (err) {
      console.error("[sms] Claude draft failed, falling back:", err);
      draft = `Hey! Got your message — give me a minute and I'll get right back to you.`;
    }
    if (!draft) draft = `Hey! Got your message — give me a minute and I'll get right back to you.`;

    // 4. Log inbound Conversation turn (always, for history)
    if (client) {
      await createConversationRow({
        "Client":     [client.id],
        "Channel":    "Website chatbot", // existing single-select option
        "Direction":  "Inbound",
        "Author":     "Customer",
        "Message":    text,
        "Timestamp":  new Date().toISOString(),
        "Customer phone": from,
        "Source":     "Website",
      }).catch(err => console.error("[sms] inbound log error:", err));
    }

    // 5. Create pending_approval row for the draft
    const convoRow = client ? await createConversationRow({
      "Client":         [client.id],
      "Channel":        "Website chatbot",
      "Direction":      "Outbound",
      "Author":         "AI bot",
      "Message":        draft, // keep Message in sync so downstream tools can read it
      "Draft_Message":  draft,
      "Status":         "pending_approval",
      "Timestamp":      new Date().toISOString(),
      "Customer phone": from,
      "Source":         "Website",
      "Intent":         "sms_draft",
    }) : null;

    if (!convoRow || !convoRow.id) {
      console.error("[sms] couldn't create pending Conversation row; skipping Telegram approval prompt");
      res.setHeader("Content-Type", "text/xml");
      return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }

    // 6. Send Telegram approval prompt with inline buttons
    const label = name ? `${htmlEscape(name)} · ${htmlEscape(from)}` : `${htmlEscape(from)}`;
    const clientDisplay = client?.fields?.Name ? htmlEscape(client.fields.Name) : "(new contact)";
    const telegramText = [
      `💬 <b>Incoming SMS — ${clientDisplay}</b>`,
      `📞 ${label}`,
      numMedia > 0 ? `📎 <i>${numMedia} attachment${numMedia > 1 ? "s" : ""}</i>` : null,
      ``,
      `<b>Customer:</b>`,
      `<pre>${htmlEscape(text || "(no text)")}</pre>`,
      ``,
      `<b>Suggested reply (Claude Haiku draft):</b>`,
      `<pre>${htmlEscape(draft)}</pre>`,
    ].filter(x => x != null).join("\n");

    const tgResp = await sendTelegram({
      text: telegramText,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve & Send", callback_data: `send:${convoRow.id}` },
            { text: "✏️ Edit",           callback_data: `edit:${convoRow.id}` },
            { text: "❌ Reject",          callback_data: `reject:${convoRow.id}` },
          ],
        ],
      },
    });

    // 7. Store Telegram message_id on the Conversation row for later edits
    const tgMsgId = tgResp?.result?.message_id;
    if (tgMsgId) {
      await updateConversationRow(convoRow.id, {
        "Telegram_Message_Id":  String(tgMsgId),
        "Notification_Sent_At": new Date().toISOString(),
      }).catch(err => console.error("[sms] update msg_id error:", err));
    }

    res.setHeader("Content-Type", "text/xml");
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } catch (err) {
    console.error("[sms] handler fatal:", err);
    // Still return 200 to Twilio so it doesn't retry forever
    res.setHeader("Content-Type", "text/xml");
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }
}
