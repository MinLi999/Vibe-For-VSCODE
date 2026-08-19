# Security Policy

## Reporting a vulnerability

Please use GitHub's **[private vulnerability reporting](https://github.com/MinLi999/VibeFox/security/advisories/new)** (Security tab → "Report a vulnerability") instead of a public issue. This lets us discuss and fix the problem before details become public.

We'll acknowledge reports on a best-effort basis — this is a solo-maintained project, not a company with an SLA. Please include:

- What you found and how to reproduce it
- Which component: the macOS app (`macos/`), the Worker backend (`server/`), or a self-hosted deployment
- Impact, if you can assess it (e.g. "extracts another user's transcript" vs. "crashes the app")

## Scope

**In scope:**
- Authentication/authorization bypass on the Worker (`server/`) — reading or using another user's quota, credentials, or transcripts
- Any path that leaks a License Key, API key, or DashScope secret — client-side or server-side
- Memory-safety or injection issues in the native app or Worker
- Supply-chain issues in this repo's own code or CI configuration

**Out of scope:**
- Vulnerabilities in upstream dependencies — report those to the dependency's own maintainers (Dependabot already tracks known CVEs here)
- Vulnerabilities in Cloudflare, Alibaba Cloud DashScope, Groq, or OpenAI's own infrastructure — report those to the provider directly
- Issues that require an already-compromised device or a stolen License Key (the threat model assumes the device and keychain are trusted)
- Self-hosted deployments misconfigured by the person running them (e.g. a self-issued License Key shared publicly)

## Design notes relevant to security review

If you're auditing this codebase, a few things worth knowing up front:

- **Provider API keys never reach any client.** Qwen/DashScope credentials live only as Cloudflare Worker secrets (`wrangler secret put`), never in source, never in a response body. The native app only ever holds, in the macOS Keychain: a License Key you were issued, or a BYOK provider key you typed in yourself.
- **The Worker never logs transcript content** — only engine name, timing, length, and a reason code.
- **Rewrite prompts and model selection are server-owned.** The API does not accept a client-supplied prompt or model name, closing off a class of billing-abuse and prompt-injection attempts.
- **Auth is a License Key existence check against a KV namespace** (`Authorization: Bearer <key>`), rate-limited per key (free: 10 req/min, quality tier: 40 req/min) with an additional monthly audio-duration quota to bound worst-case cost from a single leaked key.

Source code for both the app and the backend is public (AGPL-3.0) specifically so this can be verified independently rather than taken on trust.

---

# 安全策略

## 上报漏洞

请通过 GitHub 的 **[私密漏洞上报](https://github.com/MinLi999/VibeFox/security/advisories/new)** 功能(Security 标签页 →「Report a vulnerability」),不要发公开 issue——这样能在细节公开之前先讨论修复。

这是个人维护的项目,不是有 SLA 的公司,我会尽力及时处理,但不承诺具体时限。请尽量包含:

- 发现了什么、怎么复现
- 涉及哪部分:macOS App(`macos/`)、Worker 后端(`server/`),还是自托管部署
- 影响面(如果你能判断的话):比如"能读到别人的转写内容" vs "让 App 崩溃"

## 范围

**算数的:**
- Worker(`server/`)上的鉴权绕过——读取或盗用别人的配额、凭据、转写内容
- 任何会泄露 License Key、API Key 或 DashScope 密钥的路径(客户端或服务端)
- 原生 App 或 Worker 里的内存安全 / 注入类问题
- 本仓库自身代码或 CI 配置里的供应链问题

**不算数的:**
- 上游依赖库本身的漏洞——请直接报给对应依赖的维护者(Dependabot 已经在跟踪已知 CVE)
- Cloudflare、阿里云 DashScope、Groq、OpenAI 自家基础设施的漏洞——请直接报给对应服务商
- 需要设备已被攻破或 License Key 已被盗用才能利用的问题(威胁模型默认设备与钥匙串本身可信)
- 自托管用户自己配置不当导致的问题(比如自己发的 License Key 被公开分享出去)

## 供审计参考的设计要点

如果你在审计这份代码,几件事提前说明:

- **服务商 API Key 从不会到达任何客户端。** 千问/DashScope 的凭据只以 Cloudflare Worker secret 形式存在(`wrangler secret put`),不进源码,不进任何响应体。原生 App 的 macOS 钥匙串里只会存两种东西:分发给你的 License Key,或者你自己填入的 BYOK 服务商 Key。
- **Worker 从不记录转写内容**——只记引擎名、耗时、长度和原因码。
- **改写提示词与模型选择归服务端所有。** 协议不接受客户端传入 prompt 或 model 名,堵住了一类计费滥用与提示词注入的路子。
- **鉴权是对 KV namespace 的 License Key 存在性检查**(`Authorization: Bearer <key>`),按 key 限流(免费档 10 次/分,质量档 40 次/分),外加每月音频时长配额,把单把 Key 泄露的最坏成本圈定在有限范围内。

App 与后端源码均公开(AGPL-3.0),就是为了让上面这些说法能被独立验证,而不是只能选择相信。
