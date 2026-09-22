import { randomBytes } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { AuthStore, parseCookie, SESSION_COOKIE } from "./auth.ts";
import { MAX_DOCUMENT_BYTES, MAX_PREVIEW_IMAGE_BYTES, previewType, withinPreviewRoot } from "./preview-security.ts";

export const INTERACTIVE_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' http: https: blob:; style-src 'unsafe-inline' http: https:; img-src http: https: data: blob:; font-src http: https: data:; media-src http: https: data: blob:; connect-src http: https: ws: wss:; worker-src blob:; frame-src 'none'; object-src 'none'; sandbox allow-scripts; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

const ASSET_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".ico": "image/x-icon", ".avif": "image/avif", ".bmp": "image/bmp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".webm": "video/webm",
};

type Grant = { directory: string; session: string; expires: number };

export class InteractivePreviews {
  private readonly grants = new Map<string, Grant>();

  constructor(private auth: AuthStore, private roots: readonly string[], private stateDirectory: string) {}

  async create(path: string, cookie: string | null): Promise<{ token: string; url: string } | null> {
    const session = parseCookie(cookie, SESSION_COOKIE);
    if (!session || !this.auth.authenticated(cookie) || !isAbsolute(path)) return null;
    try {
      const canonical = await realpath(path);
      if (previewType(canonical)?.kind !== "html" || !withinPreviewRoot(canonical, this.roots)) return null;
      const directory = dirname(canonical);
      const grant = { directory, session, expires: Date.now() + 24 * 60 * 60 * 1000 };
      if (!(await this.readFile(grant, basename(canonical)))) return null;
      for (const [key, entry] of this.grants) if (!this.valid(entry)) this.grants.delete(key);
      const token = randomBytes(32).toString("hex");
      this.grants.set(token, grant);
      return { token, url: `/api/preview-content/${token}/${encodeURIComponent(basename(canonical))}` };
    } catch { return null; }
  }

  revoke(token: string, cookie: string | null): boolean {
    if (this.grants.get(token)?.session !== parseCookie(cookie, SESSION_COOKIE)) return false;
    return this.grants.delete(token);
  }

  async read(token: string, resource: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string } | null> {
    const grant = this.grants.get(token);
    if (!grant || !this.valid(grant)) { this.grants.delete(token); return null; }
    return this.readFile(grant, resource);
  }

  private valid(grant: Grant): boolean {
    return grant.expires > Date.now() && this.auth.authenticated(`${SESSION_COOKIE}=${grant.session}`);
  }

  private async readFile(grant: Grant, resource: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string } | null> {
    if (!resource || isAbsolute(resource) || resource.includes("\\") || resource.includes("\0") || resource.split("/").some(part => part.startsWith("."))) return null;
    try {
      const canonical = await realpath(join(grant.directory, resource));
      const privateDirectory = await realpath(this.stateDirectory).catch(() => resolve(this.stateDirectory));
      if (!withinPreviewRoot(canonical, [grant.directory]) || !withinPreviewRoot(canonical, this.roots) || withinPreviewRoot(canonical, [privateDirectory]) || relative(grant.directory, canonical).split("/").some(part => part.startsWith("."))) return null;
      const kind = previewType(canonical);
      const contentType = kind?.contentType ?? ASSET_TYPES[extname(canonical).toLowerCase()];
      if (!contentType || kind?.kind === "markdown") return null;
      const maxBytes = kind?.maxBytes ?? (contentType.startsWith("text/") || contentType === "application/json" ? MAX_DOCUMENT_BYTES : MAX_PREVIEW_IMAGE_BYTES);
      const file = await open(canonical, "r");
      try {
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.size > maxBytes) return null;
        const bytes = Buffer.alloc(maxBytes + 1);
        let length = 0;
        while (length < bytes.length) {
          const result = await file.read(bytes, length, bytes.length - length, null);
          if (!result.bytesRead) break;
          length += result.bytesRead;
        }
        return length <= maxBytes ? { bytes: bytes.subarray(0, length), contentType } : null;
      } finally { await file.close(); }
    } catch { return null; }
  }
}
