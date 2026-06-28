const messagesEl = document.getElementById('messages');
const composer = document.getElementById('composer');
const promptInput = document.getElementById('prompt-input');
const sendBtn = document.getElementById('send-btn');
const btnLabel = document.getElementById('btn-label');
const errorMsg = document.getElementById('error-msg');
const previewFrame = document.getElementById('preview-frame');
const placeholder = document.getElementById('placeholder');
const previewLoading = document.getElementById('preview-loading');
const downloadBtn = document.getElementById('download-btn');
const openBtn = document.getElementById('open-btn');
const newBtn = document.getElementById('new-btn');

// Bring-your-own-key UI
const keyBtn = document.getElementById('key-btn');
const keyStatus = document.getElementById('key-status');
const keyPanel = document.getElementById('key-panel');
const keyInput = document.getElementById('key-input');
const keyError = document.getElementById('key-error');
const keySave = document.getElementById('key-save');
const keyClear = document.getElementById('key-clear');

const KEY_STORAGE = 'aisb_anthropic_key';

// The full conversation we send to the agent (short text only), plus the
// latest full HTML it produced — the agent edits the site in place from there.
let conversation = []; // [{ role: 'user' | 'assistant', content }]
let latestHtml = '';
let busy = false;

// ---------------- Bring-your-own-key ----------------
// The key is kept ONLY in this browser's localStorage. It's sent as a header
// with each request and used solely to call Anthropic on the visitor's behalf.
function getKey() {
  return (localStorage.getItem(KEY_STORAGE) || '').trim();
}

function hasKey() {
  return getKey().length > 0;
}

function looksLikeKey(k) {
  // Accept either a free Google Gemini key ("AIza…") or an Anthropic key.
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k) || /^AIza[A-Za-z0-9_-]{30,}$/.test(k);
}

function refreshKeyUi() {
  const set = hasKey();
  keyStatus.hidden = !set;
  keyClear.hidden = !set;
  keyBtn.textContent = set ? 'Change key' : 'API key';
  // Gate the composer until a key exists.
  promptInput.disabled = busy || !set;
  sendBtn.disabled = busy || !set;
  promptInput.placeholder = set
    ? 'Describe your website, or ask for a change…'
    : 'Add your Anthropic API key to start…';
}

function openKeyPanel() {
  keyInput.value = getKey();
  keyError.hidden = true;
  keyPanel.hidden = false;
  keyInput.focus();
}

function closeKeyPanel() {
  keyPanel.hidden = true;
}

function saveKey() {
  const k = keyInput.value.trim();
  if (!looksLikeKey(k)) {
    keyError.textContent = 'That doesn’t look like a key. Use a free Google Gemini key ("AIza…") or an Anthropic key ("sk-ant-…").';
    keyError.hidden = false;
    return;
  }
  localStorage.setItem(KEY_STORAGE, k);
  keyError.hidden = true;
  closeKeyPanel();
  refreshKeyUi();
  hideError();
  promptInput.focus();
}

function clearKey() {
  localStorage.removeItem(KEY_STORAGE);
  keyInput.value = '';
  refreshKeyUi();
  closeKeyPanel();
}

keyBtn.addEventListener('click', openKeyPanel);
keySave.addEventListener('click', saveKey);
keyClear.addEventListener('click', clearKey);
keyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveKey(); }
});
// Click the dimmed backdrop (but not the inner card) to dismiss.
keyPanel.addEventListener('click', (e) => {
  if (e.target === keyPanel) closeKeyPanel();
});

// ---------------- Intro buttons (event-delegated) ----------------
messagesEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.example-chip');
  if (chip) {
    promptInput.value = chip.dataset.text;
    promptInput.focus();
    return;
  }
  if (e.target.closest('.load-example')) {
    loadExample();
  }
});

// Load a real, pre-built sample site into the preview so you can see (and
// open/download) an actual website immediately — no key required just to look.
// It's also seeded as the "current" site, so once a key is added you can tune
// THIS site by chatting (e.g. "make it dark mode", "change the name").
async function loadExample() {
  try {
    const res = await fetch('examples/coffee-shop.html');
    if (!res.ok) throw new Error('fetch failed');
    const html = await res.text();
    removeIntro();
    addMessage(
      'agent',
      'Here’s an example: a coffee shop landing page. Open or download it below — ' +
        'or add your API key and ask me to change anything (colors, text, sections, layout).'
    );
    latestHtml = html;
    renderPreview(html);
    downloadBtn.disabled = false;
    openBtn.disabled = false;
  } catch (err) {
    console.error(err);
    showError('Could not load the example. Try again.');
  }
}

// ---------------- Send ----------------
composer.addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});

promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

newBtn.addEventListener('click', startOver);

async function send() {
  if (busy) return;

  if (!hasKey()) {
    showError('Add your Anthropic API key first — it stays in your browser.');
    openKeyPanel();
    return;
  }

  const text = promptInput.value.trim();
  if (!text) return;

  hideError();
  removeIntro();
  addMessage('user', text);
  conversation.push({ role: 'user', content: text });
  promptInput.value = '';

  setBusy(true);
  const thinkingEl = addThinking();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-anthropic-key': getKey(),
      },
      body: JSON.stringify({ messages: conversation, currentHtml: latestHtml }),
    });

    const data = await response.json();
    thinkingEl.remove();

    if (!response.ok) {
      // Roll back the user turn so they can edit and retry cleanly.
      conversation.pop();
      showError(data.error || 'Something went wrong.');
      // If the key was missing or rejected, surface the key panel.
      if (data.code === 'NO_KEY' || data.code === 'BAD_KEY' || data.code === 'KEY_REJECTED') {
        openKeyPanel();
      }
      return;
    }

    const reply = data.reply || 'Done.';
    addMessage('agent', reply);
    conversation.push({ role: 'assistant', content: reply });

    if (data.html) {
      latestHtml = data.html;
      renderPreview(latestHtml);
      downloadBtn.disabled = false;
      openBtn.disabled = false;
    }
  } catch (err) {
    console.error(err);
    thinkingEl.remove();
    conversation.pop();
    showError('Could not reach the server. Is it running?');
  } finally {
    setBusy(false);
    if (hasKey()) promptInput.focus();
  }
}

function startOver() {
  if (busy) return;
  conversation = [];
  latestHtml = '';
  previewFrame.srcdoc = '';
  previewFrame.style.display = 'none';
  placeholder.style.display = 'flex';
  downloadBtn.disabled = true;
  openBtn.disabled = true;
  hideError();
  // Reset the conversation back to just the intro card.
  messagesEl.innerHTML = '';
  const intro = document.createElement('div');
  intro.className = 'msg agent intro';
  intro.innerHTML = `
    <p>Fresh start! Describe the website you want and I’ll build it, then keep
       chatting to tune it.</p>
    <button class="load-example">✨ See an example site →</button>
    <p class="examples-or">…or describe your own:</p>
    <div class="examples">
      <button class="example-chip" data-text="A landing page for a cozy neighborhood coffee shop called &quot;Fern &amp; Bean&quot;. Warm, earthy colors. Hero section, a menu preview, an about section, and a contact form.">Coffee shop</button>
      <button class="example-chip" data-text="A portfolio site for a freelance photographer, dark and moody, with a full-bleed image grid.">Photographer portfolio</button>
      <button class="example-chip" data-text="A landing page for a SaaS app that helps small teams manage invoices. Clean, modern, blue and white.">SaaS landing page</button>
    </div>`;
  messagesEl.appendChild(intro);
  if (hasKey()) promptInput.focus();
}

// ---------------- Chat rendering ----------------
function addMessage(who, text) {
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  const p = document.createElement('p');
  p.textContent = text; // textContent => no HTML injection from model/user
  el.appendChild(p);
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function addThinking() {
  const el = document.createElement('div');
  el.className = 'msg agent thinking';
  el.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function removeIntro() {
  const intro = messagesEl.querySelector('.intro');
  if (intro) intro.remove();
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------------- Preview ----------------
function renderPreview(html) {
  previewFrame.style.display = 'block';
  placeholder.style.display = 'none';
  // srcdoc keeps the generated page sandboxed inside the iframe instead of
  // navigating the whole app to it.
  previewFrame.srcdoc = html;
}

// ---------------- UI state ----------------
function setBusy(isBusy) {
  busy = isBusy;
  sendBtn.disabled = isBusy || !hasKey();
  promptInput.disabled = isBusy || !hasKey();
  btnLabel.textContent = isBusy ? 'Working…' : 'Send';
  previewLoading.hidden = !isBusy;
}

function showError(text) {
  errorMsg.textContent = text;
  errorMsg.hidden = false;
}

function hideError() {
  errorMsg.hidden = true;
}

// ---------------- Download / open ----------------
downloadBtn.addEventListener('click', () => {
  if (!latestHtml) return;
  const blob = new Blob([latestHtml], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'my-website.html';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

openBtn.addEventListener('click', () => {
  if (!latestHtml) return;
  const blob = new Blob([latestHtml], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  // Revoke a little later so the new tab has time to load.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
});

// ---------------- Boot ----------------
refreshKeyUi();
if (!hasKey()) openKeyPanel();
