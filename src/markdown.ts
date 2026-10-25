const MARKDOWN_METACHARACTER = /([\\`*_[\]{}()#+\-!|<>~=$%&])/gu;
const ORDERED_LIST_MARKER = /^(\d+)([.)])/gmu;
const LINE_BREAK = /\r\n?|\n/gu;

/** Escape source text so it remains literal in Obsidian Flavored Markdown. */
export function escapeMarkdownText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(MARKDOWN_METACHARACTER, "\\$1")
    .replace(ORDERED_LIST_MARKER, "$1\\$2")
    .replace(/^(?: {4}|\t)/gmu, (indentation) =>
      indentation === "\t" ? "&#9;" : "&#32;   ");
}

/** Escape source text for a heading or link label that must stay on one line. */
export function escapeMarkdownInlineText(value: string): string {
  return escapeMarkdownText(value.replace(LINE_BREAK, " "));
}

/** Normalize an external AFFiNE URL and reject executable or local schemes. */
export function normalizeExternalUrl(value: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(value)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (scheme === "http" || scheme === "https" || scheme === "mailto") return value;
    throw new Error(`Unsupported external URL scheme "${scheme}".`);
  }
  return value.startsWith("//") ? `https:${value}` : `https://${value}`;
}

/** Render literal inline code with a delimiter longer than every embedded run. */
export function escapeInlineCode(value: string): string {
  const content = value.replace(LINE_BREAK, " ");
  const runs = content.match(/`+/gu) ?? [];
  const longestRun = runs.reduce((longest, run) => Math.max(longest, run.length), 0);
  const delimiter = "`".repeat(longestRun + 1);
  const needsPadding = content.startsWith("`") || content.endsWith("`")
    || (content.startsWith(" ") && content.endsWith(" "));
  const body = needsPadding ? ` ${content} ` : content;
  return `${delimiter}${body}${delimiter}`;
}

/** Angle-bracket destinations safely retain spaces and balanced parentheses. */
export function escapeMarkdownUrl(value: string): string {
  const destination = value
    .replace(/\\/gu, "%5C")
    .replace(/</gu, "%3C")
    .replace(/>/gu, "%3E")
    .replace(/\r/gu, "%0D")
    .replace(/\n/gu, "%0A");
  return `<${destination}>`;
}

/** Escape a registry-owned .md path for use as an Obsidian wikilink target. */
export function escapeWikilinkTarget(outputPath: string): string {
  const path = outputPath.replace(/\.md$/iu, "").replace(LINE_BREAK, " ");
  return path.replace(/([\\[\]#^|])/gu, "\\$1");
}

/** Wikilink aliases cannot contain literal line breaks or Markdown delimiters. */
export function escapeWikilinkAlias(value: string): string {
  return escapeMarkdownText(value.replace(LINE_BREAK, " "));
}
