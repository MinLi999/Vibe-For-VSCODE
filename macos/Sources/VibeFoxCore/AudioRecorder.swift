import AVFoundation
import Foundation

/// Native microphone capture — replaces the Electron build's ffmpeg dependency entirely
/// (no install burden, no orphan processes, no device-release races).
///
/// Output: 16kHz mono PCM16 (the pipeline's canonical format, same as the ffmpeg capture),
/// accumulated in memory for the batch path. VAD segmentation is ported separately.
/// @unchecked Sendable: pcm/peak are NSLock-protected; inputLevel is a monotonically
/// overwritten display value read from UI timers (last-writer-wins is acceptable).
public final class AudioRecorder: @unchecked Sendable {
    public enum RecorderError: Error, LocalizedError {
        case microphoneDenied
        case engineStartFailed(String)

        public var errorDescription: String? {
            switch self {
            case .microphoneDenied:
                return "未获得麦克风权限:系统设置 → 隐私与安全性 → 麦克风 → 勾选 VibeFox。"
            case .engineStartFailed(let reason):
                return "录音引擎启动失败:\(reason)"
            }
        }
    }

    public static let sampleRate: Double = 16000

    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private var pcm = Data()
    private var running = false
    private var peak: Int16 = 0
    /// Serializes onPcmChunk delivery so downstream consumers (VAD segmentation, streaming
    /// upload) see chunks in capture order without their own locking.
    private let chunkQueue = DispatchQueue(label: "vibefox.audio.chunks")
    /// Live 16kHz mono PCM16 chunks as they are captured (called on an internal serial queue).
    public var onPcmChunk: (@Sendable (Data) -> Void)?

    /// Smoothed input level in 0...1 for UI meters (updated from the audio thread).
    public private(set) var inputLevel: Float = 0
    /// Peak |sample| observed this session (diagnostic capturePeak field in protocol v2).
    public var peakAmplitude: Int {
        lock.lock(); defer { lock.unlock() }
        return Int(peak)
    }

    public init() {}

    public static func requestMicrophoneAccess() async -> Bool {
        await AVCaptureDevice.requestAccess(for: .audio)
    }

    public func start() throws {
        guard !running else { return }
        lock.lock()
        pcm = Data()
        peak = 0
        lock.unlock()

        let input = engine.inputNode
        let hardwareFormat = input.outputFormat(forBus: 0)
        guard hardwareFormat.sampleRate > 0, hardwareFormat.channelCount > 0 else {
            throw RecorderError.engineStartFailed("no input device")
        }
        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16, sampleRate: Self.sampleRate, channels: 1, interleaved: true
        ), let converter = AVAudioConverter(from: hardwareFormat, to: targetFormat) else {
            throw RecorderError.engineStartFailed("unsupported input format \(hardwareFormat)")
        }

        input.installTap(onBus: 0, bufferSize: 4096, format: hardwareFormat) { [weak self] buffer, _ in
            self?.consume(buffer, converter: converter, targetFormat: targetFormat)
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw RecorderError.engineStartFailed(error.localizedDescription)
        }
        running = true
    }

    /// Stops capture and returns the session's 16kHz mono PCM16 bytes.
    public func stop() -> Data {
        teardown()
        drainPendingChunks()
        lock.lock(); defer { lock.unlock() }
        let out = pcm
        pcm = Data()
        return out
    }

    /// Blocks until every already-captured chunk has been delivered to onPcmChunk. Call after
    /// stop() before touching single-queue consumers (e.g. VadSegmenter.drainTrailing).
    public func drainPendingChunks() {
        chunkQueue.sync {}
    }

    public func cancel() {
        teardown()
        lock.lock()
        pcm = Data()
        lock.unlock()
    }

    private func teardown() {
        guard running else { return }
        running = false
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        inputLevel = 0
    }

    private func consume(_ buffer: AVAudioPCMBuffer, converter: AVAudioConverter, targetFormat: AVAudioFormat) {
        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 32)
        guard let converted = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }
        var fed = false
        var conversionError: NSError?
        converter.convert(to: converted, error: &conversionError) { _, outStatus in
            if fed {
                outStatus.pointee = .noDataNow
                return nil
            }
            fed = true
            outStatus.pointee = .haveData
            return buffer
        }
        guard conversionError == nil, converted.frameLength > 0, let channel = converted.int16ChannelData else { return }

        let frames = Int(converted.frameLength)
        var localPeak: Int16 = 0
        var sum: Int64 = 0
        let samples = channel[0]
        for i in 0..<frames {
            let magnitude = samples[i] == Int16.min ? Int16.max : abs(samples[i])
            localPeak = max(localPeak, magnitude)
            sum += Int64(magnitude)
        }
        let average = frames > 0 ? Float(sum) / Float(frames) : 0
        let chunkData = UnsafeBufferPointer(start: samples, count: frames).withMemoryRebound(to: UInt8.self) { Data(buffer: $0) }

        lock.lock()
        pcm.append(chunkData)
        peak = max(peak, localPeak)
        lock.unlock()

        if let onPcmChunk {
            chunkQueue.async { onPcmChunk(chunkData) }
        }

        // Same display mapping idea as the Electron meter: noise-gated, roughly 0..1 by ~2500 avg.
        inputLevel = min(1, average / 2500)
    }
}
