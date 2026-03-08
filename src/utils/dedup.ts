const DEDUP_THRESHOLD = 0.85;

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordSet(text: string): Set<string> {
  return new Set(normalizeTitle(text).split(' ').filter(w => w.length > 1));
}

export function titleSimilarity(a: string, b: string): number {
  const setA = wordSet(a);
  const setB = wordSet(b);

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function isDuplicate(
  existingTitle: string | undefined,
  newTitle: string,
  existingDoi?: string | null,
  newDoi?: string | null,
  existingMd5?: string | null,
  newMd5?: string | null
): boolean {
  if (existingDoi && newDoi && existingDoi === newDoi) return true;
  if (existingMd5 && newMd5 && existingMd5 === newMd5) return true;
  if (existingTitle && newTitle && titleSimilarity(existingTitle, newTitle) >= DEDUP_THRESHOLD) return true;
  return false;
}
