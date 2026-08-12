import Foundation
import Testing
@testable import VibeFoxCore

// MARK: TranscriptHistory

@Test func historyCapsAtFiftyNewestFirst() {
    var history = TranscriptHistory()
    for i in 1...60 {
        history.add("第 \(i) 条", now: Double(i))
    }
    #expect(history.entries.count == TranscriptHistory.cap)
    #expect(history.entries.first?.text == "第 60 条")
    #expect(history.entries.last?.text == "第 11 条")
}

@Test func historyIgnoresBlankText() {
    var history = TranscriptHistory()
    history.add("   \n ", now: 1)
    history.add("真内容", now: 2)
    #expect(history.entries.count == 1)
}

@Test func historySanitizesUntrustedInitialData() {
    let history = TranscriptHistory([
        TranscriptHistoryEntry(at: 1, text: "好的"),
        TranscriptHistoryEntry(at: .infinity, text: "坏时间戳"),
        TranscriptHistoryEntry(at: 2, text: "  "),
    ])
    #expect(history.entries.map(\.text) == ["好的"])
}

// MARK: UsageStats

@Test func statsPruneKeepsMostRecentNinetyDays() {
    var stats = UsageStats()
    var days: [String: DayStats] = [:]
    for i in 0..<120 {
        days[String(format: "2026-01-01-%03d", i)] = DayStats(chars: 1, sessions: 1)
    }
    // Keys sort lexicographically; recordSession prunes to the newest 90.
    stats.days = days
    stats.recordSession(chars: 10)
    #expect(stats.days.count <= 91) // 90 kept + today's key.
    #expect(stats.days[String(format: "2026-01-01-%03d", 0)] == nil) // Oldest gone.
}

@Test func dayKeyIsGregorianRegardlessOfLocale() {
    let key = UsageStats.dayKey(Date(timeIntervalSince1970: 0))
    // Jan 1 1970 in every timezone lands in 1969-12-31 or 1970-01-01 — never a Buddhist 2512.
    #expect(key.hasPrefix("1969-") || key.hasPrefix("1970-"))
    #expect(key.count == 10)
}

// MARK: HotkeyManager.parse

@Test func hotkeyParseAcceptsElectronAccelerators() throws {
    let parsed = try #require(HotkeyManager.parse("Command+Alt+Z"))
    #expect(parsed.keyCode == 6) // kVK_ANSI_Z
    #expect(parsed.carbonModifiers == 256 | 2048) // cmd | option

    let space = try #require(HotkeyManager.parse("Control+Shift+Space"))
    #expect(space.keyCode == 49)

    let fkey = try #require(HotkeyManager.parse("command+F5")) // Case-insensitive parts.
    #expect(fkey.keyCode == 96)
}

@Test func hotkeyParseRejectsInvalidCombos() {
    #expect(HotkeyManager.parse("Z") == nil) // No modifier.
    #expect(HotkeyManager.parse("Command+Alt") == nil) // No key.
    #expect(HotkeyManager.parse("Command+囧") == nil) // Unknown key name.
    #expect(HotkeyManager.parse("") == nil)
}

// MARK: FrontmostApp.categorize

@Test func bundleIdCategoriesMatchElectronTable() {
    #expect(FrontmostApp.categorize(bundleId: "com.anthropic.claudefordesktop") == "chat")
    #expect(FrontmostApp.categorize(bundleId: "com.todesktop.230313mzl4w4u92") == "ide") // Cursor
    #expect(FrontmostApp.categorize(bundleId: "com.jetbrains.intellij") == "ide")
    #expect(FrontmostApp.categorize(bundleId: "md.obsidian") == "notes")
    #expect(FrontmostApp.categorize(bundleId: "com.googlecode.iterm2") == "terminal")
    #expect(FrontmostApp.categorize(bundleId: "com.apple.Safari") == "other") // Browsers = other.
}
