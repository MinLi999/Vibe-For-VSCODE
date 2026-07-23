# Vibe-For-Vscode — 开发规范

语音「Vibe Coding」输入的**开源产品(AGPL-3.0,2026-07-23 起全仓开源)**:说话(中文优先、中英混杂)经 Cloudflare Worker 处理 —— 质量档(license `plan:"pro"`)全程走**阿里云 DashScope**:Qwen3-ASR(区域感知路由,可手动指定区域)转写 + **Qwen-Plus 改写**;免费档/降级链 = Workers AI `@cf/openai/whisper-large-v3-turbo` + llama-3.1-8b;支持中文繁简四变体输出(大陆/新马简体,台湾/港澳繁体)。

**两个前端,共用同一个 Worker 后端 / License Key / 改写档位**:
- **VS Code 扩展**(`client/`,`ctrl+shift+space`):结果插入 LLM 聊天输入框(Claude Code / Cline / Copilot Chat)或活动编辑器。
- **桌面 App**(`desktop/`,`⌘⌥Z`,2026-07-18 新增):Electron 菜单栏应用,转写结果模拟 ⌘V 粘进任何前台应用(首要场景 = Claude 桌面 App),即「系统级语音输入法」。

技术栈:TypeScript;`client` = VS Code Extension(esbuild、零运行时依赖、严格 MVC+S);`desktop` = Electron(esbuild,复用 `client/src/services/` 的录音+API 服务,electron-builder 打包为 `VibeFox.app`、以 Developer ID 证书签名);服务端 = Cloudflare Worker(native fetch handler、AI + KV 绑定 + DashScope secrets)。

## AI 上下文路由 / Context Routing
> 按任务类型读对应文档,别一次吞下全部。CLAUDE.md 只放*事实与红线*。

| 任务 | 读 |
|---|---|
| 新需求/业务变更 | 先读并更新 docs/01-PRD.md |
| 写代码/设计架构 | docs/02-STANDARDS.md |
| 交付/提交前 | docs/03-DOD.md 或 /dod |
| 当前进度 | 开场读 docs/STATE.md,DoD 通过后回写 |

**Skills**:/dod、/deploy(仅手动)、/push-to-obsidian。

## 项目硬规则(事实与红线)

0. **语言分工**:沟通与内部文档(CLAUDE.md、docs/)用中文;**代码一律英文,含注释**(`//`、`/** */`);**commit message 与对外文档(README 等)用英文**(2026-07-23 开源后用户指定,替代原中文 commit 惯例)。产品面向终端用户的中文字符串(状态栏文案、错误提示、命令标题)属产品内容不算「代码」,可保留中文。
1. **严格 MVC+S 分层**(详见 docs/02-STANDARDS.md):
   - `client/src/models/` 禁 `vscode.window`/`vscode.commands`(纯数据与状态);
   - `client/src/viewer/` 禁 `fetch(`/`spawn(`/业务判断(只渲染 UI、读 UI、插入文本);
   - `client/src/services/` 禁 UI 调用(只做 I/O:录音进程、HTTPS);
   - 只有 `controllers/` 可以同时触碰 M/V/S。
2. **密钥红线**:License Key 只存 VS Code `SecretStorage`;Worker 端 KV namespace id 进 wrangler.jsonc 但**密钥值一律 `wrangler kv key put` / `wrangler secret put`(含 DASHSCOPE_API_KEY / ANTHROPIC_API_KEY),绝不进源码与配置**。**改写提示词与模型 id 服务端所有**,协议 v2 不接受客户端传 prompt/model(防计费滥用)。
3. **转写语言默认 `auto`**(`vibefox.language` 可覆盖为 ISO-639-1 强制单语):质量档 Qwen3-ASR **不指定 language、自动检测**——阿里官方文档对中英混杂音频明确建议勿指定该参数,锁 `zh` 会把英文词往中文发音上偏(2026-07-19 核实并修正);Whisper 兜底路径仍显式锁 `zh` + `temperature:0`(绕过其检测延迟)。Qwen ASR 端 context 偏置**只传纯实体词表**(keywords ≤40,禁 free-form 文本/projectContext),服务端 `isContextEcho` guard 拦截词表复读降级 Whisper(2026-07-12 提示词泄露事故的回归防线)。
4. **录音默认 25s / 上限 600s**(`vibefox.maxRecordSeconds`):MP3 16kHz 单声道 64kbps;Worker 端拒收 base64:免费档 >4MB、质量档 >8MB(413);按 key 限流 free 10 次/分、pro 40 次/分(429)。
4b. **改写默认开**:`vibefox.rewriteMode` 默认 `clean`(off/clean/rewrite 三档);`llmCorrection*` 为已废弃 legacy 设置(首启自动迁移);`vibe.*` 为 legacy 配置命名空间回落。
5. **开源(2026-07-23 起,替代原闭源红线)**:全仓(client/server/desktop)以 **AGPL-3.0-only** 开源;商业模式 = open core——代码可自托管(自部署 Worker + 自备 DashScope key,或 BYOK 直连 provider),官方托管 Worker + License Key 发放是付费便利服务。**对外文档双语**:目标用户以中文开发者为主,故 `README.md`/`CONTRIBUTING.md`/`docs/SELF_HOSTING.md` 为中文主版本,`*.en.md` 为英文版,两版顶部互链、**改动必须同步两份**;issue 模板双语。内部文档(docs/ 其余、CLAUDE.md)仍中文,**commit message 用英文**。未经要求不发布 marketplace、不提交不推送的纪律不变。
6. **音频采集 = 系统 ffmpeg**(macOS avfoundation / Windows dshow / Linux pulse),**不捆绑二进制**(许可证风险)、不走 webview 录音(VS Code 对 webview 麦克风限制不可靠,微软官方语音扩展也是原生模块方案)。**装机负担最小化**:三级探测(`vibefox.ffmpegPath` → PATH → 各平台常见安装路径,含 Homebrew 的 `/opt/homebrew/bin`,规避 GUI 启动 PATH 缺失坑);未装时错误提示带「一键安装」按钮(内置终端自动执行 brew/winget/apt 命令)。
7. **Worker 鉴权**:`Authorization: Bearer <LICENSE_KEY>` → `AUTH_KEYS` KV 查存在性;缺头 401,无效 403。

## 全局知识库联动 / MCP ↔ Obsidian
经 .mcp.json 的 `obsidian-vault`(filesystem MCP)连接长期记忆(vault:`/Users/elvisli/Library/Mobile Documents/com~apple~CloudDocs/Obsidian`)。
- [Pull] 设计/排错前先读 Obsidian `Skills/`(本项目重点:`Skills/Cloudflare/Cloudflare-Workers-SaaS-Backend.md`)、`Post-Mortems/`,有现成模板别盲目发挥。
- [Push] 解决普适问题后,完成 03-DOD 自查,主动问用户是否 /push-to-obsidian 脱敏沉淀。
- ⚠️ filesystem MCP 有 roots 覆盖坑(client 把项目目录当 root 发过去,vault 访问报 Access denied):修法见 playbook §5.4 —— 用 `/add-dir` 加 vault,或直接用原生 Read/Write 工具读写 vault(iCloud 路径即本地路径,MCP 非必需)。
