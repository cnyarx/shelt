import { describe, expect, test } from "bun:test";
import { loginShellFromPasswd, resolveLaunch } from "../src/launch.ts";

const bins = new Map([
  ["herdr", "/usr/bin/herdr"],
  ["bash", "/bin/bash"],
  ["zsh", "/bin/zsh"],
  ["sh", "/bin/sh"],
  ["/custom/fish", "/custom/fish"],
]);
const which = (command: string) => bins.get(command) ?? null;

describe("launch mode", () => {
  test("defaults to Herdr when it is installed", () => {
    expect(resolveLaunch({ env: {}, which, passwdShell: "/bin/bash" })).toEqual({
      mode: "herdr", command: "/usr/bin/herdr", args: [],
    });
  });


  test("falls back to the environment shell when Herdr is absent", () => {
    const noHerdr = (command: string) => command === "/bin/zsh" ? "/bin/zsh" : null;
    expect(resolveLaunch({ env: { SHELL: "/bin/zsh" }, which: noHerdr })).toEqual({
      mode: "shell", command: "/bin/zsh", args: [],
    });
  });

  test("uses passwd and then common shells as fallbacks", () => {
    const noHerdr = (command: string) => command === "/bin/bash" || command === "bash" ? "/bin/bash" : null;
    expect(resolveLaunch({ env: {}, which: noHerdr, passwdShell: "/bin/bash" }).command).toBe("/bin/bash");
    expect(resolveLaunch({ env: {}, which: noHerdr }).command).toBe("/bin/bash");
  });

  test("honours explicit shell mode and SHELT_SHELL", () => {
    expect(resolveLaunch({ env: { SHELT_MODE: "shell", SHELT_SHELL: "/custom/fish" }, which })).toEqual({
      mode: "shell", command: "/custom/fish", args: [],
    });
  });

  test("forced Herdr and invalid modes fail clearly", () => {
    expect(() => resolveLaunch({ env: { SHELT_MODE: "herdr" }, which: () => null })).toThrow(/not found/);
    expect(() => resolveLaunch({ env: { SHELT_MODE: "other" }, which })).toThrow(/Invalid SHELT_MODE/);
  });
});

describe("passwd shell", () => {
  test("extracts the current uid login shell", () => {
    expect(loginShellFromPasswd("root:x:0:0:root:/root:/bin/bash\nuser:x:1000:1000::/home/user:/bin/zsh\n", 1000)).toBe("/bin/zsh");
  });
});
