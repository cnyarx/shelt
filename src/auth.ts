import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export const SESSION_COOKIE = "shelt_session";
export const REMEMBER_SECONDS = 30 * 24 * 60 * 60;
export const MAX_AUTH_BODY_BYTES = 8 * 1024;
const SESSION_BYTES = 32;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 256;
const SESSION_MAX_AGE_MS = REMEMBER_SECONDS * 1000;
const VOLATILE_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

export type AuthFile = {
  version: 1;
  passwordHash: string;
  createdAt: string;
};

type Session = { expiresAt: number };

export function passwordError(password: unknown): string | null {
  if (typeof password !== "string") return "Password is required";
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  return null;
}

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim() || null;
  }
  return null;
}

export function sessionCookie(token: string, remember: boolean, secure: boolean): string {
  const attributes = [`${SESSION_COOKIE}=${token}`, "HttpOnly", "SameSite=Strict", "Path=/"];
  if (remember) attributes.push(`Max-Age=${REMEMBER_SECONDS}`);
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function expiredSessionCookie(secure: boolean): string {
  return sessionCookie("", false, secure) + "; Max-Age=0";
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SESSION_BYTES));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export class AuthStore {
  readonly filePath: string;
  readonly secureCookie: boolean;
  private passwordHash: string | null = null;
  private initialized = false;
  private readonly sessions = new Map<string, Session>();

  constructor(filePath: string, secureCookie: boolean) {
    this.filePath = filePath;
    this.secureCookie = secureCookie;
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<AuthFile>;
      if (parsed.version !== 1 || typeof parsed.passwordHash !== "string" || !parsed.passwordHash.startsWith("$argon2id$") || typeof parsed.createdAt !== "string") {
        throw new Error(`Invalid authentication file: ${this.filePath}`);
      }
      this.passwordHash = parsed.passwordHash;
      this.initialized = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.passwordHash = null;
        this.initialized = true;
        return;
      }
      throw error;
    }
  }

  setupRequired(): boolean {
    if (!this.initialized) throw new Error("AuthStore.load() has not completed");
    return this.passwordHash === null;
  }

  authenticated(cookieHeader: string | null, now = Date.now()): boolean {
    const token = parseCookie(cookieHeader, SESSION_COOKIE);
    if (!token) return false;
    const session = this.sessions.get(token);
    if (!session) return false;
    if (session.expiresAt <= now) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  createSession(remember: boolean, now = Date.now()): string {
    this.purgeExpired(now);
    const token = randomToken();
    this.sessions.set(token, { expiresAt: now + (remember ? SESSION_MAX_AGE_MS : VOLATILE_SESSION_AGE_MS) });
    return token;
  }

  revoke(cookieHeader: string | null): void {
    const token = parseCookie(cookieHeader, SESSION_COOKIE);
    if (token) this.sessions.delete(token);
  }

  async setup(password: string): Promise<boolean> {
    if (!this.setupRequired()) return false;
    const passwordHash = await Bun.password.hash(password, {
      algorithm: "argon2id",
      memoryCost: 19456,
      timeCost: 2,
    });
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.filePath), 0o700);
    const file = await open(this.filePath, "wx", 0o600);
    try {
      const data: AuthFile = { version: 1, passwordHash, createdAt: new Date().toISOString() };
      await file.writeFile(JSON.stringify(data) + "\n");
    } finally {
      await file.close();
    }
    await chmod(this.filePath, 0o600);
    this.passwordHash = passwordHash;
    return true;
  }

  async verify(password: string): Promise<boolean> {
    if (!this.passwordHash) return false;
    return Bun.password.verify(password, this.passwordHash);
  }

  private purgeExpired(now: number): void {
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}
