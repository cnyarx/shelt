import { chmod, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const stateDir = process.env.SHELT_STATE_DIR || join(process.env.XDG_STATE_HOME || join(process.env.HOME || ".", ".local/state"), "shelt");
const pidFile = join(stateDir, "shelt.pid");
const logFile = join(stateDir, "shelt.log");
const host = process.env.SHELT_HOST || "127.0.0.1";
const port = process.env.SHELT_PORT || "8790";
const url = `http://${host}:${port}`;

async function readPid(): Promise<number | null> {
  try {
    const pid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runningPid(): Promise<number | null> {
  const pid = await readPid();
  if (pid && alive(pid)) return pid;
  if (pid) await rm(pidFile, { force: true });
  return null;
}

async function start(): Promise<void> {
  const existing = await runningPid();
  if (existing) {
    console.log(`Shelt is already running (PID ${existing})`);
    console.log(url);
    return;
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const log = await open(logFile, "a", 0o600);
  const child = Bun.spawn([process.execPath, "foreground"], {
    cwd: process.env.HOME || process.cwd(),
    env: { ...process.env, SHELT_DAEMON_CHILD: "1", SHELT_STATE_DIR: stateDir },
    stdin: "ignore",
    stdout: log.fd,
    stderr: log.fd,
    detached: true,
  });
  child.unref();
  await log.close();
  await writeFile(pidFile, `${child.pid}\n`, { mode: 0o600 });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) {
        console.log(`Shelt started (PID ${child.pid})`);
        console.log(url);
        return;
      }
    } catch {}
    if (!alive(child.pid)) break;
    await Bun.sleep(100);
  }
  await rm(pidFile, { force: true });
  throw new Error(`Shelt failed to start. See ${logFile}`);
}

async function stop(): Promise<void> {
  const pid = await runningPid();
  if (!pid) {
    console.log("Shelt is not running");
    return;
  }
  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 50 && alive(pid); attempt += 1) await Bun.sleep(100);
  await rm(pidFile, { force: true });
  console.log("Shelt stopped");
}

async function foreground(): Promise<void> {
  await import("./server.ts");
}

const command = process.argv[2] || "start";
switch (command) {
  case "start":
    await start();
    break;
  case "foreground":
    await foreground();
    break;
  case "stop":
    await stop();
    break;
  case "restart":
    await stop();
    await start();
    break;
  case "status": {
    const pid = await runningPid();
    if (!pid) {
      console.log("Shelt is not running");
      process.exitCode = 1;
    } else {
      console.log(`Shelt is running (PID ${pid})`);
      console.log(url);
    }
    break;
  }
  case "url":
    console.log(url);
    break;
  case "logs":
    console.log(logFile);
    break;
  default:
    console.error("usage: shelt [start|stop|restart|status|url|logs|foreground]");
    process.exitCode = 2;
}
