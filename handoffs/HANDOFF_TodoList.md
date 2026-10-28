# 终端待办：设计与实现交接

## 基线与边界

- 任务工作区 /home/admin/github/shelt/.qwen/worktrees/todo-list，基线 7229ffe1b47638e04a83ace7f75ddf7844e829e8。
- 主工作区朗读改动与既有预览工作区保留，不操作现有用户 agent。
- 本文设计先于代码落盘。Bun/Rust 实现、自动测试和隔离浏览器验收结果见后文。
- 实现验收后，用户另行明确授权发布并更新：只提交本功能，推送 GitHub main，CI/Release 成功后更新44.99三个正式实例与160分发入口，并尝试可达的M4。部署保留数据、旧版备份和Herdr会话。

### 原始时序与基线证据

[COMPUTED HIGH] 已只读核对本会话原始转录 /home/admin/.qwen/projects/-home-admin-github-shelt/chats/76e3a58a-9275-40e2-9df8-55e5b4eb1731.jsonl，以下均为原始工具调用/回执，不以本文自述代替：

- 第41718行，原始 run_shell_command 回执 call_sQuwsL4COsfA3DedFdpJjxrW：任务开始时主工作区 HEAD=d05bc7d，git diff --binary 的 SHA256 为60728aa784b8b3f666fc69b8aa1bcdc96a9bc5c7078869987611e1cf04d302cd，与收尾实测一致。
- 第41750行写入本文完整设计，第41753行 write_file 成功回执 call_yEQoQ7yeWM3pDhm4byRCYceA：原文件为空，新建66行，覆盖外观、状态、数据、并发、接口、授权与验收计划；原始回执时间2026-10-27T08:07:10.097Z。
- 第41785行开始写 src/todos.ts，第41788行 write_file 成功回执 call_NEUslQFNPzIXdjlqQwGPzSwf：新建117行；原始回执时间2026-10-27T08:13:28.625Z，晚于设计落盘。随后实现存储、HTTP、Rust和UI。
- 第43956行保存隔离连接切换后快照完全一致的原始浏览器回执；第44132行保存一次连接重置后的2次SSE请求；第44138行保存最新构建默认收起、展开前后终端尺寸一致的原始DOM回执。

## 外观与使用

- 登录后的终端主页右侧增加清单 SVG 按钮，默认收起，显示有效未完成叶子数量。预览页和匿名分享不显示。
- 深色浮窗宽380px，桌面定位右侧，390px窄屏使用底部面板；内部滚动。浮窗不调整终端容器或PTY尺寸。打开时关闭设置和朗读浮窗，按钮保持可访问。
- 顶部项目筛选、项目管理、添加任务/清单、隐藏已完成项。树形行有折叠箭头、叶子状态图标/文字、标题和编辑入口，使用 textContent 渲染。
- 编辑表单可修改标题、说明、状态、项目、父清单和顺序。父清单选择排除自身和后代；后端仍校验。
- 删除非空项目/清单显示明确的子项数量，用户确认后递归删除。空节点及叶子也有删除确认，取消不发送请求。
- 面板关闭但图标保持计数；服务事件更新各浏览器，断线显示离线标识并保留内容。重连收到最新快照。切换Herdr连接不切换清单。

## 数据结构与状态机

- 项目 Project：id、title、description、order、revision。
- 节点 Item：id、projectId、parentId(null表示项目根)、kind(folder或task)、title、description、order、status、revision。
- folder为纯组织节点，status固定null；task不可有子项，状态为 todo / doing / blocked / done / canceled。节点类型创建后不可更改。
- 允许任意两个有效叶子状态之间显式转换，包括直接完成、重开、取消与恢复；同一状态无业务效果，版本仍以明确写入为准。阻塞原因写说明，不凭进程活动推断完成。
- 汇总只计算后代task：总数、取消数、有效数(总数-取消)、完成数、剩余数，以及各状态数量。取消不计入完成率。无有效叶子显示0/0；父节点状态派生：有doing为进行中，否则有blocked为阻塞，否则有todo为待处理，否则有done为完成，否则全部取消为已取消，空清单为空。
- 移动保持无环、同一项目有效父引用、深度最多16。跨项目移动folder时整棵子树一同移动，叶子状态保持；项目令牌禁止移出其项目。排序由order整数决定，相同值按id稳定排序。

## 持久化与并发

- SHELT_STATE_DIR/todos.json，Bun/Rust共用 version=1 格式，含revision、projects、items、tokens、receipts。文件600、目录700，仅令牌SHA256哈希落盘。
- 全局revision每次成功写入加1，返回快照；PATCH/DELETE必须提交当前revision，过期返回409。POST创建使用requestId(32位小写hex)防重，同ID同内容返回原结果，同ID异内容409；防重先于版本检查。
- 所有写入先取得todos.lock目录排他锁，重新读取文件，验证后写临时文件、fsync、rename和同步目录，再发布事件；跨进程使用同一锁规则，锁被占用返回409/重试提示，不自动删除未知锁。
- GET从磁盘读取原子快照；SSE在连接时发送snapshot，应用内每秒检查revision变化，20秒心跳，断开即释放。覆盖共享状态目录下多实例写入及客户端重连，不建立后台定时任务。
- 数据完整性校验失败停止该操作并报错，不静默重置数据。

## HTTP 契约

所有路径限定 /api/todos；浏览器用登录cookie + 原有Host/Origin校验；Bearer只适用于待办CRUD、snapshot、events，不能用于授权管理/提示词投递或其他API。

- GET /api/todos：授权范围内完整snapshot。
- GET/POST /api/todos/projects；GET/PATCH/DELETE /api/todos/projects/{id}。
- GET/POST /api/todos/projects/{id}/items；GET/PATCH/DELETE /api/todos/items/{id}。
- 非空DELETE请求体 {revision,recursive:true}，未明确recursive返回409 confirmation_required。
- POST创建 {revision,requestId,title,...}，创建item另带kind、parentId、status、order。
- PATCH {revision,...字段}；不接受修改id、kind，不接受未知字段。缺失/非法数据400，范围外403，不存在404，版本冲突409，文件失败503。
- GET /api/todos/events：SSE snapshot事件，含scope过滤后的snapshot，不包含token或哈希。
- GET/POST /api/todos/grants、DELETE /api/todos/grants/{id}：仅浏览器cookie；创建projectId明确为项目或null(用户明确选择全清单)，有效期1小时/8小时/24小时。返回一次明文Bearer，后续列表只含id、范围、到期/撤销信息。
- POST /api/todos/prompt：仅浏览器cookie，{projectId,baseUrl,ttlSeconds}；创建令牌并返回生成提示词。baseUrl必须是本服务已允许的Host和HTTP(S)地址，不信任任意外部地址；本机地址明确提示远端agent可能不可达。
- GET /api/todos/agents：浏览器读取现有连接agent列表及当前来源；POST /api/todos/send：仅cookie，{requestId,grantId,targetId,paneId,session}，发送已生成且未过期授权对应的提示词。复用现有Herdr CLI/SSH投递机制、忙碌拒绝及请求回执，不通过终端WebSocket注入文字。

## agent 提示词、授权与发送

- 提示词包含API根地址、范围、当前项目/节点及revision、状态规则、curl示例。Bearer放HTTP Authorization头，不进URL；示例含GET、项目/节点POST/PATCH/DELETE，删除非空必须明确recursive。
- 要求先读当前状态再根据真实工作更新，复用已有项目/节点、避免重复；无证据保留原状态，冲突重新读取；不能把创建提示词/接收消息当作任务完成证据。
- 用户生成提示词时明确选择当前项目或全清单与有效期；可复制，或选agent明确点击发送。默认当前连接聚焦agent，后续用户改选不被刷新覆盖。无agent能力时只复制。
- 明文令牌只在本次浏览器/待发送内存持有，不写日志、sessionStorage、源码或Git；刷新可重新生成，授权管理可撤销旧令牌。服务端为显式发送临时在内存保存提示词；重启后不能找回正文，用户重新生成。
- 项目令牌不能读取其他项目、不能创建其他项目或管理授权。全清单令牌只有用户明确选择后创建。到期/撤销立即拒绝后续请求并结束相关SSE。
- HTTP地址下Bearer仅适合受信内网，跨不可信网络需HTTPS；UI明确显示有效期、范围与风险。远程不可达时保留复制，不擅自建隧道。

## 实现顺序与验收计划

1. 共用类型、状态/树操作及提示词模板；Bun持久化/认证/CRUD/SSE。
2. Rust使用相同磁盘/接口契约，实现状态校验、令牌权限及事件。
3. 终端浮窗与授权/提示词/明确投递，默认来源查询。
4. 同一套双后端契约测试覆盖CRUD、树边界/删除、状态汇总、版本冲突、幂等、跨后端读写/重启、令牌范围/撤销/到期及实时事件。
5. 隔离接收端执行提示词中列出的真实HTTP调用，真实浏览器两个标签页实时同步和390px布局，检查终端尺寸未变；保留Chrome/noVNC。
6. 按上述顺序实现后，统一运行测试和顺序构建，再检查最新构建的浏览器结果。结果如下。

## 实现入口

- src/todos.ts：状态、树校验、汇总、CRUD 规则和提示词模板。
- src/todo-store.ts、src/todo-http.ts：Bun 持久化、令牌、CRUD、SSE、提示词和明确投递；src/server.ts 挂载接口。
- rust/todos.rs、rust/main.rs：相同接口和磁盘契约的 Rust 实现。
- src/todo-ui.ts、public/index.html、public/style.css、src/i18n.ts：主页浮窗、编辑表单、授权管理、中文/英文文案。
- src/preview-edit-service.ts、rust/preview_edits.rs：抽出显式文本投递入口，保留预览提示词构建与原有回执机制。
- test/todos.test.ts、test/todo-http.test.ts、test/todo-ui.test.ts：模型、双后端契约和 UI 行为测试。
- test/fixtures/todo-agent.ts、test/fixtures/todo-browser-harness.ts：隔离接收端与保留的浏览器验收服务。

## 使用步骤

1. 登录终端主页，点击右侧清单图标，创建项目。选择项目后添加任务或清单。
2. 用行末编辑按钮修改标题、说明、父清单、项目或排序；直接用叶子行下拉框改状态。文件夹汇总自动计算。
3. 点击“更新提示词”，选择当前项目或明确勾选全清单，填写 agent 实际可访问的 Shelt 地址，选择有效期后生成。
4. 复制提示词，或核对默认 agent 后明确点击发送。生成、复制和刷新列表均不投递消息。收到提示词和投递成功均不表示任务完成。
5. agent 使用临时 Bearer 调用 /api/todos，只按实际工作结果更新。授权列表可撤销；撤销后下一次请求拒绝，相关 SSE 在检查周期内关闭。

## 验证结果如下

[COMPUTED HIGH] 以下命令在本任务工作区执行，最终退出码均为0：

| 检查 | 实际结果 |
| --- | --- |
| bun run typecheck | 通过 |
| $HOME/.cargo/bin/cargo fmt --check | 通过 |
| $HOME/.cargo/bin/cargo clippy --all-targets -- -D warnings | 通过 |
| $HOME/.cargo/bin/cargo test | 51 passed，0 failed |
| bun run build → $HOME/.cargo/bin/cargo build | 按此顺序通过，随后用最新 Rust 构建验收 |
| bun test | 220 pass，1 skip，0 fail；45个文件 |
| SHELT_TEST_RUST=1 bun test | 234 pass，0 fail；45个文件 |
| git diff --check | 通过 |

- 默认模式跳过的1项为跨 Bun/Rust 重启回执测试；已在 SHELT_TEST_RUST=1 中实际执行通过。
- 初次命令链在 typecheck 通过后因 PATH 缺少 cargo 退出127。随后改用项目 package.json 指定的 $HOME/.cargo/bin/cargo 跑完其余检查；未跳过失败检查。
- 完整输出：/home/admin/.qwen/tmp/2fdea3689b4bfe4e97aa4f9fdccf9e0e2009fb03b54a905975cff053b4cc103c/background-shells/76e3a58a-9275-40e2-9df8-55e5b4eb1731/shell-bg_ab66536e.output。

[COMPUTED HIGH] 浏览器与接收端实测：

- 最新构建登录后默认收起。桌面1432×909，面板x=1042、y=98、宽380、高511.5；展开前后终端均1432×909。
- 390×844窄屏，面板x=10、y=322.5、宽370、底边834；document.scrollWidth=390，无横向溢出。
- 创建项目、嵌套清单、叶子改状态、重开、隐藏完成、折叠、编辑标题、排序和父节点移动；非空删除先取消保留，再明确确认删除。确认文案包含子项数量。
- 两个标签页实际同步状态；最终保留5行，其中一个任务待处理、另一个任务已完成，父级汇总1/2。
- 从实际连接 UI 切到“待办连接切换验收”后，完整待办快照与版本22保持一致；已切回“本机 Herdr”。远程地址 editor@fixture.test 由隔离 fake SSH 接收，没有访问真实主机。
- 对 SSE 注入一次 ConnectionReset 后观察到2次事件请求，自动恢复“● 实时同步”与5行；停止隔离服务时显示离线并保留内容。重启后重新登录，磁盘数据仍保留。
- 生成及复制时接收数为0；明确发送并连续点击后接收数为1。接收端先确认 durable pending 回执，再执行12个实际 HTTP 请求，含 GET/POST/PATCH/DELETE，全部200；浏览器看到“Agent 实际同步任务”已完成。全清单的项目创建、改名、删除另由双后端契约测试覆盖。
- 项目权限、其他 API 拒绝、到期、撤销、409、创建幂等和跨后端磁盘恢复均有自动测试。令牌未写入接收记录、投递回执和 todos.json 明文，最终截图中的提示词输入框为空，测试授权已撤销。

## 证据与保留资源

以下路径均相对于任务工作区，不含令牌正文：

- .qwen/tmp/todo-evidence/desktop.png：最新桌面截图。
- .qwen/tmp/todo-evidence/mobile.png：最新390px截图。
- .qwen/tmp/todo-evidence/verification.json：DOM尺寸、树状态、连接切换、SSE重连、脱敏HTTP结果和测试计数。
- 隔离页面 http://127.0.0.1:24866/；控制服务 http://127.0.0.1:24867，仅本任务使用。
- Bun harness PID843445，最新 Rust 子进程 PID2251706；任务 bg_0ee2076e。状态目录 /tmp/shelt-preview-edits-4oSS6x/state，保留测试数据。
- Chrome PID272045，任务 bg_a15750eb，CDP9227，profile .qwen/tmp/todo-chrome，DISPLAY=:99，保留桌面标签页。
- 共享 Xvfb PID1993930；x11vnc PID1994794，5999；websockify PID1994803，6080。未重启或关闭这些共享服务及其他 Chrome。
- 查看同一画面：VSCode Remote SSH 转发远端6080后，浏览器打开 http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale。也可转发24866直接访问隔离页面。
- .qwen/tmp、Chrome profile 和证据均为本地保留资源，不是待提交源码；后续提交须精确选择本功能文件。dist/、target/保持原有忽略状态。

## 范围核对与剩余边界

[COMPUTED HIGH] 主工作区 tracked diff 的 SHA256 仍为60728aa784b8b3f666fc69b8aa1bcdc96a9bc5c7078869987611e1cf04d302cd。任务中的 public/preview.html、src/terminal-tts.ts、test/terminal-tts.test.ts 无差异；依赖清单和锁文件无差异。未改 qwen-code/herdr，未提交、推送或部署。

- 统一清单属于同一 SHELT_STATE_DIR；切换 Herdr 连接共享此清单，不代表不同 Shelt 安装之间自动同步。
- 登录会话仍用既有内存机制，服务重启后需重新登录；待办数据和授权哈希保留。待发送提示词只在内存，重启后需重新生成，旧授权仍可在列表中撤销。
- 真实用户 agent 未投递；当前执行证据来自隔离接收端。网络地址可达性、实际 agent 是否按提示词工作仍取决于部署环境和目标 agent。
- Herdr 投递没有外部幂等键，遇到不确定结果保留同一次请求并要求检查目标，不承诺外部 exactly-once。
- 尚未提交、发布或进行生产验收；这些动作需要后续授权。保留工作区和浏览器，方便查看与继续。
