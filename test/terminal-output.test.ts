import { describe, expect, test } from "bun:test";
import { TerminalOutputPump } from "../src/terminal-output.ts";

describe("terminal output flow control", () => {
  test("waits for xterm parsing before writing and acknowledging the next chunk", () => {
    const writes: Array<{ data: string | Uint8Array; done: () => void }> = [];
    const acknowledgements: number[] = [];
    const pump = new TerminalOutputPump(
      (data, done) => writes.push({ data, done }),
      (bytes) => acknowledgements.push(bytes),
      () => { throw new Error("unexpected overflow"); },
    );

    pump.enqueue("first");
    pump.enqueue(new Uint8Array([1, 2, 3]));
    expect(writes.map(({ data }) => data)).toEqual(["first"]);
    expect(acknowledgements).toEqual([]);

    writes[0]!.done();
    expect(acknowledgements).toEqual([5]);
    expect(writes.map(({ data }) => data)).toEqual(["first", new Uint8Array([1, 2, 3])]);

    writes[1]!.done();
    expect(acknowledgements).toEqual([5, 3]);
  });

  test("counts the in-flight chunk against the bounded queue", () => {
    const writes: Array<() => void> = [];
    let overflows = 0;
    const pump = new TerminalOutputPump(
      (_data, done) => writes.push(done),
      () => undefined,
      () => { overflows += 1; },
      4,
    );

    pump.enqueue("a");
    pump.enqueue("1234");
    expect(overflows).toBe(1);
    expect(writes).toHaveLength(1);
    writes[0]!();
    expect(writes).toHaveLength(1);
  });

  test("does not acknowledge an in-flight chunk after close", () => {
    let done: (() => void) | undefined;
    let acknowledged = 0;
    const pump = new TerminalOutputPump(
      (_data, callback) => { done = callback; },
      (bytes) => { acknowledged += bytes; },
      () => undefined,
    );
    pump.enqueue("pending");
    pump.close();
    done!();
    expect(acknowledged).toBe(0);
  });
});
