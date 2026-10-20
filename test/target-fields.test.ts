import { expect, test } from "bun:test";
import { fillRemoteHost } from "../src/target-fields.ts";

test("fills an empty SSH target with the client IP", () => {
  expect(fillRemoteHost("", "10.1.2.3")).toBe("10.1.2.3");
  expect(fillRemoteHost("   ", "10.1.2.3")).toBe("10.1.2.3");
});

test("keeps the user prefix and replaces the host with the client IP", () => {
  expect(fillRemoteHost("admin@", "10.1.2.3")).toBe("admin@10.1.2.3");
  expect(fillRemoteHost("admin@old.host", "10.1.2.3")).toBe("admin@10.1.2.3");
});

test("replaces a bare host with the client IP", () => {
  expect(fillRemoteHost("old.host", "10.1.2.3")).toBe("10.1.2.3");
});

test("keeps the value when it already targets the client IP", () => {
  expect(fillRemoteHost("10.1.2.3", "10.1.2.3")).toBe("10.1.2.3");
  expect(fillRemoteHost("admin@10.1.2.3", "10.1.2.3")).toBe("admin@10.1.2.3");
});
