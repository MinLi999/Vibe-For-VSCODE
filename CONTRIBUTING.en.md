<p align="right"><b>English</b> · <a href="CONTRIBUTING.md">简体中文</a></p>

# Contributing to VibeFox

Thanks for helping! A few ground rules keep this codebase easy to reason about.

## Project layout

- `macos/` — native SwiftUI app (Swift Package Manager), the `VibeFoxCore` library + `VibeFox` app.
- `server/` — Cloudflare Worker. Native fetch handler; engines under `src/engines/`.
- `shared/fixtures/` — cross-implementation contract test data (JSON) shared by server and macos, so the same logic (e.g. nonspeech filtering) can't quietly drift apart between the two.

## Hard rules

1. **Code and comments in English.** User-facing product strings may be Chinese. Every `.md` file in the repo other than this one, `README.md`/`README.en.md`, and `docs/SELF_HOSTING.md`/`.en.md` is the author's private working notes and isn't version-controlled.
2. **No secrets anywhere in the repo** — keys go through `wrangler secret put` / `wrangler kv key put`, license keys live in the macOS Keychain. Rewrite prompts and model ids are server-owned; the API never accepts client-supplied prompts or model names.
3. **Never log transcript content** server-side — engine names, timings, lengths, and reason codes only.
4. **No bundled binaries** (third-party licensing risk).

## Before you open a PR

```bash
cd server && npm run typecheck && npm test
cd macos  && swift build && swift test
```

CI runs exactly this. Add tests for pure logic you touch (server: vitest, see `server/src/nonspeech.test.ts` for the style; macos: Swift Testing).

## Good first contributions

- Reproductions or fixes for issues labeled `help wanted`.

## Commit style

Conventional-commit prefixes (`feat:`, `fix:`, `docs:`…). **Write commit messages in English** so the history stays readable for every contributor.
