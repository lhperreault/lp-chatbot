// lib/currentOffer.js
//
// Single source of truth for the current customer-facing promotion.
// Both api/estimate.js (website chat) and api/sms.js (SMS chatbot)
// import OFFER_PROMPT_BLOCK and inject it into their AI system prompts.
//
// ─── HOW TO SWAP A PROMOTION ──────────────────────────────────────────
//
//   1. Edit OFFER_ACTIVE / OFFER_NAME / OFFER_END_DATE / the rules
//      block below to describe the new offer.
//   2. Commit + push. Both website chat and SMS pick it up on the next
//      Vercel deploy (~30 sec).
//   3. To turn the offer OFF entirely (no promo running), set
//      OFFER_ACTIVE = false — the bot will quote standard prices and
//      will not mention any discount.
//
// The Anthropic prompt cache will rebuild once when the offer changes
// (one cache miss is normal), then keep hitting cache for every
// subsequent request until the next swap.

export const OFFER_ACTIVE   = true;
export const OFFER_NAME     = "Memorial Day Special";
export const OFFER_END_DATE = "May 31, 2026";

// ─── ACTIVE OFFER PROMPT TEMPLATE ─────────────────────────────────────
// This is the block of rules the AI follows when an offer is running.
// Edit the bullet points below to reshape what discount applies, what
// the bot says when revealing prices, and how it handles
// pricing-clarity questions.
const ACTIVE_OFFER_BLOCK = `
==========================================
CURRENT OFFER — ${OFFER_NAME} (active through ${OFFER_END_DATE}, CRITICAL):
- HOUSE WASH alone: Quote the standard house-wash range straight from the pricing table. Do NOT apply any house-wash discount. Do NOT mention the offer if the customer is only getting a house wash with no add-ons.
- ADDITIONAL SERVICES paired with a house wash (deck, patio, fence, gutters, etc.): The pricing tables in this prompt already include the 30% off discount for these services — do NOT apply another 30%. When you reveal the price for an add-on, mention: "this includes 30% off as part of our ${OFFER_NAME} — all additional services are 30% off when paired with a house wash."
- ADDITIONAL SERVICES alone (no house wash in the same quote): the 30% bundle discount does NOT apply. Quote standard add-on pricing and do NOT mention the offer.
- CRITICAL — pricing-clarity questions: If the customer asks ANY variation of "is the discount included in this price?" / "is this the discounted price?" / "how much would it be without the discount?" / similar — respond EXACTLY with: "The LP team needs to verify the pricing of everything before moving forward." Do NOT improvise around this.
- Do NOT calculate or reveal a "without discount" or "before discount" price under any circumstance.
==========================================
`;

// ─── NO-OFFER FALLBACK ────────────────────────────────────────────────
// Used when OFFER_ACTIVE = false. Tells the AI to quote standard prices
// and stay silent about any promo (so a stale-cache response can't say
// "Mother's Day 10% off!" in July).
const NO_OFFER_BLOCK = `
==========================================
CURRENT OFFER: No promotion is currently running. Do NOT mention any discount, special, or sale. Quote standard prices from the pricing tables below.
==========================================
`;

export const OFFER_PROMPT_BLOCK = OFFER_ACTIVE ? ACTIVE_OFFER_BLOCK : NO_OFFER_BLOCK;
