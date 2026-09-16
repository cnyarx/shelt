import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute } from "node:path";
import { renderMarkdown } from "./markdown";

type Share = { hash: string; path: string; expiresAt: number };
const now = () => Math.floor(Date.now() / 1000);
export const validShareKey = (key: string) => /^[a-f0-9]{64}$/.test(key);
const hash = (key: string) => createHash("sha256").update(key).digest("hex");

export class ShareStore {
  private entries: Share[];
  constructor(private file: string) {
    try {
      this.entries = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.entries = [];
    }
    if (!Array.isArray(this.entries) || this.entries.some((entry) => !isAbsolute(entry.path) || !validShareKey(entry.hash) || !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt < 0)) {
      throw new Error("Invalid share records");
    }
  }
  private save(entries: Share[]): void {
    const parent = dirname(this.file);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
    const temporary = `${parent}/.shares-${randomBytes(16).toString("hex")}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, JSON.stringify(entries));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.file);
    } catch (error) {
      unlinkSync(temporary);
      throw error;
    }
    this.entries = entries;
  }
  create(path: string): { url: string; expiresAt: number } {
    const key = randomBytes(32).toString("hex");
    const expiresAt = now() + 7 * 24 * 60 * 60;
    this.save([...this.entries.filter((entry) => entry.path !== path && entry.expiresAt > now()), { hash: hash(key), path, expiresAt }]);
    return { url: `/share/${key}`, expiresAt };
  }
  revoke(path: string): void {
    this.save(this.entries.filter((entry) => entry.path !== path && entry.expiresAt > now()));
  }
  status(path: string): number | null {
    return this.entries.find((entry) => entry.path === path && entry.expiresAt > now())?.expiresAt ?? null;
  }
  resolve(key: string): Share | undefined {
    return validShareKey(key) ? this.entries.find((entry) => entry.hash === hash(key) && entry.expiresAt > now()) : undefined;
  }
}

export function imageSources(text: string): string[] {
  const key = "0".repeat(64);
  const { html } = renderMarkdown(text, `share:${key}`);
  return [...html.matchAll(/<img src="\/api\/share\/[a-f0-9]{64}\?source=([^"]*)"/g)]
    .map((match) => decodeURIComponent(match[1]!.replace(/&#39;/g, "'")));
}
