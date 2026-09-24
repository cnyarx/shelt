import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageSources } from "../src/shares";

for (const backend of process.env.SHELT_TEST_RUST ? ["bun", "rust"] : ["bun"]) {
  test(`${backend}: anonymous document scope, images, rotation, restart, revocation and expiry`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "shelt-share-http-"));
    const document = join(directory, "doc.md");
    await writeFile(document, "# Shared\n![pic](pic.svg)\n");
    await writeFile(join(directory, "pic.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(join(directory, "secret.md"), "private");
    await symlink("/etc/passwd", join(directory, "escape.md"));
    const port = backend === "rust" ? 34792 : 34791;
    const base = `http://127.0.0.1:${port}`;
    const env = { ...process.env, SHELT_HOST: "127.0.0.1", SHELT_PORT: String(port), SHELT_STATE_DIR: directory, SHELT_UPLOAD_DIR: join(directory, "uploads"), SHELT_PREVIEW_ROOTS: directory, SHELT_PUBLIC_HOSTS: `127.0.0.1:${port}`, SHELT_MODE: "shell" };
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
      const icon = await fetch(`${base}/favicon.svg`);
      expect(icon.status).toBe(200);
      expect(icon.headers.get("content-type")).toBe("image/svg+xml");
      expect(icon.headers.get("cache-control")).toBe("no-cache");
      expect(await icon.text()).toBe(await readFile(new URL("../public/favicon.svg", import.meta.url), "utf8"));
      const iconHead = await fetch(`${base}/favicon.svg`, { method: "HEAD" });
      expect(iconHead.status).toBe(200);
      expect(await iconHead.text()).toBe("");
      const setup = await fetch(`${base}/api/auth/setup`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ password: "share-test-password" }) });
      expect(setup.status).toBe(200);
      let cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
      const manage = (method: string, path = document, origin = base) => fetch(`${base}/api/shares?path=${encodeURIComponent(path)}`, { method, headers: { cookie, Origin: origin } });
      expect((await fetch(`${base}/api/shares?path=${encodeURIComponent(document)}`, { method: "POST", headers: { Origin: base } })).status).toBe(401);
      expect((await manage("POST", document, "https://evil.example")).status).toBe(403);
      expect((await manage("POST", join(directory, "escape.md"))).status).toBe(404);
      const htmlPath = join(directory, "page.html");
      await writeFile(htmlPath, '<h1>Static share</h1><script>window.executed=true</script>');
      const htmlShare = await (await manage("POST", htmlPath)).json();
      const htmlResponse = await fetch(`${base}/api/share/${htmlShare.url.slice(7)}`);
      expect(htmlResponse.status).toBe(200);
      expect(htmlResponse.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
      expect(htmlResponse.headers.get("content-security-policy")).not.toContain("allow-same-origin");
      await manage("DELETE", htmlPath);
      const first = await (await manage("POST")).json();
      let key = first.url.slice(7);
      const content = () => fetch(`${base}/api/share/${key}`);
      expect((await fetch(`${base}${first.url}`)).status).toBe(200);
      const initial = await content();
      expect(initial.headers.get("cache-control")).toBe("no-store");
      expect(initial.headers.get("referrer-policy")).toBe("no-referrer");
      expect(await initial.text()).toContain("# Shared");
      const head = await fetch(`${base}/api/share/${key}`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect((await fetch(`${base}/api/share/${key}?source=pic.svg`)).status).toBe(200);
      expect((await fetch(`${base}/api/share/${key}?source=secret.md`)).status).toBe(404);
      expect((await fetch(`${base}/api/share/${key}?source=../secret.png`)).status).toBe(404);
      expect((await fetch(`${base}/api/preview?path=${encodeURIComponent(document)}&key=${key}`)).status).toBe(401);
      expect((await fetch(`${base}/ws?key=${key}`, { headers: { Origin: base } })).status).not.toBe(101);
      for (const hidden of ["```md\n![pic](pic.svg)\n```", "`![pic](pic.svg)`", "$$\n![pic](pic.svg)\n$$", "> ```\n> ![pic](pic.svg)\n> ```", "```\n```js\n![pic](pic.svg)\n```", "$a\n![pic](pic.svg)\nb$", "![pic](pi`ignored`c.svg)"]) {
        await writeFile(document, hidden);
        expect((await fetch(`${base}/api/share/${key}?source=pic.svg`)).status).toBe(404);
      }
      const boundaries = [
        "![x\n\n](pic.svg)", "# ![x\n](pic.svg)", "```\n> ```\n![x](pic.svg)\n```", "> ```\n```\n![x](pic.svg)\n```",
        "![x\n---\n](pic.svg)", "- ![x\n- ](pic.svg)", "a | b\n--- | ---\n![x | ](pic.svg)",
        "> ![pic](pic.svg)", "# ![pic](pic.svg)", "- ![pic](pic.svg)", "- a\n  ![pic](pic.svg)",
        "a | b\n--- | ---\n![pic](pic.svg) | yes", "$$a\nb$$\n![pic](pic.svg)", "``![pic](pic.svg)``",
      ];
      for (const markdown of boundaries) {
        await writeFile(document, markdown);
        const expected = imageSources(markdown).includes("pic.svg") ? 200 : 404;
        expect((await fetch(`${base}/api/share/${key}?source=pic.svg`)).status).toBe(expected);
      }
      await writeFile(document, "# Latest\n");
      expect(await (await content()).text()).toBe("# Latest\n");
      expect((await fetch(`${base}/api/share/${key}?source=pic.svg`)).status).toBe(404);
      const second = await (await manage("POST")).json();
      expect((await content()).status).toBe(404);
      expect((await fetch(`${base}/api/share/${key}`, { method: "HEAD" })).status).toBe(404);
      key = second.url.slice(7);
      expect(await readFile(join(directory, "shares.json"), "utf8")).not.toContain(key);
      await stop(); child = start(); await ready();
      expect((await content()).status).toBe(200);
      const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ password: "share-test-password" }) });
      cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      expect((await manage("DELETE")).status).toBe(200);
      expect((await content()).status).toBe(404);
      key = (await (await manage("POST")).json()).url.slice(7);
      await stop();
      const entries = JSON.parse(await readFile(join(directory, "shares.json"), "utf8"));
      entries[0].expiresAt = 1;
      await writeFile(join(directory, "shares.json"), JSON.stringify(entries));
      child = start(); await ready();
      expect((await content()).status).toBe(404);
    } finally {
      await stop();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
}
