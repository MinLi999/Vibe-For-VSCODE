import Foundation
import Testing
@testable import VibeFoxCore

private func tempLogURL() -> URL {
    FileManager.default.temporaryDirectory
        .appendingPathComponent("vibefox-diag-\(UUID().uuidString)", isDirectory: true)
        .appendingPathComponent("diagnostics.log")
}

@Test func ringBufferCapsAtThreeHundred() {
    let log = DiagnosticsLog(fileURL: nil)
    for i in 0..<350 {
        log.log("event", "n=\(i)")
    }
    let recent = log.recent(400)
    #expect(recent.count == DiagnosticsLog.cap)
    #expect(recent.last?.detail == "n=349")
    #expect(recent.first?.detail == "n=50") // Oldest 50 evicted.
}

@Test func persistsAcrossRelaunch() async throws {
    let url = tempLogURL()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let first = DiagnosticsLog(fileURL: url)
    first.log("session_start", "provider=cloudflare")
    first.log("no_speech", "peak=3200 bytes=64000")
    // Appends are async on a utility queue; give them a beat to land.
    try await Task.sleep(nanoseconds: 300_000_000)

    let second = DiagnosticsLog(fileURL: url)
    let recent = second.recent()
    #expect(recent.count == 2)
    #expect(recent.first?.kind == "session_start")
    #expect(recent.last?.detail == "peak=3200 bytes=64000")
}

@Test func exportTextIsHumanReadableAndOrdered() {
    let log = DiagnosticsLog(fileURL: nil)
    log.log("segment_queued", "bytes=32000 ms=1000 peak=2500")
    log.log("delivered", "chars=42 paste=auto")
    let text = log.exportText()
    let lines = text.split(separator: "\n")
    #expect(lines.count == 2)
    #expect(lines[0].contains("segment_queued"))
    #expect(lines[1].contains("delivered chars=42"))
    #expect(lines[0].contains("-")) // Timestamp prefix present (yyyy-MM-dd ...).
}

@Test func clearEmptiesBufferAndFile() async throws {
    let url = tempLogURL()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let log = DiagnosticsLog(fileURL: url)
    log.log("event", "x")
    log.clear()
    #expect(log.recent().isEmpty)
    try await Task.sleep(nanoseconds: 300_000_000)
    let reloaded = DiagnosticsLog(fileURL: url)
    #expect(reloaded.recent().isEmpty)
}

@Test func corruptedLogFileLoadsAsEmpty() throws {
    let url = tempLogURL()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try "not json at all\n{broken".write(to: url, atomically: true, encoding: .utf8)
    let log = DiagnosticsLog(fileURL: url)
    #expect(log.recent().isEmpty)
}
