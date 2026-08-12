import Foundation
import Testing
@testable import VibeFoxCore

/// Store round-trips through real files in an isolated temp dir, plus fixtures in the exact
/// format the Electron/TS build writes — the two builds share these files, so cross-build
/// compatibility is a contract, not an accident.
private func tempDir() -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("vibefox-tests-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

private func write(_ text: String, _ name: String, in dir: URL) {
    try? text.data(using: .utf8)!.write(to: dir.appendingPathComponent(name))
}

@Test func configRoundTripPersistsEdits() {
    let dir = tempDir()
    defer { try? FileManager.default.removeItem(at: dir) }
    var config = ConfigStore.load(from: dir) // Materializes defaults.
    config.rewriteMode = "rewrite"
    config.maxRecordSeconds = 300
    ConfigStore.save(config, to: dir)
    let reloaded = ConfigStore.load(from: dir)
    #expect(reloaded.rewriteMode == "rewrite")
    #expect(reloaded.maxRecordSeconds == 300)
}

@Test func configLoadHealsCorruptedFile() {
    let dir = tempDir()
    defer { try? FileManager.default.removeItem(at: dir) }
    write("{{{{not json", "config.json", in: dir)
    let config = ConfigStore.load(from: dir)
    #expect(config.hotkey == AppConfig.default.hotkey)
    // And the healed file was materialized back to disk.
    let reloaded = ConfigStore.load(from: dir)
    #expect(reloaded == config)
}

@Test func dictionaryRoundTripSurvivesRestart() {
    let dir = tempDir()
    defer { try? FileManager.default.removeItem(at: dir) }
    var dict = UserDictionary()
    dict.addEntry("Careby", now: 1)
    dict.addEntry("WiseMum", aliases: ["Wise Mom"], now: 2)
    dict.addReplacement(from: "艾特", to: "@")
    dict.recordUsage("Careby is here", now: 3)
    DictionaryStore.save(dict, to: dir)

    let reloaded = DictionaryStore.load(from: dir)
    #expect(reloaded.entries.map(\.word) == ["Careby", "WiseMum"])
    #expect(reloaded.findEntry("Careby")?.hits == 1)
    #expect(reloaded.findEntry("WiseMum")?.aliases == ["Wise Mom"])
    #expect(reloaded.replacements.count == 1)
}

@Test func dictionaryReadsElectronFormat() {
    // Exactly what the TS build writes: explicit null lastUsedAt, integer timestamps.
    let dir = tempDir()
    defer { try? FileManager.default.removeItem(at: dir) }
    write("""
    {
      "entries": [
        {"word": "useEffect", "aliases": ["use effect"], "source": "manual", "addedAt": 1723100000000, "lastUsedAt": null, "hits": 0},
        {"word": "Qwen", "aliases": [], "source": "learned", "addedAt": 1723100001000, "lastUsedAt": 1723100002000, "hits": 3}
      ],
      "replacements": [{"from": "at sign", "to": "@", "caseSensitive": false}]
    }
    """, "dictionary.json", in: dir)
    let dict = DictionaryStore.load(from: dir)
    #expect(dict.entries.count == 2)
    #expect(dict.findEntry("useEffect")?.lastUsedAt == nil)
    #expect(dict.findEntry("Qwen")?.hits == 3)
    #expect(dict.findEntry("Qwen")?.source == "learned")
    #expect(dict.replacements.first?.to == "@")
}

@Test func historyRoundTripAndElectronFormat() {
    let dir = tempDir()
    defer { try? FileManager.default.removeItem(at: dir) }
    // Electron writes an array of {at, text} with integer timestamps.
    write(#"[{"at": 1723100000000, "text": "第一句"}, {"at": 1723100001000, "text": "第二句"}, {"at": "corrupt"}, {"text": ""}]"#,
          "history.json", in: dir)
    var history = HistoryStore.load(from: dir)
    #expect(history.entries.map(\.text) == ["第一句", "第二句"]) // Malformed/blank rows dropped.

    history.add("第三句", now: 1723100002000)
    HistoryStore.save(history, to: dir)
    let reloaded = HistoryStore.load(from: dir)
    #expect(reloaded.entries.first?.text == "第三句")
    #expect(reloaded.entries.count == 3)
}

@Test func statsRoundTripAccumulates() {
    let dir = tempDir()
    defer { try? FileManager.default.removeItem(at: dir) }
    var stats = StatsStore.load(from: dir)
    stats.recordSession(chars: 100)
    stats.recordSession(chars: 50)
    StatsStore.save(stats, to: dir)
    let reloaded = StatsStore.load(from: dir)
    #expect(reloaded.totalChars == 150)
    #expect(reloaded.totalSessions == 2)
    #expect(reloaded.todayChars == 150)
}

@Test func missingFilesLoadAsEmptyNotCrash() {
    let dir = tempDir()
    defer { try? FileManager.default.removeItem(at: dir) }
    #expect(DictionaryStore.load(from: dir).entries.isEmpty)
    #expect(HistoryStore.load(from: dir).entries.isEmpty)
    #expect(StatsStore.load(from: dir).totalChars == 0)
}
