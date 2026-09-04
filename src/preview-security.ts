import { delimiter, dirname, extname, join, resolve } from "node:path";

export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_PREVIEW_IMAGE_BYTES = 20 * 1024 * 1024;

export type PreviewType = {
  kind: "markdown" | "html" | "svg" | "image";
  contentType: string;
  maxBytes: number;
};

const TYPES = new Map<string, PreviewType>([
  [".md", { kind: "markdown", contentType: "text/markdown; charset=utf-8", maxBytes: MAX_MARKDOWN_BYTES }],
  [".markdown", { kind: "markdown", contentType: "text/markdown; charset=utf-8", maxBytes: MAX_MARKDOWN_BYTES }],
  [".html", { kind: "html", contentType: "text/html; charset=utf-8", maxBytes: MAX_DOCUMENT_BYTES }],
  [".htm", { kind: "html", contentType: "text/html; charset=utf-8", maxBytes: MAX_DOCUMENT_BYTES }],
  [".svg", { kind: "svg", contentType: "image/svg+xml; charset=utf-8", maxBytes: MAX_DOCUMENT_BYTES }],
  [".png", { kind: "image", contentType: "image/png", maxBytes: MAX_PREVIEW_IMAGE_BYTES }],
  [".jpg", { kind: "image", contentType: "image/jpeg", maxBytes: MAX_PREVIEW_IMAGE_BYTES }],
  [".jpeg", { kind: "image", contentType: "image/jpeg", maxBytes: MAX_PREVIEW_IMAGE_BYTES }],
  [".gif", { kind: "image", contentType: "image/gif", maxBytes: MAX_PREVIEW_IMAGE_BYTES }],
  [".webp", { kind: "image", contentType: "image/webp", maxBytes: MAX_PREVIEW_IMAGE_BYTES }],
]);

export function previewRoots(value: string | undefined, home: string | undefined): string[] {
  const configured = value
    ?.split(delimiter)
    .map((root) => root.trim())
    .filter(Boolean);
  const roots = configured?.length ? configured : home ? [home] : [];
  return [...new Set(roots.map((root) => resolve(root)))];
}

export function previewType(path: string): PreviewType | null {
  return TYPES.get(extname(path).toLowerCase()) ?? null;
}

export function withinPreviewRoot(canonicalPath: string, canonicalRoots: readonly string[]): boolean {
  return canonicalRoots.some((root) => canonicalPath === root || canonicalPath.startsWith(`${root}/`));
}

export function wikiLinkCandidates(documentPath: string, target: string, canonicalRoots: readonly string[]): string[] {
  if (!documentPath.startsWith("/") || target.startsWith("/") || target.includes("\0")) return [];
  const parts = target.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return [];
  const extensions = /\.markdown?$/i.test(target) ? [""] : [".md", ".markdown"];
  const candidates: string[] = [];
  let directory = dirname(documentPath);
  while (withinPreviewRoot(directory, canonicalRoots)) {
    for (const extension of extensions) candidates.push(join(directory, `${target}${extension}`));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return candidates;
}
