<p align="right"><a href="README.en.md">English</a> · <b>简体中文</b></p>

# VibeFox 🦊

**为 Vibe Coding 而生的语音输入 —— 中文优先，专治中英混杂。**

按下热键，用中文夹着英文术语把需求说出来，2~4 秒后清理润色好的文字直接落进 AI 聊天框。专为对着 Claude Code、Cline、Copilot Chat 和 Claude 桌面版说话而做。

VibeFox 完全开源（AGPL-3.0）。你可以用官方托管后端配一把 License Key，也可以自带 API Key，或者把整套后端自己部署起来。

## 为什么用 VibeFox

通用听写工具遇到「把 AudioRecorderService 的 retry 逻辑改成 confirm-based」这种话就乱套。VibeFox 从头到尾就是为这件事优化的：

- **双引擎质量档** —— Qwen3-ASR 负责转写（2026 年中英 code-switching 第一梯队，自动检测语种），Qwen-Plus 负责改写（去填充词、修标点、折叠口误自纠：「用 A…不对，用 B」只留 B）。任一环节出问题自动降级到 Whisper + Llama。
- **项目上下文感知** —— VS Code 扩展会扫描你工作区里的标识符，同时偏置 ASR 与改写两个阶段，所以 `dedupeAgainstSession` 这种词能被正确拼写和大小写还原。
- **个人词典** —— `vibefox.personalDictionary`（桌面端是配置里的 `vocabulary`）占据最高优先级的偏置名额，专门收拾那些 ASR 老是听错的人名和术语。
- **改写三档** —— `off`（原样转写）/ `clean`（默认：去填充词、修标点、校正标识符大小写）/ `rewrite`（折叠口误自纠、轻度重组、口述的「第一…第二…」自动排成编号列表 —— 但绝不改变你的意图）。
- **流式转写**（实验性，`vibefox.streamingMode`）—— 边说边转写，每句定稿即插入，状态栏实时显示预览。任何失败都会静默回落到普通模式。
- **语气随目标应用变化** —— 桌面端会识别当前前台应用，让改写阶段跟着调整（聊天软件保持随意，邮件保持得体）；写代码的场景维持默认的口述调校。
- **中文四变体** —— 简体（大陆 / 新马）与繁体（台湾 / 港澳）输出。
- **自带 Key** —— 完全不用官方后端也行：扩展内置了 Groq / OpenAI / 阿里云 / 自定义端点的直连支持。
- **隐私** —— 服务端只记录引擎名、耗时和长度，转写内容从不记录、从不留存；本地转写历史（最近 50 条，命令面板或托盘菜单可查）永远不离开你的机器。

## 两个前端，同一个后端

| | VS Code 扩展（`client/`） | macOS 菜单栏应用（`desktop/`） |
|---|---|---|
| 热键 | `Ctrl+Shift+Space` | `⌘⌥Z`（可配置） |
| 文字去哪 | AI 聊天框（Claude Code / Cline / Copilot Chat）、编辑器光标、终端或剪贴板 | 粘进任何前台应用（Claude 桌面版、浏览器、备忘录…） |
| 项目上下文偏置 | ✅ 扫描工作区标识符 | 仅个人词典 |
| 目标应用语气适配 | — | ✅ |
| 长语音 | ✅ VAD 增量分段（最长 10 分钟） | ✅ |
| 本地历史 | ✅ 命令面板 | ✅ 托盘菜单 |

两端共用同一个 Cloudflare Worker 后端、同一把 License Key、同一套改写档位。

## 快速开始

**前置条件：** 系统装了 `ffmpeg`（`brew install ffmpeg` / `winget install ffmpeg` / `apt install ffmpeg`）。扩展会自动探测，没装的话错误提示里有「一键安装」按钮。

### VS Code 扩展

1. 安装 `.vsix`（Marketplace 上架中）：`code --install-extension vibefox-*.vsix`
2. 运行命令 **VibeFox: Set License Key**（用托管后端）—— 或者把 `vibefox.apiProvider` 改成 `groq`/`openai`/`aliyun`/`custom` 用自己的 Key，不需要 License。
3. 按 `Ctrl+Shift+Space`，说话，再按一次。完事。

### 桌面应用（macOS）

1. 构建：`cd desktop && npm install && npm run dist`（或直接下载 release 版本）。
2. 启动 `VibeFox.app`，按提示授予**麦克风**和**辅助功能**权限。
3. 在任何应用里按 `⌘⌥Z`，说话，再按一次 —— 文字自动粘到光标处。

### 自己部署后端

用自己的 Cloudflare Worker（免费额度够用）和自己的 DashScope Key —— 见 [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)。

## 架构

```
┌─ client/   VS Code 扩展（TypeScript,严格 MVC+S,零运行时依赖）
├─ desktop/  Electron 菜单栏应用（直接复用 client/src/services 与 models）
└─ server/   Cloudflare Worker：鉴权(KV) → 限流 → ASR → 改写 → 响应
             质量档：Qwen3-ASR + Qwen-Plus（区域感知：新加坡 / 美国）
             免费档与降级链：Workers AI Whisper + Llama 3.1
```

音频经系统 ffmpeg 采集（16kHz 单声道 64kbps MP3），客户端按 VAD 分段，以 base64 走 HTTPS 上传。不捆绑任何二进制。

## 开发

```bash
cd client  && npm install && npm run typecheck && npm run compile && npm test
cd server  && npm install && npm run typecheck && npm test   # wrangler dev 本地起服务
cd desktop && npm install && npm run typecheck && npm run compile
```

分层规范与 PR 要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。[docs/](docs/) 下的内部设计文档为中文。

## 已知问题

- 偶发的「未识别到语音」—— 音频里明明有声音却转写为空，根因仍在排查，已内置诊断手段（`vibefox.diagnosticSaveAudio`）。详见 [docs/handoff.md](docs/handoff.md) §四。
- Windows/Linux 的采集路径（dshow/pulse）代码已就位但从未实测 —— 欢迎反馈与 PR（标记为 `help wanted`）。
- 流式转写是实验性功能，且只有新加坡区可用（国际版 realtime 端点没有美国区），美洲用户会多一段往返延迟。它需要运行时带全局 WebSocket（Node ≥ 22），否则客户端会一直走普通模式。

## 许可证

[AGPL-3.0-only](LICENSE)。如果你把后端改造后作为服务对外提供，需要以相同许可证公开你的修改。
