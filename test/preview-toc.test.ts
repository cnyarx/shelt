import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src/preview.ts", import.meta.url), "utf8");
const revealSource = source.slice(source.indexOf("  function revealActiveLink()"), source.indexOf("  function setExpanded("));
const reveal = new Bun.Transpiler({ loader: "ts" }).transformSync(revealSource);

function scrollResult(top: number, bottom: number, collapsed = false, active = true): number {
  const list = {
    scrollTop: 300,
    clientTop: 1,
    clientHeight: 200,
    getBoundingClientRect: () => ({ top: 100 }),
  };
  runInNewContext(`${reveal}\nrevealActiveLink();`, {
    list,
    panel: { classList: { contains: () => collapsed } },
    links: [{
      classList: { contains: () => active },
      getBoundingClientRect: () => ({ top, bottom }),
    }],
  });
  return list.scrollTop;
}

describe("preview directory active item visibility", () => {
  test("scrolls the directory down when the active item is below its viewport", () => {
    expect(scrollResult(480, 510)).toBe(509);
  });
  test("scrolls the directory up when the active item is above its viewport", () => {
    expect(scrollResult(40, 70)).toBe(239);
  });
  test("does not move an already visible item, including viewport edges", () => {
    expect(scrollResult(150, 180)).toBe(300);
    expect(scrollResult(101, 131)).toBe(300);
    expect(scrollResult(271, 301)).toBe(300);
  });
  test("does not scroll a collapsed directory or one without an active item", () => {
    expect(scrollResult(480, 510, true)).toBe(300);
    expect(scrollResult(480, 510, false, false)).toBe(300);
  });
});
