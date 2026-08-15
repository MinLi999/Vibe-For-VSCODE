import Testing
import Foundation
@testable import VibeFoxCore

/// Recorder lifecycle robustness. These deliberately assert behaviour that holds BOTH on a Mac
/// with a real microphone and on a CI runner with no audio input device at all — the failure
/// they guard against ("pressed record, nothing happened, had to relaunch") is precisely a
/// recorder that gets stuck in an unusable state, so "stays reusable after failure" is the
/// property worth pinning, not "recording succeeds".
struct AudioRecorderTests {
    /// The regression: a stale engine used to poison every later start() until app restart.
    /// After invalidateEngine() the next start() must either succeed on a rebuilt engine
    /// (reporting the recovery) or fail cleanly — never trap, hang, or silently no-op.
    @Test func invalidatedEngineRecoversOrFailsCleanly() {
        let recorder = AudioRecorder()
        let recoveries = Locked<[String]>([])
        recorder.onRecovery = { reason in recoveries.withLock { $0.append(reason) } }

        recorder.invalidateEngine()
        do {
            try recorder.start()
            #expect(recoveries.value == ["config_change"], "a rebuild must be reported for diagnostics")
            _ = recorder.stop()
        } catch let error as AudioRecorder.RecorderError {
            // No input device (CI): the retry path ran and surfaced a real, describable error.
            guard case .engineStartFailed = error else {
                Issue.record("unexpected recorder error: \(error)")
                return
            }
            #expect(error.errorDescription?.isEmpty == false)
        } catch {
            Issue.record("unexpected error type: \(error)")
        }
    }

    /// Repeated failed starts must not trap. installTap on a bus that already holds a tap is a
    /// hard crash in AVAudioEngine, and a tap can outlive a failed start — hence the defensive
    /// removeTap before every install.
    @Test func repeatedStartAttemptsDoNotTrap() {
        let recorder = AudioRecorder()
        for _ in 0..<3 {
            try? recorder.start()
            recorder.cancel()
        }
        #expect(recorder.peakAmplitude == 0, "cancel must clear captured audio")
    }

    /// start() is idempotent while running: a second call must not install a duplicate tap.
    @Test func doubleStartIsIdempotent() {
        let recorder = AudioRecorder()
        guard (try? recorder.start()) != nil else { return } // No device: nothing to assert.
        try? recorder.start()
        _ = recorder.stop()
    }

    /// stop() after a failed start must return empty data rather than stale bytes.
    @Test func stopAfterFailedStartReturnsEmpty() {
        let recorder = AudioRecorder()
        recorder.invalidateEngine()
        try? recorder.start()
        let data = recorder.stop()
        if data.isEmpty { return } // Expected when the engine never started.
        // With a live mic an immediate stop may still capture a frame or two; only assert
        // that whatever came back is coherent PCM16 (even byte count).
        #expect(data.count % 2 == 0)
    }
}

/// Minimal lock box so the @Sendable recovery callback can record into test state.
private final class Locked<T>: @unchecked Sendable {
    private var storage: T
    private let lock = NSLock()

    init(_ value: T) { storage = value }

    var value: T {
        lock.lock(); defer { lock.unlock() }
        return storage
    }

    func withLock(_ body: (inout T) -> Void) {
        lock.lock(); defer { lock.unlock() }
        body(&storage)
    }
}
