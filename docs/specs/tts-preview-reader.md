# Shelt 预览页 TTS 读屏功能规范

## 1. 背景与目标

Shelt 当前支持 Markdown、HTML、SVG 和图片预览，但没有语音朗读能力。本功能在不干扰链接点击、文本选择、表格滚动和浏览器右键操作的前提下，为预览页面增加可控的文字转语音（TTS）读屏能力。

目标：

1. Markdown、HTML 和 SVG 预览支持朗读；图片预览在没有可读文字时明确提示。
2. 页面右上角提供默认折叠的紧凑工具栏，点击朗读图标后展开。
3. 用户点击“定位朗读”后，直接点击可读内容，从该内容块开始向后朗读；也可点击“从头朗读”。
4. 支持暂停、继续、停止、语速和中文神经语音选择，并在播放当前段时预取下一段音频。
5. 使用免费的 Edge 在线神经语音；在线服务失败时停止队列并明确提示不可用。
6. 不实现本地系统语音、朗读历史、书签、OCR 或终端动态输出朗读。

## 2. 已验证事实

- 当前预览页由 `public/preview.html`、`src/preview.ts` 和 `public/preview.css` 组成。
- Markdown 在父页面中直接渲染，可精确获取语义块和鼠标位置。
- HTML/SVG 当前通过无脚本、无表单、无外部资源的沙箱 iframe 展示。
- 主页面 CSP 只允许同源网络请求，因此前端应请求 Shelt 自身的 `/api/tts`，不能直接跨域调用第三方服务。
- 当前后端内置最小 Edge Read Aloud WebSocket 客户端，不需要 API Key，支持神经语音并返回 24kHz、48kbps、单声道 MP3。
- 客户端仅依赖现有异步运行时、WebSocket 与 rustls/ring TLS 栈，并内置 Edge 当前证书链使用的 `DigiCert Global Root G2` 公共根证书，保持主机名、有效期和签名链校验。
- Edge Read Aloud 不是微软承诺稳定性的正式公共 API，失败时必须明确停止队列并提示服务不可用。
- StreamElements 候选接口在实际请求中返回 401；Google Translate 朗读端点在当前网络中连续超时，均不作为默认实现。

## 3. 用户交互

### 3.1 工具栏

预览页右上角显示浮动工具栏：

- 折叠图标：默认只显示右上角圆形朗读图标，点击后展开或收起完整工具栏；收起不停止当前播放。
- `从头朗读`：从第一个可读语义块开始朗读。
- `定位朗读`：开启或关闭定位模式，默认关闭。
- `暂停` / `继续`：控制当前在线音频。
- `停止`：终止当前朗读并清除高亮。
- `语音`：列出内置的优质中英文神经语音。
- `语速`：0.75x、1x、1.25x、1.5x。
- 状态文本：显示“就绪”“正在朗读”“已暂停”“语音朗读不可用”等状态。

工具栏默认折叠以避免覆盖正文；窄屏展开时允许换行。

### 3.2 定位模式

- 默认关闭，不监听普通悬停，不改变鼠标样式。
- 开启后，直接点击可读语义块，从该块开始按文档顺序继续朗读。
- 点击目标内容后自动退出定位模式。
- 再次点击 `定位朗读` 或按 `Esc` 也可退出定位模式。
- 定位模式使用捕获阶段处理目标点击，避免链接跳转与朗读同时发生；关闭定位后链接、文本选择和滚动保持原行为。

### 3.3 朗读反馈

- 当前语义块添加非侵入式高亮边框或背景。
- 切换位置、停止、完成或出错时清除旧高亮。
- 新的朗读请求会取消旧音频、旧网络请求和后续队列。

## 4. 可读内容与顺序

语义块选择器：

```text
h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, figcaption, th, td
```

规则：

- 忽略空文本、工具栏、隐藏元素、脚本、样式和表单控件。
- Markdown 按 DOM 顺序朗读。
- 表格按当前 DOM 顺序朗读表头和单元格。
- 每个块读取规范化后的 `textContent`，折叠连续空白。
- 单个请求最多 1,000 个 Unicode 字符；长块按句号、问号、感叹号、分号和换行优先切分。
- 从指定块开始构造队列，播放当前分段时并行预取下一分段，减少段落之间的网络等待。

## 5. 在线语音

### 5.1 默认在线语音

后端通过内置最小 WebSocket 客户端调用 Edge Read Aloud：

- 默认中文女声：`zh-CN-XiaoxiaoNeural`
- 可选中文男声：`zh-CN-YunxiNeural`
- 可选中文女声：`zh-CN-XiaoyiNeural`
- 可选英文多语言女声：`en-US-EmmaMultilingualNeural`
- 输出格式：24kHz、48kbps、单声道 MP3

第一版使用固定白名单，不接受任意 voice、locale 或上游 URL，避免服务端请求伪造和参数滥用。

### 5.2 同源接口

```text
POST /api/tts
Content-Type: application/json

{
  "text": "需要朗读的文本",
  "voice": "zh-CN-XiaoxiaoNeural",
  "rate": 1
}
```

成功响应：

```text
200 OK
Content-Type: audio/mpeg
Cache-Control: no-store
```

错误规则：

- 未认证：401
- Origin 不合法：403
- 文本为空或参数非法：400
- 文本超过 1,000 字符：413
- 在线服务失败或超时：502/504

安全约束：

- 必须通过现有 Host、Origin 和会话认证检查。
- 请求体设置较小上限。
- 不记录正文、Cookie、上游令牌或生成音频。
- 不落盘、不缓存音频。
- 单次合成设置超时。
- 客户端取消时停止等待并丢弃结果。

### 5.3 在线失败

当 `/api/tts` 网络失败、超时、返回非 2xx 或音频无法播放时，客户端停止当前队列、清除高亮，并显示“语音朗读不可用”。

## 6. Markdown、HTML、SVG 和图片支持

### 6.1 Markdown

Markdown 内容直接位于父页面 DOM 中，支持精确定位、高亮和从当前位置向后朗读。

### 6.2 HTML 与 SVG

保持 iframe 禁止脚本、表单和外部资源。为实现精确指向：

- iframe 和响应 CSP 仅增加 `allow-same-origin`，不增加 `allow-scripts`。
- 父页面可以读取 iframe 中已经由浏览器解析的安全 DOM。
- iframe 加载后从 `contentDocument` 收集语义块，并在 iframe 文档内捕获定位点击事件。
- 点击 iframe 中的语义块后，从对应块开始朗读。
- 高亮样式由父页面向 iframe 文档注入一段纯 CSS。

安全不变量：绝不同时启用 `allow-scripts` 和 `allow-same-origin`；原有 `default-src 'none'`、`form-action 'none'` 等限制保留。

### 6.3 图片

图片没有文本 DOM：

- 工具栏仍可见。
- `定位朗读` 禁用。
- 状态显示“图片预览未启用 OCR 识别”。
- 第一版不做 OCR。

## 7. 前端状态模型

```text
idle -> targeting -> loading -> speaking -> paused
                  \-> error
```

关键状态：

- 当前文档和可读块列表
- 当前队列索引及下一分段的预取请求
- 当前高亮元素
- 当前 `AbortController`
- 当前 `HTMLAudioElement`
- 工具栏展开状态和定位模式
- 语音及语速设置（使用 `localStorage` 保存，不包含敏感数据）

## 8. 代码改动范围

预计修改：

- `Cargo.toml`、`Cargo.lock`：增加最小 Edge WebSocket/TLS 依赖并移除重量级 HTTP/TTS 客户端链。
- `rust/edge_tts.rs`：内置 Edge Read Aloud 协议、证书校验、GEC、SSML 与音频帧解析。
- `rust/digicert-global-root-g2.der`：内置 Edge 当前证书链锚定的公开根证书。
- `rust/main.rs`：新增 `/api/tts`、请求校验、超时和音频响应；HTML/SVG CSP 沙箱增加 `allow-same-origin`；生产版静态 JavaScript 使用构建期 gzip 以控制独立二进制体积。
- `src/server.ts`：开发服务器明确返回在线 TTS 仅在编译版可用，保持测试链路边界清晰。
- `src/tts.ts`：文本块收集、分段、播放队列、下一分段预取、在线音频和工具栏逻辑。
- `src/preview.ts`：各预览类型加载完成后接入读屏控制器。
- `public/preview.html`：增加无障碍工具栏挂载点。
- `public/preview.css`：工具栏、定位按钮、高亮和响应式样式。
- `test/tts.test.ts`：文本规范化、分段、块顺序和语音白名单测试。
- `test/build.test.ts`、Rust 测试：构建资源、接口安全和沙箱策略回归测试。

不修改：

- 终端 WebSocket 输入输出协议。
- 终端右键、链接点击和剪贴板逻辑。
- Docker、服务启动方式或部署配置。
- 图片 OCR、朗读历史和书签。

## 9. 验收标准

1. 默认打开 Markdown、HTML 或 SVG 预览时只显示右上角朗读图标，普通页面操作不受影响。
2. 展开工具栏后可从头朗读；点击 `定位朗读` 后，直接点击语义块即可从该处开始。
3. Markdown 和 HTML 均能定位、高亮、暂停、继续和停止。
4. 播放当前分段时预取下一分段，连续朗读时不逐段串行等待网络。
5. 在线合成使用 `zh-CN-XiaoxiaoNeural` 时能返回并播放 MP3。
6. 模拟在线服务失败时停止队列并显示不可用状态，不调用本地系统语音。
7. 图片预览明确提示无可读内容，不发起 TTS 请求。
8. 未认证、错误 Origin、超长文本和未知 voice 均被后端拒绝。
9. HTML/SVG 中的脚本仍不可执行，不能发起外部资源请求。
10. `bun test`、`bun run typecheck`、`cargo fmt --check`、`cargo test`、`cargo check` 和生产编译全部通过。
11. 在真实 Shelt 页面完成 Markdown、HTML、窄屏和在线失败提示的端到端验收。

## 10. 风险与边界

- Edge Read Aloud 为非正式公共接口，可能改变或限流；出现失败时必须明确停止并提示，不能静默降级到低质量本地语音。
- 实际音质受上游语音和网络影响，默认选择晓晓神经语音以优先保障中文自然度。
- `allow-same-origin` 仅用于无脚本 iframe；若未来允许预览 HTML 执行脚本，必须重新设计隔离机制，不能沿用该组合。
- 长文按语义块逐段请求，避免一次提交整篇文档和过大音频响应。
