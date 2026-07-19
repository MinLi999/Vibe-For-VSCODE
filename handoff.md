# VibeFox 交接文档(handoff.md)

> 這份文檔專門為「換一個對話視窗 / 換一個 AI 接手」而寫,目的是讓接手者不用重新翻整個對話紀錄就能知道:我們做了什麼、現在什麼狀態、有什麼還沒解決。
>
> **深度細節請看 `docs/` 目錄**(這份文檔是導覽,不是取代):
> - `docs/STATE.md` —— 逐次會話的完整變更記錄(最詳細,含每個 bug 的根因分析)
> - `docs/01-PRD.md` —— 業務需求與功能矩陣
> - `docs/02-STANDARDS.md` —— 技術規範與權威數值
> - `docs/03-DOD.md` —— 交付前自查清單
> - `CLAUDE.md` —— 項目硬規則(密鑰紅線、分層紅線等,AI 接手第一件事就該讀這個)
>
> **接手時的建議順序**:先讀本文件抓大局 → 讀 `CLAUDE.md` 抓硬規則 → 讀 `docs/STATE.md` 最上面幾條抓最新進度 → 需要時再深入其他文檔或原始碼。

最後更新:2026-07-18

---

## 一、這是什麼項目

VibeFox —— 語音「Vibe Coding」輸入。按熱鍵說話(中文優先、中英混雜),透過 Cloudflare Worker 轉寫+改寫成乾淨文字,插入 LLM 聊天輸入框或活動編輯器。目標是做成訂閱制產品,賣點是「中英混雜 vibe coding 場景」的口述準確度和項目上下文理解,對標 Wispr Flow、Aqua Voice。

**現在有兩個前端,共用同一個 Worker 後端 / License Key / 改寫檔位:**
1. **VS Code 擴展**(`client/`,`Ctrl+Shift+Space`):結果插入 Claude Code / Cline / Copilot Chat 的聊天框或活動編輯器。
2. **桌面 App**(`desktop/`,`⌘⌥Z`,2026-07-18 新增):Electron 菜單欄應用,把轉寫結果粘進**任何前台應用**的光標處——首要場景是 **Claude 桌面 App** 的聊天框,也適用於瀏覽器/備忘錄等。這是把 VibeFox 做成「系統級語音輸入法」的方向。

技術棧:
- **client**(`client/`):TypeScript,VS Code Extension,esbuild 打包,零運行時依賴,嚴格 MVC+S 分層。
- **desktop**(`desktop/`):TypeScript,Electron menu bar 應用,esbuild 打包,**直接 import 複用 `client/src/services/` 的錄音與 API 服務**(那三個服務零 vscode 依賴,是分層清零的紅利)。用 electron-builder 打包成 `VibeFox.app`,以用戶的 **Developer ID 證書**簽名。
- **server**(`server/`):TypeScript,Cloudflare Worker(native fetch handler),部署地址 `https://vibe-voice-worker.presley-us.workers.dev`。

---

## 二、目前的架構(單引擎,2026-07-13 定案)

**質量檔**(license KV metadata `plan:"pro"`)—— 全程走阿里雲 DashScope:
- **ASR**:Qwen3-ASR(`qwen3-asr-flash` 新加坡 / `qwen3-asr-flash-us` 美國,依 `request.cf.continent` 自動路由或用戶手動指定區域)
- **改寫**:Qwen-Plus(唯一質量檔改寫引擎,2026-07-13 從「Qwen+Haiku 雙引擎」簡化成單引擎——原因是用戶决定用 Qwen 就好,便宜、且能複用 ASR 已有的區域 key)
- 兩者失敗都降級到 CF Whisper(`@cf/openai/whisper-large-v3-turbo`)+ CF llama(`@cf/meta/llama-3.1-8b-instruct`)

**免費檔**:CF Whisper + CF llama。

**歷史注意**:早期版本(以及部分舊 commit message)提到過 Claude Haiku 4.5 改寫引擎和一個 Haiku vs Qwen 對比評估功能(`rewriteCompareEnabled`)——**這兩個都已經在 2026-07-13 被用戶明確要求移除**(見下方「近期完成」)。如果你在舊文檔或註釋裡看到 Haiku/Anthropic/compareRewrite 的痕跡,那是歷史遺留描述,不是當前行為;當前代碼已無 Anthropic 依賴。

---

## 三、密鑰與部署現狀

- **需要的密鑰**(`wrangler secret put <NAME>`,線上已配置):
  - `DASHSCOPE_API_KEY_APAC`(新加坡區,阿里雲國際版 Model Studio)
  - `DASHSCOPE_API_KEY_US`(美國/Virginia 區,注意**該區沒有免費額度**,需已開通計費)
  - ~~`ANTHROPIC_API_KEY`~~ ——已不再使用,可以 `wrangler secret delete ANTHROPIC_API_KEY`(還沒刪,不影響功能,純粹是清理)
- **重要事實(已查證,決定了路由設計)**:`qwen3-asr-flash` 國際版**只在新加坡+美國兩區提供**,東京、法蘭克福官方文檔明確標註「Not supported」,香港有域名但 ASR 可用性無文檔。所以現在的 `auto`(按大洲)/`apac`/`us` 三選一,已經是阿里雲國際版能給的完整集合——不要再花時間research「加更多區域」,這條路已經走到頭了。
- **中國大陸策略(已研究,結論是「暫不做」)**:真正的障礙不是 API key,是 ①Cloudflare Worker 在大陸被墻/極慢 ②北京區需要中國企業實體+ICP備案。決定:v1 不服務大陸,插件本身不用分兩個版本;將來要做,需要在國內獨立部署一套平行後端(阿里雲函數計算/騰訊雲)+ 北京區 key + ICP,插件加一個服務器區域端點切換即可。
- **部署命令**:`cd server && npx wrangler deploy`(本機 Node 是 v20,wrangler 4 需要 Node ≥22——已在 scratchpad 放了一份 Node 22 二進制,見對話歷史,或自行 `nvm install 22`)。
- **打包擴展**:`cd client && npm run package` 產出 `.vsix`。

---

## 四、⚠️ 尚未解決的問題(最重要,不要漏看)

### 間歇性「有聲音卻轉寫成空」—— 根因還沒抓到

**現象**:用戶錄音時狀態欄的即時麥克風電平表有明顯反應(證明麥克風真的採集到了聲音),錄了 30-80 秒不等,轉寫卻返回「未偵測到語音」502。不是每次都發生,同一個人同樣環境,下一次錄音又正常。

**已排除的可能性**(靠加日誌診斷一步步排除的,不要重複繞這些彎路):
1. ~~麥克風完全沒採集到聲音~~——客戶端已加 `capturePeak` 診斷欄位隨請求上報,實測抓到 `capture_peak=8099`(遠高於靜音閾值 80),證明採集端確實有響亮的真實人聲。
2. ~~單純 Qwen 抽風~~——服務端已加「Qwen 回傳空/垃圾結果時自動降級 Whisper」的兜底(2026-07-13),但監控抓到的失敗案例裡 **Qwen 和 Whisper 兩個獨立引擎同時判定為空**,說明不是單一引擎的問題。
3. ~~壓縮產出空 MP3 文件~~——已確認失敗時的 MP3 是「完整長度」(35-53秒),不是空文件或截斷文件。

**已經做的修復,但可能還沒根治**(2026-07-13 最後一次改動):
- `client/src/services/AudioRecorderService.ts` 的 `compressToMp3()`:把 `stdin.write(buf); stdin.end();` 改成 `stdin.end(buf)`,理論上能修正大 buffer(30-60秒 PCM)在背壓下可能丟失尾部數據的問題;加了 stdin error 處理;壓縮產出 <512B 視為失敗直接報錯。
- **但**:在這個修復部署後,監控**又抓到一次**同樣特徵的失敗(`capture_peak=8099`,兩引擎皆空)。這條記錄的時間點在用戶說「這個版本已經很完美了」附近,**無法 100%確定是新版本(含壓縮硬化修復)還是舊版本(用戶重裝 .vsix 之前)產生的**——這是下一步要先確認的事。

**下一步建議(給接手者)**:
1. 先確認用戶當時測試用的到底是哪個 build(問清楚「你這次錄音前有沒有重新安裝過 .vsix / 重載視窗」)。
2. 如果確認是新版本(含 stdin.end(buf) 修復)仍然失敗,那壓縮管線硬化沒有根治問題,需要往兩個方向繼續查:
   - **VAD 分段合併的 `Buffer.concat(this.pcmChunks)` 邏輯**(`processPcmChunk` 裡)是否在特定條件下把某一段的 PCM 弄丟或錯位——可以在合併前後加 byte length 的完整性日誌,交叉比對「累計採集的總 bytes」vs「最終送去壓縮的 bytes」。
   - **base64 編碼/HTTP body 傳輸**環節是否在極長字串下出過問題(不太可能,但要排除)。
3. 監控腳本(`wrangler tail` 篩選 `no_speech|fallback|http_error`)這輪對話裡已經證明很有效,建議繼續用同樣的方法收集更多 `capture_peak` 高值但轉寫為空的案例。

**2026-07-18 更新 —— 診斷手段已內建**:當時說「唯一還沒做過的驗證手段」(把失敗的 MP3 存下來人工聽)現在做好了:
- 新增隱藏設置 **`vibefox.diagnosticSaveAudio`**(默認關)。打開後,當某段音頻**自身峰值**高卻轉寫為空時,把**實際上傳的 MP3** 落盤到 `$TMPDIR/vibefox-diagnostics/` 並彈出路徑(可在 Finder 顯示),人工播放即可確認「到底是麥克風錄進了靜音,還是音頻有聲但兩個引擎都讀空」。
- **順帶修正一個誤導**:此前上報服務端的 `capturePeak` 一直是**會話級**峰值,對 VAD 分段是錯的(任一段響過後,句間靜音段也帶著高 peak 上報,難怪監控會看到「高 peak 卻空」——那可能只是正常的句間靜音段)。現在 `onSegment` 一併傳出**每段自己的峰值**,`capturePeak` 與診斷門控都用段級值。
- **下一步**:用戶再遇到此現象時,讓他打開 `diagnosticSaveAudio`,復現後把落盤的 MP3 發來人工聽——這是定位根因的最後一塊拼圖。用戶當前主力機已從 2017 Intel MBP 換成 **M3 MacBook Air**,近期未再復現(2026-07-18 用戶原話「暫時沒再碰到,後面關注」)。

---

## 四點五、桌面 App(`desktop/`)—— Claude App 語音輸入法(2026-07-18 新增)

> 完整逐條記錄見 `docs/STATE.md` 最上面的 2026-07-18 各條;這裡是導覽。

**是什麼**:Electron 菜單欄應用(`app.dock.hide()`,無窗口),全局熱鍵 **`⌘⌥Z`(Command+Option+Z)**。按一下開始錄音(菜單欄麥克風圖標旁顯示實時電平),再按一下停止→轉寫→**模擬 ⌘V 粘進當前前台應用**(Claude App 聊天框就是普通聚焦文本框,這招通用)。

**關鍵設計 / 踩過的坑(接手必看,別重踩)**:
1. **同源複用**:直接 `import ../../client/src/services/*`,服務端與 client 服務零改動。License Key 存 **macOS 鑰匙串**(`security` CLI,等價 SecretStorage 紅線);配置 `~/Library/Application Support/VibeFox/config.json` 首啟自動生成。
2. **熱鍵不能用系統保留鍵**:最初用 `⌃⌥Space`,結果「註冊返回 true 卻永不觸發」——`⌃⌥Space` 是 macOS「切換輸入法」系統快捷鍵,系統搶先攔截。`config.ts` 的 `RESERVED_HOTKEYS` 會把存量壞熱鍵自動遷移。選默認熱鍵必須避開 `defaults read com.apple.symbolichotkeys` 的保留集,也避開 `⌃⇧Space`(那是 VS Code 擴展的)。
3. **托盤圖標不能用空圖標**:`new Tray(nativeImage.createEmpty())` 在 macOS 上渲染成零寬、看不見也點不到——必須用真實圖標(`assets/trayTemplate.png`,模板圖)。
4. **自動粘貼需要「輔助功能」權限**:`AXIsProcessTrusted` 在進程內是**緩存值,授權後必須重啟 App 才翻 true**;粘貼動作**不要**卡在這個檢查後面(會誤傷),應永遠嘗試、失敗留剪貼板。
5. **簽名 = 授權能否長期保持的關鍵**:ad-hoc 簽名每次重打包 cdhash 變 → TCC 授權作廢 → 反覆重授。**已改用用戶自己的 `Developer ID Application: Min Li (CFA9WX4496)` 證書簽名**(electron-builder `mac.identity: "Min Li (CFA9WX4496)"` + `hardenedRuntime` + `build/entitlements.mac.plist` 帶麥克風 entitlement),designated requirement 基於證書+bundle id 而非 cdhash,**TCC 授權跨重打包永久有效**。`dist` 腳本**不加 `--production`**(esbuild 壓縮會讓打包 App 靜默崩潰)、**不 ad-hoc 重簽**(會破壞 Developer ID 簽名)。
6. **打包/安裝**:`cd desktop && npm run dist` → 產出 `release/mac-arm64/VibeFox.app` → `cp -R` 到 `/Applications`(保簽名不重簽)。用戶機上已裝好、跑通、能粘進 Claude App。
7. **未做**:notarize(免 Gatekeeper 需 Apple ID 憑證)、開機自啟、Windows/Linux 打包。

---

## 五、這輪對話裡完成的所有工作(按時間順序,粗略分組)

### 2026-07-18 這輪(桌面 App + 三個插件 bug)
- **三個插件 bug**(用戶 M3 Air 實測):①`auto` 插入改「Claude 聊天框優先」(`activeTerminal` 不等於焦點,VS Code 不暴露 webview 焦點);②電平表噪聲門控 + 去隨機抖動(靜音死平線);③空轉寫診斷落盤 `vibefox.diagnosticSaveAudio` + 段級 `capturePeak`。
- **桌面 App**:見上面「四點五」。
- 詳見 `docs/STATE.md` 的 2026-07-18 各條。

### 階段 A:雙引擎重構(Qwen3-ASR + Haiku,已被單引擎化取代)
協議 v2(`rewriteMode`/`projectContext`/`chineseVariant`/`regionPreference` 等欄位)、區域感知路由(`request.cf.continent`)、按 key 限流(Cloudflare Rate Limiting binding)、兩級上下文載荷(keywords + projectContext)。

### 階段 B:五個實測 bug 修復(用戶真實使用中發現)
1. **VAD 切分字節錯位致金屬噪音**——`silentTimeMs * 32` 浮點運算切在奇數字節,導致 16-bit PCM 採樣錯位(=聽起來像機械噪音)。修復:強制 2 字節對齊。
2. **垃圾/幻覺轉寫過濾**——ASR 對靜音/噪音輸出省略號、字幕水印類幻覺文字,新增 `isNonSpeechTranscript()` 雙端過濾器。
3. **插入到錯的聊天面板**——舊邏輯盲發一串命令,列表裡沒有 Claude Code,內建 `workbench.action.chat.open` 必然"成功"劫持到 Copilot。修復:讀取本機已裝擴展 manifest,`claude-vscode.focus` 置頂優先。
4. **按住熱鍵報錯**——OS 按鍵自動重複觸發 toggle 互撞。修復:雙語義熱鍵狀態機(點按=開關,按住=對講)。
5. **改寫質量問題**——prompt 加固,含「逐句清理不是總結」規則、截斷句禁止瞎補規則、編號回溯自糾規則。

### 階段 C:更多實測 bug(持續迭代)
- previousTranscript 導致的重複句(Whisper 在近靜音音頻上會把 prompt 原文吐回)——**徹底移除 previousTranscript**,改用客戶端確定性去重 `dedupeAgainstSession()`。
- Haiku「拒絕處理非技術內容」嚴重 bug——它會判斷內容"跟項目無關"然後把拒絕理由當正文輸出到聊天框。加了規則 0(最高優先級):不做內容審核,任何主題都要正常處理。**這個 bug 目前已隨 Haiku 一起移除,不再適用,但如果未來重新引入其他 LLM 改寫引擎要記得這個坑**。
- avfoundation 麥克風設備打開失敗(`ffmpeg exited abnormally code 251`,`Input/output error`)——根因是孤兒 ffmpeg 進程(擴展重載/更新 .vsix 時舊進程不會跟著死,因為用了 `detached:true`)霸占麥克風。修復:①每會話啟動前 `pkill` 回收孤兒進程;②`start()` 重構為確認式重試(用「第一個真實 stdout 數據塊」而非固定超時判斷啟動成功,失敗自動重試一次)。
- VAD 句間靜音段誤報「轉寫失敗」——VAD 按停頓切句,句子之間的靜音間隙本身也會被切一段發出去,服務器正常回「無語音」502,但 `handleVadSegment` 的 catch 把這個也記成錯誤。修復:抽共用 `isNoSpeechError()` 過濾。

### 階段 D:三個新功能(用戶明確要求)
1. **Qwen-Plus 轉正為單一改寫引擎**,移除 Haiku 與對比評估功能(`RewriteComparisonViewer`、`compareRewrite` 協議欄位、`anthropicRewrite.ts` 全部刪除)。
2. **中文繁簡四變體**——`vibefox.chineseVariant`:`simplified-cn`(默認,大陸)/ `simplified-sg-my`(新馬)/ `traditional-tw`(台灣)/ `traditional-hk-mo`(港澳)。由改寫階段 system prompt 後綴實現字形+用語轉換,`rewriteMode:'off'` 時不生效。**已用真實測試驗證繁體輸出正確**。
3. **DashScope 地區手動選擇**——`vibefox.dashscopeRegion`:`auto`(默認)/ `apac` / `us`。

### 階段 E:實時麥克風電平表(用戶提議,學習 Claude Code 內建錄音的視覺反饋)
狀態欄波形從「定時器假動畫」改為真實電平表——`AudioRecorderService` 逐塊計算 PCM 振幅並暴露歸一化 `inputLevel`(0..1,快起慢落的 VU 表手感),狀態欄 110ms 刷新。說話會跳動、靜音回落成平線,直接回答「麥克風到底有沒有在工作」,不用再猜。

**注**:用戶還提過一個更大的 idea——「流式轉寫 + 說完能回溯修正前一句」(學 Claude Code 內建語音輸入)。已初步分析:這個功能受限於我們是第三方擴展、無法即時編輯 Claude Code 聊天框裡已貼入的文字(webview 限制),完整版做不到;現實可行版本需要接阿里雲 WebSocket 實時 ASR + 把 Cloudflare Worker 改成流式代理,是一個獨立的大工程,**尚未開始做**,只是聊過方向,等用戶拍板要不要投入。

---

## 六、商業化相關的已有研究結論(尚未執行,等用戶決策)

- **定價建議**:COGS 估算典型用戶 $3-8/月、重度 $15-30/月。建議 Pro 訂閱 **$9-12/月**(年付 8 折),免費檔限量引流。競品錨點:Wispr Flow $15-18、Aqua Voice $8、Superwhisper $8.49。
- **防濫用**:目前已有 per-key 速率限制(Cloudflare Rate Limiting binding,免費檔 10次/分、Pro 40次/分)。**建議但尚未實現**:月度公平使用軟上限(在 KV metadata 記月度用量,超出後降速/降級到免費檔),防止極端用戶(一月上萬次)吃掉毛利。
- **License 發放/支付基礎設施**:目前只有 `wrangler kv key put` 手動發 key 這一種方式,沒有自助訂閱、支付整合。這整塊還沒開始做,是下一個大方向。

---

## 七、當前完整設置列表(`vibefox.*`,共 21 個有效 + 4 個已廢棄)

```
apiProvider (默認 cloudflare)      customEndpoint
endpoint                          language (默認 zh)
maxRecordSeconds (默認 25,上限600)  insertTarget (默認 auto)
ffmpegPath                        audioDevice
contextHint (默認 true)            vadEnabled (默認 true)
vadSilenceMs (默認 1200)           vadMinDurationMs (默認 3000)
vadSilenceThreshold (默認 350)     vadAdaptiveThreshold (默認 true)
rewriteMode (默認 clean)           chineseVariant (默認 simplified-cn)
dashscopeRegion (默認 auto)        developerModeEnabled (默認 true)
diagnosticSaveAudio (默認 false,隱藏診斷:有聲卻轉空時落盤 MP3)

已廢棄(首次啟動自動遷移,保留一個版本週期,不要刪):
llmCorrectionEnabled / llmCorrectionProvider /
llmCorrectionModel / llmCorrectionCustomEndpoint
```

---

## 八、項目硬規則速記(完整版見 CLAUDE.md)

- **嚴格 MVC+S 分層**:`models/` 禁 UI,`viewer/` 禁 fetch/spawn/exec,`services/` 禁 UI 調用,只有 `controllers/` 能同時碰三層。每次交付前跑 DoD 的分層 grep(見 `docs/03-DOD.md`)。
- **密鑰紅線**:License Key 只進 VS Code SecretStorage;服務端密鑰只進 `wrangler secret put`,絕不進源碼/配置。協議 v2 不接受客戶端傳 prompt/model(防計費濫用)。
- **未經要求不提交不推送**——但這輪對話裡用戶已經多次明確要求"提交推送",所以近期的 commit 都已經 push 到 `origin/main` 了,不是違規。
- **閉源**:不發布 marketplace。

---

## 九、如果你是接手的新 AI,建議這樣開場

1. 讀這份文件 + `CLAUDE.md`。桌面 App 相關先讀「四點五」+ `desktop/README.md`。
2. 跑一次 DoD 自查(`docs/03-DOD.md` 或直接呼叫 `/dod` skill)確認當前代碼健康。
3. 桌面 App 已在用戶 M3 Air 上跑通(能粘進 Claude App、Developer ID 簽名、授權永久保持)。若用戶報「桌面 App 又不能粘了」,先查:菜單欄「輔助功能:已授權 ✓」還在嗎?是不是換了機器/證書?
4. 「間歇性有聲卻轉空」仍是唯一懸而未決的技術問題,但已內建診斷手段(`vibefox.diagnosticSaveAudio`,見第四節)。用戶近期未再復現;下次復現讓他開診斷、把落盤 MP3 發來。
5. 如果用戶想繼續推進商業化(定價/支付/月度限流),那是全新的一塊,可以從第六節的研究結論開始接著做。

## 十、下一步候選(2026-07-18 收尾時)

- 桌面 App:notarize(公證,免 Gatekeeper 提示,發給別人用時需要)、開機自啟(login item)、Windows/Linux 打包、按住對講。
- 商業化基礎設施:自助發 key、支付、月度用量軟上限(見第六節)。桌面 App 讓「不用 VS Code 的用戶」也成了潛在客戶,擴大了市場面。
- 「有聲卻轉空」根因收尾(靠 `diagnosticSaveAudio` 收集失敗 MP3)。
