# Sparkle 自动更新与公证(macOS 原生 App)

> 依据 Obsidian `Skills/macOS-Distribution/Sparkle-and-Notarization-Pitfalls.md` 的通用踩坑清单落地。VibeFox 走**直分发**(DMG/zip + Sparkle),不上 Mac App Store——因为要读用户主目录下的配置/历史文件与钥匙串条目,App Sandbox 必须关,这与 MAS 互斥(踩坑 #4)。

## 一次性设置(两把互相独立的密钥)

**公证凭据**(Apple ID App 专用密码,notarytool 用)——**仍然需要**,和 Sparkle 签名 key 是两回事:
1. 去 [appleid.apple.com](https://appleid.apple.com) → 登录与安全性 → App 专用密码 → 生成一个;
2. 本地存一次(存在钥匙串,之后 `notarytool` 自动读取,不进代码库):
   ```bash
   xcrun notarytool store-credentials vibefox-notary \
     --apple-id <你的 Apple ID 邮箱> --team-id CFA9WX4496 --password <刚生成的 App 专用密码>
   ```

**Sparkle 签名 key**(EdDSA,给自动更新包签名用)——本地生成一次即可,所有 VibeFox 版本共用:
```bash
cd macos && ./tools/sparkle-bin/generate_keys
```
会弹一次系统钥匙串权限确认,点允许。私钥**只存在你登录钥匙串里,永不落盘、永不进 git**;终端会打印一行公钥。把这行公钥填进 `macos/scripts/Info.plist` 的 `SUPublicEDKey`(当前是占位符 `REPLACE_WITH_SPARKLE_PUBLIC_KEY`——公钥没填对时 Sparkle 会拒绝验证任何更新,失败方向是安全的,不会误装未签名的包)。

工具下载:
```bash
cd macos && mkdir -p tools && curl -sL https://github.com/sparkle-project/Sparkle/releases/download/2.9.5/Sparkle-2.9.5.tar.xz | tar -xJf - -C tools bin/generate_keys bin/sign_update bin/generate_appcast && mv tools/bin tools/sparkle-bin && xattr -cr tools/sparkle-bin/*
```
（这些是下载的第三方 CLI 工具，不进仓库——`tools/` 已在 `.gitignore`。）

## 已落地的防坑设计

| 踩坑 | 应对 |
|---|---|
| **#1 build number 不严格递增 → 更新器误判"已是最新"** | `CFBundleVersion` 不手填。`scripts/bump-build-number.sh` 用 UTC `YYYYMMDDHHMM`：只增不减、零状态、首次发布前没有 appcast 可读也能用。`CFBundleShortVersionString`（展示版本，当前 `0.2.0`）保持人工维护，纯展示用。 |
| **#2 一个 app 一个 appcast feed** | `SUFeedURL` 固定指向 `https://vibefox.app/appcast.xml`（VibeFox 专属域名下），`macos/appcast.xml` 是本地模板，不与任何其他项目共用签名 key 或 feed 文件。 |
| **#3 公证顺序：签名 → 公证 → staple → 签 appcast** | `scripts/make-app.sh --notarize` 按序执行；`--notarize` 结束后自动跑 `sign_update` 并把可直接粘贴的 `<item>` XML 打印到终端。 |
| **#4 App Sandbox 关闭 ⇒ 只能直分发** | 已确认（读钥匙串/主目录配置），entitlements 里没有 sandbox key，走 zip 直发。 |
| **#5 验证启动要用正常双击** | 本仓库所有冒烟测试改用未打包的 debug 二进制 + 精确 PID 清理（见 STATE.md 2026-08-12 记录），真机验证请直接双击 `VibeFox.app`，不要从沙盒 shell 里启动单实例守卫的正式 App。 |

## 发新版本的完整流程

```bash
cd macos
# 1. 改代码,提升 CFBundleShortVersionString(如需要,展示用,人工维护)
# 2. 一条命令:构建 + 签名 + 公证 + staple + Sparkle 签名 + 打印 appcast 条目
./scripts/make-app.sh --notarize
# 3. 把终端打印的 <item> 粘进 macos/appcast.xml(放最新的一条在最前面)
# 4. 把 build/VibeFox.zip 传到 https://vibefox.app/releases/VibeFox-<版本>.zip
#    (appcast 条目里的 enclosure url 要和实际上传路径一致)
# 5. 把更新后的 macos/appcast.xml 上传到 https://vibefox.app/appcast.xml
```

第 4、5 步依赖网站上线(用户独立负责),在此之前 `--notarize` 打包出的 zip 可以先手动分发（如直接发 GitHub Release），只是自动更新检测要等 appcast 真实可访问后才生效。

## CI 中的行为

`.github/workflows/ci.yml` 的 `macos` job 跑 `swift build && swift test && ./scripts/make-app.sh --skip-sign`——不签名、不公证、不需要任何密钥，只验证代码能编译、单元测试通过、App 能正常组装。签名与公证是本地/发布时的手动步骤，不在 CI 里自动执行（密钥只存在本机钥匙串）。
