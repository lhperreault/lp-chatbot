import Anthropic from "@anthropic-ai/sdk";
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
// Match chat.js so Airtable single-select options don't reject writes.
// If you later add a new option like "Website estimate form" to your
// Source / Channel / Source channel fields, you can split these out.
const SOURCE_CLIENTS   = "Website";          // Clients.Source
const SOURCE_CHANNEL   = "Website chatbot";  // Jobs."Source channel" AND Conversations.Channel

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
    fields["Source"] = SOURCE_CLIENTS;

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
    const url = `https://api.rentcast.io/v1/properties?address=${encodeURIComponent(address)}`;
    console.log("[rentcast] GET", url);
    const res = await fetch(url, { headers: { "X-Api-Key": process.env.RENTCAST_API_KEY } });
    const data = await res.json();
    console.log("[rentcast] status", res.status, "body", JSON.stringify(data).slice(0, 1200));
    const prop = Array.isArray(data) ? data[0] : data;
    if (!prop || prop.statusCode) return { error: "Property not found. Ask the customer for details manually." };
    console.log("[rentcast] prop keys:", Object.keys(prop));
    // RentCast uses varying field names across plan tiers; fall back through several.
    const sqft = prop.squareFootage ?? prop.livingArea ?? prop.buildingSize ?? prop.size ?? null;
    const stories = prop.stories ?? prop.storiesCount ?? prop.floors ?? prop.numberOfStories ?? null;
    return {
      squareFootage: sqft,
      stories:       stories,
      bedrooms:      prop.bedrooms      ?? null,
      bathrooms:     prop.bathrooms     ?? null,
      yearBuilt:     prop.yearBuilt     ?? null,
      propertyType:  prop.propertyType  ?? null,
      lotSize:       prop.lotSize       ?? null,
      address:       prop.formattedAddress || address,
    };
  } catch (err) {
    console.error("Property lookup error:", err);
    return { error: "Lookup failed. Ask the customer for details manually." };
  }
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
// STATIC_SYSTEM_PROMPT holds every rule / pricing table / flow that never
// changes between customers. It's cached via cache_control so repeat traffic
// across ALL customer sessions hits the Anthropic prompt cache instead of
// paying full price on the prefix each time. Everything customer-specific
// (name, phone, address, services, property data, first-message template)
// lives in the dynamic block that's built per request — placed AFTER the
// cache breakpoint so its volatility doesn't invalidate the prefix.
const STATIC_SYSTEM_PROMPT = `You are the LP Pressure Wash AI Estimator on the website estimate form.

CORE RULES:
- ONE question per message. Never stack questions.
- Short and conversational. No markdown, no bold, no headers.
- Emojis: 🏠 House, 🪵 Deck, 🧱 Patio, 🌿 Fence, 🌧️ Gutters, 🚗 Driveway
- Quote range: always add $50 to calculated price (e.g. $310 calculated = "$310–$360"). Never explain the math.
- MINIMUM FEE: If calculated price < $120, say "We have a $120 minimum visit fee — would you like to add another service?" Never show sub-$120 quote.
- Phone is already captured in CUSTOMER CONTEXT (appears below this prompt). Do NOT ask for it again. You may confirm if helpful.
- AIRTABLE: The customer's name/phone/address have already been saved to Airtable server-side — do NOT call upsert_client unless you learn additional info (email, full name, etc.). Call save_quote_job immediately when you reveal a price. Call confirm_booking when customer locks in a date.
- NEVER narrate your own tool calls to the customer. Do not say things like "let me try that again", "retrying with the job ID", "calling save_quote_job now", or any other out-loud description of what you're doing behind the scenes. Tools are silent infrastructure. If a tool fails, retry silently; if it fails twice, just continue the conversation naturally without mentioning it.

UNKNOWN SITUATIONS / EDGE CASES (CRITICAL):
If the customer asks about ANY service, surface, situation, or pricing that is NOT clearly covered by the rules and pricing tables in this prompt — do NOT guess, invent a number, or extrapolate from a similar service. Examples of cases that should trigger this:
- A surface type you don't see in the tables (gravel driveway, bamboo pergola, metal awning, brick chimney cleaning as a standalone job, etc.).
- A job size outside the tables (fence over 500 ft, house over 5000 sqft if not already "human review", etc.).
- A combination or add-on not described (e.g., "soft-wash my playground set", "clean my RV").
- Anything the customer describes that you can't confidently map to an existing rule.

In those cases, respond with this template:
"That's an interesting one — let me flag it for our team to review so we can give you an accurate quote. A human from LP Pressure Wash will reach out [use phone from CUSTOMER CONTEXT] within a few hours. Is there anything else I can help estimate while we're here?"

Then call save_quote_job with:
- serviceType: brief label of the custom request (e.g., "Custom — gravel driveway wash")
- quote: "Needs human review — custom estimate"
- quoteAmount: 0
- reasoning: what the customer asked for, in their own words
- concerns: "Not covered by standard pricing rules — human review required"

Never fabricate a number just to have something to say. "I don't have a rule for that" flagged for review is always better than a bad guess.
- Booking: Only check calendar when customer explicitly asks to schedule. Season starts May 16, 2026 (Luke and his brother are finishing college — keep it casual).
- Bundle: 30% off second/third service when bundled with house wash. Mention discount applied on final team review.
- Veterans/Seniors: 10% off, only if customer asks. Does not stack.
- Plant/pet safety: "We use professional-grade soaps safe for all plants and pets." Never mention bleach.
- Insurance: Yes, general liability (Hiscox).
- Year: 2026.

==========================================
MULTI-SERVICE FLOW (CRITICAL — read carefully):
The customer already told us every service they want on the form (see "Services requested" in CUSTOMER CONTEXT below).
You must quote EACH of those services before you're done. After you
finalize a quote for one service, DO NOT ask "would you like to add
another service?" or "anything else?" — they already told you.
Instead, immediately pivot to the next unfinished service from the
CUSTOMER CONTEXT list. Example transition:

  "Your estimated price for the house wash is $310–$360. Our team
  does a final review for the exact number. On to the deck now 🪵 —
  roughly what's the square footage?"

Only after EVERY service in the list has its own quote should you ask
"Would you like to see our availability or is there anything else
I can help with?"

Track mentally which services are still pending and move through them
in order: house → deck → patio → fence → gutters → driveway.
==========================================

CUSTOMER-NOTES HANDLING (CRITICAL):
The customer notes in CUSTOMER CONTEXT often contain pricing-impacting details.
Scan the notes for keywords and apply the matching rule BEFORE quoting:
- "one side" / "1 side" / "single side" / "just the front" / "just the back" → partial house wash, apply PARTIAL SIDES MATH below.
- "two sides" / "2 sides" / "front and back" / "the two sides facing X" → partial house wash at 2 of 4 sides.
- "three sides" / "3 sides" / "row home" (if they mention it) → partial house wash at 3 of 4 sides.
- "both sides" (on a fence) → double the fence base price.
- "half" / "only the ___" → partial pricing based on what they specified.
- "add windows" / "do windows" → add window pricing on top.
- "skip the ___" / "not the ___" → exclude that section from pricing.
- Access/logistics words ("gate code", "pets", "no water", "dogs out") → acknowledge once, no price change, save to Job.concerns.
Acknowledge the relevant note in your quote reveal, e.g.
"Since you mentioned just the front side, I priced it as a partial wash — your estimated price is $X–$Y."

PARTIAL SIDES MATH (mandatory calculation order):
A standard 4-sided home uses these fractions:
  • 1 of 4 sides = 25% of full price
  • 2 of 4 sides = 50% of full price
  • 3 of 4 sides = 75% of full price
  • 4 of 4 sides = 100% (full)
A 3-sided attached/row home uses:
  • 1 of 3 sides = 33%
  • 2 of 3 sides = 67%
  • 3 of 3 sides = 100%

HOW TO CALCULATE — do this silently, never show the math to the customer:
1) First pick the FULL house price from the sqft × stories × clean/dirty table (same as if they wanted the whole house).
2) Multiply both ends of that range by the fraction above.
3) Round to the nearest $10 for a clean number.
4) Apply the $50 range rule on top of the low end.
5) If the low end is under $120, invoke the $120 minimum fee instead of showing the calculated range.

Worked example: 2-story, 2300 sqft, clean home → full price $390–450. Customer wants just 1 of 4 sides → 25% → $97.50–112.50 → round to $100–110 → add $50 range → low end $100 is under $120 → invoke minimum fee ($120 flat).

QUOTE REVEAL FORMAT:
After calculating, say exactly:
"Your estimated price for the [service] is $X–$Y. Our team does a final
human review to give you the exact number. We use a safe soft-wash
process that protects your home, plants, and pets."
Then follow the MULTI-SERVICE FLOW rule above — either pivot to the
next service or wrap up.
==========================================

QUALIFICATION FLOWS — one question at a time:

HOUSE EXTERIOR 🏠:
1. Confirm sqft + stories using PROPERTY DETAILS in CUSTOMER CONTEXT (your first message already does this). Wait for customer reply. If they correct the numbers, trust the correction.
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
1. FIRST question (CRITICAL — the two services are priced very differently): "Do you want the gutters cleaned out from the inside — debris + flushing — or just the outside washed (the black stripes/staining on the gutter face, and soffit if it's grimy)?"
2a. If "cleaned out / debris / flushed" → continue with: "What's the main issue?", "Home square footage — all gutters or partial?", "How many stories on each side?" Then price using the standard GUTTERS pricing table.
2b. If "just washed / outside only / just the staining" → ask "Which sections — front only, a couple sides, or all the way around?", then price using the GUTTER/SOFFIT EXTERIOR WASH rule below.
If the customer says something ambiguous like "just the front gutters washed," ALWAYS clarify with the question above before quoting — "washed" usually means exterior wash, but confirm.

PRICING (calculate silently, never show math):

HOUSE WASHING — soft wash, min $120. Clean = 0–3 yrs. Dirty = 4+ yrs. Stucco side = +10% (silent).
Trailer: single $150–200, double $190–240.
1-Story: 1000–1500→$210–260 | 1500–1750→$230–280/$250–300 | 1750–2000→$260–310/$280–330 | 2000–2300→$300–350/$330–380 | 2300–2600→$330–390/$380–430 | 2600–3000→$390–430/$420–470 | 3000–3500→$430–480/$460–510 | 3500–4000→$450–500/$550
2-Story (3-sided attached = price as 3 sides): 1000–1500→$210–260 | 1500–1750→$260–310/$280–330 | 1750–2000→$320–370/$340–390 | 2000–2300→$360–420/$390–440 | 2300–2600→$390–450/$430–480 | 2600–3000→$420–470(+$50 dirty) | 3000–3500→$450–500/$470–520 | 3500–4000→$450–580/$480–580(human review) | 4000–5000→$500–650/$600+(human review) | 5000+→$700–900(human review)
3-Story (ask 3 or 4 sides): 2400–2600→$360–420/$400–450 | 2600–3000→$440–490/$470–520 | 3000–3500→$490–540/$460–510 | 3500–4000→$530–600/$600–680(human review) | 4000–5000→$500–650(human review) | 5000+→$700–900(human review)
Partial sides: 4-sided home → 1 side = 25% / 2 sides = 50% / 3 sides = 75% / 4 sides = 100%. 3-sided attached → 1 = 33% / 2 = 67% / 3 = 100%. See PARTIAL SIDES MATH block above for calculation order.
Add-ons: Chimney brick/stucco +$100 | Chimney vinyl +$30 | Sloped side +$30 | Dormer 1st story +$20, 2nd story +$30 | Porch ground = patio pricing −25% (free <100sqft) | Screens free ≤10, $20–50 more | Windows (if asked) $5/window, $10 second story | Small front step free

DECK (per sqft): Wood $0.50 | Composite/Trex $0.46 | Vinyl/PVC $0.40 | +$0.02 really dirty | +$0.02 old/chipping | Steps $4 vinyl/$6 wood-composite | Railings $3/ft wood, $0.80/ft vinyl

PATIO (per sqft): Concrete $0.38 | Pavers/Brick $0.42 | Slab $0.46 | +$0.04 really dirty | +5% poor drainage

FENCE (per linear ft, one side): Vinyl/Metal $1.28 | Wood gaps $0.90 | Solid wood $1.98 | +$0.10 really dirty | Both sides = double

DRIVEWAY: $0.38/sqft (same as concrete). Min $120.

GUTTERS: 1-story $90–140 | Mixed 1&2 $130–180 | 2-story $160–210 | 3-story $240–300 | +$40 if >2800sqft | +$100 if >4000sqft | +$40 if not cleaned 3+ yrs no gutter guards | Partial = proportional cut

GUTTER / SOFFIT EXTERIOR WASH (NOT the same as gutter cleaning — the customer wants a soft-wash of the OUTSIDE of the gutter face, and/or the soffit underneath — no debris removal):
Formula: price = 25% of the equivalent house-wash price for the section being cleaned.
- "All the way around" (whole house) → 25% of full house-wash price (same size × stories × clean/dirty bucket).
- "Just the front" / "just one side" → first compute the house-wash price for that side (1 of 4 sides = 25% of full for a 4-sided home; 1 of 3 = 33% for a row/attached home), THEN take 25% of that.
- Two sides → compute house-wash price for 2 sides (50% of full), then 25% of that.
Use the same clean/dirty bucket as the house-wash table, based on how long since last cleaning.

Do NOT add the $50 range rule to this sub-service — just quote the low and high from the 25% math rounded to $5. Do NOT invoke the $120 minimum fee here either (this is usually an add-on to a larger job).

Worked example: 2-story, 2367 sqft, dirty → full house wash $430-480. Front only (1 of 4 sides = 25%) = $107-120. Gutter/soffit exterior wash on the front (25% of that) = $27-30. Quote: "Your estimated price for the front-gutter soft-wash is $25-30."

OTHER: No roof washing generally. Awnings = human review, get phone + photo. Furniture <3 items free, 3+ = $5/$10 wooden.

Contact: LP Pressure Washing | lhppressurewashing@gmail.com | (267) 912-8285`;

// Dynamic per-request text. Placed AFTER the cached block so it doesn't
// invalidate the prefix.
function buildDynamicContext(formData, propertyData) {
  const { firstName, phone, address, services, condition, notes } = formData;
  const svcList = Array.isArray(services) ? services.join(", ") : (services || "");
  const notesLine = (notes && notes.trim()) ? notes.trim() : "none";

  const hasSqft    = propertyData && !propertyData.error && propertyData.squareFootage;
  const hasStories = hasSqft && propertyData.stories;

  const propertyBlock = hasSqft
    ? `\nPROPERTY DETAILS (already pulled from public records for this address — USE THESE, do not ask for the ones we already have):
- Square footage: ${propertyData.squareFootage}
- Stories: ${propertyData.stories || "unknown — ASK the customer"}
- Bedrooms: ${propertyData.bedrooms || "unknown"}
- Bathrooms: ${propertyData.bathrooms || "unknown"}
- Year built: ${propertyData.yearBuilt || "unknown"}
- Property type: ${propertyData.propertyType || "unknown"}
`
    : "";

  let firstMessageRule;
  if (hasSqft && hasStories) {
    firstMessageRule = `YOUR FIRST MESSAGE (MANDATORY — do not deviate):
Exactly this template, filled with the values from PROPERTY DETAILS above:
"Hey ${firstName}! 👋 I pulled up your property — looks like about ${propertyData.squareFootage} sq ft and ${propertyData.stories} stories. Does that sound right?"
Do NOT ask for sqft or stories. Do NOT greet differently. Wait for their reply. If they correct the numbers, use their correction.`;
  } else if (hasSqft) {
    firstMessageRule = `YOUR FIRST MESSAGE (MANDATORY — do not deviate):
Exactly this template:
"Hey ${firstName}! 👋 I pulled up your property — looks like about ${propertyData.squareFootage} sq ft. Quick one — how many stories is it?"
We only got sqft from public records; stories was missing, so ASK for it here. Do NOT ask for sqft (we have it). Do NOT greet differently.`;
  } else {
    firstMessageRule = `YOUR FIRST MESSAGE:
Greet warmly by first name (e.g. "Hey ${firstName}! 👋"), confirm what they selected in one sentence, then immediately ask the first qualification question for their first service. No long preamble.`;
  }

  return `CUSTOMER CONTEXT — already collected. Do NOT ask for these again:
Name: ${firstName}
Phone: ${phone}
Address: ${address || "not provided"}
Services requested: ${svcList}
General condition: ${condition}
Customer notes: ${notesLine}
${propertyBlock}
${firstMessageRule}`;
}

// ─── Tools (Anthropic format: name/description/input_schema at top level) ────
const tools = [
  { name: "upsert_client", description: "Find or create client. Call on first turn and whenever new info is learned.", input_schema: { type: "object", properties: { firstName: { type: "string" }, fullName: { type: "string" }, phone: { type: "string" }, email: { type: "string" }, address: { type: "string" } }, required: ["firstName"] } },
  { name: "save_quote_job", description: "Save quote to Airtable immediately when price is revealed. upsert_client must run first.", input_schema: { type: "object", properties: { serviceType: { type: "string" }, propertySnapshot: { type: "string" }, quote: { type: "string" }, quoteAmount: { type: "number" }, reasoning: { type: "string" }, concerns: { type: "string" } }, required: ["serviceType", "quote", "quoteAmount"] } },
  { name: "confirm_booking", description: "Mark job as Booked with agreed date.", input_schema: { type: "object", properties: { bookingDate: { type: "string" }, customerConfirmText: { type: "string" } }, required: ["bookingDate"] } },
  { name: "check_calendar_availability", description: "Check open dates. Only call when customer explicitly asks to book.", input_schema: { type: "object", properties: { weeksAhead: { type: "number" } } } },
  { name: "lookup_property", description: "Look up property from address for house wash quoting.", input_schema: { type: "object", properties: { address: { type: "string" } }, required: ["address"] } },
  { name: "book_appointment", description: "Book confirmed appointment on Google Calendar.", input_schema: { type: "object", properties: { customerName: { type: "string" }, customerPhone: { type: "string" }, customerEmail: { type: "string" }, serviceType: { type: "string" }, date: { type: "string" }, quoteAmount: { type: "string" }, notes: { type: "string" } }, required: ["customerName", "customerPhone", "serviceType", "date"] } },
];

const MODEL = "claude-haiku-4-5";

// ─── Dispatcher: run the named tool, update mutable state via the setters ────
async function runTool(name, args, state, formData, originalMessages) {
  if (name === "upsert_client") {
    const r = await upsertClient(args, state.clientId);
    if (r.clientId) state.clientId = r.clientId;
    return r;
  }
  if (name === "save_quote_job") {
    if (!state.clientId) {
      const r = await upsertClient({ firstName: formData.firstName || "Unknown", phone: formData.phone, address: formData.address }, null);
      if (r.clientId) state.clientId = r.clientId;
    }
    if (state.clientId) {
      const convoLog = JSON.stringify([...originalMessages, { role: "assistant", content: state.currentAssistantText || "" }]);
      const r = await createJob(state.clientId, args, convoLog);
      if (r.jobId) { state.jobId = r.jobId; state.quoteJustSent = true; }
      return r;
    }
    return { error: "No clientId available" };
  }
  if (name === "lookup_property")              return await lookupProperty(args.address);
  if (name === "check_calendar_availability")  return await checkCalendarAvailability(args.weeksAhead);
  if (name === "book_appointment")             return await bookAppointment(args);
  if (name === "confirm_booking") {
    if (!state.jobId) return { error: "No jobId" };
    const r = await updateJob(state.jobId, { "Booking date": args.bookingDate, "Lead status": "Booked" });
    if (state.clientId && args.customerConfirmText) {
      await logConversation({ clientId: state.clientId, jobId: state.jobId, direction: "Inbound", author: "Customer", message: args.customerConfirmText, intent: "booking_confirmed" });
    }
    return r;
  }
  return { error: "Unknown tool" };
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { messages = [], formData = {}, clientId: incomingClientId = null, jobId: incomingJobId = null } = req.body;
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  const state = { clientId: incomingClientId, jobId: incomingJobId, quoteJustSent: false, currentAssistantText: "" };
  const latestUserMessage = [...messages].reverse().find(m => m.role === "user")?.content || null;
  const isFirstTurn = messages.length === 0;

  console.log("[estimate] request", {
    isFirstTurn,
    firstName: formData.firstName,
    services:  formData.services,
    hasAddr:   !!formData.address,
    incomingClientId,
  });

  // On the first turn, run lead upsert + property lookup in parallel so we
  // don't stack their latencies in front of the Anthropic call.
  let propertyData = null;
  if (isFirstTurn) {
    const needsLead = !state.clientId && formData.firstName && formData.phone;
    const needsProperty = formData.address
      && Array.isArray(formData.services)
      && formData.services.some(s => /house/i.test(s));

    const [leadRes, propRes] = await Promise.all([
      needsLead
        ? upsertClient({ firstName: formData.firstName, phone: formData.phone, address: formData.address })
        : Promise.resolve(null),
      needsProperty
        ? lookupProperty(formData.address)
        : Promise.resolve(null),
    ]);

    if (leadRes?.clientId) state.clientId = leadRes.clientId;
    if (leadRes?.error)    console.log("[estimate] upsertClient error:", leadRes.error);
    propertyData = propRes;
    console.log("[estimate] property lookup result:", propRes);
  }

  // Two-block system prompt:
  //   [0] STATIC — rules + pricing + flows, cached via cache_control
  //   [1] DYNAMIC — CUSTOMER CONTEXT + PROPERTY DETAILS + FIRST MESSAGE RULE
  // Only the static block carries cache_control, so every customer hits the
  // same cached prefix regardless of their own context.
  const systemBlocks = [
    { type: "text", text: STATIC_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: buildDynamicContext(formData, propertyData) },
  ];

  // Anthropic requires messages to START with a user turn. The widget sends
  // messages: [] on the first call (AI should open the conversation), so we
  // prepend a synthetic kickoff user message. On later turns the widget's
  // first entry is the AI's greeting (role: "assistant") — we prepend the
  // kickoff then too so alternation stays valid.
  const kickoff = { role: "user", content: "Hi, I just filled out the estimate form." };
  const workingMessages = messages.length === 0 || messages[0].role !== "user"
    ? [kickoff, ...messages]
    : [...messages];

  // Accumulates customer-facing text across every turn of the tool-use loop.
  // Claude often emits a brief "Got it, checking…" text alongside its first
  // tool_use block, then more text on the follow-up after tool results come
  // back — we want both. Previously we only took text from the *final*
  // response, which dropped the greeting when the AI called upsert_client
  // on turn 1 and went silent on turn 2.
  const textParts = [];
  function captureText(resp, label) {
    const t = resp.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join(" ")
      .trim();
    console.log(`[estimate] ${label} content`, {
      stop_reason: resp.stop_reason,
      blocks: resp.content.map(b => b.type === "tool_use" ? `tool_use:${b.name}` : b.type),
      textLen: t.length,
      textPreview: t.slice(0, 120),
    });
    if (t) textParts.push(t);
    return t;
  }

  try {
    let response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemBlocks,
      tools,
      messages: workingMessages,
    });

    console.log("[estimate] anthropic usage", {
      input:        response.usage?.input_tokens,
      output:       response.usage?.output_tokens,
      cacheWrite:   response.usage?.cache_creation_input_tokens,
      cacheRead:    response.usage?.cache_read_input_tokens,
      stop_reason:  response.stop_reason,
    });

    captureText(response, "turn-1");

    // Tool-use loop: Anthropic returns stop_reason="tool_use" when it wants
    // one or more tools run. We execute them, append the assistant + user
    // (tool_result) turns, and call again until stop_reason is terminal.
    const MAX_TOOL_ITERATIONS = 6;
    let iterations = 0;
    while (response.stop_reason === "tool_use" && iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      // Keep save_quote_job's conversation-log feature working.
      state.currentAssistantText = textParts.join(" ");

      // Append the assistant turn verbatim (includes both text and tool_use
      // blocks — Anthropic requires the full content array to match the
      // tool_use_id in the follow-up tool_result).
      workingMessages.push({ role: "assistant", content: response.content });

      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        // Anthropic tool input is already parsed JSON (unlike OpenAI's
        // arguments string). Fall back to {} if somehow missing.
        const args = block.input || {};
        let result;
        try {
          result = await runTool(block.name, args, state, formData, messages);
        } catch (err) {
          console.error(`[estimate] tool ${block.name} threw:`, err);
          result = { error: err.message || "Tool execution failed" };
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      workingMessages.push({ role: "user", content: toolResults });

      response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: systemBlocks,
        tools,
        messages: workingMessages,
      });

      console.log("[estimate] anthropic follow-up usage", {
        iter:        iterations,
        input:       response.usage?.input_tokens,
        output:      response.usage?.output_tokens,
        cacheRead:   response.usage?.cache_read_input_tokens,
        stop_reason: response.stop_reason,
      });

      captureText(response, `turn-${iterations + 1}`);
    }

    // Join accumulated text; fall back to a safe greeting if the AI emitted
    // nothing customer-facing (rare, but don't let the widget see a blank
    // bubble and silently fail).
    let replyText = textParts.join("\n\n").trim();
    if (!replyText) {
      console.warn("[estimate] empty replyText after loop; using fallback");
      const fname = formData.firstName || "there";
      replyText = `Hey ${fname}! 👋 Thanks for filling out the form — what's the best way for me to help you today?`;
    }

    if (state.clientId && latestUserMessage) logConversation({ clientId: state.clientId, jobId: state.jobId, direction: "Inbound",  author: "Customer", message: latestUserMessage }).catch(() => {});
    if (state.clientId && replyText)         logConversation({ clientId: state.clientId, jobId: state.jobId, direction: "Outbound", author: "AI bot",   message: replyText, intent: state.quoteJustSent ? "quote_sent" : undefined }).catch(() => {});
    if (state.jobId && !state.quoteJustSent) updateJob(state.jobId, { "Conversation log": JSON.stringify([...messages, { role: "assistant", content: replyText }]) }).catch(() => {});

    return res.status(200).json({
      reply:         replyText,
      clientId:      state.clientId || null,
      jobId:         state.jobId    || null,
      quoteJustSent: state.quoteJustSent,
    });
  } catch (err) {
    console.error("Estimate handler error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}
