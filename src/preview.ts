import { renderMermaid } from "@vercel/beautiful-mermaid";
import { escapeHtml, renderMarkdown } from "./markdown.ts";

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Preview mount missing: ${id}`);
  return element;
}

const mount = requiredElement("preview");
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
    return;
  }
  if (kind === "image") {
    mount.className = "native-preview";
    const image = document.createElement("img");
    image.src = apiUrl;
    image.alt = path.split("/").pop() || "Image preview";
    mount.replaceChildren(image);
    return;
  }
  if (kind === "html" || kind === "svg") {
    mount.className = "native-preview";
    const frame = document.createElement("iframe");
    frame.src = apiUrl;
    frame.sandbox.value = "";
    frame.title = path.split("/").pop() || "Document preview";
    mount.replaceChildren(frame);
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

function showError(message: string): void {
  mount.className = "preview-error";
  mount.textContent = message;
}
