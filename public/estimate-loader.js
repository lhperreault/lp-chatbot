/**
 * LP Pressure Wash — Estimate Widget Loader
 *
 * Paste ONE line into your Elementor HTML widget (or any HTML block):
 *
 *   <script src="https://chatbot-t1bk.vercel.app/estimate-loader.js"></script>
 *
 * That's it. The latest version of the widget is auto-fetched at page load
 * and injected in place of this script tag — every push to the GitHub repo
 * propagates to your live site within ~5 minutes (CDN cache window).
 *
 * If you need to control where the widget appears, drop a mount point first:
 *   <div id="lp-estimate-mount"></div>
 *   <script src="https://chatbot-t1bk.vercel.app/estimate-loader.js"></script>
 * Otherwise the script self-mounts right where it sits in the page.
 */

(function () {
  // Self-mount idempotency — Elementor can re-render the same widget on
  // breakpoint changes; we don't want to inject twice.
  if (window.__lpEstimateLoaded) return;
  window.__lpEstimateLoaded = true;

  // Capture the current <script> tag synchronously — document.currentScript
  // is null inside async callbacks (after fetch resolves).
  const scriptTag = document.currentScript;

  const WIDGET_URL = 'https://chatbot-t1bk.vercel.app/estimate-widget.html';

  fetch(WIDGET_URL, { cache: 'no-cache' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    })
    .then(function (html) {
      // Find or create the mount point
      var mount = document.getElementById('lp-estimate-mount');
      if (!mount) {
        mount = document.createElement('div');
        mount.id = 'lp-estimate-mount';
        if (scriptTag && scriptTag.parentNode) {
          scriptTag.parentNode.insertBefore(mount, scriptTag);
        } else {
          document.body.appendChild(mount);
        }
      }

      // Drop the widget markup in. <link>, <style>, and most elements
      // execute fine via innerHTML; <script> tags do NOT, so we re-create
      // them below so the widget's JS actually runs.
      mount.innerHTML = html;

      // Re-create every <script> tag inside the mount so the browser
      // actually executes them. innerHTML-injected scripts are inert by
      // spec — this is the standard workaround.
      var scripts = mount.querySelectorAll('script');
      Array.prototype.forEach.call(scripts, function (oldScript) {
        var newScript = document.createElement('script');
        // Copy any attributes (src, type, etc.)
        for (var i = 0; i < oldScript.attributes.length; i++) {
          var a = oldScript.attributes[i];
          newScript.setAttribute(a.name, a.value);
        }
        if (oldScript.textContent) newScript.textContent = oldScript.textContent;
        oldScript.parentNode.replaceChild(newScript, oldScript);
      });
    })
    .catch(function (err) {
      console.error('[lp-estimate-loader] failed to load widget:', err);
      // Fallback: show a phone link so leads don't disappear silently if
      // the loader breaks in production.
      var fallback = document.createElement('div');
      fallback.style.cssText = 'padding:20px;text-align:center;font-family:sans-serif;color:#374151';
      fallback.innerHTML =
        '<p>Having trouble loading the estimator. Reach us directly:</p>' +
        '<p><a href="tel:+12679128285" style="font-size:18px;color:#2563eb;text-decoration:none">📱 (267) 912-8285</a></p>';
      if (scriptTag && scriptTag.parentNode) {
        scriptTag.parentNode.insertBefore(fallback, scriptTag);
      } else {
        document.body.appendChild(fallback);
      }
    });
})();
