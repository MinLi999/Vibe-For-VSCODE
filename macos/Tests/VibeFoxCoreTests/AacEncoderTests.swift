import Foundation
import Testing
@testable import VibeFoxCore

@Test func encodesSinePcmToNonTrivialM4a() throws {
    // 1s of 440Hz sine at 16kHz mono PCM16.
    var pcm = Data(capacity: 16000 * 2)
    for i in 0..<16000 {
        let sample = Int16(12000 * sin(2 * Double.pi * 440 * Double(i) / 16000))
        withUnsafeBytes(of: sample.littleEndian) { pcm.append(contentsOf: $0) }
    }
    let m4a = try AacEncoder.encodeToM4A(pcm16: pcm)
    #expect(m4a.count > 2000) // Real AAC payload, not just an empty container.
    #expect(m4a.count < pcm.count) // Compressed.
    // MP4 container magic: "ftyp" at offset 4.
    #expect(m4a.count > 8 && m4a[4...7].elementsEqual("ftyp".utf8))
}

@Test func rejectsEmptyInput() {
    #expect(throws: AacEncoder.EncodeError.self) {
        _ = try AacEncoder.encodeToM4A(pcm16: Data())
    }
}
