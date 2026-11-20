import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { wrappedFirstLineNumber, wrappedLineText } from "./document-links.ts";

const URL_END = /[\s"'<>\\\x00-\x1f]/u;
const TRAILING_PUNCTUATION = /(?:[.,;:!?)\]}>'"`]|[\u3002\uff0c\uff1b\uff1a\uff01\uff1f\uff09\u3011\u300b\u3001])+$/u;

export type UrlMatch = { url: string; start: number; end: number };

export function findUrls(text: string): UrlMatch[] {
  const matches: UrlMatch[] = [];
  const scheme = /\bhttps?:\/\//giu;
  for (let match; (match = scheme.exec(text));) {
    const start = match.index;
    let before = start;
    while (before > 0 && /[ \t]/.test(text[before - 1]!)) before--;
    const opener = text[before - 1];
    const closer = opener === "(" ? ")" : opener === "（" ? "）" : undefined;
    let depth = 0, end = scheme.lastIndex;
    for (; end < text.length && !URL_END.test(text[end]!); end++) {
      if (!closer) continue;
      if (text[end] === opener) depth++;
      if (text[end] === closer) {
        if (depth === 0) break;
        depth--;
      }
    }
    const raw = text.slice(start, end);
    const delimited = (closer !== undefined && text[end] === closer) || text.endsWith("](", before);
    const url = delimited ? raw : raw.replace(TRAILING_PUNCTUATION, "");
    if (url.length > match[0].length) matches.push({ url, start, end: start + url.length });
    scheme.lastIndex = end;
  }
  return matches;
}

/** Link provider for http(s) URLs. Unlike xterm's built-in linkifier, URLs are
 * matched on the joined wrapped text, so a link broken across narrow-terminal
 * rows still opens the full URL. Results are cached per wrapped block and
 * invalidated on writes and resizes, because xterm queries the provider on
 * every mouse move. */
export function createWebLinkProvider(
  terminal: Terminal,
  mount: HTMLElement,
  open: (url: string) => void,
): ILinkProvider {
  let cache = new Map<number, ILink[]>();
  terminal.onWriteParsed(() => { cache = new Map(); });
  terminal.onResize(() => { cache = new Map(); });
  return {
    provideLinks(bufferLineNumber, callback) {
      const firstLineNumber = wrappedFirstLineNumber(terminal, bufferLineNumber);
      let links = cache.get(firstLineNumber);
      if (!links) {
        const { text, offsets } = wrappedLineText(terminal, bufferLineNumber);
        links = findUrls(text).flatMap<ILink>((match) => {
          const first = offsets.find((offset) => match.start >= offset.start && match.start < offset.end);
          const last = offsets.findLast((offset) => match.end > offset.start && match.end <= offset.end)
            ?? offsets.findLast((offset) => offset.start < match.end);
          if (!first || !last) return [];
          return [{
            range: {
              start: { x: first.cell + 1, y: first.line },
              end: { x: last.cell + 1, y: last.line },
            },
            text: match.url,
            decorations: { underline: true, pointerCursor: true },
            activate: () => open(match.url),
            hover: () => { mount.title = match.url; },
            leave: () => { mount.removeAttribute("title"); },
          }];
        });
        cache.set(firstLineNumber, links);
      }
      callback(links.length ? links : undefined);
    },
  };
}
