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

// The full conversation we send to the agent (short text only), plus the
// latest full HTML it produced — the agent edits the site in place from there.
let conversation = []; // [{ role: 'user' | 'assistant', content }]
let latestHtml = '';
let busy = false;

// --- Example chips (event-delegated so they keep working as the DOM changes) ---
messagesEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.example-chip');
  if (!chip) return;
  promptInput.value = chip.dataset.text;
  promptInput.focus();
});

// --- Send on submit / Enter ---
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: conversation, currentHtml: latestHtml }),
    });

    const data = await response.json();
    thinkingEl.remove();

    if (!response.ok) {
      // Roll back the user turn so they can edit and retry cleanly.
      conversation.pop();
      showError(data.error || 'Something went wrong.');
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
    promptInput.focus();
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
    <div class="examples">
      <button class="example-chip" data-text="A landing page for a cozy neighborhood coffee shop called &quot;Fern &amp; Bean&quot;. Warm, earthy colors. Hero section, a menu preview, an about section, and a contact form.">Coffee shop</button>
      <button class="example-chip" data-text="A portfolio site for a freelance photographer, dark and moody, with a full-bleed image grid.">Photographer portfolio</button>
      <button class="example-chip" data-text="A landing page for a SaaS app that helps small teams manage invoices. Clean, modern, blue and white.">SaaS landing page</button>
    </div>`;
  messagesEl.appendChild(intro);
  promptInput.focus();
}

// --- Chat rendering ---
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

// --- Preview ---
function renderPreview(html) {
  previewFrame.style.display = 'block';
  placeholder.style.display = 'none';
  // srcdoc keeps the generated page sandboxed inside the iframe instead of
  // navigating the whole app to it.
  previewFrame.srcdoc = html;
}

// --- UI state ---
function setBusy(isBusy) {
  busy = isBusy;
  sendBtn.disabled = isBusy;
  promptInput.disabled = isBusy;
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

// --- Download / open ---
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
