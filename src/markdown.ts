import katex from "katex";

const MAX_MERMAID_DIAGRAMS = 10;
export const MAX_MERMAID_SOURCE_BYTES = 64 * 1024;

export type RenderedMarkdown = { html: string; mermaid: Array<{ id: string; source: string }> };

export function renderMarkdown(source: string, documentPath: string): RenderedMarkdown {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  const mermaid: Array<{ id: string; source: string }> = [];
  const headingIds = new Map<string, number>();
  let paragraph: string[] = [];
  let list: "ul" | "ol" | null = null;
  let index = 0;

  const closeParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${renderInline(paragraph.join(" "), documentPath)}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!list) return;
    output.push(`</${list}>`);
    list = null;
  };
  const closeBlocks = () => {
    closeParagraph();
    closeList();
  };

  while (index < lines.length) {
    const line = lines[index]!;
    const fence = line.match(/^\s*```\s*([^\s`]*)\s*$/);
    if (fence) {
      closeBlocks();
      const language = fence[1]?.toLowerCase() ?? "";
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index]!)) {
        code.push(lines[index]!);
        index += 1;
      }
      const text = code.join("\n");
      if (language === "mermaid" && mermaid.length < MAX_MERMAID_DIAGRAMS && new TextEncoder().encode(text).length <= MAX_MERMAID_SOURCE_BYTES) {
        const id = `mermaid-${mermaid.length + 1}`;
        mermaid.push({ id, source: text });
        output.push(`<figure class="mermaid" data-mermaid-id="${id}"><pre><code>${escapeHtml(text)}</code></pre></figure>`);
      } else {
        const className = language ? ` class="language-${escapeAttribute(language)}"` : "";
        output.push(`<pre><code${className}>${escapeHtml(text)}</code></pre>`);
      }
      index += 1;
      continue;
    }

    const displayMath = line.match(/^\s*\$\$(.*)$/);
    if (displayMath) {
      closeBlocks();
      const math: string[] = [];
      let current = displayMath[1]!;
      while (true) {
        const end = current.indexOf("$$");
        if (end >= 0) {
          math.push(current.slice(0, end));
          break;
        }
        math.push(current);
        index += 1;
        if (index >= lines.length) break;
        current = lines[index]!;
      }
      output.push(renderMath(math.join("\n").trim(), true));
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeBlocks();
      const level = heading[1]!.length;
      const headingText = heading[2]!;
      const baseId = headingId(headingText);
      const occurrence = (headingIds.get(baseId) ?? 0) + 1;
      headingIds.set(baseId, occurrence);
      const id = occurrence === 1 ? baseId : `${baseId}-${occurrence}`;
      output.push(`<h${level} id="${escapeAttribute(id)}">${renderInline(headingText, documentPath)}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      closeBlocks();
      output.push("<hr>");
      index += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      closeBlocks();
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index]!)) {
        quote.push(lines[index]!.replace(/^>\s?/, ""));
        index += 1;
      }
      output.push(`<blockquote>${renderMarkdown(quote.join("\n"), documentPath).html}</blockquote>`);
      continue;
    }
    if (isTableHeader(lines, index)) {
      closeBlocks();
      const headers = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index]!.includes("|") && lines[index]!.trim()) {
        rows.push(splitTableRow(lines[index]!));
        index += 1;
      }
      output.push(`<div class="table-wrap"><table><thead><tr>${headers.map((cell) => `<th>${renderInline(cell, documentPath)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell, documentPath)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      closeParagraph();
      const nextList = unordered ? "ul" : "ol";
      if (list !== nextList) {
        closeList();
        list = nextList;
        output.push(`<${list}>`);
      }
      output.push(`<li>${renderInline((unordered ?? ordered)![1]!, documentPath)}</li>`);
      index += 1;
      continue;
    }
    if (!line.trim()) {
      closeBlocks();
      index += 1;
      continue;
    }
    paragraph.push(line.trim());
    index += 1;
  }
  closeBlocks();
  return { html: output.join("\n"), mermaid };
}

export function localImagePreviewUrl(source: string, documentPath: string): string | null {
  if (!source || source.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith("//")) return null;
  const base = documentPath.slice(0, documentPath.lastIndexOf("/") + 1);
  const stack = (source.startsWith("/") ? [] : base.split("/")).filter(Boolean);
  for (const part of source.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return `/api/preview?path=${encodeURIComponent(`/${stack.join("/")}`)}`;
}

function renderInline(source: string, documentPath: string): string {
  let text = escapeHtml(source);
  const tokens: string[] = [];
  const save = (html: string) => {
    const token = `\u0000${tokens.length}\u0000`;
    tokens.push(html);
    return token;
  };
  text = text.replace(/`([^`]+)`/g, (_match, code: string) => save(`<code>${code}</code>`));
  text = text.replace(/(?<!\\)\$([^$\n]+?)(?<!\\)\$/g, (_match, math: string) => save(renderMath(decodeHtml(math), false)));
  text = text.replace(/(?<!!)\[\[([^\]\n]+)\]\]/g, (_match, value: string) => {
    const decoded = decodeHtml(value);
    const separator = decoded.indexOf("|");
    const destination = (separator >= 0 ? decoded.slice(0, separator) : decoded).trim();
    const label = (separator >= 0 ? decoded.slice(separator + 1) : destination.split("#", 1)[0]!).trim();
    const href = wikiLinkUrl(destination, documentPath);
    return href && label
      ? save(`<a class="wikilink" href="${escapeAttribute(href)}">${escapeHtml(label)}</a>`)
      : escapeHtml(`[[${decoded}]]`);
  });
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (_match, alt: string, sourceValue: string) => {
    const url = localImagePreviewUrl(decodeHtml(sourceValue), documentPath);
    return url ? save(`<img src="${escapeAttribute(url)}" alt="${escapeAttribute(decodeHtml(alt))}" loading="lazy">`) : save(`<span class="image-unavailable">${alt}</span>`);
  });
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (_match, label: string, hrefValue: string) => {
    const href = safeLink(decodeHtml(hrefValue));
    return href ? save(`<a href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`) : label;
  });
  text = text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/(?<!_)_([^_]+)_(?!_)/g, "<em>$1</em>");
  return text.replace(/\u0000(\d+)\u0000/g, (_match, token: string) => tokens[Number(token)]!);
}

function renderMath(source: string, displayMode: boolean): string {
  if (!source) return displayMode ? '<div class="math-error">Empty formula</div>' : "$$";
  try {
    return katex.renderToString(source, {
      displayMode,
      output: "mathml",
      throwOnError: true,
      trust: false,
      strict: "warn",
    });
  } catch {
    const escaped = escapeHtml(source);
    return displayMode
      ? `<pre class="math-error"><code>$$${escaped}$$</code></pre>`
      : `<code class="math-error">$${escaped}$</code>`;
  }
}

export function wikiLinkUrl(value: string, documentPath: string): string | null {
  const separator = value.indexOf("#");
  const target = (separator >= 0 ? value.slice(0, separator) : value).trim();
  const heading = (separator >= 0 ? value.slice(separator + 1) : "").trim();
  if (!documentPath.startsWith("/") || value.includes("\0")) return null;
  if (!target) return heading ? `#${encodeURIComponent(headingId(heading))}` : null;
  if (target.startsWith("/") || target.startsWith(".") || target.split("/").some((part) => !part || part === "." || part === "..")) return null;
  const query = new URLSearchParams({ documentPath, target });
  if (heading) query.set("heading", headingId(heading));
  return `/api/resolve-wikilink?${query.toString()}`;
}

function headingId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "section";
}

function safeLink(value: string): string | null {
  if (value.startsWith("#") || value.startsWith("/")) return value;
  return /^(?:https?|mailto):/i.test(value) ? value : null;
}

function isTableHeader(lines: string[], index: number): boolean {
  return lines[index]!.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] ?? "");
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function decodeHtml(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
