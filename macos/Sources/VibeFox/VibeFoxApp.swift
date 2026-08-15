import SwiftUI
import VibeFoxCore

/// Native menu-bar voice input for macOS (SwiftUI rewrite of the Electron desktop app).
/// Same Worker backend, same license key, same on-disk data files as the other frontends.
@main
struct VibeFoxApp: App {
    @StateObject private var model = AppModel()
    @StateObject private var updater = UpdaterManager()

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
                .environmentObject(updater)
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
    @EnvironmentObject private var updater: UpdaterManager

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

        // The only always-visible home for lastError: a failed start (dead audio engine,
        // missing credentials) otherwise reaches the user only through a system notification
        // they may never have granted — which is exactly what "I pressed it and nothing
        // happened" looked like from their side.
        if let error = model.lastError {
            Text("⚠️ \(error)")
            Button("清除提示") { model.lastError = nil }
        }

        if model.inFlightSegments > 0 {
            Text("正在转写 \(model.inFlightSegments) 段…")
        }
        if model.pendingCount > 0 {
            Text("⚠️ \(model.pendingCount) 段未转写成功(录音已保留)")
            Button("打开设置重试…") {
                model.settingsWindow.show(model: model)
            }
        }

        Divider()

        Button("检查更新…") {
            updater.checkForUpdates()
        }
        .disabled(!updater.canCheckForUpdates)

        Divider()

        Button("退出 VibeFox") {
            NSApplication.shared.terminate(nil)
        }
    }
}
