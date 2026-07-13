# 技术栈与分层标准
> 源头以 CLAUDE.md 为准,本文是其架构化展开。

## 1. 技术栈 + 构建命令

| 端 | 栈 | 构建/验证 |
|---|---|---|
| client | TypeScript + VS Code Extension API,esbuild 单文件打包,**零运行时依赖** | `cd client && npm run typecheck && npm run compile`;打包 `npm run package` |
| server | TypeScript + Cloudflare Worker(native fetch handler,无框架),AI + KV 绑定 | `cd server && npm run typecheck`;本地 `npm run dev`;发布 `npm run deploy`(仅 /deploy) |

## 2. 分层职责(MVC+S,映射到本项目实际目录)

| 层 | 职责 | 本项目落点 | 红线 |
|---|---|---|---|
| **M** odel | 纯数据与状态:录音状态机、Buffer→Base64、词频/两级载荷拼装、按文档版本缓存 | `client/src/models/`(AudioState、VocabularyModel) | 禁 `vscode.window` / `vscode.commands` / 任何 I/O;不 import viewer/services/controllers |
| **V** iewer | 只渲染 UI、读 UI、写 UI:状态栏、文本插入、读活动编辑器原文 | `client/src/viewer/`(StatusBarViewer、TextInserter、EditorContextViewer) | 禁 `fetch(` / `spawn(` / `exec(` / 业务判断;不 import models/services(数据由 Controller 递入递出);需要进程级动作时返回提示字段(如 `needsSystemPaste`)由 Controller 调 Service |
| **C** ontroller | 编排:热键/命令注册、状态流转、鉴权生命周期、错误兜底、会话级缓存(context/config/stats) | `client/src/controllers/`(VibeController) | 唯一可同时触碰 M/V/S 的层;自身不做底层 I/O、不直接拼 UI 字符串细节 |
| **S** ervice | 低层 I/O:ffmpeg 录音进程(三级探测+VAD 切分+采样诊断)、HTTPS 调用、工作区扫描、系统粘贴模拟、keybindings 读取 | `client/src/services/`(AudioRecorderService、CloudflareApiService、WorkspaceContextService、SystemPasteService、KeybindingLookupService);`server/src/` 整体视为远端 Service | 禁 UI 调用(`vscode.window.*`);错误以 typed Error 抛给 Controller 或经 onSegmentError 回调 |

依赖方向(单向):`extension.ts(组合根) → Controller → { Model, Viewer, Service }`,M/V/S 互相**不**引用。

## 3. 核心算法/领域标准(权威数值)

- 词汇提取 regex:`/[a-zA-Z_][a-zA-Z0-9_]{3,19}/g`;停用词 = 常见语言关键字小表。
- **两级上下文载荷**(每录音会话构建一次并缓存):
  - `keywords[]` ≤ **40**(活动文档 top **20** → 工作区 top **15** → 其他标签页 → 最近 **15** 个文件名词干);
  - `projectContext` ≤ **2000 字符**(项目名/当前文件+语言/当前文件符号 top **30**/工作区高频标识符 top **100**/相关文件,保留原始大小写)——**只喂给改写阶段**,不发给 ASR。
- Whisper 路径 `initial_prompt`:previousTranscript 末 **300 字** + 中文引导句 + 顿号拼接词表,UTF-8 预算 **800 字节**(`WHISPER_PROMPT_BUDGET_BYTES`)。**Qwen3-ASR 请求为纯音频**(不注入任何文本偏置)——阿里云官方 API 参考未证实同步接口(`multimodal-generation`)支持文本级 context/corpus 参数(唯一线索是另一个异步接口示例里一行被注释掉的 `parameters.corpus.text`);早期用 `system` 角色消息塞偏置文本的实现曾在生产环境被模型原样"读出来"当成转写结果返回(prompt-injection 式污染),已彻底移除,标识符校正改在改写阶段(`buildRewriteUserMessage` 携带 keywords + projectContext)进行。
- 音频:MP3、16kHz、单声道、**64kbps**;录音上限 `vibefox.maxRecordSeconds` 默认 **25s**(可调至 600s);Worker 拒收 base64:免费档 >**4MB**、质量档 >**8MB**(413)。
- **协议 v2**:请求 `{audio, language?, keywords?, projectContext?, previousTranscript?, rewriteMode, enginePreference?}`;响应 `{text, duration_ms, rawText, finalText, tier, engines, timings, fallback?}`;`rewriteMode` 存在即 v2,v1 `llmCorrect:true→clean`,`llmPrompt`/`llmModel` 忽略。
- **引擎路由**:tier 由 KV metadata `plan:"pro"` 决定;质量档 ASR = `qwen3-asr-flash`(亚太 `dashscope-intl` / 美国 `dashscope-us` + `qwen3-asr-flash-us`,按 `request.cf.continent` 自动路由或 `regionPreference` 手动指定,**6s** 超时,`enable_itn:true`)降级 CF Whisper(**20s** race);改写 = **`qwen-plus`(主力,8s 超时,`temperature:0`,同区域 key)** 降级 `claude-haiku-4-5`(**10s** 超时)降级 `@cf/meta/llama-3.1-8b-instruct` 降级原文;**<10 字符跳过改写**。`compareRewrite:true` 时影子并发跑 Haiku 供对比(响应 `rewriteComparison.alt*` 字段)。
- **中文变体**:请求 `chineseVariant`(`simplified-cn` 默认 / `simplified-sg-my` / `traditional-tw` / `traditional-hk-mo`),由改写阶段的 system prompt 后缀实现字形+地区用语转换(`prompts.ts withChineseVariant`);`rewriteMode:'off'` 时不生效;英文与代码标识符不受影响。
- Whisper 调用:`@cf/openai/whisper-large-v3-turbo`,`task:"transcribe"`,`language` 默认 `"zh"`(显式传,绕过自动检测),`vad_filter:true`,`temperature:0`。
- **限流**:Cloudflare Rate Limiting binding,按 license key:free **10 次/60s**、pro **40 次/60s**,超限 429;绑定缺失时放行(本地 dev)。
- **VAD**:静音切分阈值默认自适应 —— 噪声底 = 前 **500ms** 最小chunk均幅,此后 `min(chunkAvg, floor×1.02)` 快降慢升;`effectiveThreshold = clamp(floor×2.5, vadSilenceThreshold, 2000)`;`vadAdaptiveThreshold:false` 退回固定值。结尾段 ≥200ms 一律送 ASR(不做振幅丢弃)。
- **rewriteMode** 默认 **`clean`**;提示词服务端所有(`server/src/prompts.ts`),客户端兜底路径用内置等价 prompt;developer-mode 符号规则在改写**之后**执行(prompt 要求保留口述符号词原样,保证幂等)。
- ffmpeg 探测顺序(权威):`vibefox.ffmpegPath` → PATH → 平台常见安装路径(macOS:`/opt/homebrew/bin`、`/usr/local/bin`、`/opt/local/bin`;Windows:winget Links、chocolatey bin、scoop shims、`C:\ffmpeg\bin`;Linux:`/usr/bin`、`/usr/local/bin`、`/snap/bin`)。只缓存成功结果(装完重试须能生效)。
- 客户端 HTTP 超时 **60s**(AbortController);错误映射:401/403→重设 key,413→录音过长,429→限流稍候,5xx→服务端错误。
- **配置命名空间**:`vibefox.*` 为准;`vibe.*` 为 legacy 迁移回落(读取时 vibefox 无显式值才回落),保留一个版本周期。

## 4. 跨切面硬规则

- **命名**:类=PascalCase 单一职责名(`XxxViewer`/`XxxService`/`XxxModel`/`XxxController`);配置键=`vibefox.*` camelCase;命令=`vibefox.verbNoun`。
- **密钥**:客户端只进 `SecretStorage`;服务端只进 KV/secret(见 CLAUDE.md 红线 2)。
- **错误面向用户**:一律经 Controller 用 `showErrorMessage` 给**可操作**文案(ffmpeg 缺失 →「一键安装」按钮直接在内置终端执行安装命令,不让用户抄命令);Service 层抛 typed Error 不弹 UI。
- **Disposable**:所有注册(命令/监听/状态栏)入 `context.subscriptions`;类实现 `vscode.Disposable`。
- **无 any**:`strict: true`;跨端契约(请求/响应)在 client 与 server 各自 types 中保持字段一致。
