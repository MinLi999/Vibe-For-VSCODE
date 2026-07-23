<p align="right"><a href="CONTRIBUTING.en.md">English</a> · <b>简体中文</b></p>

# 参与 VibeFox 开发

感谢帮忙！下面几条规矩能让这份代码保持容易理解。

## 项目结构

- `client/` —— VS Code 扩展。**严格 MVC+S 分层**（代码审查时会检查）：
  - `models/` —— 纯数据与状态。禁止 `vscode.window` / `vscode.commands`。
  - `viewer/` —— 只做 UI 渲染与读取。禁止 `fetch(`、`spawn(`，不放业务判断。
  - `services/` —— 只做 I/O（录音进程、HTTPS）。禁止调用 UI；**桌面端复用的那几个 service 里不能出现 `vscode` 导入**（`AudioRecorderService`、`CloudflareApiService`、`SystemPasteService`）。
  - `controllers/` —— 唯一可以同时触碰 M/V/S 的层。
- `server/` —— Cloudflare Worker。原生 fetch handler，各引擎在 `src/engines/` 下。
- `desktop/` —— Electron 菜单栏应用。直接 import `client/src/services` 与 `client/src/models`，所以那些文件必须保持与 vscode 无关。

## 硬性规则

1. **代码与注释一律英文。** 面向终端用户的产品文案可以是中文。内部设计文档（`docs/`）是中文，对外文档中英双语。
2. **仓库里不许出现任何密钥** —— 密钥走 `wrangler secret put` / `wrangler kv key put`，License Key 存在 VS Code SecretStorage 或 macOS 钥匙串里。改写提示词与模型 id 归服务端所有，API 永远不接受客户端传入的 prompt 或模型名。
3. **服务端绝不记录转写内容** —— 只记录引擎名、耗时、长度和原因码。
4. **不捆绑二进制**（ffmpeg/sox 的许可证风险），**不用 webview 录音**（VS Code 对 webview 的麦克风权限不可靠）。

## 提 PR 之前

```bash
cd client  && npm run typecheck && npm run compile && npm test
cd server  && npm run typecheck && npm test
cd desktop && npm run typecheck && npm run compile
```

CI 跑的就是这些。改动了纯逻辑请补测试（用 vitest，风格参考 `server/src/nonspeech.test.ts` 和 `client/src/models/TranscriptDedupe.test.ts`）。

## 适合新人上手的任务

- 在真机上测试 Windows/Linux 的采集路径（dshow/pulse）—— 代码写好了但从没在真实机器上验证过。
- 复现或修复标记为 `help wanted` 的 issue。

## Commit 规范

用 conventional-commit 前缀（`feat:`、`fix:`、`docs:`…）。**Commit message 用英文**（开源项目的历史要让所有人读得懂）。
