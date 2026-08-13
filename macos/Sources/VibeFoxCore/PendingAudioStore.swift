import Foundation

/// Safety net for the "I spoke and nothing came out" failure: every segment's audio is kept
/// on disk until its text is actually delivered. A segment that fails (timeout, 502 no-speech
/// on real audio, network drop) stays here so it can be retried instead of being lost — the
/// recording is the only irreplaceable part of the pipeline; everything else can be redone.
///
/// Files live in userData/pending-audio/ as raw m4a. Deleted the moment delivery succeeds, so
/// in the happy path this directory is empty and costs nothing.
public struct PendingAudio: Codable, Identifiable, Sendable {
    public let id: UUID
    /// Epoch milliseconds of capture.
    public let at: Double
    public let fileName: String
    public let durationMs: Int
    public let peak: Int
    /// How many times transcription has been attempted (1 = the original attempt).
    public var attempts: Int
    /// Reason the last attempt failed, for display ("no_speech", "timeout", …).
    public var lastError: String

    public init(at: Double, fileName: String, durationMs: Int, peak: Int, attempts: Int, lastError: String) {
        self.id = UUID()
        self.at = at
        self.fileName = fileName
        self.durationMs = durationMs
        self.peak = peak
        self.attempts = attempts
        self.lastError = lastError
    }
}

public final class PendingAudioStore: @unchecked Sendable {
    /// Beyond this, the oldest entries are dropped — a safety net, not an archive.
    public static let cap = 20
    /// Entries older than this are swept on load; a week-old failed take is not worth retrying.
    static let maxAgeMs: Double = 7 * 24 * 60 * 60 * 1000

    private let lock = NSLock()
    private let directory: URL
    private let indexURL: URL
    private var entries: [PendingAudio] = []

    public init(userDataDir: URL) {
        directory = userDataDir.appendingPathComponent("pending-audio", isDirectory: true)
        indexURL = directory.appendingPathComponent("index.json")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: indexURL),
           let decoded = try? JSONDecoder().decode([PendingAudio].self, from: data) {
            entries = decoded
        }
        sweep()
    }

    public var count: Int {
        lock.lock(); defer { lock.unlock() }
        return entries.count
    }

    public func list() -> [PendingAudio] {
        lock.lock(); defer { lock.unlock() }
        return entries
    }

    /// Stores the audio and returns the entry (nil if the write fails — never throws into the
    /// recording path; a failed safety-net write must not break the primary flow).
    @discardableResult
    public func add(audio: Data, durationMs: Int, peak: Int, error: String, now: Double = Date().timeIntervalSince1970 * 1000) -> PendingAudio? {
        let fileName = "\(UUID().uuidString).m4a"
        guard (try? audio.write(to: directory.appendingPathComponent(fileName), options: .atomic)) != nil else {
            return nil
        }
        let entry = PendingAudio(at: now, fileName: fileName, durationMs: durationMs, peak: peak, attempts: 1, lastError: error)
        lock.lock()
        entries.append(entry)
        let overflow = entries.count - Self.cap
        if overflow > 0 {
            let evicted = entries.prefix(overflow)
            entries.removeFirst(overflow)
            for old in evicted { removeFile(old.fileName) }
        }
        lock.unlock()
        persist()
        return entry
    }

    public func audio(for entry: PendingAudio) -> Data? {
        try? Data(contentsOf: directory.appendingPathComponent(entry.fileName))
    }

    /// Called when a retry finally succeeds — the recording has served its purpose.
    public func remove(_ entry: PendingAudio) {
        lock.lock()
        entries.removeAll { $0.id == entry.id }
        lock.unlock()
        removeFile(entry.fileName)
        persist()
    }

    public func markAttempt(_ entry: PendingAudio, error: String) {
        lock.lock()
        if let index = entries.firstIndex(where: { $0.id == entry.id }) {
            entries[index].attempts += 1
            entries[index].lastError = error
        }
        lock.unlock()
        persist()
    }

    public func clear() {
        lock.lock()
        let all = entries
        entries = []
        lock.unlock()
        for entry in all { removeFile(entry.fileName) }
        persist()
    }

    /// Drops stale entries and any index row whose audio file vanished (manual cleanup, disk
    /// repair), plus orphan files with no index row — keeps the two views consistent.
    private func sweep(now: Double = Date().timeIntervalSince1970 * 1000) {
        lock.lock()
        let stale = entries.filter { now - $0.at > Self.maxAgeMs }
        entries.removeAll { entry in
            stale.contains { $0.id == entry.id }
                || !FileManager.default.fileExists(atPath: directory.appendingPathComponent(entry.fileName).path)
        }
        let known = Set(entries.map(\.fileName))
        lock.unlock()
        for entry in stale { removeFile(entry.fileName) }
        if let files = try? FileManager.default.contentsOfDirectory(atPath: directory.path) {
            for file in files where file.hasSuffix(".m4a") && !known.contains(file) {
                removeFile(file)
            }
        }
        persist()
    }

    private func removeFile(_ name: String) {
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
    }

    private func persist() {
        lock.lock()
        let snapshot = entries
        lock.unlock()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(snapshot) {
            try? data.write(to: indexURL, options: .atomic)
        }
    }
}
