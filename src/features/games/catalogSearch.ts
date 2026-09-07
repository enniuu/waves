export function normalizeCatalogText(value: string): string {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function catalogMatchRank(
  primaryText: string,
  secondaryText: string,
  normalizedQuery: string,
  tokens: readonly string[] = normalizedQuery.split(" "),
): number {
  if (!normalizedQuery) return 0;
  if (primaryText === normalizedQuery) return 0;
  if (primaryText.startsWith(normalizedQuery)) return 1;

  if (tokens.every((token) => primaryText.includes(token))) return 2;
  if (secondaryText.startsWith(normalizedQuery)) return 3;

  const combinedText = `${primaryText} ${secondaryText}`;
  return tokens.every((token) => combinedText.includes(token)) ? 4 : -1;
}
