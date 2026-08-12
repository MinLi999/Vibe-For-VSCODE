import AVFoundation
import Foundation

/// Encodes the recorder's 16kHz mono PCM16 into an AAC .m4a container for upload
/// (protocol v2 `audioFormat: "m4a"`). macOS has no MP3 encoder API; AAC at 64kbps
/// matches the old MP3 payload size closely.
public enum AacEncoder {
    public enum EncodeError: Error {
        case emptyInput
        case fileWriteFailed
    }

    public static func encodeToM4A(pcm16: Data) throws -> Data {
        guard !pcm16.isEmpty else { throw EncodeError.emptyInput }

        guard let pcmFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16, sampleRate: AudioRecorder.sampleRate, channels: 1, interleaved: true
        ) else {
            throw EncodeError.fileWriteFailed
        }

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("vibefox-\(UUID().uuidString).m4a")
        defer { try? FileManager.default.removeItem(at: url) }

        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: AudioRecorder.sampleRate,
            AVNumberOfChannelsKey: 1,
            // 64k is out of range for 16kHz mono AAC (encoder rejects it); 32k AAC-LC is
            // transparent for speech and roughly matches the old MP3 payload size anyway.
            AVEncoderBitRateKey: 32000,
        ]

        // Scope the AVAudioFile so it finalizes (writes the moov atom) before we read back.
        do {
            let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatInt16, interleaved: true)
            let frameCount = AVAudioFrameCount(pcm16.count / 2)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: frameCount) else {
                throw EncodeError.fileWriteFailed
            }
            buffer.frameLength = frameCount
            pcm16.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                if let src = raw.baseAddress, let dst = buffer.int16ChannelData?[0] {
                    memcpy(dst, src, pcm16.count)
                }
            }
            try file.write(from: buffer)
        }

        return try Data(contentsOf: url)
    }
}
