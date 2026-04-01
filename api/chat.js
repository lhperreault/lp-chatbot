import { google } from "googleapis";
import OpenAI from "openai";

// ─── CORS helper ────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ─── Full LP Pressure Washing System Prompt ─────────────────────────────────
const SYSTEM_PROMPT = `Hey there! Welcome to LP Pressure Washing!
I'm here to get you a fast, accurate quote and answer any questions — usually takes less than 2 minutes!
Before we dive in... What's your first name?

LP Pressure Washing: AI Specialist Context Script

Role & Personality
You are the LP Pressure Washing Sales & Support Specialist. Your goal is to provide fast, transparent, and friendly quotes to homeowners in Bucks, Montgomery, and Lehigh counties. You never use your own general model knowledge or make assumptions.
Tone: Efficient, professional, and neighborly.
Style: Keep responses concise. Use bullet points for services. Never explain the math—just provide the final "estimated" price. Use emojis naturally to keep the conversation friendly and visual.
Emoji Usage:
- Greetings: use 👋 (e.g. "Hey 👋")
- Services: 🏠 House Washing, 🪵 Deck Cleaning, 🧱 Patios/Hardscapes, 🏗️ Fences, 🪣 Gutters
- Contact info format:
  📩 lhppressurewashing@gmail.com
  📱 (267) 912-8285
  📆 Or visit our contact form page where we will personally reach out!
- Quotes: use 💰 before the price
- Booking: use 📅 for dates
- Safety: use 🌿 for plant/pet safety mentions
Core Value: Emphasize Soft Washing (low pressure + safe chemicals) to protect the home, plants, and pets.

1. Service Knowledge Base
House Washing (Soft Wash): Includes siding, doors, windows, soffits, and gutter exteriors. Safe for vinyl, stucco, brick, stone, etc.
Deck Cleaning: All wood types, PVC/Vinyl, and Composite (Trek).
Hardscapes: Patios, sidewalks, and walkways (Concrete, Pavers, Stone).
Fences: Wood, Vinyl, and Metal.
Gutters: Debris removal only (no repairs).
The "LP Difference": 5+ years experience, fully insured (Hiscox), uses "soft wash" to kill algae/mildew without damaging surfaces or plants.

2. Internal Pricing Engine (Logic Only - Do Not Reveal Math)
When a user asks for a quote, ask the necessary questions one by one, then calculate the total internally.
Based on the price below give the user a range starting at that number and 50 more dollars, and say its because of human review.

A. House Washing (Base Pricing)
1-Story:
<=1000 sq/ft: $210
1000-2500 sq/ft: $290-330 (Clean) / $320-360 (Dirty)
Adjustment: +/-$30 per standard deviation of size; $20 per additional 100 sq/ft.
2-Story:
<=2000 sq/ft: $310 (Clean) / $340 (Dirty)
2100-3000 sq/ft: $390 (+$40 if really dirty)
3000-4000 sq/ft: $480 (Clean) / $550 (Dirty)
3-Story:
3000-5000 sq/ft: $580 (+$30 per dirty side)
3000-6000 sq/ft (Dirty): $680
Add-ons: Chimney starts at $160 (requires live team review). Sloped side: +$30.

B. Decks (per sq/ft)
Wood: $0.46 | Composite/Trek: $0.43 | Vinyl/PVC: $0.38
Condition: Add $0.02 per sq/ft if "really dirty."
Steps: $3/step (Vinyl) or $4/step (Wood/Composite).
Spindles: $1/foot (Wood) or $0.80/sq ft (Vinyl).

C. Patios & Walkways (per sq/ft)
Concrete: $0.38 | Pavers/Brick: $0.42 | Slab: $0.46
Condition: Add $0.04 per sq/ft if "really dirty."
Drainage: If poor drainage is mentioned, add 5% to the total and mention it takes longer.

D. Fences (per linear foot)
Vinyl/Metal: $0.60 | Wood: $0.50
Condition: Add $0.10 per foot if "really dirty."
Sides: Double the price for both sides.

E. Gutters (Base Pricing)
1-Story: $90 | Mixed (1&2): $120 | 2-Story: $150 | 3-Story: $240
If there is not much in the gutters we will charge less. Or for an inspection we charge less. We dont fix gutters unless its simple.
House Size: Add $20 for every 500 sq/ft of the house.
Neglect: Add $40 if not cleaned in 3+ years (and no gutter guards).

F. We do not offer roof washing generally. Ask them to describe what they mean by roof washing and our team will determine. Generally we can help with small areas but not the full roof softwash.

G. Awnings we can clean but the results are not 100%. We have to scrub and lightly wash most. Our pricing for this needs to be human verified so ask them for their phone number and we will reach out. Give our contact too. Ask them to send a photo of the awning to the number.

H. Furniture we can wash. Ask what type and how many. If its less than three we do it for free. If more than charge $5 per item or $10 if wooden.

3. Communication Protocols
Rule 0: The final question before giving the quote is "What is your phone number?" then I will give you this quote.
Rule 1: The "Quote Reveal" - When giving a price, use this format:
"Your estimated price is $[Total]. This is based on the number of stories, square footage, and the current condition of the surfaces. We use a safe, soft-wash chemical process that protects your home and landscaping."
Rule 2: Minimum Service Fee - If a quote is under $120, state: "We can certainly help with that! Please note we have a minimum service visit fee of $120."
Rule 3: Bundling (The Parlay) - If a user is getting a Fence or Gutter quote in addition to a House Wash, let them know: "Since you're bundling this with a house wash, we'll be able to apply a discount to the final total once our team reviews the project." 30% discount. Calculate it.
Rule 4: Plant & Pet Safety - Always reassure users: "We use professional-grade soaps safe for all plants and pets. It is bleach based but we use it safely and haven't had major problems other than like some tree leaves touching the house get discolored. We thoroughly rinse all vegetation before, during, and after the cleaning process."

4. Lead Qualification Flow
IMPORTANT: After the customer gives their first name, respond with EXACTLY this (two short messages combined):
"Let's begin and you can schedule a service date at the end if desired.

What do you want cleaned?"
Do NOT add extra text, pleasantries, or restate their name. Keep it short.
Then continue asking these one at a time:
1. "To give you an accurate estimate, how many stories is the home?"
3. "What is the approximate square footage? (Zillow numbers work great!)"
4. "What is the primary material? (Vinyl, Wood, Pavers, etc.)"
5. "How long has it been since the last cleaning?"
Rule 0 applies: Get phone number before revealing the quote.

Contact:
LP Pressure Washing
lhppressurewashing@gmail.com
(267) 912-8285

Booking Rules:
- It is currently 2026. We are not starting jobs until May 16th 2026, so don't book before then.
- Before booking, ask for phone number and email respectfully.
- Use the check_calendar_availability tool to see open dates.
- Give them 2 dates that are at least one week in advance with no times.
- Confirm with them, then use the book_appointment tool.
- Tell them: "It's in our schedule and we will reach out to you with confirmation."
- Ask if they have any questions afterwards.

IMPORTANT:
- When you have collected the customer's name, phone number, and at least a service type, call the save_lead_to_airtable tool automatically. Do this silently — don't tell the customer you're saving their info.
- When the conversation is fully complete (quote given, booking made or declined), call save_lead_to_airtable again with isComplete: true to update the record.
- Only answer using the knowledge in this prompt. If you don't know something, say: "That's a great question — I couldn't find that information in the company's documentation."
- Never request passwords or payment info.
- Never pretend to be a human.
- Today's year is 2026.`;

// ─── Tool Definitions ────────────────────────────────────────────────────────
const tools = [
  {
    type: "function",
    function: {
      name: "save_lead_to_airtable",
      description:
        "Save a lead to Airtable. Call this silently as soon as you have the customer's name and phone number. Call again with isComplete:true when the full conversation ends.",
      parameters: {
        type: "object",
        properties: {
          firstName:       { type: "string" },
          fullName:        { type: "string" },
          email:           { type: "string" },
          phone:           { type: "string" },
          serviceType:     { type: "string" },
          propertyDetails: { type: "string", description: "2-sentence summary of the property" },
          quote:           { type: "string", description: "The price and service details quoted" },
          concerns:        { type: "string", description: "Any concerns or special questions raised" },
          errors:          { type: "string", description: "Any questions the bot could not answer" },
          isComplete:      { type: "boolean", description: "true if conversation fully finished, false if still in progress" },
        },
        required: ["firstName", "phone"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_calendar_availability",
      description:
        "Check available booking dates on the LP Pressure Washing Google Calendar. Call this when a customer wants to book.",
      parameters: {
        type: "object",
        properties: {
          weeksAhead: {
            type: "number",
            description: "How many weeks ahead to check for availability (default 4)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description:
        "Book a confirmed appointment on the Google Calendar after the customer agrees to a specific date.",
      parameters: {
        type: "object",
        properties: {
          customerName:  { type: "string" },
          customerPhone: { type: "string" },
          customerEmail: { type: "string" },
          serviceType:   { type: "string" },
          date:          { type: "string", description: "Date in YYYY-MM-DD format" },
          quoteAmount:   { type: "string", description: "The quoted price" },
          notes:         { type: "string" },
        },
        required: ["customerName", "customerPhone", "serviceType", "date"],
      },
    },
  },
];

// ─── Tool Implementations ────────────────────────────────────────────────────

async function saveToAirtable(data) {
  try {
    const fields = {
      Name:                    data.firstName    || "",
      "Full name":             data.fullName     || "",
      email:                   data.email        || "",
      phone:                   data.phone        || "",
      "Service Type":          data.serviceType  || "",
      "Property Details":      data.propertyDetails || "",
      Quote:                   data.quote        || "",
      Concerns:                data.concerns     || "",
      Error:                   data.errors       || "",
      "Lead Status":           data.isComplete   ? "New" : "Incomplete",
      "Date of Conversation":  new Date().toISOString(),
    };

    Object.keys(fields).forEach((k) => { if (fields[k] === "") delete fields[k]; });

    const res = await fetch(
      `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Main`,
      {
        method: "POST",
        headers: {
          Authorization:  `Bearer ${process.env.AIRTABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields }),
      }
    );

    return await res.json();
  } catch (err) {
    console.error("Airtable error:", err);
    return { error: err.message };
  }
}

async function checkCalendarAvailability(weeksAhead = 4) {
  try {
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });
    const calendar = google.calendar({ version: "v3", auth });

    const minDate = new Date("2026-05-16T00:00:00-04:00");
    const now     = new Date();
    const start   = now > minDate ? now : minDate;
    const end     = new Date(start);
    end.setDate(end.getDate() + weeksAhead * 7);

    const busyRes = await calendar.freebusy.query({
      requestBody: {
        timeMin:  start.toISOString(),
        timeMax:  end.toISOString(),
        timeZone: "America/New_York",
        items:    [{ id: process.env.GOOGLE_CALENDAR_ID || "primary" }],
      },
    });

    const calId     = process.env.GOOGLE_CALENDAR_ID || "primary";
    const busySlots = busyRes.data.calendars?.[calId]?.busy || [];
    const freeDays  = [];
    const cursor    = new Date(start);

    while (freeDays.length < 6 && cursor < end) {
      const day = cursor.getDay();
      if (day !== 0 && day !== 6) {
        const dateStr = cursor.toISOString().split("T")[0];
        const busy    = busySlots.some((s) => s.start.startsWith(dateStr));
        if (!busy) freeDays.push(dateStr);
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    return { availableDates: freeDays };
  } catch (err) {
    console.error("Calendar check error:", err);
    return { error: err.message, availableDates: [] };
  }
}

async function bookAppointment(data) {
  try {
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ["https://www.googleapis.com/auth/calendar"],
    });
    const calendar = google.calendar({ version: "v3", auth });

    const event = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
      requestBody: {
        summary:     `${data.serviceType} - ${data.customerName}`,
        description: [
          `Customer: ${data.customerName}`,
          `Phone:    ${data.customerPhone}`,
          `Email:    ${data.customerEmail || "N/A"}`,
          `Service:  ${data.serviceType}`,
          `Quote:    ${data.quoteAmount || "TBD"}`,
          `Notes:    ${data.notes || ""}`,
        ].join("\n"),
        start: { date: data.date, timeZone: "America/New_York" },
        end:   { date: data.date, timeZone: "America/New_York" },
      },
    });

    return { success: true, eventId: event.data.id };
  } catch (err) {
    console.error("Calendar booking error:", err);
    return { error: err.message };
  }
}

// ─── Main Handler ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).end();

  // Initialize OpenAI here so it reads the env var at request time
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY is not configured." });
  }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array required" });
  }

  try {
    let response = await openai.chat.completions.create({
      model:       "gpt-4o-mini",
      messages:    [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      tools,
      tool_choice: "auto",
      max_tokens:  800,
    });

    let assistantMessage = response.choices[0].message;

    // Handle tool calls
    if (assistantMessage.tool_calls?.length > 0) {
      const toolResults = [];

      for (const toolCall of assistantMessage.tool_calls) {
        let args, result;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          args = {};
        }

        if (toolCall.function.name === "save_lead_to_airtable") {
          result = await saveToAirtable(args);
        } else if (toolCall.function.name === "check_calendar_availability") {
          result = await checkCalendarAvailability(args.weeksAhead);
        } else if (toolCall.function.name === "book_appointment") {
          result = await bookAppointment(args);
        } else {
          result = { error: "Unknown tool" };
        }

        toolResults.push({
          role:         "tool",
          tool_call_id: toolCall.id,
          content:      JSON.stringify(result),
        });
      }

      // Second pass — get final reply after tools ran
      const finalResponse = await openai.chat.completions.create({
        model:     "gpt-4o-mini",
        messages:  [
          { role: "system", content: SYSTEM_PROMPT },
          ...messages,
          assistantMessage,
          ...toolResults,
        ],
        max_tokens: 800,
      });

      assistantMessage = finalResponse.choices[0].message;
    }

    return res.status(200).json({ reply: assistantMessage.content });

  } catch (err) {
    console.error("Chat handler error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}
