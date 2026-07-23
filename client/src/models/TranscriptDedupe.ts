/**
 * Trims text that echoes what the current session already inserted. Echoes come from two
 * vectors: ASR repeating conditioning text on near-silent audio, and rewrite LLMs ignoring
 * the "禁止重复输出" instruction. Deterministic last line of defense regardless of the source.
 *
 * Shared by the VS Code extension controller and the desktop app (previously two identical
 * copies). Pure function — no vscode/electron dependencies.
 */
export function dedupeAgainstSession(sessionTranscript: string, text: string): string {
  const prev = sessionTranscript;
  const t = text.trim();
  if (prev.length === 0 || t.length === 0) {
    return t;
  }
  const normalize = (s: string): string => s.replace(/[\s。.,，、;；:：!！?？…~〜'"'"()（）\-]/g, '');
  const nPrev = normalize(prev);
  const nText = normalize(t);
  // The whole utterance is a re-emission of what was already inserted.
  if (nText.length > 0 && nPrev.endsWith(nText)) {
    return '';
  }
  // Overlap trim: longest suffix of the inserted transcript that prefixes the new text
  // (≥8 chars so ordinary short word repeats aren't mistaken for echoes).
  const max = Math.min(prev.length, t.length);
  for (let k = max; k >= 8; k--) {
    if (prev.endsWith(t.slice(0, k))) {
      return t.slice(k).replace(/^[\s。.,，、;；:：!！?？…]+/, '');
    }
  }
  return t;
}
