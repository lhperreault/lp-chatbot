import OpenAI from "openai";
import { google } from "googleapis";

// ─── CORS helper ─────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ─── Airtable config ──────────────────────────────────────────────────────────
const AT_CLIENTS       = "Clients";
const AT_JOBS          = "Jobs";
const AT_CONVERSATIONS = "Conversations";
const SOURCE_CHANNEL   = "Website estimate form";

function airtableUrl(table) {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`;
}
function airtableHeaders() {
  return { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" };
}

// ─── Airtable helpers (mirrors chat.js exactly) ───────────────────────────────
async function findClient({ phone, email }) {
  try {
    const clauses = [];
    if (phone) clauses.push(`{Phone}='${phone.replace(/'/g, "\\'")}'`);
    if (email) clauses.push(`LOWER({Email})=LOWER('${email.replace(/'/g, "\\'")}')`);
    if (!clauses.length) return null;
    const formula = clauses.length === 1 ? clauses[0] : `OR(${clauses.join(",")})`;
    const res = await fetch(`${airtableUrl(AT_CLIENTS)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`, { headers: airtableHeaders() });
    const data = await res.json();
    return data.records?.[0]?.id || null;
  } catch { return null; }
}

async function upsertClient(args, knownClientId = null) {
  try {
    let existingId = knownClientId || await findClient({ phone: args.phone, email: args.email });
    const fields = {};
    if (args.firstName) fields["Name"]      = args.firstName;
    if (args.fullName)  fields["Full name"] = args.fullName;
    if (args.phone)     fields["Phone"]     = args.phone;
    if (args.email)     fields["Email"]     = args.email;
    if (args.address)   fields["Address"]   = args.address;
    fields["Source"] = SOURCE_CHANNEL;

    if (existingId) {
      await fetch(`${airtableUrl(AT_CLIENTS)}/${existingId}`, { method: "PATCH", headers: airtableHeaders(), body: JSON.stringify({ fields }) });
      return { clientId: existingId, isNew: false };
    }
    fields["First contacted"] = new Date().toISOString().split("T")[0];
    const res  = await fetch(airtableUrl(AT_CLIENTS), { method: "POST", headers: airtableHeaders(), body: JSON.stringify({ fields }) });
    const data = await res.json();
    if (data.error) return { error: data.error.message };
    return { clientId: data.id, isNew: true };
  } catch (err) { return { error: err.message }; }
}

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
      "Source channel":    SOURCE_CHANNEL,
    };
    if (typeof args.quoteAmount === "number") fields["Quote amount"]     = args.quoteAmount;
    if (args.reasoning)   fields["Reasoning"]        = args.reasoning;
    if (args.concerns)    fields["Concerns"]          = args.concerns;
    if (conversationLog)  fields["Conversation log"]  = conversationLog;
    const res  = await fetch(airtableUrl(AT_JOBS), { method: "POST", headers: airtableHeaders(), body: JSON.stringify({ fields }) });
    const data = await res.json();
    if (data.error) return { error: data.error.message };
    return { jobId: data.id };
  } catch (err) { return { error: err.message }; }
}

async function updateJob(jobId, fields) {
  try {
    if (!jobId) return { error: "jobId required" };
    const res  = await fetch(`${airtableUrl(AT_JOBS)}/${jobId}`, { method: "PATCH", headers: airtableHeaders(), body: JSON.stringify({ fields }) });
    const data = await res.json();
    if (data.error) return { error: data.error.message };
    return { jobId: data.id };
  } catch (err) { return { error: err.message }; }
}

async function logConversation({ clientId, jobId, direction, author, message, intent }) {
  try {
    if (!clientId) return;
    const fields = {
      "Client": [clientId], "Channel": SOURCE_CHANNEL, "Direction": direction,
      "Author": author, "Message": message || "", "Timestamp": new Date().toISOString(),
    };
    if (jobId)  fields["Job"]    = [jobId];
    if (intent) fields["Intent"] = intent;
    await fetch(airtableUrl(AT_CONVERSATIONS), { method: "POST", headers: airtableHeaders(), body: JSON.stringify({ fields }) });
  } catch (err) { console.error("logConversation error:", err); }
}

async function lookupProperty(address) {
  try {
    if (!process.env.RENTCAST_API_KEY) return { error: "Property lookup not configured" };
    const res  = await fetch(`https://api.rentcast.io/v1/properties?address=${encodeURIComponent(address)}`, { headers: { "X-Api-Key": process.env.RENTCAST_API_KEY } });
    const data = await res.json();
    const prop = Array.isArray(data) ? data[0] : data;
    if (!prop || prop.statusCode) return { error: "Property not found. Ask manually." };
    return { squareFootage: prop.squareFootage || null, stories: prop.stories || null, yearBuilt: prop.yearBuilt || null, propertyType: prop.propertyType || null, address: prop.formattedAddress || address };
  } catch { return { error: "Lookup failed. Ask manually." }; }
}

async function checkCalendarAvailability(weeksAhead = 4) {
  try {
    const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ["https://www.googleapis.com/auth/calendar.readonly"] });
    const calendar = google.calendar({ version: "v3", auth });
    const minDate  = new Date("2026-05-16T00:00:00-04:00");
    const start    = new Date() > minDate ? new Date() : minDate;
    const end      = new Date(start); end.setDate(end.getDate() + weeksAhead * 7);
    const busyRes  = await calendar.freebusy.query({ requestBody: { timeMin: start.toISOString(), timeMax: end.toISOString(), timeZone: "America/New_York", items: [{ id: process.env.GOOGLE_CALENDAR_ID || "primary" }] } });
    const busy     = busyRes.data.calendars?.[process.env.GOOGLE_CALENDAR_ID || "primary"]?.busy || [];
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
    const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ["https://www.googleapis.com/auth/calendar"] });
    const calendar = google.calendar({ version: "v3", auth });
    const event = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
      requestBody: { summary: `${data.serviceType} - ${data.customerName}`, description: `Customer: ${data.customerName}\nPhone: ${data.customerPhone}\nEmail: ${data.customerEmail || "N/A"}\nService: ${data.serviceType}\nQuote: ${data.quoteAmount || "TBD"}\nNotes: ${data.notes || ""}`, start: { date: data.date, timeZone: "America/New_York" }, end: { date: data.date, timeZone: "America/New_York" } },
    });
    return { success: true, eventId: event.data.id };
  } catch (err) { return { error: err.message }; }
}

// ─── System prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt(formData) {
  const { firstName, phone, address, services, condition } = formData;
  const svcList = Array.isArray(services) ? services.join(", ") : (services || "");
  return `You are the LP Pressure Wash AI Estimator on the website estimate form.

CUSTOMER CONTEXT — already collected. Do NOT ask for these again:
Name: ${firstName}
Phone: ${phone}
Address: ${address || "not provided"}
Services requested: ${svcList}
General condition: ${condition}

YOUR FIRST MESSAGE: Greet warmly by first name (e.g. "Hey ${firstName}! 👋"), confirm what they selected in one sentence, then immediately ask the first qualification question for their first service. No long preamble.

CORE RULES:
- ONE question per message. Never stack questions.
- Short and conversational. No markdown, no bold, no headers.
- Emojis: 🏠 House, 🪵 Deck, 🧱 Patio, 🌿 Fence, 🌧️ Gutters, 🚗 Driveway
- Quote format: "Your estimated price is $X–$Y. Our team does a final human review to give you the exact number. We use a safe soft-wash process that protects your home, plants, and pets. Would you like to add another service or see our availability?"
- Quote range: always add $50 to calculated price (e.g. $310 calculated = "$310–$360"). Never explain the math.
- MINIMUM FEE: If calculated price < $120, say "We have a $120 minimum visit fee — would you like to add another service?" Never show sub-$120 quote.
- Phone already captured (${phone}). Do NOT ask for it again. You may confirm if helpful.
- AIRTABLE: Call upsert_client on your very first turn with name + phone + address. Call save_quote_job immediately when you reveal a price. Call confirm_booking when customer locks in a date.
- Booking: Only check calendar when customer explicitly asks to schedule. Season starts May 16, 2026 (Luke and his brother are finishing college — keep it casual).
- Bundle: 30% off second/third service when bundled with house wash. Mention discount applied on final team review.
- Veterans/Seniors: 10% off, only if customer asks. Does not stack.
- Plant/pet safety: "We use professional-grade soaps safe for all plants and pets." Never mention bleach.
- Insurance: Yes, general liability (Hiscox).
- Year: 2026.

QUALIFICATION FLOWS — one question at a time:

HOUSE EXTERIOR 🏠:
1. "I can give you an estimate two ways — would you like to share your address so I can pull up your property details, or would you prefer to tell me the stories and square footage?"
   - Address given → call lookup_property → confirm result → skip to material
   - Manual → ask stories, then sq footage
2. Primary siding material? (Vinyl, Wood, Brick, Stucco, etc.)
3. Any dormers, porch, or chimney to clean?
4. How long since last cleaning, and how dirty would you say it is?

DECK 🪵:
1. Approximate square footage?
2. Primary material? (Wood, Composite/Trex, Vinyl/PVC)
3. Railings — type and length in feet?
4. Any steps? Approx how many?
5. How long since last cleaning, and how dirty?
6. Are the boards/paint in good shape or getting old?

PATIO 🧱:
1. Approximate square footage?
2. Primary material? (Concrete, Pavers, Brick, Slab)
3. Any weeds between cracks to handle?
4. How long since last cleaning, and how dirty?

FENCE 🌿:
1. Approximate length in feet?
2. Primary material? (Vinyl, Wood, Trex, PVC) — if Wood: "Is it post-then-2-3-beams with gaps, or solid with no gaps?"
3. One side or both sides cleaned?
4. How long since last cleaning, and how dirty?
5. Are boards/paint in good shape or getting old?

DRIVEWAY 🚗:
1. Approximate square footage or dimensions?
2. Any heavy algae or mildew buildup?
3. How long since last cleaning?

GUTTERS 🌧️:
1. What's the main issue with them?
2. Home square footage — do you need all gutters done?
3. How many stories on each side? Specify if sides differ.

PRICING (calculate silently, never show math):

HOUSE WASHING — soft wash, min $120. Clean = 0–3 yrs. Dirty = 4+ yrs. Stucco side = +10% (silent).
Trailer: single $150–200, double $190–240.
1-Story: 1000–1500→$210–260 | 1500–1750→$230–280/$250–300 | 1750–2000→$260–310/$280–330 | 2000–2300→$300–350/$330–380 | 2300–2600→$330–390/$380–430 | 2600–3000→$390–430/$420–470 | 3000–3500→$430–480/$460–510 | 3500–4000→$450–500/$550
2-Story (3-sided attached = price as 3 sides): 1000–1500→$210–260 | 1500–1750→$260–310/$280–330 | 1750–2000→$320–370/$340–390 | 2000–2300→$360–420/$390–440 | 2300–2600→$390–450/$430–480 | 2600–3000→$420–470(+$50 dirty) | 3000–3500→$450–500/$470–520 | 3500–4000→$450–580/$480–580(human review) | 4000–5000→$500–650/$600+(human review) | 5000+→$700–900(human review)
3-Story (ask 3 or 4 sides): 2400–2600→$360–420/$400–450 | 2600–3000→$440–490/$470–520 | 3000–3500→$490–540/$460–510 | 3500–4000→$530–600/$600–680(human review) | 4000–5000→$500–650(human review) | 5000+→$700–900(human review)
Partial sides: 4-sided home, 2 sides = 50% price, 3 sides = 75%.
Add-ons: Chimney brick/stucco +$100 | Chimney vinyl +$30 | Sloped side +$30 | Dormer 1st story +$20, 2nd story +$30 | Porch ground = patio pricing −25% (free <100sqft) | Screens free ≤10, $20–50 more | Windows (if asked) $5/window, $10 second story | Small front step free

DECK (per sqft): Wood $0.50 | Composite/Trex $0.46 | Vinyl/PVC $0.40 | +$0.02 really dirty | +$0.02 old/chipping | Steps $4 vinyl/$6 wood-composite | Railings $3/ft wood, $0.80/ft vinyl

PATIO (per sqft): Concrete $0.38 | Pavers/Brick $0.42 | Slab $0.46 | +$0.04 really dirty | +5% poor drainage

FENCE (per linear ft, one side): Vinyl/Metal $1.30 | Wood gaps $1.70 | Solid wood $2.00 | +$0.10 really dirty | Both sides = double

DRIVEWAY: $0.38/sqft (same as concrete). Min $120.

GUTTERS: 1-story $90–140 | Mixed 1&2 $130–180 | 2-story $160–210 | 3-story $240–300 | +$40 if >2800sqft | +$100 if >4000sqft | +$40 if not cleaned 3+ yrs no gutter guards | Partial = proportional cut

OTHER: No roof washing generally. Awnings = human review, get phone + photo. Furniture <3 items free, 3+ = $5/$10 wooden.

Contact: LP Pressure Washing | lhppressurewashing@gmail.com | (267) 912-8285`;
}

// ─── Tools ────────────────────────────────────────────────────────────────────
const tools = [
  { type: "function", function: { name: "upsert_client", description: "Find or create client. Call on first turn and whenever new info is learned.", parameters: { type: "object", properties: { firstName: { type: "string" }, fullName: { type: "string" }, phone: { type: "string" }, email: { type: "string" }, address: { type: "string" } }, required: ["firstName"] } } },
  { type: "function", function: { name: "save_quote_job", description: "Save quote to Airtable immediately when price is revealed. upsert_client must run first.", parameters: { type: "object", properties: { serviceType: { type: "string" }, propertySnapshot: { type: "string" }, quote: { type: "string" }, quoteAmount: { type: "number" }, reasoning: { type: "string" }, concerns: { type: "string" } }, required: ["serviceType", "quote", "quoteAmount"] } } },
  { type: "function", function: { name: "confirm_booking", description: "Mark job as Booked with agreed date.", parameters: { type: "object", properties: { bookingDate: { type: "string" }, customerConfirmText: { type: "string" } }, required: ["bookingDate"] } } },
  { type: "function", function: { name: "check_calendar_availability", description: "Check open dates. Only call when customer explicitly asks to book.", parameters: { type: "object", properties: { weeksAhead: { type: "number" } } } } },
  { type: "function", function: { name: "lookup_property", description: "Look up property from address for house wash quoting.", parameters: { type: "object", properties: { address: { type: "string" } }, required: ["address"] } } },
  { type: "function", function: { name: "book_appointment", description: "Book confirmed appointment on Google Calendar.", parameters: { type: "object", properties: { customerName: { type: "string" }, customerPhone: { type: "string" }, customerEmail: { type: "string" }, serviceType: { type: "string" }, date: { type: "string" }, quoteAmount: { type: "string" }, notes: { type: "string" } }, required: ["customerName", "customerPhone", "serviceType", "date"] } } },
];

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY not configured" });

  const { messages = [], formData = {}, clientId: incomingClientId = null, jobId: incomingJobId = null } = req.body;
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  let clientId = incomingClientId, jobId = incomingJobId, quoteJustSent = false;
  const latestUserMessage = [...messages].reverse().find(m => m.role === "user")?.content || null;
  const systemPrompt = buildSystemPrompt(formData);

  try {
    let response = await openai.chat.completions.create({ model: "gpt-4o-mini", max_tokens: 600, messages: [{ role: "system", content: systemPrompt }, ...messages], tools, tool_choice: "auto" });
    let assistantMessage = response.choices[0].message;

    if (assistantMessage.tool_calls?.length) {
      const toolResults = [];
      for (const toolCall of assistantMessage.tool_calls) {
        let args = {}; try { args = JSON.parse(toolCall.function.arguments); } catch {}
        let result = {};

        if (toolCall.function.name === "upsert_client") {
          const r = await upsertClient(args, clientId); if (r.clientId) clientId = r.clientId; result = r;
        } else if (toolCall.function.name === "save_quote_job") {
          if (!clientId) { const r = await upsertClient({ firstName: formData.firstName || "Unknown", phone: formData.phone, address: formData.address }, null); if (r.clientId) clientId = r.clientId; }
          if (clientId) { const convoLog = JSON.stringify([...messages, { role: "assistant", content: assistantMessage.content || "" }]); const r = await createJob(clientId, args, convoLog); if (r.jobId) { jobId = r.jobId; quoteJustSent = true; } result = r; }
          else result = { error: "No clientId available" };
        } else if (toolCall.function.name === "lookup_property") {
          result = await lookupProperty(args.address);
        } else if (toolCall.function.name === "check_calendar_availability") {
          result = await checkCalendarAvailability(args.weeksAhead);
        } else if (toolCall.function.name === "book_appointment") {
          result = await bookAppointment(args);
        } else if (toolCall.function.name === "confirm_booking") {
          if (jobId) { result = await updateJob(jobId, { "Booking date": args.bookingDate, "Lead status": "Booked" }); if (clientId && args.customerConfirmText) await logConversation({ clientId, jobId, direction: "Inbound", author: "Customer", message: args.customerConfirmText, intent: "booking_confirmed" }); }
          else result = { error: "No jobId" };
        } else result = { error: "Unknown tool" };

        toolResults.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(result) });
      }
      const finalResponse = await openai.chat.completions.create({ model: "gpt-4o-mini", max_tokens: 600, messages: [{ role: "system", content: systemPrompt }, ...messages, assistantMessage, ...toolResults] });
      assistantMessage = finalResponse.choices[0].message;
    }

    const replyText = assistantMessage.content || "";
    if (clientId && latestUserMessage) logConversation({ clientId, jobId, direction: "Inbound",  author: "Customer", message: latestUserMessage }).catch(() => {});
    if (clientId && replyText)        logConversation({ clientId, jobId, direction: "Outbound", author: "AI bot",   message: replyText, intent: quoteJustSent ? "quote_sent" : undefined }).catch(() => {});
    if (jobId && !quoteJustSent)      updateJob(jobId, { "Conversation log": JSON.stringify([...messages, { role: "assistant", content: replyText }]) }).catch(() => {});

    return res.status(200).json({ reply: replyText, clientId: clientId || null, jobId: jobId || null, quoteJustSent });
  } catch (err) {
    console.error("Estimate handler error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}
