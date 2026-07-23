#!/usr/bin/env node
/**
 * Live smoke test for the /api/realtime streaming proxy (docs/04-STREAMING.md M1).
 *
 * Replays a local PCM file against a deployed Worker at real-time pace and prints the
 * event sequence with timings — verifies auth, the session handshake, partial/segment
 * flow, rewrite orchestration, and end-of-session flush.
 *
 * Prereqs: Node >= 22 (global WebSocket); the Worker deployed with DASHSCOPE_WORKSPACE_ID
 * and DASHSCOPE_API_KEY_APAC secrets; a pro license key.
 *
 * Make a test file (5s of mic audio, PCM16/16k mono):
 *   ffmpeg -f avfoundation -i :default -t 5 -ac 1 -ar 16000 -f s16le sample.pcm
 *
 * Run:
 *   node scripts/realtime-smoke.mjs https://<worker>.workers.dev <LICENSE_KEY> sample.pcm
 */

import { readFileSync } from 'node:fs';

const [workerUrl, licenseKey, pcmPath] = process.argv.slice(2);
if (!workerUrl || !licenseKey || !pcmPath) {
  console.error('usage: node scripts/realtime-smoke.mjs <worker-url> <license-key> <pcm-file>');
  process.exit(1);
}
if (typeof WebSocket !== 'function') {
  console.error('This script needs Node >= 22 (global WebSocket).');
  process.exit(1);
}

const pcm = readFileSync(pcmPath);
const CHUNK_BYTES = 3200; // ~0.1s of PCM16/16k mono — the upstream-recommended pace.
const url = `${workerUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/api/realtime`;

const t0 = Date.now();
const stamp = () => `[+${String(Date.now() - t0).padStart(5, ' ')}ms]`;
let finishSentAt = 0;
let segments = 0;

console.log(`${stamp()} connecting ${url} (audio: ${(pcm.byteLength / 32000).toFixed(1)}s)`);
const ws = new WebSocket(url, ['vibefox.v1', licenseKey]);
ws.binaryType = 'arraybuffer';

ws.addEventListener('open', () => {
  console.log(`${stamp()} open — sending start frame`);
  ws.send(JSON.stringify({ type: 'start', rewriteMode: 'clean', keywords: [], language: 'auto', vadSilenceMs: 800 }));

  let offset = 0;
  const pump = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      clearInterval(pump);
      return;
    }
    if (offset >= pcm.byteLength) {
      clearInterval(pump);
      finishSentAt = Date.now();
      console.log(`${stamp()} audio fully sent — sending finish`);
      ws.send(JSON.stringify({ type: 'finish' }));
      return;
    }
    ws.send(pcm.subarray(offset, offset + CHUNK_BYTES));
    offset += CHUNK_BYTES;
  }, 100);
});

ws.addEventListener('message', (evt) => {
  if (typeof evt.data !== 'string') return;
  const msg = JSON.parse(evt.data);
  switch (msg.type) {
    case 'ready':
      console.log(`${stamp()} ready`);
      break;
    case 'partial':
      console.log(`${stamp()} partial: ${msg.text}`);
      break;
    case 'segment':
      segments++;
      console.log(`${stamp()} SEGMENT #${segments} (rewrite=${msg.rewriteEngine})`);
      console.log(`          raw:   ${msg.rawText}`);
      console.log(`          final: ${msg.finalText}`);
      break;
    case 'done':
      console.log(`${stamp()} done — ${segments} segment(s); flush latency after finish: ${Date.now() - finishSentAt}ms`);
      ws.close(1000);
      break;
    case 'error':
      console.error(`${stamp()} SERVER ERROR: ${msg.message}`);
      process.exitCode = 1;
      break;
    default:
      console.log(`${stamp()} (unknown event) ${evt.data}`);
  }
});

ws.addEventListener('close', (evt) => {
  console.log(`${stamp()} closed (code ${evt.code})`);
  process.exit(process.exitCode ?? (segments > 0 ? 0 : 1));
});
ws.addEventListener('error', () => {
  console.error(`${stamp()} connection error (check the URL, license key plan, and Worker secrets)`);
  process.exitCode = 1;
});
