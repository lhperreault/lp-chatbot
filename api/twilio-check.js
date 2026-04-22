// ─── One-shot Twilio credential diagnostic ─────────────────────────────
// GET https://chatbot-t1bk.vercel.app/api/twilio-check
//
// Runs a safe read-only Twilio API call (GET /Accounts/{SID}.json) using
// whatever credentials Vercel has in env right now. Returns the Twilio
// response verbatim so you can see exactly what's wrong, plus safe-to-share
// metadata about the env vars (length, prefix, suffix) to catch silent
// whitespace issues without leaking secrets.
//
// Delete this file or add an auth check once debugging is done — anyone
// who hits this URL can see non-secret credential metadata.

export default async function handler(req, res) {
  const sid   = process.env.TWILIO_ACCOUNT_SID || "";
  const token = process.env.TWILIO_AUTH_TOKEN  || "";
  const from  = process.env.TWILIO_FROM_NUMBER || "";

  const meta = {
    TWILIO_ACCOUNT_SID: {
      set:             !!sid,
      length:          sid.length,
      expected_length: 34,
      first4:          sid.slice(0, 4),
      last4:           sid.slice(-4),
      starts_with_AC:  sid.startsWith("AC"),
      has_whitespace:  /\s/.test(sid),
    },
    TWILIO_AUTH_TOKEN: {
      set:             !!token,
      length:          token.length,
      expected_length: 32,
      first2:          token.slice(0, 2),
      last2:           token.slice(-2),
      has_whitespace:  /\s/.test(token),
    },
    TWILIO_FROM_NUMBER: {
      set:           !!from,
      value:         from,
      starts_with_plus: from.startsWith("+"),
      has_whitespace:   /\s/.test(from),
    },
  };

  if (!sid || !token) {
    return res.status(200).json({ ok: false, reason: "Credentials not set in env", meta });
  }

  // Read-only call: fetch the Account record. If auth is valid, Twilio
  // returns { friendly_name, status, ... }. If not, 401 + error body.
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const url  = `https://api.twilio.com/2010-04-01/Accounts/${sid}.json`;
  try {
    const r    = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    const body = await r.json();
    if (r.ok) {
      return res.status(200).json({
        ok: true,
        twilio_account: {
          friendly_name: body.friendly_name,
          status:        body.status,
          type:          body.type,
        },
        meta,
      });
    }
    return res.status(200).json({
      ok:               false,
      twilio_http_code: r.status,
      twilio_error:     body,
      meta,
    });
  } catch (err) {
    return res.status(200).json({
      ok:    false,
      reason: "Fetch threw",
      error:  err?.message || String(err),
      meta,
    });
  }
}
