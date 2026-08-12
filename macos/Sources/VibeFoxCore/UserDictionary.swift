import Foundation

/// Swift port of client/src/models/UserDictionary.ts — SAME dictionary.json schema, so the
/// native and Electron builds share one dictionary. Three-layer design:
///   L1 selectAsrKeywords() — the <=40 most relevant words per request (ASR bias channel).
///   L2 rewrite-stage phonetic correction — planned, not here.
///   L3 applyReplacements() — deterministic local replacement, unlimited, zero tokens.
public struct DictionaryEntry: Codable, Equatable, Identifiable {
    public var word: String
    public var aliases: [String]
    /// "manual" | "learned" | "contacts" (string-typed to survive hand-edited files).
    public var source: String
    /// Epoch milliseconds (matches TS Date.now()).
    public var addedAt: Double
    public var lastUsedAt: Double?
    public var hits: Int

    public var id: String { word.lowercased() }

    public init(word: String, aliases: [String] = [], source: String = "manual",
                addedAt: Double = 0, lastUsedAt: Double? = nil, hits: Int = 0) {
        self.word = word
        self.aliases = aliases
        self.source = source
        self.addedAt = addedAt
        self.lastUsedAt = lastUsedAt
        self.hits = hits
    }
}

public struct ReplacementRule: Codable, Equatable, Identifiable {
    public var from: String
    public var to: String
    public var caseSensitive: Bool

    public var id: String { from.lowercased() }

    public init(from: String, to: String, caseSensitive: Bool = false) {
        self.from = from
        self.to = to
        self.caseSensitive = caseSensitive
    }
}

public struct UserDictionary: Codable, Equatable {
    public private(set) var entries: [DictionaryEntry]
    public private(set) var replacements: [ReplacementRule]

    public static let entryCap = 10000
    public static let replacementCap = 1000
    public static let maxWordLength = 64
    /// A usage hit outranks one day of pure recency in ASR keyword scoring.
    static let hitWeightMs: Double = 24 * 60 * 60 * 1000

    public init() {
        entries = []
        replacements = []
    }

    /// Sanitizing decode — persisted data is untrusted (hand-edited files, older versions).
    /// Field-level leniency mirrors the TS sanitize: a malformed item or field is skipped or
    /// healed without discarding the rest of the file.
    public init(from decoder: Decoder) throws {
        self.init()
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        var seen = Set<String>()
        let rawEntries = ((try? c.decodeIfPresent([Failable<LenientEntry>].self, forKey: .entries)) ?? nil) ?? []
        for wrapper in rawEntries {
            guard let raw = wrapper.value else { continue }
            guard entries.count < Self.entryCap,
                  let word = raw.word.map(Self.trimmed), Self.isValidWord(word),
                  seen.insert(word.lowercased()).inserted else { continue }
            entries.append(DictionaryEntry(
                word: word,
                aliases: (raw.aliases ?? []).map(Self.trimmed).filter(Self.isValidWord).prefix(8).map { $0 },
                source: ["manual", "learned", "contacts"].contains(raw.source ?? "") ? raw.source! : "manual",
                addedAt: raw.addedAt?.finiteOrNil ?? 0,
                lastUsedAt: raw.lastUsedAt?.finiteOrNil,
                hits: max(0, raw.hits ?? 0)
            ))
        }
        let rawRules = ((try? c.decodeIfPresent([Failable<LenientRule>].self, forKey: .replacements)) ?? nil) ?? []
        for wrapper in rawRules {
            guard let raw = wrapper.value else { continue }
            guard replacements.count < Self.replacementCap,
                  let from = raw.from.map(Self.trimmed), Self.isValidWord(from),
                  let to = raw.to, to.count <= 2000,
                  !replacements.contains(where: { $0.from.lowercased() == from.lowercased() }) else { continue }
            replacements.append(ReplacementRule(from: from, to: to, caseSensitive: raw.caseSensitive ?? false))
        }
    }

    // MARK: mutations

    @discardableResult
    public mutating func addEntry(_ word: String, aliases: [String] = [], source: String = "manual",
                                  now: Double = Date().timeIntervalSince1970 * 1000) -> Bool {
        let trimmed = Self.trimmed(word)
        guard Self.isValidWord(trimmed), entries.count < Self.entryCap, findEntry(trimmed) == nil else { return false }
        entries.append(DictionaryEntry(
            word: trimmed,
            aliases: aliases.map(Self.trimmed).filter(Self.isValidWord).prefix(8).map { $0 },
            source: source, addedAt: now
        ))
        return true
    }

    @discardableResult
    public mutating func updateEntry(_ originalWord: String, word: String? = nil, aliases: [String]? = nil) -> Bool {
        guard let index = entries.firstIndex(where: { $0.word.lowercased() == originalWord.trimmingCharacters(in: .whitespaces).lowercased() }) else { return false }
        if let word {
            let trimmed = Self.trimmed(word)
            guard Self.isValidWord(trimmed) else { return false }
            if let collision = findEntry(trimmed), collision.word.lowercased() != entries[index].word.lowercased() { return false }
            entries[index].word = trimmed
        }
        if let aliases {
            entries[index].aliases = aliases.map(Self.trimmed).filter(Self.isValidWord).prefix(8).map { $0 }
        }
        return true
    }

    @discardableResult
    public mutating func removeEntry(_ word: String) -> Bool {
        let key = Self.trimmed(word).lowercased()
        let before = entries.count
        entries.removeAll { $0.word.lowercased() == key }
        return entries.count < before
    }

    @discardableResult
    public mutating func addReplacement(from: String, to: String, caseSensitive: Bool = false) -> Bool {
        let trimmed = Self.trimmed(from)
        guard Self.isValidWord(trimmed), to.count <= 2000, replacements.count < Self.replacementCap,
              !replacements.contains(where: { $0.from.lowercased() == trimmed.lowercased() }) else { return false }
        replacements.append(ReplacementRule(from: trimmed, to: to, caseSensitive: caseSensitive))
        return true
    }

    @discardableResult
    public mutating func removeReplacement(from: String) -> Bool {
        let key = Self.trimmed(from).lowercased()
        let before = replacements.count
        replacements.removeAll { $0.from.lowercased() == key }
        return replacements.count < before
    }

    /// Merge another export; existing entries win. Returns the number added.
    public mutating func importData(_ other: UserDictionary) -> Int {
        var added = 0
        for entry in other.entries where entries.count < Self.entryCap && findEntry(entry.word) == nil {
            entries.append(entry)
            added += 1
        }
        for rule in other.replacements where addReplacement(from: rule.from, to: rule.to, caseSensitive: rule.caseSensitive) {
            added += 1
        }
        return added
    }

    // MARK: layers

    public func findEntry(_ word: String) -> DictionaryEntry? {
        let key = Self.trimmed(word).lowercased()
        return entries.first { $0.word.lowercased() == key }
    }

    /// L1: score = recency (lastUsedAt, else addedAt — fresh manual adds rank high because the
    /// user just added them BECAUSE they get mis-heard) + hits weighted at one day per hit.
    public func selectAsrKeywords(limit: Int) -> [String] {
        guard limit > 0 else { return [] }
        return entries
            .map { (word: $0.word, score: max($0.lastUsedAt ?? 0, $0.addedAt) + Double($0.hits) * Self.hitWeightMs) }
            .sorted { $0.score > $1.score }
            .prefix(limit)
            .map { $0.word }
    }

    /// L3: literal replacement, longest pattern first so overlapping rules resolve stably.
    /// replacingOccurrences replaces every match in ONE pass over the input, so a rule whose
    /// replacement contains its own pattern (e.g. "vibefox" → "VibeFox app") can never loop
    /// or starve later occurrences — matches the TS global-regex-replace semantics.
    public func applyReplacements(_ text: String) -> String {
        var out = text
        for rule in replacements.sorted(by: { $0.from.count > $1.from.count }) {
            let options: String.CompareOptions = rule.caseSensitive ? [.literal] : [.literal, .caseInsensitive]
            out = out.replacingOccurrences(of: rule.from, with: rule.to, options: options)
        }
        return out
    }

    /// Bumps hits/lastUsedAt for every entry whose word appears in the delivered text.
    @discardableResult
    public mutating func recordUsage(_ text: String, now: Double = Date().timeIntervalSince1970 * 1000) -> Bool {
        let haystack = text.lowercased()
        var touched = false
        for index in entries.indices where haystack.contains(entries[index].word.lowercased()) {
            entries[index].hits += 1
            entries[index].lastUsedAt = now
            touched = true
        }
        return touched
    }

    // MARK: helpers

    static func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespaces) }

    static func isValidWord(_ s: String) -> Bool {
        !s.isEmpty && s.count <= maxWordLength && !s.contains("\n")
    }
}

/// Element wrapper that turns a decode failure into nil instead of failing the whole array
/// (e.g. a bare string where an object is expected).
private struct Failable<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) {
        value = try? T(from: decoder)
    }
}

/// Loose shapes for sanitizing decode: every field decodes independently, so one mistyped
/// field (e.g. addedAt: "nope") heals to nil instead of discarding the entry.
private struct LenientEntry: Decodable {
    var word: String?
    var aliases: [String]?
    var source: String?
    var addedAt: Double?
    var lastUsedAt: Double?
    var hits: Int?

    enum CodingKeys: String, CodingKey { case word, aliases, source, addedAt, lastUsedAt, hits }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        word = ((try? c.decodeIfPresent(String.self, forKey: .word)) ?? nil)
        aliases = ((try? c.decodeIfPresent([String].self, forKey: .aliases)) ?? nil)
        source = ((try? c.decodeIfPresent(String.self, forKey: .source)) ?? nil)
        addedAt = ((try? c.decodeIfPresent(Double.self, forKey: .addedAt)) ?? nil)
        lastUsedAt = ((try? c.decodeIfPresent(Double.self, forKey: .lastUsedAt)) ?? nil)
        hits = ((try? c.decodeIfPresent(Int.self, forKey: .hits)) ?? nil)
    }
}

private struct LenientRule: Decodable {
    var from: String?
    var to: String?
    var caseSensitive: Bool?

    enum CodingKeys: String, CodingKey { case from, to, caseSensitive }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        from = ((try? c.decodeIfPresent(String.self, forKey: .from)) ?? nil)
        to = ((try? c.decodeIfPresent(String.self, forKey: .to)) ?? nil)
        caseSensitive = ((try? c.decodeIfPresent(Bool.self, forKey: .caseSensitive)) ?? nil)
    }
}

private extension Double {
    var finiteOrNil: Double? { isFinite ? self : nil }
}

public enum DictionaryStore {
    public static func load(from dir: URL = AppPaths.userDataDir) -> UserDictionary {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("dictionary.json")),
              let dictionary = try? JSONDecoder().decode(UserDictionary.self, from: data) else {
            return UserDictionary()
        }
        return dictionary
    }

    public static func save(_ dictionary: UserDictionary, to dir: URL = AppPaths.userDataDir) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        if let data = try? encoder.encode(dictionary) {
            try? data.write(to: dir.appendingPathComponent("dictionary.json"), options: .atomic)
        }
    }
}
