# VibeFox 交接文档(handoff.md)

> 这份文档专门为「换一个对话窗口 / 换一个 AI 接手」而写:让接手者不用翻整个对话记录就知道**做了什么、现在什么状态、什么还没解决**。这是导览,不是取代 `docs/`。
>
> **接手顺序**:本文抓大局 → `CLAUDE.md` 抓硬规则(密钥/分层/署名红线)→ `docs/STATE.md` 最上面几条抓最新进度 → 需要时再深入其他文档或源码。
>
> - `docs/STATE.md` —— 逐次会话的完整变更记录(最详细,含每个 bug 的根因分析)
> - `docs/01-PRD.md` —— 业务需求与功能矩阵
> - `docs/02-STANDARDS.md` —— 技术规范与权威数值(**§4.1 是常驻 App 的系统资源生命周期三铁律,macOS 端改动前必读**)
> - `docs/03-DOD.md` —— 交付前自查清单
> - `docs/SPARKLE.md` —— 签名、公证、自动更新的完整流程与踩坑

最后更新:2026-08-14

---

## 一、这是什么项目

VibeFox —— 语音「Vibe Coding」输入。按热键说话(中文优先、中英混杂),经 Cloudflare Worker 转写 + 改写成干净文字,插入 LLM 聊天输入框或直接粘进任何前台应用。差异化 = **中英混杂精度 + 中文长口述自动结构化排版 + 开源可自托管**,对标 Typeless / Wispr Flow / Superwhisper。

**2026-07-23 起全仓开源(AGPL-3.0-only)**,商业模式 = open core:代码可自托管(自部署 Worker + 自备 key,或 BYOK 直连),官方托管 Worker + License Key 发放是付费便利服务。

**两个前端,共用同一个 Worker 后端 / License Key / 改写档位:**
1. **VS Code 扩展**(`client/`,`Ctrl+Shift+Space`):结果插入 Claude Code / Cline / Copilot Chat 聊天框或活动编辑器。
2. **macOS 原生 App**(`macos/`,`⌘⌥Z` 或 Fn,2026-08-08 起纯原生 SwiftUI):菜单栏常驻,转写结果模拟 ⌘V 粘进**任何前台应用**(首要场景 = Claude 桌面 App),即「系统级语音输入法」。

> ⚠️ **早期的 Electron 版 `desktop/` 已于 2026-08-13 退役删除**(原生达到 parity 后)。旧文档、旧 commit、`docs/01-PRD.md` 模块 H、`docs/05-MAC-VOICE-INPUT.md` 里关于 `desktop/`、electron-builder、`uiohook-napi` 的描述**全部是历史记录,不是当前架构**。

技术栈见 `docs/02-STANDARDS.md` §1。要点:`macos/` 与 `client/` 是**两套独立实现**(Swift 不 import TypeScript),同名逻辑(nonspeech 过滤、会话去重)靠 `shared/fixtures/*.json` 的跨实现契约测试防漂移。

---

## 二、当前架构

**质量档**(license KV metadata `plan:"pro"`)—— 全程走阿里云 DashScope:
- **ASR**:Qwen3-ASR(`qwen3-asr-flash` 新加坡 / `-us` 美国,按 `request.cf.continent` 自动路由或手动指定)
- **改写**:Qwen-Plus(单一质量档改写引擎)
- 任一失败降级 CF Whisper(`@cf/openai/whisper-large-v3-turbo`)+ CF llama(`@cf/meta/llama-3.1-8b-instruct`)

**免费档**:CF Whisper + CF llama。

**BYOK(自带 Key,开源用户主路径)**:客户端直连服务商,**完全不经过 Worker**。v1 只支持千问系(`qwen3-asr-flash` + `qwen-plus`),理由是"BYOK 承诺与官方同质量"就必须绑同一套引擎;**BYOK 无降级链**(用户明确决策:"对于开源的,无需降级")。改写提示词在 `macos/Sources/VibeFoxCore/RewritePrompts.swift` 里与服务端逐字对齐。

**历史注意**:早期有 Claude Haiku 改写引擎和 Haiku-vs-Qwen 对比功能,**2026-07-13 已全部移除**,当前代码无 Anthropic 依赖。旧注释里的 Haiku/compareRewrite 痕迹是历史遗留。

---

## 三、密钥与部署现状

- **线上地址**:`https://api.vibefox.app`(自定义域名,2026-08-12 绑定;旧的 `vibe-voice-worker.presley-us.workers.dev` 仍可用,客户端有自动迁移)
- **密钥**(`wrangler secret put`,线上已配置):`DASHSCOPE_API_KEY_APAC`(新加坡)、`DASHSCOPE_API_KEY_US`(美国,该区无免费额度需已开通计费)。`ANTHROPIC_API_KEY` 已不再使用。
- **部署命令**:`cd server && npx wrangler deploy`(**仅在用户明确要求时**,见 CLAUDE.md;有 `/deploy` skill)
- **已查证的边界,别重复研究**:
  - `qwen3-asr-flash` 国际版**只在新加坡+美国两区**,东京/法兰克福官方标注 Not supported —— `auto`/`apac`/`us` 已是完整集合。
  - **中国大陆**:障碍不是 API key,是 ①Worker 在大陆被墙/极慢 ②北京区需中国企业实体 + ICP 备案。结论「暂不做」;将来需国内独立部署平行后端。**但 BYOK 大陆用户可直连 dashscope.aliyuncs.com 国内端点,已实现且无需备案** —— 这是目前服务大陆用户的实际路径。
- **月度公平使用护栏(已实现)**:每 license key 每月 30 小时(`MONTHLY_AUDIO_LIMIT_SECONDS`,**"0" = 无限,自托管者应设此值**),超出返 **402**;时长由服务端按载荷估算(防伪造);KV 故障时 fail open。BYOK 不经 Worker,天然不受限。

---

## 四、macOS 原生 App 要点(接手必看)

完整记录见 `docs/STATE.md`;`docs/SPARKLE.md` 是签名/公证/自动更新专篇。

- **构建**:`cd macos && swift build && swift test`;打包 `./scripts/make-app.sh --notarize`(不加 `--notarize` 只签名)。产物 `macos/build/VibeFox.app`。
- **安装**:`ditto build/VibeFox.app /Applications/VibeFox.app`(**必须 `ditto` 不能 `cp -R`**,后者可能丢扩展属性破坏公证)。覆盖前先退出 App。
- **签名 = TCC 授权能否长期保持的关键**:用 Developer ID 证书签名,designated requirement 基于证书 + bundle id 而非 cdhash,**麦克风/辅助功能授权跨重打包永久有效**。ad-hoc 签名会导致每次重打包都要重新授权。
- **版权署名**:对外一律 `© 2026 VibeFox.app`,**不出现用户真名**(证书身份 `Min Li (CFA9WX4496)` 仅用于 codesign,不进 UI/文档)。
- **自动更新**:Sparkle 2.9.x,`SUFeedURL = https://vibefox.app/appcast.xml`。**待用户完成**:网站托管 `appcast.xml` 与 `releases/*.zip`。在那之前只能手动 `ditto` 覆盖安装。
- **⚠️ 系统资源生命周期三铁律**:见 `docs/02-STANDARDS.md` §4.1。修改录音/热键相关代码前**务必先读**——这个 App 已经因为同一类问题(系统悄悄回收长生命周期句柄)出过两次"必须重启才能恢复"的 bug。

---

## 五、已根因修复的历史疑难(别再重复排查)

> 这些在旧版 handoff 里曾被列为"未解决",现已定位并修复。**如果用户报告类似现象,先看诊断日志再怀疑这些结论。**

1. **「有声音却转写成空」(悬了近一个月)** —— 已定位为**多因叠加**,2026-08-13 全部修复:
   - `QWEN_TIMEOUT_MS` 是**固定 6 秒**,而 60 秒音频需 6-12 秒 → 必然超时 → 降级 Whisper 也吃力 → 双引擎皆空 → 502 → 客户端按"正常静音段"静默跳过。修复:超时随音频长度缩放。
   - VAD 只在静音 ≥1.2s 时切分,**连续说话永不切分**,整段 60s 一次性发出,正好落进上面的超时区。修复:`maxSegmentMs = 20s` 强制切分。
   - ⚠️ **踩坑**:该修复的第一版 `asrTimeoutMs()` 返回**浮点数**,Node 的 `AbortSignal.timeout()` 对小数抛 RangeError,且异常落在 ASR 的 try/catch 里 = **每个质量档请求静默降级 Whisper**(症状与原 bug 一模一样)。已加 `Math.round` 并在注释标注 LOAD-BEARING,集成测试锁定。
2. **句尾莫名多一个「嗯」** —— VAD 尾部呼吸段 → ASR 填充词幻觉 → 文本 <10 字符跳过改写 → 直接输出。修复:nonspeech 过滤器增加"纯填充词"判定(服务端 + 客户端 + Swift 三端,靠 `shared/fixtures` 锁定一致)。
3. **热键偶发失灵、必须重启** —— CGEventTap 被系统禁用且"禁用通知"本身可能丢失;安全输入期间 tap 看似 enabled 实则全聋;`.processing` 卡死吞掉按键。修复:10s watchdog(tap 复活/重建、安全输入切 Carbon 后备、卡死复位)。
4. **点录音键完全没反应、必须重启**(2026-08-14) —— `AVAudioEngine` 单实例复用且从不监听 `AVAudioEngineConfigurationChange`,系统重配音频栈后该实例**永久失效**。修复:引擎可重建 + `start()` 同步路径自愈 + 系统唤醒重建 + App Nap 活动声明。**同时修了三重静默**:`lastError` 当时在菜单栏和主界面都没有展示位、系统通知需授权、该路径无埋点。

**诊断能力**:`macos` 端有内容零落盘的 `DiagnosticsLog`(只记长度/引擎/耗时/原因码/峰值),设置页「诊断」区可查看复制。判读口径:`no_speech` 且 `peak>1000` = 引擎侧问题(录到了没识别出),peak 低 = 采集侧问题。关键事件:`recorder_start_failed`、`audio_engine_recovered`、`system_wake`、`hotkey_*`、`toggle_ignored_processing`。

---

## 六、商业化现状

- **定价锚点**:Typeless 年付 $12/月;本产品建议 **$9-12/月**,BYOK 全免费。
- **成本实测(非估算)**:改写侧每请求**固定 1571 token**(占输入 87-91%)。单用户月成本:轻度 $0.55 / 中度 $1.74 / 重度 $5.90 / 极端 $14。$9.9 订阅下毛利率 94%/82%/40%/**-41%**(极端尾部亏钱,这是设 30 小时护栏的直接依据)。
- **隐式缓存是意外之喜,已加锁**:qwen-plus 默认开 Context Cache、命中按 20% 计费、门槛 256 token;我们的固定前缀 1341 token 且同会话逐字节相同 —— **碰巧吃到了,不是设计出来的**。一次无心的顺序调整就会静默涨价 ~30%,故用三重防线锁死:注释 → `prompts.test.ts` 4 例契约测试 → 生产遥测(日志 `cache=<cached>/<input>`)。
- **账号系统:暂不需要**。License Key 本身就是最小账号,当前缺的是**自助发放**而非登录。`/api/usage` 已提供用量透明度。
- **未做**:自助订阅/支付整合(用户的 pulsequota 项目可参考)、网站 vibefox.app 与 /support 页(用户自己做)。

---

## 七、硬规则速记(完整版见 CLAUDE.md)

- **严格 MVC+S 分层**:`models/` 禁 UI,`viewer/` 禁 fetch/spawn,`services/` 禁 UI 调用,只有 `controllers/` 能同时碰三层。交付前跑 `/dod`。
- **密钥红线**:License Key 只进 SecretStorage / macOS 钥匙串;服务端密钥只进 `wrangler secret put`。改写提示词与模型 id **服务端所有**,协议 v2 不接受客户端传 prompt/model(防计费滥用)。
- **语言分工**:沟通与内部文档用中文;**代码一律英文含注释**;**commit message 与对外文档(README 等)用英文**。
- **⚠️ commit 署名**:只用用户本人 git 身份,**绝不加 `Co-Authored-By: Claude` 或任何 AI 署名行**(2026-08-13 用户明确要求;历史上 84 条 commit 带过这行,已 `git filter-repo` 清除并 force-push)。
- **开源**:AGPL-3.0-only;对外文档双语(中文主版本 + `*.en.md`),**改动必须同步两份**。
- **未经要求不发布 marketplace、不提交不推送**(用户明确要求时才做)。

---

## 八、如果你是接手的新 AI,建议这样开场

1. 读本文 + `CLAUDE.md`;要动 macOS 端就再读 `docs/02-STANDARDS.md` §4.1。
2. 跑一次 `/dod` 自查确认当前代码健康(server/client/macos 三端测试)。
3. 当前测试基线:**server 73 / client 20 / macos 97**,全绿。
4. 用户报"又不能用了"时的分诊顺序:先看设置页**诊断日志**(能直接分辨引擎侧/采集侧/卡死/唤醒)→ 再看菜单栏是否有 `⚠️` 错误提示 → 最后才怀疑服务端(`curl https://api.vibefox.app/api/transcribe` 无 auth 应 401)。

## 九、下一步候选

- **用户侧待办**:网站 vibefox.app(含 `/support`、`appcast.xml`、`releases/` 托管)—— 完成前 Sparkle 自动更新无法生效。
- **已分析待拍板**:BYOK 双 provider 拆分(ASR/改写独立选型)、自助 License Key 发放(建议上线前做)。
- **明确推迟**:本地离线模型(用户原话"离线模型暂时不要";已核实 Qwen3-ASR-1.7B 开源 Apache 2.0、M3 Air 16GB 可跑,改写侧走 Ollama 与现有 BYOK 协议天然对上)。
- **长期未验证**:Windows/Linux 采集路径(dshow/pulse)代码就位但无真机实测。
