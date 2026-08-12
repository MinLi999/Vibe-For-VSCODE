import Foundation

/// Filesystem locations shared with the Electron build: the native app reads and writes the
/// exact same JSON files, so a user switching builds keeps their config, dictionary, history
/// and stats without any migration step.
public enum AppPaths {
    /// ~/Library/Application Support/VibeFox (Electron's app.getPath('userData') for productName "VibeFox").
    /// VIBEFOX_DATA_DIR overrides for development/smoke-testing against an isolated directory.
    public static var userDataDir: URL {
        if let override = ProcessInfo.processInfo.environment["VIBEFOX_DATA_DIR"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        return FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("VibeFox", isDirectory: true)
    }

    public static var configFile: URL { userDataDir.appendingPathComponent("config.json") }
    public static var dictionaryFile: URL { userDataDir.appendingPathComponent("dictionary.json") }
    public static var historyFile: URL { userDataDir.appendingPathComponent("history.json") }
    public static var statsFile: URL { userDataDir.appendingPathComponent("stats.json") }

    public static func ensureUserDataDir() {
        try? FileManager.default.createDirectory(at: userDataDir, withIntermediateDirectories: true)
    }
}
