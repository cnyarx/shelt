import { describe, expect, test } from "bun:test";
import {
  herdrPaneCwd,
  herdrPaneEnvironment,
  loginShellFromPasswd,
  resolveLaunch,
} from "../src/launch.ts";

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

describe("Herdr focused pane", () => {
  test("removes caller pane identity from the query environment", () => {
    expect(herdrPaneEnvironment({
      HOME: "/home/user",
      HERDR_PANE_ID: "wA:p1",
      HERDR_WORKSPACE_ID: "wA",
      HERDR_TAB_ID: "wA:t1",
      HERDR_CWD: "/tmp",
    })).toEqual({ HOME: "/home/user" });
  });

  test("prefers foreground_cwd and validates absolute paths", () => {
    expect(herdrPaneCwd(JSON.stringify({
      result: { pane: { cwd: "/home/user", foreground_cwd: "/home/user/project" } },
    }))).toBe("/home/user/project");
    expect(herdrPaneCwd(JSON.stringify({
      result: { pane: { cwd: "/home/user", foreground_cwd: null } },
    }))).toBe("/home/user");
    expect(herdrPaneCwd('{"result":{"pane":{"cwd":"relative"}}}')).toBeNull();
    expect(herdrPaneCwd("not json")).toBeNull();
  });
});

describe("passwd shell", () => {
  test("extracts the current uid login shell", () => {
    expect(loginShellFromPasswd("root:x:0:0:root:/root:/bin/bash\nuser:x:1000:1000::/home/user:/bin/zsh\n", 1000)).toBe("/bin/zsh");
  });
});
