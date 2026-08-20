import Foundation
import Testing
@testable import VibeFoxCore

struct CorrectionDiffTests {
    @Test func cjkReplacementBecomesOnePair() {
        let pairs = CorrectionDiff.learnedPairs(
            original: "把磁库打开看看",
            corrected: "把词库打开看看"
        )
        #expect(pairs == [CorrectionDiff.Pair(from: "磁", to: "词")])
    }

    @Test func multiCharCjkRunGroupsIntoOnePair() {
        let pairs = CorrectionDiff.learnedPairs(
            original: "用西游宝记录旅程",
            corrected: "用汐游宝记录旅程"
        )
        #expect(pairs == [CorrectionDiff.Pair(from: "西", to: "汐")])
    }

    @Test func englishCasingFixIsLearned() {
        let pairs = CorrectionDiff.learnedPairs(
            original: "run the whisper model",
            corrected: "run the Whisper model"
        )
        #expect(pairs == [CorrectionDiff.Pair(from: "whisper", to: "Whisper")])
    }

    @Test func splitIdentifierMergesIntoOnePair() {
        let pairs = CorrectionDiff.learnedPairs(
            original: "call use effect here",
            corrected: "call useEffect here"
        )
        #expect(pairs == [CorrectionDiff.Pair(from: "use effect", to: "useEffect")])
    }

    @Test func insertOnlyAndDeleteOnlyTeachNothing() {
        #expect(CorrectionDiff.learnedPairs(original: "打开词库", corrected: "现在打开词库").isEmpty)
        #expect(CorrectionDiff.learnedPairs(original: "现在打开词库", corrected: "打开词库").isEmpty)
    }

    @Test func identicalTextYieldsNothing() {
        #expect(CorrectionDiff.learnedPairs(original: "一样的", corrected: "一样的").isEmpty)
    }

    @Test func wholesaleRewriteIsRejected() {
        // A >30-char replaced span is a rewrite, not a word fix — nothing to learn.
        let pairs = CorrectionDiff.learnedPairs(
            original: String(repeating: "甲", count: 40),
            corrected: String(repeating: "乙", count: 40)
        )
        #expect(pairs.isEmpty)
    }

    @Test func multipleIndependentFixesStaySeparate() {
        let pairs = CorrectionDiff.learnedPairs(
            original: "磁库和 whisper 都错了",
            corrected: "词库和 Whisper 都错了"
        )
        #expect(pairs.count == 2)
        #expect(pairs.contains(CorrectionDiff.Pair(from: "磁", to: "词")))
        #expect(pairs.contains(CorrectionDiff.Pair(from: "whisper", to: "Whisper")))
    }
}
