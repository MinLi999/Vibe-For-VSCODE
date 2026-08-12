import SwiftUI
import VibeFoxCore

/// Six-step first-run wizard: welcome → microphone → accessibility → hotkey try →
/// practice playground → done. Mirrors the flow validated in the Electron build.
struct OnboardingView: View {
    var isRerun: Bool
    var onFinish: () -> Void

    @EnvironmentObject private var model: AppModel
    @State private var step = 0
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
            if step == 3 && newPhase == .recording {
                hotkeyTried = true
            }
        }
        .onChange(of: model.lastDelivered) { _, delivered in
            // Practice step without accessibility: the synthetic ⌘V can't land — insert directly.
            if step == 4, let delivered, !model.accessibilityTrusted {
                practiceText += (practiceText.isEmpty ? "" : " ") + delivered
            }
        }
        .onChange(of: step) { _, newStep in
            stopMic()
            axTimer?.invalidate()
            if newStep == 2 && !model.accessibilityTrusted {
                axTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { _ in
                    Task { @MainActor in model.refreshAccessibility() }
                }
            }
        }
        .onDisappear {
            stopMic()
            axTimer?.invalidate()
        }
    }

    private var stepDots: some View {
        HStack(spacing: 9) {
            ForEach(0..<6, id: \.self) { index in
                Circle()
                    .fill(index == step ? Color.accentColor : Color.secondary.opacity(0.35))
                    .frame(width: index == step ? 9 : 7, height: index == step ? 9 : 7)
            }
        }
        .animation(.easeOut(duration: 0.15), value: step)
    }

    @ViewBuilder
    private var stepContent: some View {
        switch step {
        case 0:
            VStack(spacing: 14) {
                Text("🦊").font(.system(size: 56))
                Text("欢迎使用 VibeFox").font(.largeTitle.bold())
                Text("按一下热键开始说话,再按一下 —— 清理、排版好的文字就出现在任何应用的光标处。\n中文优先、中英混杂随便说,代码词汇不打折。")
                    .font(.title3).multilineTextAlignment(.center).foregroundStyle(.secondary)
                    .lineSpacing(4)
                infoRow("1", "下面几步会依次准备好:麦克风、自动粘贴权限、热键,最后现场试一次。")
                infoRow("2", "全程约一分钟,以后可在「设置 → 重新运行新手引导」里重来。")
            }
        case 1:
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
        case 2:
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
        case 3:
            VStack(spacing: 14) {
                Text("🔥 试试热键").font(.title.bold())
                Text("现在按下 \(model.config.hotkey) 开始录音,随便说一句,再按一次停止。")
                    .font(.title3).foregroundStyle(.secondary)
                Text(hotkeyTried ? "✓ 热键工作正常!"
                     : model.phase == .recording ? "🔴 正在录音…再按一次热键停止"
                     : "等待你按下热键…")
                    .font(.title3)
                    .foregroundStyle(hotkeyTried ? .green : .secondary)
                Text("热键无反应?可能被其他应用占用,稍后可在「设置」页换一个组合键。")
                    .font(.callout).foregroundStyle(.secondary)
            }
        case 4:
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
            if step > 0 && step < 5 {
                Button("上一步") { step -= 1 }
            }
            if step < 5 {
                Button(step == 0 ? "开始设置" : "下一步") { step += 1 }
                    .buttonStyle(.borderedProminent)
                if step > 0 {
                    Button("跳过") { step += 1 }
                }
            } else {
                Button("开始使用 🎉") { onFinish() }
                    .buttonStyle(.borderedProminent)
            }
        }
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
