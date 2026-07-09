# STATE.md —— 进度状态机
> ⚠️ 每次 DoD 通过后用主管视角更新;相对日期转绝对日期。

## 当前阶段 / 健康度
**阶段**:线上部署完成,DoD 通过(2026-07-08)。
**健康度**:🟢 Worker 已上线,鉴权链路验证通过;双端构建绿。

## 最近完成
- 2026-07-09:根据用户确认,执行 `/push-to-obsidian` 成功沉淀两个模式 —— ① Whisper `initial_prompt` 代码词汇偏置;② ffmpeg 跨平台录音参数管道至 Obsidian 知识库。
- 2026-07-08:采集方案复审 —— webview `getUserMedia` 评估后**否决**(VS Code 对 webview 麦克风限制不可靠;微软官方 VS Code Speech 也走原生模块),维持系统 ffmpeg,转向**装机负担最小化**:①三级探测(`vibe.ffmpegPath` → PATH → 平台常见路径,修复 GUI 启动短 PATH 误报"未安装"的坑,本机实证 `/opt/homebrew/bin` 场景);②未装时「一键安装」按钮(内置终端自动执行 brew/winget/apt)。CLAUDE.md 红线 6、PRD 模块 A、02-STANDARDS 已同步,双端构建绿,DoD 分层 grep 全绿。
- 2026-07-07:全量代码生成(scaffold + server + client),本地 wrangler dev 验证通过,详见历史记录。
- 2026-07-08:AUTH_KEYS KV namespace 已建(id `e29c90eca9d24071b0777defbe61618d`),`remote: true` 已写入 wrangler.jsonc。
- 2026-07-08:`npx wrangler deploy` 成功,Worker 线上地址:`https://vibe-voice-worker.presley-us.workers.dev`。
- 2026-07-08:线上冒烟测试通过 —— 无 auth→401、假 key→403、错路径→404,均与本地 wrangler dev 行为一致。200(真实转写)路径留给用户在扩展内用真实录音验证,避免密钥经对话记录暴露。
- 2026-07-08:DoD 全项通过;顺手修复 docs/03-DOD.md 里一处检查命令的假阴性(双引号 `"zh"` 匹配不到源码里的单引号字符串,已改为 `= 'zh'`)。

## 下一步
1. (用户)VS Code 打开 `client/`,F5 起 Extension Development Host,`vibe.endpoint` 填 `https://vibe-voice-worker.presley-us.workers.dev`,用真实麦克风走通完整链路(200 路径)。
2. (已完成)首个 License Key 已通过 `npx wrangler kv key put` 下发至线上 KV。

## 阻塞
- 无硬阻塞。Windows/Linux 录音路径(dshow/pulse)代码就位但本机(macOS)无法实测。
