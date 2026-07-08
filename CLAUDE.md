# Vibe-For-Vscode — 开发规范

语音「Vibe Coding」输入的闭源 VS Code 扩展:按 `ctrl+shift+space` 说话(中文优先),经 Cloudflare Worker 调用 Workers AI `@cf/openai/whisper-large-v3-turbo` 转写,结果插入 LLM 聊天输入框(Claude Code / Cline / Copilot Chat)或活动编辑器。技术栈:TypeScript;客户端 = VS Code Extension(esbuild 打包、零运行时依赖);服务端 = Cloudflare Worker(native fetch handler、AI + KV 绑定)。

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

0. **语言分工**:沟通与文档(CLAUDE.md、docs/、commit message)用中文;**代码一律英文,含注释**(`//`、`/** */`)。产品面向终端用户的中文字符串(状态栏文案、错误提示、命令标题)属产品内容不算「代码」,可保留中文。
1. **严格 MVC+S 分层**(详见 docs/02-STANDARDS.md):
   - `client/src/models/` 禁 `vscode.window`/`vscode.commands`(纯数据与状态);
   - `client/src/viewer/` 禁 `fetch(`/`spawn(`/业务判断(只渲染 UI、读 UI、插入文本);
   - `client/src/services/` 禁 UI 调用(只做 I/O:录音进程、HTTPS);
   - 只有 `controllers/` 可以同时触碰 M/V/S。
2. **密钥红线**:License Key 只存 VS Code `SecretStorage`;Worker 端 KV namespace id 进 wrangler.jsonc 但**密钥值一律 `wrangler kv key put` / `wrangler secret put`,绝不进源码与配置**。
3. **转写语言锁 `zh`**(`vibe.language` 可覆盖):显式传 `language` 给 Whisper,绕过自动检测延迟。
4. **录音上限 25s**(`vibe.maxRecordSeconds`):MP3 16kHz 单声道 ~32kbps,payload 远低于 Worker 128MB 内存/30s 执行上限;Worker 端拒收 >8MB base64(413)。
5. **闭源**:LICENSE 为 proprietary;未经要求不发布 marketplace、不提交不推送。
6. **音频采集 = 系统 ffmpeg**(macOS avfoundation / Windows dshow / Linux pulse),未安装时给出平台安装指引,不捆绑二进制(许可证风险)。
7. **Worker 鉴权**:`Authorization: Bearer <LICENSE_KEY>` → `AUTH_KEYS` KV 查存在性;缺头 401,无效 403。

## 全局知识库联动 / MCP ↔ Obsidian
经 .mcp.json 的 `obsidian-vault`(filesystem MCP)连接长期记忆(vault:`/Users/elvisli/Library/Mobile Documents/com~apple~CloudDocs/Obsidian`)。
- [Pull] 设计/排错前先读 Obsidian `Skills/`(本项目重点:`Skills/Cloudflare/Cloudflare-Workers-SaaS-Backend.md`)、`Post-Mortems/`,有现成模板别盲目发挥。
- [Push] 解决普适问题后,完成 03-DOD 自查,主动问用户是否 /push-to-obsidian 脱敏沉淀。
- ⚠️ filesystem MCP 有 roots 覆盖坑(client 把项目目录当 root 发过去,vault 访问报 Access denied):修法见 playbook §5.4 —— 用 `/add-dir` 加 vault,或直接用原生 Read/Write 工具读写 vault(iCloud 路径即本地路径,MCP 非必需)。
