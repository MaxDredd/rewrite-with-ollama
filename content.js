// Rewrite with Ollama — content script.
// Runs in every page. Snapshots the user's selection (field offsets or a
// DOM Range) so the rewrite window can later replace exactly that text,
// even though the popup is a separate window.

let lastSelection = null;

function isTextField(el) {
  if (!el) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") {
    return /^(text|search|url|tel|password|email|number)$/i.test(el.type || "text");
  }
  return false;
}

function snapshotSelection() {
  try {
    const ae = document.activeElement;
    if (isTextField(ae) && typeof ae.selectionStart === "number") {
      lastSelection = {
        kind: "field",
        el: ae, // live reference to the field
        start: ae.selectionStart,
        end: ae.selectionEnd
      };
      return;
    }
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      lastSelection = { kind: "range", range: sel.getRangeAt(0).cloneRange() };
    }
  } catch (e) {
    // Never let a snapshot failure break the page.
  }
}

// Keep the snapshot fresh as the selection changes, and capture it the
// instant the right-click menu opens (before the click is processed).
document.addEventListener("selectionchange", snapshotSelection);
document.addEventListener("contextmenu", snapshotSelection, true);
snapshotSelection();

function fireInputEvents(el) {
  el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
}

function applyToField(sel, newText) {
  const el = sel.el;
  if (!document.contains(el)) {
    return { ok: false, error: "The text field is gone." };
  }
  el.focus();
  const len = el.value.length;
  const start = Math.max(0, Math.min(sel.start, len));
  const end = Math.max(start, Math.min(sel.end, len));
  try {
    const merged = el.value.slice(0, start) + newText + el.value.slice(end);
    // Use the prototype's native value setter so framework-controlled
    // inputs (React etc.) notice the change, then fire a genuine input
    // event for them to pick up.
    const proto = el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    if (setter) {
      setter.call(el, merged);
    } else {
      el.value = merged;
    }
    const caret = start + newText.length;
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
  } catch (e) {
    return { ok: false, error: "Couldn't edit the field." };
  }
  return { ok: true };
}

async function applyToRange(sel, newText) {
  const saved = sel.range;
  if (!saved || !document.contains(saved.commonAncestorContainer)) {
    return { ok: false, error: "The selected text is no longer on the page." };
  }
  const container = saved.commonAncestorContainer;
  const editable = container instanceof Element
    ? container.closest("[contenteditable]")
    : container.parentElement
      ? container.parentElement.closest("[contenteditable]")
      : null;
  const selection = window.getSelection();

  // Rich-text editors (Facebook's composer, etc.) keep their own text
  // model and can silently discard direct DOM edits. So for them, Apply
  // does exactly what Ctrl+V would: the dialog has already put the rewrite
  // on the clipboard, and a real, trusted paste replaces the highlighted
  // text. The editor cannot tell it apart from the user pasting.
  if (editable) {
    const pasted = await applyViaPaste(editable, selection, saved);
    if (pasted.ok || pasted.manualPaste) return pasted;
    // Paste path errored without the manual fallback — try in-place editing.
    try {
      editable.focus();
      selection.removeAllRanges();
      selection.addRange(saved);
      if (document.execCommand("insertText", false, newText)) {
        return { ok: true };
      }
    } catch (e) { /* fall through to DOM replacement */ }
  }

  try {
    selection.removeAllRanges();
    selection.addRange(saved);
    saved.deleteContents();
    const node = document.createTextNode(newText);
    saved.insertNode(node);
    saved.setStartAfter(node);
    saved.collapse(true);
    selection.removeAllRanges();
    selection.addRange(saved);
    fireInputEvents(editable || document.body);
  } catch (e) {
    return { ok: false, error: "Couldn't replace the selected text." };
  }
  return { ok: true };
}

// Wait until the document has focus (the tab window was just refocused;
// the OS can lag a beat). Resolves true if focused within ms.
function waitForDocumentFocus(ms) {
  return new Promise((resolve) => {
    if (document.hasFocus()) { resolve(true); return; }
    const start = Date.now();
    const timer = setInterval(() => {
      if (document.hasFocus() || Date.now() - start >= ms) {
        clearInterval(timer);
        resolve(document.hasFocus());
      }
    }, 50);
  });
}

// Paste the rewrite (already on the clipboard — the dialog put it there,
// where the clipboard write is reliable) over the saved selection: the
// extension equivalent of the user pressing Ctrl+V.
async function applyViaPaste(editable, selection, saved) {
  editable.focus();
  await waitForDocumentFocus(1200);
  selection.removeAllRanges();
  selection.addRange(saved);
  // Trusted paste: fires genuine beforeinput (insertFromPaste) + input,
  // exactly like the user pressing Ctrl+V. Needs the clipboardRead
  // permission in the manifest.
  let pasted = false;
  try {
    pasted = document.execCommand("paste");
  } catch (e) {
    pasted = false;
  }
  if (!pasted) {
    // Leave the rewrite on the clipboard so the user can Ctrl+V manually.
    return { ok: false, manualPaste: true, error: "The paste command was refused." };
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;

  if (msg.type === "QWEN_SNAPSHOT_SELECTION") {
    snapshotSelection();
    sendResponse({ ok: true, hasSelection: !!lastSelection });
    return false;
  }

  if (msg.type === "QWEN_APPLY_REWRITE") {
    // Async: the paste path waits for focus, so keep the channel open.
    (async () => {
      try {
        if (!lastSelection) snapshotSelection(); // one last try
        if (!lastSelection) {
          sendResponse({ ok: false, error: "No text selection found on the page." });
          return;
        }
        const text = String(msg.text ?? "");
        const prevClip = msg.previousClipboard ?? null;
        let result;
        if (lastSelection.kind === "field") {
          result = applyToField(lastSelection, text);
        } else {
          result = await applyToRange(lastSelection, text);
        }
        // The clipboard was only a transfer mechanism: put the user's
        // original clipboard back after a successful apply. On manualPaste
        // failures the rewrite stays on the clipboard for Ctrl+V.
        if (result && result.ok && !result.manualPaste && prevClip !== null) {
          try { await navigator.clipboard.writeText(prevClip); } catch (e) {}
        }
        sendResponse(result);
      } catch (e) {
        // Never leave the sender hanging: a throw becomes an error reply.
        sendResponse({ ok: false, error: "Apply crashed: " + String((e && e.message) || e) });
      }
    })();
    return true;
  }

  return false;
});
