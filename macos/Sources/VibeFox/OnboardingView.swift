import SwiftUI
import VibeFoxCore

/// First-run wizard: welcome → microphone → accessibility → transcription engine →
/// hotkey try → practice playground → done.
///
/// Steps are a named enum, NOT raw indices: the flow used to compare `step == 3` in four
/// places, so inserting a step meant hand-renumbering every comparison. `credentials` had to
/// be inserted BEFORE `hotkey`, because startRecording() bails in checkCredentials() when no
/// key is configured — meaning the hotkey test and the practice step could never pass for an
/// open-source user, who by default has no License Key at all.
struct OnboardingView: View {
    enum Step: Int, CaseIterable, Comparable {
        case welcome, microphone, accessibility, credentials, hotkey, practice, done

        static func < (lhs: Step, rhs: Step) -> Bool { lhs.rawValue < rhs.rawValue }
        var next: Step { Step(rawValue: rawValue + 1) ?? .done }
        var previous: Step { Step(rawValue: rawValue - 1) ?? .welcome }
    }

    var isRerun: Bool
    var onFinish: () -> Void

    @EnvironmentObject private var model: AppModel
    @State private var step: Step = .welcome
    @State private var selectedEngine = "cloudflare"
    @State private var licenseInput = ""
    @State private var providerKeyInput = ""
    @State private var credentialFeedback: String?
    @State private var micGranted: Bool?
    @State private var micLevel: Float = 0
    @State private var micRecorder: AudioRecorder?
    @State private var micTimer: Timer?
    @State private var hotkeyTried = false
    @State private var practiceText = ""
    @State private var axTimer: Timer?

    private static let practiceSamples: [(String, String)] = [
        ("练习 1 · 纯中文", "帮我把这个函数重构一下,把重复的逻辑抽出来。"),
        ("练习 2 · 中英混杂", "用 useEffect 监听 window resize,然后调用 debounce 处理。"),
        ("练习 3 · 口述列表(试试深度润色档)", "我要做三件事,第一,修复登录 bug,第二,更新文档,第三,发布新版本。"),
    ]

    var body: some View {
        VStack(spacing: 24) {
            Spacer(minLength: 10)
            stepContent
                .frame(maxWidth: 600)
            Spacer(minLength: 0)
            navigationBar
                .controlSize(.large)
            stepDots.padding(.bottom, 18)
        }
        .padding(32)
        .onChange(of: model.phase) { _, newPhase in
            if step == .hotkey && newPhase == .recording {
                hotkeyTried = true
            }
        }
        .onChange(of: model.lastDelivered) { _, delivered in
            // Practice step without accessibility: the synthetic ⌘V can't land — insert directly.
            if step == .practice, let delivered, !model.accessibilityTrusted {
                practiceText += (practiceText.isEmpty ? "" : " ") + delivered
            }
        }
        .onChange(of: step) { _, newStep in
            stopMic()
            axTimer?.invalidate()
            if newStep == .accessibility && !model.accessibilityTrusted {
                axTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { _ in
                    Task { @MainActor in model.refreshAccessibility() }
                }
            }
            if newStep == .credentials {
                // Reflect whatever is already configured (onboarding rerun); any non-hosted
                // provider maps onto the BYOK card.
                selectedEngine = model.config.apiProvider == "cloudflare" ? "cloudflare" : "aliyun"
                credentialFeedback = nil
            }
        }
        .onDisappear {
            stopMic()
            axTimer?.invalidate()
        }
    }

    private var stepDots: some View {
        HStack(spacing: 9) {
            ForEach(Step.allCases, id: \.self) { s in
                Circle()
                    .fill(s == step ? Color.accentColor : Color.secondary.opacity(0.35))
                    .frame(width: s == step ? 9 : 7, height: s == step ? 9 : 7)
            }
        }
        .animation(.easeOut(duration: 0.15), value: step)
    }

    @ViewBuilder
    private var stepContent: some View {
        switch step {
        case .welcome:
            VStack(spacing: 14) {
                Text("🦊").font(.system(size: 56))
                Text("欢迎使用 VibeFox").font(.largeTitle.bold())
                Text("按一下热键开始说话,再按一下 —— 清理、排版好的文字就出现在任何应用的光标处。\n中文优先、中英混杂随便说,代码词汇不打折。")
                    .font(.title3).multilineTextAlignment(.center).foregroundStyle(.secondary)
                    .lineSpacing(4)
                infoRow("1", "下面几步会依次准备好:麦克风、自动粘贴权限、转写引擎、热键,最后现场试一次。")
                infoRow("2", "全程约一分钟,以后可在「设置 → 重新运行新手引导」里重来。")
            }
        case .microphone:
            VStack(spacing: 14) {
                Text("🎙️ 麦克风").font(.title.bold())
                Text("点击下方按钮授权麦克风,对着电脑说句话,看到绿条跳动即为正常。")
                    .font(.title3).foregroundStyle(.secondary)
                HStack {
                    Button("授权并测试") { startMicTest() }.buttonStyle(.borderedProminent)
                    LevelMeter(level: micLevel).frame(width: 220)
                }
                if micGranted == false {
                    Text("未获得权限:系统设置 → 隐私与安全性 → 麦克风 → 勾选 VibeFox。")
                        .font(.callout).foregroundStyle(.orange)
                }
            }
        case .accessibility:
            VStack(spacing: 14) {
                Text("⌨️ 自动粘贴权限").font(.title.bold())
                Text("VibeFox 通过模拟 ⌘V 把文字粘进当前应用,macOS 要求先授予「辅助功能」权限。")
                    .font(.title3).foregroundStyle(.secondary)
                HStack {
                    Text(model.accessibilityTrusted ? "已授权 ✓" : "未授权")
                        .foregroundStyle(model.accessibilityTrusted ? .green : .orange)
                        .fontWeight(.semibold)
                    Button("打开系统设置授权") {
                        _ = PasteService.accessibilityTrusted(prompt: true)
                        PasteService.openAccessibilitySettings()
                    }
                    .disabled(model.accessibilityTrusted)
                }
                Text("勾选 VibeFox 后需要退出并重新打开 VibeFox 才生效(引导结束后会提醒)。没有该权限时,转写结果会留在剪贴板,手动 ⌘V 也能用。")
                    .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
        case .credentials:
            VStack(spacing: 14) {
                Text("🔑 选择转写引擎").font(.title.bold())
                Text("语音转文字需要一个云端引擎,二选一即可(以后可在「设置」页随时切换):")
                    .font(.title3).foregroundStyle(.secondary).multilineTextAlignment(.center)
                HStack(alignment: .top, spacing: 12) {
                    engineCard(
                        provider: "cloudflare", title: "官方托管", badge: "最省事",
                        lines: ["无需申请任何 Key,粘贴 License Key 即用",
                                "阿里云 Qwen 双模型 + 区域自动路由",
                                "在 vibefox.app 获取 License Key"])
                    engineCard(
                        provider: "aliyun", title: "自带 API Key", badge: "免费",
                        lines: ["自行申请阿里云百炼 API Key(免费注册)",
                                "同款 Qwen 引擎,用量走你自己的账单",
                                "适合开源自助用户,无月度上限"])
                }
                credentialEntryRow
                if let credentialFeedback {
                    Text(credentialFeedback).font(.callout).foregroundStyle(.green)
                }
                Text("现在跳过也可以,之后在「设置」页填写;但下一步的热键试用需要先配置好引擎。")
                    .font(.callout).foregroundStyle(.secondary)
            }
        case .hotkey:
            VStack(spacing: 14) {
                Text("🔥 试试热键").font(.title.bold())
                Text("现在按下 \(model.config.hotkey) 开始录音,随便说一句,再按一次停止。")
                    .font(.title3).foregroundStyle(.secondary)
                if !credentialsConfigured {
                    Text("尚未配置转写引擎,录音后会提示缺少 Key —— 回上一步即可配置。")
                        .font(.callout).foregroundStyle(.orange)
                }
                Text(hotkeyTried ? "✓ 热键工作正常!"
                     : model.phase == .recording ? "🔴 正在录音…再按一次热键停止"
                     : "等待你按下热键…")
                    .font(.title3)
                    .foregroundStyle(hotkeyTried ? .green : .secondary)
                Text("热键无反应?可能被其他应用占用,稍后可在「设置」页换一个组合键。")
                    .font(.callout).foregroundStyle(.secondary)
            }
        case .practice:
            VStack(alignment: .leading, spacing: 10) {
                Text("✍️ 现场练习").font(.title.bold()).frame(maxWidth: .infinity)
                Text("把光标放进下面的输入框,按热键 \(model.config.hotkey) 照着念一条:")
                    .font(.title3).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                ForEach(Self.practiceSamples, id: \.0) { title, sample in
                    (Text(title + "  ").bold().foregroundColor(.accentColor) + Text(sample))
                        .font(.body)
                        .padding(11)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 9))
                }
                TextEditor(text: $practiceText)
                    .font(.body)
                    .frame(height: 100)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
                if !model.accessibilityTrusted {
                    Text("尚未授权辅助功能:转写结果会自动填进上面的框(正式使用时在剪贴板,手动 ⌘V)。")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }
        default:
            VStack(spacing: 14) {
                Text("🎉 就绪!").font(.title.bold())
                Text("VibeFox 已常驻菜单栏(麦克风图标),在任何应用里按 \(model.config.hotkey) 即可语音输入。")
                    .font(.title3).foregroundStyle(.secondary).multilineTextAlignment(.center)
                infoRow("词库", "把常被听错的人名、产品名、代码标识符加进「词库」页,识别立刻变准。")
                infoRow("排版", "「风格」页选「深度润色」,口述\u{201C}第一…第二…\u{201D}会自动排成编号列表。")
                if !model.accessibilityTrusted {
                    infoRow("提醒", "你刚授权了辅助功能的话,记得退出并重开 VibeFox 让自动粘贴生效。")
                }
            }
        }
    }

    private var navigationBar: some View {
        HStack(spacing: 10) {
            if step > .welcome && step < .done {
                Button("上一步") { step = step.previous }
            }
            if step < .done {
                Button(step == .welcome ? "开始设置" : "下一步") { step = step.next }
                    .buttonStyle(.borderedProminent)
                if step > .welcome {
                    Button("跳过") { step = step.next }
                }
            } else {
                Button("开始使用 🎉") { onFinish() }
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    // MARK: transcription engine step

    /// True once the currently selected provider has usable credentials — mirrors the
    /// checks in AppModel.checkCredentials() so the hint on the hotkey step is honest.
    private var credentialsConfigured: Bool {
        switch model.config.apiProvider {
        case "cloudflare": return model.licenseKeyPresent
        case "custom": return !model.config.customEndpoint.isEmpty
        default: return model.providerKeyPresent(model.config.apiProvider)
        }
    }

    private func engineCard(provider: String, title: String, badge: String, lines: [String]) -> some View {
        let selected = selectedEngine == provider
        return Button {
            selectedEngine = provider
            credentialFeedback = nil
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(title).font(.headline)
                    Text(badge)
                        .font(.caption.bold())
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(selected ? Color.accentColor : Color.secondary.opacity(0.3),
                                    in: Capsule())
                        .foregroundStyle(selected ? .white : .primary)
                    Spacer()
                    if selected {
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor)
                    }
                }
                ForEach(lines, id: \.self) { line in
                    Text("· " + line).font(.callout).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(13)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(selected ? 0.55 : 0.25), in: RoundedRectangle(cornerRadius: 11))
            .overlay(RoundedRectangle(cornerRadius: 11)
                .stroke(selected ? Color.accentColor : Color.secondary.opacity(0.25),
                        lineWidth: selected ? 2 : 1))
        }
        .buttonStyle(.plain)
    }

    /// Key entry for the selected card. Selecting a card is browsing only — nothing is
    /// persisted until 保存, so flipping between cards never breaks an existing setup.
    @ViewBuilder
    private var credentialEntryRow: some View {
        if selectedEngine == "cloudflare" {
            HStack(spacing: 8) {
                SecureField("粘贴 License Key", text: $licenseInput)
                    .textFieldStyle(.roundedBorder).frame(maxWidth: 320)
                Button("保存") { saveHostedKey() }
                    .disabled(licenseInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if model.config.apiProvider == "cloudflare" && model.licenseKeyPresent {
                    Text("已配置 ✓").font(.callout).foregroundStyle(.green)
                }
            }
            Link("还没有 License Key?去 vibefox.app 获取 →",
                 destination: URL(string: "https://vibefox.app")!)
                .font(.callout)
        } else {
            HStack(spacing: 8) {
                SecureField("粘贴阿里云百炼 API Key(sk-…)", text: $providerKeyInput)
                    .textFieldStyle(.roundedBorder).frame(maxWidth: 320)
                Button("保存") { saveAliyunKey() }
                    .disabled(providerKeyInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if model.config.apiProvider == "aliyun" && model.providerKeyPresent("aliyun") {
                    Text("已配置 ✓").font(.callout).foregroundStyle(.green)
                }
            }
            Link("免费申请:阿里云百炼控制台 → API-KEY 管理 →",
                 destination: URL(string: "https://bailian.console.aliyun.com/?apiKey=1")!)
                .font(.callout)
        }
    }

    private func saveHostedKey() {
        let key = licenseInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return }
        model.setLicenseKey(key)
        model.config.apiProvider = "cloudflare"
        model.saveConfig()
        licenseInput = ""
        credentialFeedback = "已保存,使用官方托管引擎 ✓"
    }

    private func saveAliyunKey() {
        let key = providerKeyInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return }
        model.setProviderKey(key, for: "aliyun")
        model.config.apiProvider = "aliyun"
        model.saveConfig()
        providerKeyInput = ""
        credentialFeedback = "已保存,使用你自己的阿里云 Key ✓"
    }

    private func infoRow(_ tag: String, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(tag).bold().foregroundColor(.accentColor)
            Text(text).frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.body)
        .padding(12)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 9))
    }

    private func startMicTest() {
        Task {
            let granted = await AudioRecorder.requestMicrophoneAccess()
            micGranted = granted
            guard granted else { return }
            let recorder = AudioRecorder()
            do {
                try recorder.start()
            } catch {
                return
            }
            micRecorder = recorder
            micTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
                Task { @MainActor in micLevel = recorder.inputLevel }
            }
        }
    }

    private func stopMic() {
        micTimer?.invalidate()
        micTimer = nil
        micRecorder?.cancel()
        micRecorder = nil
        micLevel = 0
    }
}
