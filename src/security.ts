import { basename, extname } from "node:path";

export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const IMAGE_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/bmp", "bmp"],
]);

export function allowedHost(host: string, configured: readonly string[]): boolean {
  return configured.includes(host.toLowerCase());
}

export function allowedOrigin(origin: string | null, host: string, configured: readonly string[]): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.host.toLowerCase() === host.toLowerCase() || configured.includes(parsed.origin);
  } catch {
    return false;
  }
}

export function imageExtension(contentType: string): string | null {
  return IMAGE_TYPES.get(contentType.toLowerCase()) ?? null;
}

export function hasImageSignature(bytes: Uint8Array, extension: string): boolean {
  const starts = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
  switch (extension) {
    case "png":
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "jpg":
      return starts(0xff, 0xd8, 0xff);
    case "gif":
      return new TextDecoder().decode(bytes.subarray(0, 6)) === "GIF87a" || new TextDecoder().decode(bytes.subarray(0, 6)) === "GIF89a";
    case "webp":
      return new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP";
    case "bmp":
      return starts(0x42, 0x4d);
    default:
      return false;
  }
}

export function uploadFileNameHeader(name: string): string {
  return encodeURIComponent(name);
}

export function safeUploadStem(name: string | null): string {
  const raw = basename(name || "clipboard").slice(0, 80);
  const withoutExt = raw.slice(0, raw.length - extname(raw).length);
  const safe = withoutExt.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "clipboard";
}

export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}
