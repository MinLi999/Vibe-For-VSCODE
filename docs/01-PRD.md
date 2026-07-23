# 需求分析与业务范围(动态契约)
> ⚠️ AI 协议:新需求先更新本文档(业务语言 + MVC+S 分层影响面),用户确认后才编码。

## 1. 业务目标

为使用 LLM 聊天扩展(Claude Code、Cline、Copilot Chat)的开发者提供**语音输入**:按下热键说需求(中文优先,中英混杂夹带代码词汇),松手后 2~4 秒内把**清理/润色后的**转写文本插入聊天框/光标处/终端/剪贴板。核心卖点(对标 Wispr Flow / Aqua Voice,差异化=中英混杂编程口述唯一深度优化):
- **双引擎质量档**:订阅链路 = **Qwen3-ASR**(2026 中英 code-switching SOTA 梯队,语言自动检测 + 实体词表 context 偏置,带复读 guard)+ **Qwen-Plus** 改写(去填充词/口误自纠折叠/标识符保真,项目背景在此阶段介入);免费档 = CF Whisper + llama,自动降级兜底。
- **项目级上下文**:两级载荷 —— 排序词表(40,喂给 Qwen3-ASR 的 system-message 实体词表偏置 + Whisper 的 initial_prompt 偏置 + 改写阶段的标识符校正)+ 自由文本 projectContext(≤2000 字符,当前文件符号/工作区高频标识符/相关文件,保留原始大小写,**只喂给改写阶段**辅助理解术语,绝不进 ASR)。
- **改写三档**:`rewriteMode` = off / clean(默认,去填充词修标点校标识符)/ rewrite(折叠"用A…不对,用B"式口误自纠、轻度重组,不改意图)。
- **低延迟**:语言默认 `auto`(Qwen3-ASR 自动检测,官方对混合语种的推荐;Whisper 兜底仍锁 `zh` 绕过其检测延迟);区域感知路由(亚太→DashScope 新加坡,其余→美国区);短文本跳过改写;质量档端到端 2.2~4.0s。
- **商业化就绪**:License Key 鉴权(Cloudflare KV,`plan:"pro"` 元数据路由质量档),按 key 限流;**2026-07-23 起转为开源 open core 模式**(见 §4)。

## 2. 功能矩阵(当前生效)

### 模块 A:录音与热键
- 业务逻辑:`ctrl+shift+space` 切换录音;再按停止并转写;`vibefox.cancelRecording` 丢弃;`maxRecordSeconds` 自动停止(默认 25s,上限 600s)。
- 采集方式:**系统 ffmpeg**(macOS avfoundation / Windows dshow / Linux pulse → 16kHz 单声道 64kbps MP3;VAD 模式走 s16le PCM 流客户端切分)。webview 录音方案已评估并否决:VS Code 对 webview 麦克风权限限制不可靠(微软官方 VS Code Speech 扩展亦采用原生模块而非 webview)。
- **VAD 增量转写**:客户端按静音切分长录音,分段即时转写插入;静音阈值默认**自适应**(噪声底自校准,`vadAdaptiveThreshold`),结尾段不做振幅丢弃(空文本由 ASR 判定后静默跳过);会话级只弹一次统计反馈(字数/段数/引擎/耗时),段级错误累积汇总为一条。
- **装机负担最小化**(本模块的产品要求):
  1. 三级自动探测:`vibefox.ffmpegPath`(手动指定)→ PATH → 各平台常见安装路径(macOS `/opt/homebrew/bin`、`/usr/local/bin`;Windows winget/choco/scoop 默认位置;Linux `/usr/bin`、`/snap/bin`)。已装用户零操作直接可用(规避 VS Code GUI 启动时 PATH 不含 Homebrew 的坑)。
  2. 未找到时错误提示带「一键安装」按钮:自动打开内置终端并执行平台命令(brew / winget / apt),装完再按热键即用;另提供「手动指定路径」按钮直达设置项。
- 分层影响面:
  - View:`StatusBarViewer`(麦克风图标→波形动画→转写 spinner)
  - Controller:`VibeController`(toggle 状态编排、超时自停、ffmpeg 缺失时的一键安装引导)
  - Service:`AudioRecorderService`(三级探测、ffmpeg 进程、平台参数、MP3 流)
  - Model:`AudioState`(状态机 + Buffer + Base64)

### 模块 B:上下文两级载荷
- 业务逻辑:每**录音会话**构建一次(VAD 分段复用,不重复扫描):
  1. `keywords[]`(≤40,排序:活动文档 top20 → 工作区全局 top15 → 其他标签页 → 文件名词干)——供 Whisper 兜底路径的 `initial_prompt` 偏置(800 字节预算);
  2. `projectContext`(≤2000 字符自由文本:项目名/当前文件+语言/当前文件符号 top30/工作区高频标识符 top100/相关文件,保留原始大小写)——**不发给 ASR**(2026-07-19 复核官方文档:同步接口的"定制化识别"支持的是**实体词表/背景文本**,不支持指令式自由文本;早期把这段 free-form 文本塞进 system 消息曾被模型当成转写内容读出来),只喂给改写阶段的用户消息,辅助 Qwen-Plus 理解项目术语并校正标识符拼写。`keywords` 词表则**同时**以纯实体列表形式作为 Qwen3-ASR 的 system-message context 偏置(服务端 `isContextEcho` guard:输出与词表高度重合即判定复读、降级 Whisper)。
- 工作区全局词频:`WorkspaceContextService` 后台扫描 ≤300 个源码文件(>256KB 跳过),保存/删除增量更新。
- **个人词典**(2026-07-23):`vibefox.personalDictionary`(字符串数组,默认空)——用户手工维护的人名/产品名/团队术语,以**最高优先级**进入 keywords 词表(排在活动文档挖掘之前,大小写以词典拼写为准);`contextHint` 关闭时词典仍然生效。桌面端等价物 = config.json 的 `vocabulary`(既有)。
- 分层影响面:
  - View:`EditorContextViewer`(只读文本快照 + activeFilePath/languageId/workspaceName,零业务)
  - Model:`VocabularyModel.buildPayload`(regex/词频/停用词/两级载荷拼装,按文档版本缓存)
  - Service:`WorkspaceContextService`(后台扫描 I/O)
  - Controller:会话开始时构建并缓存(`sessionContext`)

### 模块 C:云端转写(协议 v2,双引擎)
- 业务逻辑:POST `/api/transcribe`,Bearer License Key → KV 校验(`plan:"pro"` → 质量档)→ 按 key 限流(free 10 次/分,pro 40 次/分,429)。
- 请求:`{ audio, language?, keywords?, projectContext?, previousTranscript?, rewriteMode, enginePreference? }`;响应:`{ text, duration_ms /*v1兼容*/, rawText, finalText, tier, engines, timings, fallback? }`。v1 请求(`llmCorrect`)兼容,`llmPrompt`/`llmModel` 一律忽略(模型与提示词服务端所有,防计费滥用)。
- 引擎路由:质量档 = Qwen3-ASR(区域感知:亚太→新加坡区/其余→美国区,支持 `vibefox.dashscopeRegion` 手动指定,6s 超时)→失败降级 CF Whisper(temperature:0);改写 = **Qwen-Plus(唯一质量档改写引擎)**→ CF llama → 原文。免费档 = CF Whisper + llama。<10 字符跳过改写。中文输出支持繁简四变体(`vibefox.chineseVariant`,改写阶段执行转换)。
- 分层影响面:
  - Service(client):`CloudflareApiService`(fetch + AbortController 60s + 错误映射含 429;v1 响应兼容映射)
  - Server:`server/src/{index,auth,transcribe,types,prompts,ratelimit,errors}.ts` + `engines/{qwenAsr,anthropicRewrite,cfWhisper,cfLlama}.ts`

### 模块 D:文本插入
- 业务逻辑:`vibefox.insertTarget` = `auto`(编辑器光标 → 活动终端 sendText → chat 面板 → 剪贴板+提示)/ `editor` / `terminal` / `clipboard` / `chat`。
- Chat 路径:先复制到剪贴板,依次尝试已知 chat 聚焦命令(Antigravity/Cursor/Cline/Continue/Cody/Amazon Q/Windsurf,首成功即停);内置 Copilot Chat 有原生 query API 直接填入;其余 webview 面板由 Controller 调 `SystemPasteService` 触发系统级 ⌘V(macOS AppleScript)。
- 已知约束:**webview 聊天输入框无跨扩展 API 可直接写入**;Claude Code CLI 跑在终端里,`terminal.sendText` 可直达。
- 分层影响面:View:`TextInserter`(返回 `needsSystemPaste` 提示);Service:`SystemPasteService`;Controller:调度与错误兜底。

### 模块 E:鉴权生命周期
- 业务逻辑:`vibefox.setLicenseKey` 存 SecretStorage;首次录音无 key 时引导输入;服务端 401/403 时提示重新输入;429 提示稍候。
- 分层影响面:Controller(生命周期)、Service(携带 Bearer)、Server(`auth.ts`)。

### 模块 F:改写引擎(rewriteMode)
- 业务逻辑:三档 `vibefox.rewriteMode`(默认 **clean**):
  - `off` 原样转写;
  - `clean` 最小清理:修标点、去填充词(嗯/啊/那个/就是说/um/uh)、合并口吃重复、按词表校正标识符拼写大小写,不改语序;
  - `rewrite` 深度润色:clean + 回溯自我更正折叠("用A…不对,用B"只留 B;"删掉刚才那句"执行撤回)、轻度语法重组、**口述顺序列举自动排版为逐行编号列表(2026-07-23,"第一…第二…"→"1. / 2. "各占一行,仅明确逐点列举时触发)**,绝不改变技术意图、绝不添加原文没有的内容。
- 提示词服务端所有(`server/src/prompts.ts`);中英混排不翻译;口述符号词(如"等号")保留文字,由客户端 developer-mode 规则最后转符号(职责分离,天然幂等)。
- Cloudflare 链路服务端执行(Haiku→llama→原文);其他 provider 客户端调对应 chat 端点执行(内置 clean/rewrite 两套 prompt)。
- UX:状态栏 tooltip 显示当前模式并可一键切换(`vibefox.selectRewriteMode` QuickPick);旧 `llmCorrectionEnabled` 首次启动自动迁移(true→clean,false→off)。
- 分层影响面:Controller(`processUtterance` 管线)、Server(`prompts.ts` + `engines/`)、View(`StatusBarViewer` 模式显示/统计)。

### 模块 G:多 Provider 兜底
- 业务逻辑:`vibefox.apiProvider` = cloudflare(默认,订阅旗舰)/ groq / openai / aliyun(paraformer 异步流)/ custom。非 cloudflare 走客户端 Whisper prompt 偏置 + 客户端 LLM 改写。
- 分层影响面:Service:`CloudflareApiService` 各 transcribe* 方法;Controller:provider 分发与 key 管理(SecretStorage)。

### 模块 H:桌面端伴侣应用(`desktop/`,2026-07-18 新增)
- 业务目标:把 VibeFox 从「VS Code 专属」扩展成系统级语音输入法 —— 首要场景是 **Claude 桌面 App** 的聊天输入框,同时天然适用于任何前台应用的文本框(浏览器、备忘录等)。
- 形态:Electron menu bar 应用(无 Dock 图标、无窗口),全局热键默认 `Command+Shift+Space`(**刻意避开** VS Code 扩展的 `Ctrl+Shift+Space`,也避开 macOS 系统保留的 `Control+Alt+Space`=切换输入法 / `Command+Space`=Spotlight 等——这些被系统抢先拦截,`globalShortcut.register` 仍返回 true 但回调永不触发;`config.ts` 的 `RESERVED_HOTKEYS` 会把存量坏热键自动迁移到默认值)。
- 管线:与扩展完全同源 —— 直接 import 复用 `client/src/services/` 的 `AudioRecorderService`(ffmpeg 采集 + VAD + MP3 压缩)与 `CloudflareApiService`(协议 v2),同一个 Worker、同一把 License Key、同一套改写档位;插入方式 = 剪贴板 + 模拟 ⌘V 粘贴到前台应用光标处(粘贴后约 1s 恢复原剪贴板)。
- 配置:`~/Library/Application Support/VibeFox/config.json`(用户可直接编辑);License Key 存 macOS 钥匙串(`security` CLI,等价于扩展的 SecretStorage 红线);托盘菜单可切换改写模式/中文变体/转写区域。
- 差异点:桌面端无工作区可挖,`keywords`/`projectContext` 为空 —— 改写阶段仍做填充词清理与标点;不做 IDE 上下文偏置。
- **前台应用感知 tone hint(2026-07-23)**:录音启动时经 System Events 取前台 App bundle id(`frontmostApp.ts`,复用粘贴路径已有的 Apple-events 权限,失败静默降级),映射为类别(`chat`/`email`/`notes`/`ide`/`terminal`/`other`)随请求发送(协议字段 `appCategory`,服务端白名单校验,未知值忽略);服务端 `withAppTone` 只对 chat/email/notes 追加语气指令(**从属于全部核心规则,只调标点与正式度,不改内容**),ide/terminal/未知 = 无操作(基础 prompt 本就面向编程口述)。
- 分层影响面:`desktop/src/main.ts`(controller)+ `config.ts`/`licenseStore.ts`/`paste.ts`(service);client 服务零改动。

### 模块 I:本地转写历史(2026-07-23 新增)
- 业务逻辑:最近 50 条插入过的最终文本仅存本机(隐私承诺:历史绝不上云)。**记录时机在插入之前**,粘贴目标拒收时文本也不丢。
- 扩展端:存 `globalState`;命令 `vibefox.showHistory` → QuickPick(选中复制到剪贴板,含「清空历史」项)。
- 桌面端:存 `history.json`(config.json 同目录);托盘菜单「转写历史(仅本机)」子菜单显示最近 10 条,点击复制,含「清空历史」。
- 分层影响面:Model:`TranscriptHistory`(纯函数,client/desktop 共享,含持久化数据消毒);Controller/desktop main 负责持久化与 UI 调度。

## 3. 绝对禁止(Out of Scope)
- 支付/授权门户(key 用 wrangler CLI 手工发放;Marketplace 发布已解禁但仅手动执行,不自动发布)。
- 捆绑 ffmpeg/sox 二进制((L)GPL 风险);webview 录音(权限不可靠,已评估否决)。
- Windows/Linux 的人工实测(代码路径保留,本机 macOS 无法验证;开源后标 `help wanted` 借助社区)。
- 实时语音翻译(Typeless 有,但非目标用户核心需求,不做)。

## 4. 开源化与对标 Typeless 路线图(2026-07-23 拍板)

**决策**:全仓开源(client/server/desktop),license = **AGPL-3.0-only**(防止云厂商闭源托管服务端)。商业模式 = **open core**:代码完全可自托管(自部署 Worker + 自备 DashScope key,或 BYOK 直连 groq/openai/aliyun 无需服务端),官方托管 Worker + License Key 发放作为付费便利服务(定价锚点:Typeless 年付 $12/月,本产品 $9–12/月 + BYOK 全免费)。差异化打 Typeless 被评测点名的弱项:不支持 BYOK、无开发者集成(MCP)、云强依赖无离线、闭源不可审计。

**Phase A 开源就绪**(本期):LICENSE + 三包 license 字段;仓库清洗(1.md 删除、handoff.md 移入 docs/、git 历史密钥扫描已确认干净);英文 README / docs/SELF_HOSTING.md / CONTRIBUTING.md / issue 模板;GitHub Actions CI(三端 typecheck+build+测试);回归用例固化为 vitest(nonspeech/isContextEcho/dedupeAgainstSession);`dedupeAgainstSession` 抽为共享纯函数消除 client/desktop 双份副本。

**Phase B 体验追平 Typeless**:①流式转写(`qwen3-asr-flash-realtime` WS 代理,松手即出)——**设计已完成**,见 docs/04-STREAMING.md(关键调研结论:国际版 realtime 只有新加坡区、协议为 OpenAI Realtime 风格、官方未记载词表偏置);②个人词典 ✅ 2026-07-23(模块 B);③本地转写历史 ✅ 2026-07-23(模块 I);④桌面端前台应用感知 tone hint ✅ 2026-07-23(模块 H);⑤rewrite 档自动结构化排版 ✅ 2026-07-23(模块 F)。**Phase B 剩余 = ①流式转写实现(M1-M4)**。

**Phase C 平台覆盖**:Windows 实测(dshow + electron-builder win + SendInput 粘贴,社区优先);macOS 公证 + 自动更新 + 开机自启;Linux(pulse)最低优先级。

**Phase D 开源护城河**:MCP server(语音输入暴露为 agent 工具);whisper.cpp 离线档;语音编辑指令(最低优先级)。
