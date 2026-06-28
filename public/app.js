// ===========================================================================
// Atelier — AI Website Builder (workspace app)
// Multi-file projects, file explorer, editable code, live preview, local
// persistence, ZIP export, a free managed AI agent with token metering (pay
// after a free quota), or bring-your-own-key for unlimited use.
// ===========================================================================

// ---- element refs ----
const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const composer = $('composer');
const promptInput = $('prompt-input');
const sendBtn = $('send-btn');
const btnLabel = $('btn-label');
const errorMsg = $('error-msg');

const fileListEl = $('file-list');
const addFileBtn = $('add-file-btn');
const codeEditor = $('code-editor');
const activeFileLabel = $('active-file');
const downloadBtn = $('download-btn');
const openBtn = $('open-btn');
const refreshBtn = $('refresh-btn');

const previewFrame = $('preview-frame');
const placeholder = $('placeholder');
const previewLoading = $('preview-loading');

const tabPreview = $('tab-preview');
const tabCode = $('tab-code');
const previewView = $('preview-view');
const codeView = $('code-view');

const projectSelect = $('project-select');
const renameBtn = $('rename-btn');
const newBtn = $('new-btn');
const deleteBtn = $('delete-btn');

const keyBtn = $('key-btn');
const keyStatus = $('key-status');
const keyPanel = $('key-panel');
const keyInput = $('key-input');
const keyError = $('key-error');
const keySave = $('key-save');
const keyClear = $('key-clear');

// Usage meter + upgrade
const usageMeter = $('usage-meter');
const usageText = $('usage-text');
const usageBar = $('usage-bar');
const upgradePanel = $('upgrade-panel');
const upgradeClose = $('upgrade-close');

// ---- storage keys ----
const KEY_STORAGE = 'aisb_anthropic_key';
const CLIENT_ID = 'aisb_client_id';
const PROJECTS = 'aisb_projects_v2';
const ACTIVE_PROJECT = 'aisb_active_project';

// ---- runtime state ----
let project = null; // { id, name, files: {path:content}, conversation: [], activeFile }
let busy = false;
let config = { managedAgent: false, freeTokens: 0, stripeProLink: '', stripeStudioLink: '' };
let saveTimer = null;
let previewTimer = null;

// ===========================================================================
// Client id (anonymous, for usage metering of the free managed agent)
// ===========================================================================
function clientId() {
  let id = localStorage.getItem(CLIENT_ID);
  if (!id) {
    id = 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(CLIENT_ID, id);
  }
  return id;
}

// ===========================================================================
// Bring-your-own-key (optional — unlimited use, bypasses the free quota)
// ===========================================================================
function getKey() { return (localStorage.getItem(KEY_STORAGE) || '').trim(); }
function hasKey() { return getKey().length > 0; }
function looksLikeKey(k) {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k) || /^AIza[A-Za-z0-9_-]{30,}$/.test(k);
}
function refreshKeyUi() {
  const set = hasKey();
  keyStatus.hidden = !set;
  keyClear.hidden = !set;
  keyBtn.textContent = set ? 'Your key ✓' : 'Use your own key';
}
function openKeyPanel() {
  keyInput.value = getKey();
  keyError.hidden = true;
  keyPanel.hidden = false;
  keyInput.focus();
}
function closeKeyPanel() { keyPanel.hidden = true; }
function saveKey() {
  const k = keyInput.value.trim();
  if (k && !looksLikeKey(k)) {
    keyError.textContent = 'That doesn’t look like a key. Use a free Google Gemini key ("AIza…") or an Anthropic key ("sk-ant-…").';
    keyError.hidden = false;
    return;
  }
  if (k) localStorage.setItem(KEY_STORAGE, k);
  else localStorage.removeItem(KEY_STORAGE);
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
keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveKey(); } });
keyPanel.addEventListener('click', (e) => { if (e.target === keyPanel) closeKeyPanel(); });

// ===========================================================================
// Config + usage meter
// ===========================================================================
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) config = Object.assign(config, await res.json());
  } catch (e) { /* offline / static host — managed agent just stays off */ }
  refreshUsage();
}

async function refreshUsage() {
  // BYOK = unlimited; don't show a quota meter.
  if (hasKey() || !config.managedAgent) {
    usageMeter.hidden = true;
    return;
  }
  try {
    const res = await fetch('/api/usage', { headers: { 'x-client-id': clientId() } });
    if (!res.ok) { usageMeter.hidden = true; return; }
    const u = await res.json();
    const used = u.used || 0;
    const limit = u.limit || config.freeTokens || 1;
    const pct = Math.min(100, Math.round((used / limit) * 100));
    usageMeter.hidden = false;
    usageText.textContent = `${fmt(used)} / ${fmt(limit)} free tokens`;
    usageBar.style.width = pct + '%';
    usageBar.classList.toggle('warn', pct >= 80);
    usageBar.classList.toggle('full', pct >= 100);
  } catch (e) { usageMeter.hidden = true; }
}
function fmt(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(n);
}

function openUpgrade() {
  // Fill payment links if configured.
  const proLink = $('upgrade-pro');
  const studioLink = $('upgrade-studio');
  if (config.stripeProLink) { proLink.href = config.stripeProLink; proLink.classList.remove('disabled'); }
  if (config.stripeStudioLink) { studioLink.href = config.stripeStudioLink; studioLink.classList.remove('disabled'); }
  upgradePanel.hidden = false;
}
function closeUpgrade() { upgradePanel.hidden = true; }
upgradeClose.addEventListener('click', closeUpgrade);
upgradePanel.addEventListener('click', (e) => { if (e.target === upgradePanel) closeUpgrade(); });

// ===========================================================================
// Projects (localStorage persistence — instant, no signup)
// ===========================================================================
function loadProjects() {
  try { return JSON.parse(localStorage.getItem(PROJECTS) || '[]'); }
  catch (e) { return []; }
}
function saveProjects(list) { localStorage.setItem(PROJECTS, JSON.stringify(list)); }

function persist() {
  if (!project) return;
  const list = loadProjects();
  const i = list.findIndex((p) => p.id === project.id);
  project.updatedAt = Date.now();
  if (i === -1) list.unshift(project);
  else list[i] = project;
  saveProjects(list);
  localStorage.setItem(ACTIVE_PROJECT, project.id);
}
function persistDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 400);
}

function newProject(name) {
  return {
    id: 'p_' + Math.random().toString(36).slice(2) + Date.now().toString(36),
    name: name || 'Untitled site',
    files: {},
    conversation: [],
    activeFile: null,
    updatedAt: Date.now(),
  };
}

function switchToProject(id) {
  const list = loadProjects();
  const found = list.find((p) => p.id === id);
  project = found || (list[0] || newProject());
  if (!found) persist();
  localStorage.setItem(ACTIVE_PROJECT, project.id);
  project.activeFile = project.activeFile && project.files[project.activeFile]
    ? project.activeFile
    : firstHtml(project.files) || Object.keys(project.files)[0] || null;
  renderAll();
}

function renderProjectSelect() {
  const list = loadProjects();
  projectSelect.innerHTML = '';
  for (const p of list) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (project && p.id === project.id) opt.selected = true;
    projectSelect.appendChild(opt);
  }
}

projectSelect.addEventListener('change', () => switchToProject(projectSelect.value));
newBtn.addEventListener('click', () => {
  const name = prompt('Name your new website project:', 'Untitled site');
  if (name === null) return;
  project = newProject(name.trim() || 'Untitled site');
  persist();
  renderAll();
  promptInput.focus();
});
renameBtn.addEventListener('click', () => {
  if (!project) return;
  const name = prompt('Rename project:', project.name);
  if (name === null) return;
  project.name = name.trim() || project.name;
  persist();
  renderProjectSelect();
});
deleteBtn.addEventListener('click', () => {
  if (!project) return;
  if (!confirm(`Delete "${project.name}"? This can’t be undone.`)) return;
  const list = loadProjects().filter((p) => p.id !== project.id);
  saveProjects(list);
  if (list.length) switchToProject(list[0].id);
  else { project = newProject(); persist(); renderAll(); }
});

// ===========================================================================
// File helpers
// ===========================================================================
function firstHtml(files) {
  if (files['index.html'] != null) return 'index.html';
  return Object.keys(files).find((p) => p.endsWith('.html')) || null;
}
function fileIcon(path) {
  if (path.endsWith('.html')) return '📄';
  if (path.endsWith('.css')) return '🎨';
  if (path.endsWith('.js')) return '⚙️';
  if (/\.(png|jpe?g|svg|gif|webp|ico)$/i.test(path)) return '🖼️';
  return '📃';
}

function renderFileList() {
  const paths = Object.keys(project.files).sort((a, b) => {
    // index.html first, then html, then everything else, alpha.
    const rank = (p) => (p === 'index.html' ? 0 : p.endsWith('.html') ? 1 : 2);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  fileListEl.innerHTML = '';
  if (!paths.length) {
    const li = document.createElement('li');
    li.className = 'explorer-empty';
    li.textContent = 'No files yet. Describe a site to generate them.';
    fileListEl.appendChild(li);
    downloadBtn.disabled = true;
    return;
  }
  downloadBtn.disabled = false;
  for (const path of paths) {
    const li = document.createElement('li');
    li.className = 'file-item' + (path === project.activeFile ? ' active' : '');
    li.dataset.path = path;
    li.innerHTML =
      `<span class="fi-icon">${fileIcon(path)}</span>` +
      `<span class="fi-name"></span>` +
      `<button class="fi-del" title="Delete file">✕</button>`;
    li.querySelector('.fi-name').textContent = path;
    fileListEl.appendChild(li);
  }
}

fileListEl.addEventListener('click', (e) => {
  const del = e.target.closest('.fi-del');
  const item = e.target.closest('.file-item');
  if (!item) return;
  const path = item.dataset.path;
  if (del) {
    e.stopPropagation();
    if (!confirm(`Delete ${path}?`)) return;
    delete project.files[path];
    if (project.activeFile === path) project.activeFile = firstHtml(project.files) || Object.keys(project.files)[0] || null;
    persist();
    renderFileList();
    renderEditor();
    renderPreview();
    return;
  }
  selectFile(path);
});

addFileBtn.addEventListener('click', () => {
  const name = prompt('New file name (e.g. about.html, theme.css):', '');
  if (!name) return;
  const path = name.trim().replace(/^\/+/, '');
  if (!path || project.files[path] != null) { if (project.files[path] != null) alert('That file already exists.'); return; }
  project.files[path] = path.endsWith('.html')
    ? '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<title>New page</title>\n<link rel="stylesheet" href="styles.css">\n</head>\n<body>\n\n</body>\n</html>\n'
    : '';
  selectFile(path);
  persist();
  renderFileList();
});

function selectFile(path) {
  project.activeFile = path;
  renderFileList();
  renderEditor();
  switchTab('code');
}

// ===========================================================================
// Code editor
// ===========================================================================
function renderEditor() {
  const path = project.activeFile;
  if (!path || project.files[path] == null) {
    codeEditor.value = '';
    codeEditor.disabled = true;
    activeFileLabel.textContent = '';
    return;
  }
  codeEditor.disabled = false;
  codeEditor.value = project.files[path];
  activeFileLabel.textContent = path;
}

codeEditor.addEventListener('input', () => {
  const path = project.activeFile;
  if (!path) return;
  project.files[path] = codeEditor.value;
  persistDebounced();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 350);
});

// Tab key inserts two spaces instead of leaving the textarea.
codeEditor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = codeEditor.selectionStart, en = codeEditor.selectionEnd;
    codeEditor.value = codeEditor.value.slice(0, s) + '  ' + codeEditor.value.slice(en);
    codeEditor.selectionStart = codeEditor.selectionEnd = s + 2;
    codeEditor.dispatchEvent(new Event('input'));
  }
});

// ===========================================================================
// Preview — assemble the project into one self-contained document
// ===========================================================================
function stripRel(href) {
  return String(href).replace(/^\.\//, '').replace(/^\//, '').split(/[?#]/)[0];
}

function assemble(files, entry) {
  let html = files[entry];
  if (html == null) return '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:2rem;color:#555">No <code>index.html</code> yet.</body>';

  // Inline local stylesheets so the iframe (no network to our files) renders them.
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
    const m = tag.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!m) return tag;
    const key = stripRel(m[1]);
    if (files[key] != null) return `<style>\n${files[key]}\n</style>`;
    return tag; // external CDN stays
  });

  // Inline local scripts.
  html = html.replace(/<script\b[^>]*src\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi, (tag, src) => {
    const key = stripRel(src);
    if (files[key] != null) return `<script>\n${files[key]}\n</script>`;
    return tag;
  });

  return html;
}

function previewEntry() {
  const af = project.activeFile;
  if (af && af.endsWith('.html')) return af;
  return firstHtml(project.files);
}

function renderPreview() {
  const entry = previewEntry();
  if (!entry) {
    previewFrame.style.display = 'none';
    placeholder.style.display = 'flex';
    openBtn.disabled = true;
    refreshBtn.disabled = true;
    return;
  }
  previewFrame.style.display = 'block';
  placeholder.style.display = 'none';
  previewFrame.srcdoc = assemble(project.files, entry);
  openBtn.disabled = false;
  refreshBtn.disabled = false;
}

refreshBtn.addEventListener('click', renderPreview);

// ===========================================================================
// Tabs
// ===========================================================================
function switchTab(which) {
  const isCode = which === 'code';
  tabCode.classList.toggle('active', isCode);
  tabPreview.classList.toggle('active', !isCode);
  codeView.hidden = !isCode;
  previewView.hidden = isCode;
}
tabPreview.addEventListener('click', () => { switchTab('preview'); renderPreview(); });
tabCode.addEventListener('click', () => switchTab('code'));

// ===========================================================================
// Open in tab / Download zip
// ===========================================================================
openBtn.addEventListener('click', () => {
  const entry = previewEntry();
  if (!entry) return;
  const blob = new Blob([assemble(project.files, entry)], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
});

downloadBtn.addEventListener('click', () => {
  const paths = Object.keys(project.files);
  if (!paths.length) return;
  const files = paths.map((p) => ({ name: p, content: project.files[p] }));
  const blob = window.makeZip(files);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (project.name || 'website').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

// ===========================================================================
// Chat with the agent
// ===========================================================================
composer.addEventListener('submit', (e) => { e.preventDefault(); send(); });
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

messagesEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.example-chip');
  if (chip) { promptInput.value = chip.dataset.text; promptInput.focus(); }
});

async function send() {
  if (busy) return;
  const text = promptInput.value.trim();
  if (!text) return;

  hideError();
  removeIntro();
  addMessage('user', text);
  project.conversation.push({ role: 'user', content: text });
  promptInput.value = '';
  persist();

  setBusy(true);
  const thinkingEl = addThinking();

  const currentFiles = Object.keys(project.files).map((p) => ({ path: p, content: project.files[p] }));
  const headers = { 'Content-Type': 'application/json', 'x-client-id': clientId() };
  if (hasKey()) headers['x-anthropic-key'] = getKey();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ messages: project.conversation, currentFiles }),
    });
    const data = await response.json();
    thinkingEl.remove();

    if (!response.ok) {
      project.conversation.pop();
      persist();
      if (data.code === 'QUOTA_EXCEEDED') {
        addMessage('agent', 'You’ve used your free token allowance. Upgrade to keep building — or add your own AI key for unlimited use.');
        openUpgrade();
      } else {
        showError(data.error || 'Something went wrong.');
        if (data.code === 'NO_KEY' || data.code === 'BAD_KEY' || data.code === 'KEY_REJECTED') openKeyPanel();
      }
      refreshUsage();
      return;
    }

    const reply = data.reply || 'Done.';
    addMessage('agent', reply);
    project.conversation.push({ role: 'assistant', content: reply });

    if (Array.isArray(data.files) && data.files.length) {
      const map = {};
      for (const f of data.files) {
        if (f && typeof f.path === 'string' && typeof f.content === 'string') map[f.path] = f.content;
      }
      project.files = map;
      project.activeFile = firstHtml(map) || Object.keys(map)[0] || null;
      renderFileList();
      renderEditor();
      renderPreview();
      switchTab('preview');
    }
    persist();
    refreshUsage();
  } catch (err) {
    console.error(err);
    thinkingEl.remove();
    project.conversation.pop();
    persist();
    showError('Could not reach the server. Is it running?');
  } finally {
    setBusy(false);
    promptInput.focus();
  }
}

// ===========================================================================
// Chat rendering
// ===========================================================================
function addMessage(who, text) {
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  const p = document.createElement('p');
  p.textContent = text;
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
function removeIntro() { const i = messagesEl.querySelector('.intro'); if (i) i.remove(); }
function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

function renderConversation() {
  messagesEl.innerHTML = '';
  if (!project.conversation.length) { renderIntro(); return; }
  for (const m of project.conversation) addMessage(m.role === 'user' ? 'user' : 'agent', m.content);
}
function renderIntro() {
  const intro = document.createElement('div');
  intro.className = 'msg agent intro';
  intro.innerHTML = `
    <p>Hi! I’m your website-building agent. Describe the site you want and I’ll
       build a real multi-file project — pages, styles, and scripts — then keep
       chatting to refine it.</p>
    <p class="examples-or">Try one to get going:</p>
    <div class="examples">
      <button class="example-chip" data-text="A landing page for a cozy neighborhood coffee shop called &quot;Fern &amp; Bean&quot;. Warm, earthy colors. Hero section, a menu preview, an about section, and a contact form. Add a separate Menu page too.">☕ Coffee shop (multi-page)</button>
      <button class="example-chip" data-text="A portfolio site for a freelance photographer, dark and moody, with a full-bleed image grid, an about page, and a contact page.">📷 Photographer portfolio</button>
      <button class="example-chip" data-text="A landing page for a SaaS app that helps small teams manage invoices. Clean, modern, blue and white, with a pricing section and a separate features page.">🚀 SaaS landing page</button>
      <button class="example-chip" data-text="A personal blog with a home page listing posts, an about page, and one sample post page. Friendly, readable typography.">✍️ Personal blog</button>
    </div>`;
  messagesEl.appendChild(intro);
}

// ===========================================================================
// UI state
// ===========================================================================
function setBusy(isBusy) {
  busy = isBusy;
  sendBtn.disabled = isBusy;
  promptInput.disabled = isBusy;
  btnLabel.textContent = isBusy ? 'Working…' : 'Send';
  previewLoading.hidden = !isBusy;
}
function showError(text) { errorMsg.textContent = text; errorMsg.hidden = false; }
function hideError() { errorMsg.hidden = true; }

// ===========================================================================
// Render everything for the current project
// ===========================================================================
function renderAll() {
  renderProjectSelect();
  renderConversation();
  renderFileList();
  renderEditor();
  renderPreview();
  if (Object.keys(project.files).length) switchTab('preview');
  else switchTab('code');
  refreshKeyUi();
  refreshUsage();
}

// ===========================================================================
// Boot
// ===========================================================================
(function boot() {
  const list = loadProjects();
  const activeId = localStorage.getItem(ACTIVE_PROJECT);
  if (list.length) {
    project = list.find((p) => p.id === activeId) || list[0];
    project.activeFile = project.activeFile && project.files[project.activeFile]
      ? project.activeFile
      : firstHtml(project.files) || Object.keys(project.files)[0] || null;
  } else {
    project = newProject();
    persist();
  }
  refreshKeyUi();
  renderAll();
  loadConfig();
})();
