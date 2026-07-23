# VibeFox 🦊

**Voice input for vibe coding — Chinese-first, built for Chinese/English code-switching.**

Press a hotkey, speak your prompt (mixing Chinese and English code terms freely), and get cleaned-up, ready-to-send text inserted into your AI chat box in 2–4 seconds. Purpose-built for talking to Claude Code, Cline, Copilot Chat, and the Claude desktop app.

VibeFox is fully open source (AGPL-3.0). Use the hosted backend with a license key, bring your own API keys, or self-host the whole stack.

## Why VibeFox

Generic dictation tools garble code-switched speech like "把 AudioRecorderService 的 retry 逻辑改成 confirm-based". VibeFox is optimized end-to-end for exactly that:

- **Dual-engine quality tier** — Qwen3-ASR (state-of-the-art Chinese/English code-switching, auto language detection) transcribes; Qwen-Plus rewrites (fillers removed, punctuation fixed, self-corrections folded: "用A…不对,用B" keeps only B). Automatic fallback to Whisper + Llama if anything fails.
- **Project-aware accuracy** — the VS Code extension mines identifiers from your workspace and biases both the ASR and the rewrite stage, so `dedupeAgainstSession` comes out spelled and cased correctly.
- **Personal dictionary** — `vibefox.personalDictionary` (or `vocabulary` in the desktop config) takes the top-priority bias slots for the names and jargon your ASR keeps mishearing.
- **Rewrite modes** — `off` (verbatim) / `clean` (default: fillers, punctuation, identifier casing) / `rewrite` (fold self-corrections, light restructuring, spoken enumerations become numbered lists — never changes intent).
- **Streaming mode** (experimental, `vibefox.streamingMode`) — transcribes while you speak and inserts each utterance as it finalizes, with a live preview in the status bar. Falls back to the batch path silently on any failure.
- **Tone adapts to the target app** — the desktop app detects the frontmost app and lets the rewrite stage match it (chat stays casual, email stays composed); coding targets keep the default dictation tuning.
- **Chinese variants** — Simplified (CN / SG-MY) and Traditional (TW / HK-MO) output.
- **Bring your own key** — skip the hosted backend entirely: direct Groq / OpenAI / Alibaba Cloud / custom endpoint support built into the extension.
- **Privacy** — the server logs engine names, timings, and lengths only. Transcript content is never logged or retained, and your local transcription history (last 50 entries, browsable from the command palette or tray menu) never leaves your machine.

## Two frontends, one backend

| | VS Code extension (`client/`) | macOS menu-bar app (`desktop/`) |
|---|---|---|
| Hotkey | `Ctrl+Shift+Space` | `⌘⌥Z` (configurable) |
| Output goes to | AI chat input (Claude Code / Cline / Copilot Chat), editor cursor, terminal, or clipboard | Pasted into any frontmost app (Claude desktop app, browser, Notes…) |
| Project context biasing | ✅ workspace identifier mining | personal dictionary only |
| Target-app tone adaptation | — | ✅ |
| Long dictation | ✅ VAD incremental segmentation (up to 10 min) | ✅ |
| Local history | ✅ command palette | ✅ tray menu |

Both share the same Cloudflare Worker backend, license key, and rewrite settings.

## Quick start

**Prerequisite:** `ffmpeg` on your system (`brew install ffmpeg` / `winget install ffmpeg` / `apt install ffmpeg`). The extension auto-detects it and offers one-click install if missing.

### VS Code extension

1. Install the `.vsix` (Marketplace listing coming soon): `code --install-extension vibefox-*.vsix`
2. Run **VibeFox: Set License Key** (hosted backend) — or set `vibefox.apiProvider` to `groq`/`openai`/`aliyun`/`custom` and use your own key, no license needed.
3. Press `Ctrl+Shift+Space`, speak, press again. Done.

### Desktop app (macOS)

1. Build: `cd desktop && npm install && npm run dist` (or grab a release build).
2. Launch `VibeFox.app`, grant microphone + accessibility permissions when prompted.
3. Press `⌘⌥Z` in any app, speak, press again — the text is pasted at your cursor.

### Self-hosting

Deploy your own Cloudflare Worker backend (free tier works) with your own DashScope keys — see [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## Architecture

```
┌─ client/   VS Code extension (TypeScript, strict MVC+S, zero runtime deps)
├─ desktop/  Electron menu-bar app (reuses client/src/services + models directly)
└─ server/   Cloudflare Worker: auth (KV) → rate limit → ASR → rewrite → response
             Quality tier: Qwen3-ASR + Qwen-Plus (region-aware: SG / US)
             Free tier & fallback chain: Workers AI Whisper + Llama 3.1
```

Audio is captured via system ffmpeg (16 kHz mono 64 kbps MP3), segmented client-side by VAD, sent as base64 over HTTPS. No binaries are bundled.

## Development

```bash
cd client  && npm install && npm run typecheck && npm run compile && npm test
cd server  && npm install && npm run typecheck && npm test   # wrangler dev to run locally
cd desktop && npm install && npm run typecheck && npm run compile
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for layering rules and PR guidelines. Internal design docs under [docs/](docs/) are written in Chinese.

## Known issues

- Intermittent "no speech detected" on audio that clearly contains speech — under investigation, diagnostics built in (`vibefox.diagnosticSaveAudio`). See [docs/handoff.md](docs/handoff.md) §四.
- Windows/Linux capture paths (dshow/pulse) are implemented but untested — reports and PRs welcome (`help wanted`).
- Streaming mode is experimental and Singapore-region only (the international realtime endpoint has no US region), so expect extra round-trip latency from the Americas. It needs a host with a global WebSocket (Node ≥ 22) and a self-hosted backend must set `DASHSCOPE_WORKSPACE_ID`; otherwise clients stay on the batch path.

## License

[AGPL-3.0-only](LICENSE). Commercial hosting of the backend requires releasing your modifications under the same license.
