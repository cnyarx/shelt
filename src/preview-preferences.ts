export const HTML_INTERACTIVE_KEY = "shelt-html-interactive";

export function htmlInteractiveEnabled(): boolean {
  try { return localStorage.getItem(HTML_INTERACTIVE_KEY) !== "false"; }
  catch { return true; }
}

export function setHtmlInteractive(enabled: boolean): void {
  localStorage.setItem(HTML_INTERACTIVE_KEY, String(enabled));
}
