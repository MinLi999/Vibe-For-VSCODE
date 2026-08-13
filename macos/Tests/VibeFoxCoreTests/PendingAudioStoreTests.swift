import Foundation
import Testing
@testable import VibeFoxCore

private func tempUserDataDir() -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("vibefox-pending-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

@Test func storesAudioAndSurvivesRelaunch() {
    let dir = tempUserDataDir()
    defer { try? FileManager.default.removeItem(at: dir) }
    let store = PendingAudioStore(userDataDir: dir)
    let audio = Data(repeating: 0xAB, count: 4096)
    let entry = store.add(audio: audio, durationMs: 5000, peak: 3200, error: "timeout")
    #expect(entry != nil)
    #expect(store.count == 1)

    let reloaded = PendingAudioStore(userDataDir: dir)
    #expect(reloaded.count == 1)
    let restored = try? #require(reloaded.list().first)
    #expect(restored?.peak == 3200)
    #expect(restored?.lastError == "timeout")
    #expect(reloaded.audio(for: restored!) == audio) // The recording itself round-trips intact.
}

@Test func removeDeletesBothIndexRowAndFile() {
    let dir = tempUserDataDir()
    defer { try? FileManager.default.removeItem(at: dir) }
    let store = PendingAudioStore(userDataDir: dir)
    let entry = store.add(audio: Data(repeating: 1, count: 64), durationMs: 1000, peak: 900, error: "no_speech")!
    store.remove(entry)
    #expect(store.count == 0)
    #expect(store.audio(for: entry) == nil)
    // A fresh store must not resurrect it.
    #expect(PendingAudioStore(userDataDir: dir).count == 0)
}

@Test func markAttemptIncrementsAndRecordsLatestReason() {
    let dir = tempUserDataDir()
    defer { try? FileManager.default.removeItem(at: dir) }
    let store = PendingAudioStore(userDataDir: dir)
    let entry = store.add(audio: Data(repeating: 2, count: 64), durationMs: 2000, peak: 1500, error: "timeout")!
    store.markAttempt(entry, error: "server_500")
    let updated = store.list().first
    #expect(updated?.attempts == 2)
    #expect(updated?.lastError == "server_500")
}

@Test func capEvictsOldestEntriesAndTheirFiles() {
    let dir = tempUserDataDir()
    defer { try? FileManager.default.removeItem(at: dir) }
    let store = PendingAudioStore(userDataDir: dir)
    var first: PendingAudio?
    for i in 0..<(PendingAudioStore.cap + 3) {
        let entry = store.add(audio: Data(repeating: UInt8(i % 256), count: 32), durationMs: 1000, peak: 1200, error: "timeout")
        if i == 0 { first = entry }
    }
    #expect(store.count == PendingAudioStore.cap)
    #expect(store.audio(for: first!) == nil) // Evicted entry's file is gone, not orphaned.
    let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("pending-audio").path)) ?? []
    #expect(files.filter { $0.hasSuffix(".m4a") }.count == PendingAudioStore.cap)
}

@Test func sweepDropsStaleEntriesOnLoad() {
    let dir = tempUserDataDir()
    defer { try? FileManager.default.removeItem(at: dir) }
    let store = PendingAudioStore(userDataDir: dir)
    let eightDaysAgo = Date().timeIntervalSince1970 * 1000 - 8 * 24 * 60 * 60 * 1000
    store.add(audio: Data(repeating: 3, count: 64), durationMs: 1000, peak: 1200, error: "timeout", now: eightDaysAgo)
    store.add(audio: Data(repeating: 4, count: 64), durationMs: 1000, peak: 1200, error: "timeout")
    #expect(store.count == 2)
    // A week-old failed take isn't worth keeping; the fresh one is.
    #expect(PendingAudioStore(userDataDir: dir).count == 1)
}

@Test func clearRemovesEverything() {
    let dir = tempUserDataDir()
    defer { try? FileManager.default.removeItem(at: dir) }
    let store = PendingAudioStore(userDataDir: dir)
    store.add(audio: Data(repeating: 5, count: 64), durationMs: 1000, peak: 1200, error: "timeout")
    store.add(audio: Data(repeating: 6, count: 64), durationMs: 1000, peak: 1200, error: "timeout")
    store.clear()
    #expect(store.count == 0)
    let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("pending-audio").path)) ?? []
    #expect(files.filter { $0.hasSuffix(".m4a") }.isEmpty)
}
