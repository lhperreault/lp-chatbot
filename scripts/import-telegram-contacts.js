// ─── One-shot: bulk-import Telegram Desktop contacts export into Airtable ──
//
// Usage (Windows PowerShell or cmd):
//   node scripts/import-telegram-contacts.js path\to\result.json
//   node scripts/import-telegram-contacts.js path\to\result.json --dry-run
//
// Telegram Desktop → Settings → Advanced → Export Telegram data →
//   uncheck everything except "Contacts list", Format: Machine-readable JSON,
//   Export. The script wants the result.json it produces.
//
// How it works:
//   1. Load AIRTABLE_* env vars from .env or .env.local (or system env).
//   2. Fetch ALL existing Clients once → build a Set of last-10-digit phones.
//   3. Walk the Telegram contacts list, normalize each phone to E.164.
//   4. Skip any whose last-10 already exist in Airtable.
//   5. Create new Client rows with Source="Telegram import", 250ms apart.
//   6. Print: added / skipped-existing / skipped-no-phone / errors.
//
// Dry-run prints what it would do without touching Airtable.

import fs from "node:fs";
import path from "node:path";

// ─── Env loading ─────────────────────────────────────────────────────
// No external dep — parse .env manually. Prefers .env.local (what
// `vercel env pull` writes) over .env.
function loadEnvFromFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq === -1) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const envFromLocal = loadEnvFromFile(path.join(process.cwd(), ".env.local"));
const envFromEnv   = loadEnvFromFile(path.join(process.cwd(), ".env"));
const ENV = { ...envFromEnv, ...envFromLocal, ...process.env };

const AT_KEY  = ENV.AIRTABLE_API_KEY;
const AT_BASE = ENV.AIRTABLE_BASE_ID;
const AT_CLIENTS = "Clients";

if (!AT_KEY || !AT_BASE) {
  console.error("[import] Missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID.");
  console.error("         Either create .env.local (try: `vercel env pull .env.local`)");
  console.error("         or set them inline: $env:AIRTABLE_API_KEY=\"pat...\"; node scripts/import-telegram-contacts.js file.json");
  process.exit(1);
}

// ─── Args ────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const dryRun   = args.includes("--dry-run");
const filePath = args.find(a => !a.startsWith("--"));

if (!filePath) {
  console.error("[import] Usage: node scripts/import-telegram-contacts.js <path-to-result.json> [--dry-run]");
  process.exit(1);
}
if (!fs.existsSync(filePath)) {
  console.error(`[import] File not found: ${filePath}`);
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────
function atUrl(table)  { return `https://api.airtable.com/v0/${AT_BASE}/${encodeURIComponent(table)}`; }
function atHeaders()   { return { Authorization: `Bearer ${AT_KEY}`, "Content-Type": "application/json" }; }
function sleep(ms)     { return new Promise(r => setTimeout(r, ms)); }

function parsePhoneToE164(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10)                           return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}
function last10(phone) {
  return String(phone || "").replace(/\D/g, "").slice(-10);
}

// ─── Fetch all existing Clients and index by last-10-digits ──────────
async function fetchAllExistingPhones() {
  const seen = new Set();
  let offset = undefined;
  let pages  = 0;
  do {
    const url = new URL(atUrl(AT_CLIENTS));
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("fields[]", "Phone");
    if (offset) url.searchParams.set("offset", offset);
    const res = await fetch(url, { headers: atHeaders() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable list failed: HTTP ${res.status} — ${body}`);
    }
    const data = await res.json();
    for (const rec of data.records || []) {
      const l10 = last10(rec.fields?.Phone);
      if (l10.length === 10) seen.add(l10);
    }
    offset = data.offset;
    pages++;
  } while (offset);
  console.log(`[import] Loaded ${seen.size} existing client phones across ${pages} page(s).`);
  return seen;
}

async function createClient(fields) {
  const res = await fetch(atUrl(AT_CLIENTS), {
    method: "POST",
    headers: atHeaders(),
    body: JSON.stringify({ fields, typecast: true }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} — ${JSON.stringify(data)}`);
  }
  return data;
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`[import] Reading: ${filePath}`);
  if (dryRun) console.log(`[import] DRY RUN — no Airtable writes will happen.`);

  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  // Telegram export shape: { contacts: { list: [ { first_name, last_name, phone_number, date } ] } }
  // Defensive: some exports nest differently — try a couple of shapes.
  const list =
    raw?.contacts?.list ||
    raw?.contacts ||
    (Array.isArray(raw) ? raw : []);
  if (!Array.isArray(list) || !list.length) {
    console.error("[import] Could not find a contacts array in that file. Expected `contacts.list[]`.");
    process.exit(1);
  }
  console.log(`[import] Found ${list.length} contacts in export.`);

  const existing = await fetchAllExistingPhones();

  let added = 0, alreadyInAirtable = 0, missingPhone = 0, errored = 0;
  const errors = [];

  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const first = (c.first_name || "").trim();
    const last  = (c.last_name  || "").trim();
    const name  = [first, last].filter(Boolean).join(" ").trim() || "Unknown";
    const phoneE164 = parsePhoneToE164(c.phone_number);
    const l10 = last10(phoneE164);

    const label = `${name} <${phoneE164 || "no-phone"}>`;

    if (!phoneE164 || l10.length !== 10) {
      missingPhone++;
      console.log(`  [skip ${i+1}/${list.length}] no-phone — ${label}`);
      continue;
    }
    if (existing.has(l10)) {
      alreadyInAirtable++;
      console.log(`  [skip ${i+1}/${list.length}] already in Airtable — ${label}`);
      continue;
    }

    if (dryRun) {
      console.log(`  [DRY ${i+1}/${list.length}] would add — ${label}`);
      added++;
      existing.add(l10);
      continue;
    }

    try {
      await createClient({
        Name:   name,
        Phone:  phoneE164,
        Source: "Telegram import",
      });
      existing.add(l10);
      added++;
      console.log(`  [add ${i+1}/${list.length}] ${label}`);
      await sleep(250); // Airtable: 5 req/sec per base — stay well under
    } catch (err) {
      errored++;
      const msg = err?.message || String(err);
      errors.push({ contact: label, error: msg });
      console.error(`  [err ${i+1}/${list.length}] ${label} — ${msg}`);
    }
  }

  console.log("");
  console.log("─── Summary ─────────────────────────────────");
  console.log(`  Added:                 ${added}${dryRun ? " (dry run)" : ""}`);
  console.log(`  Already in Airtable:   ${alreadyInAirtable}`);
  console.log(`  Skipped (no phone):    ${missingPhone}`);
  console.log(`  Errors:                ${errored}`);
  if (errors.length) {
    console.log("");
    console.log("  First few errors:");
    for (const e of errors.slice(0, 5)) {
      console.log(`    - ${e.contact}: ${e.error}`);
    }
  }
}

main().catch(err => {
  console.error("[import] Fatal:", err);
  process.exit(1);
});
