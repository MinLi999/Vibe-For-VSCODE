# 流式转写立项设计(Phase B①,2026-07-23 调研)

> 目标:「松手即出」。现状端到端 2.2–4.0s 的感知延迟,根因是**说完才开始转写**;流式方案让转写与说话并行,松手时只剩尾段 + 改写的时间(预期感知延迟 <1s)。这是对标 Typeless 体感差距的第一优先级。

## 1. 上游 API 调研结论(qwen3-asr-flash-realtime)

- **协议**:WebSocket,OpenAI Realtime 风格事件。握手 `Authorization: Bearer <DASHSCOPE_KEY>`,401/403 在握手期返回。
- **端点**:`wss://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime`。⚠️ **国际版只有新加坡区**(北京区需中国实体,美国区无 realtime 端点)——与批量接口(SG+US 双区)不同。URL 里需要 **WorkspaceId**(按 secret 管理:`DASHSCOPE_WORKSPACE_ID`)。
- **音频**:PCM16 16kHz 单声道(`input_audio_format:"pcm"`, `sample_rate:16000`),推荐 ~3200 字节/包(≈0.1s)。**我们的 VAD 采集路径本来就是 s16le 16k PCM 流,零转码直接可发**。
- **两种断句模式**:`server_vad`(服务端断句,`silence_duration_ms` 默认 800/会话场景推荐 400)或 `turn_detection:null` 手动 commit(**累计音频 ≤60s,不适合长口述**)→ 选 server_vad。
- **事件流**:上行 `session.update` / `input_audio_buffer.append`(base64 PCM)/ `session.finish`;下行 `...transcription.text`(增量)/ `...transcription.completed`(整句定稿)/ `session.finished`。
- **限制与缺失**:不返回时间戳;**官方未记载 context/词表偏置支持**——流式路径 ASR 端失去 keywords 偏置,标识符校正只能靠改写阶段兜住(keywords 照常喂 qwen-plus)。

## 2. 架构

```
client/desktop                Worker (/api/realtime)                DashScope SG
ffmpeg PCM16 流 ──WS──▶  鉴权(license key, plan:"pro")  ──WS──▶  qwen3-asr-flash-realtime
     ◀── 整句定稿(已改写) ──  每句 completed → qwen-plus 改写 ◀── transcription events
```

- **Worker 做纯代理 + 改写编排**:客户端永远只连 Worker(密钥红线不变,DashScope key/WorkspaceId 不出服务端);Worker 收到每句 `completed` 后走既有 `qwenRewrite` → 下发 `{type:"segment", rawText, finalText}`;增量 `text` 事件透传为 `{type:"partial", text}` 供状态栏预览。
- **插入策略不变**:整句定稿才插入(聊天框/粘贴目标无法可靠地渐进式改写);partial 只进状态栏预览。dedupeAgainstSession/isNonSpeechTranscript/isContextEcho 防线照常在定稿路径生效。
- **断句权转移**:流式模式下客户端 VAD 只做电平表显示,断句交给 server_vad(silence_duration_ms 映射自 `vibefox.vadSilenceMs`,clamp 到 [400,2000])。
- **降级链**:WS 握手失败/中途断连/超时 → 当前段音频落回既有 HTTP 批量路径重发(PCM 已在客户端缓存,压 MP3 复用现有管线),用户无感;连续两次流式失败本会话降级批量。

## 3. 商业与档位

- **仅质量档**(`plan:"pro"`):流式是付费卖点,免费档维持批量 Whisper 链(Workers AI 无流式 ASR)。
- **区域现实**:所有流式流量走新加坡(无美国 realtime 端点)。美洲用户 RTT 增加 ~150-250ms——仍远优于批量路径的整段等待;`vibefox.dashscopeRegion` 对流式路径无效(文档注明)。
- **限流**:每 key 并发流式会话 =1;会话时长上限 = maxRecordSeconds;沿用 RL_PRO 计数(一次会话计一次)。

## 4. 配置面

- `vibefox.streamingMode`(默认 `off`,验证期 opt-in;稳定后翻默认):`off` / `on`。desktop config 同名字段。
- 服务端新增 secret:`DASHSCOPE_WORKSPACE_ID`(SG workspace)。wrangler.jsonc 不新增明文。

## 5. 里程碑

- **M1 Worker 代理**:`server/src/realtime.ts`(WebSocketPair 下行 + 上游 WS)、node 脚本用本地 PCM 文件回放实测(验证事件序列/改写编排/延迟数字);vitest 覆盖事件转换纯函数。
- **M2 client 接入**:`CloudflareApiService.transcribeStream`(WS)+ Controller 流式分支 + 状态栏 partial 预览 + 降级链;A/B 遥测(timings 对比批量)。
- **M3 desktop 接入**:复用同一 service;托盘 title 显示 partial。
- **M4 转默认**:遥测确认 p50 感知延迟 <1s 且降级率 <5% 后,streamingMode 默认 `on`。

## 6. 风险

1. **官方 realtime 文档无词表偏置** → 流式模式标识符首译准确率可能低于批量;缓解:改写阶段 keywords 校正 + 效果不达预期时在 PRD 层面把流式定位为「速度档」、批量为「精度档」供用户选。
2. Cloudflare Workers 出站 WS 的空闲超时/时长限制需在 M1 实测(长录音 10 分钟场景);必要时升级 Durable Objects 承载会话。
3. server_vad 断句节奏与现有客户端 VAD 不同,句间静音段语义变化,需回归 `dedupeAgainstSession` 与「N 段汇总」统计口径。
