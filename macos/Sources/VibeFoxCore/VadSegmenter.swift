import Foundation

/// Swift port of the VAD segmentation inside client/src/services/AudioRecorderService.ts:
/// silence-gap splitting over a 16kHz mono PCM16 stream with a noise-floor-adaptive
/// threshold. Pure logic — the caller feeds chunks from the capture thread and receives
/// finished segments to transcribe while the user keeps talking.
///
/// Invariants ported verbatim from the TS original:
///  - Split offsets ALWAYS land on the 2-byte sample grid (an odd-offset slice byte-swaps
///    every subsequent sample — the 2026-07-12 "metallic grinding noise" incident).
///  - Adaptive threshold: noise floor seeds from the first 500ms minimum, then tracks
///    fast-down / slow-up (floor = min(chunkAvg, floor*1.02));
///    effective = clamp(floor*2.5, configured floor, 2000).
///  - A segment only splits off once it is at least minDurationMs long.
/// @unchecked Sendable: NOT internally synchronized — the caller must confine consume() to
/// one serial queue (the recorder's chunk queue) and only call drainTrailing() after capture
/// has stopped and pending chunks are flushed.
public final class VadSegmenter: @unchecked Sendable {
    public struct Segment {
        public let pcm: Data
        /// Loudest chunk average WITHIN this segment (not the session) — distinguishes a
        /// real-speech segment from a silence-gap segment.
        public let peak: Double
    }

    static let bytesPerMs: Double = 32 // 16000 samples/s * 2 bytes / 1000
    static let adaptiveThresholdMax: Double = 2000
    static let noiseFloorFactor: Double = 2.5
    static let calibrationWindowMs: Double = 500
    /// Trailing audio shorter than this at stop time cannot contain speech.
    public static let minTrailingMs: Double = 200
    /// Hard segment ceiling — split even with no silence gap in sight. Without this, someone
    /// speaking continuously (pauses under silenceMs) buffers the WHOLE take until they stop:
    /// no text appears for a minute, and the resulting giant single request is exactly what
    /// used to blow the ASR timeout and vanish into a silent 502. 20s keeps every segment
    /// comfortably inside the engines' fast path and gives steady feedback while talking.
    public static let maxSegmentMs: Double = 20_000

    private let silenceMs: Double
    private let minDurationMs: Double
    private let thresholdFloor: Double
    private let adaptive: Bool

    private var buffer = Data()
    private var silentTimeMs: Double = 0
    private var noiseFloor: Double?
    private var observedMs: Double = 0
    private var segmentPeak: Double = 0

    public init(silenceMs: Double, minDurationMs: Double, silenceThreshold: Double, adaptive: Bool) {
        self.silenceMs = max(1, silenceMs)
        self.minDurationMs = max(0, minDurationMs)
        self.thresholdFloor = silenceThreshold
        self.adaptive = adaptive
    }

    /// Feeds one capture chunk; returns a finished segment when a long-enough silence gap
    /// closes a long-enough utterance.
    public func consume(_ chunk: Data) -> Segment? {
        buffer.append(chunk)
        let sampleCount = chunk.count / 2
        guard sampleCount > 0 else { return nil }

        var sum: Double = 0
        chunk.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let samples = raw.bindMemory(to: Int16.self)
            for i in 0..<sampleCount {
                sum += Double(samples[i] == Int16.min ? Int16.max : abs(samples[i]))
            }
        }
        let average = sum / Double(sampleCount)
        let durationMs = Double(chunk.count) / Self.bytesPerMs
        segmentPeak = max(segmentPeak, average)

        let threshold = updateAdaptiveThreshold(average: average, durationMs: durationMs)
        if average < threshold {
            silentTimeMs += durationMs
        } else {
            silentTimeMs = 0
        }

        // Continuous-speech escape hatch: cut at the ceiling even mid-sentence. A slightly
        // awkward split beats a minute of silence followed by one oversized request.
        if Double(buffer.count) >= Self.maxSegmentMs * Self.bytesPerMs {
            let cut = Int(Self.maxSegmentMs * Self.bytesPerMs) / 2 * 2
            let segmentPcm = buffer.prefix(cut)
            buffer = Data(buffer.suffix(from: cut))
            silentTimeMs = 0
            let peak = segmentPeak
            segmentPeak = 0
            return Segment(pcm: Data(segmentPcm), peak: peak)
        }

        guard silentTimeMs >= silenceMs else { return nil }

        // Sample-grid-aligned split (see header comment).
        let silenceBytes = min(buffer.count, Int(silentTimeMs * Self.bytesPerMs / 2) * 2)
        let segmentLength = max(0, (buffer.count - silenceBytes) / 2 * 2)
        guard Double(segmentLength) >= minDurationMs * Self.bytesPerMs else { return nil }

        let segmentPcm = buffer.prefix(segmentLength)
        buffer = Data(buffer.suffix(from: segmentLength))
        silentTimeMs = 0
        let peak = segmentPeak
        segmentPeak = 0
        return Segment(pcm: Data(segmentPcm), peak: peak)
    }

    /// Remaining buffered audio at stop time (always sample-aligned). Callers skip it when
    /// shorter than minTrailingMs; amplitude is deliberately NOT checked — quiet tail words
    /// are the ASR's call (the filler-only server filter handles breath-noise hallucinations).
    public func drainTrailing() -> Segment? {
        let aligned = buffer.count / 2 * 2
        guard Double(aligned) >= Self.minTrailingMs * Self.bytesPerMs else {
            buffer = Data()
            return nil
        }
        let segment = Segment(pcm: Data(buffer.prefix(aligned)), peak: segmentPeak)
        buffer = Data()
        segmentPeak = 0
        return segment
    }

    private func updateAdaptiveThreshold(average: Double, durationMs: Double) -> Double {
        guard adaptive else { return thresholdFloor }
        observedMs += durationMs
        if noiseFloor == nil || observedMs <= Self.calibrationWindowMs {
            noiseFloor = noiseFloor.map { min($0, average) } ?? average
        } else {
            noiseFloor = min(average, noiseFloor! * 1.02)
        }
        return min(max(noiseFloor! * Self.noiseFloorFactor, thresholdFloor), Self.adaptiveThresholdMax)
    }
}
