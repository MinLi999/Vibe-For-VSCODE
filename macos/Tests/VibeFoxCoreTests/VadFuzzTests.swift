import Foundation
import Testing
@testable import VibeFoxCore

/// Deterministic LCG so the fuzz run is reproducible (no wall-clock randomness in tests).
private struct Lcg {
    var state: UInt64
    mutating func next(_ bound: Int) -> Int {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return Int(state >> 33) % bound
    }
}

@Test func vadFuzzKeepsSampleAlignmentAndConservesBytes() {
    var rng = Lcg(state: 20260812)
    let vad = VadSegmenter(silenceMs: 400, minDurationMs: 500, silenceThreshold: 350, adaptive: true)
    var totalFed = 0
    var segmentBytes = 0
    var segments = 0

    // 200 chunks of random duration (20–200ms) alternating speech/silence phases of random length.
    var speech = true
    var phaseLeft = 5
    for _ in 0..<200 {
        if phaseLeft == 0 {
            speech.toggle()
            phaseLeft = 2 + rng.next(8)
        }
        phaseLeft -= 1
        let ms = 20 + rng.next(180)
        let samples = ms * 16
        let amplitude = Int16(speech ? 2500 + rng.next(2000) : rng.next(120))
        var chunk = Data(capacity: samples * 2)
        for i in 0..<samples {
            let v = i % 2 == 0 ? amplitude : -amplitude
            withUnsafeBytes(of: v.littleEndian) { chunk.append(contentsOf: $0) }
        }
        totalFed += chunk.count
        if let segment = vad.consume(chunk) {
            segments += 1
            #expect(segment.pcm.count % 2 == 0) // The 2026-07-12 metallic-noise red line.
            #expect(segment.pcm.count >= 500 * 32) // Never shorter than minDurationMs.
            segmentBytes += segment.pcm.count
        }
    }
    if let trailing = vad.drainTrailing() {
        #expect(trailing.pcm.count % 2 == 0)
        segmentBytes += trailing.pcm.count
    }
    #expect(segments > 0) // The pattern must actually exercise splitting.
    // No byte invented or lost: segments + trailing == everything fed (inputs are even-sized).
    #expect(segmentBytes == totalFed)
}
