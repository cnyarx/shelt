import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export type HerdrTarget = { id: string; name: string; remote: string; session: string | null };
export const LOCAL_TARGET_ID = "local";

type TargetsFile = { active: string; targets: HerdrTarget[] };

export function targetError(name: unknown, remote: unknown, session: unknown): string | null {
  if (typeof name !== "string") return "名称需要 1-40 个字符";
  const trimmed = name.trim();
  if ([...trimmed].length === 0 || [...trimmed].length > 40 || [...trimmed].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return "名称需要 1-40 个字符";
  if (typeof remote !== "string" || remote.startsWith("-") || !/^([A-Za-z0-9._%+-]{1,64}@)?[A-Za-z0-9._:-]{1,253}$/.test(remote)) return "SSH 目标格式无效";
  if (session !== null && session !== undefined && (typeof session !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(session))) return "会话名格式无效";
  return null;
}

function validEntry(entry: unknown): entry is HerdrTarget {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as HerdrTarget;
  return typeof candidate.id === "string" && /^[a-f0-9]{8}$/.test(candidate.id) && targetError(candidate.name, candidate.remote, candidate.session ?? null) === null;
}

export class TargetStore {
  private state: TargetsFile;
  constructor(private file: string) {
    try {
      this.state = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = { active: LOCAL_TARGET_ID, targets: [] };
    }
    if (typeof this.state?.active !== "string" || !Array.isArray(this.state.targets) || this.state.targets.some((entry) => !validEntry(entry))) {
      throw new Error("Invalid Herdr target records");
    }
    if (this.state.active !== LOCAL_TARGET_ID && !this.state.targets.some((entry) => entry.id === this.state.active)) {
      this.state.active = LOCAL_TARGET_ID;
    }
  }
  private save(): void {
    const parent = dirname(this.file);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
    const temporary = `${parent}/.targets-${randomBytes(16).toString("hex")}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, JSON.stringify(this.state));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.file);
    } catch (error) {
      unlinkSync(temporary);
      throw error;
    }
    this.state = { active: this.state.active, targets: this.state.targets };
  }
  list(): { active: string; targets: HerdrTarget[] } {
    return { active: this.state.active, targets: this.state.targets.map((entry) => ({ ...entry })) };
  }
  create(name: string, remote: string, session: string | null): HerdrTarget {
    const entry: HerdrTarget = { id: randomBytes(4).toString("hex"), name: name.trim(), remote, session };
    this.state.targets.push(entry);
    this.save();
    return { ...entry };
  }
  update(id: string, name: string, remote: string, session: string | null): HerdrTarget | null {
    const entry = this.state.targets.find((candidate) => candidate.id === id);
    if (!entry) return null;
    entry.name = name.trim();
    entry.remote = remote;
    entry.session = session;
    this.save();
    return { ...entry };
  }
  remove(id: string): boolean {
    const before = this.state.targets.length;
    this.state.targets = this.state.targets.filter((entry) => entry.id !== id);
    if (this.state.targets.length === before) return false;
    if (this.state.active === id) this.state.active = LOCAL_TARGET_ID;
    this.save();
    return true;
  }
  active(): string {
    return this.state.active;
  }
  activate(id: string): boolean {
    if (id !== LOCAL_TARGET_ID && !this.state.targets.some((entry) => entry.id === id)) return false;
    this.state.active = id;
    this.save();
    return true;
  }
  activeArgs(): string[] {
    const entry = this.state.targets.find((candidate) => candidate.id === this.state.active);
    if (!entry) return [];
    return entry.session ? ["--remote", entry.remote, "--session", entry.session] : ["--remote", entry.remote];
  }
}
