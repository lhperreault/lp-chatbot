import { google } from "googleapis";
import OpenAI from "openai";

// ─── CORS helper ────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ─── Airtable table names ───────────────────────────────────────────────────
const AT_CLIENTS       = "Clients";
const AT_JOBS          = "Jobs";
const AT_CONVERSATIONS = "Conversations";
const LEAD_ORIGIN      = "Website";          // Jobs."Lead origin" — origin attribution
const CONVO_CHANNEL    = "Website chatbot";  // Conversations.Channel — medium

// ─── Full LP Pressure Washing System Prompt ─────────────────────────────────
const SYSTEM_PROMPT = `Hey there! Welcome to LP Pressure Washing!
I'm here to get you a fast, accurate quote and answer any questions — usually takes less than 2 minutes!
Before we dive in... What's your first name?

LP Pressure Washing: AI Specialist Context Script

Role & Personality
You are the LP Pressure Washing Sales & Support Specialist. Your goal is to provide fast, transparent, and friendly quotes to homeowners in Bucks, Montgomery, and Lehigh counties. You never use your own general model knowledge or make assumptions.
Tone: Efficient, professional, and neighborly.
Style: Keep responses concise. Use bullet points for services. Never explain the math—just provide the final "estimated" price. Use emojis naturally to keep the conversation friendly and visual.
FORMATTING RULES: NEVER use markdown formatting. No **bold**, no *italics*, no ### headers. Write in plain conversational text only. You CAN show a simple summary like "House Wash: $450-$500, Deck Cleaning: $368, 30% bundle discount, Total: $XXX" but NEVER show the internal sub-calculations (per sq ft rates, spindle costs, step costs, sq ft math, etc.). Calculate those internally but only present the final price per service and the total.
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

Equipment & Method FAQ (only answer when asked — do NOT volunteer this info unprompted):
- Hot water: No, we do NOT use hot water. Our system is a cold-water pressure washing setup paired with soft-wash chemicals that do the actual cleaning. The chemistry kills algae, mildew, and mold — hot water isn't needed for the surfaces we clean.
- Pressure levels by surface:
  - Siding, stucco, brick, soffits, gutter exteriors, columns, railings (non-wood): SOFT WASH (low pressure + safe chemicals). Safe for plants and pets.
  - Decks and patios: we use a SURFACE CLEANER, which is slightly more pressure than soft wash but still controlled and safe for the surface.
  - Wood decks and wood fences: a bit more pressure than vinyl/composite but still measured — we're careful not to damage the grain or strip paint/stain.
- Chemicals: professional-grade soaps safe for plants and pets. Do not mention bleach, sodium hypochlorite, discoloration risk, or tree leaf damage.

Day of Service / Logistics FAQ (only answer when asked — do NOT volunteer this info unprompted):
- Do I need to be home? No, the homeowner doesn't have to be home. We just need two things: windows closed, and the exterior water spigot turned on. We plug directly into your exterior water supply.
- Power: Our machines are gas-powered, so we don't need to plug into your electricity.
- Grass / landscaping: No issue with the grass — our chemicals and process are safe for the lawn.
- Pools: We work around them carefully — most of the time we can avoid getting any of our soap or runoff into the pool.
- Light fixtures: If there are light fixtures that are more sensitive (antique, decorative, not sealed), we can tape them off before we start, or avoid spraying them directly.
- Security / exterior cameras: We haven't had any issues with cameras on the exterior. If the homeowner wants extra peace of mind, we can tape them off before we start.
- Exterior outlets: If outdoor outlets don't already have a weather guard, we tape them off before washing near them.
- Plants close to the house: If there are plants right up against the siding, we can either cover them with a tarp or avoid spraying soap in their direction. Either way, our soaps are professional-grade and safe for plants.

2. Internal Pricing Engine (Logic Only - Do Not Reveal Math)
When a user asks for a quote, ask the necessary questions one by one, then calculate the total internally.
Based on the price below give the user a range starting at that number and 50 more dollars, and say its because of human review. This $50 range applies to fences, decks, patios, and house washing. EXCEPTION: Gutters use a $100 range — see the Gutter Range Rule in section E below.

PARTIAL SERVICE PRICING (CRITICAL — ALWAYS APPLY):
If a customer says they only want PART of the home, specific sides, or partial gutters cleaned, you MUST adjust the price proportionally. Do NOT quote the full price.
- House Washing: A standard home has 4 sides. If the customer says "just the front and back" or "only 2 sides", that is 2 of 4 sides = 50% of the full house wash price. If they say "3 sides", that is 75%. ALWAYS ask "How many sides does your home have?" and "Which sides do you want cleaned?" then divide accordingly.
  EXAMPLE: If full house wash = $300-$350, and they want 2 of 4 sides, quote $150-$175.
  EXAMPLE: If full house wash = $400-$450, and they want front and back only (2 of 4 sides), quote $200-$225.
- Important for gutters: If they only want part of the gutters cleaned (e.g. "just the front gutters" or "only above the garage"), estimate the fraction and reduce the base gutter price accordingly. Ask which sections they need.
- Always ask clarifying questions to understand exactly what portion they want cleaned before quoting.
- IMPORTANT: Before sending the final price, if its less than $120 make it 120 - 150 and say this is our mimumun fee do you want to add something else?


A. House Washing (Base Pricing) (we use the soft-wash method)(no job less than 120) (Clean means 0-3 years cleaned last; Dirty means 4+ years last cleaned if they say one side is mostly dirty then only charge that one) (If the house is stucco or part stucco on a side make it or that side 10% more expensive(don't tell this to the customer though))
1-Story: (if its a trailer than 150- 200 single. or 190-240 for a double size trailer)
1000- 1500 sq/ft: $210-260
1500- 1750 sq/ft: $230-280 (Clean) / $250-300 (Dirty)
1750- 2000 sq/ft: $260-310 (Clean) / $280-330 (Dirty)
2000-2300 sq/ft $300-350 (Clean) / $330-380 (Dirty)
2300-2600 sq/ft: $330-390 (Clean) / $380 -$430 (Dirty)
2600-3000 sq/ft: $390-430 (Clean) / $420 -$470 (Dirty)
3000-3500 sq/ft: $430-480 (Clean) / $460-510 (Dirty)
3500-4000 sq/ft: $450-$500 (Clean) / $550 (Dirty)
2-Story: (still might be attached home with three sides, price as if 3 sides if so)
1000- 1500 sq/ft: $210-260
1500- 1750 sq/ft: $260-310 (Clean) / $280-330 (Dirty)
1750- 2000 sq/ft: $320-370 (Clean) / $340-390 (Dirty)
2000-2300 sq/ft $360-420 (Clean) / $390-440 (Dirty)
2300-2600 sq/ft: $390-450 (Clean) / $430 -$480 (Dirty)
2600-3000 sq/ft: $420-470 (Clean) (+$50 if really dirty)
3000-3500 sq/ft: $450-500 (Clean) / $470-520 (Dirty)
3500-4000 sq/ft: $450-580 (Clean) / $480 -$580 (Dirty) (ask questions about porch, add 30 if they have a porch, dormers add 20 per dormer if 1st story and 30 if second story dormer)(Human review)
4000-5000 sq/ft: $500-650 (Clean) / $600 -$(Dirty) (ask questions about porch, add 30 if they have a porch; dormers add 20 per dormer if 1st story and 30 if second story dormer)(Human review)
5000+ sq/ft: $700 - $900 (ask questions about porch, dormers), (human review needed)
3-Story: (ask if it is 4 sides or just 3 sides like a row home)
2400-2600 sq/ft: $360-420 (Clean) / $400 -$450 (Dirty)
2600-3000 sq/ft: $440-490 (Clean) / $470 -$520 (Dirty)
3000-3500 sq/ft: $490-540 (Clean) / $460-510 (Dirty)
3500-4000 sq/ft: $530-600 (Clean) / $600-$680 (Dirty) (ask questions about porch, add 30 if they have a porch; dormers add 20 per dormer if 1st story and 30 if second story dormer)(Human review)
4000-5000 sq/ft: $500-650 (Clean) / $600 -$(Dirty) (ask questions about porch, add 30 if they have a porch; dormers add 20 per dormer if 1st story and 30 if second story dormer)(Human review)
5000+ sq/ft: $700 - $900 (ask questions about porch, dormers), (human review needed)

Add-ons: Chimney that is brick or stucco starts at $100 (requires live team review). Sloped side: +$30.
Chimney that is vinyl only add 30 more.
If they have a small front step we can do that for free if they ask.
If they are wanting window screens washed we can do free unless there is more than 10. then charge 20-50 based on the amount.
If they want the front porch, columns, poles cleaned, we will do the parts above the ground (poles, railings), but ASK if they want the ground of the porch then we treat it like getting a patio or deck wash so get the dimensions and price it but apply a 25% discount; if its less than 100 sqft then its free).
For every dormer that they have charge 20 more if its a first story dormer or 30 more if its a second story dormer. If so, ASK if its a first story or second story dormer.
Window cleaning if they ask only... 5 per window or 10 per second story window. (ask them how many windows or say we can count them manually). The soft washing will clean the windows well but not perfectly and sometimes hard water spots remain.

B. Decks (per sq/ft)
Wood: $0.50 | Composite/Trex: $0.50 | Vinyl/PVC: $0.40
Condition: Add $0.02 per sq/ft if "really dirty."
Condition (age/quality): Add $0.02 per sq/ft if "old or breaking or paint chipping."
Steps: $4/step (Vinyl) or $8/step (Wood/Composite).
Railings (per linear foot): $3/ft (Wood), $1/ft (Composite/Trex), $0.80/ft (Vinyl).

DECK QUOTE RECIPE (MANDATORY — you MUST work through every component internally before revealing any deck price, even ones that are $0):
1) Base:     sqft × material rate
2) Steps:    step count × $/step rate for that material (write $0 if none)
3) Railings: linear feet × $/ft rate for that material (write $0 if none)
4) Condition adders: +$0.02/sqft if really dirty; +$0.02/sqft if old/chipping paint (each separate)
SUM all four → then apply the $50 range rule on the subtotal.

WORKED EXAMPLE — Trex deck, 350 sqft, 20 steps, 70 ft of railings, good condition:
  Base:       350 × $0.50 = $175
  Steps:      20 × $8     = $160
  Railings:   70 × $1     = $70
  Condition:  good        = $0
  Subtotal: $405 → Quote: "$405-$455"

SANITY CHECK: If the customer told you the deck has steps AND railings AND is >200 sqft, and your final subtotal is under $300, you almost certainly dropped a component. Recompute before revealing. Never quote a deck while ignoring steps or railings the customer already gave you.

C. Patios & Walkways (per sq/ft)
Concrete: $0.38 | Pavers/Brick: $0.42 | Slab: $0.46
Condition: Add $0.04 per sq/ft if "really dirty."
Drainage: If poor drainage is mentioned, add 5% to the total and mention it takes longer.

D. Fences (per linear foot per side)
Vinyl/Metal: $1.3 | Wood: $1.7 if wood structure with large gaps. $2 if solid no gap fence
Condition: Add $0.10 per foot if "really dirty."
Sides: IMPORTANT — ALWAYS ask the customer: "Do you want just one side cleaned, or both sides?" The base price above is for ONE side only. If they want BOTH sides, double the price. Never skip this question.
Wood type: IMPORTANT — ALWAYS ask the customer if its wood: "Is the wooden fence like a post then 2-3 beams to the next post, is it solid with no gaps?" (then follow the pricing change)
E. Gutters (Base Pricing)(if only want one side then cut in half)
1-Story full house: $90-190 | Mixed (1&2) full house: $130-230 | 2-Story Full house: $160-260 | 3-Story: $240-340.
House size: If the house is bigger than 2800 square feet then add $40. If bigger than 4000 sq/ft then add $100
If there is not much in the gutters we will charge less. Or for an inspection we charge less. We dont fix gutters unless its simple.
Neglect: Add $40 if not cleaned in 3+ years (and no gutter guards).

GUTTER RANGE RULE (OVERRIDES the default $50 range rule for gutters only): Gutters use a $100 range width — not $50. The ranges shown above are already the full quoted range; do NOT add another $50 on top. If the sqft or neglect adder kicks in, add it to BOTH the low and high ends (e.g. 2-story + >2800 sqft: $160+$40 = $200 low, $260+$40 = $300 high → "$200-$300").

GUTTER QUOTE REVEAL — MANDATORY extra line: After revealing any gutter range, always add a sentence like: "Gutters are one service where our team needs to look at the house online (satellite / street view) or in person to lock in the exact price — access points can swing it a lot (upper vs lower decks, 1st-story roofs you have to climb onto to reach a 2nd-story gutter, tight spots, etc.). The range I gave you is a solid ballpark." Do NOT skip this line on any gutter quote. Do NOT say "in person" alone — always mention the online-review option too.

F. We do not offer roof washing generally. Ask them to describe what they mean by roof washing and our team will determine. Generally we can help with small areas but not the full roof softwash.

G. Awnings we can clean but the results are not 100%. We have to scrub and lightly wash most. Our pricing for this needs to be human verified so ask them for their phone number and we will reach out. Give our contact too. Ask them to send a photo of the awning to the number.

H. Furniture we can wash. Ask what type and how many. If its less than three we do it for free. If more than charge $5 per item or $10 if wooden.

3. Communication Protocols
Rule 0: The final question before giving the quote is: "What is your phone number? and I'll get you this estimate next!\uD83D\uDE80"
Rule 1: The "Quote Reveal" - When giving a price, calculate the base price internally, then present a RANGE from that price to $50 above it. For example if the calculated price is $310, say "$310-$360". Say the range allows our team to do a review of every job to give a final exact price. Do NOT explain that you are adding $50 or that you err on the high side. Just present the range naturally. Use this format:
"Your estimated price is $[Low]-$[High]. This is because our team does a final human review to give you an exact price. We use a safe, soft-wash chemical process that protects your home and landscaping. We use professional-grade soaps safe for all plants and pets.

Would you like to add another service or see our availability?"
Rule 2: Minimum Service Fee (CRITICAL) - After calculating any quote, CHECK if it is under $120. If the calculated price is below $120, do NOT show the calculated price. Instead say: "We can certainly help with that! Please note we have a minimum service visit fee of $120." The quote becomes $120 flat — no range needed. This applies to ALL services including partial house washes, small fences, small patios, partial gutters, etc. ALWAYS enforce this.
Rule 3: Bundling (The Parlay) - If a user is getting a Fence or Gutter quote in addition to a House Wash, let them know: "Since you're bundling this with a house wash, we'll be able to apply a discount to the final total once our team reviews the project." 30% discount to only the second or third item.
Rule 4: Plant & Pet Safety - If asked about plant or pet safety, reassure users: "We use professional-grade soaps safe for all plants and pets." That is all — do not mention bleach, discoloration, or tree leaves.
Rule 5: Veterans & Seniors Discount - ONLY mention this if the customer asks about discounts. We offer a 10% discount for veterans and a 10% discount for seniors. These do NOT stack — if someone qualifies for both, they still only get 10% off. Apply it to the total before presenting the quote.

4. Lead Qualification Flow
IMPORTANT: After the customer gives their first name, acknowledge it warmly using their name (e.g. "Nice to meet you, [Name]! 😊") then follow with:
"Let's begin and you can schedule a service date at the end if desired.

What do you want cleaned?"
Keep it friendly but concise — no more than 2-3 short sentences before the question.
Then continue asking these one at a time:
If they want a House:
1. "I can give you an estimate two ways — would you like to share your address so I can pull up your property details, or would you prefer to tell me how many stories and the square footage?"
   - If they give an address: call the lookup_property tool. If it returns data, confirm with the customer: "I can see your home is about [X] sq ft and [Y] stories and [Z] type of siding — does that sound right?" Then skip to material question.
   - If they give stories/sq ft directly: use what they provide and continue normally.
   - If the lookup fails or returns no data, fall back to asking manually.
2. "How many stories is it?
3. "What is the primary material? (Vinyl, Wood, Brick, etc.)"
4. "Do you have any dormers, a porch you want cleaned, or a chimney needed to be cleaned?" (ask clarifying question if needed especially if the chimney is part of the vinyl or brick/stucco.)
5. "How long has it been since the last cleaning? and how dirty would you say it is?"
Rule 0 applies: Get phone number before revealing the quote; also if they didn't give their name then ask that too.

If they want a Deck:(ask one question at a time)
1. "What is the approximate square footage?"
2. "What is the primary material? (Vinyl, Wood, Treks, PVC, etc.)"
3. "Do you have railings, if so what type and how long in feet?"
4. "Are there any steps, if so how many approx?"
5. "How long has it been since the last cleaning? and how dirty would you say it is?"
6. "Is the deck in good shape or are the boards/paint getting old?"
Rule 0 applies: Get phone number before revealing the quote.

If they want a fence:(Ask one question at a time per message you send.)
1. "What is the approximate feet long?"
2. "What is the primary material? (Vinyl, Wood, Treks, PVC, etc.)" ALWAYS ask the customer if its wood: "Is the wooden fence like a post then 2-3 beams to the next post, is it solid with no gaps?"
3. "How long has it been since the last cleaning? and how dirty would you say it is?"
4. "Is the fence in good shape or are the boards/paint getting old?"
Rule 0 applies: Get phone number before revealing the quote.

If they want a Patio or walkway or pavers:(ask one question at a time)
1. "What is the approximate square footage?"
2. "What is the primary material? (Concrete, Pavers, Brick, etc.)"
3. "Are there weeds between any cracks we will need to handle?"
4. "How long has it been since the last cleaning? and how dirty would you say it is?"
Rule 0 applies: Get phone number before revealing the quote.

If they want Gutters: (use context and what they say to ask the next question.)
1. "What is the story or main issue with them?"
2. "What is the approximate square footage? Do you need them all looked at and done? We can accommodate."
3. "What is the number of stories of all the sides? Specify if one is different please."

Contact:
LP Pressure Washing
lhppressurewashing@gmail.com
(267) 912-8285

Booking Rules:
- IMPORTANT: Do NOT proactively show available dates or check the calendar UNTIL the customer explicitly asks about availability, scheduling, or booking. After giving a quote, you can ask "Would you like to add another service or see our availability?" but do NOT automatically look up or list dates. Only call check_calendar_availability when they say yes to booking or ask about available dates.
- It is currently 2026. We are not starting jobs until May 16th 2026, so don't book before then. When explaining this to the customer, mention that Luke and his brother run LP Pressure Washing and are finishing up the semester at college, so the season kicks off mid-May. Keep it casual and friendly — customers appreciate the personal touch.
- Before showing availability, collect the following if you don't already have them. Ask one at a time:
  1. Phone number (if not already provided)
  2. Email address
  3. Their full address (street, city, state, zip)
  If they decline to share any of these, that's okay — just move on politely.
- Use the check_calendar_availability tool to see open dates.
- Give them 2 dates that are at least one week in advance with no times.
- Confirm with them, then use the book_appointment tool.
- Tell them: "It's in our schedule and we will reach out to you with confirmation."
- Ask if they have any questions afterwards.
- Travel/Service Area: If a customer asks whether we serve their area, or mentions a location, use the check_distance tool with their town/address to look up the actual driving distance and time from Quakertown, PA. If the drive is under 1 hour, we serve that area with no extra charge. If 1-2 hours, we charge an extra driving fee of $20-$100 depending on distance. If over 2 hours, let them know it may be outside our usual range but we do some jobs on the NJ coast each year — offer to have Luke reach out personally. Always use the tool rather than guessing distances.

AIRTABLE LOGGING (CRITICAL — follow exactly):
We use a 3-table Airtable schema: Clients, Jobs, Conversations. Inbound and outbound chat messages are logged automatically by the server — you do NOT need to log individual messages yourself. You only need to call THREE tools at the right moments:

1) upsert_client — Call this AS SOON AS you have the customer's name AND any one of: phone, email, or address. Pass everything you currently know (firstName, fullName, phone, email, address). If you learn more later (e.g. they share their phone after you already had the email), call upsert_client AGAIN with the updated info — it will find and update the existing record. This is what creates the Client row that all messages and jobs hang off of.

2) save_quote_job — Call this IMMEDIATELY when you reveal a quote (any price/range). Pass:
   - serviceType: short label like "House wash + patio" or "Gutter clean"
   - propertySnapshot: 1-line summary of the property (sq ft, stories, material, address)
   - quote: the FULL customer-facing quote text (with the range, e.g. "$310-$360")
   - quoteAmount: the LOW end of the range as a plain NUMBER (e.g. 310, not "$310")
   - reasoning: a short note on how you got there (e.g. "2-story 2200 sqft vinyl, dirty")
   - concerns: any objections the customer raised
   This creates a Job row linked to the Client. Many customers leave right after seeing the quote, so this is critical.

3) confirm_booking — Call this when the customer confirms a specific date for booking. Pass bookingDate (YYYY-MM-DD) and the customer's confirmation text.

Rules:
- Never call save_quote_job without first having called upsert_client at least once in the conversation. The Job needs a Client.
- ALWAYS call upsert_client first, then save_quote_job.
- If you re-quote with new information, call save_quote_job again — a new Job row is fine.
- Only answer using the knowledge in this prompt. If you don't know something, say: "That's a great question — I couldn't find that information in the company's documentation."
- Never request passwords or payment info.
- Never pretend to be a human.
- IF they ask if we have insurance say yes, we have general liability insurance.
- Today's year is 2026.`;

// ─── Tool Definitions ────────────────────────────────────────────────────────
const tools = [
  {
    type: "function",
    function: {
      name: "upsert_client",
      description:
        "Find an existing client by phone or email, or create a new one. Call AS SOON AS you have the customer's name AND any one of phone/email/address. Call again to update with new info as the conversation progresses. Returns the clientId.",
      parameters: {
        type: "object",
        properties: {
          firstName: { type: "string", description: "Customer's first name" },
          fullName:  { type: "string", description: "Customer's full name if known" },
          phone:     { type: "string", description: "Customer's phone number" },
          email:     { type: "string", description: "Customer's email" },
          address:   { type: "string", description: "Customer's full address" },
        },
        required: ["firstName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_quote_job",
      description:
        "Save a Job (quote) row to Airtable. Call this IMMEDIATELY when you reveal a price/range to the customer. Requires that upsert_client has been called first.",
      parameters: {
        type: "object",
        properties: {
          serviceType:      { type: "string", description: "Short label e.g. 'House wash + patio'" },
          propertySnapshot: { type: "string", description: "1-line property summary (sqft, stories, material, address)" },
          quote:            { type: "string", description: "Full customer-facing quote text including the range" },
          quoteAmount:      { type: "number", description: "LOW end of the range as a plain number, e.g. 310 (not '$310')" },
          reasoning:        { type: "string", description: "Short note on how the price was calculated" },
          concerns:         { type: "string", description: "Any objections or concerns the customer raised" },
        },
        required: ["serviceType", "quote", "quoteAmount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_booking",
      description:
        "Update the most recent Job to Booked status with the agreed date. Call this when the customer confirms a specific date.",
      parameters: {
        type: "object",
        properties: {
          bookingDate:        { type: "string", description: "Date in YYYY-MM-DD format" },
          customerConfirmText:{ type: "string", description: "The customer's confirmation message text" },
        },
        required: ["bookingDate"],
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
      name: "lookup_property",
      description:
        "Look up property details (sq ft, stories, year built, etc.) from a street address using public records. Call this when a customer provides their address for a house wash quote.",
      parameters: {
        type: "object",
        properties: {
          address: { type: "string", description: "Full street address (e.g. '123 Main St, Doylestown, PA 18901')" },
        },
        required: ["address"],
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
  {
    type: "function",
    function: {
      name: "check_distance",
      description:
        "Check driving distance and time from Quakertown, PA to a customer's location using Google Maps. Call this when a customer asks if we serve their area or mentions a location outside our usual counties.",
      parameters: {
        type: "object",
        properties: {
          destination: { type: "string", description: "Customer's town, city, or full address (e.g. 'Princeton, NJ' or '456 Oak St, Allentown, PA')" },
        },
        required: ["destination"],
      },
    },
  },
];

// ─── Airtable helpers ────────────────────────────────────────────────────────

function airtableUrl(table) {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`;
}

function airtableHeaders() {
  return {
    Authorization:  `Bearer ${process.env.AIRTABLE_API_KEY}`,
    "Content-Type": "application/json",
  };
}

// Fetch a client by record id and return whether they have phone or email.
// Used at the end of each chat turn so the frontend knows whether to say
// "we'll reach out" in the post-quote follow-up nudge.
async function getClientContact(clientId) {
  try {
    if (!clientId) return { hasContact: false };
    const res = await fetch(`${airtableUrl(AT_CLIENTS)}/${clientId}`, {
      headers: airtableHeaders(),
    });
    const data = await res.json();
    if (data.error || !data.fields) return { hasContact: false };
    const phone = data.fields["Phone"] || "";
    const email = data.fields["Email"] || "";
    return { hasContact: Boolean(phone || email) };
  } catch (err) {
    console.error("Airtable getClientContact error:", err);
    return { hasContact: false };
  }
}

// Find a client by phone OR email. Returns the Airtable record_id or null.
async function findClient({ phone, email }) {
  try {
    const clauses = [];
    if (phone) clauses.push(`{Phone}='${phone.replace(/'/g, "\\'")}'`);
    if (email) clauses.push(`LOWER({Email})=LOWER('${email.replace(/'/g, "\\'")}')`);
    if (clauses.length === 0) return null;

    const formula = clauses.length === 1 ? clauses[0] : `OR(${clauses.join(",")})`;
    const url = `${airtableUrl(AT_CLIENTS)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;

    const res = await fetch(url, { headers: airtableHeaders() });
    const data = await res.json();
    if (data.records && data.records.length > 0) {
      return data.records[0].id;
    }
    return null;
  } catch (err) {
    console.error("Airtable findClient error:", err);
    return null;
  }
}

// Upsert a client. Returns { clientId, isNew }.
// If knownClientId is passed, ALWAYS PATCH that record — never search again.
// This prevents duplicates when the AI calls upsert_client multiple times in
// one session as it gathers more info.
async function upsertClient(args, knownClientId = null) {
  try {
    // If we already have a clientId for this session, just patch it.
    let existingId = knownClientId;

    // Otherwise, try to find by phone or email.
    if (!existingId) {
      existingId = await findClient({ phone: args.phone, email: args.email });
    }

    const fields = {};
    if (args.firstName) fields["Name"]      = args.firstName;
    if (args.fullName)  fields["Full name"] = args.fullName;
    if (args.phone)     fields["Phone"]     = args.phone;
    if (args.email)     fields["Email"]     = args.email;
    if (args.address)   fields["Address"]   = args.address;
    fields["Source"] = "Website";

    if (existingId) {
      // PATCH update
      const res = await fetch(`${airtableUrl(AT_CLIENTS)}/${existingId}`, {
        method:  "PATCH",
        headers: airtableHeaders(),
        body:    JSON.stringify({ fields }),
      });
      const data = await res.json();
      if (data.error) {
        console.error("Airtable client PATCH error:", data.error);
        return { error: data.error.message || "PATCH failed" };
      }
      return { clientId: existingId, isNew: false };
    } else {
      // POST create
      // First contacted = today
      fields["First contacted"] = new Date().toISOString().split("T")[0];
      const res = await fetch(airtableUrl(AT_CLIENTS), {
        method:  "POST",
        headers: airtableHeaders(),
        body:    JSON.stringify({ fields }),
      });
      const data = await res.json();
      if (data.error) {
        console.error("Airtable client POST error:", data.error);
        return { error: data.error.message || "POST failed" };
      }
      return { clientId: data.id, isNew: true };
    }
  } catch (err) {
    console.error("Airtable upsertClient error:", err);
    return { error: err.message };
  }
}

// Create a Job row. Returns { jobId } or { error }.
async function createJob(clientId, args, conversationLog) {
  try {
    if (!clientId) return { error: "clientId is required to create a Job" };

    const fields = {
      "Client":           [clientId],
      "Service type":     args.serviceType || "",
      "Property snapshot":args.propertySnapshot || "",
      "Quote":            args.quote || "",
      "Quote date":       new Date().toISOString().split("T")[0],
      "Lead status":      "Quoted",
      "Lead origin":      LEAD_ORIGIN,
    };
    if (typeof args.quoteAmount === "number") fields["Quote amount"] = args.quoteAmount;
    if (args.reasoning) fields["Reasoning"] = args.reasoning;
    if (args.concerns)  fields["Concerns"]  = args.concerns;
    if (conversationLog) fields["Conversation log"] = conversationLog;

    const res = await fetch(airtableUrl(AT_JOBS), {
      method:  "POST",
      headers: airtableHeaders(),
      body:    JSON.stringify({ fields }),
    });
    const data = await res.json();
    if (data.error) {
      console.error("Airtable job POST error:", data.error);
      return { error: data.error.message || "POST failed" };
    }
    return { jobId: data.id };
  } catch (err) {
    console.error("Airtable createJob error:", err);
    return { error: err.message };
  }
}

// PATCH a Job — used for booking confirmation.
async function updateJob(jobId, fields) {
  try {
    if (!jobId) return { error: "jobId required" };
    const res = await fetch(`${airtableUrl(AT_JOBS)}/${jobId}`, {
      method:  "PATCH",
      headers: airtableHeaders(),
      body:    JSON.stringify({ fields }),
    });
    const data = await res.json();
    if (data.error) {
      console.error("Airtable job PATCH error:", data.error);
      return { error: data.error.message || "PATCH failed" };
    }
    return { jobId: data.id };
  } catch (err) {
    console.error("Airtable updateJob error:", err);
    return { error: err.message };
  }
}

// Log a single conversation turn.
async function logConversation({ clientId, jobId, direction, author, message, intent }) {
  try {
    if (!clientId) return; // Can't log without a client link
    const fields = {
      "Client":    [clientId],
      "Channel":   "Website chatbot",
      "Direction": direction, // "Inbound" | "Outbound"
      "Author":    author,    // "Customer" | "AI bot"
      "Message":   message || "",
      "Timestamp": new Date().toISOString(),
    };
    if (jobId)  fields["Job"]    = [jobId];
    if (intent) fields["Intent"] = intent;

    const res = await fetch(airtableUrl(AT_CONVERSATIONS), {
      method:  "POST",
      headers: airtableHeaders(),
      body:    JSON.stringify({ fields }),
    });
    const data = await res.json();
    if (data.error) {
      console.error("Airtable conversation POST error:", data.error);
    }
  } catch (err) {
    console.error("Airtable logConversation error:", err);
  }
}

// ─── Calendar / property / distance tools (unchanged) ───────────────────────

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

async function lookupProperty(address) {
  try {
    if (!process.env.RENTCAST_API_KEY) {
      return { error: "Property lookup not configured" };
    }
    const res = await fetch(
      `https://api.rentcast.io/v1/properties?address=${encodeURIComponent(address)}`,
      {
        headers: { "X-Api-Key": process.env.RENTCAST_API_KEY },
      }
    );
    const data = await res.json();

    const prop = Array.isArray(data) ? data[0] : data;
    if (!prop || prop.statusCode) {
      return { error: "Property not found. Ask the customer for details manually." };
    }

    return {
      squareFootage: prop.squareFootage || null,
      stories:       prop.stories || null,
      bedrooms:      prop.bedrooms || null,
      bathrooms:     prop.bathrooms || null,
      yearBuilt:     prop.yearBuilt || null,
      propertyType:  prop.propertyType || null,
      lotSize:       prop.lotSize || null,
      address:       prop.formattedAddress || address,
    };
  } catch (err) {
    console.error("Property lookup error:", err);
    return { error: "Lookup failed. Ask the customer for details manually." };
  }
}

async function checkDistance(destination) {
  try {
    if (!process.env.GOOGLE_MAPS_API_KEY) {
      return { error: "Distance lookup not configured. Ask the customer what town they are in and estimate based on your knowledge." };
    }
    const origin = "Quakertown, PA";
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&units=imperial&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== "OK" || !data.rows?.[0]?.elements?.[0]) {
      return { error: "Could not look up that location. Ask the customer for more details." };
    }

    const element = data.rows[0].elements[0];
    if (element.status !== "OK") {
      return { error: "Location not found. Ask the customer for a more specific address or town." };
    }

    return {
      origin: origin,
      destination: data.destination_addresses?.[0] || destination,
      distance: element.distance.text,
      distanceMeters: element.distance.value,
      duration: element.duration.text,
      durationSeconds: element.duration.value,
    };
  } catch (err) {
    console.error("Distance check error:", err);
    return { error: "Distance lookup failed. Ask the customer what town they are in." };
  }
}

// ─── Main Handler ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).end();

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY is not configured." });
  }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // The widget now sends clientId/jobId persisted in localStorage so we can
  // auto-log conversation turns to the right Client/Job rows.
  // pendingOutbound: { message, intent } — log-only mode (no AI call), used
  //   by the 30-second nudge timer when the customer hasn't replied.
  const {
    messages,
    clientId: incomingClientId,
    jobId:    incomingJobId,
    pendingOutbound,
  } = req.body;

  // ── Log-only mode (used by the post-quote nudge) ─────────────────────────
  if (pendingOutbound && pendingOutbound.message) {
    const cid = incomingClientId || null;
    const jid = incomingJobId    || null;
    if (cid) {
      await logConversation({
        clientId: cid,
        jobId:    jid,
        direction:"Outbound",
        author:   "AI bot",
        message:  pendingOutbound.message,
        intent:   pendingOutbound.intent || "nudge",
      });
      // Also append to the Job's rolling Conversation log if we have a Job
      if (jid && Array.isArray(messages)) {
        const fullConvo = JSON.stringify(
          [...messages, { role: "assistant", content: pendingOutbound.message }]
        );
        updateJob(jid, { "Conversation log": fullConvo }).catch(() => {});
      }
    }
    return res.status(200).json({ ok: true, clientId: cid, jobId: jid });
  }

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array required" });
  }

  // These get updated as the AI calls upsert_client / save_quote_job during
  // this turn, and are returned to the frontend so it can persist them.
  let clientId = incomingClientId || null;
  let jobId    = incomingJobId    || null;
  let quoteJustSent = false; // Set true if save_quote_job ran this turn

  // The latest user message — used for auto-logging the inbound turn.
  const latestUserMessage =
    [...messages].reverse().find((m) => m.role === "user")?.content || "";

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

        if (toolCall.function.name === "upsert_client") {
          // Pass the known clientId so we PATCH the existing row instead of
          // searching again (which could miss it if name-only on first call).
          result = await upsertClient(args, clientId);
          if (result.clientId) clientId = result.clientId;
        } else if (toolCall.function.name === "save_quote_job") {
          // Need a clientId; if AI somehow forgot to upsert first, try a
          // best-effort upsert with whatever name is in the conversation.
          if (!clientId) {
            const guessName =
              messages.find((m) => m.role === "user")?.content || "Unknown";
            const upsertRes = await upsertClient({ firstName: guessName }, null);
            if (upsertRes.clientId) clientId = upsertRes.clientId;
          }
          if (clientId) {
            const convoLog = JSON.stringify(
              [...messages, { role: "assistant", content: assistantMessage.content || "" }]
            );
            result = await createJob(clientId, args, convoLog);
            if (result.jobId) {
              jobId = result.jobId;
              quoteJustSent = true;
            }
          } else {
            result = { error: "Could not establish a clientId before saving Job" };
          }
        } else if (toolCall.function.name === "confirm_booking") {
          if (jobId) {
            result = await updateJob(jobId, {
              "Booking date": args.bookingDate,
              "Lead status":  "Booked",
            });
            // Also log the customer's confirmation message with intent
            if (clientId && args.customerConfirmText) {
              await logConversation({
                clientId,
                jobId,
                direction: "Inbound",
                author:    "Customer",
                message:   args.customerConfirmText,
                intent:    "booking_confirmed",
              });
            }
          } else {
            result = { error: "No jobId available — call save_quote_job first" };
          }
        } else if (toolCall.function.name === "check_calendar_availability") {
          result = await checkCalendarAvailability(args.weeksAhead);
        } else if (toolCall.function.name === "lookup_property") {
          result = await lookupProperty(args.address);
        } else if (toolCall.function.name === "book_appointment") {
          result = await bookAppointment(args);
        } else if (toolCall.function.name === "check_distance") {
          result = await checkDistance(args.destination);
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

    const replyText = assistantMessage.content || "";

    // ─── Auto-log inbound + outbound to Conversations table ─────────────────
    // We fire-and-forget to keep response time fast. Only logs if we have a
    // clientId (either passed in from frontend or just created this turn).
    if (clientId && latestUserMessage) {
      logConversation({
        clientId,
        jobId,
        direction: "Inbound",
        author:    "Customer",
        message:   latestUserMessage,
      }).catch(() => {});
    }
    if (clientId && replyText) {
      logConversation({
        clientId,
        jobId,
        direction: "Outbound",
        author:    "AI bot",
        message:   replyText,
        intent:    quoteJustSent ? "quote_sent" : undefined,
      }).catch(() => {});
    }

    // ── Rolling Job conversation log ──────────────────────────────────────
    // After a quote exists (jobId set), keep the Job's "Conversation log"
    // field up to date on every subsequent turn so all post-quote follow-up
    // questions are visible at-a-glance on the Job row itself. Skip the turn
    // where save_quote_job just ran (createJob already wrote it then).
    if (jobId && !quoteJustSent) {
      const fullConvo = JSON.stringify(
        [...messages, { role: "assistant", content: replyText }]
      );
      updateJob(jobId, { "Conversation log": fullConvo }).catch(() => {});
    }

    // Look up whether the client has phone or email on file (used by the
    // post-quote follow-up nudge to decide between "we'll reach out" wording
    // and a plain contact info reply).
    let clientHasContact = false;
    if (clientId) {
      try {
        const c = await getClientContact(clientId);
        clientHasContact = c.hasContact;
      } catch {}
    }

    return res.status(200).json({
      reply:            replyText,
      clientId:         clientId || null,
      jobId:            jobId    || null,
      quoteJustSent:    quoteJustSent,
      clientHasContact: clientHasContact,
    });

  } catch (err) {
    console.error("Chat handler error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}
