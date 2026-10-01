# Rewrite with Ollama

A browser extension (Edge / Chrome, Manifest V3) that rewrites your selected
text with a **local** Ollama model. No accounts, no cloud, no subscriptions —
your text never leaves your own network.

Select text on any page → right-click → **Rewrite with Ollama** → preview and
edit the rewrite in a dialog → **Apply** it back into the page, **Copy** it,
or **Regenerate** an alternative.

## Features

- Right-click context menu on any selected text
- Preview dialog: original (read-only) + rewrite (editable)
- **Apply** replaces the text in the page; **Copy** is verified against the
  clipboard and shows a ✓ confirmation; **Regenerate** asks for alternative
  wording
- Custom rewrite prompt and temperature slider in Settings
- Running version shown in the dialog header

## Requirements

- [Ollama](https://ollama.com) installed and running
- At least one model pulled, e.g. `ollama pull qwen2.5:7b`

## Install

1. Download the release zip and extract it. Keep the inner
   `RewriteWithOllama` folder — the one that directly contains
   `manifest.json`.
2. Open `edge://extensions` (or `chrome://extensions`) and turn on
   **Developer mode**.
3. Click **Load unpacked** and select the `RewriteWithOllama` folder.
4. Optional: pin it via the puzzle-piece toolbar menu.

## Configure

Click the toolbar icon with no text selected to open Settings:

- **Ollama endpoint** — default `http://localhost:11434`. If Ollama runs on
  another machine (e.g. over Tailscale), set it to that address, like
  `http://100.x.y.z:11434`.
- **Model name** — must match `ollama list` on the Ollama machine
  **exactly**, or you'll get an HTTP 404.
- **Rewrite prompt** — the instruction sent before your selected text.
  Default: "Rewrite this to be clear, concise, and preserve the meaning:"
- **Temperature** — 0 to 2, default 0.8. Lower = more literal, higher = more
  creative.

### Ollama on another machine — the two gotchas

1. **Bind to the network:** set `OLLAMA_HOST=0.0.0.0` and restart Ollama,
   or it only listens on localhost.
2. **Allow browser-extension origins:** set `OLLAMA_ORIGINS=*` and restart
   Ollama. Without this, the extension gets an HTTP 403 — Ollama's default
   origins don't include `chrome-extension://` schemes.

On Windows with Ollama installed as a service, set these via the registry at
`HKLM:\SYSTEM\CurrentControlSet\Services\OllamaService\Parameters\AppEnvironmentExtra`,
then run `Restart-Service OllamaService` in an admin PowerShell.

## Usage

1. Select text on a webpage, right-click it, choose **Rewrite with Ollama**.
   (The menu item only appears on real web pages with text selected — not on
   `edge://`/`chrome://` pages, the new-tab page, or some PDFs.)
2. Wait for the rewrite. A local 7B model can take 30–60 seconds on the first
   run while the model loads.
3. Edit the rewrite if you like, then **Apply** (replaces the text in the
   page), **Copy** (verified — the button shows "Copied ✓"), **Regenerate**
   (alternative wording; re-reads Settings first), or **Cancel**.

## Permissions — why each one

- `contextMenus` — the right-click menu item
- `storage` — your settings and in-flight rewrite jobs
- `activeTab`, `scripting` — read the selected text and apply the rewrite
  on the current tab
- `clipboardWrite`, `clipboardRead` — the Copy button (verified copy) and
  Apply on rich-text editors, which paste the rewrite like Ctrl+V. The
  extension only reads your clipboard momentarily to restore what was there
  before. Nothing is sent anywhere.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Couldn't reach Ollama" | Server isn't running at the configured endpoint, or the address is wrong |
| HTTP 403 from Ollama | Set `OLLAMA_ORIGINS=*` and restart Ollama |
| HTTP 404 "model not found" | Model name doesn't match `ollama list` exactly — fix it in Settings |
| Menu item doesn't appear | You need selected text on a normal web page; reload the extension after edits |
| Model answers with a greeting instead of rewriting | The model needs an explicit ChatML `TEMPLATE` + `SYSTEM` in its Modelfile, then `ollama create` again |
| Apply does nothing on some sites | Some editors (e.g. Facebook's composer) discard programmatic edits — use **Copy** + Ctrl+V there |

## Privacy

Every request goes to the Ollama endpoint you configure. The extension makes
no other network calls, has no analytics, and sends nothing to any third
party.

## License

MIT — see [LICENSE](LICENSE).
