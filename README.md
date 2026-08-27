# Shelt

Shelt is a minimal web terminal with clipboard image paste. By default it attaches to the existing default Herdr session
when Herdr is installed; without Herdr it automatically opens the current user's login shell. The
browser surface is a single xterm.js terminal — no tabs, sidebar, composer, or other business UI is
recreated by Shelt.

## Modes

```text
SHELT_MODE=auto    # default: Herdr when available, otherwise the current shell
SHELT_MODE=herdr   # require Herdr 0.8.2+
SHELT_MODE=shell   # always open a normal shell
```

Shell selection order is `SHELT_SHELL`, `$SHELL`, the passwd login shell, then `bash`, `zsh`, `sh`.
Commands are spawned directly as argument arrays; Shelt never passes configuration through
`/bin/sh -c`.

In either mode, keyboard, mouse, resize, text paste, and image paste share the same PTY path. Pasting
an image with Ctrl+V / Cmd+V saves it on the host with private permissions and pastes its absolute
path at the current terminal cursor.

## Requirements

- Bun 1.3.14 or newer for building the browser client
- Rust 1.95 or newer for building the native server
- Herdr 0.8.2 or newer only when using Herdr mode

## Standalone executable

Build one self-contained Linux executable:

```bash
bun install
bun run compile
./release/shelt
```

Running `shelt` starts a background daemon, prints a clickable URL, and returns to the shell. Use
`shelt status`, `shelt stop`, `shelt restart`, or `shelt foreground` for lifecycle control.

The executable is a native Rust server with the browser assets embedded. It does not need Bun, Rust,
`node_modules`, `dist`, or the source repository at runtime. Click the printed
`http://127.0.0.1:8790` link to open Shelt.

## Run from source

```bash
bun install
bun run build
$HOME/.cargo/bin/cargo run -- foreground
```

Open `http://127.0.0.1:8790`.

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
```

Keep Shelt on loopback. Put an authenticated private HTTPS reverse proxy in front when remote access
is needed. Do not expose it publicly: anyone who can connect can control the terminal.

Only one browser controller is active at a time. Opening a newer controller disconnects the older
one so terminal size, mouse coordinates, and keyboard ownership stay unambiguous.

The repository includes `herdr-plugin.toml`, so Herdr users can install or link it as a plugin. The
standalone Shell mode does not depend on Herdr.
