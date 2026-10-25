// A small fuzzy matcher for the command palette: the typed letters must appear in order, and the
// best way of placing them wins. Letters at the start of a word, next to the last match, or at
// the very start score higher, so "ow" finds "Open web" before "Show rows", and "sm" finds
// "Stream mode" (an acronym) as well as "Smite".

export interface Match {
  /** Higher is better. */
  score: number;
  /** Which characters of the text matched, for highlighting. */
  positions: number[];
}

const START = 8;
const WORD = 5;
const NEXT_TO_LAST = 8;
const SAME_CASE = 0.5;
const GAP = 0.15;
const LEAD = 0.05;
const LENGTH = 0.02;
const WHOLE = 4;

const isWordChar = (c: string) => /[a-z0-9]/i.test(c);

/** True for the first letter of a word: after a space or symbol, or an upper case letter after a lower case one. */
function wordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  const here = text[i];
  if (!isWordChar(prev)) return true;
  return prev === prev.toLowerCase() && prev !== prev.toUpperCase() && here === here.toUpperCase() && here !== here.toLowerCase();
}

/** One word of the query against the text, or null if its letters aren't in the text in order. */
function matchWord(word: string, text: string): Match | null {
  const m = word.length;
  const n = text.length;
  if (m === 0) return { score: 0, positions: [] };
  if (m > n) return null;
  const q = word.toLowerCase();
  const t = text.toLowerCase();

  // best[i][j]: the best score with word letter i placed on text letter j (-Infinity if it can't be).
  const best: number[][] = [];
  const from: number[][] = [];
  for (let i = 0; i < m; i++) {
    best.push(new Array<number>(n).fill(-Infinity));
    from.push(new Array<number>(n).fill(-1));
    // The best earlier placement with a gap, tracked as we sweep j: best[i-1][k] + GAP * k.
    let run = -Infinity;
    let runAt = -1;
    for (let j = 0; j < n; j++) {
      if (i > 0 && j >= 2) {
        const k = j - 2;
        const v = best[i - 1][k] + GAP * k;
        if (v > run) {
          run = v;
          runAt = k;
        }
      }
      if (q[i] !== t[j]) continue;
      let gain = 1 + (text[j] === word[i] ? SAME_CASE : 0);
      if (wordStart(text, j)) gain += j === 0 ? START : WORD;
      if (i === 0) {
        best[i][j] = gain - LEAD * j;
        continue;
      }
      let prior = -Infinity;
      let priorAt = -1;
      if (run > -Infinity) {
        prior = run - GAP * (j - 1);
        priorAt = runAt;
      }
      if (j >= 1 && best[i - 1][j - 1] > -Infinity && best[i - 1][j - 1] + NEXT_TO_LAST > prior) {
        prior = best[i - 1][j - 1] + NEXT_TO_LAST;
        priorAt = j - 1;
      }
      if (prior > -Infinity) {
        best[i][j] = prior + gain;
        from[i][j] = priorAt;
      }
    }
  }

  let end = -1;
  for (let j = 0; j < n; j++) if (best[m - 1][j] > -Infinity && (end < 0 || best[m - 1][j] > best[m - 1][end])) end = j;
  if (end < 0) return null;
  const positions = new Array<number>(m);
  for (let i = m - 1, j = end; i >= 0; i--) {
    positions[i] = j;
    j = from[i][j];
  }
  return { score: best[m - 1][end], positions };
}

/**
 * How well the query matches the text, or null when it doesn't. Words of the query (split on
 * spaces) are matched on their own, in any order, and every one has to match. Case doesn't matter
 * (matching case only breaks ties). An empty query matches everything with a score of 0.
 */
export function fuzzyMatch(query: string, text: string): Match | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { score: 0, positions: [] };
  let score = 0;
  const positions = new Set<number>();
  for (const word of words) {
    const m = matchWord(word, text);
    if (!m) return null;
    score += m.score;
    m.positions.forEach((p) => positions.add(p));
  }
  // A query that is the whole text is the best answer there is.
  if (text.trim().toLowerCase() === query.trim().toLowerCase()) score += WHOLE;
  return { score: score - LENGTH * text.length, positions: [...positions].sort((a, b) => a - b) };
}

export const fuzzyScore = (query: string, text: string): number | null => fuzzyMatch(query, text)?.score ?? null;

/** The items that match, best first; ties keep their original order. */
export function fuzzyFilter<T>(query: string, items: T[], textOf: (item: T) => string): { item: T; match: Match }[] {
  return items
    .map((item, index) => ({ item, index, match: fuzzyMatch(query, textOf(item)) }))
    .filter((r): r is { item: T; index: number; match: Match } => r.match !== null)
    .sort((a, b) => b.match.score - a.match.score || a.index - b.index)
    .map(({ item, match }) => ({ item, match }));
}
