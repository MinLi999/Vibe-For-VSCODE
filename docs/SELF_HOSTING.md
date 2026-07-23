# Self-Hosting Guide

Run the entire VibeFox backend on your own Cloudflare account. The free Workers plan is enough for personal use (the free-tier engines run on Workers AI; the quality tier needs your own Alibaba Cloud DashScope keys).

## Prerequisites

- A Cloudflare account and `wrangler` CLI (Node.js ≥ 22)
- Optional, for the quality tier: [Alibaba Cloud Model Studio (international)](https://www.alibabacloud.com/en/product/modelstudio) API keys. DashScope keys are **region-isolated** — you need one key per region you want to serve:
  - Singapore region key → serves APAC users
  - US (Virginia) region key → serves everyone else (note: the US region has no free quota)

Without DashScope keys the Worker still works: every request falls back to the free chain (Workers AI Whisper + Llama).

## Deploy the Worker

```bash
cd server
npm install

# 1. Create the license-key KV namespace and paste its id into wrangler.jsonc
npx wrangler kv namespace create AUTH_KEYS

# 2. (Quality tier only) set the DashScope secrets — never put key values in files
npx wrangler secret put DASHSCOPE_API_KEY_APAC
npx wrangler secret put DASHSCOPE_API_KEY_US

# 3. Deploy
npx wrangler deploy
```

The deploy output prints your Worker URL, e.g. `https://vibe-voice-worker.<account>.workers.dev`.

## Issue license keys

Auth is a simple existence check against KV. Issue keys yourself:

```bash
# Free tier (Whisper + Llama)
npx wrangler kv key put --binding AUTH_KEYS "some-key-you-generate" '{"owner":"me"}' --remote

# Quality tier (Qwen3-ASR + Qwen-Plus)
npx wrangler kv key put --binding AUTH_KEYS "some-pro-key" '{"owner":"me","plan":"pro"}' --remote
```

Revoke with `wrangler kv key delete`. Rate limits are per key: free 10 req/min, pro 40 req/min (see `unsafe.bindings` in `wrangler.jsonc`).

## Point the clients at your Worker

- **VS Code extension:** set `vibefox.endpoint` to your Worker URL (no trailing slash), then run **VibeFox: Set License Key** with a key you issued.
- **Desktop app:** edit `~/Library/Application Support/VibeFox/config.json` → `"endpoint": "https://your-worker.workers.dev"`, then set the license key from the tray menu.

## Local development

```bash
cd server
cp .dev.vars.example .dev.vars   # fill in keys, or leave empty to test the free chain
npx wrangler kv key put --binding AUTH_KEYS "dev-test-key" '{"owner":"local"}' --local
npx wrangler dev
```

Smoke test: no auth header → 401, unknown key → 403, wrong path → 404.

## No server at all (BYOK)

If you don't want to run a Worker, set `vibefox.apiProvider` to `groq`, `openai`, `aliyun`, or `custom` in the extension — transcription and rewrite then run directly against that provider with your own API key.
