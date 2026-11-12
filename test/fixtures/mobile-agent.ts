#!/usr/bin/env bun
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "node:net";
const directory = process.env.SHELT_EDIT_FIXTURE!;
const args = process.argv.slice(2);
if (args[0] === "--session") args.splice(0, 2);
const remote = process.env.EDIT_REMOTE === "1";
await appendFile(join(directory, "mobile-calls.jsonl"), JSON.stringify({ args, remote, pid: process.pid }) + "\n");
if (args[0] === "remote-api-bridge") {
  const socket = connect(join(directory, "native.sock"));
  process.stdin.pipe(socket); socket.pipe(process.stdout);
  socket.on("error", () => process.exit(1)); socket.on("close", () => process.exit(0));
} else if (!args.length || args[0] === "--remote") {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const socket = connect(join(directory, "terminal.sock"));
  process.stdin.pipe(socket); socket.pipe(process.stdout);
  socket.on("error", () => process.exit(1)); socket.on("close", () => process.exit(0));
} else {
  const control = JSON.parse(await readFile(join(directory, "control.json"), "utf8"));
  console.log(JSON.stringify({ result: control }));
}
