export function setupPreviewTools(): void {
  const toolbar = document.getElementById("preview-tools")!;
  const buttons = ["share-toggle", "tts-toggle", "toc-toggle", "edit-toggle"];
  toolbar.addEventListener("click", event => {
    const target = (event.target as Element | null)?.closest<HTMLButtonElement>("button.preview-tool");
    if (!target || !buttons.includes(target.id)) return;
    for (const id of buttons) {
      const other = document.getElementById(id) as HTMLButtonElement;
      if (other === target) continue;
      if (other.getAttribute("aria-expanded") === "true" || other.getAttribute("aria-pressed") === "true") other.click();
    }
  }, true);
}
