const promptInput = document.getElementById('prompt-input');
const generateBtn = document.getElementById('generate-btn');
const btnLabel = document.getElementById('btn-label');
const errorMsg = document.getElementById('error-msg');
const previewFrame = document.getElementById('preview-frame');
const placeholder = document.getElementById('placeholder');
const downloadBtn = document.getElementById('download-btn');

let latestHtml = '';

document.querySelectorAll('.example-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    promptInput.value = chip.dataset.text;
    promptInput.focus();
  });
});

generateBtn.addEventListener('click', generateSite);

promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    generateSite();
  }
});

async function generateSite() {
  const prompt = promptInput.value.trim();
  if (!prompt) {
    showError('Describe the website you want first.');
    return;
  }

  setLoading(true);
  hideError();

  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });

    const data = await response.json();

    if (!response.ok) {
      showError(data.error || 'Something went wrong.');
      return;
    }

    latestHtml = data.html;
    renderPreview(latestHtml);
    downloadBtn.disabled = false;
  } catch (err) {
    console.error(err);
    showError('Could not reach the server. Is it running?');
  } finally {
    setLoading(false);
  }
}

function renderPreview(html) {
  previewFrame.style.display = 'block';
  placeholder.style.display = 'none';
  // srcdoc keeps the generated page sandboxed inside the iframe
  // instead of navigating the whole app to it.
  previewFrame.srcdoc = html;
}

function setLoading(isLoading) {
  generateBtn.disabled = isLoading;
  btnLabel.textContent = isLoading ? 'Generating…' : 'Generate website';
}

function showError(text) {
  errorMsg.textContent = text;
  errorMsg.hidden = false;
}

function hideError() {
  errorMsg.hidden = true;
}

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
