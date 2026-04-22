// ─── Telegram webhook: handles inline-keyboard taps + Edit reply text ─────
// Set this as the webhook URL for the Telegram bot:
//   https://chatbot-t1bk.vercel.app/api/telegram-webhook
//
// Callback buttons from api/sms.js fire POSTs here with callback_data of
// the form "send:<conv_id>" / "edit:<conv_id>" / "reject:<conv_id>".
// Luke's typed-edit replies come in as regular messages with
// reply_to_message.message_id === the Edit prompt's id we stored on the
// Conversation row.

const AT_BASE        = process.env.AIRTABLE_BASE_ID;
const AT_KEY         = process.env.AIRTABLE_API_KEY;
const AT_CLIENTS       = "Clients";
const AT_CONVERSATIONS = "Conversations";
const AT_EDIT_LOG    = "Edit Log";

function atUrl(table)  { return `https://api.airtable.com/v0/${AT_BASE}/${encodeURIComponent(table)}`; }
function atHeaders()   { return { Authorization: `Bearer ${AT_KEY}`, "Content-Type": "application/json" }; }
function htmlEscape(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// ─── Telegram helpers ──────────────────────────────────────────────────
async function tgCall(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) console.error(`[tg-webhook] ${method} error:`, data);
  return data;
}
const tgSend          = (payload) => tgCall("sendMessage",        { chat_id: process.env.TELEGRAM_CHAT_ID, parse_mode: "HTML", ...payload });
const tgEdit          = (payload) => tgCall("editMessageText",    { chat_id: process.env.TELEGRAM_CHAT_ID, parse_mode: "HTML", ...payload });
const tgAnswerCb      = (id, txt) => tgCall("answerCallbackQuery", { callback_query_id: id, text: txt || "" });

// ─── Airtable helpers ──────────────────────────────────────────────────
async function getConversation(id) {
  try {
    const res = await fetch(`${atUrl(AT_CONVERSATIONS)}/${id}`, { headers: atHeaders() });
    return res.json();
  } catch { return null; }
}

async function updateConversation(id, fields) {
  const res = await fetch(`${atUrl(AT_CONVERSATIONS)}/${id}`, {
    method: "PATCH",
    headers: atHeaders(),
    body: JSON.stringify({ fields, typecast: true }),
  });
  return res.json();
}

async function findConversationByEditPromptId(promptMsgId) {
  try {
    const formula = `{Telegram_Edit_Prompt_Id}='${promptMsgId}'`;
    const url = `${atUrl(AT_CONVERSATIONS)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
    const res = await fetch(url, { headers: atHeaders() });
    const data = await res.json();
    return data.records?.[0] || null;
  } catch { return null; }
}

async function createEditLogRow(fields) {
  try {
    const res = await fetch(atUrl(AT_EDIT_LOG), {
      method: "POST",
      headers: atHeaders(),
      body: JSON.stringify({ fields, typecast: true }),
    });
    return res.json();
  } catch (err) { console.error("[tg-webhook] edit log create error:", err); return null; }
}

// ─── Phone + client helpers (for /text + contact imports) ─────────────
function parsePhoneToE164(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10)                         return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  // Already international-ish (e.g. 44xxxxxxxxxx) — just add +
  return `+${digits}`;
}

async function findClientByPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  const last10 = digits.slice(-10);
  if (last10.length !== 10) return null;
  const formula = `FIND('${last10}', REGEX_REPLACE({Phone} & '', '[^0-9]', ''))`;
  const url     = `${atUrl(AT_CLIENTS)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  try {
    const res  = await fetch(url, { headers: atHeaders() });
    const data = await res.json();
    return data.records?.[0] || null;
  } catch (err) {
    console.error("[tg-webhook] findClientByPhone error:", err);
    return null;
  }
}

// Upsert a client row by phone. If name is provided and the existing row
// has no Name (or Name === "Unknown"), patch it in. Returns the record id.
async function upsertClientByPhone(phone, name) {
  const existing = await findClientByPhone(phone);
  if (existing) {
    const existingName = (existing.fields?.Name || "").trim();
    const shouldUpdateName = name && (!existingName || existingName.toLowerCase() === "unknown");
    if (shouldUpdateName) {
      try {
        await fetch(`${atUrl(AT_CLIENTS)}/${existing.id}`, {
          method: "PATCH",
          headers: atHeaders(),
          body: JSON.stringify({ fields: { Name: name }, typecast: true }),
        });
      } catch (err) { console.error("[tg-webhook] client name patch error:", err); }
    }
    return { id: existing.id, wasExisting: true, previousName: existingName };
  }
  try {
    const res = await fetch(atUrl(AT_CLIENTS), {
      method: "POST",
      headers: atHeaders(),
      body: JSON.stringify({
        fields: {
          Name:   name || "Unknown",
          Phone:  phone,
          Source: "Telegram",
        },
        typecast: true,
      }),
    });
    const data = await res.json();
    if (data?.id) return { id: data.id, wasExisting: false, previousName: null };
  } catch (err) { console.error("[tg-webhook] client create error:", err); }
  return null;
}

async function createOutboundConversation(clientId, bodyText) {
  try {
    const res = await fetch(atUrl(AT_CONVERSATIONS), {
      method: "POST",
      headers: atHeaders(),
      body: JSON.stringify({
        fields: {
          Client:        clientId ? [clientId] : undefined,
          Direction:     "outbound",
          Status:        "sent",
          Channel:       "SMS",
          Message:       bodyText,
          Final_Message: bodyText,
          Sent_At:       new Date().toISOString(),
        },
        typecast: true,
      }),
    });
    return res.json();
  } catch (err) {
    console.error("[tg-webhook] outbound conv log error:", err);
    return null;
  }
}

// ─── Twilio outbound SMS ───────────────────────────────────────────────
async function sendTwilioSms(to, bodyText) {
  const sid  = process.env.TWILIO_ACCOUNT_SID;
  const tok  = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !tok || !from) throw new Error("Twilio env vars not set");
  const url   = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth  = Buffer.from(`${sid}:${tok}`).toString("base64");
  const form  = new URLSearchParams({ To: to, From: from, Body: bodyText });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    const code = data.code ? ` (code ${data.code})` : "";
    const more = data.more_info ? ` — ${data.more_info}` : "";
    throw new Error(`Twilio error${code}: ${data.message || res.status}${more}`);
  }
  return data;
}

// ─── Security: only respond to Luke's chat ────────────────────────────
function chatIdMatches(update) {
  const expected = String(process.env.TELEGRAM_CHAT_ID || "");
  const cb  = update.callback_query;
  const msg = update.message;
  const chatId = String(cb?.message?.chat?.id || msg?.chat?.id || "");
  return chatId && chatId === expected;
}

// ─── Callback handlers ────────────────────────────────────────────────
async function handleCallbackQuery(cb) {
  const data   = cb.data || "";
  const msgId  = cb.message?.message_id;
  const [action, convId] = data.split(":");
  if (!action || !convId) {
    await tgAnswerCb(cb.id, "Unknown action");
    return;
  }

  const convoRes = await getConversation(convId);
  const convo = convoRes?.fields;
  if (!convo) {
    await tgAnswerCb(cb.id, "Conversation not found");
    return;
  }

  if (action === "send") {
    const draft = convo.Draft_Message || convo.Message || "";
    const to    = convo["Customer phone"];
    if (!to || !draft) { await tgAnswerCb(cb.id, "Missing draft or phone"); return; }
    try {
      await sendTwilioSms(to, draft);
    } catch (err) {
      console.error("[tg-webhook] Twilio send failed:", err);
      await tgAnswerCb(cb.id, "Twilio send failed");
      const detail = htmlEscape((err && err.message) || "unknown error");
      await tgEdit({
        message_id: msgId,
        text: `${htmlEscape(cb.message.text || "")}\n\n⚠️ <b>Twilio send FAILED</b>\n<code>${detail}</code>\n\n<i>Customer did NOT receive this.</i>`,
      });
      return;
    }
    await updateConversation(convId, {
      "Status":        "sent",
      "Final_Message": draft,
      "Sent_At":       new Date().toISOString(),
    });
    await tgAnswerCb(cb.id, "Sent ✅");
    // Strip buttons, annotate the message so Luke sees what happened.
    const originalHtml = (cb.message.text || "").replace(/\n?\u2705.*/gs, "");
    await tgEdit({
      message_id: msgId,
      text: rebuildMessage(cb.message, "✅ <b>Sent as drafted</b>"),
      reply_markup: { inline_keyboard: [] },
    });
    return;
  }

  if (action === "reject") {
    await updateConversation(convId, { "Status": "rejected" });
    await tgAnswerCb(cb.id, "Rejected");
    await tgEdit({
      message_id: msgId,
      text: rebuildMessage(cb.message, "❌ <b>Rejected — nothing sent to customer</b>"),
      reply_markup: { inline_keyboard: [] },
    });
    return;
  }

  if (action === "edit") {
    // Send a prompt the user must reply TO, so their typed response arrives
    // with reply_to_message set — we use that to match back to convId.
    const prompt = await tgSend({
      text: `✏️ <i>Reply to this message with your edited version. I'll send that to the customer instead of the Haiku draft.</i>`,
      reply_markup: { force_reply: true, selective: true },
      // Bind the force_reply to the approval message — hint for the user
      reply_parameters: { message_id: msgId },
    });
    const promptId = prompt?.result?.message_id;
    if (promptId) {
      await updateConversation(convId, {
        "Status":                   "waiting_for_edit",
        "Telegram_Edit_Prompt_Id":  String(promptId),
      });
    }
    await tgAnswerCb(cb.id, "Type your edit as a reply below");
    return;
  }

  await tgAnswerCb(cb.id, "Unknown action");
}

// Helper to append a status note to the approval message while keeping the
// original context visible.
function rebuildMessage(originalMessage, statusHtml) {
  // Telegram gives us .text (plain) and .entities, but we originally sent
  // HTML. Simpler: re-pull Message.text_html if available, else fall back to
  // the plain text (which loses the <pre> blocks). Plain is fine — Luke
  // can still read it.
  const base = (originalMessage?.text || "").trim();
  return `${htmlEscape(base)}\n\n${statusHtml}`;
}

// ─── Edit-reply handler ───────────────────────────────────────────────
async function handleEditReply(msg) {
  const replyTo   = msg.reply_to_message;
  const promptId  = replyTo?.message_id;
  const editedText = (msg.text || "").trim();
  if (!promptId || !editedText) return;

  const convRecord = await findConversationByEditPromptId(promptId);
  if (!convRecord) {
    // Not an edit-reply we're tracking — ignore silently
    return;
  }
  const convId = convRecord.id;
  const convo  = convRecord.fields;
  const to     = convo["Customer phone"];
  const draft  = convo.Draft_Message || "";

  if (!to) {
    await tgSend({ text: "⚠️ Can't send — no customer phone on that Conversation row." });
    return;
  }

  try {
    await sendTwilioSms(to, editedText);
  } catch (err) {
    console.error("[tg-webhook] Twilio edit send failed:", err);
    await tgSend({ text: `⚠️ <b>Twilio send FAILED</b>: ${htmlEscape(err.message || "unknown")}` });
    return;
  }

  // Mark the Conversation sent (with the edited body)
  await updateConversation(convId, {
    "Status":        "sent",
    "Final_Message": editedText,
    "Sent_At":       new Date().toISOString(),
  });

  // Log the edit for Phase 2 learning
  if (draft && draft !== editedText) {
    await createEditLogRow({
      "Conversation": [convId],
      "Client":       convo.Client || undefined,
      "Draft":        draft,
      "Final":        editedText,
      "Created_At":   new Date().toISOString(),
    });
  }

  // Edit the ORIGINAL approval message to show it was sent (if we still know its id)
  const originalMsgId = convo.Telegram_Message_Id;
  if (originalMsgId) {
    await tgEdit({
      message_id: parseInt(originalMsgId, 10),
      text: `✏️ <b>Edited & sent</b>\n\n<b>What was sent:</b>\n<pre>${htmlEscape(editedText)}</pre>`,
      reply_markup: { inline_keyboard: [] },
    });
  }

  // Brief confirmation
  await tgSend({ text: `✅ <i>Sent your edited version to ${htmlEscape(to)}.</i>` });
}

// ─── /text command: Luke initiates an outbound SMS to any number ──────
// Format: /text +12155551234 Your message here
// If the number isn't in Airtable yet, a stub Client row is created.
// Message is sent immediately — no approval loop (Luke wrote it himself).
async function handleTextCommand(msg) {
  const text = (msg.text || "").trim();
  // First whitespace-separated token after "/text" = phone; rest = message
  const match = text.match(/^\/text\s+(\S+)\s+([\s\S]+)$/);
  if (!match) {
    await tgSend({
      text: `⚠️ <b>Usage</b>\n<code>/text +12155551234 Your message here</code>\n\nPhone can be 10 digits, +1 formatted, or any E.164 number (no spaces in the phone portion).`,
    });
    return;
  }
  const phoneRaw = match[1];
  const bodyText = match[2].trim();
  const phone    = parsePhoneToE164(phoneRaw);
  if (!phone || !bodyText) {
    await tgSend({ text: "⚠️ Couldn't parse phone or message body." });
    return;
  }

  // Upsert the client (creates stub if new)
  const clientResult = await upsertClientByPhone(phone, null);
  const clientId     = clientResult?.id || null;
  const wasExisting  = !!clientResult?.wasExisting;
  const existingName = clientResult?.previousName || null;

  // Fire the SMS
  try {
    await sendTwilioSms(phone, bodyText);
  } catch (err) {
    console.error("[tg-webhook] outbound /text send failed:", err);
    await tgSend({
      text: `⚠️ <b>Twilio send FAILED</b> to <code>${htmlEscape(phone)}</code>\n<code>${htmlEscape(err.message || "unknown error")}</code>`,
    });
    return;
  }

  // Log it to Conversations so it shows up in history on the next inbound
  await createOutboundConversation(clientId, bodyText);

  const who = wasExisting
    ? (existingName ? `<b>${htmlEscape(existingName)}</b> ` : "existing client ")
    : "<i>new client (stub created in Airtable)</i> ";
  await tgSend({
    text: `✅ Sent to ${who}<code>${htmlEscape(phone)}</code>\n<pre>${htmlEscape(bodyText)}</pre>`,
  });
}

// ─── Shared contact card: auto-import into Airtable Clients ───────────
// Fires when Luke taps 📎 → Contact → picks someone from his phone.
async function handleContactShared(msg) {
  const c = msg.contact;
  if (!c || !c.phone_number) {
    await tgSend({ text: "⚠️ That contact had no phone number." });
    return;
  }
  const phone = parsePhoneToE164(c.phone_number);
  const first = (c.first_name || "").trim();
  const last  = (c.last_name  || "").trim();
  const name  = [first, last].filter(Boolean).join(" ").trim() || null;
  if (!phone) {
    await tgSend({ text: "⚠️ Couldn't parse that contact's phone number." });
    return;
  }

  const result = await upsertClientByPhone(phone, name);
  if (!result?.id) {
    await tgSend({ text: "⚠️ Couldn't save that contact to Airtable." });
    return;
  }

  const label = name || "Unknown";
  if (result.wasExisting) {
    const wasEmpty = !result.previousName || result.previousName.toLowerCase() === "unknown";
    const verb = wasEmpty && name ? "Updated name on existing client" : "Already in Airtable";
    await tgSend({
      text: `✅ <b>${verb}</b>: ${htmlEscape(label)} <code>${htmlEscape(phone)}</code>`,
    });
  } else {
    await tgSend({
      text: `✅ <b>Added to Airtable</b>: ${htmlEscape(label)} <code>${htmlEscape(phone)}</code>\n<i>You can now /text them and they'll be recognized on reply.</i>`,
    });
  }
}

// ─── /help: cheat-sheet ───────────────────────────────────────────────
async function handleHelp() {
  await tgSend({
    text:
`<b>LP bot commands</b>

<code>/text +12155551234 your message</code>
Text a customer directly. Creates/matches the Client in Airtable and logs the outbound SMS.

<code>/help</code>
This menu.

<b>Tricks</b>
• 📎 → <b>Contact</b> → pick someone from your phone → I'll auto-add them to Airtable Clients.
• Reply to any ✏️ <i>Edit</i> prompt with your rewrite to override the Haiku draft.
• Tap ✅ / ✏️ / ❌ on inbound SMS alerts.`,
  });
}

// ─── Handler ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("ok"); // Telegram health checks
  const update = req.body || {};

  // Ignore anything from someone else's chat
  if (!chatIdMatches(update)) {
    console.warn("[tg-webhook] ignoring update from non-matching chat");
    return res.status(200).send("ok");
  }

  try {
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    } else if (update.message?.contact) {
      // Shared contact card → add/update in Airtable
      await handleContactShared(update.message);
    } else if (typeof update.message?.text === "string" && /^\/text(\s|$)/.test(update.message.text)) {
      await handleTextCommand(update.message);
    } else if (typeof update.message?.text === "string" && /^\/help(\s|$)/.test(update.message.text)) {
      await handleHelp();
    } else if (update.message && update.message.reply_to_message) {
      await handleEditReply(update.message);
    }
    // Plain messages without a reply_to go ignored — keeps the bot from
    // reacting to random chatter in the Telegram thread.
  } catch (err) {
    console.error("[tg-webhook] handler error:", err);
  }

  return res.status(200).send("ok");
}
