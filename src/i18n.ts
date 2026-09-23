export type Language = "zh-CN" | "en";
export const LANGUAGE_KEY = "shelt-language";

const zh = {
  settings: "设置", language: "界面语言", version: "Shelt 版本", loadingVersion: "正在读取版本…", unavailableVersion: "版本信息不可用", development: "开发版", dirty: "未提交改动",
  herdr: "Herdr 连接", herdrHint: "点击连接即可切换，终端会自动重连。", addConnection: "添加连接", name: "名称", remote: "SSH 目标（user@host）", session: "会话名（可选）", sessionDetail: "会话 {name}",
  add: "添加", save: "保存", cancel: "取消", edit: "编辑", remove: "删除", localHerdr: "本机 Herdr", defaultConnection: "默认连接", currentConnection: "当前连接", switchConnection: "切换到此连接", removeConnection: "删除连接“{name}”？", added: "已添加。", saved: "已保存。", removed: "已删除。", switching: "正在切换连接…",
  interactive: "HTML 交互预览", interactiveHint: "允许运行 JavaScript、加载外部库和同目录资源。不可信文件可关闭；仅保存在此浏览器，匿名分享始终静态。", interactiveOn: "已开启 HTML 交互预览。", interactiveOff: "已切换为静态安全预览。", storageError: "浏览器不允许保存设置，请检查存储权限。",
  changePassword: "修改密码", currentPassword: "当前密码", newPassword: "新密码（至少 8 个字符）", confirmPassword: "确认新密码", passwordMismatch: "两次输入的新密码不一致。", passwordChanged: "密码已修改，其他浏览器的登录状态已失效。", wrongPassword: "当前密码不正确", passwordLength: "密码需要 8–256 个字符", invalidName: "名称需要 1–40 个字符", invalidRemote: "SSH 目标格式无效", invalidSession: "会话名格式无效", tooManyConnections: "最多配置 16 个远程连接", unknownConnection: "连接不存在", saveConnectionError: "无法保存连接配置", loginRequired: "请先在终端页面登录", requestFailed: "请求失败（{status}）", forbidden: "请求被拒绝", invalidRequest: "请求格式不正确", notFound: "未找到", networkError: "网络请求失败，请重试。",
  preview: "文档预览", sharedDocument: "文档分享", loadingPreview: "正在加载预览…", absolutePath: "预览需要绝对路径。", previewLogin: "请先在终端页面登录，再刷新预览。", previewLoadError: "无法加载文档，请检查网络后重试。", unsupportedPreview: "不支持此预览格式。", imagePreview: "图片预览", htmlPreview: "HTML 预览", unnamedHeading: "未命名标题", mermaidError: "图表预览不可用：{detail}",
  share: "分享", readOnlyShare: "只读分享", loadingShare: "正在查询分享状态…", shareLink: "分享链接", createShare: "创建并复制链接", copyShare: "复制分享链接", regenerateShare: "重新生成并复制", revokeShare: "撤销分享", shareInfo: "链接有效期为 7 天，持有链接的人无需登录即可查看此文档及其引用图片。", shareExpires: "有效期至 {date}。", shareUnrecoverable: "旧链接无法找回，重新生成将使旧链接失效。", confirmRegenerate: "重新生成将立即使旧分享链接失效，是否继续？", shareCopied: "分享链接已复制。请仅发送给可信任的人。", copied: "分享链接已复制。", manualCopy: "浏览器不允许自动复制，请复制下方已选中的链接。", shareRevoked: "分享已撤销，旧链接立即失效。", shareSaveError: "无法保存分享状态", shareUnavailable: "分享不存在、已过期或文件不可用",
  speechToolbar: "语音朗读工具栏", expandSpeech: "展开语音朗读工具栏", collapseSpeech: "收起语音朗读工具栏", readStart: "从头朗读", targetRead: "定位朗读", exitTargeting: "退出定位", pause: "暂停", resume: "继续", stop: "停止", voice: "语音", rate: "语速", voiceXiaoxiao: "晓晓（中文女声）", voiceYunxi: "云希（中文男声）", voiceXiaoyi: "晓伊（中文女声）", voiceEmma: "Emma（多语言女声）", noReadable: "此预览没有可朗读内容", ready: "就绪", targetHint: "请点击要开始朗读的内容", speechComplete: "朗读完成", speaking: "正在使用在线神经语音朗读", speechUnavailable: "语音朗读不可用", speechResumed: "继续朗读", paused: "已暂停", imageSpeechUnavailable: "图片预览未启用 OCR 识别", interactiveSpeechUnavailable: "交互模式不支持朗读；可在设置中关闭 HTML 交互预览后朗读。",
  toc: "文档目录", toggleToc: "切换目录导航", tocTree: "文档目录树", interactiveLoadError: "无法打开交互预览。请检查文件是否在允许的目录中，或在设置中关闭 HTML 交互预览。", switchPreviewError: "无法切换预览模式，请刷新后重试。", resumePreviewError: "无法恢复预览，请刷新后重试。",
} as const;

export type MessageKey = keyof typeof zh;
const en: Record<MessageKey, string> = {
  settings: "Settings", language: "Language", version: "Shelt version", loadingVersion: "Loading version…", unavailableVersion: "Version unavailable", development: "Development", dirty: "Uncommitted changes",
  herdr: "Herdr connections", herdrHint: "Select a connection to switch. The terminal reconnects automatically.", addConnection: "Add connection", name: "Name", remote: "SSH target (user@host)", session: "Session name (optional)", sessionDetail: "Session {name}",
  add: "Add", save: "Save", cancel: "Cancel", edit: "Edit", remove: "Delete", localHerdr: "Local Herdr", defaultConnection: "Default connection", currentConnection: "Current connection", switchConnection: "Switch to this connection", removeConnection: "Delete connection “{name}”?", added: "Connection added.", saved: "Changes saved.", removed: "Connection deleted.", switching: "Switching connection…",
  interactive: "Interactive HTML preview", interactiveHint: "Allow JavaScript, external libraries and local assets. Turn off for untrusted files. Saved in this browser; shared previews stay static.", interactiveOn: "Interactive HTML preview enabled.", interactiveOff: "Switched to static safe preview.", storageError: "Unable to save settings. Check browser storage permissions.",
  changePassword: "Change password", currentPassword: "Current password", newPassword: "New password (at least 8 characters)", confirmPassword: "Confirm new password", passwordMismatch: "The new passwords do not match.", passwordChanged: "Password changed. Other browser sessions have been signed out.", wrongPassword: "Current password is incorrect", passwordLength: "Password must contain 8–256 characters", invalidName: "Name must contain 1–40 characters", invalidRemote: "Invalid SSH target", invalidSession: "Invalid session name", tooManyConnections: "At most 16 remote connections are supported", unknownConnection: "Connection not found", saveConnectionError: "Unable to save connection settings", loginRequired: "Sign in on the terminal page first", requestFailed: "Request failed ({status})", forbidden: "Request denied", invalidRequest: "Invalid request", notFound: "Not found", networkError: "Network request failed. Please try again.",
  preview: "Document preview", sharedDocument: "Shared document", loadingPreview: "Loading preview…", absolutePath: "An absolute preview path is required.", previewLogin: "Sign in on the terminal page, then reload this preview.", previewLoadError: "Unable to load the document. Check your connection and try again.", unsupportedPreview: "Unsupported preview format.", imagePreview: "Image preview", htmlPreview: "HTML preview", unnamedHeading: "Untitled heading", mermaidError: "Diagram preview unavailable: {detail}",
  share: "Share", readOnlyShare: "Read-only sharing", loadingShare: "Loading share status…", shareLink: "Share link", createShare: "Create & copy link", copyShare: "Copy share link", regenerateShare: "Regenerate & copy", revokeShare: "Revoke share", shareInfo: "Links last 7 days. Anyone with the link can view this document and its referenced images without signing in.", shareExpires: "Expires {date}. ", shareUnrecoverable: "The old link cannot be recovered. Regenerating invalidates it.", confirmRegenerate: "Regenerating immediately invalidates the old share link. Continue?", shareCopied: "Link copied. Share it only with people you trust.", copied: "Share link copied.", manualCopy: "Automatic copy was blocked. Copy the selected link below.", shareRevoked: "Share revoked. The old link is no longer valid.", shareSaveError: "Unable to save share settings", shareUnavailable: "The share is unavailable, expired or its file cannot be read",
  speechToolbar: "Read-aloud toolbar", expandSpeech: "Expand read-aloud toolbar", collapseSpeech: "Collapse read-aloud toolbar", readStart: "Read from start", targetRead: "Read from here", exitTargeting: "Exit selection", pause: "Pause", resume: "Resume", stop: "Stop", voice: "Voice", rate: "Speed", voiceXiaoxiao: "Xiaoxiao (Chinese, female)", voiceYunxi: "Yunxi (Chinese, male)", voiceXiaoyi: "Xiaoyi (Chinese, female)", voiceEmma: "Emma (multilingual, female)", noReadable: "No readable text in this preview", ready: "Ready", targetHint: "Click the text to start reading", speechComplete: "Reading complete", speaking: "Reading with online neural voice", speechUnavailable: "Read-aloud is unavailable", speechResumed: "Reading resumed", paused: "Paused", imageSpeechUnavailable: "OCR is not enabled for image previews", interactiveSpeechUnavailable: "Read-aloud is unavailable in interactive mode. Turn off interactive HTML preview in Settings to read aloud.",
  toc: "Table of contents", toggleToc: "Toggle table of contents", tocTree: "Document outline", interactiveLoadError: "Unable to open interactive preview. Check the allowed directory or turn off interactive HTML preview in Settings.", switchPreviewError: "Unable to switch preview modes. Reload and try again.", resumePreviewError: "Unable to restore the preview. Please reload.",
};

function storedLanguage(): Language {
  try { return localStorage.getItem(LANGUAGE_KEY) === "en" ? "en" : "zh-CN"; }
  catch { return "zh-CN"; }
}
let language = storedLanguage();
const listeners = new Set<() => void>();
export function getLanguage(): Language { return language; }
export function t(key: MessageKey, values: Record<string, string | number> = {}): string {
  const text = language === "en" ? en[key] : zh[key];
  return text.replace(/\{(\w+)\}/g, (match, name: string) => String(values[name] ?? match));
}
export function onLanguageChange(listener: () => void): void { listeners.add(listener); }
export function setLanguage(value: Language): void {
  localStorage.setItem(LANGUAGE_KEY, value);
  if (language === value) return;
  language = value;
  listeners.forEach(listener => listener());
}

export function translateElements(root: ParentNode = document): void {
  for (const attribute of ["text", "title", "aria-label", "placeholder"] as const) {
    const data = attribute === "text" ? "data-i18n" : `data-i18n-${attribute}`;
    for (const element of root.querySelectorAll<HTMLElement>(`[${data}]`)) {
      const key = element.getAttribute(data) as MessageKey;
      if (!(key in zh)) continue;
      if (attribute === "text") element.textContent = t(key);
      else element.setAttribute(attribute, t(key));
    }
  }
}

export function setupLanguage(): void {
  const select = document.getElementById("ui-language") as HTMLSelectElement;
  const update = () => {
    document.documentElement.lang = language;
    translateElements();
    select.value = language;
  };
  select.addEventListener("change", () => {
    try { setLanguage(select.value === "en" ? "en" : "zh-CN"); }
    catch { select.value = language; }
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== LANGUAGE_KEY && event.key !== null) return;
    const value = storedLanguage();
    if (value === language) return;
    language = value;
    listeners.forEach(listener => listener());
  });
  onLanguageChange(update);
  update();
}

const errors: Record<string, MessageKey> = {
  "当前密码不正确": "wrongPassword", "Password is required": "currentPassword", "Password must be at least 8 characters": "passwordLength", "Password must be at most 256 characters": "passwordLength", "Password must contain 8 to 256 characters": "passwordLength", "Password must be between 8 and 256 characters": "passwordLength",
  "无法保存分享状态": "shareSaveError", "分享不存在、已过期或文件不可用": "shareUnavailable",
  "名称需要 1-40 个字符": "invalidName", "SSH 目标格式无效": "invalidRemote", "会话名格式无效": "invalidSession", "最多配置 16 个远程连接": "tooManyConnections", "Unknown target": "unknownConnection", "无法保存连接配置": "saveConnectionError", "Authentication required": "loginRequired", "Cross-origin rejected": "forbidden", "Forbidden": "forbidden", "Invalid request": "invalidRequest", "Not found": "notFound", "Failed to fetch": "networkError",
};
export function localizedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return errors[message] ? t(errors[message]) : message;
}
