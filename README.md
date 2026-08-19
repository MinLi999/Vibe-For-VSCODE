<p align="right"><a href="README.en.md">English</a> · <b>简体中文</b></p>

### 🌐 官网：[vibefox.app](https://vibefox.app)

# VibeFox 🦊

> ⚠️ **开发中**：项目还处于打包整理阶段，正式版即将上线。不过仓库里的代码现在就是可以构建、运行的完整实现——想抢先体验或参与开发，直接跳到下面「快速开始」。

**Mac 上的 AI 语音输入法 —— 中文优先，专治中英混杂。**

按一下热键（`⌘⌥Z` 或 **Fn 键**）开始说话，中文夹着英文术语随便说，再按一次，2~4 秒后清理润色好的文字就模拟 ⌘V 粘进**当前最前面的应用**——Claude 桌面版、浏览器、备忘录、任何输入框都行。菜单栏常驻，零外部依赖（原生 `AVAudioEngine` 采集，不需要装 ffmpeg）。

VibeFox 完全开源（AGPL-3.0）。你可以用官方托管后端配一把 License Key，也可以自带 API Key，或者把整套后端自己部署起来。

VibeFox 永远免费开源，如果它帮你省下了时间，欢迎 [❤️ 自愿付费支持开发](https://vibefox.app/support)。

## 为什么做这个项目

最早是因为在 VS Code 里用 Claude Code 写代码时，发现语音输入不支持中文，更不用说中英文夹杂着说——于是写了个 VS Code 插件解决自己的问题。

用下来发现插件形态局限很大：只能在 VS Code 一个应用里用。我想要的其实是一个**在任何地方都能用**的语音输入方案，于是转向跨平台方案；但实践下来体验始终不够好，最终改用 Swift 重写成原生 macOS 程序——这才是现在这个仓库的样子。用户可以在里面维护一份很大的自定义词语组合词典，说得越多，识别就越准。

## 为什么用 VibeFox

通用听写工具遇到「把 AudioRecorderService 的 retry 逻辑改成 confirm-based」这种话就乱套。VibeFox 从头到尾就是为这件事优化的：

- **双引擎质量档** —— Qwen3-ASR 负责转写（中英 code-switching 第一梯队，自动检测语种），Qwen-Plus 负责改写（去填充词、修标点、折叠口误自纠：「用 A…不对，用 B」只留 B）。
- **用户词库偏置识别** —— 常被听错的人名、产品名、代码标识符加进词库，识别与改写两个阶段都会用它校正拼写和大小写。
- **改写三档** —— `off`（原样转写）/ `clean`（默认：去填充词、修标点、校正标识符大小写）/ `rewrite`（折叠口误自纠、轻度重组、口述的「第一…第二…」自动排成编号列表 —— 但绝不改变你的意图）。
- **流式转写**（实验性）—— 边说边转写，每句定稿即插入，悬浮 HUD 实时显示预览。失败会静默回落到普通模式。
- **语气随目标应用变化** —— 识别当前前台应用，让改写阶段跟着调整（聊天软件保持随意，邮件保持得体）。
- **中文四变体** —— 简体（大陆 / 新马）与繁体（台湾 / 港澳）输出。
- **自带 Key** —— 内置 Groq / OpenAI / 阿里云 / 自定义端点的直连支持，音频与文本直接发给你自己的 Key，不经过任何中间服务器。
- **隐私** —— 转写内容从不记录、从不留存；本地转写历史（最近 50 条，菜单栏可查）永远不离开你的机器。

## 快速开始

1. 构建：`cd macos && ./scripts/make-app.sh`（需要 Xcode；或直接下载 release 的 `VibeFox.zip`）。
2. 打开 `build/VibeFox.app`，跟随新手引导授予**麦克风**和**辅助功能**权限，选好转写引擎，现场练习一次。
3. 在任何应用里按 `⌘⌥Z`（或在设置中改为 Fn 键），说话，再按一次 —— 文字自动粘到光标处。

### 转写引擎怎么选

新手引导里可以二选一，随时能在设置里切换：

- **官方托管**：填一把 License Key 即用，省心，区域路由和成本护栏都是配好的。
- **自带 API Key（免费）**：设置里选阿里云 / Groq / OpenAI 或自定义端点，粘贴你自己的 Key。音频直接发给你选的服务商，不经过任何中间服务器。

想要托管功能但自己掌控基础设施，也可以自己部署一套 —— 用自己的 Cloudflare Worker（免费额度够用）和自己的 DashScope Key，见 [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)。

## 自定义词汇表（英文技术词老是听错就靠它）

ASR 对中文很稳，但英文专有名词、驼峰标识符、少见缩写经常听错。把它们写进词库，会**同时**用于两个环节：喂给 Qwen3-ASR 做识别偏置，以及在改写阶段校正拼写和大小写。

设置窗口 →「词库」页直接增删词条（存于 `~/Library/Application Support/VibeFox/dictionary.json`）。每次录音只会挑**最近用过 / 命中次数最高**的词参与偏置（见下方上限），不用担心词库大了拖慢识别。

### 上限与配额（重要）

| 限制 | 数值 | 说明 |
|---|---|---|
| 单次偏置词表 | **≤40** | 按最近使用时间与命中次数排序，词库再大也只取最相关的一批 |
| 单条长度 | 64 字符 | 超长的条目被丢弃 |

**选词建议**：普通英文单词（`code`、`project`、`token`）不值得收进词库，ASR 本来就听得对。留给**专有名词**（`Anthropic`、`Supabase`）、**大小写特殊的标识符**（`useEffect`、`PostgreSQL`）和**你的黑话**。

## 架构

```
┌─ macos/   macOS 原生 App（Swift/SwiftUI,AVAudioEngine 采集,零外部依赖）
└─ server/  Cloudflare Worker：鉴权(KV) → 限流 → ASR → 改写 → 响应
            质量档：Qwen3-ASR + Qwen-Plus（区域感知：新加坡 / 美国）
            免费档与降级链：Workers AI Whisper + Llama 3.1
```

原生 App 用 `AVAudioEngine` 采集 16kHz 单声道音频并编码 AAC。按 VAD 分段，以 base64 走 HTTPS 上传，流式模式走 WebSocket。不捆绑任何二进制。

## 开发

```bash
cd macos  && swift build && swift test                      # 原生 App(需 Xcode)
cd server && npm install && npm run typecheck && npm test   # wrangler dev 本地起服务
```

分层规范与 PR 要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 已知问题

- 流式转写是实验性功能，且只有新加坡区可用（国际版 realtime 端点没有美国区），美洲用户会多一段往返延迟。
- 仅支持 macOS（14.0+）。项目此前含一个 VS Code 扩展前端，已停止维护并从仓库移除，专注做好一件事。

## 许可证

© 2026 VibeFox.app · [AGPL-3.0-only](LICENSE)。如果你把后端改造后作为服务对外提供，需要以相同许可证公开你的修改。

VibeFox 永远开源、可自托管。官方托管后端 + License Key 是付费便利服务；软件本身免费，[自愿付费支持](https://vibefox.app/support)让开发持续下去。官网：[vibefox.app](https://vibefox.app)。
