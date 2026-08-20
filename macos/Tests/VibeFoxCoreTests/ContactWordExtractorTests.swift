import Foundation
import Testing
@testable import VibeFoxCore

struct ContactWordExtractorTests {
    private typealias C = ContactWordExtractor.Candidate

    @Test func chineseNameJoinsFamilyFirstNoSpace() {
        let words = ContactWordExtractor.words(from: [C(given: "伟", family: "张")])
        #expect(words == ["张伟"])
    }

    @Test func westernNameJoinsGivenFirstWithSpace() {
        let words = ContactWordExtractor.words(from: [C(given: "Ada", family: "Lovelace")])
        #expect(words == ["Ada Lovelace"])
    }

    @Test func nicknameAndOrganizationAreTheirOwnWords() {
        let words = ContactWordExtractor.words(from: [
            C(given: "伟", family: "张", nickname: "老张", organization: "字节跳动"),
        ])
        #expect(words == ["张伟", "老张", "字节跳动"])
    }

    @Test func singleCharAndEmptyFieldsAreDropped() {
        // A lone one-char given name and blank fields contribute nothing.
        let words = ContactWordExtractor.words(from: [
            C(given: "伟", family: ""), C(given: "", family: ""), C(given: nil, family: nil),
        ])
        #expect(words.isEmpty)
    }

    @Test func duplicatesAcrossContactsCollapseCaseInsensitively() {
        let words = ContactWordExtractor.words(from: [
            C(given: "Ada", family: "Lovelace", organization: "Anthropic"),
            C(given: "ada", family: "lovelace", organization: "anthropic"),
        ])
        #expect(words == ["Ada Lovelace", "Anthropic"])
    }

    @Test func mixedScriptNameFallsBackToSpacedOrder() {
        // One CJK side + one Latin side: not the Chinese convention — keep "given family".
        let words = ContactWordExtractor.words(from: [C(given: "Kevin", family: "张")])
        #expect(words == ["Kevin 张"])
    }
}
