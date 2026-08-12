# VibeFox Mac 语音输入法 —— 竞品调研与产品化方案(2026-08-08,待用户确认)

> 状态:**调研完成、方案待拍板,未编码**。目标 = 把 `desktop/`(VibeFox.app)从「托盘工具」升级为完整的 Mac AI 语音输入法产品,对标 Typeless / Wispr Flow / Superwhisper。
> 调研范围:Typeless、Wispr Flow、Superwhisper、Willow Voice、Aqua Voice、VoiceInk(开源)、讯飞输入法、Apple 原生听写。竞品原始调研数据见本文档末尾"调研底稿"章节链接说明。

## 0. 一句话结论

**形态不用改,外壳全要补。** 全行业(Typeless/Wispr/Superwhisper/VoiceInk)没有一家用 macOS IMKit 输入法框架,统一形态就是「菜单栏 App + 全局热键 + 文本插入」——现有 desktop 架构方向完全正确。差距在产品化五件套:**设置 App 窗口 UI、三层大词库、录音 HUD、逐场景排版规则、Onboarding 向导**。技术栈留在 Electron(复用 client 服务与 Worker,服务端零改动),按住说话/Fn 键需一个小的原生监听补丁。

## 1. 形态判断(先排除错误方向)

- **不做 IMKit 输入法**:真正注册成 macOS 输入法(出现在系统输入法菜单里)的方案没有任何竞品采用——IMKit 面向逐键组字(拼音/日文),与"按热键说一段→插入整段文本"的交互模型不匹配,且失去改写/排版的介入点。
- **业界标准 = 现有形态**:菜单栏常驻 + 全局热键(Typeless 默认 **Fn 键**)+ 录音 → 云端 ASR+LLM → 粘贴/键入到前台 App 光标处。VibeFox desktop 的 ⌘⌥Z + 剪贴板 ⌘V + 恢复剪贴板管线已经是这个形态。
- **插入方式演进(调研项,非 MVP)**:竞品多数也是模拟粘贴;可评估 AX(Accessibility)API 直接写入以减少剪贴板抖动,失败回落 ⌘V。现有"约 1s 后恢复原剪贴板"先保留。

## 2. 与竞品的差距清单(Mac 端逐项对照)

### 2.1 现在就有、且不落后的
- 双热键语义(点按=开关,按住=对讲,client 端已有;desktop 只有点按,见 §2.3-F)
- 改写三档 + 中文四变体 + 区域路由;**前台 App 感知 tone hint(appCategory)已实现**——这正是 Typeless 用户最高频抱怨"只有黑盒自动版"的功能的底座
- 转写历史(仅本机)、流式转写(M3 已接,partial 托盘尾巴)
- License Key 钥匙串 + BYOK + 自托管——全品类唯一开源

### 2.2 必须补的(行业标配,现在缺失)

| # | 功能 | 竞品参照 | 现状 |
|---|---|---|---|
| A | **设置 App 窗口**(完整 UI,不再靠托盘菜单+手编 config.json) | 全部竞品 | 只有托盘菜单 + AppleScript 输入框 |
| B | **词库系统与词库 UI**(搜索/编辑/来源标记/删除) | Wispr Dictionary(✨AI 建议、👤通讯录)、Typeless Dictionary tab | config.json `vocabulary` 数组,无 UI |
| C | **Replacements 文本替换 + Snippets** | Superwhisper 双轨制、Wispr Snippets;**Typeless 没有 Snippets(可反打)** | 无 |
| D | **录音 HUD**(悬浮波形条 + 流式 partial 预览) | Wispr 屏幕底部胶囊、Typeless 波形 | 托盘字符电平表(▁▃▅),存在感太弱 |
| E | **Onboarding 向导**(权限/热键/练习场) | Typeless:麦克风实测蓝条→三热键确认→内嵌功能演练 | 无,首次体验全靠 README |
| F | **按住说话 + Fn 键支持** | Typeless 默认 Fn;竞品普遍支持 hold-to-talk | Electron `globalShortcut` 无 keyup/Fn 事件,desktop 只有点按 |
| G | **用量统计**(字数/WPM/节省时间) | Typeless ROI 数据是其传播素材;Wispr 500 词解锁统计 | 无 |
| H | **逐 App 规则 UI**(用户可覆盖的场景规则) | Superwhisper/VoiceInk 配置派;Typeless 只有推断派且被用户狂骂 | appCategory 只有自动推断,无用户覆盖 |
| I | **手改回学 + 通讯录导入**(词库自动生长) | Typeless Auto-added、Wispr Auto-add + 通讯录 | 无 |

### 2.3 竞品的坑,避开
- **Typeless**:6 分钟录音上限强制断流(我们 600s + VAD 分段天然免疫);过度改写乱补内容(我们 prompt 红线已有);闭源隐私逆向争议(采集窗口标题/剪贴板)——我们隐私页要把"读了什么、传了什么"写死并链接源码。
- **Wispr**:剪贴板/长录音丢字投诉——我们"插入前先记历史"已规避;客服黑洞——开源 issue 通道天然解决。
- **Superwhisper**:上手陡峭(模式系统太复杂)——我们场景预设开箱即用,高级配置藏进二级页。
- **VoiceInk**(同为开源,最直接的对照):它的 Power Mode(按前台 App/网站切模式、粘贴后自动回车)是 §2.2-H 的现成范本;但它 Mac-only 无云端质量档、无中文优化——我们的差异化仍然成立。

### 2.4 能做得比所有人好的
1. **中文/中英混杂精度**(Qwen3-ASR;Typeless 被中文用户实测"中文识别偏弱")。
2. **中文长口述自动结构化排版**(市场空白,rewrite 档规则 7 已是雏形,升级为场景预设)。
3. **推断+配置混合的逐 App 规则**(Typeless 用户第一需求,它做不了,我们底座已有)。
4. **开源 + BYOK + 自托管 + 无广告**(讯飞广告差评、Typeless 年费近千元的国产替代情绪都是流量)。

## 3. 词库设计(重点:「足够大」)

行业共识与本项目红线一致:直接喂 ASR 的词表必须小(Superwhisper 官方警告"加太多词干扰识别";本项目 keywords ≤40 + isContextEcho guard 是 2026-07-12 事故的回归防线)。"足够大"与"≤40"用**三层架构**调和:

```
用户词库(容量目标 ≥5,000 条,本地存储 + 导入导出;与 VS Code 端 personalDictionary 互通)
│  词条:{ 词面, 别名(常被误识成的样子,可多个), 来源(手动/回学✨/通讯录👤), 场景标签, 最近使用, 命中次数 }
│
├─ L1 ASR 偏置层:每次请求动态选 ≤40 词
│    打分 = 场景标签匹配(appCategory)+ 最近使用 + 命中频率
│    → 走现有 keywords 通道(Qwen3-ASR system 实体词表),isContextEcho guard 不动
│
├─ L2 改写校正层:相关子集,几十~几百词
│    客户端按发音/拼音相似度检索 rawText 中的可疑误识(rawText 含"克劳德"、词库有 "Claude")
│    → 只把命中的「误识样子 → 正确写法」词条对发给 Qwen-Plus 改写阶段
│    → 词库总量再大,单次请求 token 成本恒定
│
└─ L3 确定性替换层(Replacements + Snippets,容量无上限)
     转写返回后本地字符串/正则替换,零 token、离线执行
     适合:邮箱、@符号、术语强制大小写、语音触发短语展开
```

**收词管道(词库自己长大)**:
1. 转写完成通知带「加入词典」快捷action(HUD 上一键收词);
2. **手改回学**:粘贴后短窗口内监测剪贴板/前台文本对我们刚插入文本的修改(实现细节调研项),diff 出的词条进「建议收件箱」,下次打开设置 App 以卡片确认入库(带 ✨ 标记,**不静默入库**);
3. 通讯录导入(macOS Contacts 权限,👤 标记,人名是中文误识重灾区);
4. VS Code 端 `personalDictionary` ↔ desktop 词库:导入/导出 JSON 打通(远期 Worker 账号同步需先解决隐私承诺表述,单独立项)。

## 4. 输出排版(重点:「有条理、第一眼可识别」)

在 off/clean/rewrite 三档之上,把「排版场景」升为一级公民,**推断保底 + 用户覆盖**:

- **场景预设**(desktop 已有 appCategory 推断,补用户覆盖矩阵):
  - `聊天`(Claude/微信/Slack):短句、口语标点、不列表化;
  - `笔记/待办`(Notes/Obsidian/Bear):激进结构化——要点自动成列表、长段自动分段、可选自动小标题;
  - `邮件/正式`(Mail/Outlook):分段 + 敬语(复用 withAppTone);
  - `编程/终端`(IDE/Terminal):现状,标识符保真 + developer-mode 符号规则。
- **逐 App 覆盖 UI**:设置 App 里一张「App → 场景/改写档/自动回车」映射表(VoiceInk Power Mode 范本);bundle id 探测链路(frontmostApp.ts)已就绪。
- **HUD 临时切换**:录音时 HUD 上可点场景胶囊临时覆盖本次(Wispr Quick Style Switcher 的桌面版)。
- 服务端:`appCategory` 白名单扩展 `notes` 场景 + 结构化排版指令(新增 prompt 规则,clean 档契约不动)。

## 5. 设置 App UI(四 Tab)与 Onboarding

**窗口结构**(菜单栏点击/热键唤出,BrowserWindow):
1. **首页**:今日/累计统计(字数、次数、估算节省时间)+ 历史列表(按日分组、搜索、点击复制、保留时长设置);
2. **词库**:搜索 + 分段(全部/手动/建议✨/通讯录👤/替换规则/Snippets)+ 建议收件箱卡片;
3. **风格**:场景预设矩阵 + 逐 App 覆盖表 + 改写三档 + 中文四变体 + 语言;
4. **设置**:热键(录音/取消,含按住语义开关)、License Key 与 BYOK/自托管 endpoint(现有凭据菜单迁入)、录音(最长时长/VAD/麦克风选择)、流式开关、隐私页(历史仅本机、读了什么传了什么、源码链接)、检查更新。

**Onboarding 向导**(首启一次,可从帮助重进,对标 Typeless 流程):
欢迎页(30 秒演示:中英混杂口述 → 结构化文本)→ 麦克风授权 + **实测蓝条**(说话看电平,授权失败给手动指引)→ 辅助功能授权(解释为什么要:模拟 ⌘V;含"已授权 ✓"实时检测,现有托盘引导迁入)→ 热键确认与试按 → **内置练习场**(App 内文本框,预置 3 条练习句:纯中文/中英混杂/口述列表,首次成功发生在受控环境)→ 词库快速导入(通讯录/粘贴术语列表,可跳过)。首次真实转写成功后 HUD 冒「加入词典」教学气泡;累计 500 词解锁统计页(留存钩子)。

## 6. 技术方案要点

- **纯原生 SwiftUI(2026-08-08 用户拍板,推翻本文初版的"留在 Electron"结论)**:新建 `macos/` Swift Package(SPM,无 Xcode 工程文件,`swift build` + `scripts/make-app.sh` 出签名 .app)。理由:真原生质感、内存 ~30MB、Fn/按住说话原生可达、**AVAudioEngine 录音彻底甩掉 ffmpeg 装机负担**(产品最大安装摩擦消失)。代价:录音/API/流式管线 Swift 重写,与 client TS 服务不再共享代码——但**数据文件(config/dictionary/history/stats.json)与钥匙串条目、协议 v2 完全同构**,服务端零改动,Electron 版保留至原生达到 parity 后退役。bundle id 沿用 `com.vibefox.desktop` + 同一 Developer ID 证书,TCC 授权(麦克风/辅助功能)跨实现继承。协议 v2 新增 `audioFormat: mp3|m4a|wav`(默认 mp3 向后兼容),原生端上传 32kbps AAC/m4a。
- **Fn 键与按住说话**:Electron `globalShortcut` 无 keyup/Fn。方案 = `uiohook-napi`(全局事件钩子,MIT)或小型 Swift helper(CGEventTap,辅助功能权限已具备)。client 端双语义热键状态机(点按=开关/按住=对讲)逻辑可移植。
- **HUD**:frameless + transparent + alwaysOnTop + 不抢焦点(`focusable:false`)的小窗,屏幕底部居中;显示波形、流式 partial 尾巴、场景胶囊、「加入词典」气泡。**注意不抢焦点是硬要求**(否则粘贴目标丢失)。
- **词库存储**:`~/Library/Application Support/VibeFox/dictionary.json`(词条结构见 §3),与 config.json 分离;导入导出 JSON。
- **手改回学**:实现机制需 spike(候选:粘贴后 N 秒轮询 AX 读取前台文本框值做 diff / 剪贴板监听;隐私敏感,默认关,设置页明示)。

## 7. MVP 分期

- **M-A 设置窗口 + 词库(2~3 周)**:四 Tab 窗口、词库 CRUD UI + L1/L3 层接入管线、凭据/历史/统计迁入、Onboarding 向导(权限+热键+练习场)。→ 这一步就把"托盘工具"变成"产品"。
- **M-B HUD + 按住说话(1~2 周)**:悬浮波形 HUD(含流式 partial)、uiohook/Fn 键、HUD 一键收词。
- **M-C 词库完全体 + 场景规则(2 周)**:L2 改写校正层、通讯录导入、手改回学建议收件箱、逐 App 覆盖表 + `notes` 场景服务端 prompt。
- **M-D 打磨**:统计页完全体、Snippets 富文本、AX 直接插入 spike、自动更新(Phase C 既有项合并)。
- 发布纪律不变:不经用户要求不分发、不提交不推送。

## 8. 风险清单

1. **手改回学的隐私面**:读前台文本框内容属敏感能力,默认关 + 设置页明示 + 开源可审计;绝不能默默开。
2. **uiohook-napi 原生依赖**:Electron 43 ABI 兼容性需先 spike;失败回退 Swift helper 子进程。
3. **HUD 抢焦点**:macOS 上 focusable:false + panel 类型窗口需真机验证各目标 App(尤其全屏 App)下不干扰粘贴。
4. **免费档限额**:桌面高频使用下现有 free 10 次/分是否要叠加词量/周限额(Wispr 2,000 词/周、Typeless 8,000 词/周),商业化时重估。
5. **词库上云与隐私承诺**:现有承诺"历史绝不上云";词库同步先本地导入导出,账号级同步单独立项再议。

---

*调研底稿:三份原始调研(Typeless 深挖 / 六竞品横评含讯飞豆包 / iOS 键盘扩展可行性)完成于 2026-08-08 会话内;iOS 方向经用户澄清不做,其结论(键盘扩展不可直录、容器 App 保活架构)留档于会话记录,未来若做 iOS 再取用。*
