import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const backend of process.env.SHELT_TEST_RUST ? ["bun", "rust"] : ["bun"]) {
  test(`${backend}: /api/update requires auth, stays read-only in source mode and is not cached`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "shelt-update-http-"));
    const port = backend === "rust" ? 34812 : 34811;
    const base = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env, SHELT_HOST: "127.0.0.1", SHELT_PORT: String(port), SHELT_STATE_DIR: directory,
      SHELT_UPLOAD_DIR: join(directory, "uploads"), SHELT_PUBLIC_HOSTS: `127.0.0.1:${port}`, SHELT_MODE: "shell",
    };
    const start = () => Bun.spawn(backend === "rust" ? ["target/debug/shelt", "foreground"] : ["bun", "src/server.ts"], { env, stdout: "pipe", stderr: "pipe" });
    let child = start();
    const ready = async () => {
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
        try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
        await Bun.sleep(50);
      }
      throw new Error("Server did not start");
    };
    const stop = async () => { child.kill(); await child.exited; };
    try {
      await ready();
      expect((await fetch(`${base}/api/update`)).status).toBe(401);
      expect((await fetch(`${base}/api/update`, { method: "POST", headers: { Origin: base } })).status).toBe(401);
      expect((await fetch(`${base}/api/update`, { method: "POST", headers: { Origin: "https://evil.example" } })).status).toBe(403);

      const setup = await fetch(`${base}/api/auth/setup`, {
        method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
        body: JSON.stringify({ password: "update-test-password" }),
      });
      expect(setup.status).toBe(200);
      const cookie = setup.headers.get("set-cookie")!.split(";")[0]!;

      expect((await fetch(`${base}/api/update`, { method: "POST", headers: { cookie, Origin: "https://evil.example" } })).status).toBe(403);
      const rejected = await fetch(`${base}/api/update`, { method: "POST", headers: { cookie, Origin: base } });
      expect(rejected.status).toBe(409);
      expect(typeof (await rejected.json()).error).toBe("string");

      const statusResponse = await fetch(`${base}/api/update`, { headers: { cookie } });
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.headers.get("cache-control")).toBe("no-store");
      const status = await statusResponse.json();
      expect(status.canInstall).toBe(false);
      expect(status.phase).toBe("idle");
      expect(typeof status.currentVersion).toBe("string");
      expect(typeof status.reason).toBe("string");
      if (backend === "bun") {
        expect(status.reason).toBe("updateSourceMode");
        expect(status.currentVersion).toBe(JSON.parse(await readFile(new URL("../dist/version.json", import.meta.url), "utf8")).version);
      }
    } finally {
      await stop();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
}
