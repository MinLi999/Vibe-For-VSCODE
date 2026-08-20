<p align="right"><b>English</b> · <a href="README.md">简体中文</a></p>

### 🌐 Website: [vibefox.app](https://vibefox.app)

# VibeFox 🦊

> ⚠️ **Under active development**: features are still landing fast. A notarized installer is available at [vibefox.app/download](https://vibefox.app/download) — install once and Sparkle auto-update keeps you current.

**AI voice input for the Mac — Chinese-first, built for Chinese/English code-switching.**

Press a hotkey (`⌘⌥Z` or the **Fn key**), speak your prompt (mixing Chinese and English freely), press again — 2–4 seconds later the cleaned-up text is pasted straight into **whatever app is frontmost**: the Claude desktop app, a browser, Notes, any text field. Lives in the menu bar, zero external dependencies (native `AVAudioEngine` capture, no ffmpeg install needed).

VibeFox is fully open source (AGPL-3.0). Use the hosted backend with a license key, bring your own API keys, or self-host the whole stack — see "Quick start" below.

VibeFox is free forever — if it saves you time, consider [❤️ supporting development](https://vibefox.app/support).

## Why this project exists

It started because dictation inside VS Code with Claude Code didn't support Chinese at all, let alone speech that mixes Chinese and English mid-sentence — so a VS Code extension got built to fix that for myself.

Living with it exposed the real limitation: an extension only works inside one app. What I actually wanted was voice input that works **anywhere**, so the project moved to a cross-platform approach — which, in practice, still wasn't good enough. It ended up rewritten as a native Swift macOS app, which is the shape of this repo today. Users can build up a large custom vocabulary of word combinations inside it, and recognition keeps getting more accurate the more it's used.

## Why VibeFox

Generic dictation tools garble code-switched speech like "把 AudioRecorderService 的 retry 逻辑改成 confirm-based". VibeFox is optimized end-to-end for exactly that:

- **Dual-engine quality tier** — Qwen3-ASR (state-of-the-art Chinese/English code-switching, auto language detection) transcribes; Qwen-Plus rewrites (fillers removed, punctuation fixed, self-corrections folded: "用A…不对,用B" keeps only B).
- **Dictionary-biased recognition** — add names, product names, and identifiers your ASR keeps mishearing to the dictionary; both the recognition and rewrite stages use it to correct spelling and casing.
- **Rewrite modes** — `off` (verbatim) / `clean` (default: fillers, punctuation, identifier casing) / `rewrite` (fold self-corrections, light restructuring, spoken enumerations become numbered lists — never changes intent).
- **Streaming mode** (experimental) — transcribes while you speak and inserts each utterance as it finalizes, with a live preview in the floating HUD. Falls back to the batch path silently on any failure.
- **Tone adapts to the target app** — detects the frontmost app and lets the rewrite stage match it (chat stays casual, email stays composed); the Style tab lets you **force a tone per app**, overriding the inference.
- **A dictionary that grows on its own** — three feedback loops: **fix-it learning** in history (correct a mishearing once and the word joins the dictionary), **Contacts import** (names/orgs in one click, local only), and **homophone correction** (dictionary words auto-fix "right sound, wrong characters" — local, deterministic, free).
- **Phrase templates** — say "insert my email" and get the full address; a spoken trigger can expand into a whole snippet (local deterministic replacement, up to 2000 chars).
- **Chinese variants** — Simplified (CN / SG-MY) and Traditional (TW / HK-MO) output.
- **Bring your own key** — direct Groq / OpenAI / Alibaba Cloud / custom endpoint support built in, sending audio and text straight to your own key with no server in between.
- **Privacy** — transcript content is never logged or retained; your local transcription history (last 50 entries, browsable from the menu bar) never leaves your machine.

## Quick start

1. Download: [vibefox.app/download](https://vibefox.app/download) (notarized — unzip, drag into Applications); or build from source: `cd macos && ./scripts/make-app.sh` (needs Xcode).
2. Open VibeFox, follow the onboarding wizard — microphone + accessibility permissions, pick a transcription engine, a live practice round.
3. Press `⌘⌥Z` in any app (or switch to the Fn key in Settings), speak, press again — the text is pasted at your cursor.

### Choosing a transcription engine

Onboarding offers a choice, switchable anytime in Settings:

- **Hosted** — paste a license key and go. Region routing and cost guardrails are already configured.
- **Bring your own key (free)** — pick Alibaba Cloud / Groq / OpenAI / a custom endpoint in Settings and paste your own key. Audio goes straight to your chosen provider, no server in between.

Want the hosted-style features but control your own infrastructure? Deploy your own Cloudflare Worker (free tier works) with your own DashScope keys — see [docs/SELF_HOSTING.en.md](docs/SELF_HOSTING.en.md).

## Custom vocabulary (the fix for mis-heard English tech terms)

Chinese transcribes reliably, but English proper nouns, camelCase identifiers and
uncommon acronyms often come out wrong. Words you add to the dictionary are used
**twice**: as bias for Qwen3-ASR, and to correct spelling/casing in the rewrite stage.

Settings window → Dictionary tab, add/remove entries directly (stored at
`~/Library/Application Support/VibeFox/dictionary.json`). Each recording only biases
toward your **most recently used / most frequently hit** words (see the cap below), so
a large dictionary never slows recognition down.

### Limits and budget (important)

| Limit | Value | Notes |
|---|---|---|
| Bias slots per request | **≤40** | Ranked by recency and hit count — a large dictionary only contributes its most relevant entries |
| Per-entry length | 64 chars | Longer entries are dropped |

**Choosing words**: ordinary English words (`code`, `project`, `token`) aren't worth a
slot — the ASR already gets those right. Spend the budget on **proper nouns**
(`Anthropic`, `Supabase`), **unusual casing** (`useEffect`, `PostgreSQL`), and your
team's private jargon.

## Architecture

```
┌─ macos/   Native macOS app (Swift/SwiftUI, AVAudioEngine capture, zero external deps)
└─ server/  Cloudflare Worker: auth (KV) → rate limit → ASR → rewrite → response
            Quality tier: Qwen3-ASR + Qwen-Plus (region-aware: SG / US)
            Free tier & fallback chain: Workers AI Whisper + Llama 3.1
```

The native app captures 16 kHz mono audio via AVAudioEngine and encodes AAC. Clients segment by VAD and upload base64 over HTTPS; streaming mode uses a WebSocket. No binaries are bundled.

## Development

```bash
cd macos  && swift build && swift test                      # native app (needs Xcode)
cd server && npm install && npm run typecheck && npm test   # wrangler dev to run locally
```

See [CONTRIBUTING.en.md](CONTRIBUTING.en.md) for layering rules and PR guidelines.

## Known issues

- Streaming mode is experimental and Singapore-region only (the international realtime endpoint has no US region), so expect extra round-trip latency from the Americas.
- macOS only (14.0+). The project previously included a VS Code extension frontend; it has been retired and removed from the repo to focus on doing one thing well.

## License

© 2026 VibeFox.app · [AGPL-3.0-only](LICENSE). Commercial hosting of the backend requires releasing your modifications under the same license.

VibeFox is open source and self-hostable forever. The hosted backend + license keys are a paid convenience; the software itself is free — [voluntary support](https://vibefox.app/support) keeps development going. Website: [vibefox.app](https://vibefox.app).
