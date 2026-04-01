/**
 * LP Pressure Washing Chat Widget
 *
 * Paste ONE line into your WordPress footer (just before </body>):
 *   <script src="https://YOUR_VERCEL_URL/widget.js"></script>
 */

(function () {
  const ORIGIN = document.currentScript?.src
    ? new URL(document.currentScript.src).origin
    : "";
  const API_URL  = ORIGIN + "/api/chat";
  const LOGO_URL = ORIGIN + "/logo.png";
  const STORAGE_KEY = "lp-chat-session";

  // ─── LocalStorage helpers ──────────────────────────────────────────────────
  function saveSession() {
    const data = { messages, ts: Date.now() };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      // Expire after midnight (same-day persistence)
      const saved = new Date(data.ts);
      const now   = new Date();
      if (saved.toDateString() !== now.toDateString()) {
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return data.messages || null;
    } catch { return null; }
  }

  function clearSession() {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }

  const style = document.createElement("style");
  style.textContent = `
    #lp-chat-bubble {
      position: fixed; bottom: 24px; right: 24px; z-index: 9999;
      width: 64px; height: 64px; border-radius: 50%;
      background: #1e3a5f; border: none; padding: 0;
      box-shadow: 0 4px 16px rgba(0,0,0,0.25);
      cursor: pointer; overflow: hidden;
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s;
    }
    #lp-chat-bubble:hover { transform: scale(1.08); }
    #lp-chat-bubble img {
      width: 100%; height: 100%; object-fit: cover; border-radius: 50%;
    }
    #lp-chat-bubble.lp-open {
      background: #1e3a5f; font-size: 28px; color: #fff;
    }
    #lp-chat-window {
      position: fixed; bottom: 100px; right: 24px; z-index: 9999;
      width: 420px; max-width: calc(100vw - 32px);
      height: 540px; max-height: calc(100vh - 120px);
      background: #fff; border-radius: 16px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.18);
      display: flex; flex-direction: column; overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      transition: opacity 0.2s, transform 0.2s;
    }
    #lp-chat-window.lp-hidden {
      opacity: 0; transform: translateY(12px); pointer-events: none;
    }
    #lp-chat-header {
      background: #1e3a5f; color: #fff;
      padding: 10px 18px; display: flex; align-items: center; gap: 10px;
      flex-shrink: 0;
    }
    #lp-chat-header-logo {
      width: 36px; height: 36px; border-radius: 50%;
      object-fit: cover; flex-shrink: 0;
    }
    #lp-chat-header-text h4 { margin: 0; font-size: 15px; font-weight: 600; }
    #lp-chat-header-text p  { margin: 0; font-size: 12px; opacity: 0.85; }
    #lp-chat-close {
      margin-left: auto; background: none; border: none;
      color: #fff; font-size: 20px; cursor: pointer; padding: 0 4px;
      opacity: 0.8; line-height: 1;
    }
    #lp-chat-close:hover { opacity: 1; }

    /* Welcome hero area */
    #lp-chat-welcome {
      display: flex; flex-direction: column; align-items: center;
      padding: 24px 20px 16px; background: #f8fafc; flex-shrink: 0;
      border-bottom: 1px solid #e2e8f0;
    }
    #lp-chat-welcome img {
      width: 64px; height: 64px; border-radius: 50%;
      object-fit: cover; margin-bottom: 10px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.12);
    }
    #lp-chat-welcome h3 {
      margin: 0; font-size: 17px; font-weight: 700; color: #1e293b;
    }
    #lp-chat-welcome p {
      margin: 4px 0 0; font-size: 13px; color: #64748b;
      text-align: center; line-height: 1.4;
    }
    #lp-chat-welcome.lp-welcome-hidden { display: none; }

    #lp-chat-messages {
      flex: 1; overflow-y: auto; padding: 16px;
      display: flex; flex-direction: column; gap: 10px;
      background: #f8fafc;
    }
    #lp-chat-messages::-webkit-scrollbar { width: 4px; }
    #lp-chat-messages::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 2px; }

    /* Bot message row: avatar + bubble */
    .lp-msg-row {
      display: flex; align-items: flex-end; gap: 8px;
      align-self: flex-start; max-width: 88%;
    }
    .lp-msg-avatar {
      width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
      object-fit: cover;
    }
    .lp-msg {
      padding: 10px 14px;
      border-radius: 14px; font-size: 14px; line-height: 1.5;
      word-break: break-word; white-space: pre-wrap;
    }
    .lp-msg-bot {
      background: #fff; color: #1e293b;
      border-bottom-left-radius: 4px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.07);
    }
    .lp-msg-user {
      background: #2563eb; color: #fff;
      border-bottom-right-radius: 4px;
      align-self: flex-end; max-width: 82%;
    }

    /* Suggestion buttons */
    .lp-suggestions {
      display: flex; flex-wrap: wrap; gap: 6px;
      align-self: flex-start; padding-left: 36px;
    }
    .lp-suggestion-btn {
      background: #fff; color: #64748b; border: 1.5px solid #cbd5e1;
      border-radius: 20px; padding: 6px 14px; font-size: 13px;
      cursor: pointer; font-family: inherit;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
    }
    .lp-suggestion-btn:hover {
      background: #f1f5f9; color: #1e293b; border-color: #94a3b8;
    }

    /* Calculating animation */
    .lp-status-row {
      display: flex; align-items: flex-end; gap: 8px;
      align-self: flex-start;
    }
    .lp-status-msg {
      padding: 10px 14px; background: #fff;
      border-radius: 14px; border-bottom-left-radius: 4px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.07);
      font-size: 14px; color: #94a3b8; font-style: italic;
      transition: opacity 0.3s;
    }

    .lp-typing {
      display: flex; gap: 4px; align-items: center;
      padding: 10px 14px; background: #fff;
      border-radius: 14px; border-bottom-left-radius: 4px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.07);
    }
    .lp-typing-row {
      display: flex; align-items: flex-end; gap: 8px;
      align-self: flex-start;
    }
    .lp-typing span {
      width: 7px; height: 7px; background: #94a3b8;
      border-radius: 50%; animation: lp-bounce 1.2s infinite;
    }
    .lp-typing span:nth-child(2) { animation-delay: 0.2s; }
    .lp-typing span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes lp-bounce {
      0%, 80%, 100% { transform: translateY(0); }
      40%           { transform: translateY(-6px); }
    }
    #lp-chat-input-row {
      display: flex; gap: 8px; padding: 12px;
      background: #fff; border-top: 1px solid #e2e8f0; flex-shrink: 0;
    }
    #lp-chat-input {
      flex: 1; border: 1px solid #e2e8f0; border-radius: 10px;
      padding: 9px 13px; font-size: 14px; outline: none;
      resize: none; font-family: inherit; line-height: 1.4;
      max-height: 90px; overflow-y: auto;
    }
    #lp-chat-input:focus { border-color: #2563eb; }
    #lp-chat-send {
      background: #2563eb; color: #fff; border: none;
      border-radius: 10px; padding: 0 14px;
      cursor: pointer; font-size: 18px; flex-shrink: 0;
      transition: background 0.15s;
    }
    #lp-chat-send:hover    { background: #1d4ed8; }
    #lp-chat-send:disabled { background: #93c5fd; cursor: not-allowed; }
    #lp-chat-footer {
      display: flex; align-items: center; justify-content: center;
      gap: 8px; padding: 4px 0 8px; background: #fff; flex-shrink: 0;
    }
    #lp-powered {
      font-size: 11px; color: #94a3b8;
    }
    #lp-reset-btn {
      background: none; border: none; color: #cbd5e1;
      font-size: 13px; cursor: pointer; padding: 0 4px;
      transition: color 0.15s; line-height: 1;
    }
    #lp-reset-btn:hover { color: #94a3b8; }
    #lp-reset-confirm {
      display: none; font-size: 11px; color: #ef4444;
      cursor: pointer; background: none; border: none;
      font-family: inherit; padding: 0 4px;
    }
    #lp-reset-confirm:hover { text-decoration: underline; }
  `;
  document.head.appendChild(style);

  const bubble = document.createElement("button");
  bubble.id = "lp-chat-bubble";
  bubble.setAttribute("aria-label", "Open chat");
  bubble.innerHTML = `<img src="${LOGO_URL}" alt="LP Pressure Washing">`;

  const win = document.createElement("div");
  win.id = "lp-chat-window";
  win.classList.add("lp-hidden");
  win.innerHTML = `
    <div id="lp-chat-header">
      <img id="lp-chat-header-logo" src="${LOGO_URL}" alt="LP">
      <div id="lp-chat-header-text">
        <h4>LP Pressure Washing</h4>
        <p>Online - usually replies instantly</p>
      </div>
      <button id="lp-chat-close" aria-label="Close chat">\u2715</button>
    </div>
    <div id="lp-chat-welcome">
      <img src="${LOGO_URL}" alt="LP Pressure Washing">
      <h3>LP AI Assistant</h3>
      <p>Try our LP instant quote calculator.<br>Ask us a question!</p>
    </div>
    <div id="lp-chat-messages"></div>
    <div id="lp-chat-input-row">
      <textarea id="lp-chat-input" rows="1" placeholder="Type a message..."></textarea>
      <button id="lp-chat-send" aria-label="Send">\u27A4</button>
    </div>
    <div id="lp-chat-footer">
      <span id="lp-powered">Powered by LP Pressure Washing AI</span>
      <button id="lp-reset-btn" title="Reset chat">\u21BB</button>
      <button id="lp-reset-confirm">Reset chat?</button>
    </div>
  `;

  document.body.appendChild(bubble);
  document.body.appendChild(win);

  const messages    = [];
  let   isOpen      = false;
  let   isWaiting   = false;
  let   greeted     = false;
  let   welcomeHidden = false;

  const messagesEl  = win.querySelector("#lp-chat-messages");
  const welcomeEl   = win.querySelector("#lp-chat-welcome");
  const inputEl     = win.querySelector("#lp-chat-input");
  const sendBtn     = win.querySelector("#lp-chat-send");
  const resetBtn    = win.querySelector("#lp-reset-btn");
  const resetConfirm = win.querySelector("#lp-reset-confirm");

  function hideWelcome() {
    if (!welcomeHidden) {
      welcomeHidden = true;
      welcomeEl.classList.add("lp-welcome-hidden");
    }
  }

  function addMessage(role, text) {
    if (role === "user") {
      const div = document.createElement("div");
      div.className = "lp-msg lp-msg-user";
      div.textContent = text;
      messagesEl.appendChild(div);
    } else {
      const row = document.createElement("div");
      row.className = "lp-msg-row";
      row.innerHTML = `<img class="lp-msg-avatar" src="${LOGO_URL}" alt="LP">`;
      const msgBubble = document.createElement("div");
      msgBubble.className = "lp-msg lp-msg-bot";
      msgBubble.textContent = text;
      row.appendChild(msgBubble);
      messagesEl.appendChild(row);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addSuggestions(options) {
    const container = document.createElement("div");
    container.className = "lp-suggestions";
    options.forEach((opt) => {
      const btn = document.createElement("button");
      btn.className = "lp-suggestion-btn";
      btn.textContent = opt;
      btn.addEventListener("click", () => {
        container.remove();
        sendMessage(opt);
      });
      container.appendChild(btn);
    });
    messagesEl.appendChild(container);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showTyping() {
    const row = document.createElement("div");
    row.className = "lp-typing-row";
    row.id = "lp-typing-indicator";
    row.innerHTML = `<img class="lp-msg-avatar" src="${LOGO_URL}" alt="LP"><div class="lp-typing"><span></span><span></span><span></span></div>`;
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideTyping() {
    document.getElementById("lp-typing-indicator")?.remove();
  }

  // Calculating animation
  async function showCalculating() {
    const steps = ["Surveying the home...", "Measuring...", "Calculating..."];
    const row = document.createElement("div");
    row.className = "lp-status-row";
    row.id = "lp-calc-indicator";
    row.innerHTML = `<img class="lp-msg-avatar" src="${LOGO_URL}" alt="LP">`;
    const statusEl = document.createElement("div");
    statusEl.className = "lp-status-msg";
    row.appendChild(statusEl);
    messagesEl.appendChild(row);

    for (let i = 0; i < steps.length; i++) {
      statusEl.textContent = steps[i];
      messagesEl.scrollTop = messagesEl.scrollHeight;
      await new Promise((r) => setTimeout(r, 1300));
    }
  }

  function hideCalculating() {
    document.getElementById("lp-calc-indicator")?.remove();
  }

  function replyHasQuote(text) {
    return /\$\d{2,}/.test(text) && /estimat|price|quote|total/i.test(text);
  }

  function detectSuggestions(reply) {
    const lower = reply.toLowerCase();
    if (lower.includes("what do you want cleaned") || lower.includes("what would you like cleaned") || lower.includes("what can i help") || lower.includes("what service") || lower.includes("what are you looking")) {
      return ["house exterior", "deck, porch", "patio, slab, brick, stone, pavers, sidewalk", "fencing", "clean out gutters"];
    }
    if (lower.includes("how many stories") || lower.includes("how many floors")) {
      return ["1 Story", "2 Stories", "3 Stories"];
    }
    if (lower.includes("primary material") || lower.includes("what material") || lower.includes("what type of material") || lower.includes("what is the siding")) {
      return ["Vinyl", "Wood", "Brick/Stone", "Stucco", "Composite"];
    }
    if (lower.includes("last cleaning") || lower.includes("how long has it been") || lower.includes("last time") || lower.includes("when was the last")) {
      return ["Less than 1 year", "1-2 years", "3+ years", "Never"];
    }
    if (lower.includes("deck") && (lower.includes("material") || lower.includes("type"))) {
      return ["Wood", "Composite/Trek", "Vinyl/PVC"];
    }
    if (lower.includes("fence") && (lower.includes("material") || lower.includes("type"))) {
      return ["Wood", "Vinyl", "Metal"];
    }
    if ((lower.includes("patio") || lower.includes("walkway")) && (lower.includes("material") || lower.includes("type"))) {
      return ["Concrete", "Pavers/Brick", "Stone Slab"];
    }
    return null;
  }

  async function sendMessage(text) {
    if (!text.trim() || isWaiting) return;
    hideWelcome();
    messagesEl.querySelectorAll(".lp-suggestions").forEach((el) => el.remove());
    addMessage("user", text.trim());
    messages.push({ role: "user", content: text.trim() });
    saveSession();
    inputEl.value = "";
    inputEl.style.height = "auto";
    isWaiting        = true;
    sendBtn.disabled = true;
    showTyping();
    try {
      const res = await fetch(API_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ messages }),
      });
      const data = await res.json();
      hideTyping();
      const reply = data.reply || "Sorry, something went wrong. Please try again!";

      if (replyHasQuote(reply)) {
        await showCalculating();
        hideCalculating();
      }

      addMessage("bot", reply);
      messages.push({ role: "assistant", content: reply });
      saveSession();
      const suggestions = detectSuggestions(reply);
      if (suggestions) addSuggestions(suggestions);
    } catch {
      hideTyping();
      addMessage("bot", "Sorry, I couldn't connect. Please check your internet and try again.");
    }
    isWaiting        = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }

  // Restore a saved session into the UI
  function restoreSession(saved) {
    greeted       = true;
    welcomeHidden = true;
    welcomeEl.classList.add("lp-welcome-hidden");
    saved.forEach((msg) => {
      messages.push(msg);
      addMessage(msg.role === "user" ? "user" : "bot", msg.content);
    });
  }

  function resetChat() {
    messages.length = 0;
    messagesEl.innerHTML = "";
    greeted       = false;
    welcomeHidden = false;
    welcomeEl.classList.remove("lp-welcome-hidden");
    clearSession();
    resetConfirm.style.display = "none";
    resetBtn.style.display = "";
    // Re-greet
    greeted = true;
    const greeting = "Hey \uD83D\uDC4B! Welcome to LP Pressure Washing!\nI'm here to get you a fast, accurate quote and answer any questions - usually takes less than 2 minutes!\n\nBefore we dive in... What's your first name?";
    addMessage("bot", greeting);
    messages.push({ role: "assistant", content: greeting });
    saveSession();
  }

  // Two-step reset: click icon → show "Reset chat?" → click that to confirm
  resetBtn.addEventListener("click", () => {
    resetBtn.style.display = "none";
    resetConfirm.style.display = "inline";
    // Auto-hide confirm after 3 seconds if not clicked
    setTimeout(() => {
      resetConfirm.style.display = "none";
      resetBtn.style.display = "";
    }, 3000);
  });
  resetConfirm.addEventListener("click", resetChat);

  async function openChat() {
    isOpen = true;
    win.classList.remove("lp-hidden");
    bubble.innerHTML = `<span style="font-size:28px;color:#fff;">\u2715</span>`;
    bubble.classList.add("lp-open");
    if (!greeted) {
      // Try to restore a saved session
      const saved = loadSession();
      if (saved && saved.length > 0) {
        restoreSession(saved);
      } else {
        greeted = true;
        const greeting = "Hey \uD83D\uDC4B! Welcome to LP Pressure Washing!\nI'm here to get you a fast, accurate quote and answer any questions - usually takes less than 2 minutes!\n\nBefore we dive in... What's your first name?";
        addMessage("bot", greeting);
        messages.push({ role: "assistant", content: greeting });
        saveSession();
      }
    }
    inputEl.focus();
  }

  function closeChat() {
    isOpen = false;
    win.classList.add("lp-hidden");
    bubble.innerHTML = `<img src="${LOGO_URL}" alt="LP Pressure Washing">`;
    bubble.classList.remove("lp-open");
  }

  bubble.addEventListener("click", () => (isOpen ? closeChat() : openChat()));
  win.querySelector("#lp-chat-close").addEventListener("click", closeChat);
  sendBtn.addEventListener("click", () => sendMessage(inputEl.value));

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(inputEl.value);
    }
  });

  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 90) + "px";
  });
})();
