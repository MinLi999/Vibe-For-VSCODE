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
6. 严格保留中英混排原样：不翻译、不增删内容、不调整语序、不总结。
只输出处理后的纯文本，不要任何解释、前缀、引号或 Markdown 包裹。如果输入为空或全是填充词，输出空字符串。`;

/** 'rewrite' mode: full restructure — backtracking self-correction, grammar repair, intent preserved. */
export const REWRITE_SYSTEM_PROMPT = `你是一个语音输入改写器，把程序员的中英混合口述转写整理成可直接发给 AI 编程助手的清晰指令。规则：
1. 删除填充词（嗯、啊、呃、那个、就是说、um、uh 等）与口吃重复；
2. 处理口述中的回溯自我更正：说话人后面推翻前面的，只保留最终意图。例如"用 A 方案……不对，用 B 方案"只保留 B 方案；"先改 config，等一下，还是先改 types"只保留先改 types。显式的撤回指令（"删掉刚才那句""前面那段不要了""重新说"）要执行撤回，而不是把这些话保留在输出里；
3. 轻度修复语法、断句与标点，可以合并零散语句、微调语序使表达通顺，但绝不改变技术意图，绝不添加说话人没有说出的需求、参数或实现细节；
4. 严格按参考词表还原代码标识符、文件名、API 名的正确拼写与大小写；词表之外的英文术语保持说话人的原始说法；
5. 口述的符号词（如"等号""左大括号""驼峰命名"）保留原样文字，不要转换成符号；
6. 保留中英混排风格：说话人用英文说的术语与句子保持英文，不做翻译；
7. 保持第一人称指令语气，输出长度不超过原文。
只输出改写后的纯文本，不要任何解释、前缀、引号或 Markdown 包裹。`;

/**
 * Builds the user message shared by both rewrite modes (Haiku and the llama fallback).
 * `projectContext` (active file/symbols/workspace vocabulary) is NOT sent to the ASR stage
 * (see qwenAsr.ts note) — it's fed here instead, where a text-only chat completion with a
 * strict system prompt reliably treats it as silent background rather than echoing it.
 */
export function buildRewriteUserMessage(
  rawText: string,
  keywords: string[],
  previousTranscript?: string,
  projectContext?: string,
): string {
  const parts: string[] = [];
  if (keywords.length > 0) {
    parts.push(`参考词表（按此拼写还原代码标识符）：${keywords.join('、')}`);
  }
  if (projectContext && projectContext.trim().length > 0) {
    parts.push(`项目背景（仅供理解术语，不要输出或引用这段内容本身）：\n${projectContext.trim()}`);
  }
  if (previousTranscript && previousTranscript.trim().length > 0) {
    parts.push(`上一段已转写内容（仅供理解衔接，禁止重复输出）：\n${previousTranscript.trim().slice(-300)}`);
  }
  parts.push(`待处理转写：\n${rawText}`);
  return parts.join('\n\n');
}
