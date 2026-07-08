# 需求分析与业务范围(动态契约)
> ⚠️ AI 协议:新需求先更新本文档(业务语言 + MVC+S 分层影响面),用户确认后才编码。

## 1. 业务目标

为使用 LLM 聊天扩展(Claude Code、Cline、Copilot Chat)的开发者提供**语音输入**:按下热键说需求(中文优先,夹杂英文代码词汇),松手后 1~3 秒内把转写文本插入光标处/终端/剪贴板。核心卖点:
- **代码词汇准确**:自动从当前编辑器提取变量名/文件名注入 Whisper 的 `initial_prompt`,专有名词不被音译。
- **低延迟**:语言锁 `zh` 绕过自动检测;MP3 压缩后 payload 小;Whisper large-v3-turbo 是最快的高质量模型。
- **商业化就绪**:License Key 鉴权(Cloudflare KV),闭源分发 .vsix。

## 2. 功能矩阵(当前生效)

### 模块 A:录音与热键
- 业务逻辑:`ctrl+shift+space` 切换录音;再按停止并转写;`vibe.cancelRecording` 丢弃;25s 自动停止。
- 分层影响面:
  - View:`StatusBarViewer`(麦克风图标→波形动画→转写 spinner)
  - Controller:`VibeController`(toggle 状态编排、超时自停)
  - Service:`AudioRecorderService`(ffmpeg 进程、平台参数、MP3 流)
  - Model:`AudioState`(状态机 + Buffer + Base64)

### 模块 B:上下文词汇提取
- 业务逻辑:对活动编辑器全文跑 `/[a-zA-Z_][a-zA-Z0-9_]{3,19}/g`,词频排序取 top 40,合并最近工作区文件名词干,拼成 hint 注入请求。
- 分层影响面:
  - View:`EditorContextViewer`(只读 activeTextEditor 文本 + findFiles 文件名,含 onDidChangeActiveTextEditor 监听,零业务)
  - Model:`VocabularyModel`(regex/词频/停用词/top-40/hint 拼装,按文档版本缓存)
  - Controller:编排两者时机(停止录音后、发请求前)

### 模块 C:云端转写
- 业务逻辑:POST `/api/transcribe`,Bearer License Key → KV 校验;`@cf/openai/whisper-large-v3-turbo`,`language:"zh"` 锁定,keywords 动态注入 `initial_prompt`,`vad_filter` 开。
- 分层影响面:
  - Service(client):`CloudflareApiService`(fetch + AbortController 60s + 错误映射)
  - Server:`server/src/{index,auth,transcribe,types}.ts`

### 模块 D:文本插入
- 业务逻辑:`vibe.insertTarget` = `auto`(编辑器光标 → 活动终端 sendText → 剪贴板+提示)/ `editor` / `terminal` / `clipboard`。
- 已知约束:**webview 聊天输入框(Copilot Chat/Cline)无跨扩展 API 可直接写入**,可靠路径是剪贴板 + 用户 ⌘V;Claude Code CLI 跑在终端里,`terminal.sendText` 可直达。
- 分层影响面:View:`TextInserter`;Controller:选择时机与错误兜底。

### 模块 E:鉴权生命周期
- 业务逻辑:`vibe.setLicenseKey` 存 SecretStorage;首次录音无 key 时引导输入;服务端 401/403 时提示重新输入。
- 分层影响面:Controller(生命周期)、Service(携带 Bearer)、Server(`auth.ts`)。

## 3. 绝对禁止(Out of Scope)
- Marketplace 发布/签名流程、支付/授权门户(key 用 wrangler CLI 手工发放)。
- 流式增量转写(等 Workers AI 支持再议)。
- 捆绑 ffmpeg/sox 二进制((L)GPL 风险)。
- Windows/Linux 的人工实测(代码路径保留,本机 macOS 无法验证)。
