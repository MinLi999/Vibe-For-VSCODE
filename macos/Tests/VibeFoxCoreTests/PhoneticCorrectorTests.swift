import Foundation
import Testing
@testable import VibeFoxCore

/// L2 homophone correction. All expectations are tone-strict by design: "true homophone"
/// is exactly what the corrector is allowed to fix, and nothing else.
struct PhoneticCorrectorTests {
    private func map(_ words: [String]) -> PhoneticCorrector.Map {
        PhoneticCorrector.Map(entries: words.map { DictionaryEntry(word: $0) })
    }

    @Test func exactHomophoneIsCorrected() {
        // 磁(cí) and 词(cí) are true homophones; 库 matches itself.
        let m = map(["词库"])
        #expect(PhoneticCorrector.correct("把磁库打开看看", map: m) == "把词库打开看看")
    }

    @Test func toneMismatchIsLeftAlone() {
        // 食品(shí pǐn) vs 视频(shì pín): near miss, not a homophone — must not be touched.
        let m = map(["视频"])
        #expect(PhoneticCorrector.correct("这个食品不错", map: m) == "这个食品不错")
    }

    @Test func alreadyCorrectTextAndEnglishPassThrough() {
        let m = map(["词库"])
        #expect(PhoneticCorrector.correct("词库里有 useEffect 这个词", map: m) == "词库里有 useEffect 这个词")
        #expect(PhoneticCorrector.correct("pure English stays put", map: m) == "pure English stays put")
    }

    @Test func dictionaryWordSpanIsNeverRewrittenIntoAnotherEntry() {
        // Both entries share a pronunciation (quán lì) — the key becomes ambiguous and is
        // dropped, so neither direction ever rewrites the other.
        let m = map(["权利", "权力"])
        #expect(PhoneticCorrector.correct("保护你的权利", map: m) == "保护你的权利")
        #expect(PhoneticCorrector.correct("滥用权力不可取", map: m) == "滥用权力不可取")
    }

    @Test func correctionWorksAcrossPunctuationBoundaries() {
        let m = map(["词库"])
        // The run is split by punctuation; each CJK run is scanned independently.
        #expect(PhoneticCorrector.correct("打开磁库,再看磁库。", map: m) == "打开词库,再看词库。")
    }

    @Test func singleCharAndOverlongWordsAreExcluded() {
        // 1-char words are false-positive city; >6 chars are phrases, not vocabulary.
        let m = map(["词", "这是一个超长的词条啊"])
        #expect(m.isEmpty)
    }

    @Test func emptyMapShortCircuits() {
        let m = map([])
        #expect(PhoneticCorrector.correct("磁库", map: m) == "磁库")
    }
}
