# Vibe Coding Voice Input(闭源)

按 `Ctrl+Shift+Space` 说话(中文优先),转写文本插入 Claude Code / Cline / Copilot Chat 或活动编辑器。

## 前置条件

1. **ffmpeg**(系统安装,不捆绑):
   - macOS:`brew install ffmpeg`,并在 系统设置 → 隐私与安全性 → 麦克风 中允许 VS Code
   - Windows:`winget install Gyan.FFmpeg`
   - Linux:`sudo apt install ffmpeg`(pulse 输入)
2. **服务端**:部署 `server/` 的 Cloudflare Worker,把 URL 填进 `vibe.endpoint`。
3. **License Key**:命令面板 → `Vibe: Set License Key`(存 SecretStorage,不进设置文件)。

## 使用

| 操作 | 方式 |
|---|---|
| 开始/停止录音 | `Ctrl+Shift+Space` 或点状态栏 `$(mic) Vibe` |
| 取消录音 | 录音中按 `Esc` |
| 插入位置 | `vibe.insertTarget`:`auto`(编辑器光标→活动终端→剪贴板)/`editor`/`terminal`/`clipboard` |

说明:
- **Claude Code CLI**(跑在终端里)可直接注入:焦点不在编辑器时 `auto` 会走 `terminal.sendText`。
- **Copilot Chat / Cline** 的 webview 输入框没有跨扩展写入 API:结果会进剪贴板并提示粘贴。
- 代码词汇准确性:默认开启 `vibe.contextHint`,自动把当前文件 top-40 标识符 + 最近文件名注入 Whisper 提示词。
- ⚠️ Windows/Linux 上 `Ctrl+Shift+Space` 与内置「触发参数提示」冲突,可在 Keyboard Shortcuts 里改绑其一。

## 开发

```bash
npm install
npm run typecheck && npm run compile   # dist/extension.js
npm run watch                          # 开发监听
npm run package                        # .vsix(不发布 marketplace)
```

调试:VS Code 打开 `client/`,F5 启动 Extension Development Host。
