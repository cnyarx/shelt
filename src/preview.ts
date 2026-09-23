import { renderMermaid } from "@vercel/beautiful-mermaid";
import { renderMarkdown } from "./markdown.ts";
import { PreviewTtsController } from "./tts.ts";
import { setupShare } from "./share-ui.ts";
import { mountHtmlPreview } from "./html-preview.ts";
import { localizedError, onLanguageChange, setupLanguage, t } from "./i18n.ts";

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Preview mount missing: ${id}`);
  return element;
}

setupLanguage();
const mount = requiredElement("preview");
let message: (() => string) | null = () => t("loadingPreview");
mount.textContent = message();
const shareKey = location.pathname.match(/^\/share\/([a-f0-9]{64})$/)?.[1];
const tts = shareKey ? null : new PreviewTtsController();
if (shareKey) requiredElement("tts-toolbar").hidden = true;
const path = shareKey ? `share:${shareKey}` : new URL(location.href).searchParams.get("path");
const updateTitle = () => { document.title = `${shareKey ? t("sharedDocument") : path?.split("/").pop() || t("preview")} — Shelt`; };
onLanguageChange(() => { updateTitle(); if (message) mount.textContent = message(); });
updateTitle();
if (!path || (!shareKey && !path.startsWith("/"))) {
  showError(() => t("absolutePath"));
} else {
  void load(path).catch(() => showError(() => t("previewLoadError")));
}

async function load(path: string): Promise<void> {
  const apiUrl = shareKey ? `/api/share/${shareKey}` : `/api/preview?path=${encodeURIComponent(path)}`;
  const response = await fetch(apiUrl, { credentials: "same-origin" });
  if (response.status === 401) {
    showError(() => t("previewLogin"));
    return;
  }
  if (!response.ok) {
    const error = await response.text();
    showError(() => localizedError(error));
    return;
  }
  message = null;
  if (!shareKey) setupShare(path);
  const kind = response.headers.get("x-shelt-preview-kind");
  if (kind === "markdown") {
    const rendered = renderMarkdown(await response.text(), path);
    mount.className = "markdown-body";
    mount.innerHTML = rendered.html;
    setupTableOfContents();
    await Promise.all(rendered.mermaid.map(async (diagram) => {
      const figure = mount.querySelector<HTMLElement>(`[data-mermaid-id="${diagram.id}"]`);
      if (!figure) return;
      try {
        const svg = sanitizeSvg(await renderMermaid(diagram.source, {
          bg: "#ffffff",
          fg: "#24292f",
          line: "#57606a",
          accent: "#0969da",
          muted: "#6e7781",
          surface: "#f6f8fa",
          border: "#d0d7de",
          transparent: true,
        }));
        figure.innerHTML = svg;
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unsupported Mermaid diagram";
        const caption = document.createElement("figcaption");
        const update = () => { caption.textContent = t("mermaidError", { detail }); };
        onLanguageChange(update);
        update();
        figure.append(caption);
      }
    }));
    tts?.setDocument(mount);
    return;
  }
  if (kind === "image") {
    mount.className = "native-preview";
    const image = document.createElement("img");
    image.src = apiUrl;
    image.alt = path.split("/").pop() || t("imagePreview");
    mount.replaceChildren(image);
    tts?.setDocument(null, undefined, "imageSpeechUnavailable");
    return;
  }
  if (kind === "html" || kind === "svg") {
    mount.className = "native-preview";
    if (kind === "html" && !shareKey) {
      await mountHtmlPreview(mount, path, apiUrl, tts);
      return;
    }
    const frame = document.createElement("iframe");
    frame.src = apiUrl;
    frame.sandbox.value = "allow-same-origin";
    frame.title = path.split("/").pop() || t("preview");
    mount.replaceChildren(frame);
    frame.addEventListener("load", () => {
      try {
        tts?.setDocument(frame.contentDocument, frame);
      } catch {
        tts?.setDocument(null, undefined, "noReadable");
      }
    });
    return;
  }
  showError(() => t("unsupportedPreview"));
}

function sanitizeSvg(source: string): string {
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  if (document.querySelector("parsererror") || document.documentElement.localName !== "svg") throw new Error("Invalid Mermaid SVG");
  for (const element of document.querySelectorAll("script, foreignObject, iframe, object, embed, audio, video")) element.remove();
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on") || ((name === "href" || name.endsWith(":href")) && !value.startsWith("#"))) {
        element.removeAttribute(attribute.name);
      }
      if ((name === "style" || name === "fill" || name === "stroke" || name === "filter") && /url\(\s*["']?(?!#)/i.test(value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  return new XMLSerializer().serializeToString(document.documentElement);
}

function setupTableOfContents(): void {
  const headings = [...mount.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")];
  if (!headings.length) return;
  const panel = requiredElement("toc-panel");
  const toggle = requiredElement("toc-toggle");
  const list = requiredElement("toc-list");
  const tree = document.createElement("ul");
  tree.className = "toc-tree";
  const stack: { level: number; item: HTMLLIElement; list: HTMLUListElement }[] = [];
  const links: HTMLAnchorElement[] = [];
  for (const heading of headings) {
    const level = Number(heading.tagName.slice(1));
    while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
    const parent = stack[stack.length - 1];
    let container = tree;
    if (parent) {
      container = parent.list;
      if (!container.parentElement) parent.item.append(container);
    }
    const item = document.createElement("li");
    item.className = `toc-item toc-item-l${stack.length + 1}`;
    const link = document.createElement("a");
    link.className = "toc-link";
    link.href = `#${encodeURIComponent(heading.id)}`;
    const updateHeading = () => { link.textContent = heading.textContent || t("unnamedHeading"); link.title = link.textContent; };
    if (!heading.textContent) onLanguageChange(updateHeading);
    updateHeading();
    link.addEventListener("click", (event) => {
      event.preventDefault();
      heading.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      history.replaceState(null, "", link.hash);
      if (matchMedia("(max-width: 900px)").matches) setExpanded(false);
    });
    links.push(link);
    item.append(link);
    container.append(item);
    const children = document.createElement("ul");
    children.className = "toc-tree";
    stack.push({ level, item, list: children });
  }
  list.replaceChildren(tree);
  panel.hidden = false;
  function revealActiveLink(): void {
    if (panel.classList.contains("collapsed")) return;
    const link = links.find((link) => link.classList.contains("toc-active"));
    if (!link) return;
    const bounds = list.getBoundingClientRect();
    const item = link.getBoundingClientRect();
    const top = bounds.top + list.clientTop;
    const bottom = top + list.clientHeight;
    if (item.top < top) list.scrollTop += item.top - top;
    else if (item.bottom > bottom) list.scrollTop += item.bottom - bottom;
  }
  function setExpanded(expanded: boolean): void {
    panel.classList.toggle("collapsed", !expanded);
    toggle.setAttribute("aria-expanded", String(expanded));
    if (expanded) revealActiveLink();
  }
  toggle.addEventListener("click", () => setExpanded(panel.classList.contains("collapsed")));
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setExpanded(false);
      toggle.focus();
    }
  });
  const toolbar = requiredElement("tts-toolbar");
  const placePanel = () => {
    const sharing = requiredElement("share-toolbar");
    const languageToolbar = requiredElement("preview-language");
    panel.style.top = `${Math.max(languageToolbar.getBoundingClientRect().bottom, toolbar.hidden ? 0 : toolbar.getBoundingClientRect().bottom, sharing.hidden ? 0 : sharing.getBoundingClientRect().bottom) + 8}px`;
  };
  new ResizeObserver(placePanel).observe(toolbar);
  placePanel();
  let scheduled = false;
  const updateActive = () => {
    scheduled = false;
    let active = 0;
    for (let index = 0; index < headings.length; index++) {
      if (headings[index]!.getBoundingClientRect().top <= 100) active = index;
    }
    links.forEach((link, index) => {
      link.classList.toggle("toc-active", index === active);
      if (index === active) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
    revealActiveLink();
  };
  window.addEventListener("scroll", () => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(updateActive);
    }
  }, { passive: true });
  window.addEventListener("resize", updateActive);
  updateActive();
}

function showError(text: () => string): void {
  message = text;
  mount.className = "preview-error";
  mount.textContent = text();
}
