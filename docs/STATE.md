# STATE.md —— 进度状态机
> ⚠️ 每次 DoD 通过后用主管视角更新;相对日期转绝对日期。

## 当前阶段 / 健康度
**阶段**:Phase 2 精度与语法提升完成 & 线上部署通过 (2026-07-10)。
**健康度**:🟢 客户端大模型纠错、VAD上下文继承、Developer Mode 语法规则引擎已全部落地并完成 wrangler 线上部署，双端编译与打包正常。

## 最近完成
- 2026-07-10:Phase 2 —— 精度与语法提升方案全量交付与部署：
  ① **LLM 二次后处理校正**：集成跨服务商的 LLM 后处理引擎。支持通过 `vibefox.llmCorrectionEnabled` 开启，对转写内容执行标点修复、词表拼写校准及固定填充词滤除。针对 Cloudflare 托管 Worker 链路，直接在服务端调用 `@cf/meta/llama-3.1-8b-instruct` 以免去客户端额外调用与 Key 开销，非 Cloudflare 链路在客户端二次执行兼容调用。
  ② **VAD 分段上下文继承**：实现 previous-text conditioning。将前一分段经处理后的转录文本作为下一分段的 prompt 前文，并在 800 字节 prompt 预算限制内动态与 Keywords 混编，彻底解决 VAD 断句后上下文失联与漏字现象。
  ③ **Developer Mode 规则引擎**：独立实现词法级规则解析引擎。支持高频口述符号转义（如“等号”->“=”，“左大括号”->“{”）以及智能命名风格转换（如“驼峰命名 auth middleware” -> “authMiddleware”，“点 ts” -> “.ts”），大幅减少语音转写后的手工微调。
- 2026-07-10:Phase 1 —— 竞品分析 × 精度优化 × Chat 兼容性审计全量交付：
  ① **竞品全景对标**：深度分析 6 款竞品(VS Code Speech 137 万安装 / Mantra / VoxPilot / WisprFlow $15/月 / Voibe $149 买断)，确认 VibeFox 的核心差异化：中文编程唯一深度优化 + 代码上下文词表注入 + 多 Chat 面板兼容 + 5 种 API 后端 + 免费。
  ② **精度优化 3 连击**：(a) 显式传入 `temperature=0` 消除 Whisper 随机性;(b) MP3 比特率从 32kbps 提升到 64kbps 改善中文声母韵母辨识度;(c) `initial_prompt` 从指令式改为自然转录前文风格(Whisper 将 prompt 视为"前一段转录文本"而非指令)。
  ③ **Chat 面板 break-on-first-success**：修复 `intoChat()` 中所有聚焦命令被依次全部执行的逻辑 Bug，改为首个成功即停止。
  ④ **新增 5 款 IDE Chat 支持**：补充 Cline (Claude Dev)、Continue、Sourcegraph Cody、Amazon Q、Windsurf (Cascade) 的 Chat 聚焦命令。
  ⑤ **Copilot Chat 早返优化**：VS Code 内置 Copilot Chat 有原生 query API，命中后直接返回跳过不必要的 AppleScript 粘贴。
- 2026-07-10:针对多引擎部署（添加原生阿里云百炼和极速 Groq/OpenAI 支持），完成跨国低延迟优化与提示词策略升级：
  ① **原生阿里云 ASR 支持**：因专属 MaaS 不支持 OpenAI 兼容转写接口，实现阿里云原生 REST API 异步转写流（提交 -> tasks/{id} 状态轮询 -> 结果 JSON transcripts 解析）。
  ② **跨境网络抖动防御**：加入 AbortController 严格控制各网络 fetch 阶段的超时（12s 提交、6s 轮询、8s 结果下载），并移除了 ffmpeg 音频压缩过程的静默异常吞噬，暴露诊断异常。
  ③ **Groq 极速转写与硬限限制**：集成北美本土低延迟 Groq 接口（0.2s 极速响应），动态计算并将 keywords 词表在 FormData 提交前限制在 800 字符内，规避 896 字符硬限报错。
  ④ **项目级提词优先级重构**：将词频排序修改为：活动文档（Top 30）-> 项目全局高频词（Top 100）-> 其他打开的标签页 -> 文件名，确保全局类名方法名 100% 在额度内传入偏置，极大便利 Vibe Coding 跨项目口述代码。
  ⑤ **沉淀 Obsidian 笔记**：更新 [[Workers-AI-Whisper-Vocabulary-Biasing]]，载入 Groq 限制与重构后的词频优先级规范。
- 2026-07-09:根据用户关于"代码更佳理解 + 录音时间更长 + 录音直填 Agent 对话框"的反馈，完成第二阶段优化迭代并全部跑通验证：
  ① **全局/工作区背景提词**：上线 `WorkspaceContextService` 后台异步扫描，自动收集整个工作区内所有未打开代码文件中的标识符，与当前打开 Tabs 汇总计算词频，全面提升语音识别精准度。
  ② **自动粘贴黑科技**：打通 `workbench.action.chat.open` 与 macOS AppleScript 系统级 `Cmd+V` 模拟按键，实现将语音转写文本直接在光标闪烁时自动粘贴输入进 sandboxed Webview Agent 聊天框中。
  ③ **录音时间限制解除**：在配置中将 `vibe.maxRecordSeconds` 限制上限由 28s 放宽至 600s（10分钟），满足用户超长语音转写需求（2分钟实测完美通过）。
  ④ **沉淀 Obsidian 笔记**：新增沉淀 [[VSCode-Webview-Clipboard-Paste-Simulation]]（Webview粘贴模拟），并升级 [[Workers-AI-Whisper-Vocabulary-Biasing]]（项目级提词优化）至知识库。
- 2026-07-08:采集方案复审 —— webview `getUserMedia` 评估后**否决**(VS Code 对 webview 麦克风限制不可靠;微软官方 VS Code Speech 也走原生模块),维持系统 ffmpeg,转向**装机负担最小化**:①三级探测(`vibe.ffmpegPath` → PATH → 平台常见路径,修复 GUI 启动短 PATH 误报\"未安装\"的坑,本机实证 `/opt/homebrew/bin` 场景);②未装时「一键安装」按钮(内置终端自动执行 brew/winget/apt)。CLAUDE.md 红线 6、PRD 模块 A、02-STANDARDS 已同步,双端构建绿,DoD 分层 grep 全绿。
- 2026-07-07:全量代码生成(scaffold + server + client),本地 wrangler dev 验证通过,详见历史记录。
- 2026-07-08:AUTH_KEYS KV namespace 已建(id `e29c90eca9d24071b0777defbe61618d`),`remote: true` 已写入 wrangler.jsonc。
- 2026-07-08:`npx wrangler deploy` 成功,Worker 线上地址:`https://vibe-voice-worker.presley-us.workers.dev`。
- 2026-07-08:线上冒烟测试通过 —— 无 auth→401、假 key→403、错路径→404,均与本地 wrangler dev 行为一致。200(真实转写)路径留给用户在扩展内用真实录音验证,避免密钥经对话记录暴露。
- 2026-07-08:DoD 全项通过;顺手修复 docs/03-DOD.md 里一处检查命令的假阴性(双引号 `"zh"` 匹配不到源码里的单引号字符串,已改为 `= 'zh'`)。

## 下一步 (Phase 3)
1. 离线本地 Whisper 模式（集成 whisper.cpp / ONNX Runtime 等）。
2. WebSocket 实时流式转写支持。
3. 中英混合多语言自动识别切换优化。

## 阻塞
- 无硬阻塞。Windows/Linux 录音路径(dshow/pulse)代码就位但本机(macOS)无法实测。
