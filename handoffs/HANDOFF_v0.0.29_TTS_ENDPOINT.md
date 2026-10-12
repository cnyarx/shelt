# v0.0.29 TTS 新端点发布交接

## 用户最终需求

微软下线旧 Read Aloud 合成端点后，Shelt v0.0.28 生产环境 `/api/tts` 全量 502（服务器日志上游 WebSocket `403 Forbidden`）。要求按社区新端点方案修改 Shelt 的 Rust 实现，真实实测通过后按标准发布链路（推送 → CI/Release → 部署 44.99 三容器 + 160 → 生产验证）发布 v0.0.29。

该任务已于 2026-10-12 全链路完成，生产 TTS 恢复。本文档记录事实、验证证据与遗留注意事项。

## 根因与改动内容

### 根因

- 旧端点 `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=...` 被 Microsoft 全球分批下线（参考 rany2/edge-tts#490，2026-10-10 起）。
- 新端点：`wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key=<原 TRUSTED_CLIENT_TOKEN>`，`ConnectionId`、`Sec-MS-GEC`、`Sec-MS-GEC-Version` 等参数保持不变。
- 新域名证书链为 `www.msedgeservices.com ← Microsoft TLS G2 ECC CA OCSP 06 ← Microsoft TLS ECC Root G2(交叉签名) ← DigiCert Global Root G3`，原实现只内嵌 G2 根，rustls 报 `invalid peer certificate: UnknownIssuer`。
- 新端点存在随机瞬时 429 限流（快速连续请求时更明显，实测约 2/6 概率；连续请求 14 次出现 4 次），非持续配额。

### 代码改动（commit `00b7066`）

- `rust/edge_tts.rs`：
  - `WSS_BASE` 切换到 `api.msedgeservices.com`，query 首参数改 `Ocp-Apim-Subscription-Key`；URL 构造抽出 `websocket_url_with()` 供测试覆盖实际拼装。
  - 新增 `rust/digicert-global-root-g3.der`（579 字节，来源系统信任库，指纹 `31:AD:66:48:F8:3D:30:95:10:52:7A:1A:EC:90:37:3A:3D:55:44:62:29:A2:61:6C:77:5B:FD:A0:E4:31:D0`，与 `digicert-global-root-g2.der` 并存）。**两个文件必须在同一 commit**（`include_bytes!` 依赖）。
  - `synthesize` 拆为重试外壳 + `synthesize_once`：仅对 HTTP 429 以 1s→2s→4s 指数退避重试共 4 次（TTS_TIMEOUT 45s 预算内），重试时输出日志 `TTS endpoint rate limited; retrying (attempt N/4)`；其他错误原样上抛。
  - `is_rate_limited()` 通过 downcast tungstenite `Error::Http` 判断 429。
- 附带修复（commit `4e714b0`）：集成测试固定端口 34xxx 全部迁移到 24xxx。根因：34xxx 落在系统临时端口范围（32768-60999）内，本机某客户端反复以 34792 为源端口连接 26xxx 本地服务，其 TIME_WAIT（源 socket 无 SO_REUSEADDR，Linux 要求冲突双方都设 reuse 才能跨 TIME_WAIT 绑定）随机阻断测试实例 listener，表现为偶发 `Address already in use`。tokio/mio 的 bind 已设 SO_REUSEADDR 但无法覆盖此场景。

## 验证证据

### 本地（隔离实例 127.0.0.1:43971、独立 state、正规 setup/login）

- 连续 14 个 `/api/tts` 请求全部 HTTP 200 `audio/mpeg`（Xiaoxiao 29,520B、Yunxi 15,696B，同文本输出字节级一致，单次 1.4–2.1s）。
- 日志捕获 4 次 429 全部被内部重试吸收（3 次第 2 次尝试成功、1 次第 3 次成功），零 502 透出。
- MP3 帧头 `ff f3 64 c4` = MPEG2 Layer III 48kbps 24kHz mono，与请求的 `audio-24khz-48kbitrate-mono-mp3` 一致；Chrome AudioContext 解码 4.92s 单声道。
- 门禁：51 Rust tests、183 bun tests、`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、双后端集成测试连续两轮 14/14，全部通过。

### 发布与部署（2026-10-12）

- Release：https://github.com/cnyarx/shelt/releases/tag/v0.0.29（commit `4e714b0`）
- CI：Code Review https://github.com/cnyarx/shelt/actions/runs/38251787867 success；Release https://github.com/cnyarx/shelt/actions/runs/38252042816 success
- 资产：`shelt-linux-x86_64-musl` 3,765,392 字节，sha256 `fff0b645059d77c4501a85d28c95e7552cb7bad56e84c7ef15b5b110f81d80d7`

### 44.99 三容器（替换方式：docker cp staged → 双端 sha 校验 → 备份 → `mv -Tf` 原子替换 → 按原完整 env 重启）

| 容器 | PID | exe 哈希 | health |
|---|---|---|---|
| 0d23474b5139（对外 20229） | 3131044 | `fff0b645…` | 200（容器内 + 宿主外部） |
| 15361581f5af | 3708 | `fff0b645…` | 200 |
| 9bd7327d2418 | 23544 | `fff0b645…` | 200（herdr 模式正常） |

- 备份：两处 `shelt-pre-v0.0.29-backup`（v28，`b6dc991a…`）。
- 数据文件部署前后哈希不变：auth.json `92563c43…`、herdr-targets.json `bc7ee886…`、shares.json `55e4e1b8…`。
- 受保护进程（Herdr server 1795326、debug Shelt 42606/2960648）全程未触碰。

### 生产验收

- 真实登录 0d 实例（11.167.44.99:20229）→ `POST /api/tts` → HTTP 200 `audio/mpeg` 18,576 字节，帧头与格式正确，Chrome 解码 3.10s 单声道。
- 0d 日志中 4 条 403 均为重启前旧 v28 进程产生；新进程启动后零失败。

### 160 分发主机

- `/home/admin/dev_container/shelt_v0.0.29`（sha 校验一致，755），`ln -sfn` 已切软链；`./shelt version` = v0.0.29/4e714b0，`./shelt url` = http://127.0.0.1:8790。只分发未重启。

## 保留资源

- `.qwen/tmp/prod-tts-v29.mp3`：生产实例验证音频（18,576B，已登记 artifact）。
- `.qwen/tmp/tts-endpoint-verify-final.mp3`：本地隔离实例验证音频（29,520B，已登记 artifact）。
- `.qwen/tmp/terminal-tts-preview.png`：v0.0.27 终端朗读功能验收截图。
- 44.99 两处 `shelt-pre-v0.0.29-backup`（v28 回滚用）。

## 遗留注意事项

1. **限流可能再收紧**：新端点是临时逆向协议，Microsoft 后续可能调整。观察各容器 `shelt-<容器id>.log` 中 `TTS endpoint rate limited; retrying` 频次；若重试 4 次仍 429（日志出现 `TTS synthesis failed: HTTP error: 429`），需加大退避或跟进 edge-tts 上游适配。
2. **UA 与 GEC-Version 未做忠实匹配**：沿用原实现的 Android Edge143 UA + `1-130.0.2849.68`，实测新端点当前接受；若上游开始严格校验，需同步 edge-tts 上游的 UA/GEC 组合。
3. **`shelt-pre-v0.0.29-backup` 命名覆盖**：v28 部署时误将 v27 副本放入该名称（无 pre-v0.0.28-backup），本次部署用正确的 v28 备份覆盖了它；v27 仍可从官方 Release 资产取回。后续部署备份命名应严格用 `shelt-pre-vX.Y.Z-backup`（X.Y.Z = 被替换的版本）。
4. **github.com 直连下载当前不可用**（TLS 握手后响应挂起；api.github.com 与 git SSH 正常）：资产下载用 `gh release download`。Range 分块 curl 需 `-L` 且依赖 github.com 可达。
5. **`docker exec -i` stdin 陷阱**：经 ssh 不喂 stdin 会永久挂起，staged 文件用 `docker cp`。
6. 集成测试端口现已全部在 24xxx（临时端口范围外）；9bd 容器内历史泄漏的测试实例仍占 34814/34794（受保护，勿动）。
7. 生产更新只能走 Release 资产 + 双端 SHA 校验（既有约定，禁止 rsync/debug 二进制直覆盖）。

## 下一位 Agent 的执行任务

无待办任务。如需再次发布，按标准链路执行：门禁（bun test / cargo test / 双后端集成 / typecheck / clippy -D warnings / fmt --check）→ commit（含配套资产文件）→ push main → 轮询 CI/Release → `gh release download` 资产并校验 → 44.99 三容器（docker cp + 原子替换 + 原 env 重启）→ 160 分发 → 生产验证（health + 真实业务请求 + 数据文件哈希比对）→ 清理与报告。操作前重新核实实时状态，勿以本文档快照为准。

## 禁止事项

- 不要触碰 9bd 的保护进程（42606、2960648）与 Herdr server（1795326）。
- 不要修改 auth.json / herdr-targets.json / shares.json；herdr-targets.json 的哈希变化属用户/生产状态。
- 不要使用 `shelt restart`（共享 pid 文件跨容器 PID namespace 歧义）。
- 不要提交 `.qwen/`、`docs/images/`、`docs/shelt-internal-guide.md`、`handoffs/` 下未跟踪文件到功能 commit。
- 不要因上游再收紧而回退到旧端点（已确认全球下线）。
