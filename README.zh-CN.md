# Shelt

<p align="center">
  <img src="public/favicon.png" alt="Shelt logo" width="160" height="160" />
</p>

一个面向 Herdr 或用户登录 Shell 的极简、自包含 Web 终端，支持可靠的 Unicode 渲染和剪贴板图片粘贴。

[English](README.md) · 简体中文

Shelt 通过单一 xterm.js 界面在浏览器中提供真实 PTY。检测到 Herdr 时，它会连接现有的默认共享 Herdr 会话；否则自动打开当前用户的登录 Shell。

## 主要功能

- 连接现有的 Herdr 默认共享会话，不创建额外 session
- Herdr 不可用时自动回退到当前用户的登录 Shell
- 正确显示中文、Emoji、组合字符和终端边框字符
- 支持键盘、鼠标、窗口缩放和文本粘贴
- 支持通过 `Ctrl+V` / `Cmd+V` 粘贴图片：图片以私有权限保存，并将绝对路径插入终端
- 支持经过大小和格式校验的 OSC 52 剪贴板复制
- 终端中的绝对路径可点击，只读预览 Markdown、静态 HTML、SVG 和图片
- Markdown 使用轻量 Mermaid 渲染，支持流程图、时序图、类图、状态图和 ER 图
- 浏览器资源嵌入原生可执行文件，构建后可独立运行
- 支持 `start`、`stop`、`restart`、`status`、`url`、`logs` 等后台服务命令
- 仓库内置 Herdr 插件清单

Shelt 不会重新实现标签页、侧栏、输入框等业务界面。浏览器只负责忠实显示底层程序输出的终端内容。

## 环境要求

构建环境：

- Bun 1.3.14 或更高版本
- Rust 1.95 或更高版本
- 默认 Linux release 需要 Rust `x86_64-unknown-linux-musl` target 和 musl linker
- macOS Apple Silicon 构建需要在 Apple Silicon Mac 上安装 Rust `aarch64-apple-darwin` target

运行环境：

- 编译完成后不依赖 Bun、Rust、`node_modules` 或源码目录
- 默认 `shelt-linux-x86_64-musl` 是静态 musl ELF，不依赖目标机器的 glibc，可运行在包括 glibc 2.17 在内的环境
- `shelt-macos-aarch64` 可在包括 M4 在内的 Apple Silicon Mac 上原生运行
- Herdr 0.8.2 或更高版本为可选依赖，仅 Herdr 模式需要

## 构建

```bash
git clone https://github.com/cnyarx/shelt.git
cd shelt
bun install --frozen-lockfile
rustup target add x86_64-unknown-linux-musl
bun run compile
bun run check:linux-musl
```

默认构建生成：

```text
release/shelt-linux-x86_64-musl
release/shelt-linux-x86_64-musl.sha256
```

`check:linux-musl` 会拒绝包含程序解释器、依赖 `libc.so.6` 或包含 `GLIBC_` 版本要求的可执行文件。

在 Apple Silicon Mac 上执行以下命令构建原生 macOS release：

```bash
rustup target add aarch64-apple-darwin
bun run build
bun run src/compile.ts --target aarch64-apple-darwin
cd release && shasum -a 256 --check shelt-macos-aarch64.sha256
```

该构建生成 `release/shelt-macos-aarch64` 和 `release/shelt-macos-aarch64.sha256`。其他 Rust target 可通过 `bun run src/compile.ts --target <target-triple>` 或 `SHELT_RUST_TARGET` 指定，产物命名为 `release/shelt-<target-triple>`。

## 使用

以后台服务方式启动：

```bash
./release/shelt-linux-x86_64-musl
# Apple Silicon macOS：
./release/shelt-macos-aarch64
```

打开命令输出的地址，默认是：

```text
http://127.0.0.1:8790
```

服务管理命令：

```bash
./release/shelt-linux-x86_64-musl start
./release/shelt-linux-x86_64-musl stop
./release/shelt-linux-x86_64-musl restart
./release/shelt-linux-x86_64-musl status
./release/shelt-linux-x86_64-musl url
./release/shelt-linux-x86_64-musl logs
./release/shelt-linux-x86_64-musl foreground
```

从源码运行：

```bash
bun install --frozen-lockfile
bun run build
$HOME/.cargo/bin/cargo run -- foreground
```

## 运行模式

```text
SHELT_MODE=auto    # 默认：优先使用 Herdr，否则打开登录 Shell
SHELT_MODE=herdr   # 强制使用 Herdr 0.8.2+
SHELT_MODE=shell   # 强制使用普通 Shell
```

Shell 查找顺序：

1. `SHELT_SHELL`
2. `$SHELL`
3. `/etc/passwd` 中的登录 Shell
4. `bash`、`zsh`、`sh`

命令会以参数数组直接启动，不会通过 `/bin/sh -c` 传递启动配置。

## 配置

```bash
SHELT_MODE=auto
SHELT_SHELL=
SHELT_HERDR_BIN=herdr
SHELT_HOST=127.0.0.1
SHELT_PORT=8790
SHELT_PUBLIC_HOSTS=127.0.0.1:8790,localhost:8790
SHELT_ALLOWED_ORIGINS=
SHELT_PREVIEW_ROOTS=
SHELT_UPLOAD_DIR=
SHELT_STATE_DIR=
SHELT_SECURE_COOKIE=false
```

同一时间只允许一个浏览器 controller。新连接会断开旧连接，避免终端尺寸、鼠标坐标和键盘控制权产生歧义。

## 只读文档预览

终端中以 `.md`、`.markdown`、`.html`、`.htm`、`.svg`、`.png`、`.jpg`、`.jpeg`、`.gif` 或 `.webp` 结尾的 Linux 绝对路径会自动变成可点击链接，并在新标签页中只读预览，不提供编辑或文件管理控件。支持引号包裹、转义空格、中文路径，以及可选的 `:line[:column]` 或 `#LxCy` 后缀。普通相对路径不会自动链接，因为浏览器无法可靠获知 Shell 实时工作目录。

Markdown 支持常用阅读语法、本地相对图片，以及流程图、时序图、类图、状态图和 ER 图五类轻量 Mermaid 预览。不支持的 Mermaid 类型会回退显示原始代码。

预览复用 Shelt 登录 Session。`SHELT_PREVIEW_ROOTS` 是以冒号分隔的允许目录列表，默认使用 `$HOME`。根目录和请求文件都会 canonicalize，因此 `..` 和 symlink 无法越过允许范围。Markdown、HTML/SVG、图片的大小上限分别为 2 MiB、5 MiB 和 20 MiB。Markdown 原始 HTML 会转义；静态 HTML 和 SVG 在禁用脚本、网络请求、表单和顶层导航的 sandbox 中展示。

## 密码访问

新的 Shelt 状态目录首次被浏览器打开时，必须先创建访问密码。Shelt 只会把 Argon2id 密码哈希保存到 `${SHELT_STATE_DIR}/auth.json`，文件权限为仅当前用户可读写。之后必须输入密码，才能使用 WebSocket 终端和图片上传接口。

勾选“Remember this browser”会创建一个有效期 30 天的 `HttpOnly`、`SameSite=Strict` 会话 Cookie，不会把明文密码写入浏览器 JavaScript 存储。会话只保存在服务进程内存中，Shelt 重启后需要重新登录，但已设置的密码仍然有效。

通过 HTTPS 提供 Shelt 时，请设置 `SHELT_SECURE_COOKIE=true`。如果忘记密码，先停止 Shelt，删除 `${SHELT_STATE_DIR}/auth.json`，再重新启动并设置新密码。

## Herdr 插件

仓库包含 `herdr-plugin.toml`，可以将 Shelt 安装或链接为 Herdr 插件，并使用清单中定义的操作。

Shell 模式可以独立运行，不依赖 Herdr。

## 安全说明

Shelt 提供完整的交互式终端能力，能够连接它的人也能控制底层 PTY。

- 默认保持本机回环地址监听
- 不要将 Shelt 直接暴露到公网
- 远程使用时，应放在带身份认证的私有 HTTPS 反向代理之后
- 使用代理或自定义域名时，配置 `SHELT_PUBLIC_HOSTS` 和 `SHELT_ALLOWED_ORIGINS`
- 上传的图片使用私有文件权限保存

## 开发验证

```bash
bun test
bun run typecheck
bun run compile
bun run check:linux-musl
$HOME/.cargo/bin/cargo test
$HOME/.cargo/bin/cargo check
```

## 许可证

[MIT](LICENSE)
