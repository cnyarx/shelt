# Shelt

<p align="center">
  <img src="public/favicon.png" alt="Shelt logo" width="160" height="160" />
</p>

A minimal, self-contained web terminal for Herdr or your login shell, with Unicode-safe rendering and clipboard image paste.

English · [简体中文](README.zh-CN.md)

Shelt exposes a real PTY in the browser through a single xterm.js surface. When Herdr is installed, it attaches to the existing default shared Herdr session. Otherwise, it opens the current user's login shell.

## Features

- Connects to the existing default Herdr session without creating a separate session
- Automatically falls back to the current user's login shell
- Correct terminal-cell rendering for CJK text, emoji, combining characters, and box-drawing glyphs
- Keyboard, mouse, resize, and text paste support over a real PTY
- Clipboard image paste with `Ctrl+V` / `Cmd+V`: saves the image privately and inserts its absolute path
- OSC 52 clipboard copy support with size and format validation
- Clickable absolute paths for read-only Markdown, static HTML, SVG, and image previews
- Lightweight Mermaid rendering in Markdown for flowcharts, sequence, class, state, and ER diagrams
- One self-contained native executable with embedded browser assets
- Background daemon lifecycle commands: `start`, `stop`, `restart`, `status`, `url`, and `logs`
- Herdr plugin manifest included

Shelt deliberately does not recreate tabs, sidebars, composers, or other application UI. The browser displays the terminal exactly as the underlying program renders it.

## Requirements

Build requirements:

- Bun 1.3.14 or newer
- Rust 1.95 or newer
- The `x86_64-unknown-linux-musl` Rust target and a musl linker for the default Linux release
- macOS Apple Silicon builds require the `aarch64-apple-darwin` Rust target on an Apple Silicon Mac

Runtime requirements:

- No Bun, Rust, `node_modules`, or source checkout is required after compilation
- The default `shelt-linux-x86_64-musl` release is a static musl ELF and does not depend on the target system's glibc, including on glibc 2.17 environments
- The `shelt-macos-aarch64` release runs natively on Apple Silicon Macs, including M4
- Herdr 0.8.2 or newer is optional and only required for Herdr mode

## Build

```bash
git clone https://github.com/cnyarx/shelt.git
cd shelt
bun install --frozen-lockfile
rustup target add x86_64-unknown-linux-musl
bun run compile
bun run check:linux-musl
```

The default build creates:

```text
release/shelt-linux-x86_64-musl
release/shelt-linux-x86_64-musl.sha256
```

`check:linux-musl` rejects executables with a program interpreter, a `libc.so.6` dependency, or `GLIBC_` version requirements.

On an Apple Silicon Mac, build the native macOS release with:

```bash
rustup target add aarch64-apple-darwin
bun run build
bun run src/compile.ts --target aarch64-apple-darwin
cd release && shasum -a 256 --check shelt-macos-aarch64.sha256
```

This creates `release/shelt-macos-aarch64` and `release/shelt-macos-aarch64.sha256`. Other explicit Rust targets can be selected with `bun run src/compile.ts --target <target-triple>` or `SHELT_RUST_TARGET`; their output is named `release/shelt-<target-triple>`.

## Usage

Start Shelt as a background daemon:

```bash
./release/shelt-linux-x86_64-musl
# Apple Silicon macOS:
./release/shelt-macos-aarch64
```

Open the printed URL, which defaults to:

```text
http://127.0.0.1:8790
```

Lifecycle commands:

```bash
./release/shelt-linux-x86_64-musl start
./release/shelt-linux-x86_64-musl stop
./release/shelt-linux-x86_64-musl restart
./release/shelt-linux-x86_64-musl status
./release/shelt-linux-x86_64-musl url
./release/shelt-linux-x86_64-musl logs
./release/shelt-linux-x86_64-musl foreground
```

Run from source:

```bash
bun install --frozen-lockfile
bun run build
$HOME/.cargo/bin/cargo run -- foreground
```

## Modes

```text
SHELT_MODE=auto    # Default: use Herdr when available, otherwise use the login shell
SHELT_MODE=herdr   # Require Herdr 0.8.2+
SHELT_MODE=shell   # Always open a normal shell
```

Shell resolution order:

1. `SHELT_SHELL`
2. `$SHELL`
3. The login shell from `/etc/passwd`
4. `bash`, `zsh`, then `sh`

Commands are spawned directly as argument arrays. Shelt never passes launch configuration through `/bin/sh -c`.

## Configuration

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

Only one browser controller is active at a time. A new controller disconnects the previous one so terminal size, mouse coordinates, and keyboard ownership remain unambiguous.

## Read-only document preview

Linux paths ending in `.md`, `.markdown`, `.html`, `.htm`, `.svg`, `.png`, `.jpg`, `.jpeg`, `.gif`, or `.webp` become clickable in the terminal. Preview opens in a new browser tab and never provides editing or file-management controls. Quoted paths, escaped spaces, Unicode names, and optional `:line[:column]` or `#LxCy` suffixes are recognized. In Herdr mode, relative paths are resolved at click time against the focused pane's `foreground_cwd`; shell mode supports absolute paths only.

Markdown supports common reading syntax, local relative images, and lightweight Mermaid previews for flowcharts, sequence diagrams, class diagrams, state diagrams, and ER diagrams. Unsupported Mermaid types fall back to their source code.

Preview access reuses the Shelt login session. `SHELT_PREVIEW_ROOTS` is a colon-separated list of allowed directories and defaults to `$HOME`. Both roots and requested files are canonicalized, so `..` and symlinks cannot escape the allowlist. Markdown is limited to 2 MiB, HTML/SVG to 5 MiB, and images to 20 MiB. Raw Markdown HTML is escaped; static HTML and SVG run in a script-free sandbox with network requests, forms, and top-level navigation blocked.

## Password access

The first browser that opens a new Shelt state directory must create a password. Shelt stores only an Argon2id password hash in `${SHELT_STATE_DIR}/auth.json` with private file permissions. Later visits must enter that password before the WebSocket terminal or image upload API can be used.

"Remember this browser" creates a 30-day `HttpOnly`, `SameSite=Strict` session cookie. The password is never stored in browser JavaScript storage. Sessions are held in memory and are invalidated when Shelt restarts; the password remains configured.

When Shelt is served through HTTPS, set `SHELT_SECURE_COOKIE=true`. If the password is forgotten, stop Shelt, remove `${SHELT_STATE_DIR}/auth.json`, and start it again to create a new password.

## Herdr plugin

The repository includes `herdr-plugin.toml`. Herdr users can install or link Shelt as a plugin and use the actions defined in the manifest.

Shell mode is standalone and does not depend on Herdr.

## Security

Shelt provides interactive terminal access. Anyone who can connect to it can control the underlying PTY.

- Keep the default loopback binding unless remote access is explicitly required
- Do not expose Shelt directly to the public internet
- Use an authenticated private HTTPS reverse proxy for remote access
- Configure `SHELT_PUBLIC_HOSTS` and `SHELT_ALLOWED_ORIGINS` when using a proxy or custom hostname
- Uploaded images are stored with private permissions

## Development

```bash
bun test
bun run typecheck
bun run compile
bun run check:linux-musl
$HOME/.cargo/bin/cargo test
$HOME/.cargo/bin/cargo check
```

## License

[MIT](LICENSE)
