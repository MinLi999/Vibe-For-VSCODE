import Foundation

/// Swift port of client/src/models/TranscriptHistory.ts — same history.json schema.
/// Privacy contract: history NEVER leaves the machine.
public struct TranscriptHistoryEntry: Codable, Equatable, Identifiable {
    /// Epoch milliseconds of the insertion.
    public var at: Double
    public var text: String

    public var id: Double { at }

    public init(at: Double, text: String) {
        self.at = at
        self.text = text
    }
}

public struct TranscriptHistory {
    public static let cap = 50
    public private(set) var entries: [TranscriptHistoryEntry]

    public init(_ initial: [TranscriptHistoryEntry] = []) {
        // Untrusted persisted data: drop malformed rows, enforce the cap (newest first).
        entries = initial
            .filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.at.isFinite }
            .prefix(Self.cap)
            .map { $0 }
    }

    public mutating func add(_ text: String, now: Double = Date().timeIntervalSince1970 * 1000) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        entries.insert(TranscriptHistoryEntry(at: now, text: trimmed), at: 0)
        if entries.count > Self.cap { entries.removeLast(entries.count - Self.cap) }
    }

    public mutating func clear() { entries = [] }
}

public enum HistoryStore {
    /// Field-lenient row decode: one malformed row is dropped instead of nuking the file.
    private struct LenientRow: Decodable {
        var at: Double?
        var text: String?
        enum CodingKeys: String, CodingKey { case at, text }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            at = ((try? c.decodeIfPresent(Double.self, forKey: .at)) ?? nil)
            text = ((try? c.decodeIfPresent(String.self, forKey: .text)) ?? nil)
        }
    }

    public static func load(from dir: URL = AppPaths.userDataDir) -> TranscriptHistory {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("history.json")),
              let raw = try? JSONDecoder().decode([FailableRow].self, from: data) else {
            return TranscriptHistory()
        }
        let entries = raw.compactMap { row -> TranscriptHistoryEntry? in
            guard let value = row.value, let at = value.at, let text = value.text else { return nil }
            return TranscriptHistoryEntry(at: at, text: text)
        }
        return TranscriptHistory(entries)
    }

    private struct FailableRow: Decodable {
        let value: LenientRow?
        init(from decoder: Decoder) {
            value = try? LenientRow(from: decoder)
        }
    }

    public static func save(_ history: TranscriptHistory, to dir: URL = AppPaths.userDataDir) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        if let data = try? encoder.encode(history.entries) {
            try? data.write(to: dir.appendingPathComponent("history.json"), options: .atomic)
        }
    }
}
