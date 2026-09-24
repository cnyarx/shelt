import { expect, setSystemTime, test } from "bun:test";
import { checkSourceUpdate } from "../src/update-check.ts";

const build = { version: "v0.0.21", commit: "0123456789abcdef", dirty: false } as const;

test("source update check parses releases, compares versions and caches", async () => {
  const realFetch = globalThis.fetch;
  const realNow = Date.now();
  const calls: number[] = [];
  const state = { status: 200, body: { tag_name: "v0.0.22", draft: false, prerelease: false } };
  const failure = { message: "" };
  globalThis.fetch = (async () => {
    calls.push(state.status);
    if (failure.message) throw new Error(failure.message);
    return new Response(JSON.stringify(state.body), { status: state.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  setSystemTime(new Date("2026-09-24T00:00:00Z"));
  const advance = (minutes: number) => setSystemTime(new Date(Date.now() + minutes * 60_000));
  try {
    const status = await checkSourceUpdate(build);
    expect(status).toEqual({
      currentVersion: "v0.0.21", latestVersion: "v0.0.22", available: true,
      canInstall: false, reason: "updateSourceMode", phase: "idle", error: null,
    });
    expect(calls).toEqual([200]);
    await checkSourceUpdate(build);
    expect(calls.length).toBe(1);

    advance(61);
    state.body = { tag_name: "v0.0.20", draft: false, prerelease: false };
    expect((await checkSourceUpdate(build)).available).toBe(false);
    expect(calls.length).toBe(2);

    advance(61);
    const dev = await checkSourceUpdate({ version: "开发版", commit: "dev", dirty: true });
    expect(dev.available).toBe(true);
    expect(dev.currentVersion).toBe("开发版");
    expect(dev.latestVersion).toBe("v0.0.20");

    advance(61);
    state.status = 403;
    expect((await checkSourceUpdate(build)).error).toBe("updateRateLimited");

    advance(6);
    state.status = 200;
    state.body = { tag_name: "v0.0.23", draft: true, prerelease: false };
    expect((await checkSourceUpdate(build)).error).toBe("updateInvalidRelease");

    advance(6);
    state.body = { tag_name: "latest", draft: false, prerelease: false };
    expect((await checkSourceUpdate(build)).error).toBe("updateInvalidRelease");

    advance(6);
    state.body = { tag_name: "v0.0.23", draft: false, prerelease: true };
    expect((await checkSourceUpdate(build)).error).toBe("updateInvalidRelease");

    advance(6);
    state.status = 500;
    state.body = { tag_name: "v0.0.23", draft: false, prerelease: false };
    expect((await checkSourceUpdate(build)).error).toBe("updateCheckFailed");

    advance(6);
    state.status = 429;
    expect((await checkSourceUpdate(build)).error).toBe("updateRateLimited");

    advance(6);
    state.status = 200;
    failure.message = "socket hang up";
    expect((await checkSourceUpdate(build)).error).toBe("updateCheckFailed");

    advance(6);
    failure.message = "";
    state.body = { tag_name: "v0.0.30", draft: false, prerelease: false };
    calls.length = 0;
    const [first, second] = await Promise.all([checkSourceUpdate(build), checkSourceUpdate(build)]);
    expect(calls.length).toBe(1);
    expect(first).toEqual(second);
    expect(first.latestVersion).toBe("v0.0.30");
    expect(first.available).toBe(true);
  } finally {
    globalThis.fetch = realFetch;
    setSystemTime(realNow);
  }
});
