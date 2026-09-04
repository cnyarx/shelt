export type LaunchMode = "auto" | "herdr" | "shell";
export type LaunchTarget = { mode: "herdr" | "shell"; command: string; args: string[] };

const HERDR_PANE_ENVIRONMENT = [
  "HERDR_PANE_ID",
  "HERDR_WORKSPACE_ID",
  "HERDR_TAB_ID",
  "HERDR_CWD",
] as const;

type ResolveOptions = {
  env: Record<string, string | undefined>;
  which: (command: string) => string | null;
  passwdShell?: string | null;
};

export function resolveLaunch({ env, which, passwdShell }: ResolveOptions): LaunchTarget {
  const mode = parseMode(env.SHELT_MODE);
  const herdr = resolveCommand(env.SHELT_HERDR_BIN || "herdr", which);

  if (mode === "herdr") {
    if (!herdr) throw new Error(`SHELT_MODE=herdr but ${env.SHELT_HERDR_BIN || "herdr"} was not found`);
    return { mode: "herdr", command: herdr, args: [] };
  }
  if (mode === "auto" && herdr) return { mode: "herdr", command: herdr, args: [] };

  const shell = resolveShell(env.SHELT_SHELL, env.SHELL, passwdShell, which);
  if (!shell) throw new Error("No usable shell found. Set SHELT_SHELL to an executable shell path.");
  return { mode: "shell", command: shell, args: [] };
}

function parseMode(value: string | undefined): LaunchMode {
  const mode = (value || "auto").toLowerCase();
  if (mode === "auto" || mode === "herdr" || mode === "shell") return mode;
  throw new Error(`Invalid SHELT_MODE=${value}; expected auto, herdr, or shell`);
}

function resolveShell(
  configured: string | undefined,
  environmentShell: string | undefined,
  passwdShell: string | null | undefined,
  which: (command: string) => string | null,
): string | null {
  for (const candidate of [configured, environmentShell, passwdShell, "bash", "zsh", "sh"]) {
    if (!candidate) continue;
    const resolved = resolveCommand(candidate, which);
    if (resolved) return resolved;
  }
  return null;
}

function resolveCommand(command: string, which: (command: string) => string | null): string | null {
  if (command.includes("\0") || command.includes("\n") || command.includes("\r")) return null;
  return which(command);
}

export function herdrPaneEnvironment(
  environment: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const result = { ...environment };
  for (const key of HERDR_PANE_ENVIRONMENT) delete result[key];
  return result;
}

export function herdrPaneCwd(output: string): string | null {
  let response: unknown;
  try {
    response = JSON.parse(output);
  } catch {
    return null;
  }
  if (!response || typeof response !== "object" || !("result" in response)) return null;
  const result = response.result;
  if (!result || typeof result !== "object" || !("pane" in result)) return null;
  const pane = result.pane;
  if (!pane || typeof pane !== "object") return null;
  const foregroundCwd = "foreground_cwd" in pane ? pane.foreground_cwd : null;
  const cwd = "cwd" in pane ? pane.cwd : null;
  const selected = typeof foregroundCwd === "string" && foregroundCwd ? foregroundCwd : cwd;
  return typeof selected === "string" && selected.startsWith("/") ? selected : null;
}

export function loginShellFromPasswd(passwd: string, uid: number): string | null {
  for (const line of passwd.split("\n")) {
    const fields = line.split(":");
    if (fields.length >= 7 && Number(fields[2]) === uid) return fields[6] || null;
  }
  return null;
}
