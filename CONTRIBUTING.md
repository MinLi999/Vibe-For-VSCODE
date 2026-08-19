<p align="right"><a href="CONTRIBUTING.en.md">English</a> · <b>简体中文</b></p>

# 参与 VibeFox 开发

感谢帮忙！下面几条规矩能让这份代码保持容易理解。

## 项目结构

- `macos/` —— 原生 SwiftUI App（Swift Package Manager），`VibeFoxCore` 库 + `VibeFox` App。
- `server/` —— Cloudflare Worker。原生 fetch handler，各引擎在 `src/engines/` 下。
- `shared/fixtures/` —— server 与 macos 共用的跨实现契约测试数据（JSON），防止同一逻辑（如 nonspeech 过滤）在两端悄悄漂移。

## 硬性规则

1. **代码与注释一律英文。** 面向终端用户的产品文案可以是中文。仓库里的 `.md` 文档除本文件、`README.md`/`README.en.md`、`docs/SELF_HOSTING.md`/`.en.md` 外均为作者私人工作笔记，不进版本控制。
2. **仓库里不许出现任何密钥** —— 密钥走 `wrangler secret put` / `wrangler kv key put`，License Key 存在 macOS 钥匙串里。改写提示词与模型 id 归服务端所有，API 永远不接受客户端传入的 prompt 或模型名。
3. **服务端绝不记录转写内容** —— 只记录引擎名、耗时、长度和原因码。
4. **不捆绑二进制**（第三方许可证风险）。

## 提 PR 之前

```bash
cd server && npm run typecheck && npm test
cd macos  && swift build && swift test
```

CI 跑的就是这些。改动了纯逻辑请补测试（server 用 vitest，风格参考 `server/src/nonspeech.test.ts`；macos 用 Swift Testing）。

## 适合新人上手的任务

- 复现或修复标记为 `help wanted` 的 issue。

## Commit 规范

用 conventional-commit 前缀（`feat:`、`fix:`、`docs:`…）。**Commit message 用英文**（开源项目的历史要让所有人读得懂）。
