import Testing
@testable import VibeFoxCore

// Mirrors client/src/models/TranscriptDedupe.test.ts.

@Test func fullEchoIsDropped() {
    let session = "你现在需要调整几点,第一是布局。"
    #expect(dedupeAgainstSession(session, "你现在需要调整几点,第一是布局。") == "")
}

@Test func longOverlapIsTrimmed() {
    // Overlap "页面的样式统一改好" is 9 chars — at or above the >=8 trim threshold.
    let session = "先把登录页面的样式统一改好"
    let result = dedupeAgainstSession(session, "页面的样式统一改好然后再提交代码")
    #expect(result == "然后再提交代码")
}

@Test func shortRepeatsAreKept() {
    // Overlap under 8 chars: ordinary word repeats, not echoes.
    #expect(dedupeAgainstSession("我们先做这个", "这个方案还需要评审") == "这个方案还需要评审")
}

@Test func freshTextPassesThrough() {
    #expect(dedupeAgainstSession("前一句话", "完全不同的新内容") == "完全不同的新内容")
    #expect(dedupeAgainstSession("", "第一句") == "第一句")
}
