# 预览页提修改首版

## 使用方式

1. 从终端的 agent 页面点击文档链接打开预览。右上角依次提供分享、朗读、目录、修改四个 SVG 图标，悬停显示用途。
2. 点击铅笔图标开启修改标注。点击段落、表格单元格或拖选文字，填写修改要求；可选填写替换文字，再加入清单。
3. 清单可添加多处意见、编辑和删除，修改顺序保持稳定。同一浏览器标签页刷新后恢复草稿。
4. 从终端打开预览时默认选择来源 agent，允许手动更换；改选后刷新列表和页面均保留选择。查看提示词后，复制自行发送，或明确点击「发送给该 agent 执行」。
5. 投递成功只表示 Herdr 接受提示词。实际修改及验证结果请查看目标 agent，刷新预览查看文件更新。

## 本轮增量：图标栏与来源 agent

- 分享、朗读、目录、修改统一在右上角一排：40×40px 按钮、21×21px 线条 SVG、4px 间距、相同圆角及选中态；保留 title、aria-label 和键盘聚焦样式。
- 展开一个工具面板会关闭另一个；桌面面板位于图标栏下方，窄屏修改清单使用底部面板。
- 终端内同源文档链接先经过 GET /api/preview-edits/open?path=...，服务端读取该次打开的连接配置和当前 agent 身份，再跳转预览。绝对路径与相对路径均覆盖。
- 预览 URL 保存连接、agent 位置和会话身份摘要。已打开页面不随终端焦点或当前连接变化而更换默认对象。
- 用户手动改选按身份保存，列表排序变化不影响选择；同一路径从另一个来源 agent 打开时重新采用本次来源。
- 来源失效、会话已替换、直接访问且没有来源时保留手选，不选择其他 agent。忙碌来源保持选中并禁用发送。
- 工作区使用 Herdr workspace list 返回的 label；缺失时用工作目录名兜底。agent 使用标题或名称兜底，界面不展示内部位置编号。
- 来源默认值只帮助选择，不触发任何自动投递。投递仍要求明确点击，服务端重新核对目标身份和状态。

## 行为与限制

- Shelt 不写预览源文件。草稿保存在浏览器 sessionStorage；服务端保存投递摘要及状态回执，不保存提示词正文。
- 修改模式默认关闭；普通阅读的链接和选取保持原行为。修改定位与朗读定位互斥。
- 匿名分享页无修改入口。交互 HTML 的隔离 iframe 保持 allow-scripts；切换静态标注后，仅当前预览使用 allow-same-origin，脚本禁用，不改变全局偏好。
- 提示词包含路径、章节、原文、前后文及要求；Markdown 附源码行范围，HTML 附元素位置。要求 agent 读取当前文件重新定位，保护已有修改并汇报验证。
- 本机及已配置 SSH 连接分别获取 agent 列表；仅 idle / done 可发送，working / blocked / unknown / 启动中拒绝。缺能力时保留复制。
- 每页最多 30 处，每处选取 / 替换最多 12000 字符，要求最多 4000 字符；请求上限 256 KiB，投递提示词上限 60 KiB。
- requestId 排他创建回执，文件及目录同步后才投递；相同请求返回已有结果，内容冲突拒绝。超时、断线和重启遗留 pending 显示 uncertain，禁止自动重投。
- Herdr 当前接口没有条件投递或服务端幂等键。无法完全消除其他客户端造成的状态竞态；结果不确定时先检查目标 agent，不尝试按键降级投递。
- 当前预览源文件位于 Shelt 所在环境；选择远程 agent 时须确认它可访问同一路径，不假定不同机器的相同路径是同一文件。
- 来源捕获读取服务端当前聚焦的 agent；缺少 Herdr 查询能力时不提供默认选择，仍可预览绝对路径文件并手动选择。

## 代码与基线

- 主仓库 /home/admin/github/shelt；基线 d05bc7d7d9f90882e427953c5b9fd6b677edf164。
- 任务路径 /home/admin/github/shelt/.qwen/worktrees/preview-edits。本轮按用户授权提交并推送到 GitHub main，环境未部署；本文件随功能提交，实际提交与推送结果以 Git 记录为准。
- 主工作区朗读改动独立保留，本轮开始与最终核对差异指纹使用 SHA-256；依赖 manifest / lock 不变。
- 图标栏：public/preview.html、public/preview.css、src/preview-tools.ts、src/share-ui.ts、src/tts.ts、src/preview.ts。
- 来源捕获与默认选择：src/client.ts、src/preview-source.ts、src/preview-edit-ui.ts、src/preview-edit-service.ts、rust/preview_edits.rs、rust/main.rs。
- 首版选取和提示词：src/preview-edits.ts、src/preview-edit-selection.ts、src/markdown.ts、src/html-preview.ts。
- 接口：GET /api/preview-edits/open、GET /api/preview-edits/agents、POST /api/preview-edits/send。
- 本地用配置的 Herdr CLI；远程用已有 SSH 目标，保留主机密钥校验，命令参数引用，正文走 stdin。

## 验证结果如下

[COMPUTED HIGH]

- bun test：210 pass / 0 fail，42 文件。
- SHELT_TEST_RUST=1 bun test test/preview-edits-http.test.ts：6 pass / 0 fail，190 次断言。包含本地 / 远程来源、相对路径、焦点变化、忙碌和失效来源，来源检查不投递。
- bun run typecheck、cargo fmt --check、cargo clippy --all-targets -- -D warnings 通过；cargo test：51 passed / 0 failed。
- 按 bun run build → cargo build 顺序构建，真实浏览器使用构建后的 Rust 二进制。
- 来源与工具栏单测：9 pass / 0 fail，52 次断言。覆盖来源身份、手动改选跨列表刷新及页面刷新、无来源 / 失效来源 / 身份替换、忙碌禁发及面板互斥。
- 构建测试检查四个入口均有 SVG、title、aria-label，且没有文字作为按钮内容。
- 桌面 1920px：四按钮 y=21、尺寸40×40、横向间隔4；工具栏底部66，四个面板展开顶端80，均在视口内，一次只有一个面板展开。
- 390px：四按钮 y=13、尺寸40×40；工具栏底部58，分享 / 朗读 / 目录面板顶端68，修改面板底部展开；所有面板在视口内，无页面横向溢出。
- 真实 Chrome：本机 Documents / local editor 自动选中；忙碌来源保持选择且禁发；手动改为 Remote docs / Documents / remote editor 后刷新列表和页面仍保留。
- 从远程连接打开预览默认选择 remote editor；之后切回本机连接并改变焦点，已打开预览仍保留远程来源。会话身份替换后变为未选择；无来源直接访问也未选择。
- 本轮来源及界面验收期间测试接收数量始终0，预览源文件内容保持不变；复制提示词通过。
- 原首版选取、草稿、匿名分享、iframe及防重复投递仍由全量回归和双后端契约覆盖。测试目标为受控 CLI / SSH fixture，未向现有用户 agent 发消息。
- 本轮修正过两处测试/布局问题：新测试最初用了不存在的激活路由，改用已有 /api/herdr/active；去掉图标栏容器的 backdrop-filter，避免固定面板相对该容器偏移，最终几何检查通过。

## 查看画面与保留资源

- 共享 Chrome、Xvfb、x11vnc、noVNC 保留，已有用户标签页未关闭。
- 在 VS Code Remote SSH 的 Ports 面板转发远端6080，打开 http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale 。本轮已确认HTTP 200。
- 隔离预览 http://127.0.0.1:24855/；控制端仅监听127.0.0.1:24856。
- 当前测试文档 /tmp/shelt-preview-edits-Z55yIQ/document.md 与 page.html。
- 当前后台任务 bg_6419494d，启动PID 3301884，Rust服务PID 3302028。保留供用户查看；结束查看后只停止该任务，共享浏览器继续保留。
- 本轮截图 / 证据：.qwen/tmp/preview-toolbar-evidence/desktop.png、mobile.png、verification.json。
- 上一轮首版截图 / 证据继续保留在 .qwen/tmp/preview-edit-evidence/。
