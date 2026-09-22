import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const backend of process.env.SHELT_TEST_RUST ? ["bun", "rust"] : ["bun"]) {
  test(`${backend}: isolated HTML resources, origin restrictions, revocation and static shares`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "shelt-interactive-"));
    const document = join(directory, "页面 #1.html");
    const state = join(directory, "state");
    await mkdir(join(directory, "assets"));
    await mkdir(join(directory, ".private"));
    await writeFile(document, '<h1>Interactive</h1><script src="assets/app.js"></script>');
    await writeFile(join(directory, "assets/app.js"), 'window.executed = true;');
    await writeFile(join(directory, "assets/app.css"), 'h1 {color: blue}');
    await writeFile(join(directory, "assets/data.json"), '{"count":3}');
    await writeFile(join(directory, ".private/secret.json"), '{"private":true}');
    await writeFile(join(directory, "private.md"), 'not a web resource');
    await symlink(join(directory, ".private/secret.json"), join(directory, "alias.json"));
    await symlink("/etc/passwd", join(directory, "outside.txt"));
    await writeFile(join(directory, "picture.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>window.executed=true</script></svg>');
    const fakeHerdr = join(directory, "fake-herdr");
    await writeFile(fakeHerdr, '#!/bin/sh\nsleep 30\n');
    await chmod(fakeHerdr, 0o755);
    const port = backend === "rust" ? 34812 : 34811;
    const base = `http://127.0.0.1:${port}`;
    const child = Bun.spawn(backend === "rust" ? ["target/debug/shelt", "foreground"] : ["bun", "src/server.ts"], {
      env: { ...process.env, SHELT_HOST: "127.0.0.1", SHELT_PORT: String(port), SHELT_STATE_DIR: state, SHELT_UPLOAD_DIR: join(directory, "uploads"), SHELT_PREVIEW_ROOTS: directory, SHELT_PUBLIC_HOSTS: `127.0.0.1:${port}`, SHELT_ALLOWED_ORIGINS: "null", SHELT_MODE: "herdr", SHELT_HERDR_BIN: fakeHerdr }, stdout: "pipe", stderr: "pipe",
    });
    try {
      let started = false;
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
        try { if ((await fetch(`${base}/health`)).ok) { started = true; break; } } catch {}
        await Bun.sleep(50);
      }
      expect(started).toBe(true);
      const setup = await fetch(`${base}/api/auth/setup`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ password: "interactive-test-password" }) });
      expect(setup.status).toBe(200);
      const cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
      const create = (path = document, origin = base, credentials = cookie) => fetch(`${base}/api/preview-session`, { method: "POST", headers: { cookie: credentials, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
      expect((await create(document, base, "")).status).toBe(401);
      expect((await create(document, "null")).status).toBe(403);
      expect((await create(document, "https://evil.example")).status).toBe(403);
      expect((await create(join(directory, "picture.svg"))).status).toBe(404);
      expect((await create("relative.html")).ok).toBe(false);
      const response = await create();
      expect(response.status).toBe(200);
      const grant = await response.json();
      expect(grant.token).toMatch(/^[a-f0-9]{64}$/);
      const resourceBase = `${base}/api/preview-content/${grant.token}/`;
      const html = await fetch(`${base}${grant.url}`, { headers: { Origin: "null", "Sec-Fetch-Site": "cross-site" } });
      expect(html.status).toBe(200);
      expect(html.headers.get("content-security-policy")).toContain("sandbox allow-scripts;");
      expect(html.headers.get("content-security-policy")).not.toContain("allow-same-origin");
      expect(html.headers.get("content-security-policy")).toContain("https:");
      expect(html.headers.get("access-control-allow-origin")).toBe("*");
      expect(html.headers.get("access-control-allow-credentials")).toBeNull();
      expect(html.headers.get("cache-control")).toBe("no-store");
      expect(html.headers.get("referrer-policy")).toBe("no-referrer");
      expect(await html.text()).toContain("Interactive");
      for (const [path, type] of [["assets/app.js", "text/javascript"], ["assets/app.css", "text/css"], ["assets/data.json", "application/json"]]) {
        const asset = await fetch(resourceBase + path!, { headers: { Origin: "null" } });
        expect(asset.status).toBe(200);
        expect(asset.headers.get("content-type")).toContain(type!);
        expect(await asset.text()).toBe(await readFile(join(directory, path!), "utf8"));
      }
      const head = await fetch(resourceBase + "assets/app.js", { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      for (const path of [".private/secret.json", "alias.json", "outside.txt", "state/auth.json", "private.md", "assets/", "%2e%2e%2foutside.txt", "assets%5capp.js", "missing.js"]) {
        expect((await fetch(resourceBase + path)).status).toBe(404);
      }
      expect((await fetch(`${base}/api/preview-content/${"0".repeat(64)}/assets/app.js`)).status).toBe(404);
      expect((await fetch(resourceBase + "assets/app.js", { headers: { Host: "evil.example" } })).status).toBe(403);
      for (const headers of [new Headers({ cookie, Origin: "null" }), new Headers({ cookie, "Sec-Fetch-Site": "cross-site" })]) {
        expect((await fetch(`${base}/api/preview?path=${encodeURIComponent(document)}`, { headers })).status).toBe(403);
        expect((await fetch(`${base}/api/auth/logout`, { method: "POST", headers })).status).toBe(403);
      }
      const upgrade = (origin: string) => fetch(`${base}/ws`, { headers: { cookie, Origin: origin, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } });
      expect((await upgrade("null")).status).toBe(403);
      const socket = await new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, Origin: base } } as never);
        ws.addEventListener("open", () => resolve(ws));
        ws.addEventListener("error", () => reject(new Error("Authorized WebSocket failed")));
      });
      socket.close();
      for (const path of [document, join(directory, "picture.svg")]) {
        const staticResponse = await fetch(`${base}/api/preview?path=${encodeURIComponent(path)}&interactive=true`, { headers: { cookie } });
        expect(staticResponse.headers.get("content-security-policy")).toContain("sandbox allow-same-origin");
        expect(staticResponse.headers.get("content-security-policy")).not.toContain("allow-scripts");
      }
      const shareResponse = await fetch(`${base}/api/shares?path=${encodeURIComponent(document)}`, { method: "POST", headers: { cookie, Origin: base } });
      const share = await shareResponse.json();
      const shared = await fetch(`${base}/api/share/${share.url.slice(7)}?interactive=true`, { headers: { cookie } });
      expect(shared.status).toBe(200);
      expect(shared.headers.get("content-security-policy")).not.toContain("allow-scripts");
      expect((await fetch(`${base}/api/preview-session/${grant.token}`, { method: "DELETE", headers: { cookie, Origin: base } })).status).toBe(204);
      expect((await fetch(`${base}${grant.url}`)).status).toBe(404);
      const revokedOnLogout = await (await create()).json();
      expect((await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie, Origin: base } })).status).toBe(200);
      expect((await fetch(`${base}${revokedOnLogout.url}`)).status).toBe(404);
    } finally {
      child.kill();
      await child.exited;
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
}
