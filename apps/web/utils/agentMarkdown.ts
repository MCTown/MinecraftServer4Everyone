import { Marked, Renderer } from "marked";
import type { Tokens } from "marked";
import { escapeHtml, safeMarkdownHref } from "~/utils/html";

const renderer = new Renderer();

function hasCompactGfmTable(line: string) {
  return /\|\s*:?-{3,}:?\s*\|/.test(line);
}

function normalizeCompactMarkdown(content: string) {
  let fenced = false;

  return content.replace(/\r\n?/g, "\n").split("\n").map((line) => {
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;

    // Some providers emit compact Markdown such as "##标题|列1|列2||---|---|"
    // or "说明：-**项目**". Repair only these unambiguous block boundaries.
    let normalized = line
      .replace(/([^\n])(?=-(?:\*\*|`|\[[^\]]+\]))/g, "$1\n")
      .replace(/([。！？；;：:`）)])(?=-\S)/g, "$1\n")
      .replace(/([：:])(?=\*\*[^*]+\*\*[：:])/g, "$1\n")
      .replace(/([|])(?=#{1,6}(?=\S))/g, "$1\n")
      .replace(/([|。！？；;：:）)])(?=#{1,6}(?=[^#\s]))/g, "$1\n")
      .replace(/^(\s{0,3}#{1,6})(?=[^#\s])/gm, "$1 ")
      .replace(/^(#{1,6}\s+[^|\n]+)(?=\|)/gm, "$1\n");

    if (hasCompactGfmTable(normalized)) normalized = normalized.replace(/\|\|/g, "|\n|");

    return normalized
      .replace(/([：:。；;])(?=\d{1,3}[.)](?=\S))/g, "$1\n")
      .replace(/^(\s*(?:[-+]|\*(?!\*)|\d+[.)]))(?=[^\s-])/gm, "$1 ");
  }).join("\n");
}

renderer.html = ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text);

renderer.link = function (this: Renderer, { href, title, tokens }: Tokens.Link) {
  const label = this.parser.parseInline(tokens);
  const safeHref = safeMarkdownHref(href);
  if (!safeHref) return `<span class="markdown-link-disabled">${label}</span>`;
  const safeTitle = title ? ` title="${escapeHtml(title)}"` : "";
  return `<a href="${escapeHtml(safeHref)}"${safeTitle} target="_blank" rel="noreferrer noopener">${label}</a>`;
};

renderer.image = ({ href, text, title }: Tokens.Image) => {
  const safeHref = safeMarkdownHref(href);
  const label = escapeHtml(text || href || "image");
  const safeTitle = title ? ` title="${escapeHtml(title)}"` : "";
  if (!safeHref) return `<span class="markdown-image-fallback">图片：${label}</span>`;
  return `<img class="markdown-image" src="${escapeHtml(safeHref)}" alt="${label}"${safeTitle} loading="lazy" referrerpolicy="no-referrer" />`;
};

renderer.checkbox = ({ checked }: Tokens.Checkbox) =>
  `<input class="markdown-task-checkbox" type="checkbox" disabled${checked ? " checked" : ""} />`;

renderer.table = function (this: Renderer, token: Tokens.Table) {
  const header = this.tablerow({
    text: token.header.map((cell) => this.tablecell(cell)).join("")
  });
  const body = token.rows
    .map((row) => this.tablerow({ text: row.map((cell) => this.tablecell(cell)).join("") }))
    .join("");
  return `<div class="markdown-table-wrap"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>\n`;
};

const agentMarkdown = new Marked({
  async: false,
  breaks: true,
  gfm: true,
  pedantic: false,
  silent: true,
  renderer
});

export function renderAgentMarkdown(content: string) {
  if (!content) return "";
  try {
    const html = agentMarkdown.parse(normalizeCompactMarkdown(content), { async: false });
    return typeof html === "string" ? html : "";
  } catch {
    return `<pre class="markdown-fallback">${escapeHtml(content)}</pre>`;
  }
}

export function collapsibleAgentLogTitle(content: string) {
  const firstLine = content.trim().split(/\r?\n/, 1)[0] ?? "";
  if (firstLine.startsWith("调用工具：")) return firstLine;
  if (firstLine.startsWith("工具结果：")) return firstLine;
  if (firstLine.startsWith("工具调用失败")) return firstLine;
  return "";
}

export function isCollapsibleAgentLog(content: string) {
  return Boolean(collapsibleAgentLogTitle(content));
}
