# ◤ cloner

Universal frontend cloner — give it a **URL (+ cookies)**, a **screenshot**, or a **demo video**, and it produces a faithful, editable frontend clone with a live dashboard.

## Modes

| Mode | Input | What happens |
|------|-------|--------------|
| **URL** | `cloner https://example.com -c cookies.txt` | Headless browser logs in with your cookies → discovers tabs → captures every page's live DOM, screenshots, images, videos, fonts, CSS → assembles a self-contained clone → vision-model polish pass compares original vs clone screenshots and applies targeted fixes |
| **Image** | `cloner image shot.png` | Stitch-style: vision model analyzes the screenshot and returns pixel-faithful single-file HTML |
| **Video** | `cloner video demo.mp4` | ffmpeg extracts keyframes + audio → Whisper transcribes the narration → vision model understands every screen/state shown (and what the human says/wants) → generates an interactive clone + `brief.md` of the narration |

## F12-grade exact snapshot (`snapshot.mhtml`)

Every URL run also stores the original page through the **same channel Chrome DevTools uses** (CDP `Page.captureSnapshot` → MHTML): the *rendered* frontend with every computed style, loaded font, image and canvas paint, self-contained in one file.

- `snapshot.mhtml` — open in Chrome/Edge for the pixel-exact original, no CSS/asset chasing can break it
- `index.html` + `assets/` — the editable clone (static, scripts stripped, click-replay runtime wired)
- `clone.json` — run metadata, `mhtml` field points at the snapshot

If the editable clone ever renders short of the original, diff it against `snapshot.mhtml` — it is ground truth of what the browser actually saw.

## Live dashboard

Every run auto-starts a dashboard at `http://localhost:4173`:

- **Pipeline panel** — live steps: cookies → open → tabs found → capture → assets → assemble → polish, plus a scrolling log
- **Stage** — tabs for **Clone** (live iframe of your clone), **Original** (reference screenshots), **Side-by-side** compare
- **Edit panel** — `control-browser`-style editable output: click **⊕ Select element**, click any element in the clone preview (hover outline + click-to-pick), type an instruction ("make this button green", "change this heading", "remove this card") and the vision model patches the file; preview hot-reloads

## Cookies

`-c` accepts either format:

1. **JSON array** (EditThisCookie / DevTools export):
   `[{ "name": "session", "value": "...", "domain": ".example.com", ... }]`
2. **Netscape `cookies.txt`** (get via "Get cookies.txt" extensions)

Export cookies from a logged-in browser session and pass the file.

## Any vision model

Auto-detected from env: `ANTHROPIC_API_KEY` → `claude-sonnet-4-5`, else `OPENAI_API_KEY` → `gpt-4o`.
Override: `--model openai`, `--model anthropic`, or any OpenAI-compatible endpoint in `cloner.config.json`:

```json
{
  "model": {
    "provider": "custom",
    "model": "your-vision-model",
    "baseUrl": "https://your-endpoint/v1",
    "apiKey": "sk-..."
  }
}
```

`custom` works with any OpenAI-compatible API (z.ai GLM, OpenRouter, Together, LM Studio, Ollama with `--api`, …). Whisper transcription (video mode) uses OpenAI when `OPENAI_API_KEY` is set; otherwise the model reads frames only.

> Note: if the env keys are missing/invalid, URL mode still works fully (the DOM is ground truth — no model needed). Only the polish pass, image mode, video mode, and dashboard edit-chat need a working vision model, and every failure degrades gracefully with a warning instead of killing the run.

## Tests

```
npm test
```

- `scripts/test-vision.mjs` — VisionClient adapters (request shape, image encoding, SSE streaming, auth, error surfacing) against a local mock
- `scripts/test-integration.mjs` — dashboard server, `/api/runs`, preview picker injection, `/api/edit` model-edit flow, ffmpeg video extraction
- `scripts/verify.mjs <cloneDir> [port]` — renders a clone and screenshots it + the dashboard for visual checks

## CLI reference

```
cloner <url> [-c cookies.txt] [-p 5] [-o dir] [-m provider[:model]] [--no-polish] [--no-ui] [--port 4173]
cloner image <file>
cloner video <file>
cloner serve
```

## Notes

- URL mode does **not** need a vision model at all — the live DOM is ground truth, so the clone is exact by construction. The polish pass just sharpens residuals.
- Scripts are stripped from clones (static snapshot); CSS/JS-driven layout is captured post-render, so the result still matches visually.
- Output per run: `output/<site>-<timestamp>/` with `index.html`, `page-N.html…`, `assets/`, `clone.json`, `_reference/` (original screenshots).
