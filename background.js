// Rewrite with Ollama — background service worker (Manifest V3).
// Owns the context-menu item, stashes the selected text as a "job",
// asks the content script to snapshot the exact selection, and opens
// the rewrite window (popup.html). Also relays the Apply action back
// to the tab that the text came from.

const MENU_ID = "rewrite-with-qwen";
const POPUP_PAGE = "popup.html";

function createContextMenu() {
  // removeAll first: service workers restart often, and create() throws
  // if an item with the same id already exists.
  chrome.contextMenus.removeAll().then(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Rewrite with Ollama",
      contexts: ["selection"] // only visible when text is selected
    });
  }).catch(() => {});
}

// (Re)create on every worker start — MV3 workers are ephemeral.
createContextMenu();
chrome.runtime.onInstalled.addListener(createContextMenu);
chrome.runtime.onStartup.addListener(createContextMenu);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id == null) return;

  const selectedText = (info.selectionText || "").trim();
  if (!selectedText) return;

  const jobId = "job-" + Date.now().toString(36);
  const job = {
    text: info.selectionText,
    tabId: tab.id,
    frameId: typeof info.frameId === "number" ? info.frameId : 0,
    created: Date.now()
  };
  await chrome.storage.session.set({ [jobId]: job });

  // Ask the content script to snapshot the exact selection/range now,
  // so Apply can replace precisely that text later.
  try {
    await chrome.tabs.sendMessage(
      tab.id,
      { type: "QWEN_SNAPSHOT_SELECTION" },
      { frameId: job.frameId }
    );
  } catch (e) {
    // Content script isn't in this page (e.g. edge:// pages, some PDFs).
    // The popup still opens; Apply will report a clear error there.
  }

  await chrome.windows.create({
    url: chrome.runtime.getURL(POPUP_PAGE) + "?job=" + encodeURIComponent(jobId),
    type: "popup",
    width: 600,
    height: 680
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "QWEN_APPLY_REWRITE") return false;

  (async () => {
    try {
      const stored = await chrome.storage.session.get(msg.jobId);
      const job = stored[msg.jobId];
      if (!job) {
        sendResponse({ ok: false, error: "The selection expired. Re-select the text on the page and try again." });
        return;
      }

      let result;
      try {
        // The rewrite dialog is a separate popup window, and rich-text
        // editors (Facebook's composer, etc.) only accept programmatic
        // edits while their own window is focused. Bring the tab forward
        // first — best effort, the apply attempt runs regardless.
        try {
          const tab = await chrome.tabs.get(job.tabId);
          if (tab && tab.windowId != null) {
            await chrome.windows.update(tab.windowId, { focused: true });
          }
          await chrome.tabs.update(job.tabId, { active: true });
          // Let the OS focus settle before the content script pastes.
          await new Promise((r) => setTimeout(r, 250));
        } catch (e) {
          // Ignore focus failures and try the apply anyway.
        }
        result = await Promise.race([
          chrome.tabs.sendMessage(
            job.tabId,
            { type: "QWEN_APPLY_REWRITE", text: msg.text, previousClipboard: msg.previousClipboard ?? null },
            { frameId: job.frameId }
          ),
          // If the tab never answers, say so instead of hanging the dialog.
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("PAGE_TIMEOUT")), 12000)
          )
        ]);
      } catch (e) {
        const timedOut = e && e.message === "PAGE_TIMEOUT";
        sendResponse({ ok: false, error: timedOut
          ? "The tab didn't respond within 12 seconds — the page may be stuck."
          : "Couldn't reach the page (it may have been closed or reloaded)." });
        return;
      }

      await chrome.storage.session.remove(msg.jobId);
      if (result && result.ok) {
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: (result && result.error) || "The page couldn't replace the text." });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();

  return true; // keep the message channel open for the async response
});
