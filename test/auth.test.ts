import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthStore,
  REMEMBER_SECONDS,
  SESSION_COOKIE,
  expiredSessionCookie,
  parseCookie,
  passwordError,
  sessionCookie,
} from "../src/auth.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryAuth(): Promise<{ store: AuthStore; directory: string; file: string }> {
  const directory = await mkdtemp(join(tmpdir(), "shelt-auth-"));
  temporaryDirectories.push(directory);
  const file = join(directory, "state", "auth.json");
  const store = new AuthStore(file, false);
  await store.load();
  return { store, directory, file };
}

describe("password authentication", () => {
  test("validates Unicode passwords by character count", () => {
    expect(passwordError("1234567")).toContain("at least 8");
    expect(passwordError("密码密码密码密码")).toBeNull();
    expect(passwordError("x".repeat(257))).toContain("at most 256");
  });

  test("persists only an Argon2id hash with private permissions", async () => {
    const { store, file } = await temporaryAuth();
    expect(store.setupRequired()).toBe(true);
    expect(await store.setup("correct horse battery staple")).toBe(true);
    expect(store.setupRequired()).toBe(false);
    expect(await store.verify("correct horse battery staple")).toBe(true);
    expect(await store.verify("wrong password")).toBe(false);
    expect(await store.setup("replacement password")).toBe(false);

    const data = await Bun.file(file).json() as { passwordHash: string };
    expect(data.passwordHash).toStartWith("$argon2id$");
    expect(JSON.stringify(data)).not.toContain("correct horse battery staple");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(file, ".."))).mode & 0o777).toBe(0o700);
  });

  test("loads the persisted hash after restart without preserving sessions", async () => {
    const { store, file } = await temporaryAuth();
    await store.setup("restart-password");
    const token = store.createSession(true);
    expect(store.authenticated(`${SESSION_COOKIE}=${token}`)).toBe(true);

    const restarted = new AuthStore(file, false);
    await restarted.load();
    expect(restarted.setupRequired()).toBe(false);
    expect(await restarted.verify("restart-password")).toBe(true);
    expect(restarted.authenticated(`${SESSION_COOKIE}=${token}`)).toBe(false);
  });
});

describe("browser sessions", () => {
  test("uses an opaque session and supports logout", async () => {
    const { store } = await temporaryAuth();
    const token = store.createSession(false);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(store.authenticated(`${SESSION_COOKIE}=${token}`)).toBe(true);
    store.revoke(`other=1; ${SESSION_COOKIE}=${token}`);
    expect(store.authenticated(`${SESSION_COOKIE}=${token}`)).toBe(false);
  });

  test("marks remembered sessions persistent without exposing them to scripts", () => {
    const remembered = sessionCookie("abc", true, true);
    expect(remembered).toContain("HttpOnly");
    expect(remembered).toContain("SameSite=Strict");
    expect(remembered).toContain(`Max-Age=${REMEMBER_SECONDS}`);
    expect(remembered).toContain("Secure");
    expect(sessionCookie("abc", false, false)).not.toContain("Max-Age");
    expect(expiredSessionCookie(false)).toContain("Max-Age=0");
    expect(parseCookie("prefix=1; shelt_session=abc", SESSION_COOKIE)).toBe("abc");
    expect(parseCookie("not_shelt_session=abc", SESSION_COOKIE)).toBeNull();
  });
});
