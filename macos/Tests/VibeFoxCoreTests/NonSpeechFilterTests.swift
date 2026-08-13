import Testing
@testable import VibeFoxCore

// Ported 1:1 from server/src/nonspeech.test.ts — the BYOK path runs the exact same filter
// locally since there's no Worker in the loop to run it for it. Same cases, not invented
// ones, so a pass here carries the same confidence as the server suite already has.

@Test func flagsEmptyAndPunctuationOnly() {
    #expect(NonSpeechFilter.isNonSpeechTranscript(""))
    #expect(NonSpeechFilter.isNonSpeechTranscript("   "))
    #expect(NonSpeechFilter.isNonSpeechTranscript("..."))
    #expect(NonSpeechFilter.isNonSpeechTranscript("。。。…"))
    #expect(NonSpeechFilter.isNonSpeechTranscript("- - -"))
}

@Test func flagsBracketedSceneDescriptions() {
    #expect(NonSpeechFilter.isNonSpeechTranscript("(音频中充斥着强烈的机械噪音)"))
    #expect(NonSpeechFilter.isNonSpeechTranscript("【背景音乐】"))
    #expect(NonSpeechFilter.isNonSpeechTranscript("(inaudible)"))
}

@Test func flagsAudioNarrationPrefixes() {
    #expect(NonSpeechFilter.isNonSpeechTranscript("音频中没有清晰的人声"))
    #expect(NonSpeechFilter.isNonSpeechTranscript("本段音频无法识别"))
}

@Test func flagsShortSubtitleSpamButNotLongRealSentences() {
    #expect(NonSpeechFilter.isNonSpeechTranscript("请点赞订阅"))
    #expect(NonSpeechFilter.isNonSpeechTranscript("Thank you for watching"))
    #expect(NonSpeechFilter.isNonSpeechTranscript("字幕由 Amara.org 社区提供"))
    // Over 30 chars: a real dictation that merely mentions 字幕 must survive.
    #expect(!NonSpeechFilter.isNonSpeechTranscript("我们需要给视频播放器加一个字幕解析模块,要求支持 SRT 和 ASS 两种格式的加载和渲染"))
}

@Test func passesRealDictationIncludingSpokenSymbolWords() {
    #expect(!NonSpeechFilter.isNonSpeechTranscript("帮我修复这个 bug,顺便把等号那一行也检查一下"))
    #expect(!NonSpeechFilter.isNonSpeechTranscript("把 AudioRecorderService 的重试逻辑改成确认式启动"))
}

@Test func flagsFillerOnlyUtterances() {
    #expect(NonSpeechFilter.isNonSpeechTranscript("嗯"))
    #expect(NonSpeechFilter.isNonSpeechTranscript("嗯。"))
    #expect(NonSpeechFilter.isNonSpeechTranscript("嗯嗯,呃。"))
    #expect(NonSpeechFilter.isNonSpeechTranscript("Um, uh..."))
    #expect(NonSpeechFilter.isNonSpeechTranscript("Hmm."))
}

@Test func keepsUtterancesWhereFillersAccompanyRealContent() {
    #expect(!NonSpeechFilter.isNonSpeechTranscript("嗯,好的,开始吧"))
    #expect(!NonSpeechFilter.isNonSpeechTranscript("嗯,continue"))
    #expect(!NonSpeechFilter.isNonSpeechTranscript("好嘛"))
}

// MARK: isContextEcho

private let echoKeywords = ["Cloudflare Workers", "Cloudflare", "Claude Code", "Anthropic", "DashScope"]

@Test func flagsTranscriptThatIsJustTheInjectedVocabularyReadBack() {
    #expect(NonSpeechFilter.isContextEcho("Cloudflare Workers, Claude Code, Anthropic, DashScope", contextWords: echoKeywords))
    // Longest-first consumption: "Cloudflare Workers" must not leave a "Workers" stub that
    // counts as residual real speech.
    #expect(NonSpeechFilter.isContextEcho("Cloudflare Workers Cloudflare Claude Code", contextWords: echoKeywords))
}

@Test func passesRealSpeechThatHappensToContainKeywords() {
    #expect(!NonSpeechFilter.isContextEcho("帮我把 Claude Code 的配置改一下,然后部署到 Cloudflare Workers 上面去", contextWords: echoKeywords))
}

@Test func exemptsShortUtterancesFromEchoCheck() {
    #expect(!NonSpeechFilter.isContextEcho("Claude Code", contextWords: echoKeywords))
    #expect(!NonSpeechFilter.isContextEcho("commit", contextWords: ["commit"]))
}

@Test func neverFlagsWhenNoContextInjected() {
    #expect(!NonSpeechFilter.isContextEcho("Cloudflare Workers Claude Code Anthropic DashScope", contextWords: []))
}
