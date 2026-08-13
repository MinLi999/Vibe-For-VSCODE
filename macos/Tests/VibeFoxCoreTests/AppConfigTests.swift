import Foundation
import Testing
@testable import VibeFoxCore

private func decodeConfig(_ json: String) -> AppConfig {
    var config = (try? JSONDecoder().decode(AppConfig.self, from: Data(json.utf8))) ?? .default
    config.normalize()
    return config
}

@Test func missingFieldsHealToDefaults() {
    let config = decodeConfig("{}")
    #expect(config.hotkey == "Command+Alt+Z")
    #expect(config.rewriteMode == "clean")
    #expect(config.maxRecordSeconds == 120)
    #expect(!config.onboardingDone)
}

@Test func reservedHotkeyAutoHeals() {
    let config = decodeConfig(#"{"hotkey": "Control+Alt+Space"}"#)
    #expect(config.hotkey == "Command+Alt+Z")
}

@Test func legacyZhLanguageMigratesToAuto() {
    #expect(decodeConfig(#"{"language": "zh"}"#).language == "auto")
    #expect(decodeConfig(#"{"language": "en"}"#).language == "en")
}

@Test func legacyWorkersDevEndpointMigratesToCustomDomain() {
    let config = decodeConfig(#"{"endpoint": "https://vibe-voice-worker.presley-us.workers.dev"}"#)
    #expect(config.endpoint == "https://api.vibefox.app")
    // A self-hoster's own endpoint must NOT be touched by this migration.
    #expect(decodeConfig(#"{"endpoint": "https://my-own-worker.example.workers.dev"}"#).endpoint == "https://my-own-worker.example.workers.dev")
}

@Test func boundsAndWhitelistsClamp() {
    let config = decodeConfig(#"{"maxRecordSeconds": 9999, "rewriteMode": "nonsense", "endpoint": "https://x.example.com///"}"#)
    #expect(config.maxRecordSeconds == 600)
    #expect(config.rewriteMode == "clean")
    #expect(config.endpoint == "https://x.example.com")
}

@Test func mistypedFieldHealsWithoutDiscardingOthers() {
    let config = decodeConfig(#"{"maxRecordSeconds": "not-a-number", "hotkey": "Command+Shift+D"}"#)
    #expect(config.maxRecordSeconds == 120)
    #expect(config.hotkey == "Command+Shift+D")
}
