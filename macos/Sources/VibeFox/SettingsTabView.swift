import AppKit
import SwiftUI
import VibeFoxCore

struct SettingsTabView: View {
    @EnvironmentObject private var model: AppModel
    var onRerunOnboarding: () -> Void

    static let pendingTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "MM-dd HH:mm"
        return formatter
    }()

    @State private var licenseInput = ""
    @State private var endpointInput = ""
    @State private var providerKeyInput = ""
    @State private var customEndpointInput = ""
    @State private var hotkeyMessage: String?
    @State private var providerFeedback: String?
    @State private var micTesting = false
    @State private var micLevel: Float = 0
    @State private var micRecorder: AudioRecorder?
    @State private var micTimer: Timer?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("热键").font(.headline)
                        HStack {
                            Text("录音热键")
                            HotkeyRecorderButton(current: model.config.hotkey) { accelerator in
                                if model.applyHotkey(accelerator) {
                                    hotkeyMessage = "热键已更新为 \(accelerator)"
                                } else {
                                    hotkeyMessage = "热键不可用:被占用或是系统保留组合"
                                }
                            }
                            Button("改用 Fn 键") {
                                if model.applyHotkey("Fn") {
                                    hotkeyMessage = "已改用 Fn 键(轻按开关,按住即说)"
                                } else {
                                    hotkeyMessage = "Fn 键需要先授予辅助功能权限"
                                }
                            }
                            .disabled(model.config.hotkey.caseInsensitiveCompare("Fn") == .orderedSame)
                            if let hotkeyMessage {
                                Text(hotkeyMessage).font(.callout).foregroundStyle(.secondary)
                            }
                        }
                        Text("轻按 = 开始/停止;按住说话、松手即出字(对讲模式)。")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    .padding(6)
                }

                GroupBox {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("账户与服务").font(.headline)
                        HStack {
                            Text("License Key")
                            Text(model.licenseKeyPresent ? "已设置 ✓(存于系统钥匙串)" : "未设置")
                                .foregroundStyle(model.licenseKeyPresent ? .green : .orange)
                        }
                        HStack {
                            SecureField("粘贴 License Key…", text: $licenseInput)
                                .textFieldStyle(.roundedBorder)
                            Button("保存") {
                                model.setLicenseKey(licenseInput.trimmingCharacters(in: .whitespaces))
                                licenseInput = ""
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(licenseInput.trimmingCharacters(in: .whitespaces).isEmpty)
                            Button("清除", role: .destructive) { model.clearLicenseKey() }
                                .disabled(!model.licenseKeyPresent)
                        }
                        HStack {
                            Text("服务地址")
                            TextField(AppConfig.officialHostedEndpoint, text: $endpointInput)
                                .textFieldStyle(.roundedBorder)
                                .onAppear { endpointInput = model.config.endpoint }
                            Button("保存") {
                                model.config.endpoint = endpointInput
                                model.saveConfig()
                                endpointInput = model.config.endpoint
                            }
                            Button("恢复官方地址") {
                                model.config.endpoint = AppConfig.officialHostedEndpoint
                                model.saveConfig()
                                endpointInput = model.config.endpoint
                            }
                            .disabled(model.config.endpoint == AppConfig.officialHostedEndpoint)
                        }
                        Text("自托管:部署 server/ 到自己的 Cloudflare Worker 后把地址填到这里(见 docs/SELF_HOSTING.md);转写引擎密钥只存在 Worker 端。")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    .padding(6)
                }

                GroupBox {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text("转写引擎").font(.headline)
                            Text("默认用上面的 Worker;也可以完全跳过它,直连你自己的模型服务商")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                        Picker("", selection: Binding(
                            get: { model.config.apiProvider },
                            set: { model.config.apiProvider = $0; model.saveConfig(); providerFeedback = nil }
                        )) {
                            Text("Cloudflare(默认)").tag("cloudflare")
                            Text("Groq").tag("groq")
                            Text("OpenAI").tag("openai")
                            Text("阿里云").tag("aliyun")
                            Text("自定义").tag("custom")
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()

                        byokFields
                    }
                    .padding(6)
                }

                GroupBox {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("录音").font(.headline)
                        HStack {
                            Text("单次录音上限")
                            Stepper(value: Binding(
                                get: { model.config.maxRecordSeconds },
                                set: { model.config.maxRecordSeconds = $0; model.saveConfig() }
                            ), in: 3...600, step: 5) {
                                Text("\(model.config.maxRecordSeconds) 秒")
                            }
                            .frame(width: 160)
                        }
                        Toggle("粘贴后约 1 秒恢复原剪贴板内容", isOn: Binding(
                            get: { model.config.restoreClipboard },
                            set: { model.config.restoreClipboard = $0; model.saveConfig() }
                        ))
                        HStack {
                            Text("麦克风测试")
                            Button(micTesting ? "停止测试" : "开始测试") { toggleMicTest() }
                            LevelMeter(level: micLevel).frame(width: 220)
                        }
                    }
                    .padding(6)
                }

                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("权限").font(.headline)
                        HStack {
                            Text("辅助功能")
                            Text(model.accessibilityTrusted ? "已授权 ✓" : "未授权 — 自动粘贴不可用")
                                .foregroundStyle(model.accessibilityTrusted ? .green : .orange)
                            if !model.accessibilityTrusted {
                                Button("去授权…") {
                                    _ = PasteService.accessibilityTrusted(prompt: true)
                                    PasteService.openAccessibilitySettings()
                                }
                            }
                            Button("刷新状态") { model.refreshAccessibility() }
                        }
                        if !model.accessibilityTrusted {
                            Text("授权后需退出并重新打开 VibeFox 才生效;在那之前转写结果会留在剪贴板,手动 ⌘V 粘贴。")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                    }
                    .padding(6)
                }

                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("其他").font(.headline)
                        HStack {
                            Button("打开数据文件夹") {
                                NSWorkspace.shared.open(AppPaths.userDataDir)
                            }
                            Button("重新运行新手引导") { onRerunOnboarding() }
                        }
                        Text("隐私:转写历史、词库、统计只存在本机;每次转写仅上传音频与 ≤40 个偏置词;历史绝不上云。")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    .padding(6)
                }

                if model.pendingCount > 0 {
                    GroupBox {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text("未转写成功的录音").font(.headline)
                                Text("共 \(model.pendingCount) 段——录音已保留,可重试")
                                    .font(.callout).foregroundStyle(.secondary)
                                Spacer()
                                Button("全部丢弃", role: .destructive) { model.clearPendingAudio() }
                            }
                            ForEach(model.pendingAudio.list()) { entry in
                                HStack {
                                    Text(Self.pendingTimeFormatter.string(from: Date(timeIntervalSince1970: entry.at / 1000)))
                                        .font(.callout.monospaced()).foregroundStyle(.secondary)
                                    Text("\(entry.durationMs / 1000) 秒")
                                        .font(.callout).foregroundStyle(.secondary)
                                    Text(entry.lastError)
                                        .font(.callout).foregroundStyle(.orange)
                                    Text("已试 \(entry.attempts) 次")
                                        .font(.callout).foregroundStyle(.tertiary)
                                    Spacer()
                                    Button("重试") { model.retryPending(entry) }
                                }
                                Divider()
                            }
                        }
                        .padding(6)
                    }
                }

                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("诊断").font(.headline)
                            Text("每段转写的完整生命周期,只记长度/引擎/耗时/原因码,不含任何转写内容")
                                .font(.callout).foregroundStyle(.secondary)
                            Spacer()
                            Button("复制诊断日志") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(model.diagnostics.exportText(), forType: .string)
                            }
                            Button("清空", role: .destructive) { model.clearDiagnostics() }
                        }
                        Text("排查「说了话却没有输出」:看 no_speech 事件的 peak 值——peak 高(>1000)说明麦克风录到了声音但引擎没识别出来(引擎侧问题);peak 低说明采集阶段就没收到人声(麦克风/增益问题)。")
                            .font(.callout).foregroundStyle(.secondary)
                        DiagnosticsListView()
                    }
                    .padding(6)
                }

                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("关于 VibeFox").font(.headline)
                        HStack(spacing: 12) {
                            Link("官网 vibefox.app", destination: URL(string: "https://vibefox.app")!)
                            Link("源代码(GitHub)", destination: URL(string: "https://github.com/MinLi999/Vibe-For-VSCODE")!)
                            Link("❤️ 支持开发者", destination: URL(string: "https://vibefox.app/support")!)
                        }
                        Text("VibeFox 0.2.0 · 自由软件,AGPL-3.0-only 许可 · © 2026 VibeFox.app")
                            .font(.callout).foregroundStyle(.secondary)
                        Text("VibeFox 永远开源、可自托管。如果它帮你省下了时间,欢迎自愿付费支持持续开发。")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    .padding(6)
                }
            }
            .padding(16)
        }
        .onDisappear { stopMicTest() }
    }

    @ViewBuilder
    private var byokFields: some View {
        let provider = model.config.apiProvider
        switch provider {
        case "cloudflare":
            EmptyView()
        case "custom":
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("服务地址")
                    TextField("https://your-server.example.com/transcribe", text: $customEndpointInput)
                        .textFieldStyle(.roundedBorder)
                        .onAppear { customEndpointInput = model.config.customEndpoint }
                    Button("保存") {
                        model.config.customEndpoint = customEndpointInput.trimmingCharacters(in: .whitespaces)
                        model.saveConfig()
                        providerFeedback = "已保存"
                    }
                }
                Text("接口约定:POST JSON { audio, language, keywords } → { text }。不需要 Key,鉴权由你的服务自行处理。")
                    .font(.callout).foregroundStyle(.secondary)
            }
        default: // groq / openai / aliyun
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("\(providerLabel(provider)) API Key")
                    Text(model.providerKeyPresent(provider) ? "已设置 ✓(存于系统钥匙串)" : "未设置")
                        .foregroundStyle(model.providerKeyPresent(provider) ? .green : .orange)
                }
                HStack {
                    SecureField("粘贴 API Key…", text: $providerKeyInput)
                        .textFieldStyle(.roundedBorder)
                    Button("保存") {
                        model.setProviderKey(providerKeyInput.trimmingCharacters(in: .whitespaces), for: provider)
                        providerKeyInput = ""
                        providerFeedback = "已保存到系统钥匙串"
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(providerKeyInput.trimmingCharacters(in: .whitespaces).isEmpty)
                    Button("清除", role: .destructive) { model.clearProviderKey(for: provider) }
                        .disabled(!model.providerKeyPresent(provider))
                }
                if provider == "aliyun" {
                    HStack {
                        Text("服务地址(可选)")
                        TextField("留空用国内域名 dashscope.aliyuncs.com", text: $customEndpointInput)
                            .textFieldStyle(.roundedBorder)
                            .onAppear { customEndpointInput = model.config.customEndpoint }
                        Button("保存") {
                            model.config.customEndpoint = customEndpointInput.trimmingCharacters(in: .whitespaces)
                            model.saveConfig()
                        }
                    }
                    Text("引擎为 qwen3-asr-flash,与官方托管服务同款、走国内域名直连,不经 Cloudflare——大陆用户推荐用这个模式。")
                        .font(.callout).foregroundStyle(.secondary)
                }
                Text("音频与转写内容直接发给\(providerLabel(provider)),不经过 VibeFox 的 Worker;改写用的是与官方服务相同的 prompt,同一个 Key 调用它的对话接口。")
                    .font(.callout).foregroundStyle(.secondary)
            }
        }
        if let providerFeedback {
            Text(providerFeedback).font(.callout).foregroundStyle(.green)
        }
    }

    private func providerLabel(_ provider: String) -> String {
        switch provider {
        case "groq": return "Groq"
        case "openai": return "OpenAI"
        case "aliyun": return "阿里云"
        default: return provider
        }
    }

    private func toggleMicTest() {
        if micTesting {
            stopMicTest()
            return
        }
        Task {
            guard await AudioRecorder.requestMicrophoneAccess() else { return }
            let recorder = AudioRecorder()
            do {
                try recorder.start()
            } catch {
                return
            }
            micRecorder = recorder
            micTesting = true
            micTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
                Task { @MainActor in micLevel = recorder.inputLevel }
            }
        }
    }

    private func stopMicTest() {
        micTimer?.invalidate()
        micTimer = nil
        micRecorder?.cancel()
        micRecorder = nil
        micTesting = false
        micLevel = 0
    }
}

/// Most-recent diagnostic events, newest first. Reads model.diagRevision so SwiftUI re-renders
/// on every new event (DiagnosticsLog itself is not observable by design — it's shared with
/// non-UI code paths).
struct DiagnosticsListView: View {
    @EnvironmentObject private var model: AppModel

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()

    var body: some View {
        let _ = model.diagRevision // Dependency anchor: re-render when a new event lands.
        let events = model.diagnostics.recent(14).reversed()
        if events.isEmpty {
            Text("(暂无记录——录一段音后这里会出现每一步的痕迹)")
                .font(.callout).foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(events)) { event in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(Self.timeFormatter.string(from: Date(timeIntervalSince1970: event.at / 1000)))
                            .font(.caption.monospaced()).foregroundStyle(.tertiary)
                        Text(event.kind)
                            .font(.caption.monospaced().bold())
                            .foregroundStyle(event.kind.contains("error") || event.kind == "no_speech" ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                        Text(event.detail)
                            .font(.caption.monospaced()).foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
        }
    }
}

/// Click → "按下组合键…" → captures the next keyDown via a local event monitor and reports
/// an Electron-style accelerator string (the config.json format shared with the other builds).
struct HotkeyRecorderButton: View {
    let current: String
    let onCapture: (String) -> Void

    @State private var capturing = false
    @State private var monitor: Any?

    var body: some View {
        Button(capturing ? "按下组合键…(Esc 取消)" : current) {
            capturing ? stop() : startCapture()
        }
        .onDisappear { stop() }
    }

    private func startCapture() {
        capturing = true
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            defer { stop() }
            if event.keyCode == 53 { // Esc
                return nil
            }
            if let accelerator = Self.accelerator(from: event) {
                onCapture(accelerator)
            }
            return nil // Swallow the keystroke.
        }
    }

    private func stop() {
        if let monitor {
            NSEvent.removeMonitor(monitor)
        }
        monitor = nil
        capturing = false
    }

    private static func accelerator(from event: NSEvent) -> String? {
        var parts: [String] = []
        if event.modifierFlags.contains(.command) { parts.append("Command") }
        if event.modifierFlags.contains(.control) { parts.append("Control") }
        if event.modifierFlags.contains(.option) { parts.append("Alt") }
        if event.modifierFlags.contains(.shift) { parts.append("Shift") }
        guard !parts.isEmpty else { return nil }
        guard let keyName = HotkeyManager.keyCodes.first(where: { $0.value == UInt32(event.keyCode) })?.key else {
            return nil
        }
        // Config format uses "Space" capitalization; letters stay uppercase.
        parts.append(keyName == "SPACE" ? "Space" : keyName)
        return parts.joined(separator: "+")
    }
}
