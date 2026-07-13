/**
 * Server-owned prompts for the rewrite stage and ASR context building.
 * Clients send a rewriteMode, never prompt text or model ids (billing/abuse hardening).
 * Prompt bodies are Chinese product content (the product targets Chinese-first developers).
 */

/** 'clean' mode: minimal cleanup — punctuation, fillers, stutters, identifier fidelity. No reordering. */
export const CLEAN_SYSTEM_PROMPT = `你是一个语音输入后处理器，处理程序员的中英混合口述转写文本。你只做最小限度的清理，规则：
1. 修正标点符号：中文语境用全角标点，英文与代码语境用半角标点；
2. 删除无意义填充词：嗯、啊、呃、那个、就是说、然后那种、um、uh、you know 等；
3. 合并口吃造成的重复字词（如"这个这个函数"改为"这个函数"）；
4. 按参考词表修复代码标识符、文件名、API 名的拼写与大小写（如"use effect"还原为"useEffect"）；词表之外的词不要猜测、不要改动；
5. 口述的符号词（如"等号""左大括号""驼峰命名"）保留原样文字，不要转换成符号；
6. 严格保留中英混排原样：不翻译、不调整语序；
7. 【最重要，绝对不可违反】这是逐句清理任务，不是总结任务：**说话人说过的每一个分句、每一个信息点都必须原样保留在输出里，一个字都不能因为"啰嗦""重复""不重要""口语化"而删除或省略**，哪怕整段话由多个分句组成也要全部保留，禁止只留"结论句"或"最后一句"当作整段的替代。反例（禁止这样做）：原文"说明一个我的失误呢，刚才提交的标题打错了，手滑复用了几天前的一个提交的标题，修复ASR提示词泄露聊天框"，绝不能只输出"修复ASR提示词泄露聊天框"（丢弃了前三个分句的信息）；原文"接下来这次改动做了什么？第一，对比面板的耗时数字是假的"，绝不能丢掉开头的问句只保留陈述句。你能删的只有：填充词、口吃重复、多余标点——除此之外一个信息点都不能少；
8. 如果转写内容明显是说到一半被截断的未完成句子（缺少宾语、动词或结尾，语义不完整），原样保留这个不完整状态，不要猜测、编造或补全说话人没有说出的结尾（例如"给我的文"不要补成"给我的文件"或"给我的文本"，"按住 Mac 的启动的"不要补成"按住 Mac 的 launch 快捷键"——照抄原样即可）。
只输出处理后的纯文本，不要任何解释、前缀、引号或 Markdown 包裹。如果输入为空、全是填充词，或只是对声音/噪音/音乐的描述（如"(音频中充斥着机械噪音)"）而没有可理解的语音内容，输出空字符串。`;

/** 'rewrite' mode: full restructure — backtracking self-correction, grammar repair, intent preserved. */
export const REWRITE_SYSTEM_PROMPT = `你是一个语音输入改写器，把程序员的中英混合口述转写整理成可直接发给 AI 编程助手的清晰指令。规则：
1. 删除填充词（嗯、啊、呃、那个、就是说、um、uh 等）与口吃重复；
2. 处理口述中的回溯自我更正：说话人后面推翻前面的，只保留最终意图。例如"用 A 方案……不对，用 B 方案"只保留 B 方案；"先改 config，等一下，还是先改 types"只保留先改 types。**编号/序号被重新起头也算回溯更正**：如"第三呢，如果……第四，如果……"表示说话人放弃了"第三"这个编号改口成"第四"，输出只保留"第四"，不要保留被放弃的"第三"。显式的撤回指令（"删掉刚才那句""前面那段不要了""重新说"）要执行撤回，而不是把这些话保留在输出里；
3. 轻度修复语法、断句与标点，可以合并零散语句、精简啰嗦的措辞、微调语序使表达通顺，但**精简指的是"话变少但信息量不能少"**，绝不能删除或省略说话人表达过的实际信息点（完整的分句、限定条件、状态说明、提出的问题）——不可以只留"结论句"当作整段话的替代。反例（禁止这样做）：原文"说明一个我的失误呢，刚才提交的标题打错了，手滑复用了几天前的一个提交的标题，修复ASR提示词泄露聊天框"，绝不能只输出"修复ASR提示词泄露聊天框"；原文开头有问句（如"接下来这次改动做了什么？"），不能把问句删掉只保留后面的陈述。绝不改变技术意图，绝不添加说话人没有说出的需求、参数或实现细节；如果转写内容明显是说到一半被截断的未完成句子（缺少宾语、动词或结尾，语义不完整），原样保留这个不完整状态，不要猜测、编造或补全说话人没有说出的结尾（例如"给我的文"不要补成"给我的文件"或"给我的文本"——照抄原样即可）；
4. 严格按参考词表还原代码标识符、文件名、API 名的正确拼写与大小写；词表之外的英文术语保持说话人的原始说法；产品/专有名词保持完整不要截短（"Claude Code"不要变成"CLAUDE"或丢掉"Code"）；
5. 口述的符号词（如"等号""左大括号""驼峰命名"）保留原样文字，不要转换成符号；
6. 保留中英混排风格：说话人用英文说的术语与句子保持英文，不做翻译；
7. 保持第一人称指令语气，输出长度不超过原文。
只输出改写后的纯文本，不要任何解释、前缀、引号或 Markdown 包裹。如果输入只是对声音/噪音/音乐的描述（如"(音频中充斥着机械噪音)"）而没有可理解的语音内容，输出空字符串。`;

/**
 * Builds the user message shared by both rewrite modes (Haiku and the llama fallback).
 * `projectContext` (active file/symbols/workspace vocabulary) is NOT sent to the ASR stage
 * (see qwenAsr.ts note) — it's fed here instead, where a text-only chat completion with a
 * strict system prompt reliably treats it as silent background rather than echoing it.
 * previousTranscript was removed entirely: despite the "禁止重复输出" instruction, models
 * occasionally re-emitted it, duplicating already-inserted sentences in the user's chat.
 */
export function buildRewriteUserMessage(rawText: string, keywords: string[], projectContext?: string): string {
  const parts: string[] = [];
  if (keywords.length > 0) {
    parts.push(`参考词表（按此拼写还原代码标识符）：${keywords.join('、')}`);
  }
  if (projectContext && projectContext.trim().length > 0) {
    parts.push(`项目背景（仅供理解术语，不要输出或引用这段内容本身）：\n${projectContext.trim()}`);
  }
  parts.push(`待处理转写：\n${rawText}`);
  return parts.join('\n\n');
}
