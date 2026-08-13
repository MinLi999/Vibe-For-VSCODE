import AppKit
import Foundation
import SwiftUI
@preconcurrency import UserNotifications
import VibeFoxCore

enum Phase: String {
    case idle, recording, processing
}

/// Controller: owns config/dictionary/history/stats, the recording session state machine,
/// and the delivery pipeline (transcribe → replacements → dedupe → history → paste).
/// Views only render @Published state and call intent methods.
@MainActor
final class AppModel: ObservableObject {
    @Published var config: AppConfig
    @Published var dictionary: UserDictionary
    @Published var history: TranscriptHistory
    @Published var stats: UsageStats
    @Published var phase: Phase = .idle
    @Published var licenseKeyPresent: Bool
    @Published var accessibilityTrusted: Bool
    @Published var inputLevel: Float = 0
    @Published var lastError: String?
    /// Last delivered text — the onboarding practice step consumes this when the synthetic
    /// paste can't land (no accessibility grant yet).
    @Published var lastDelivered: String?
    /// Live transcription preview while streaming (display only, never inserted).
    @Published var partialText = ""

    private let recorder = AudioRecorder()
    private let api = ApiClient()
    /// BYOK: direct provider calls (Groq/OpenAI/Aliyun/custom) bypassing the Worker entirely.
    private let directProvider = DirectProviderClient()
    private let hotkey = HotkeyManager()
    /// Event-tap hotkey (real keyDown/keyUp → tap-to-toggle AND hold-to-talk; Fn support).
    private let keyMonitor = KeyMonitor()
    /// When the current recording was started by a key press (hold-detection anchor).
    private var hotkeyDownAt: Date?
    private let hud = HudController()

    private var sessionKeywords: [String] = []
    private var sessionAppCategory: String?
    private var sessionTranscript = ""
    private var sessionChars = 0
    private var sessionErrors: [String] = []
    private var dictionaryDirty = false
    private var maxStopTask: Task<Void, Never>?
    private var levelTimer: Timer?
    private var micAccessAsked = false
    /// VAD segmenter for the current session (confined to the recorder's chunk queue).
    private var vad: VadSegmenter?
    /// Chains segment transcription+paste so multi-segment sessions land in spoken order.
    private var segmentQueue: Task<Void, Never>?
    private var streamingClient: StreamingClient?
    /// Cross-thread streaming failure flag (the chunk callback reads it off-main).
    private let streamingFailed = AtomicFlag()
    /// Whole-session PCM stays buffered while streaming — the batch-replay fallback source.
    private let streamingPcm = PcmBuffer()
    private var streamingDone = MainSignal()

    /// Local-only, content-free segment lifecycle log (see DiagnosticsLog). `diagRevision`
    /// only exists to poke SwiftUI when a new event lands.
    let diagnostics = DiagnosticsLog(fileURL: AppPaths.userDataDir.appendingPathComponent("diagnostics.log"))
    @Published private(set) var diagRevision = 0

    let settingsWindow = SettingsWindowController()

    /// All logging funnels through here so every event also refreshes the settings UI.
    private func diag(_ kind: String, _ detail: String) {
        diagnostics.log(kind, detail)
        diagRevision &+= 1
    }

    func clearDiagnostics() {
        diagnostics.clear()
        diagRevision &+= 1
    }

    init() {
        config = ConfigStore.load()
        dictionary = DictionaryStore.load()
        history = HistoryStore.load()
        stats = StatsStore.load()
        let key = KeychainStore.getLicenseKey()
        licenseKeyPresent = key != nil
        accessibilityTrusted = PasteService.accessibilityTrusted()
        // One-time: take ownership of a keychain item created by the Electron build's
        // `security` CLI so macOS stops asking for keychain permission on every read.
        if let key, !UserDefaults.standard.bool(forKey: "keychainReclaimed") {
            KeychainStore.reclaimOwnership(key)
            UserDefaults.standard.set(true, forKey: "keychainReclaimed")
        }
    }

    func start() {
        registerHotkey()
        if !config.onboardingDone {
            settingsWindow.show(model: self)
        }
    }

    // MARK: config & credentials

    func saveConfig() {
        config.normalize()
        ConfigStore.save(config)
    }

    /// Returns false (and keeps the old combo) when the new accelerator can't be registered.
    /// "Fn" is native-only (needs the Accessibility event tap; Electron can't express it).
    func applyHotkey(_ accelerator: String) -> Bool {
        guard !AppConfig.reservedHotkeys.contains(accelerator) else { return false }
        if accelerator.caseInsensitiveCompare("Fn") == .orderedSame {
            guard PasteService.accessibilityTrusted() else { return false }
        } else {
            guard HotkeyManager.checkAvailable(accelerator) else { return false }
        }
        config.hotkey = accelerator
        saveConfig()
        registerHotkey()
        return true
    }

    /// Event-tap first (dual semantics: tap = toggle, hold >350ms = push-to-talk); Carbon
    /// toggle-only fallback when Accessibility trust is missing.
    private func registerHotkey() {
        hotkey.unregister()
        keyMonitor.unregister()
        let tapped = keyMonitor.register(
            config.hotkey,
            onDown: { [weak self] in self?.hotkeyPressed() },
            onUp: { [weak self] in self?.hotkeyReleased() }
        )
        if tapped {
            return
        }
        let ok = hotkey.register(config.hotkey) { [weak self] in
            self?.toggleRecording()
        }
        if !ok {
            lastError = "全局热键 \(config.hotkey) 注册失败(可能被其他应用占用,或 Fn 键需要辅助功能权限),请在设置中更换。"
        }
    }

    /// Hold threshold separating a tap (toggle) from a hold (push-to-talk).
    private static let holdThresholdSeconds = 0.35

    private func hotkeyPressed() {
        switch phase {
        case .idle:
            hotkeyDownAt = Date()
            Task { await startRecording() }
        case .recording:
            hotkeyDownAt = nil // Second tap while recording = stop (classic toggle).
            Task { await stopAndFinish() }
        case .processing:
            break
        }
    }

    private func hotkeyReleased() {
        guard phase == .recording, let downAt = hotkeyDownAt else { return }
        hotkeyDownAt = nil
        if Date().timeIntervalSince(downAt) > Self.holdThresholdSeconds {
            Task { await stopAndFinish() } // Held past the threshold = push-to-talk release.
        }
    }

    func setLicenseKey(_ key: String) {
        KeychainStore.setLicenseKey(key)
        licenseKeyPresent = true
    }

    func clearLicenseKey() {
        KeychainStore.clearLicenseKey()
        licenseKeyPresent = false
    }

    func refreshAccessibility() {
        accessibilityTrusted = PasteService.accessibilityTrusted()
    }

    // MARK: BYOK provider keys (Groq/OpenAI/Aliyun — "custom" has no key, just customEndpoint)

    func providerKeyPresent(_ provider: String) -> Bool {
        guard let account = KeychainStore.providerKeyAccount(for: provider) else { return false }
        return KeychainStore.getSecret(account: account) != nil
    }

    func setProviderKey(_ key: String, for provider: String) {
        guard let account = KeychainStore.providerKeyAccount(for: provider) else { return }
        KeychainStore.setSecret(key, account: account)
        objectWillChange.send() // Presence is read on demand (not @Published); nudge the view.
    }

    func clearProviderKey(for provider: String) {
        guard let account = KeychainStore.providerKeyAccount(for: provider) else { return }
        KeychainStore.clearSecret(account: account)
        objectWillChange.send()
    }

    // MARK: dictionary intents (each persists immediately)

    func dictAdd(word: String, aliases: [String], source: String = "manual") {
        dictionary.addEntry(word, aliases: aliases, source: source)
        DictionaryStore.save(dictionary)
    }

    func dictUpdate(original: String, word: String, aliases: [String]) {
        dictionary.updateEntry(original, word: word, aliases: aliases)
        DictionaryStore.save(dictionary)
    }

    func dictRemove(word: String) {
        dictionary.removeEntry(word)
        DictionaryStore.save(dictionary)
    }

    func dictAddReplacement(from: String, to: String, caseSensitive: Bool) {
        dictionary.addReplacement(from: from, to: to, caseSensitive: caseSensitive)
        DictionaryStore.save(dictionary)
    }

    func dictRemoveReplacement(from: String) {
        dictionary.removeReplacement(from: from)
        DictionaryStore.save(dictionary)
    }

    /// Returns the number of imported items, or nil when the JSON is unparsable.
    func dictImport(json: String) -> Int? {
        guard let data = json.data(using: .utf8),
              let incoming = try? JSONDecoder().decode(UserDictionary.self, from: data) else {
            return nil
        }
        let added = dictionary.importData(incoming)
        DictionaryStore.save(dictionary)
        return added
    }

    func dictExportJson() -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(dictionary)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }

    func clearHistory() {
        history.clear()
        HistoryStore.save(history)
    }

    // MARK: recording session

    func toggleRecording() {
        switch phase {
        case .recording:
            Task { await stopAndFinish() }
        case .processing:
            break // Ignore presses while the previous session is still transcribing.
        case .idle:
            Task { await startRecording() }
        }
    }

    /// Verifies the active provider has what it needs before spending a microphone permission
    /// prompt / recording session on a request that would just fail. Shows the settings window
    /// pointed at the missing credential when something's absent.
    private func checkCredentials() -> Bool {
        switch config.apiProvider {
        case "cloudflare":
            guard KeychainStore.getLicenseKey() != nil else {
                notify("还没有设置 License Key — 打开设置窗口的「设置」页填入,或切到自带 API Key(BYOK)。")
                settingsWindow.show(model: self)
                return false
            }
        case "custom":
            guard !config.customEndpoint.trimmingCharacters(in: .whitespaces).isEmpty else {
                notify("自定义服务地址未配置 — 打开设置窗口的「设置」页填入。")
                settingsWindow.show(model: self)
                return false
            }
        default:
            guard let account = KeychainStore.providerKeyAccount(for: config.apiProvider),
                  KeychainStore.getSecret(account: account) != nil else {
                notify("\(providerDisplayName(config.apiProvider)) API Key 未设置 — 打开设置窗口的「设置」页填入。")
                settingsWindow.show(model: self)
                return false
            }
        }
        return true
    }

    private func startRecording() async {
        guard checkCredentials() else { return }
        if !micAccessAsked {
            micAccessAsked = true
            guard await AudioRecorder.requestMicrophoneAccess() else {
                notify("未获得麦克风权限:系统设置 → 隐私与安全性 → 麦克风 → 勾选 VibeFox。")
                return
            }
        }

        sessionTranscript = ""
        sessionChars = 0
        sessionErrors = []
        partialText = ""
        sessionKeywords = buildSessionKeywords()
        sessionAppCategory = FrontmostApp.currentCategory()
        lastError = nil
        vad = nil
        segmentQueue = nil
        streamingClient = nil
        streamingFailed.value = false
        streamingPcm.reset()
        streamingDone = MainSignal()

        // Streaming (/api/realtime) is a Cloudflare Worker feature — BYOK providers have no
        // equivalent, so they always take the batch/VAD path (matches the VS Code extension:
        // `config.streamingMode && config.apiProvider === 'cloudflare'`).
        if config.streamingMode, config.apiProvider == "cloudflare", let licenseKey = KeychainStore.getLicenseKey() {
            openStreamingSession(licenseKey: licenseKey)
        }
        if streamingClient == nil && config.vadEnabled {
            vad = VadSegmenter(
                silenceMs: Double(config.vadSilenceMs),
                minDurationMs: Double(config.vadMinDurationMs),
                silenceThreshold: Double(config.vadSilenceThreshold),
                adaptive: config.vadAdaptiveThreshold
            )
        }
        wireChunkHandler()

        do {
            try recorder.start()
        } catch {
            streamingClient?.close()
            streamingClient = nil
            recorder.onPcmChunk = nil
            notify(error.localizedDescription)
            return
        }

        diag("session_start", "provider=\(config.apiProvider) streaming=\(streamingClient != nil) vad=\(vad != nil) keywords=\(sessionKeywords.count)")
        phase = .recording
        hud.show(model: self)
        levelTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.inputLevel = self.recorder.inputLevel
            }
        }
        let maxSeconds = config.maxRecordSeconds
        maxStopTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(maxSeconds) * 1_000_000_000)
            if !Task.isCancelled {
                await self?.stopAndFinish()
            }
        }
    }

    /// Routes live PCM chunks (recorder chunk queue) into the session's active pipeline.
    private func wireChunkHandler() {
        if let client = streamingClient {
            let buffer = streamingPcm
            let failed = streamingFailed
            recorder.onPcmChunk = { chunk in
                buffer.append(chunk) // Always buffered — the batch-replay fallback source.
                if !failed.value {
                    client.sendAudio(chunk)
                }
            }
        } else if let segmenter = vad {
            recorder.onPcmChunk = { [weak self] chunk in
                if let segment = segmenter.consume(chunk) {
                    Task { @MainActor [weak self] in
                        self?.enqueueSegment(pcm: segment.pcm, peak: Int(segment.peak))
                    }
                }
            }
        } else {
            recorder.onPcmChunk = nil // Whole-take mode: recorder accumulates, stop() delivers.
        }
    }

    func cancelRecording() {
        clearSessionTimers()
        recorder.onPcmChunk = nil
        recorder.cancel()
        streamingClient?.close()
        streamingClient = nil
        vad = nil
        partialText = ""
        phase = .idle
        inputLevel = 0
        hud.hide()
        diag("session_cancelled", "")
    }

    private func stopAndFinish() async {
        guard phase == .recording else { return }
        clearSessionTimers()
        phase = .processing
        inputLevel = 0

        let wholePcm = recorder.stop() // Also drains the chunk queue (ordering barrier).
        recorder.onPcmChunk = nil

        if let client = streamingClient {
            streamingClient = nil
            await finishStreamingSession(client)
            finishSession()
            return
        }

        if let segmenter = vad {
            vad = nil
            if let trailing = segmenter.drainTrailing() {
                enqueueSegment(pcm: trailing.pcm, peak: Int(trailing.peak))
            }
            await segmentQueue?.value
            finishSession()
            return
        }

        if wholePcm.count >= 6400 { // Under ~0.2s cannot contain speech.
            await processSegment(pcm: wholePcm, peak: recorder.peakAmplitude)
        }
        finishSession()
    }

    // MARK: streaming session

    private func openStreamingSession(licenseKey: String) {
        do {
            streamingClient = try StreamingClient(
                endpoint: config.endpoint,
                licenseKey: licenseKey,
                options: StreamingClient.StartOptions(
                    rewriteMode: config.rewriteMode,
                    chineseVariant: config.chineseVariant,
                    appCategory: sessionAppCategory,
                    keywords: sessionKeywords,
                    language: config.language,
                    vadSilenceMs: config.vadSilenceMs
                ),
                onEvent: { [weak self] event in
                    Task { @MainActor [weak self] in
                        self?.handleStreamEvent(event)
                    }
                }
            )
        } catch {
            streamingClient = nil // Batch path takes over untouched.
        }
    }

    private func handleStreamEvent(_ event: StreamingClient.Event) {
        switch event {
        case .ready:
            break
        case .partial(let text):
            partialText = text
        case .segment(_, let finalText):
            partialText = ""
            let previous = segmentQueue
            segmentQueue = Task { [weak self] in
                await previous?.value
                await self?.deliverFinalText(finalText)
            }
        case .done:
            streamingDone.fire()
        case .error:
            // Quiet degradation: keep recording+buffering; the stop path replays via batch.
            streamingFailed.value = true
            partialText = ""
            streamingDone.fire()
        }
    }

    /// Happy path: flush and use the live-pasted segments. Failure/timeout: batch-replay.
    private func finishStreamingSession(_ client: StreamingClient) async {
        if !streamingFailed.value {
            client.finish()
            let timedOut = await streamingDone.wait(timeoutSeconds: 10)
            await segmentQueue?.value
            if !timedOut && !streamingFailed.value {
                client.close()
                return
            }
        } else {
            await segmentQueue?.value
        }
        client.close()
        let pcm = streamingPcm.drain()
        guard pcm.count >= 6400 else { return }
        // deliverFinalText's dedupe trims everything the stream already pasted.
        enqueueSegment(pcm: pcm, peak: recorder.peakAmplitude)
        await segmentQueue?.value
    }

    // MARK: segment pipeline

    /// Serializes segment transcription+paste so multi-segment sessions land in spoken order.
    private func enqueueSegment(pcm: Data, peak: Int) {
        diag("segment_queued", "bytes=\(pcm.count) ms=\(pcm.count / 32) peak=\(peak)")
        let previous = segmentQueue
        segmentQueue = Task { [weak self] in
            await previous?.value
            await self?.processSegment(pcm: pcm, peak: peak)
        }
    }

    private func processSegment(pcm: Data, peak: Int) async {
        guard pcm.count >= 6400 else { // Under ~0.2s cannot contain speech.
            diag("segment_too_short", "bytes=\(pcm.count) ms=\(pcm.count / 32)")
            return
        }
        do {
            let finalText = config.apiProvider == "cloudflare"
                ? try await transcribeViaWorker(pcm: pcm, peak: peak)
                : try await transcribeViaDirectProvider(pcm: pcm)
            await deliverFinalText(finalText)
        } catch let error as ApiError {
            switch error {
            case .noSpeech:
                // A silence gap transcribing to nothing is normal — but when the CAPTURE PEAK
                // was high, this is the "I spoke but nothing appeared" field report: real audio
                // that both engines read as empty. peak splits capture bugs from engine bugs.
                diag("no_speech", "peak=\(peak) bytes=\(pcm.count) ms=\(pcm.count / 32)")
                return
            case .unauthorized:
                diag("segment_error", "unauthorized")
                notify(error.localizedDescription)
            default:
                diag("segment_error", String(error.localizedDescription.prefix(120)))
                sessionErrors.append(error.localizedDescription)
            }
        } catch {
            diag("segment_error", String(error.localizedDescription.prefix(120)))
            sessionErrors.append(error.localizedDescription)
        }
    }

    private func transcribeViaWorker(pcm: Data, peak: Int) async throws -> String {
        guard let licenseKey = KeychainStore.getLicenseKey() else {
            throw ApiError.unauthorized
        }
        let m4a = try AacEncoder.encodeToM4A(pcm16: pcm)
        let result = try await api.transcribe(
            endpoint: config.endpoint,
            licenseKey: licenseKey,
            request: TranscribeRequest(
                audio: m4a.base64EncodedString(),
                language: config.language,
                keywords: sessionKeywords,
                projectContext: config.projectContext.isEmpty ? nil : config.projectContext,
                rewriteMode: config.rewriteMode,
                chineseVariant: config.chineseVariant,
                regionPreference: config.dashscopeRegion,
                capturePeak: peak,
                appCategory: sessionAppCategory
            )
        )
        var fallbackNote = ""
        if let fallback = result.fallback {
            if let asr = fallback.asr { fallbackNote += " asr_fallback=\(asr)" }
            if let rewrite = fallback.rewrite { fallbackNote += " rewrite_fallback=\(rewrite)" }
        }
        diag("worker_ok", "asr=\(result.engines.asr) rewrite=\(result.engines.rewrite) total_ms=\(result.timings.total_ms)"
            + " raw_len=\(result.rawText.count) final_len=\(result.finalText.count)\(fallbackNote)")
        return result.finalText
    }

    /// BYOK: transcribes via the selected provider directly (no Worker involved), then — for
    /// off-Cloudflare rewrite — runs a client-side clean/rewrite chat-completions call against
    /// the SAME provider. A broken/unset rewrite never blocks delivery: it just falls back to
    /// the raw transcription (matches the VS Code extension's BYOK behavior).
    /// Mirrors the Worker's own pipeline stage-for-stage (transcribe.ts handleTranscribe):
    /// ASR → isContextEcho/isNonSpeechTranscript guard → MIN_REWRITE_CHARS gate → rewrite
    /// with the real server-owned prompts (safe to ship — see RewritePrompts.swift). No
    /// fallback to a weaker engine on failure; errors surface directly to the user.
    private func transcribeViaDirectProvider(pcm: Data) async throws -> String {
        let m4a = try AacEncoder.encodeToM4A(pcm16: pcm)
        let audioBase64 = m4a.base64EncodedString()
        let provider = config.apiProvider

        let rawText: String
        switch provider {
        case "groq":
            rawText = try await directProvider.transcribeGroq(
                apiKey: try requireProviderKey("groq"), audioBase64: audioBase64, language: config.language, keywords: sessionKeywords)
        case "openai":
            rawText = try await directProvider.transcribeOpenAI(
                apiKey: try requireProviderKey("openai"), audioBase64: audioBase64, language: config.language, keywords: sessionKeywords)
        case "aliyun":
            rawText = try await directProvider.transcribeAliyun(
                baseEndpoint: config.customEndpoint, apiKey: try requireProviderKey("aliyun"), audioBase64: audioBase64,
                language: config.language, contextWords: sessionKeywords)
        case "custom":
            guard !config.customEndpoint.isEmpty else { throw ApiError.network("自定义服务地址 (customEndpoint) 未配置") }
            rawText = try await directProvider.transcribeCustom(
                endpoint: config.customEndpoint, audioBase64: audioBase64, language: config.language, keywords: sessionKeywords)
        default:
            throw ApiError.network("不支持的 API Provider: \(provider)")
        }

        // Same guard the Worker runs before trusting an ASR result: catches silence
        // hallucinations, filler-only utterances, and the context-vocabulary-echo failure
        // mode (2026-07-12 incident) — all providers pass keywords into their ASR call
        // (Qwen3-ASR's system message, Whisper's prompt field), so all are equally exposed.
        guard !rawText.isEmpty, !NonSpeechFilter.isNonSpeechTranscript(rawText) else {
            diag("byok_filtered", "reason=nonspeech raw_len=\(rawText.count)")
            throw ApiError.noSpeech
        }
        guard !NonSpeechFilter.isContextEcho(rawText, contextWords: sessionKeywords) else {
            diag("byok_filtered", "reason=context_echo raw_len=\(rawText.count)")
            throw ApiError.noSpeech
        }

        guard config.rewriteMode != "off", rawText.trimmingCharacters(in: .whitespacesAndNewlines).count >= RewritePrompts.minRewriteChars,
              let baseURL = DirectProviderClient.chatBaseURL(for: provider, customEndpoint: config.customEndpoint) else {
            diag("byok_ok", "provider=\(provider) raw_len=\(rawText.count) rewrite=skipped")
            return rawText
        }
        let apiKey = (try? requireProviderKey(provider)) ?? ""
        let model = config.llmCorrectionModel.isEmpty ? DirectProviderClient.defaultRewriteModel(for: provider) : config.llmCorrectionModel
        let systemPrompt = RewritePrompts.systemPrompt(rewriteMode: config.rewriteMode, chineseVariant: config.chineseVariant, appCategory: sessionAppCategory)
        let userMessage = RewritePrompts.buildUserMessage(rawText: rawText, keywords: sessionKeywords, projectContext: config.projectContext)
        let finalText = await directProvider.rewrite(baseURL: baseURL, apiKey: apiKey, model: model, userMessage: userMessage, systemPrompt: systemPrompt, fallbackText: rawText)
        diag("byok_ok", "provider=\(provider) model=\(model) raw_len=\(rawText.count) final_len=\(finalText.count)"
            + (finalText == rawText ? " rewrite=fell_back" : ""))
        return finalText
    }

    private func requireProviderKey(_ provider: String) throws -> String {
        guard let account = KeychainStore.providerKeyAccount(for: provider),
              let key = KeychainStore.getSecret(account: account) else {
            throw ApiError.unauthorized
        }
        return key
    }

    private func providerDisplayName(_ provider: String) -> String {
        switch provider {
        case "groq": return "Groq"
        case "openai": return "OpenAI"
        case "aliyun": return "阿里云"
        case "custom": return "自定义服务"
        default: return provider
        }
    }

    /// Shared delivery tail for batch segments AND streaming segments:
    /// L3 replacements → session dedupe → usage stats → history → paste.
    private func deliverFinalText(_ text: String) async {
        let replaced = dictionary.applyReplacements(text)
        let finalText = dedupeAgainstSession(sessionTranscript, replaced)
        guard !finalText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            diag("dedupe_dropped", "len=\(replaced.count)") // Whole segment was a session echo.
            return
        }
        sessionTranscript = (sessionTranscript + " " + finalText).trimmingCharacters(in: .whitespaces)
        sessionChars += finalText.count
        if dictionary.recordUsage(finalText) {
            dictionaryDirty = true
        }
        // Recorded BEFORE the paste so text survives even when the target rejects it.
        history.add(finalText)
        HistoryStore.save(history)
        await PasteService.deliver(finalText, restoreClipboard: accessibilityTrusted && config.restoreClipboard)
        lastDelivered = finalText
        diag("delivered", "chars=\(finalText.count) paste=\(accessibilityTrusted ? "auto" : "clipboard_only")")
        if !accessibilityTrusted {
            notify("转写已复制到剪贴板(未授权辅助功能,自动粘贴不可用)。可直接 ⌘V;去设置窗口「设置」页授权后重启 VibeFox。")
        }
    }

    private func finishSession() {
        phase = .idle
        partialText = ""
        hud.hide()
        if sessionChars > 0 {
            stats.recordSession(chars: sessionChars)
            StatsStore.save(stats)
        }
        if dictionaryDirty {
            dictionaryDirty = false
            DictionaryStore.save(dictionary)
        }
        if !sessionErrors.isEmpty {
            let unique = Array(Set(sessionErrors))
            notify("本次录音有 \(sessionErrors.count) 段转写失败 —— \(unique[0])")
        }
        diag("session_end", "chars=\(sessionChars) errors=\(sessionErrors.count)")
    }

    private func clearSessionTimers() {
        maxStopTask?.cancel()
        maxStopTask = nil
        levelTimer?.invalidate()
        levelTimer = nil
    }

    /// Dictionary picks (usage-ranked) first; config.vocabulary seeds fill the rest of the
    /// server's 40-slot cap (same policy as the Electron build).
    private func buildSessionKeywords() -> [String] {
        let cap = 40
        var keywords = dictionary.selectAsrKeywords(limit: cap)
        var seen = Set(keywords.map { $0.lowercased() })
        for word in config.vocabulary where keywords.count < cap {
            if seen.insert(word.lowercased()).inserted {
                keywords.append(word)
            }
        }
        return keywords
    }

    private func notify(_ message: String) {
        lastError = message
        // UNUserNotificationCenter requires a real bundle identity; running un-bundled
        // (swift run) falls back to the in-app lastError banner only.
        guard Bundle.main.bundleIdentifier != nil else { return }
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = "VibeFox"
            content.body = message
            center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
    }
}

/// Lock-protected boolean readable from any thread (the capture-thread chunk callback
/// checks the streaming failure state without hopping to the main actor).
final class AtomicFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false

    var value: Bool {
        get { lock.lock(); defer { lock.unlock() }; return flag }
        set { lock.lock(); defer { lock.unlock() }; flag = newValue }
    }
}

/// Lock-protected PCM accumulator shared between the capture thread and the main actor.
final class PcmBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()

    func append(_ chunk: Data) {
        lock.lock(); defer { lock.unlock() }
        data.append(chunk)
    }

    func drain() -> Data {
        lock.lock(); defer { lock.unlock() }
        let out = data
        data = Data()
        return out
    }

    func reset() {
        lock.lock(); defer { lock.unlock() }
        data = Data()
    }
}

/// One-shot completion signal awaited on the main actor (poll-based; the 100ms granularity
/// is negligible against the 10s stream-flush timeout it guards).
@MainActor
final class MainSignal {
    private var fired = false

    func fire() {
        fired = true
    }

    /// Returns true when the wait TIMED OUT (the signal never fired).
    func wait(timeoutSeconds: Double) async -> Bool {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while !fired && Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return !fired
    }
}

/// Manually managed settings window (a MenuBarExtra-only app can't rely on a Window scene
/// opening at launch for the onboarding case).
@MainActor
final class SettingsWindowController {
    private var window: NSWindow?

    func show(model: AppModel) {
        if window == nil {
            let hosting = NSHostingController(rootView: SettingsRootView().environmentObject(model))
            let newWindow = NSWindow(contentViewController: hosting)
            newWindow.title = "VibeFox"
            newWindow.setContentSize(NSSize(width: 900, height: 660))
            newWindow.styleMask = [.titled, .closable, .miniaturizable, .resizable]
            newWindow.isReleasedWhenClosed = false
            newWindow.center()
            window = newWindow
        }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
