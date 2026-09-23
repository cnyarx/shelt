import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8").replaceAll("export ", ""));

function setup(saved?: string, blocked = false) {
  const values = new Map<string, string>();
  if (saved) values.set("shelt-language", saved);
  const select = { value: "", handlers: {} as Record<string, () => void>, addEventListener(name: string, callback: () => void) { this.handlers[name] = callback; } };
  const text = { textContent: "", getAttribute: () => "settings" };
  const input = { value: "keep my draft", attributes: { placeholder: "", "aria-label": "" } as Record<string, string>, getAttribute: () => "currentPassword", setAttribute(name: string, value: string) { this.attributes[name] = value; } };
  let storage = (_event: { key: string | null }) => {};
  const context: any = {
    localStorage: {
      getItem: (key: string) => { if (blocked) throw new Error("storage blocked"); return values.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (blocked) throw new Error("storage blocked"); values.set(key, value); },
    },
    window: { addEventListener: (_name: string, callback: typeof storage) => { storage = callback; } },
    document: {
      documentElement: { lang: "" }, getElementById: () => select,
      querySelectorAll: (selector: string) => selector === "[data-i18n]" ? [text] : selector === "[data-i18n-placeholder]" || selector === "[data-i18n-aria-label]" ? [input] : [],
    },
  };
  runInNewContext(`${source}\nsetupLanguage();`, context);
  return { values, select, input, text, context, storage: (key: string | null) => storage({ key }) };
}

test("language defaults to Chinese, updates labels without changing user text and persists", () => {
  const ui = setup();
  expect(ui.text.textContent).toBe("设置");
  expect(ui.select.value).toBe("zh-CN");
  ui.select.value = "en";
  ui.select.handlers.change!();
  expect(ui.context.document.documentElement.lang).toBe("en");
  expect(ui.text.textContent).toBe("Settings");
  expect(ui.input.attributes.placeholder).toBe("Current password");
  expect(ui.input.attributes["aria-label"]).toBe("Current password");
  expect(ui.input.value).toBe("keep my draft");
  expect(ui.context.t("removeConnection", { name: "中文连接" })).toBe("Delete connection “中文连接”?");
  expect(ui.context.localizedError("当前密码不正确")).toBe("Current password is incorrect");
  expect(setup(ui.values.get("shelt-language")).text.textContent).toBe("Settings");
});

test("language follows only its own storage changes and resets on storage clear", () => {
  const ui = setup("en");
  ui.values.set("shelt-language", "zh-CN");
  ui.storage("shelt-html-interactive");
  expect(ui.text.textContent).toBe("Settings");
  ui.storage("shelt-language");
  expect(ui.text.textContent).toBe("设置");
  ui.context.setLanguage("en");
  ui.values.clear();
  ui.storage(null);
  expect(ui.text.textContent).toBe("设置");
  expect(ui.input.value).toBe("keep my draft");
});

test("unavailable browser storage leaves a usable default language", () => {
  const ui = setup(undefined, true);
  ui.select.value = "en";
  ui.select.handlers.change!();
  expect(ui.select.value).toBe("zh-CN");
  expect(ui.text.textContent).toBe("设置");
});
