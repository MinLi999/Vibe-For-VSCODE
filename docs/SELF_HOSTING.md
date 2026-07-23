<p align="right"><a href="SELF_HOSTING.en.md">English</a> · <b>简体中文</b></p>

# 自托管指南

把整套 VibeFox 后端跑在你自己的 Cloudflare 账号上。个人使用免费版 Workers 就够（免费档引擎跑在 Workers AI 上；质量档需要你自己的阿里云 DashScope Key）。

## 前置条件

- 一个 Cloudflare 账号和 `wrangler` CLI（Node.js ≥ 22）
- 想用质量档还需要：[阿里云百炼国际版](https://www.alibabacloud.com/en/product/modelstudio) 的 API Key。DashScope 的 Key **按区域隔离**，你想服务哪个区就得申请哪个区的 Key：
  - 新加坡区 Key → 服务亚太用户，**同时也是流式转写唯一用到的 Key**
  - 美国（弗吉尼亚）区 Key → 服务其余地区用户（注意该区没有免费额度）

不配 DashScope Key 也能跑：所有请求会自动降级到免费链路（Workers AI Whisper + Llama）。

## 部署 Worker

```bash
cd server
npm install

# 1. 创建存 License Key 的 KV namespace,把返回的 id 填进 wrangler.jsonc
npx wrangler kv namespace create AUTH_KEYS

# 2. (质量档才需要)配置 DashScope 密钥 —— 密钥值绝不写进任何文件
npx wrangler secret put DASHSCOPE_API_KEY_APAC
npx wrangler secret put DASHSCOPE_API_KEY_US

# 3. 部署
npx wrangler deploy
```

不想记这些名字的话，`./scripts/secrets.sh`（list / set / delete）会列出每个 secret 的用途并代为调用 wrangler。

部署完会打印你的 Worker 地址，形如 `https://vibe-voice-worker.<account>.workers.dev`。

## 流式转写

流式（`/api/realtime`）**不需要额外凭据**，它复用 `DASHSCOPE_API_KEY_APAC`。仅新加坡区可用（国际版 realtime 端点没有美国区）。可选地设置 `DASHSCOPE_WORKSPACE_ID`（你的百炼 workspace id）来改用阿里推荐的专属域名，不设置就走共享域名。

端到端验证一个部署：

```bash
ffmpeg -f avfoundation -i :default -t 5 -ac 1 -ar 16000 -f s16le sample.pcm
node scripts/realtime-smoke.mjs https://<你的worker>.workers.dev <质量档LICENSE_KEY> sample.pcm
```

## 发放 License Key

鉴权就是拿 Key 去 KV 里查存在性，你自己发就行：

```bash
# 免费档(Whisper + Llama)
npx wrangler kv key put --binding AUTH_KEYS "你自己生成的key" '{"owner":"me"}' --remote

# 质量档(Qwen3-ASR + Qwen-Plus)
npx wrangler kv key put --binding AUTH_KEYS "你自己生成的pro-key" '{"owner":"me","plan":"pro"}' --remote
```

吊销用 `wrangler kv key delete`。限流按 Key 计：免费档 10 次/分，质量档 40 次/分（见 `wrangler.jsonc` 的 `unsafe.bindings`）。

## 把客户端指向你的 Worker

- **VS Code 扩展**：把 `vibefox.endpoint` 设成你的 Worker 地址（结尾不要斜杠），然后运行 **VibeFox: Set License Key** 填入你发的 Key。
- **桌面应用**：托盘菜单 →「凭据与服务地址」→「修改服务地址…」，然后在同一个菜单里设置 License Key。

## 本地开发

```bash
cd server
cp .dev.vars.example .dev.vars   # 填 Key,或者留空只测免费链路
npx wrangler kv key put --binding AUTH_KEYS "dev-test-key" '{"owner":"local"}' --local
npx wrangler dev
```

冒烟测试：不带 auth → 401，无效 key → 403，错误路径 → 404。

## 完全不部署服务端（BYOK）

不想跑 Worker 的话，把扩展的 `vibefox.apiProvider` 设成 `groq`、`openai`、`aliyun` 或 `custom`，转写与改写就会用你自己的 API Key 直连对应服务商。
