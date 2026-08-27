export const MAX_OSC52_BYTES = 1024 * 1024;

export type Osc52Clipboard =
  | { ok: true; selection: string; text: string }
  | { ok: false; error: "invalid-format" | "invalid-base64" | "invalid-utf8" | "too-large" };

export function decodeOsc52(data: string, maxBytes = MAX_OSC52_BYTES): Osc52Clipboard {
  const separator = data.indexOf(";");
  if (separator < 0) return { ok: false, error: "invalid-format" };

  const selection = data.slice(0, separator);
  const encoded = data.slice(separator + 1);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    return { ok: false, error: "invalid-base64" };
  }

  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const byteLength = encoded.length === 0 ? 0 : encoded.length / 4 * 3 - padding;
  if (byteLength > maxBytes) return { ok: false, error: "too-large" };

  let bytes: Uint8Array;
  try {
    const binary = atob(encoded);
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return { ok: false, error: "invalid-base64" };
  }

  try {
    return { ok: true, selection, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, error: "invalid-utf8" };
  }
}
