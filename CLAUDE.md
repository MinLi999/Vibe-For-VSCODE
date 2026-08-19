# VibeFox — 开发规范

Mac 上的 AI 语音输入法(**开源产品,AGPL-3.0,2026-07-23 起全仓开源**):按热键说话(中文优先、中英混杂)经 Cloudflare Worker 处理 —— 质量档(license `plan:"pro"`)全程走**阿里云 DashScope**:Qwen3-ASR(区域感知路由,可手动指定区域)转写 + **Qwen-Plus 改写**;免费档/降级链 = Workers AI `@cf/openai/whisper-large-v3-turbo` + llama-3.1-8b;支持中文繁简四变体输出(大陆/新马简体,台湾/港澳繁体)。

**单一前端**(`macos/`,`⌘⌥Z` 或 Fn,纯原生 SwiftUI):菜单栏常驻,转写结果模拟 ⌘V 粘进任何前台应用(首要场景 = Claude 桌面 App),即「系统级语音输入法」。**2026-08-19 起 VS Code 扩展(`client/`)已停止维护并从仓库移除**(早前 Electron 版 `desktop/` 已于 2026-08-13 退役删除)——不再做多前端,专注把 macOS 原生 App 做好。旧 `vibefox.*` VS Code 设置命名空间已随之作废,现在配置一律是 `config.json` 里的裸字段(`language`/`maxRecordSeconds`/`rewriteMode` 等,无前缀)。

技术栈:`macos` = 原生 SwiftUI(SPM,VibeFoxCore 库 + VibeFox App,AVAudioEngine 采集、`scripts/make-app.sh` 签名打包为 `VibeFox.app`、以 Developer ID 证书签名 + Sparkle 自动更新);服务端 = Cloudflare Worker(TypeScript,native fetch handler、AI + KV 绑定 + DashScope secrets)。

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

0. **语言分工**:沟通用中文;**代码一律英文,含注释**(`//`、`/** */`);**commit message 与对外文档(README/CONTRIBUTING/SELF_HOSTING)用英文**(2026-07-23 开源后用户指定,替代原中文 commit 惯例)。产品面向终端用户的中文字符串(菜单栏文案、错误提示)属产品内容不算「代码」,可保留中文。**Commit 作者与署名只用用户本人的 git 身份(`Min Li <presley.us@gmail.com>`)——commit message 里绝不加 `Co-Authored-By: Claude ...` 或任何 AI 署名行**(2026-08-13 用户明确要求:GitHub 贡献者列表只能显示他自己;实际 git author 从未变过是 `Min Li`,问题出在 message 正文里的这行被 GitHub 解析成"共同作者"——此前 84 个历史 commit 带了这行,已用 `git filter-repo` rewrite + force-push 清除)。**CLAUDE.md 与 `docs/` 下除 `SELF_HOSTING.md`/`.en.md` 外的所有文档不进版本控制**(2026-08-19 起,见规则 4)——这些文件仍在本地磁盘上,继续正常读写维护,只是不再 `git add`。
1. **密钥红线**:License Key 只存 macOS 钥匙串;Worker 端 KV namespace id 进 wrangler.jsonc 但**密钥值一律 `wrangler kv key put` / `wrangler secret put`(含 DASHSCOPE_API_KEY),绝不进源码与配置**。**改写提示词与模型 id 服务端所有**,协议不接受客户端传 prompt/model(防计费滥用)。
2. **转写语言默认 `auto`**(`config.language` 可覆盖为 ISO-639-1 强制单语):质量档 Qwen3-ASR **不指定 language、自动检测**——阿里官方文档对中英混杂音频明确建议勿指定该参数,锁 `zh` 会把英文词往中文发音上偏;Whisper 兜底路径仍显式锁 `zh` + `temperature:0`(绕过其检测延迟)。Qwen ASR 端 context 偏置**只传纯实体词表**(keywords ≤40,禁 free-form 文本),服务端 `isContextEcho` guard 拦截词表复读降级 Whisper(2026-07-12 提示词泄露事故的回归防线)。
3. **录音默认 25s / 上限 600s**(`config.maxRecordSeconds`):AAC 16kHz 单声道;Worker 端拒收 base64:免费档 >4MB、质量档 >8MB(413);按 key 限流 free 10 次/分、pro 40 次/分(429)。
3b. **改写默认开**:`config.rewriteMode` 默认 `clean`(off/clean/rewrite 三档)。
4. **开源(2026-07-23 起,替代原闭源红线)**:全仓(macos/server)以 **AGPL-3.0-only** 开源;商业模式 = open core——代码可自托管(自部署 Worker + 自备 DashScope key,或 BYOK 直连 provider),官方托管 Worker + License Key 发放是付费便利服务(此模式是否继续对外提供尚在评估,见 docs/STATE.md)。**对外文档双语**:目标用户以中文开发者为主,故 `README.md`/`CONTRIBUTING.md`/`docs/SELF_HOSTING.md` 为中文主版本,`*.en.md` 为英文版,两版顶部互链、**改动必须同步两份**;issue 模板双语。**2026-08-19 起,除上述对外文档外,仓库里其余 `.md` 文件(含 CLAUDE.md 与 docs/ 下其余全部)不进版本控制**(用户明确要求:担心策略笔记、成本模型等内部内容被公开检索到)——本地照常维护,`.gitignore` 已加;更早已推送的历史版本用 `git filter-repo` 从整个仓库历史彻底清除并 force-push(同批操作,过程见 docs/STATE.md)。未经要求不发布 marketplace、不提交不推送的纪律不变。
5. **Worker 鉴权**:`Authorization: Bearer <LICENSE_KEY>` → `AUTH_KEYS` KV 查存在性;缺头 401,无效 403。

## 全局知识库联动 / MCP ↔ Obsidian
经 .mcp.json 的 `obsidian-vault`(filesystem MCP)连接长期记忆(vault:`/Users/elvisli/Library/Mobile Documents/com~apple~CloudDocs/Obsidian`)。
- [Pull] 设计/排错前先读 Obsidian `Skills/`(本项目重点:`Skills/Cloudflare/Cloudflare-Workers-SaaS-Backend.md`)、`Post-Mortems/`,有现成模板别盲目发挥。
- [Push] 解决普适问题后,完成 03-DOD 自查,主动问用户是否 /push-to-obsidian 脱敏沉淀。
- ⚠️ filesystem MCP 有 roots 覆盖坑(client 把项目目录当 root 发过去,vault 访问报 Access denied):修法见 playbook §5.4 —— 用 `/add-dir` 加 vault,或直接用原生 Read/Write 工具读写 vault(iCloud 路径即本地路径,MCP 非必需)。
