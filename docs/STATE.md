# STATE.md —— 进度状态机
> ⚠️ 每次 DoD 通过后用主管视角更新;相对日期转绝对日期。

## 当前阶段 / 健康度
**阶段**:全量代码生成完毕,本地验证通过(2026-07-07)。
**健康度**:🟢 双端构建绿;端到端转写在本地 wrangler dev(代理真实 Workers AI)已打通。

## 最近完成
- 2026-07-07:git init、目录骨架、CLAUDE.md、.mcp.json、docs 四件套、skills 三件套。
- 2026-07-07:server 全量(wrangler.jsonc + index/auth/transcribe/types)。typecheck ✅。
- 2026-07-07:client 全量(manifest + esbuild + MVC+S 八文件)。typecheck + compile ✅(dist/extension.js 30KB)。
- 2026-07-07:DoD 分层纯洁度 grep 全绿;wrangler dev 冒烟:401/403/400/404/405/413 全部符合契约。
- 2026-07-07:端到端实测(macOS `say` 合成中文 → ffmpeg 16kHz mono 32kbps MP3 → 本地 Worker → 真实 Workers AI):200,1153ms,**keywords 注入生效**(「AudioState」逐字保留未被音译)。
- 依赖版本实况:wrangler 4.108.0、@cloudflare/workers-types 5.x(v4 已不兼容)、本机 ffmpeg 8.1。

## 下一步
1. (用户)`cd server && npx wrangler kv namespace create AUTH_KEYS` → 把 id 填进 wrangler.jsonc → /deploy。
2. (用户)`npx wrangler kv key put --binding AUTH_KEYS "<key>" '{"owner":"..."}' --remote` 发首个 License Key。
3. (用户)VS Code 里 F5 起 Extension Development Host,填 `vibe.endpoint`,实测麦克风链路(需系统麦克风权限)。
4. 可选:/push-to-obsidian 沉淀「Whisper initial_prompt 代码词汇偏置」与「ffmpeg 平台录音参数」两个可复用模式。

## 阻塞
- 无硬阻塞。Windows/Linux 录音路径(dshow/pulse)代码就位但本机(macOS)无法实测。
