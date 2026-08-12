import Foundation
import Testing
@testable import VibeFoxCore

// Mirrors client/src/models/UserDictionary.test.ts so the Swift and TS implementations
// provably agree on the shared dictionary.json semantics.

private func decodeDictionary(_ json: String) -> UserDictionary {
    (try? JSONDecoder().decode(UserDictionary.self, from: Data(json.utf8))) ?? UserDictionary()
}

@Test func sanitizesCorruptedPersistedData() {
    let dict = decodeDictionary("""
    {
      "entries": [
        {"word": "Claude Code", "aliases": ["克劳德"], "source": "manual", "addedAt": 1, "lastUsedAt": null, "hits": 2},
        {"word": "", "source": "manual"},
        {"word": "claude code"},
        "not-an-object",
        {"word": "\(String(repeating: "x", count: 100))"},
        {"word": "DashScope", "hits": -5, "addedAt": "nope"}
      ],
      "replacements": [
        {"from": "at sign", "to": "@", "caseSensitive": false},
        {"from": "", "to": "x"}
      ]
    }
    """)
    #expect(dict.entries.map(\.word) == ["Claude Code", "DashScope"])
    #expect(dict.findEntry("dashscope")?.hits == 0)
    #expect(dict.findEntry("dashscope")?.addedAt == 0)
    #expect(dict.replacements.count == 1)
}

@Test func rejectsCaseInsensitiveDuplicates() {
    var dict = UserDictionary()
    let first = dict.addEntry("useEffect", now: 10)
    let duplicate = dict.addEntry("USEEFFECT", now: 20)
    #expect(first)
    #expect(!duplicate)
    #expect(dict.findEntry("useeffect")?.word == "useEffect")
}

@Test func selectAsrKeywordsRanksFreshAddsAndHeavyUseAboveStale() {
    let day: Double = 24 * 60 * 60 * 1000
    var dict = UserDictionary()
    dict.addEntry("StaleWord", now: 1 * day)
    dict.addEntry("FreshAdd", now: 10 * day)
    dict.addEntry("HeavyUse", now: 2 * day)
    for _ in 0..<5 {
        dict.recordUsage("we said HeavyUse here", now: 3 * day)
    }
    #expect(dict.selectAsrKeywords(limit: 2) == ["FreshAdd", "HeavyUse"])
    #expect(dict.selectAsrKeywords(limit: 0).isEmpty)
}

@Test func applyReplacementsIsCaseInsensitiveLiteralLongestFirst() {
    var dict = UserDictionary()
    dict.addReplacement(from: "at sign", to: "@")
    dict.addReplacement(from: "at sign email", to: "a@b.com")
    dict.addReplacement(from: "c++", to: "C++")
    #expect(dict.applyReplacements("my At Sign Email please") == "my a@b.com please")
    #expect(dict.applyReplacements("learn c++ today") == "learn C++ today")
    #expect(dict.applyReplacements("dollar $1 stays") == "dollar $1 stays")
}

@Test func applyReplacementsHandlesAllOccurrencesAndSelfReferencingRules() {
    var dict = UserDictionary()
    // The replacement contains its own pattern (case-insensitively) — must neither loop
    // forever nor stop after the first occurrence.
    dict.addReplacement(from: "vibefox", to: "VibeFox App")
    #expect(dict.applyReplacements("装 vibefox,推荐 VIBEFOX") == "装 VibeFox App,推荐 VibeFox App")
}

@Test func recordUsageBumpsOnlyMatchingWords() {
    var dict = UserDictionary()
    dict.addEntry("VibeFox", now: 1)
    dict.addEntry("Redis", now: 1)
    let touched = dict.recordUsage("deploy vibefox now", now: 99)
    #expect(touched)
    #expect(dict.findEntry("VibeFox")?.hits == 1)
    #expect(dict.findEntry("VibeFox")?.lastUsedAt == 99)
    #expect(dict.findEntry("Redis")?.hits == 0)
}

@Test func importMergesWithoutClobbering() {
    var dict = UserDictionary()
    dict.addEntry("Claude", now: 1)
    let incoming = decodeDictionary("""
    {"entries": [{"word": "claude", "addedAt": 2}, {"word": "Qwen", "addedAt": 2}],
     "replacements": [{"from": "at sign", "to": "@"}]}
    """)
    let added = dict.importData(incoming)
    #expect(added == 2)
    #expect(dict.entries.count == 2)
    #expect(dict.replacements.count == 1)
}

@Test func updateEntryRenamesPreservesStatsRefusesCollisions() {
    var dict = UserDictionary()
    dict.addEntry("Posgres", now: 1)
    dict.addEntry("Redis", now: 1)
    dict.recordUsage("Posgres is here", now: 5)
    let renamed = dict.updateEntry("posgres", word: "PostgreSQL", aliases: ["Posgres"])
    #expect(renamed)
    #expect(dict.findEntry("PostgreSQL")?.hits == 1)
    let collision = dict.updateEntry("PostgreSQL", word: "redis")
    #expect(!collision)
}

@Test func jsonRoundTripKeepsTsSchema() throws {
    var dict = UserDictionary()
    dict.addEntry("Claude Code", aliases: ["克劳德"], now: 1234)
    dict.addReplacement(from: "at sign", to: "@")
    let data = try JSONEncoder().encode(dict)
    let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    let entry = (object?["entries"] as? [[String: Any]])?.first
    #expect(Set(entry?.keys.map { $0 } ?? []) == ["word", "aliases", "source", "addedAt", "hits"]
        || Set(entry?.keys.map { $0 } ?? []) == ["word", "aliases", "source", "addedAt", "lastUsedAt", "hits"])
    let rule = (object?["replacements"] as? [[String: Any]])?.first
    #expect(Set(rule?.keys.map { $0 } ?? []) == ["from", "to", "caseSensitive"])
}
