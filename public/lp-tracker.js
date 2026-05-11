// ─── LP universal page tracker ───────────────────────────────────────────
// Tiny script for the WordPress landing page. Fires `Page view` on every
// page load (regardless of whether the customer ever clicks the chat
// bubble), captures attribution from URL params + referrer, and reports
// page-load performance metrics so we can see if the site is slow.
//
// Embed in WordPress header (WPCode snippet or Theme Editor footer.php):
//   <script src="https://chatbot-t1bk.vercel.app/lp-tracker.js" async></script>
//
// What it does:
//   1. On script load → captures attribution (utm_*, fbclid, gclid,
//      msclkid, referrer, landing URL) into sessionStorage so subsequent
//      navigations within the session keep the same first-touch source.
//   2. Fires `Page view` immediately to /api/track with the attribution.
//   3. When the browser's `load` event fires, sends a second `Page view`
//      with performance notes: page-load duration in ms + Time-to-
//      Interactive. Lets the dashboard show "Yelp landings averaged
//      3.2s page load, Facebook averaged 5.1s" so we can spot slow paths.
//   4. Independent of widget.js — works even if the chat bubble never
//      loads (e.g., if WPCode strips the widget script).
//
// Anonymous: no PII. SessionID is a client-generated UUID. Once the
// customer fills the form, /api/estimate links the funnel events to
// the new Client by session.

(function () {
  'use strict';

  // Where to send events. Same endpoint the widget already uses.
  var TRACK_URL = 'https://chatbot-t1bk.vercel.app/api/track';

  // ── Session ID — one per browser session ───────────────────────────
  var SESSION_KEY = 'lp_tracker_session_v1';
  function getSessionId() {
    try {
      var s = sessionStorage.getItem(SESSION_KEY);
      if (!s) {
        s = (window.crypto && crypto.randomUUID && crypto.randomUUID()) ||
            (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
        sessionStorage.setItem(SESSION_KEY, s);
      }
      return s;
    } catch (e) {
      return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
  }
  var sessionId = getSessionId();

  // ── Attribution capture — first-touch sticks per session ───────────
  var ATTR_KEY = 'lp_tracker_attr_v1';
  function captureAttribution() {
    var existing = null;
    try {
      var raw = sessionStorage.getItem(ATTR_KEY);
      if (raw) existing = JSON.parse(raw);
    } catch (e) {}
    if (existing) return existing;

    var params = new URLSearchParams(window.location.search);
    var attr = {
      utm_source:   params.get('utm_source')   || '',
      utm_campaign: params.get('utm_campaign') || '',
      utm_medium:   params.get('utm_medium')   || '',
      utm_term:     params.get('utm_term')     || '',
      utm_content:  params.get('utm_content')  || '',
      fbclid:       params.get('fbclid')       || '',
      gclid:        params.get('gclid')        || '',
      msclkid:      params.get('msclkid')      || '',
      referrer:     document.referrer || '',
      landing_url:  window.location.href,
    };

    // Infer utm_source from referrer if not set
    if (!attr.utm_source) {
      var r = (attr.referrer || '').toLowerCase();
      if (attr.fbclid || /(facebook|fb\.com|fbclid)/.test(r))       attr.utm_source = 'facebook';
      else if (attr.gclid || /(google|googleadservices)/.test(r))   attr.utm_source = 'google';
      else if (attr.msclkid)                                        attr.utm_source = 'bing';
      else if (/yelp/.test(r))                                      attr.utm_source = 'yelp';
      else if (/angi|homeadvisor/.test(r))                          attr.utm_source = 'angi';
      else if (/instagram/.test(r))                                 attr.utm_source = 'instagram';
      else if (/nextdoor/.test(r))                                  attr.utm_source = 'nextdoor';
      else if (/duckduckgo/.test(r))                                attr.utm_source = 'duckduckgo';
      else if (/bing/.test(r))                                      attr.utm_source = 'bing';
      else if (/(t\.co|twitter|x\.com)/.test(r))                    attr.utm_source = 'twitter';
      else if (/linkedin/.test(r))                                  attr.utm_source = 'linkedin';
      else if (/tiktok/.test(r))                                    attr.utm_source = 'tiktok';
      else if (/youtube/.test(r))                                   attr.utm_source = 'youtube';
    }

    try { sessionStorage.setItem(ATTR_KEY, JSON.stringify(attr)); } catch (e) {}
    return attr;
  }
  var attribution = captureAttribution();

  // ── Fire — dedup'd, beacon-preferred so unload doesn't drop the call
  var fired = {};
  function fire(eventType, opts) {
    opts = opts || {};
    var dedupKey = opts.dedup ? eventType + ':' + opts.dedup : eventType;
    if (fired[dedupKey]) return;
    fired[dedupKey] = true;

    var body = JSON.stringify({
      event_type: eventType,
      sessionId:  sessionId,
      attribution: attribution,
      notes:       opts.notes,
    });

    // Prefer sendBeacon — survives page unload
    try {
      if (navigator.sendBeacon) {
        var sent = navigator.sendBeacon(TRACK_URL, new Blob([body], { type: 'application/json' }));
        if (sent) return;
      }
    } catch (e) {}

    // Fallback to fetch with keepalive
    try {
      fetch(TRACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    body,
        keepalive: true,
      }).catch(function () {
        // Allow retry on next page navigation
        delete fired[dedupKey];
      });
    } catch (e) {}
  }

  // ── 1. Fire Page view IMMEDIATELY on script load ───────────────────
  fire('Page view');

  // ── 2. Fire Ad click signal if the URL has ad params ───────────────
  // The /api/estimate endpoint also fires Telegram on ad-paid clicks.
  // This is a complementary "they landed from an ad" event for the
  // funnel chart so we can compare paid vs organic landings.
  if (attribution.fbclid || attribution.gclid || attribution.msclkid ||
      (attribution.utm_source && attribution.utm_medium === 'cpc')) {
    fire('Ad click');
  }

  // ── 3. Performance / page-load timing ──────────────────────────────
  // Wait for the load event so navigation entry has final timings.
  function reportPerf() {
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      if (!nav) return;
      var loadMs = Math.round(nav.loadEventEnd - nav.startTime);
      var ttiMs  = Math.round(nav.domInteractive - nav.startTime);
      var dnsMs  = Math.round(nav.domainLookupEnd - nav.domainLookupStart);
      var ttfbMs = Math.round(nav.responseStart - nav.requestStart);
      if (loadMs > 0) {
        fire('Page view', {
          dedup: 'perf',
          notes: 'load_ms=' + loadMs + ' tti_ms=' + ttiMs + ' ttfb_ms=' + ttfbMs + ' dns_ms=' + dnsMs,
        });
      }
    } catch (e) {}
  }
  if (document.readyState === 'complete') {
    setTimeout(reportPerf, 150);
  } else {
    window.addEventListener('load', function () { setTimeout(reportPerf, 150); });
  }
})();
