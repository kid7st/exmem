/**
 * Auto-recall: proactive memory retrieval.
 *
 * Searches context history based on the user's prompt and injects
 * relevant historical context before the agent starts processing.
 *
 * Design constraints (from COGNITIVE-RULES.md / REVIEW-reliability.md):
 * - Pure code implementation, NO LLM calls
 * - Precision > recall: better to inject nothing than wrong content
 * - Max injection budget: ~2k tokens
 * - Simple keyword matching (Phase 2 MVP)
 *
 * Design reference: DESIGN.md §11 Phase 2
 */

import type { ExMem } from "../core/exmem.ts";
import type { AutoRecallConfig, SearchHit } from "../core/types.ts";
import { DEFAULT_RECALL_CONFIG } from "../core/types.ts";

/**
 * Extract keywords from a user prompt for searching context history.
 *
 * Strategy: extract meaningful tokens, skip common words.
 * Works for both English and Chinese text.
 */
export function extractKeywords(prompt: string): string[] {
  // Common stop words to filter out
  const stopWords = new Set([
    // English
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "about", "between",
    "through", "after", "before", "above", "below", "it", "its", "this",
    "that", "these", "those", "i", "me", "my", "you", "your", "we", "our",
    "they", "them", "their", "he", "she", "his", "her", "what", "which",
    "who", "when", "where", "how", "why", "not", "no", "nor", "but", "or",
    "and", "if", "then", "else", "so", "just", "also", "very", "too",
    "here", "there", "all", "each", "every", "both", "few", "more", "most",
    "some", "any", "other", "such", "than", "up", "out", "off",
    "please", "help", "let", "want", "need", "use", "make", "get",
    "show", "tell", "give", "take", "go", "come", "see", "look", "find",
    "ok", "okay", "yes", "no", "yeah", "sure", "right", "well", "like",
    // Chinese common
    "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都",
    "一", "一个", "上", "也", "很", "到", "说", "要", "去", "你",
    "会", "着", "没有", "看", "好", "自己", "这", "他", "么", "她",
    "吗", "什么", "那", "还", "但", "而", "或", "把", "被", "从",
    "对", "能", "可以", "可能", "如果", "因为", "所以", "然后",
    "帮", "帮我", "请", "下", "里", "用", "做",
  ]);

  const lowerPrompt = prompt.toLowerCase();

  // Tokenize: split on whitespace + punctuation, keep meaningful chunks
  const rawTokens = lowerPrompt
    .split(/[\s,.:;!?，。：；！？、""''【】（）\(\)\[\]{}<>]+/)
    .filter((t) => t.length >= 2);

  // For CJK: also split by stop words to extract meaningful segments
  // e.g. "的参数" → remove "的" → "参数"
  const tokens: string[] = [];
  for (const raw of rawTokens) {
    if (stopWords.has(raw)) continue;
    // Try stripping leading/trailing CJK stop chars
    let cleaned = raw;
    for (const sw of stopWords) {
      if (sw.length === 1 && cleaned.startsWith(sw)) cleaned = cleaned.slice(sw.length);
      if (sw.length === 1 && cleaned.endsWith(sw)) cleaned = cleaned.slice(0, -sw.length);
    }
    if (cleaned.length >= 2 && !stopWords.has(cleaned)) {
      tokens.push(cleaned);
    }
  }

  // Also extract quoted strings (user often quotes specific terms)
  const quoted = prompt.match(/["'"'「」]([^"'"'「」]+)["'"'「」]/g);
  if (quoted) {
    for (const q of quoted) {
      const inner = q.slice(1, -1).trim().toLowerCase();
      if (inner.length >= 2) tokens.push(inner);
    }
  }

  // Extract numbers with context (e.g., "v2", "1.5", "25%")
  const numbers = lowerPrompt.match(/v\d+|\d+\.?\d*%?/gi);
  if (numbers) {
    tokens.push(...numbers.map((n) => n.toLowerCase()));
  }

  // Deduplicate
  return [...new Set(tokens)];
}

/**
 * Perform auto-recall: search context history and return injection content.
 *
 * Returns null if nothing relevant found (precision > recall).
 */
export async function autoRecall(
  exMem: ExMem,
  userPrompt: string,
  config: AutoRecallConfig = DEFAULT_RECALL_CONFIG,
): Promise<string | null> {
  // Guard: skip if prompt is too short
  if (userPrompt.trim().length < 5) return null;

  // Guard: skip if no history yet (at least 1 ctx_update must have happened)
  const status = await exMem.getStatus();
  if (status.checkpoints < 2) return null;

  // Step 1: Extract keywords
  const keywords = extractKeywords(userPrompt);
  if (keywords.length === 0) return null;

  // Step 2: Search context history
  const hits = await exMem.search(keywords);
  if (hits.length === 0) return null;

  // Step 3: Filter by score threshold
  const relevant = hits.filter((h) => h.score >= config.scoreThreshold);
  if (relevant.length === 0) return null;

  // Step 4: Check if the matched content is already in current context
  //         (avoid injecting what's already visible)
  const currentIndex = await exMem.getIndexContent();
  const topHit = relevant[0];
  if (currentIndex) {
    // If the top hit's key info is already in the current index, skip
    const hitInfo = topHit.matchedLines.join(" ");
    const overlapTokens = countOverlap(hitInfo, currentIndex);
    if (overlapTokens > hitInfo.split(/\s+/).length * 0.6) {
      return null; // >60% overlap with current context, skip
    }
  }

  // Step 5: Build injection content within budget
  const maxChars = config.maxInjectTokens * 3; // rough: 1 token ≈ 3 chars
  let content = "[Memory] Relevant context from history:\n\n";

  // Take top 2 hits max
  const topHits = relevant.slice(0, 2);

  for (const hit of topHits) {
    const section = `**Commit ${hit.entry.hash}**: ${hit.entry.message}\n`;
    const matches = hit.matchedLines
      .slice(0, 5) // max 5 matched lines per hit
      .map((l) => `  ${l}`)
      .join("\n");

    const addition = section + matches + "\n\n";

    if (content.length + addition.length > maxChars) break;
    content += addition;
  }

  // Step 6: If we have relevant historical context files, include a snippet
  // Try to read the most relevant context file from the top hit's commit
  if (topHit.matchedLines.length > 0) {
    // Extract file name from matched lines like "[context/strategy-params.md] ..."
    const fileMatch = topHit.matchedLines[0].match(/\[(?:context\/)?([^\]]+)\]/);
    if (fileMatch) {
      const fileName = fileMatch[1];
      try {
        const historicalContent = await exMem.git.show(
          topHit.entry.hash,
          `context/${fileName}`,
        );
        if (historicalContent) {
          const snippet = historicalContent.substring(0, maxChars - content.length);
          if (snippet.length > 50) {
            content += `**${fileName}** (at commit ${topHit.entry.hash}):\n${snippet}\n`;
          }
        }
      } catch {
        // File might not exist at that commit, ignore
      }
    }
  }

  // Final budget check
  if (content.length > maxChars) {
    content = content.substring(0, maxChars) + "\n...(truncated)";
  }

  return content.trim();
}

/**
 * Count word overlap between two texts (simple approximation).
 */
function countOverlap(text1: string, text2: string): number {
  const words1 = new Set(text1.toLowerCase().split(/\s+/));
  const words2 = new Set(text2.toLowerCase().split(/\s+/));
  let overlap = 0;
  for (const w of words1) {
    if (words2.has(w)) overlap++;
  }
  return overlap;
}
