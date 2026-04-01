/**
 * LP Pressure Washing Chat Widget
 *
 * Paste ONE line into your WordPress footer (just before </body>):
 *   <script src="https://YOUR_VERCEL_URL/widget.js"></script>
 */

(function () {
  const API_URL = document.currentScript?.src
    ? new URL(document.currentScript.src).origin + "/api/chat"
    : "/api/chat";

  const style = document.createElement("style");
  style.textContent = `
    #lp-chat-bubble {
      position: fixed; bottom: 24px; right: 24px; z-index: 9999;
      width: 60px; height: 60px; border-radius: 50%;
      background: #2563eb; color: #fff; border: none;
      box-shadow: 0 4px 16px rgba(0,0,0,0.25);
      cursor: pointer; font-size: 26px;
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s;
    }
    #lp-chat-bubble:hover { transform: scale(1.08); }
    #lp-chat-window {
      position: fixed; bottom: 96px; right: 24px; z-index: 9999;
      width: 360px; max-width: calc(100vw - 32px);
      height: 520px; max-height: calc(100vh - 120px);
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
      background: #2563eb; color: #fff;
      padding: 14px 18px; display: flex; align-items: center; gap: 10px;
      flex-shrink: 0;
    }
    #lp-chat-header-text h4 { margin: 0; font-size: 15px; font-weight: 600; }
    #lp-chat-header-text p  { margin: 0; font-size: 12px; opacity: 0.85; }
    #lp-chat-close {
      margin-left: auto; background: none; border: none;
      color: #fff; font-size: 20px; cursor: pointer; padding: 0 4px;
      opacity: 0.8; line-height: 1;
    }
    #lp-chat-close:hover { opacity: 1; }
    #lp-chat-messages {
      flex: 1; overflow-y: auto; padding: 16px;
      display: flex; flex-direction: column; gap: 10px;
      background: #f8fafc;
    }
    #lp-chat-messages::-webkit-scrollbar { width: 4px; }
    #lp-chat-messages::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 2px; }
    .lp-msg {
      max-width: 82%; padding: 10px 14px;
      border-radius: 14px; font-size: 14px; line-height: 1.5;
      word-break: break-word; white-space: pre-wrap;
    }
    .lp-msg-bot {
      background: #fff; color: #1e293b;
      border-bottom-left-radius: 4px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.07);
      align-self: flex-start;
    }
    .lp-msg-user {
      background: #2563eb; color: #fff;
      border-bottom-right-radius: 4px;
      align-self: flex-end;
    }
    .lp-typing {
      display: flex; gap: 4px; align-items: center;
      padding: 10px 14px; background: #fff;
      border-radius: 14px; border-bottom-left-radius: 4px;
      align-self: flex-start; box-shadow: 0 1px 4px rgba(0,0,0,0.07);
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
    #lp-powered {
      text-align: center; font-size: 11px; color: #94a3b8;
      padding: 4px 0 8px; background: #fff; flex-shrink: 0;
    }
  `;
  document.head.appendChild(style);

  const bubble = document.createElement("button");
  bubble.id = "lp-chat-bubble";
  bubble.setAttribute("aria-label", "Open chat");
  bubble.textContent = "\uD83D\uDCAC";

  const win = document.createElement("div");
  win.id = "lp-chat-window";
  win.classList.add("lp-hidden");
  win.innerHTML = `
    <div id="lp-chat-header">
      <div id="lp-chat-header-text">
        <h4>LP Pressure Washing</h4>
        <p>Online - usually replies instantly</p>
      </div>
      <button id="lp-chat-close" aria-label="Close chat">\u2715</button>
    </div>
    <div id="lp-chat-messages"></div>
    <div id="lp-chat-input-row">
      <textarea id="lp-chat-input" rows="1" placeholder="Type a message..."></textarea>
      <button id="lp-chat-send" aria-label="Send">\u27A4</button>
    </div>
    <div id="lp-powered">Powered by LP Pressure Washing AI</div>
  `;

  document.body.appendChild(bubble);
  document.body.appendChild(win);

  const messages  = [];
  let   isOpen    = false;
  let   isWaiting = false;
  let   greeted   = false;

  const messagesEl = win.querySelector("#lp-chat-messages");
  const inputEl    = win.querySelector("#lp-chat-input");
  const sendBtn    = win.querySelector("#lp-chat-send");

  function addMessage(role, text) {
    const div  = document.createElement("div");
    div.className = `lp-msg lp-msg-${role === "user" ? "user" : "bot"}`;
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function showTyping() {
    const el = document.createElement("div");
    el.className  = "lp-typing";
    el.id         = "lp-typing-indicator";
    el.innerHTML  = "<span></span><span></span><span></span>";
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideTyping() {
    document.getElementById("lp-typing-indicator")?.remove();
  }

  async function sendMessage(text) {
    if (!text.trim() || isWaiting) return;
    addMessage("user", text.trim());
    messages.push({ role: "user", content: text.trim() });
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
      addMessage("bot", reply);
      messages.push({ role: "assistant", content: reply });
    } catch {
      hideTyping();
      addMessage("bot", "Sorry, I couldn't connect. Please check your internet and try again.");
    }
    isWaiting        = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }

  async function openChat() {
    isOpen = true;
    win.classList.remove("lp-hidden");
    bubble.textContent = "\u2715";
    if (!greeted) {
      greeted = true;
      showTyping();
      await new Promise((r) => setTimeout(r, 900));
      hideTyping();
      const greeting = "Hey there! Welcome to LP Pressure Washing!\nI'm here to get you a fast, accurate quote and answer any questions - usually takes less than 2 minutes!\n\nBefore we dive in... What's your first name?";
      addMessage("bot", greeting);
      messages.push({ role: "assistant", content: greeting });
    }
    inputEl.focus();
  }

  function closeChat() {
    isOpen = false;
    win.classList.add("lp-hidden");
    bubble.textContent = "\uD83D\uDCAC";
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
