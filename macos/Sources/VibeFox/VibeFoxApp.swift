import SwiftUI
import VibeFoxCore

/// Native menu-bar voice input for macOS (SwiftUI rewrite of the Electron desktop app).
/// Same Worker backend, same license key, same on-disk data files as the other frontends.
@main
struct VibeFoxApp: App {
    @StateObject private var model = AppModel()

    init() {
        Self.terminateIfAlreadyRunning()
    }

    /// Single-instance guard (the Electron build's requestSingleInstanceLock equivalent).
    /// Two live instances mean two menu-bar icons, a hotkey conflict, and — the failure that
    /// prompted this guard — a stale instance showing a different data directory's (empty)
    /// dictionary/history. Unbundled dev runs (nil bundle id) are exempt.
    private static func terminateIfAlreadyRunning() {
        guard let bundleId = Bundle.main.bundleIdentifier else { return }
        let myPid = ProcessInfo.processInfo.processIdentifier
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
            .filter { $0.processIdentifier != myPid }
        if let existing = others.first {
            existing.activate()
            exit(0)
        }
    }

    var body: some Scene {
        MenuBarExtra {
            MenuContentView()
                .environmentObject(model)
        } label: {
            // The label renders as soon as the status item exists — the one reliable
            // at-launch hook a MenuBarExtra-only app has (menu content is lazy).
            Image(systemName: menuBarSymbol)
                .task { model.start() }
        }
    }

    private var menuBarSymbol: String {
        switch model.phase {
        case .idle: return "mic.fill"
        case .recording: return "record.circle.fill"
        case .processing: return "hourglass"
        }
    }
}

struct MenuContentView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Button(model.phase == .recording ? "停止录音并转写" : "开始录音") {
            model.toggleRecording()
        }
        .disabled(model.phase == .processing)

        Button("取消录音") {
            model.cancelRecording()
        }
        .disabled(model.phase != .recording)

        Divider()

        Button("设置、词库与历史…") {
            model.settingsWindow.show(model: model)
        }

        Text("热键:\(model.config.hotkey)")

        Divider()

        Button("退出 VibeFox") {
            NSApplication.shared.terminate(nil)
        }
    }
}
