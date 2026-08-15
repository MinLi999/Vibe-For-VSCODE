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

    /// Rebuilt (not merely restarted) whenever macOS reconfigures the audio hardware under us.
    ///
    /// This is the fix for "left the app alone for a while, pressed record, nothing happened,
    /// had to quit and relaunch": when the system suspends or reconfigures the audio stack
    /// (idle power management, sleep/wake, default-device switch, another process grabbing the
    /// device), AVAudioEngine stops itself, kills installed taps, and its inputNode starts
    /// reporting a 0 Hz format. Every later start() on that same instance fails forever, so
    /// relaunching the app — which built a fresh instance — was the only way back. Hence `var`.
    private var engine = AVAudioEngine()
    private var configObserver: NSObjectProtocol?
    /// Set by the configuration-change observer (any thread); lock-protected like pcm/peak.
    private var configurationStale = false
    private let lock = NSLock()
    private var pcm = Data()
    private var running = false
    private var peak: Int16 = 0

    /// Reports that start() had to rebuild the engine to recover, with the reason. Diagnostics
    /// only — the recording itself proceeds normally.
    public var onRecovery: (@Sendable (String) -> Void)?
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

    public init() {
        observeConfigurationChanges()
    }

    deinit {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
    }

    public static func requestMicrophoneAccess() async -> Bool {
        await AVCaptureDevice.requestAccess(for: .audio)
    }

    /// AVAudioEngine posts this when the hardware configuration changes underneath it. The
    /// engine has already stopped itself and its taps are dead by the time we hear about it,
    /// so the only safe response is to rebuild the instance before the next start().
    private func observeConfigurationChanges() {
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self] _ in
            guard let self else { return }
            self.lock.lock()
            self.configurationStale = true
            self.lock.unlock()
        }
    }

    /// Discards the current engine (and its observer) for a fresh one. Cheap: AVAudioEngine
    /// allocation is trivial next to the failure mode it heals.
    private func rebuildEngine() {
        if let configObserver {
            NotificationCenter.default.removeObserver(configObserver)
            self.configObserver = nil
        }
        engine.stop()
        engine = AVAudioEngine()
        observeConfigurationChanges()
        lock.lock()
        configurationStale = false
        lock.unlock()
    }

    /// Marks the engine as needing a rebuild before the next start(). Called on system wake,
    /// where the audio stack is routinely torn down without a configuration-change notification
    /// ever reaching a backgrounded app.
    public func invalidateEngine() {
        lock.lock()
        configurationStale = true
        lock.unlock()
    }

    public func start() throws {
        guard !running else { return }
        lock.lock()
        pcm = Data()
        peak = 0
        let stale = configurationStale
        lock.unlock()

        var recovery: String?
        if stale {
            // A configuration change already told us this instance is dead — don't bother
            // trying it, the attempt would just fail with a 0 Hz input format.
            rebuildEngine()
            recovery = "config_change"
        }

        do {
            try attemptStart()
        } catch {
            // Self-heal: a suspended or reconfigured audio stack leaves the engine permanently
            // unusable, and only a fresh instance recovers. Without this retry the failure
            // survives until the user quits and relaunches the app.
            rebuildEngine()
            recovery = recovery ?? "start_failed"
            try attemptStart() // Still failing on a brand-new engine = a real, reportable error.
        }
        running = true
        if let recovery { onRecovery?(recovery) }
    }

    private func attemptStart() throws {
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

        // Defensive: installing a second tap on a bus that already has one traps. A tap can
        // survive a failed start, so clear before installing rather than trusting bookkeeping.
        input.removeTap(onBus: 0)
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
