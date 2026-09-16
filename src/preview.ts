import { renderMermaid } from "@vercel/beautiful-mermaid";
import { escapeHtml, renderMarkdown } from "./markdown.ts";
import { PreviewTtsController } from "./tts.ts";

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Preview mount missing: ${id}`);
  return element;
}

const mount = requiredElement("preview");
const tts = new PreviewTtsController();
const path = new URL(location.href).searchParams.get("path");
if (!path || !path.startsWith("/")) {
  showError("Absolute preview path required.");
} else {
  document.title = `${path.split("/").pop() || path} — Shelt`;
  void load(path);
}

async function load(path: string): Promise<void> {
  const apiUrl = `/api/preview?path=${encodeURIComponent(path)}`;
  const response = await fetch(apiUrl, { credentials: "same-origin" });
  if (response.status === 401) {
    showError("Authentication required. Unlock Shelt in the terminal tab, then reload this page.");
    return;
  }
  if (!response.ok) {
    showError(await response.text());
    return;
  }
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
        const message = error instanceof Error ? error.message : "Unsupported Mermaid diagram";
        figure.insertAdjacentHTML("beforeend", `<figcaption>Mermaid preview unavailable: ${escapeHtml(message)}</figcaption>`);
      }
    }));
    tts.setDocument(mount);
    return;
  }
  if (kind === "image") {
    mount.className = "native-preview";
    const image = document.createElement("img");
    image.src = apiUrl;
    image.alt = path.split("/").pop() || "Image preview";
    mount.replaceChildren(image);
    tts.setDocument(null, undefined, "图片预览未启用 OCR 识别");
    return;
  }
  if (kind === "html" || kind === "svg") {
    mount.className = "native-preview";
    const frame = document.createElement("iframe");
    frame.src = apiUrl;
    frame.sandbox.value = "allow-same-origin";
    frame.title = path.split("/").pop() || "Document preview";
    mount.replaceChildren(frame);
    frame.addEventListener("load", () => {
      try {
        tts.setDocument(frame.contentDocument, frame);
      } catch {
        tts.setDocument(null, undefined, "此预览没有可朗读内容");
      }
    });
    return;
  }
  showError("Unsupported preview response.");
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
    link.textContent = heading.textContent || "未命名标题";
    link.title = link.textContent;
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
    panel.style.top = `${toolbar.getBoundingClientRect().bottom + 8}px`;
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

function showError(message: string): void {
  mount.className = "preview-error";
  mount.textContent = message;
}
