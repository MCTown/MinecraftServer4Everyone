export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeMarkdownHref(href: string) {
  const trimmed = href.trim();
  if (!trimmed) return "";
  const scheme = trimmed.match(/^([a-z][a-z\d+.-]*):/i)?.[1]?.toLowerCase();
  if (scheme && !["http", "https", "mailto"].includes(scheme)) return "";
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return trimmed;
}
