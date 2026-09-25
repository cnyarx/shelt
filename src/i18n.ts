export type Language = "zh-CN" | "en";
export const LANGUAGE_KEY = "shelt-language";

const zh = {
  settings: "设置", language: "界面语言", version: "Shelt 版本", loadingVersion: "正在读取版本…", unavailableVersion: "版本信息不可用", development: "开发版", dirty: "未提交改动",
  herdr: "Herdr 连接", herdrHint: "点击连接即可切换，终端会自动重连。", addConnection: "添加连接", name: "名称", remote: "SSH 目标（user@host）", session: "会话名（可选）", sessionDetail: "会话 {name}",
  add: "添加", save: "保存", cancel: "取消", edit: "编辑", remove: "删除", localHerdr: "本机 Herdr", defaultConnection: "默认连接", currentConnection: "当前连接", switchConnection: "切换到此连接", removeConnection: "删除连接“{name}”？", added: "已添加。", saved: "已保存。", removed: "已删除。", switching: "正在切换连接…",
  interactive: "HTML 交互预览", interactiveHint: "允许运行 JavaScript、加载外部库和同目录资源。不可信文件可关闭；仅保存在此浏览器，匿名分享始终静态。", interactiveOn: "已开启 HTML 交互预览。", interactiveOff: "已切换为静态安全预览。", storageError: "浏览器不允许保存设置，请检查存储权限。",
  notifyHint: "Herdr agent 任务完成或需要确认时发送系统通知。仅保存在此浏览器；需保持终端页面开启。", notifyDone: "任务完成通知（绿点）", notifyBlocked: "需要确认通知（红点）", notifyOn: "已开启系统通知。", notifyOff: "已关闭系统通知。", notifyUnavailable: "当前浏览器或地址不支持系统通知。请通过 localhost 或 HTTPS 访问，或在 Chrome 的 chrome://flags/#unsafely-treat-insecure-origin-as-secure 中加入此地址并重启浏览器。", notifyPermissionDenied: "系统通知权限已被拒绝，请在浏览器站点设置中允许通知后重试。", notifyPermissionPending: "已开启。浏览器询问通知权限时请选择“允许”。", notifyDoneTitle: "Agent 任务完成", notifyBlockedTitle: "Agent 等待确认",
  changePassword: "修改密码", currentPassword: "当前密码", newPassword: "新密码（至少 8 个字符）", confirmPassword: "确认新密码", passwordMismatch: "两次输入的新密码不一致。", passwordChanged: "密码已修改，其他浏览器的登录状态已失效。", wrongPassword: "当前密码不正确", passwordLength: "密码需要 8–256 个字符", invalidName: "名称需要 1–40 个字符", invalidRemote: "SSH 目标格式无效", invalidSession: "会话名格式无效", tooManyConnections: "最多配置 16 个远程连接", unknownConnection: "连接不存在", saveConnectionError: "无法保存连接配置", loginRequired: "请先在终端页面登录", requestFailed: "请求失败（{status}）", forbidden: "请求被拒绝", invalidRequest: "请求格式不正确", notFound: "未找到", networkError: "网络请求失败，请重试。",
  preview: "文档预览", sharedDocument: "文档分享", loadingPreview: "正在加载预览…", absolutePath: "预览需要绝对路径。", previewLogin: "请先在终端页面登录，再刷新预览。", previewLoadError: "无法加载文档，请检查网络后重试。", unsupportedPreview: "不支持此预览格式。", imagePreview: "图片预览", htmlPreview: "HTML 预览", unnamedHeading: "未命名标题", mermaidError: "图表预览不可用：{detail}",
  share: "分享", readOnlyShare: "只读分享", loadingShare: "正在查询分享状态…", shareLink: "分享链接", createShare: "创建并复制链接", copyShare: "复制分享链接", regenerateShare: "重新生成并复制", revokeShare: "撤销分享", shareInfo: "链接有效期为 7 天，持有链接的人无需登录即可查看此文档及其引用图片。", shareExpires: "有效期至 {date}。", shareUnrecoverable: "旧链接无法找回，重新生成将使旧链接失效。", confirmRegenerate: "重新生成将立即使旧分享链接失效，是否继续？", shareCopied: "分享链接已复制。请仅发送给可信任的人。", copied: "分享链接已复制。", manualCopy: "浏览器不允许自动复制，请复制下方已选中的链接。", shareRevoked: "分享已撤销，旧链接立即失效。", shareSaveError: "无法保存分享状态", shareUnavailable: "分享不存在、已过期或文件不可用",
  speechToolbar: "语音朗读工具栏", expandSpeech: "展开语音朗读工具栏", collapseSpeech: "收起语音朗读工具栏", readStart: "从头朗读", targetRead: "定位朗读", exitTargeting: "退出定位", pause: "暂停", resume: "继续", stop: "停止", voice: "语音", rate: "语速", voiceXiaoxiao: "晓晓（中文女声）", voiceYunxi: "云希（中文男声）", voiceXiaoyi: "晓伊（中文女声）", voiceEmma: "Emma（多语言女声）", noReadable: "此预览没有可朗读内容", ready: "就绪", targetHint: "请点击要开始朗读的内容", speechComplete: "朗读完成", speaking: "正在使用在线神经语音朗读", speechUnavailable: "语音朗读不可用", speechResumed: "继续朗读", paused: "已暂停", imageSpeechUnavailable: "图片预览未启用 OCR 识别", interactiveSpeechUnavailable: "交互模式不支持朗读；可在设置中关闭 HTML 交互预览后朗读。",
  toc: "文档目录", toggleToc: "切换目录导航", tocTree: "文档目录树", interactiveLoadError: "无法打开交互预览。请检查文件是否在允许的目录中，或在设置中关闭 HTML 交互预览。", switchPreviewError: "无法切换预览模式，请刷新后重试。", resumePreviewError: "无法恢复预览，请刷新后重试。",
  updateInstall: "升级 {version}", updateInstalling: "升级中…", updateFound: "发现新版本 {version}", updateConfirm: "升级到 {version}？将短暂重启当前 Shelt，断开终端并需要重新登录。密码、连接配置和分享记录会保留。共享此安装文件的其他实例将在下次启动时使用新版。", updateDownloading: "正在下载官方版本…", updateVerifying: "正在校验版本和 SHA-256…", updateRestarting: "正在重启，即将刷新页面…", updateRestartTimeout: "升级等待超时，请刷新页面或检查 Shelt 日志。", updateCheckFailed: "暂时无法检查 GitHub 更新，稍后会重试。", updateRateLimited: "GitHub 请求限流，稍后会重试。", updateUnsupported: "当前平台尚无可用的官方升级资产。", updateDevelopment: "开发构建不自动覆盖，请先安装正式 Release。", updateSourceMode: "源码运行模式不支持自升级，请使用正式二进制。", updateReadOnly: "安装目录不可写，或二进制不属于当前账号，请由管理员更新。", updateInvalidRelease: "GitHub 版本信息不完整或格式异常。", updateAssetMissing: "该版本缺少当前平台的二进制或校验文件。", updateBusy: "此安装正在升级，请稍候。", updateDownloadFailed: "下载失败，当前版本保持不变，请重试。", updateChecksumFailed: "SHA-256 校验失败，未安装下载文件。", updateInvalidBinary: "下载的程序无法运行或版本不匹配，未安装。", updateWriteFailed: "无法写入或替换安装文件，请检查磁盘与权限。", updateNoNewVersion: "当前已是最新版本。", updateChangedOnDisk: "安装文件已被其他进程更新，请刷新后重试。", updateFailed: "升级失败，请重试或查看 Shelt 日志。",
} as const;

export type MessageKey = keyof typeof zh;
const en: Record<MessageKey, string> = {
  settings: "Settings", language: "Language", version: "Shelt version", loadingVersion: "Loading version…", unavailableVersion: "Version unavailable", development: "Development", dirty: "Uncommitted changes",
  herdr: "Herdr connections", herdrHint: "Select a connection to switch. The terminal reconnects automatically.", addConnection: "Add connection", name: "Name", remote: "SSH target (user@host)", session: "Session name (optional)", sessionDetail: "Session {name}",
  add: "Add", save: "Save", cancel: "Cancel", edit: "Edit", remove: "Delete", localHerdr: "Local Herdr", defaultConnection: "Default connection", currentConnection: "Current connection", switchConnection: "Switch to this connection", removeConnection: "Delete connection “{name}”?", added: "Connection added.", saved: "Changes saved.", removed: "Connection deleted.", switching: "Switching connection…",
  interactive: "Interactive HTML preview", interactiveHint: "Allow JavaScript, external libraries and local assets. Turn off for untrusted files. Saved in this browser; shared previews stay static.", interactiveOn: "Interactive HTML preview enabled.", interactiveOff: "Switched to static safe preview.", storageError: "Unable to save settings. Check browser storage permissions.",
  notifyHint: "Send system notifications when a Herdr agent finishes or needs confirmation. Saved in this browser only; keep the terminal page open.", notifyDone: "Task completed alerts (green)", notifyBlocked: "Needs confirmation alerts (red)", notifyOn: "System notifications enabled.", notifyOff: "System notifications disabled.", notifyUnavailable: "System notifications are unavailable here. Use localhost or HTTPS, or add this address in chrome://flags/#unsafely-treat-insecure-origin-as-secure and restart Chrome.", notifyPermissionDenied: "Notification permission is denied. Allow notifications for this site in browser settings and try again.", notifyPermissionPending: "Enabled. Choose “Allow” when the browser asks for notification permission.", notifyDoneTitle: "Agent task completed", notifyBlockedTitle: "Agent needs confirmation",
  changePassword: "Change password", currentPassword: "Current password", newPassword: "New password (at least 8 characters)", confirmPassword: "Confirm new password", passwordMismatch: "The new passwords do not match.", passwordChanged: "Password changed. Other browser sessions have been signed out.", wrongPassword: "Current password is incorrect", passwordLength: "Password must contain 8–256 characters", invalidName: "Name must contain 1–40 characters", invalidRemote: "Invalid SSH target", invalidSession: "Invalid session name", tooManyConnections: "At most 16 remote connections are supported", unknownConnection: "Connection not found", saveConnectionError: "Unable to save connection settings", loginRequired: "Sign in on the terminal page first", requestFailed: "Request failed ({status})", forbidden: "Request denied", invalidRequest: "Invalid request", notFound: "Not found", networkError: "Network request failed. Please try again.",
  preview: "Document preview", sharedDocument: "Shared document", loadingPreview: "Loading preview…", absolutePath: "An absolute preview path is required.", previewLogin: "Sign in on the terminal page, then reload this preview.", previewLoadError: "Unable to load the document. Check your connection and try again.", unsupportedPreview: "Unsupported preview format.", imagePreview: "Image preview", htmlPreview: "HTML preview", unnamedHeading: "Untitled heading", mermaidError: "Diagram preview unavailable: {detail}",
  share: "Share", readOnlyShare: "Read-only sharing", loadingShare: "Loading share status…", shareLink: "Share link", createShare: "Create & copy link", copyShare: "Copy share link", regenerateShare: "Regenerate & copy", revokeShare: "Revoke share", shareInfo: "Links last 7 days. Anyone with the link can view this document and its referenced images without signing in.", shareExpires: "Expires {date}. ", shareUnrecoverable: "The old link cannot be recovered. Regenerating invalidates it.", confirmRegenerate: "Regenerating immediately invalidates the old share link. Continue?", shareCopied: "Link copied. Share it only with people you trust.", copied: "Share link copied.", manualCopy: "Automatic copy was blocked. Copy the selected link below.", shareRevoked: "Share revoked. The old link is no longer valid.", shareSaveError: "Unable to save share settings", shareUnavailable: "The share is unavailable, expired or its file cannot be read",
  speechToolbar: "Read-aloud toolbar", expandSpeech: "Expand read-aloud toolbar", collapseSpeech: "Collapse read-aloud toolbar", readStart: "Read from start", targetRead: "Read from here", exitTargeting: "Exit selection", pause: "Pause", resume: "Resume", stop: "Stop", voice: "Voice", rate: "Speed", voiceXiaoxiao: "Xiaoxiao (Chinese, female)", voiceYunxi: "Yunxi (Chinese, male)", voiceXiaoyi: "Xiaoyi (Chinese, female)", voiceEmma: "Emma (multilingual, female)", noReadable: "No readable text in this preview", ready: "Ready", targetHint: "Click the text to start reading", speechComplete: "Reading complete", speaking: "Reading with online neural voice", speechUnavailable: "Read-aloud is unavailable", speechResumed: "Reading resumed", paused: "Paused", imageSpeechUnavailable: "OCR is not enabled for image previews", interactiveSpeechUnavailable: "Read-aloud is unavailable in interactive mode. Turn off interactive HTML preview in Settings to read aloud.",
  toc: "Table of contents", toggleToc: "Toggle table of contents", tocTree: "Document outline", interactiveLoadError: "Unable to open interactive preview. Check the allowed directory or turn off interactive HTML preview in Settings.", switchPreviewError: "Unable to switch preview modes. Reload and try again.", resumePreviewError: "Unable to restore the preview. Please reload.",
  updateInstall: "Upgrade {version}", updateInstalling: "Upgrading…", updateFound: "New version {version} available", updateConfirm: "Upgrade to {version}? Shelt will briefly restart, disconnect the terminal and require sign-in again. Passwords, connections and shares are preserved. Other instances sharing this binary will use the new version on their next start.", updateDownloading: "Downloading official release…", updateVerifying: "Verifying version and SHA-256…", updateRestarting: "Restarting. This page will reload…", updateRestartTimeout: "Upgrade timed out. Reload the page or check the Shelt log.", updateCheckFailed: "Unable to check GitHub updates. Will retry later.", updateRateLimited: "GitHub rate limit reached. Will retry later.", updateUnsupported: "No official update asset is available for this platform.", updateDevelopment: "Development builds are not overwritten. Install an official Release first.", updateSourceMode: "Source mode cannot self-update. Use an official binary.", updateReadOnly: "The installation directory is read-only or the binary is owned by another user. Ask your administrator to update it.", updateInvalidRelease: "Invalid or incomplete GitHub release information.", updateAssetMissing: "The release is missing a binary or checksum for this platform.", updateBusy: "This installation is already being upgraded.", updateDownloadFailed: "Download failed. The current version is unchanged. Try again.", updateChecksumFailed: "SHA-256 verification failed. The download was not installed.", updateInvalidBinary: "The downloaded binary cannot run or its version does not match. It was not installed.", updateWriteFailed: "Cannot write or replace the binary. Check disk space and permissions.", updateNoNewVersion: "Already up to date.", updateChangedOnDisk: "Another process updated the installation. Refresh and try again.", updateFailed: "Upgrade failed. Try again or check the Shelt log.",
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
  const select = document.getElementById("ui-language") as HTMLSelectElement | null;
  const update = () => {
    document.documentElement.lang = language;
    translateElements();
    if (select) select.value = language;
  };
  select?.addEventListener("change", () => {
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
  if (message.startsWith("update") && Object.prototype.hasOwnProperty.call(zh, message)) return t(message as MessageKey);
  return errors[message] ? t(errors[message]) : message;
}
