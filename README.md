# Shelt

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
- One self-contained native executable with embedded browser assets
- Background daemon lifecycle commands: `start`, `stop`, `restart`, `status`, `url`, and `logs`
- Herdr plugin manifest included

Shelt deliberately does not recreate tabs, sidebars, composers, or other application UI. The browser displays the terminal exactly as the underlying program renders it.

## Requirements

Build requirements:

- Bun 1.3.14 or newer
- Rust 1.95 or newer
- Linux for the standalone executable

Runtime requirements:

- No Bun, Rust, `node_modules`, or source checkout is required after compilation
- Herdr 0.8.2 or newer is optional and only required for Herdr mode

## Build

```bash
git clone https://github.com/cnyarx/shelt.git
cd shelt
bun install --frozen-lockfile
bun run compile
```

The self-contained executable is created at `release/shelt`.

## Usage

Start Shelt as a background daemon:

```bash
./release/shelt
```

Open the printed URL, which defaults to:

```text
http://127.0.0.1:8790
```

Lifecycle commands:

```bash
./release/shelt start
./release/shelt stop
./release/shelt restart
./release/shelt status
./release/shelt url
./release/shelt logs
./release/shelt foreground
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
SHELT_UPLOAD_DIR=
SHELT_STATE_DIR=
```

Only one browser controller is active at a time. A new controller disconnects the previous one so terminal size, mouse coordinates, and keyboard ownership remain unambiguous.

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
$HOME/.cargo/bin/cargo test
$HOME/.cargo/bin/cargo check
```

## License

[MIT](LICENSE)
