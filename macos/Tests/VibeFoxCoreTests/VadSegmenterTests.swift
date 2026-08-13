import Foundation
import Testing
@testable import VibeFoxCore

/// Synthetic PCM helpers: chunks of constant amplitude, 100ms each (3200 bytes).
private func chunk(amplitude: Int16, ms: Int = 100) -> Data {
    let samples = ms * 16
    var data = Data(capacity: samples * 2)
    for i in 0..<samples {
        // Alternate sign so averages equal |amplitude| while staying speech-like.
        let value = i % 2 == 0 ? amplitude : -amplitude
        withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
    }
    return data
}

@Test func splitsAfterSilenceGapAndKeepsSampleAlignment() {
    // Fixed threshold 350: speech at 3000, silence at 50.
    let vad = VadSegmenter(silenceMs: 300, minDurationMs: 200, silenceThreshold: 350, adaptive: false)
    var segments: [VadSegmenter.Segment] = []
    for _ in 0..<5 { // 500ms speech
        if let s = vad.consume(chunk(amplitude: 3000)) { segments.append(s) }
    }
    for _ in 0..<4 { // 400ms silence — crosses the 300ms gap
        if let s = vad.consume(chunk(amplitude: 50)) { segments.append(s) }
    }
    #expect(segments.count == 1)
    let segment = segments[0]
    #expect(segment.pcm.count % 2 == 0)
    // Segment ≈ the 500ms of speech (the counted silence is trimmed off the tail).
    #expect(segment.pcm.count >= 500 * 32 - 3200 && segment.pcm.count <= 700 * 32)
    #expect(segment.peak >= 2900)
}

@Test func shortUtterancesWaitForMinDuration() {
    let vad = VadSegmenter(silenceMs: 300, minDurationMs: 3000, silenceThreshold: 350, adaptive: false)
    var emitted = 0
    for _ in 0..<3 {
        if vad.consume(chunk(amplitude: 3000)) != nil { emitted += 1 }
    }
    for _ in 0..<6 {
        if vad.consume(chunk(amplitude: 50)) != nil { emitted += 1 }
    }
    #expect(emitted == 0) // 300ms of speech < 3s minimum — nothing splits.
    #expect(vad.drainTrailing() != nil) // But the audio is all still there for the stop path.
}

@Test func drainTrailingSkipsSubSpeechRemainder() {
    let vad = VadSegmenter(silenceMs: 1200, minDurationMs: 3000, silenceThreshold: 350, adaptive: false)
    _ = vad.consume(chunk(amplitude: 3000, ms: 100))
    #expect(vad.drainTrailing() == nil) // 100ms < 200ms trailing minimum.
    #expect(vad.drainTrailing() == nil) // Buffer was cleared either way.
}

@Test func continuousSpeechSplitsAtTheCeilingWithoutAnySilence() {
    // The "spoke for a minute, nothing appeared" scenario: speech with no gap long enough to
    // trigger the silence split. Without the ceiling the whole take buffers to the end.
    let vad = VadSegmenter(silenceMs: 1200, minDurationMs: 3000, silenceThreshold: 350, adaptive: false)
    var segments: [VadSegmenter.Segment] = []
    for _ in 0..<250 { // 25s of unbroken speech, 100ms per chunk
        if let s = vad.consume(chunk(amplitude: 3000)) { segments.append(s) }
    }
    #expect(segments.count == 1) // Cut once at the 20s ceiling.
    #expect(segments[0].pcm.count == Int(VadSegmenter.maxSegmentMs * 32))
    #expect(segments[0].pcm.count % 2 == 0) // Sample alignment still holds.
    // The remaining ~5s stays buffered for the trailing drain, nothing is lost.
    let trailing = vad.drainTrailing()
    #expect(trailing != nil)
    #expect(trailing!.pcm.count == Int(5000 * 32))
}

@Test func adaptiveThresholdRidesNoiseFloor() {
    // Noisy room: ambient at 600 would sit above the fixed 350 floor forever. The adaptive
    // floor calibrates to ~600, threshold = 600*2.5 = 1500, so 600-level "silence" still
    // counts as silence and the split fires after real speech.
    let vad = VadSegmenter(silenceMs: 300, minDurationMs: 200, silenceThreshold: 350, adaptive: true)
    var segments = 0
    for _ in 0..<5 { // calibration window: ambient noise
        if vad.consume(chunk(amplitude: 600)) != nil { segments += 1 }
    }
    for _ in 0..<5 { // speech
        if vad.consume(chunk(amplitude: 4000)) != nil { segments += 1 }
    }
    for _ in 0..<4 { // back to ambient — must count as silence
        if vad.consume(chunk(amplitude: 600)) != nil { segments += 1 }
    }
    #expect(segments == 1)
}
