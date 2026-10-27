import type { EditAgent } from "./preview-edits.ts";

export type PreviewSource = Pick<EditAgent, "targetId" | "paneId" | "session">;

export function previewSource(value: unknown): PreviewSource | null {
  if (!value || typeof value !== "object") return null;
  const source = value as PreviewSource;
  return typeof source.targetId === "string" && /^(?:local|[a-f0-9]{8})$/.test(source.targetId)
    && typeof source.paneId === "string" && /^[A-Za-z0-9:._-]{1,128}$/.test(source.paneId)
    && typeof source.session === "string" && /^[a-f0-9]{64}$/.test(source.session)
    ? { targetId: source.targetId, paneId: source.paneId, session: source.session } : null;
}

export function sourceFromUrl(url: URL): PreviewSource | null {
  try { return previewSource(JSON.parse(url.searchParams.get("source") || "null")); }
  catch { return null; }
}

export function sameAgent(agent: PreviewSource, other: PreviewSource): boolean {
  return agent.targetId === other.targetId && agent.paneId === other.paneId && agent.session === other.session;
}

export function terminalPreviewUrl(value: string, origin: string): string | null {
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || !["/preview", "/api/resolve-terminal-path"].includes(url.pathname) || !url.searchParams.get("path")) return null;
    return `/api/preview-edits/open?path=${encodeURIComponent(url.searchParams.get("path")!)}${url.hash}`;
  } catch { return null; }
}
