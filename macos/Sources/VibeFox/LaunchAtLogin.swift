import Foundation
import ServiceManagement

/// Thin wrapper over SMAppService.mainApp. The enabled/disabled state lives in the SYSTEM
/// (System Settings → General → Login Items), not in config.json — always read it fresh so
/// the toggle can't drift from what the user flips in System Settings directly.
enum LaunchAtLogin {
    /// SMAppService needs a real bundle identity; unbundled dev runs (swift run) have none.
    static var isSupported: Bool { Bundle.main.bundleIdentifier != nil }

    static var isEnabled: Bool {
        guard isSupported else { return false }
        return SMAppService.mainApp.status == .enabled
    }

    /// Throws when macOS refuses (e.g. the user denied it in System Settings, where the
    /// switch can also be flipped back).
    static func set(_ enabled: Bool) throws {
        if enabled {
            try SMAppService.mainApp.register()
        } else {
            try SMAppService.mainApp.unregister()
        }
    }
}
