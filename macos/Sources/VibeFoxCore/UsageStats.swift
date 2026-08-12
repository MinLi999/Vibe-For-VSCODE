import Foundation

/// Swift port of desktop/src/statsStore.ts — same stats.json schema. Local-only.
public struct DayStats: Codable, Equatable {
    public var chars: Int
    public var sessions: Int

    public init(chars: Int = 0, sessions: Int = 0) {
        self.chars = chars
        self.sessions = sessions
    }
}

public struct UsageStats: Codable, Equatable {
    public var totalChars: Int
    public var totalSessions: Int
    /// Keyed by local date "YYYY-MM-DD"; pruned to the most recent 90 days.
    public var days: [String: DayStats]

    static let daysKept = 90

    public init(totalChars: Int = 0, totalSessions: Int = 0, days: [String: DayStats] = [:]) {
        self.totalChars = totalChars
        self.totalSessions = totalSessions
        self.days = days
    }

    /// Local-timezone day key — usage rolls over at the user's midnight, not UTC's.
    /// POSIX locale + Gregorian calendar pinned: with the user's locale a non-Gregorian
    /// system calendar (Buddhist/Japanese) would emit years like "2569" and split the
    /// same day into multiple keys across builds.
    public static func dayKey(_ date: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    public mutating func recordSession(chars: Int, on date: Date = Date()) {
        totalChars += chars
        totalSessions += 1
        let key = Self.dayKey(date)
        var day = days[key] ?? DayStats()
        day.chars += chars
        day.sessions += 1
        days[key] = day
        let sorted = days.keys.sorted()
        for stale in sorted.prefix(max(0, sorted.count - Self.daysKept)) {
            days.removeValue(forKey: stale)
        }
    }

    public var todayChars: Int { days[Self.dayKey()]?.chars ?? 0 }
}

public enum StatsStore {
    public static func load(from dir: URL = AppPaths.userDataDir) -> UsageStats {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("stats.json")),
              let stats = try? JSONDecoder().decode(UsageStats.self, from: data) else {
            return UsageStats()
        }
        return stats
    }

    public static func save(_ stats: UsageStats, to dir: URL = AppPaths.userDataDir) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        if let data = try? encoder.encode(stats) {
            try? data.write(to: dir.appendingPathComponent("stats.json"), options: .atomic)
        }
    }
}
