# VibeFox Desktop —— Claude App 语音输入法(macOS menu bar 应用)

把 VibeFox 的语音转写管线带出 VS Code:按全局热键说话,转写结果自动粘贴进**当前前台应用**的光标处 —— 首要场景是 Claude 桌面 App 的聊天框,同样适用于任何文本输入框。

与 VS Code 扩展**完全同源**:直接复用 `client/src/services/` 的录音与 API 服务、同一个 Cloudflare Worker、同一把 License Key、同一套改写档位(off/clean/rewrite)与中文变体。

## 运行方式一:正式 App(推荐)

打包成 `VibeFox.app`,双击启动、可从启动台/聚焦打开,权限授一次长期有效:

```bash
cd desktop
npm install        # 首次
npm run dist       # 产出 release/mac-arm64/VibeFox.app(不压缩 + arm64 ad-hoc 签名)
```

把 `release/mac-arm64/VibeFox.app` 拖进 `/Applications` 即可。菜单栏出现**麦克风图标**。首次启动 Gatekeeper 可能拦截(ad-hoc 未公证):右键图标 → 打开 → 确认一次即可。

> 注意:esbuild `--production` 压缩会导致打包后的 App 启动即崩溃(已实测),故 `dist` 脚本刻意**不压缩**。

## 运行方式二:开发模式

```bash
cd desktop
npm install
npm start          # 编译并用开发版 electron 直接跑(菜单栏出现麦克风图标)
```

## 首次使用(macOS 权限,一次性)

1. **麦克风**:第一次录音会弹系统授权(授权对象是 Electron/VibeFox),点允许。
2. **辅助功能**(自动粘贴需要):点菜单栏 🦊 →「**授予辅助功能权限…**」——它会把本进程注册进权限列表并弹授权框(未打包的 Electron 只有调用过这个 API 后才会出现在列表里,所以直接去设置里「找不到 Electron」是正常的)。在弹出的面板里勾选 **Electron** 即可。
   - 备选(手动添加):设置面板里点「+」,按 `⌘⇧G` 输入路径 `desktop/node_modules/electron/dist/Electron.app` 选中添加。
   - 没授权时:热键能录音转写,但粘不进 Claude App,文字留在剪贴板,可手动 ⌘V。
3. **License Key**:点菜单栏 🦊 →「设置 License Key…」,输入后存入系统钥匙串。
4. **ffmpeg**:与扩展共用系统 ffmpeg(`brew install ffmpeg`);探测顺序 = 配置 `ffmpegPath` → PATH → Homebrew 常见路径。

## 使用

- `Command+Alt+Z`(即 ⌘⌥Z,可在配置文件改 `hotkey`):按一下开始录音(菜单栏变 🔴 并显示实时电平),再按一下停止并转写粘贴。默认避开了 macOS 系统保留键(如 ⌃⌥Space=切换输入法、⌘Space=Spotlight)——这些即使注册"成功"也会被系统吞掉。
- VAD 默认开启:长段口述会按停顿自动切段、边说边逐段粘贴(与扩展行为一致,段落按口述顺序串行插入)。
- 托盘菜单:改写模式 / 中文变体 / 转写区域三个子菜单即点即生效;「打开配置文件」可改热键、VAD、录音上限等全部参数(改完重启生效)。
- 结束后菜单栏短暂显示 `🦊✓N`(本次插入字符数)。

## 配置文件

`~/Library/Application Support/VibeFox/config.json`(首次启动自动生成完整默认值)。License Key 不在此文件 —— macOS 存钥匙串,其他平台存同目录 `license.key`(0600)。

### 让它认识程序员英文(自定义词表)

桌面版没有 IDE 工作区可挖,所以靠 `config.json` 里的两个字段把「代码英文」喂给改写阶段:

- **`vocabulary`**(字符串数组,已内置一份种子词表):列上你常口述、但 ASR 容易听错/大小写弄错的词 —— 产品名、技术栈、函数名、驼峰标识符。改写阶段**只会按这份词表还原**大小写与拼写(如口述「use effect」→ `useEffect`);不在表里的英文按 ASR 原样保留。上限 40 条、每条 ≤64 字符,直接往数组里加你项目的高频词即可。
- **`projectContext`**(一段自由文本):给改写模型的背景提示(不会被输出),默认是一句通用的「程序员在口述编程指令」框架;若你主要为某一个代码库口述,可换成描述那个项目的段落。上限 8000 字符。

改完重启 App 生效。

## 已知边界

- 热键刻意**不用** `Ctrl+Shift+Space`:全局热键系统级独占,会把 VS Code 扩展的同名热键吞掉。
- 粘贴目标 = 触发停止那一刻的前台应用;录音中途切换应用,后续分段会粘到新前台应用,录音时保持目标窗口聚焦即可。
- Windows/Linux 代码路径就位(SendKeys / xdotool)但未实测。
- 打包成独立 VibeFox.app(electron-builder + 签名/公证)尚未做,当前用 `npm start` 运行。
