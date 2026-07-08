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
| **M** odel | 纯数据与状态:录音状态机、Buffer→Base64、词频/top-40/hint 拼装、按文档版本缓存 | `client/src/models/`(AudioState、VocabularyModel) | 禁 `vscode.window` / `vscode.commands` / 任何 I/O;不 import viewer/services/controllers |
| **V** iewer | 只渲染 UI、读 UI、写 UI:状态栏、文本插入、读活动编辑器原文 | `client/src/viewer/`(StatusBarViewer、TextInserter、EditorContextViewer) | 禁 `fetch(` / `spawn(` / 业务判断;不 import models/services(数据由 Controller 递入递出) |
| **C** ontroller | 编排:热键/命令注册、状态流转、鉴权生命周期、错误兜底 | `client/src/controllers/`(VibeController) | 唯一可同时触碰 M/V/S 的层;自身不做底层 I/O、不直接拼 UI 字符串细节 |
| **S** ervice | 低层 I/O:ffmpeg 录音进程、HTTPS 调用 | `client/src/services/`(AudioRecorderService、CloudflareApiService);`server/src/` 整体视为远端 Service | 禁 UI 调用(`vscode.window.*`);错误以 typed Error 抛给 Controller |

依赖方向(单向):`extension.ts(组合根) → Controller → { Model, Viewer, Service }`,M/V/S 互相**不**引用。

## 3. 核心算法/领域标准(权威数值)

- 词汇提取 regex:`/[a-zA-Z_][a-zA-Z0-9_]{3,19}/g`;词频降序 **top 40**;停用词 = 常见语言关键字小表;合并最近 **15** 个工作区文件名词干(去扩展名)。
- hint/`initial_prompt`:中文引导句 + 逗号拼接词表,服务端截断至 **896 字符**(Whisper prompt token 上限安全值)。
- 音频:MP3、16kHz、单声道、~32kbps;录音上限 `vibe.maxRecordSeconds` 默认 **25s**;Worker 拒收 >**8MB** base64(413)。
- Whisper 调用:`@cf/openai/whisper-large-v3-turbo`,`task:"transcribe"`,`language` 默认 `"zh"`(显式传,绕过自动检测),`vad_filter:true`。
- 客户端 HTTP 超时 **60s**(AbortController);错误映射:401/403→重设 key,413→录音过长,5xx→服务端错误。

## 4. 跨切面硬规则

- **命名**:类=PascalCase 单一职责名(`XxxViewer`/`XxxService`/`XxxModel`/`XxxController`);配置键=`vibe.*` camelCase;命令=`vibe.verbNoun`。
- **密钥**:客户端只进 `SecretStorage`;服务端只进 KV/secret(见 CLAUDE.md 红线 2)。
- **错误面向用户**:一律经 Controller 用 `showErrorMessage` 给**可操作**文案(如 ffmpeg 安装命令);Service 层抛 typed Error 不弹 UI。
- **Disposable**:所有注册(命令/监听/状态栏)入 `context.subscriptions`;类实现 `vscode.Disposable`。
- **无 any**:`strict: true`;跨端契约(请求/响应)在 client 与 server 各自 types 中保持字段一致。
