import Foundation

/// Local-only, CONTENT-FREE diagnostics: per-segment lifecycle events (byte counts, engines,
/// timings, reason codes, capture peaks) — never transcript text, matching the server-side
/// logging philosophy. Exists to answer the field report "the mic reacted but nothing was
/// inserted and history has no record": every silent drop now leaves a visible trace with the
/// evidence needed to split capture problems (low peak) from engine problems (high peak but
/// both engines heard nothing) from transport problems (error codes).
public struct DiagnosticEvent: Codable, Identifiable, Sendable {
    public let id: UUID
    /// Epoch milliseconds.
    public let at: Double
    /// Machine-readable kind, e.g. "segment_sent", "server_no_speech", "delivered".
    public let kind: String
    /// Content-free details, e.g. "peak=3200 bytes=64000".
    public let detail: String

    public init(at: Double = Date().timeIntervalSince1970 * 1000, kind: String, detail: String) {
        self.id = UUID()
        self.at = at
        self.kind = kind
        self.detail = detail
    }
}

public final class DiagnosticsLog: @unchecked Sendable {
    public static let cap = 300

    private let lock = NSLock()
    private var events: [DiagnosticEvent] = []
    private let fileURL: URL?
    private let ioQueue = DispatchQueue(label: "vibefox.diagnostics.io", qos: .utility)

    /// Loads the persisted tail (last `cap` events) and compacts the file back down to it —
    /// natural rotation on every launch, no separate size management needed.
    public init(fileURL: URL?) {
        self.fileURL = fileURL
        if let fileURL, let data = try? Data(contentsOf: fileURL), let text = String(data: data, encoding: .utf8) {
            let decoder = JSONDecoder()
            events = text.split(separator: "\n")
                .compactMap { line in (try? decoder.decode(DiagnosticEvent.self, from: Data(line.utf8))) }
                .suffix(Self.cap)
                .map { $0 }
            persistAll()
        }
    }

    public func log(_ kind: String, _ detail: String) {
        let event = DiagnosticEvent(kind: kind, detail: detail)
        lock.lock()
        events.append(event)
        if events.count > Self.cap {
            events.removeFirst(events.count - Self.cap)
        }
        lock.unlock()
        append(event)
    }

    public func recent(_ n: Int = 50) -> [DiagnosticEvent] {
        lock.lock(); defer { lock.unlock() }
        return Array(events.suffix(n))
    }

    public func clear() {
        lock.lock()
        events = []
        lock.unlock()
        persistAll()
    }

    /// Human-readable dump for the "复制诊断日志" button.
    public func exportText() -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        lock.lock(); defer { lock.unlock() }
        return events
            .map { "\(formatter.string(from: Date(timeIntervalSince1970: $0.at / 1000))) \($0.kind) \($0.detail)" }
            .joined(separator: "\n")
    }

    private func append(_ event: DiagnosticEvent) {
        guard let fileURL else { return }
        ioQueue.async {
            guard let data = try? JSONEncoder().encode(event) else { return }
            let line = data + Data("\n".utf8)
            if let handle = try? FileHandle(forWritingTo: fileURL) {
                defer { try? handle.close() }
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: line)
            } else {
                try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? line.write(to: fileURL)
            }
        }
    }

    private func persistAll() {
        guard let fileURL else { return }
        lock.lock()
        let snapshot = events
        lock.unlock()
        ioQueue.async {
            let encoder = JSONEncoder()
            let lines = snapshot.compactMap { try? encoder.encode($0) }.compactMap { String(data: $0, encoding: .utf8) }
            try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? (lines.joined(separator: "\n") + (lines.isEmpty ? "" : "\n")).write(to: fileURL, atomically: true, encoding: .utf8)
        }
    }
}
