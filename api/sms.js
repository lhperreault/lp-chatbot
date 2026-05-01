import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import { OFFER_PROMPT_BLOCK } from "../lib/currentOffer.js";

// ─── Inbound Twilio SMS → Claude tool-calling draft → Telegram approval ──
// Now a full estimator: Claude has access to the same 6 tools as the
// website form (lookup_property, check_calendar_availability, save_quote_job,
// confirm_booking, book_appointment, upsert_client). When a quote is
// calculated, it's written to Airtable Jobs automatically; when a date is
// locked in, it's booked in Google Calendar. Luke still approves every
// message that goes to the customer via Telegram.

const AT_BASE         = process.env.AIRTABLE_BASE_ID;
const AT_KEY          = process.env.AIRTABLE_API_KEY;
const AT_CLIENTS      = "Clients";
const AT_JOBS         = "Jobs";
const AT_CONVERSATIONS = "Conversations";
const SOURCE_CLIENTS  = "Website";          // Clients.Source — matches existing single-select option
const LEAD_ORIGIN     = "Website";          // Jobs."Lead origin"
const CONVO_CHANNEL   = "Website chatbot";  // Conversations.Channel — medium
const MODEL           = "claude-haiku-4-5";

function atUrl(table)      { return `https://api.airtable.com/v0/${AT_BASE}/${encodeURIComponent(table)}`; }
function atHeaders()       { return { Authorization: `Bearer ${AT_KEY}`, "Content-Type": "application/json" }; }
function htmlEscape(s)     { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function normalizePhone(p) { return String(p || "").replace(/\D/g, ""); }
function prettyDate(yyyyMmDd) {
  if (!yyyyMmDd) return yyyyMmDd;
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const [y, m, d] = yyyyMmDd.split("-").map(n => parseInt(n, 10));
  if (!y || !m || !d) return yyyyMmDd;
  return `${months[m - 1]} ${d}`;
}

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

// ─── Airtable helpers (Client lookup + generic CRUD) ─────────────────────
async function findClientByPhone(phone) {
  const digits = normalizePhone(phone);
  if (!digits) return null;
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
  const res = await fetch(atUrl(AT_CLIENTS), {
    method: "POST",
    headers: atHeaders(),
    body: JSON.stringify({
      fields: {
        "Name":            fallbackName,
        "Phone":           phone,
        "Source":          SOURCE_CLIENTS,
        "First contacted": new Date().toISOString().split("T")[0],
      },
      typecast: true,
    }),
  });
  const data = await res.json();
  if (data.error) { console.error("[sms] upsertClient create error:", data.error); return null; }
  return { id: data.id, fields: data.fields, isNew: true };
}

// Used by the upsert_client tool — updates arbitrary fields on an existing
// Client when Claude learns new info mid-conversation (name, email, address).
async function patchClient(clientId, fields) {
  try {
    const res = await fetch(`${atUrl(AT_CLIENTS)}/${clientId}`, {
      method: "PATCH",
      headers: atHeaders(),
      body: JSON.stringify({ fields, typecast: true }),
    });
    return res.json();
  } catch (err) { return { error: err.message }; }
}

async function getRecentConversations(clientId, limit = 10) {
  if (!clientId) return [];
  try {
    const formula = `SEARCH('${clientId}', ARRAYJOIN({Client}))`;
    const url = `${atUrl(AT_CONVERSATIONS)}?filterByFormula=${encodeURIComponent(formula)}&sort%5B0%5D%5Bfield%5D=Timestamp&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=${limit}`;
    const res = await fetch(url, { headers: atHeaders() });
    const data = await res.json();
    return (data.records || []).reverse(); // oldest first
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

// ─── Jobs (from estimate.js — copy-paste, no import) ─────────────────────
async function createJob(clientId, args, conversationLog) {
  try {
    if (!clientId) return { error: "clientId required" };
    const fields = {
      "Client":            [clientId],
      "Service type":      args.serviceType      || "",
      "Property snapshot": args.propertySnapshot || "",
      "Quote":             args.quote            || "",
      "Quote date":        new Date().toISOString().split("T")[0],
      "Lead status":       "Quoted",
      "Lead origin":       LEAD_ORIGIN,
    };
    if (typeof args.quoteAmount === "number") fields["Quote amount"] = args.quoteAmount;
    if (args.reasoning)  fields["Reasoning"]       = args.reasoning;
    if (args.concerns)   fields["Concerns"]        = args.concerns;
    if (conversationLog) fields["Conversation log"] = conversationLog;
    const res  = await fetch(atUrl(AT_JOBS), { method: "POST", headers: atHeaders(), body: JSON.stringify({ fields, typecast: true }) });
    const data = await res.json();
    if (data.error) return { error: data.error.message };
    return { jobId: data.id };
  } catch (err) { return { error: err.message }; }
}

async function updateJob(jobId, fields) {
  try {
    if (!jobId) return { error: "jobId required" };
    const res  = await fetch(`${atUrl(AT_JOBS)}/${jobId}`, { method: "PATCH", headers: atHeaders(), body: JSON.stringify({ fields, typecast: true }) });
    const data = await res.json();
    if (data.error) return { error: data.error.message };
    return { jobId: data.id };
  } catch (err) { return { error: err.message }; }
}

// ─── RentCast + Google Calendar (copy from estimate.js) ──────────────────
async function lookupProperty(address) {
  try {
    if (!process.env.RENTCAST_API_KEY) return { error: "Property lookup not configured" };
    const url = `https://api.rentcast.io/v1/properties?address=${encodeURIComponent(address)}`;
    const res = await fetch(url, { headers: { "X-Api-Key": process.env.RENTCAST_API_KEY } });
    const data = await res.json();
    const prop = Array.isArray(data) ? data[0] : data;
    if (!prop || prop.statusCode) return { error: "Property not found. Ask the customer for details manually." };
    const sqft = prop.squareFootage ?? prop.livingArea ?? prop.buildingSize ?? prop.size ?? null;
    const stories = prop.stories ?? prop.storiesCount ?? prop.floors ?? prop.numberOfStories ?? null;
    return {
      squareFootage: sqft,
      stories,
      bedrooms:     prop.bedrooms      ?? null,
      bathrooms:    prop.bathrooms     ?? null,
      yearBuilt:    prop.yearBuilt     ?? null,
      propertyType: prop.propertyType  ?? null,
      lotSize:      prop.lotSize       ?? null,
      address:      prop.formattedAddress || address,
    };
  } catch (err) { console.error("[sms] lookupProperty error:", err); return { error: "Lookup failed. Ask manually." }; }
}

async function checkCalendarAvailability(weeksAhead = 4) {
  try {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return { error: "Calendar not configured", availableDates: [] };
    const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ["https://www.googleapis.com/auth/calendar.readonly"] });
    const calendar = google.calendar({ version: "v3", auth });
    const minDate = new Date("2026-05-16T00:00:00-04:00");
    const start   = new Date() > minDate ? new Date() : minDate;
    const end     = new Date(start); end.setDate(end.getDate() + weeksAhead * 7);
    const busyRes = await calendar.freebusy.query({ requestBody: { timeMin: start.toISOString(), timeMax: end.toISOString(), timeZone: "America/New_York", items: [{ id: process.env.GOOGLE_CALENDAR_ID || "primary" }] } });
    const busy    = busyRes.data.calendars?.[process.env.GOOGLE_CALENDAR_ID || "primary"]?.busy || [];
    const freeDays = []; const cursor = new Date(start);
    while (freeDays.length < 6 && cursor < end) {
      const day = cursor.getDay();
      if (day !== 0 && day !== 6) { const d = cursor.toISOString().split("T")[0]; if (!busy.some(s => s.start.startsWith(d))) freeDays.push(d); }
      cursor.setDate(cursor.getDate() + 1);
    }
    return { availableDates: freeDays };
  } catch (err) { return { error: err.message, availableDates: [] }; }
}

async function bookAppointment(data) {
  try {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return { error: "Calendar not configured" };
    const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ["https://www.googleapis.com/auth/calendar"] });
    const calendar = google.calendar({ version: "v3", auth });
    const event = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
      requestBody: {
        summary: `${data.serviceType} - ${data.customerName}`,
        description: `Customer: ${data.customerName}\nPhone: ${data.customerPhone}\nEmail: ${data.customerEmail || "N/A"}\nService: ${data.serviceType}\nQuote: ${data.quoteAmount || "TBD"}\nNotes: ${data.notes || ""}\n\n(via SMS)`,
        start: { date: data.date, timeZone: "America/New_York" },
        end:   { date: data.date, timeZone: "America/New_York" },
      },
    });
    return { success: true, eventId: event.data.id };
  } catch (err) { return { error: err.message }; }
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

// ─── Tool definitions (same 6 tools as estimate.js) ──────────────────────
const tools = [
  { name: "upsert_client", description: "Update the customer's Client record when you learn new info mid-conversation (name, full name, email, address). Phone is already set from the SMS sender.", input_schema: { type: "object", properties: { firstName: { type: "string" }, fullName: { type: "string" }, phone: { type: "string" }, email: { type: "string" }, address: { type: "string" } } } },
  { name: "save_quote_job", description: "Save a quote to the Airtable Jobs table. Call this IMMEDIATELY when you reveal a price to the customer in your SMS reply.", input_schema: { type: "object", properties: { serviceType: { type: "string" }, propertySnapshot: { type: "string" }, quote: { type: "string" }, quoteAmount: { type: "number" }, reasoning: { type: "string" }, concerns: { type: "string" } }, required: ["serviceType", "quote", "quoteAmount"] } },
  { name: "confirm_booking", description: "Mark the most recent Job as Booked once the customer locks in a date.", input_schema: { type: "object", properties: { bookingDate: { type: "string" }, customerConfirmText: { type: "string" } }, required: ["bookingDate"] } },
  { name: "check_calendar_availability", description: "Check open calendar dates. Only call when the customer is ready to schedule.", input_schema: { type: "object", properties: { weeksAhead: { type: "number" } } } },
  { name: "lookup_property", description: "Look up property details (sqft, stories) from an address. Use when the customer wants a house-wash quote and provides an address.", input_schema: { type: "object", properties: { address: { type: "string" } }, required: ["address"] } },
  { name: "book_appointment", description: "Add the confirmed appointment to Google Calendar.", input_schema: { type: "object", properties: { customerName: { type: "string" }, customerPhone: { type: "string" }, customerEmail: { type: "string" }, serviceType: { type: "string" }, date: { type: "string" }, quoteAmount: { type: "string" }, notes: { type: "string" } }, required: ["customerName", "customerPhone", "serviceType", "date"] } },
];

// ─── Tool dispatcher ─────────────────────────────────────────────────────
async function runTool(name, args, state) {
  if (name === "upsert_client") {
    if (!state.clientId) return { error: "No clientId in SMS context" };
    const patchFields = {};
    if (args.firstName) patchFields["Name"]      = args.firstName;
    if (args.fullName)  patchFields["Full name"] = args.fullName;
    if (args.email)     patchFields["Email"]     = args.email;
    if (args.address)   patchFields["Address"]   = args.address;
    if (Object.keys(patchFields).length === 0) return { clientId: state.clientId, noop: true };
    const r = await patchClient(state.clientId, patchFields);
    return r?.id ? { clientId: r.id, updated: Object.keys(patchFields) } : { error: r?.error || "patchClient failed" };
  }
  if (name === "save_quote_job") {
    if (!state.clientId) return { error: "No clientId" };
    const convoLog = JSON.stringify(state.historySnapshot || []);
    const r = await createJob(state.clientId, args, convoLog);
    if (r.jobId) {
      state.jobId = r.jobId;
      state.toolsUsed.push(`save_quote_job: ${args.serviceType} ${args.quote}`);
    }
    return r;
  }
  if (name === "confirm_booking") {
    if (!state.jobId) return { error: "No jobId — save_quote_job must run first" };
    const r = await updateJob(state.jobId, { "Booking date": args.bookingDate, "Lead status": "Booked" });
    if (!r.error) state.toolsUsed.push(`confirm_booking: ${args.bookingDate}`);
    return r;
  }
  if (name === "lookup_property") {
    const r = await lookupProperty(args.address);
    if (!r.error) state.toolsUsed.push(`lookup_property: ${r.squareFootage || "?"} sqft / ${r.stories || "?"} stories`);
    return r;
  }
  if (name === "check_calendar_availability") {
    const r = await checkCalendarAvailability(args.weeksAhead);
    const dates = r?.availableDates || [];
    if (dates.length) state.toolsUsed.push(`check_calendar: ${dates.slice(0, 3).map(prettyDate).join(", ")}${dates.length > 3 ? "…" : ""}`);
    return r;
  }
  if (name === "book_appointment") {
    const r = await bookAppointment(args);
    if (r.success) state.toolsUsed.push(`book_appointment: ${prettyDate(args.date)}`);
    return r;
  }
  return { error: "Unknown tool" };
}

// ─── LP system prompt (body copied from estimate.js, SMS wrapper on top) ─
const LP_PRICING_BODY = `CORE RULES:
- ONE question per message. Never stack questions.
- Short and conversational. No markdown, no bold, no headers.
- Quote range: always add $50 to calculated price (e.g. $310 calculated = "$310–$360"). Never explain the math.
- MINIMUM FEE: If calculated price < $120, say "We have a $120 minimum visit fee — would you like to add another service?" Never show sub-$120 quote.
- AIRTABLE: The customer's phone is already saved. Call upsert_client ONLY if you learn additional info (name, email, address). Call save_quote_job IMMEDIATELY whenever you reveal a price in a reply. Call confirm_booking when the customer locks in a date. Call book_appointment to add the calendar event.
- NEVER narrate tool calls to the customer. Tools are silent.
- Booking: Only check calendar when customer explicitly asks to schedule. Season starts May 16, 2026 (Luke and his brother are finishing college — keep it casual).
- Bundle: 30% off second/third service when bundled with house wash. Mention discount applied on final team review.
- Veterans/Seniors: 10% off, only if customer asks. Does not stack.
- Plant/pet safety: "We use professional-grade soaps safe for all plants and pets." Never mention bleach.
- Insurance: Yes, general liability (Hiscox).
- Year: 2026.
${OFFER_PROMPT_BLOCK}
UNKNOWN SITUATIONS (CRITICAL):
If the customer asks about ANY service/surface/situation not clearly covered by the pricing below, do NOT guess. Reply something like: "That's an interesting one — let me flag it for our team to review so we can give you an accurate quote. I'll get back to you within a few hours." Then call save_quote_job with serviceType="Custom — <what they asked>", quote="Needs human review", quoteAmount=0, concerns="Not covered by standard pricing — human review required".

PARTIAL SIDES MATH (house wash only):
4-sided home: 1 of 4 sides = 25% of full / 2 = 50% / 3 = 75% / 4 = 100%. 3-sided attached/row home: 1 of 3 = 33% / 2 = 67% / 3 = 100%.
Calc order (silent, never show math): pick FULL price from sqft × stories × clean/dirty → × fraction → round to nearest $10 → apply $50 range → if low end < $120, invoke $120 minimum flat.

QUALIFICATION FLOWS — one question at a time:

HOUSE EXTERIOR 🏠:
1. If address known but no sqft/stories yet, call lookup_property silently, then confirm what you found with the customer.
2. Primary siding? (Vinyl, Wood, Brick, Stucco, etc.)
3. Any dormers, porch, or chimney?
4. How long since last cleaning, and how dirty?

DECK 🪵: sqft → material (wood/composite-trex/vinyl-pvc) → railings type + feet → steps count → how long + how dirty → paint/boards shape

PATIO 🧱: sqft → material (concrete/pavers-brick/slab) → weeds in cracks? → how long + how dirty

FENCE 🌿: feet → material (vinyl/wood/trex/pvc); if wood, gaps or solid? → one or both sides → how long + how dirty → paint shape

DRIVEWAY 🚗: sqft → algae/mildew? → how long since last cleaning?

GUTTERS 🌧️: FIRST ask: "Do you want the gutters cleaned out from the inside (debris + flushing) or just the outside washed (black stripes on the face, soffit if grimy)?" — prices differ a lot. Then for cleaning: issue → home sqft → stories per side. For exterior wash: which sides (front/all/etc.).

PRICING (calculate silently, never show math):

HOUSE WASHING — soft wash, min $120. Clean = 0–3 yrs. Dirty = 4+ yrs. Stucco side = +10% (silent).
Trailer: single $150–200, double $190–240.
1-Story: 1000–1500→$210–260 | 1500–1750→$230–280/$250–300 | 1750–2000→$260–310/$280–330 | 2000–2300→$300–350/$330–380 | 2300–2600→$330–390/$380–430 | 2600–3000→$390–430/$420–470 | 3000–3500→$430–480/$460–510 | 3500–4000→$450–500/$550
2-Story (3-sided attached = price as 3 sides): 1000–1500→$210–260 | 1500–1750→$260–310/$280–330 | 1750–2000→$320–370/$340–390 | 2000–2300→$360–420/$390–440 | 2300–2600→$390–450/$430–480 | 2600–3000→$420–470(+$50 dirty) | 3000–3500→$450–500/$470–520 | 3500–4000→$450–580/$480–580(human review) | 4000–5000→$500–650/$600+(human review) | 5000+→$700–900(human review)
3-Story (ask 3 or 4 sides): 2400–2600→$360–420/$400–450 | 2600–3000→$440–490/$470–520 | 3000–3500→$490–540/$460–510 | 3500–4000→$530–600/$600–680(human review) | 4000–5000→$500–650(human review) | 5000+→$700–900(human review)
Partial sides: see PARTIAL SIDES MATH above.
Add-ons: Chimney brick/stucco +$100 | Chimney vinyl +$30 | Sloped side +$30 | Dormer 1st story +$20, 2nd story +$30 | Porch ground = patio pricing −25% (free <100sqft) | Screens free ≤10, $20–50 more | Windows $5/each, $10 second story | Small front step free

DECK (per sqft): Wood $0.50 | Composite/Trex $0.46 | Vinyl/PVC $0.40 | +$0.02 really dirty | +$0.02 old/chipping | Steps $4 vinyl/$6 wood-composite | Railings $3/ft wood, $0.80/ft vinyl

PATIO (per sqft): Concrete $0.38 | Pavers/Brick $0.42 | Slab $0.46 | +$0.04 really dirty | +5% poor drainage

FENCE (per linear ft, one side): Vinyl/Metal $1.28 | Wood gaps $0.90 | Solid wood $1.98 | +$0.10 really dirty | Both sides = double

DRIVEWAY: $0.38/sqft. Min $120.

GUTTERS (debris + flush): 1-story $90–140 | Mixed 1&2 $130–180 | 2-story $160–210 | 3-story $240–300 | +$40 if >2800sqft | +$100 if >4000sqft | +$40 if not cleaned 3+ yrs no guards | Partial = proportional cut

GUTTER / SOFFIT EXTERIOR WASH (outside only, NOT debris): 25% of equivalent house-wash price for the section. All 4 sides = 25% of full. Just front = 25% of (25% of full). No $50 range on this sub-service. No $120 min on this sub-service.

OTHER: No roof washing. Awnings = human review (flag for review, get photo). Furniture <3 items free, 3+ = $5/$10 wooden.`;

function buildSmsSystemPrompt(clientRecord, historyLines) {
  const clientName = clientRecord?.fields?.["Name"] || "(unknown)";
  const clientPhone = clientRecord?.fields?.["Phone"] || "";
  const clientAddress = clientRecord?.fields?.["Address"] || "";
  const clientEmail = clientRecord?.fields?.["Email"] || "";
  const clientSqft = clientRecord?.fields?.["Sqft"] || "";
  const clientStories = clientRecord?.fields?.["Stories"] || "";

  return `You are drafting a personal SMS reply on behalf of Luke, the owner-operator of LP Pressure Wash (a small local soft-wash / pressure-washing business in the Doylestown, PA area).

SMS-SPECIFIC RULES (these OVERRIDE anything below about long messages):
- Keep replies under 320 characters (2 SMS segments max).
- Tone: warm, direct, casual — you're Luke texting back a customer from his cell. Not corporate. No markdown, no bullet lists, no links. Like a real person would text.
- If unsure about scheduling, say "I'll double-check my calendar and confirm." You have a calendar tool, but only use it if the customer actually asks to book.
- End with a friendly sign-off or a question that keeps the conversation moving.
- NEVER mention "bot", "AI", "system", "draft", or anything that suggests the reply was written by software.

CUSTOMER CONTEXT (the person you're texting):
Name: ${clientName}
Phone: ${clientPhone}
Address: ${clientAddress || "(unknown)"}
Email: ${clientEmail || "(unknown)"}
Known sqft: ${clientSqft || "(unknown)"}
Known stories: ${clientStories || "(unknown)"}
${historyLines ? `\nRECENT CONVERSATION HISTORY (oldest first):\n${historyLines}` : ""}

If the customer says something like "this is Sarah" or "my email is ___" — call upsert_client with that new info so their Client record stays up to date.

${LP_PRICING_BODY}`;
}

// ─── Draft with tool-calling loop ─────────────────────────────────────────
async function draftReplyWithTools(clientRecord, recentConvos, incomingText) {
  const anthropic = new Anthropic();

  // Build conversation for Claude: use recent Conversations as prior
  // user/assistant turns, then add the current inbound as the latest user msg.
  const historyLines = recentConvos.map(c => {
    const dir = c.fields?.Direction || "?";
    const msg = c.fields?.Message || c.fields?.["Final_Message"] || c.fields?.["Draft_Message"] || "";
    return `[${dir}] ${msg}`;
  }).join("\n");

  const claudeMessages = recentConvos.map(c => ({
    role: c.fields?.Direction === "Inbound" ? "user" : "assistant",
    content: c.fields?.Message || c.fields?.["Final_Message"] || c.fields?.["Draft_Message"] || "",
  })).filter(m => m.content);
  // Collapse consecutive same-role messages (Claude allows but cleaner this way)
  claudeMessages.push({ role: "user", content: incomingText });

  const systemPrompt = buildSmsSystemPrompt(clientRecord, historyLines);

  const state = {
    clientId: clientRecord?.id || null,
    jobId: null,
    toolsUsed: [],
    historySnapshot: [...claudeMessages], // for save_quote_job's conversation log
  };

  const textParts = [];
  const MAX_ITER = 5;
  let iter = 0;
  let response;
  let messages = [...claudeMessages];

  while (iter < MAX_ITER) {
    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: systemPrompt,
      tools,
      messages,
    });

    // Capture text
    const turnText = response.content.filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    if (turnText) textParts.push(turnText);

    if (response.stop_reason !== "tool_use") break;

    // Append assistant turn verbatim, execute tools, append tool results
    messages.push({ role: "assistant", content: response.content });
    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      let result;
      try {
        result = await runTool(block.name, block.input || {}, state);
      } catch (err) {
        console.error(`[sms] tool ${block.name} threw:`, err);
        result = { error: err.message || "Tool error" };
      }
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
    }
    messages.push({ role: "user", content: toolResults });
    iter++;
  }

  const finalText = textParts.join(" ").trim() || "Got your message — give me a minute and I'll get right back to you.";
  return { draft: finalText, toolsUsed: state.toolsUsed, jobId: state.jobId };
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

  try {
    // 1. Upsert Client
    const client = await upsertClientByPhone(from, name || "(unknown)");

    // 2. Recent history (oldest first)
    const convos = client ? await getRecentConversations(client.id, 10) : [];

    // 3. Always log the inbound first (so history + context include it)
    if (client) {
      await createConversationRow({
        "Client":     [client.id],
        "Channel":    CONVO_CHANNEL,
        "Direction":  "Inbound",
        "Author":     "Customer",
        "Message":    text,
        "Timestamp":  new Date().toISOString(),
        "Customer phone": from,
        "Source":     SOURCE_CLIENTS,
      }).catch(err => console.error("[sms] inbound log error:", err));
    }

    // 4. Claude tool-calling draft
    let draft;
    let toolsUsed = [];
    let relatedJobId = null;
    try {
      const result = await draftReplyWithTools(client, convos, text);
      draft = result.draft;
      toolsUsed = result.toolsUsed || [];
      relatedJobId = result.jobId || null;
    } catch (err) {
      console.error("[sms] draftReplyWithTools failed:", err);
      draft = "Hey! Got your message — give me a minute and I'll get right back to you.";
    }
    if (!draft) draft = "Hey! Got your message — give me a minute and I'll get right back to you.";

    // 5. Create pending_approval Conversation row for the draft
    const convoRow = client ? await createConversationRow({
      "Client":         [client.id],
      "Channel":        CONVO_CHANNEL,
      "Direction":      "Outbound",
      "Author":         "AI bot",
      "Message":        draft,
      "Draft_Message":  draft,
      "Status":         "pending_approval",
      "Timestamp":      new Date().toISOString(),
      "Customer phone": from,
      "Source":         SOURCE_CLIENTS,
      "Intent":         "sms_draft",
      ...(relatedJobId ? { "Job": [relatedJobId] } : {}),
    }) : null;

    if (!convoRow || !convoRow.id) {
      console.error("[sms] couldn't create pending Conversation row");
      res.setHeader("Content-Type", "text/xml");
      return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }

    // 6. Telegram approval prompt — now also shows tools that fired during drafting
    const label = name ? `${htmlEscape(name)} · ${htmlEscape(from)}` : htmlEscape(from);
    const clientDisplay = client?.fields?.Name && client.fields.Name !== "(unknown)"
      ? htmlEscape(client.fields.Name)
      : "(new contact)";

    const telegramLines = [
      `💬 <b>Incoming SMS — ${clientDisplay}</b>`,
      `📞 ${label}`,
      numMedia > 0 ? `📎 <i>${numMedia} attachment${numMedia > 1 ? "s" : ""}</i>` : null,
      ``,
      `<b>Customer:</b>`,
      `<pre>${htmlEscape(text || "(no text)")}</pre>`,
      ``,
      `<b>Suggested reply (Claude Haiku + tools):</b>`,
      `<pre>${htmlEscape(draft)}</pre>`,
    ];
    if (toolsUsed.length) {
      telegramLines.push(``);
      telegramLines.push(`🛠 <i>Tools used:</i>`);
      for (const t of toolsUsed) telegramLines.push(`  • ${htmlEscape(t)}`);
    }
    const telegramText = telegramLines.filter(x => x != null).join("\n");

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
    res.setHeader("Content-Type", "text/xml");
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }
}
