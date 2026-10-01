// Rewrite with Ollama — popup window logic.
// Loads the selected-text "job" left by background.js, calls the local
// Ollama /api/generate endpoint, and shows the preview/edit dialog.
// Apply sends the edited text back through background.js -> content.js.

const DEFAULT_ENDPOINT = "http://localhost:11434";
const DEFAULT_MODEL = "qwen2.5:7b";
const DEFAULT_PROMPT_PREFIX = "Rewrite this to be clear, concise, and preserve the meaning:\n\n";
const DEFAULT_TEMPERATURE = 0.8; // Ollama's own default; keeps behavior identical until changed
const OLLAMA_TIMEOUT_MS = 180000;

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const mainEl = $("main");
const emptyEl = $("empty");
const emptyMsgEl = $("emptyMsg");
const originalEl = $("original");
const rewrittenEl = $("rewritten");
const applyBtn = $("apply");
const regenerateBtn = $("regenerate");
const copyBtn = $("copy");
const cancelBtn = $("cancel");
const endpointInput = $("endpoint");
const modelInput = $("model");
const promptInput = $("promptPrefix");
const temperatureInput = $("temperature");
const tempValueEl = $("tempValue");
const saveSettingsBtn = $("saveSettings");

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = "status " + (kind || "");
}

function setActionButtonsDisabled(disabled) {
  applyBtn.disabled = disabled;
  regenerateBtn.disabled = disabled;
  copyBtn.disabled = disabled;
}

// Race a promise against a timeout so a hung page/worker surfaces as a
// visible error instead of leaving the dialog stuck silently.
function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function getSettings() {
  const s = await chrome.storage.local.get({
    endpoint: DEFAULT_ENDPOINT,
    model: DEFAULT_MODEL,
    promptPrefix: DEFAULT_PROMPT_PREFIX,
    temperature: DEFAULT_TEMPERATURE
  });
  let temperature = parseFloat(s.temperature);
  if (!Number.isFinite(temperature)) temperature = DEFAULT_TEMPERATURE;
  temperature = Math.min(2, Math.max(0, temperature));
  return {
    endpoint: String(s.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, ""),
    model: String(s.model || DEFAULT_MODEL).trim(),
    promptPrefix: String(s.promptPrefix || DEFAULT_PROMPT_PREFIX),
    temperature: temperature
  };
}

async function rewriteWithOllama(settings, text, extraInstruction) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OLLAMA_TIMEOUT_MS);
  try {
    const res = await fetch(settings.endpoint + "/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.model,
        prompt: settings.promptPrefix + (extraInstruction || "") + text,
        stream: false,
        options: { temperature: settings.temperature }
      }),
      signal: ctrl.signal
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(
        "Ollama returned HTTP " + res.status + (body ? " — " + body : "") +
        (res.status === 404 ? " (is the model name correct? check `ollama list`)" : "")
      );
    }
    const data = await res.json();
    const out = data && data.response ? String(data.response).trim() : "";
    if (!out) throw new Error("Ollama returned an empty response.");
    return out;
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error("Timed out waiting for Ollama. Is the server running and the model loaded?");
    }
    if (e instanceof TypeError) {
      throw new Error("Couldn't reach Ollama at " + settings.endpoint + ". Is the server running there?");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function init() {
  const params = new URLSearchParams(location.search);
  const jobId = params.get("job");

  // Show the running version in the dialog header so it's always clear
  // which build is loaded (read from the manifest, never hardcoded).
  try {
    const ver = chrome.runtime.getManifest().version;
    if (ver) $("version").textContent = "v" + ver;
  } catch (e) { /* leave blank */ }

  const settings = await getSettings();
  endpointInput.value = settings.endpoint;
  modelInput.value = settings.model;
  promptInput.value = settings.promptPrefix;
  temperatureInput.value = settings.temperature;
  tempValueEl.textContent = String(settings.temperature);

  temperatureInput.oninput = () => {
    tempValueEl.textContent = temperatureInput.value;
  };

  saveSettingsBtn.onclick = async () => {
    let temperature = parseFloat(temperatureInput.value);
    if (!Number.isFinite(temperature)) temperature = DEFAULT_TEMPERATURE;
    temperature = Math.min(2, Math.max(0, temperature));
    await chrome.storage.local.set({
      endpoint: endpointInput.value.trim().replace(/\/+$/, "") || DEFAULT_ENDPOINT,
      model: modelInput.value.trim() || DEFAULT_MODEL,
      promptPrefix: promptInput.value || DEFAULT_PROMPT_PREFIX,
      temperature: temperature
    });
    const s = await getSettings();
    endpointInput.value = s.endpoint;
    modelInput.value = s.model;
    promptInput.value = s.promptPrefix;
    temperatureInput.value = s.temperature;
    tempValueEl.textContent = String(s.temperature);
    setStatus("Settings saved.", "ok");
  };

  cancelBtn.onclick = () => window.close();

  copyBtn.onclick = async () => {
    const text = rewrittenEl.value;
    copyBtn.disabled = true;
    try {
      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch (e) {
        // Fallback for clipboard hiccups: select + legacy copy command.
        try {
          rewrittenEl.focus();
          rewrittenEl.select();
          copied = document.execCommand("copy");
        } catch (e2) {
          copied = false;
        }
      }
      // Verify it's really on the clipboard before saying so.
      let verified = false;
      if (copied) {
        try {
          verified = (await navigator.clipboard.readText()) === text;
        } catch (e) {
          verified = false;
        }
      }
      if (copied && verified) {
        setStatus("Copied to clipboard.", "ok");
        copyBtn.textContent = "Copied ✓";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
      } else if (copied) {
        setStatus("Copy may not have stuck — click Copy again or press Ctrl+C.", "error");
      } else {
        throw new Error("the clipboard refused the copy.");
      }
    } catch (e) {
      setStatus("Error: couldn't copy — " + e.message, "error");
    } finally {
      copyBtn.disabled = false;
    }
  };

  if (!jobId) {
    // Opened from the toolbar with no selection — show help + settings.
    emptyEl.hidden = false;
    setStatus("Idle", "");
    return;
  }

  const stored = await chrome.storage.session.get(jobId);
  const job = stored[jobId];
  if (!job || !job.text) {
    emptyEl.hidden = false;
    emptyMsgEl.textContent = "Couldn't find the selected text (the job expired). Re-select text on the page and try again.";
    setStatus("No job found.", "error");
    return;
  }

  mainEl.hidden = false;
  originalEl.value = job.text;
  rewrittenEl.value = "";
  setStatus("Rewriting with " + settings.model + "…", "busy");

  try {
    rewrittenEl.value = await rewriteWithOllama(settings, job.text);
    setStatus("Done — review and edit the rewrite, then Apply.", "ok");
  } catch (err) {
    setStatus("Error: " + err.message, "error");
    rewrittenEl.placeholder = "Rewrite failed — you can type the text manually, or press Cancel.";
  }

  regenerateBtn.onclick = async () => {
    // Re-read settings so a tweaked prompt/temperature applies immediately.
    const s = await getSettings();
    setActionButtonsDisabled(true);
    setStatus("Regenerating with " + s.model + " — trying different wording…", "busy");
    rewrittenEl.value = "";
    rewrittenEl.placeholder = "Regenerating…";
    try {
      rewrittenEl.value = await rewriteWithOllama(
        s,
        job.text,
        "Provide an alternative rewrite with different wording:\n\n"
      );
      setStatus("Done — review and edit the rewrite, then Apply.", "ok");
    } catch (err) {
      setStatus("Error: " + err.message, "error");
      rewrittenEl.placeholder = "Rewrite failed — you can type the text manually, or press Cancel.";
    } finally {
      setActionButtonsDisabled(false);
    }
  };

  applyBtn.onclick = async () => {
    const text = rewrittenEl.value;
    applyBtn.disabled = true;
    setStatus("Applying to the page…", "busy");
    let previousClipboard = null;
    try {
      // The dialog is the focused document at click time, so the clipboard
      // write is reliable here. The page then only has to paste.
      try {
        previousClipboard = await navigator.clipboard.readText();
      } catch (e) { /* restore is skipped if we can't read */ }
      await withTimeout(
        navigator.clipboard.writeText(text),
        5000,
        "Couldn't write to the clipboard."
      );
      const res = await withTimeout(
        chrome.runtime.sendMessage({
          type: "QWEN_APPLY_REWRITE",
          jobId: jobId,
          text: text,
          previousClipboard: previousClipboard
        }),
        15000,
        "Timed out waiting for the page to respond (15s)."
      );
      if (res && res.ok) {
        window.close();
        return;
      }
      if (res && res.manualPaste) {
        throw new Error("Automatic paste didn't take — the rewrite is on your clipboard. Click in the Facebook box and press Ctrl+V.");
      }
      throw new Error((res && res.error) || "Unknown error.");
    } catch (e) {
      setStatus("Error: " + e.message, "error");
      applyBtn.disabled = false;
    }
  };
}

document.addEventListener("DOMContentLoaded", init);
