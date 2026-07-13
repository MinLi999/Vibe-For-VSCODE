# STATE.md —— 进度状态机
> ⚠️ 每次 DoD 通过后用主管视角更新;相对日期转绝对日期。

## 当前阶段 / 健康度
**阶段**:Phase 2.7 第二轮实测缺陷修复完成,已部署上线 (2026-07-12)。
**健康度**:🟢 双端编译/typecheck 全绿,DoD 分层 grep 全绿,dedupe 4 用例全过,线上冒烟通过。⚠️ 待办:用户真实语音复测(重点:长录音多分段无重复句、按住热键即录、快速点按不再报错)。
- 2026-07-12(第二轮实测反馈,四个症状全部修复):
  ① **句子重复**("你现在需要调整几点…"一字不差出现两次):根因是 previousTranscript 被喂进 Whisper `initial_prompt` 与改写 LLM 的用户消息做"衔接"——Whisper 在接近静音的音频上会把 prompt 原文当转写结果吐出(著名失效模式),改写 LLM 也偶尔无视"禁止重复输出"照抄。修复:**从所有 prompt 向量中彻底移除 previousTranscript**(服务端 buildInitialPrompt/buildRewriteUserMessage、客户端各直连 provider 的 prompt 构建),会话转写只留在客户端;另加确定性兜底 `dedupeAgainstSession`(归一化整段回声消除 + ≥8 字符后缀-前缀重叠裁剪,4 组正反用例含用户原始样本全过)。
  ② **按住热键仍报错 + 用户要求按住即录**:上一轮的 400ms 盲目去抖对"按住"反而有害——每 400ms 放行一个事件变成 start/stop 交替,撞出"没有录到音频"与 `invalid state transition: idle→processing`(后者是 stopAndTranscribe 在 `await recorder.stop()` 期间被并发重入)。重写为**双语义热键状态机**:录音中首个事件先armed 350ms pending-stop 窗口,窗口内再来事件即判定为 OS 按键自动重复(=按住)→ 进入 hold 模式,重复事件停止 650ms(=松手)才触发停止——**点按=开关,按住=对讲**一个键位同时支持;并加 isStopping 重入锁、await 后 phase 复查、<700ms 的最短录音时长保障(ffmpeg 启动需 ~300ms)。
  ③ **程序"卡住"10 多秒后成功**:实际是 Qwen 超时(8s)→ Whisper 兜底的降级链总时长,用户看到的是静止的 spinner。Qwen 超时收紧到 6s,转写超过 6s 状态栏改显"转写中…(网络较慢或引擎切换中)"。
  ④ **两模型对比查看方法**:开 `vibefox.rewriteCompareEnabled` → Output 面板选「VibeFox: Rewrite Comparison (Haiku vs Qwen)」。
- 2026-07-12(**用户实测反馈的五个症状,全部定位根因并修复**):
  ① **"机械噪音/金属摩擦声"幻觉(最严重)**:根因是 `AudioRecorderService.processPcmChunk` 的 VAD 切分偏移 `silenceBytes = silentTimeMs * 32` 为浮点累加,`Buffer.slice` 在**奇数字节**处切开 s16le 流 → 之后每个 16-bit 采样高低字节互换(听感=剧烈金属摩擦声),且错位的 trailing buffer 作为下一段开头**传染整个会话**——这就是"第一段偶尔成功、后面全废"。修复:切分偏移强制 2 字节采样对齐(`Math.floor(x/2)*2`),`stop()` 尾段同样对齐;10000 次随机 fuzz 验证偏移恒为偶数且有界。
  ② **"..."空转写**:ASR 对静音输出省略号/字幕水印幻觉。新增双端同步的 `isNonSpeechTranscript` 过滤器(纯标点、整句括号包裹的场景描述、"音频中…"开头的旁白、短句字幕垃圾),服务端命中直接 502(省改写费用),客户端在改写/符号规则**之前**过滤(避免误杀"等号"→"="),12 组正反用例全过;非 VAD 场景的报错从"转写失败"toast 改为状态栏"未识别到语音,请重试"。
  ③ **打开 Copilot Chat 而非 Claude Code**:旧 `intoChat` 盲发一串命令,列表里根本没有 Claude Code,而 `workbench.action.chat.open` 是内置命令永远"成功"→必然劫持到 Copilot。修复:读取本机已装扩展 manifest 确认真实命令 id(`claude-vscode.focus` = "Claude Code: Focus input"),置于优先级首位;改用 `getCommands(true)` 只调用真实注册的命令;Copilot 兜底必须先确认 `github.copilot-chat` 已安装;全都没有则诚实返回 clipboard(不盲贴)。
  ④ **按住热键报错**:OS 按键重复(~50ms/次)高频触发 toggle → start/stop 互撞。修复:`toggle()` 加 400ms 去抖。
  ⑤ **改写模式不好用**:主要是①②的垃圾输入连带污染(错位音频→幻觉文本→污染 previousTranscript 上下文);另在两套服务端 prompt 与客户端兜底 prompt 中补充"噪音描述输出空字符串"规则。已重新部署 Worker + 重打包 vsix。
- 2026-07-12(**用户报告的严重 bug,已修复**):用户反馈聊天框里出现"【项目词表(代码标识符,注意大小写)】"字样后跟一长串明显是 package-lock.json 依赖字段的词(https/license/integrity/sha512/libvips/workerd 等),且识别精度不高。排查出两个根因,均已修复:
  ① **`client/src/services/WorkspaceContextService.ts` 的 `FIND_EXCLUDE` glob 写错**:把 `package-lock.json`/`yarn.lock`/`pnpm-lock.yaml` 塞进 `**/{...}/**` 目录排除模式里,这种写法只能排除同名**文件夹**,排除不了**文件本身**——用 `minimatch` 实测验证旧模式确实排除不掉这三个锁文件。导致 149KB 的 `package-lock.json` 被整个当"代码"扫描,依赖包字段被当成"高频项目标识符"喂进请求,挤占了真实项目词表的名额(直接拖累精度)。已改写为 `{**/dir/**,...,**/package-lock.json,**/npm-shrinkwrap.json,**/yarn.lock,**/pnpm-lock.yaml}` 形式的正确排除(`EditorContextViewer.ts` 同步修复),`minimatch` 实测验证新模式排除正确且不误伤真实源码。
  ② **Qwen3-ASR 请求方式本身有问题(真正导致文本泄漏进聊天框的原因)**:早期实现把项目词表/背景塞进 DashScope `multimodal-generation` 接口的 `system` 角色聊天消息里,当作"上下文增强"传给 ASR。重新核查阿里云官方 API 参考后发现**这个用法从未被文档证实支持**——官方文档里唯一沾边的线索是另一个**异步文件转写接口**(不同的 endpoint/model)示例代码里一行**被注释掉**的 `parameters.corpus.text`。模型显然把我们塞的这段"偏置说明文字"当成了要处理的对话内容,直接原样"读"出来当转写结果返回,造成聊天框里出现内部提示词原文的严重体验事故。修复:**彻底移除**这个未经证实且已实锤造成污染的机制,Qwen3-ASR 请求改为纯音频(不注入任何文本);词表/项目背景的校正职责转移到已验证安全的改写阶段(`server/src/prompts.ts` `buildRewriteUserMessage` 携带 keywords + projectContext,交给 Haiku/Qwen-Plus 这类文本 LLM 处理,这条路径不会有"把提示词读出来"的风险)。
  顺带清理:`server/src/engines/cfLlama.ts` 的 `LLAMA_MODEL` 常量取消不必要的 export(未被外部引用的死导出);`prompts.ts` 的 `buildQwenContext`/`QWEN_CONTEXT_MAX_CHARS` 随机制移除一并删除。全量核对 21 个 `vibefox.*` 设置与代码读取点一一对应,无孤儿设置/孤儿读取。
- 2026-07-12(修正):查阿里云官方文档发现 DashScope API Key **按区域隔离、不能跨区调用**(新加坡 key 打美国区端点会 403);原设计的单一 `DASHSCOPE_API_KEY` 是缺口,已改为 `DASHSCOPE_API_KEY_APAC` / `DASHSCOPE_API_KEY_US` 两个独立 secret,`resolveQwenRegion` 按解析出的区域一并返回对应 key(`server/src/engines/qwenAsr.ts`)。
- 2026-07-12(新增,评估用):用户质疑"为何改写引擎用 Claude Haiku 而不用阿里云自己的模型"—— 查证 Qwen-Plus 国际版定价确实比 Haiku 4.5 便宜 2~4 倍,但"更懂中英混杂"这个说法查无可信依据(第三方比较网站的 benchmark 数字不可信)。决定:**Haiku 与 Qwen-Plus 两条改写线路并行跑几天**,由用户实际听感判断。实现:`server/src/engines/qwenRewrite.ts`(DashScope 原生 text-generation 接口,模型 `qwen-plus`,复用 ASR 已有的区域 key,不需要新增 secret);`transcribe.ts` 里 Haiku(主链路,决定实际插入文本)与 Qwen-Plus(影子调用,仅供比较)用 `Promise.all` 并发跑,不增加串行延迟;响应新增 `rewriteComparison` 字段。客户端新增 `vibefox.rewriteCompareEnabled` 设置(默认关)+ `RewriteComparisonViewer`(新 Output Channel「VibeFox: Rewrite Comparison (Haiku vs Qwen)」),开启后每次转写都会把原文/两个引擎结果并排写入面板。评估期结束后建议关闭该设置(省调用成本)。

## 最近完成
- 2026-07-12:Phase 2.5 —— 对标 Wispr Flow/Aqua Voice 的「超越竞品」全量重构(竞品调研 + 2026-07 模型选型 + 全代码库审计驱动):
  ① **服务端双引擎(协议 v2)**:质量档(KV license `plan:"pro"`)= Qwen3-ASR(DashScope multimodal 同步接口,context enhancement 通道吃整段项目上下文,区域感知路由亚太→新加坡/其余→美国,8s 超时)+ Claude Haiku 4.5 改写(clean/rewrite 双模式服务端 prompt,含回溯自纠折叠);免费档/降级链 = CF Whisper(补上 temperature:0)+ llama-3.1-8b;短文本(<10 字符)跳过改写。响应含 rawText/finalText/tier/engines/timings/fallback,v1 完全兼容。
  ② **安全加固**:v2 不再接受客户端 llmPrompt/llmModel(计费滥用面清零,v1 传入直接忽略);按 key 限流(Rate Limiting binding,free 10/分、pro 40/分→429);载荷上限按档(free 4MB/pro 8MB)。
  ③ **rewriteMode 三档**(off/clean/rewrite,默认 clean):废弃 llmCorrection* 设置(首启自动迁移),状态栏 tooltip 显示模式+一键切换(QuickPick),非 cloudflare provider 走客户端内置 prompt 兜底(顺带修复 provider 解析为 cloudflare 时静默跳过纠错的 bug)。
  ④ **两级上下文载荷**:keywords[40](活动文档 top20→工作区 top15→文件名)+ projectContext(≤2000 字符,含原始大小写符号/imports/相关文件);会话级构建一次缓存,VAD 分段不再每段重扫工作区/重读配置。
  ⑤ **VAD 修复三连**:sessionTranscript 300 字窗口(修复无界累积的上下文污染);结尾段不再按振幅丢弃(轻声尾词不丢,交 ASR 判定);自适应静音阈值(噪声底 500ms 自校准+快降慢升,`vadAdaptiveThreshold` 默认开)。
  ⑥ **通知去噪**:删除每段 toast,段级错误累积会话结束一条汇总;成功反馈改为状态栏统计「✓ N字(M段) · Qwen3+Haiku · X.Xs」。
  ⑦ **分层违规清零(DoD grep 全绿)**:AudioRecorderService 去 vscode 依赖(错误走 onSegmentError 回调);AppleScript 粘贴从 TextInserter 移入新 SystemPasteService(viewer 返回 needsSystemPaste 由 Controller 调度);keybindings.json 读取移入新 KeybindingLookupService;diagnoseAudio 的 ffmpeg spawn 移入 AudioRecorderService.captureSample(顺带修复 avfoundation 硬编码,跨平台可用)。
  ⑧ **卫生**:修复 developer-mode 文件扩展名正则 `\\.`→`\.`;补 contribute `clearLicenseKey`/`selectRewriteMode`;删死代码(TOP_TOKEN_COUNT/formatHint/MAX_INITIAL_PROMPT_CHARS);VAD 压缩路径补 64kbps;PRD/STANDARDS/CLAUDE.md/DOD 四份文档与代码对齐(此前 32kbps/25s/top40/896 字符等全部过期数值已刷新)。
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

## 下一步
1. **部署与验证**(用户动作):申请阿里云国际版 Model Studio key + Anthropic key → `wrangler secret put` → `/deploy` → 发一个 `plan:"pro"` 测试 key → F5 手测脚本(见 03-DOD/计划文档):默认 clean 档说带填充词的中英混杂句、rewrite 档验证"用A…不对,用B"只留 B、VAD 长录音单条反馈、尾段轻声不丢。
2. 观察 timings/fallback 遥测:若美洲区 Qwen3-ASR 延迟不理想,引擎抽象层已预留接 ElevenLabs Scribe v2 / Groq。
3. Phase 3 候选:离线本地 Whisper(whisper.cpp)、WebSocket 实时流式、标点映射表上下文感知("价格大于一百"误转 `>` 问题)、商业化基础设施(试用 key 发放/用量计量/支付)。

## 阻塞
- 质量档 200 路径验证需要 DASHSCOPE_API_KEY / ANTHROPIC_API_KEY(用户提供)。
- 本机 Node v20.10.0 跑不动 wrangler 4(需 ≥22),`wrangler dev` 本地冒烟受阻;node@22 已在 Homebrew 后台安装,或部署后直接线上冒烟。
- Windows/Linux 录音路径(dshow/pulse)代码就位但本机(macOS)无法实测。
