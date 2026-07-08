---
name: deploy
description: Deploy the Cloudflare Worker and package the VS Code extension (.vsix). Manual-only release.
disable-model-invocation: true
allowed-tools: Bash
---
# 发布(仅用户明确要求时运行)

## 前置
1. /dod 全部通过。
2. `server/wrangler.jsonc` 里 AUTH_KEYS 的 KV namespace `id` 已填真实值(`npx wrangler kv namespace create AUTH_KEYS` 获取)。

## 步骤
```bash
# 1. Worker
cd server && npx wrangler deploy && cd ..

# 2. 发放/轮换 License Key(值绝不进源码)
# npx wrangler kv key put --binding AUTH_KEYS "<key>" '{"owner":"<who>","plan":"pro"}' --remote

# 3. 扩展打包(不发布 marketplace)
cd client && npm run package && cd ..
ls client/*.vsix
```

## 收尾
- 冒烟:curl 已部署端点(无 auth→401,真 key + 微型 mp3 → 200 text)。
- 更新 docs/STATE.md(版本、日期、KV namespace 状态)。
