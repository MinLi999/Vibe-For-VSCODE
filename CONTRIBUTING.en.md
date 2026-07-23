<p align="right"><b>English</b> · <a href="CONTRIBUTING.md">简体中文</a></p>

# Contributing to VibeFox

Thanks for helping! A few ground rules keep this codebase easy to reason about.

## Project layout

- `client/` — VS Code extension. **Strict MVC+S layering** (enforced by review):
  - `models/` — pure data/state. No `vscode.window` / `vscode.commands`.
  - `viewer/` — UI rendering/reading only. No `fetch(`, no `spawn(`, no business logic.
  - `services/` — I/O only (recording process, HTTPS). No UI calls, **no `vscode` imports in services reused by desktop** (`AudioRecorderService`, `CloudflareApiService`, `SystemPasteService`).
  - `controllers/` — the only layer allowed to touch M/V/S together.
- `server/` — Cloudflare Worker. Native fetch handler; engines under `src/engines/`.
- `desktop/` — Electron menu-bar app. Imports `client/src/services` and `client/src/models` directly — keep those vscode-free.

## Hard rules

1. **Code and comments in English.** User-facing product strings may be Chinese. Internal design docs (`docs/`) are Chinese; user-facing docs are bilingual.
2. **No secrets anywhere in the repo** — keys go through `wrangler secret put` / `wrangler kv key put`, license keys live in VS Code SecretStorage / macOS Keychain. Rewrite prompts and model ids are server-owned; the API never accepts client-supplied prompts or model names.
3. **Never log transcript content** server-side — engine names, timings, lengths, and reason codes only.
4. **No bundled binaries** (ffmpeg/sox licensing) and no webview recording (VS Code webview mic permissions are unreliable).

## Before you open a PR

```bash
cd client  && npm run typecheck && npm run compile && npm test
cd server  && npm run typecheck && npm test
cd desktop && npm run typecheck && npm run compile
```

CI runs exactly this. Add tests for pure logic you touch (vitest; see `server/src/nonspeech.test.ts` and `client/src/models/TranscriptDedupe.test.ts` for the style).

## Good first contributions

- Windows/Linux testing of the capture paths (dshow/pulse) — implemented, never verified on real machines.
- Reproductions or fixes for issues labeled `help wanted`.

## Commit style

Conventional-commit prefixes (`feat:`, `fix:`, `docs:`…). **Write commit messages in English** so the history stays readable for every contributor.
