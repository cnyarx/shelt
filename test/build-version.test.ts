import { expect, test } from "bun:test";
import { buildVersion } from "../src/build-version.ts";

const commit = "464f2c55943c22874035077edd15c24cb323c077";

test("development builds show commit and uncommitted changes", () => {
  expect(buildVersion(commit, true)).toEqual({ version: "开发版", commit: "464f2c5", dirty: true });
  expect(buildVersion(commit, false)).toEqual({ version: "开发版", commit: "464f2c5", dirty: false });
});

test("release builds embed the version chosen before building", () => {
  expect(buildVersion(commit, false, "v0.0.19")).toEqual({ version: "v0.0.19", commit: "464f2c5", dirty: false });
  expect(() => buildVersion(commit, true, "v0.0.19")).toThrow("uncommitted");
  expect(() => buildVersion(commit, false, "v0.19")).toThrow("Invalid release tag");
  expect(() => buildVersion("bad", false)).toThrow("Invalid build commit");
});
