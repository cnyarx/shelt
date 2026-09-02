# Shelt Linux musl build handoff

## Problem evidence

A Linux environment using glibc 2.17 could not load the previous default `release/shelt`, which was an `x86_64-unknown-linux-gnu` dynamically linked ELF. Local `readelf` verification showed:

- a `PT_INTERP` entry for `/lib64/ld-linux-x86-64.so.2`
- `NEEDED` entries for `libc.so.6`, `libm.so.6`, and `libgcc_s.so.1`
- GLIBC requirements through `GLIBC_2.39`, including versions newer than 2.17

The loader therefore rejects lifecycle commands before application code can run, and the service port is never opened. A static Linux build avoids this host glibc dependency.

## Intended final state

- Default Linux target: `x86_64-unknown-linux-musl`
- Default executable: `release/shelt-linux-x86_64-musl`
- Checksum: `release/shelt-linux-x86_64-musl.sha256`
- Cargo source path: `target/x86_64-unknown-linux-musl/release/shelt`
- Release artifact and GitHub Release asset names explicitly include `musl`
- The release is accepted only when it has no `PT_INTERP`, no `libc.so.6` `NEEDED` entry, and no `GLIBC_` version symbols

`src/compile.ts` also accepts `--target <triple>`, `--target=<triple>`, or `SHELT_RUST_TARGET` for explicit non-default builds. Those outputs are named `release/shelt-<target-triple>`.

## Source changes prepared

- `src/compile-target.ts`: target parsing, target-specific Cargo output paths (including relative or absolute `CARGO_TARGET_DIR`), and release naming
- `src/compile.ts`: passes `--target`, copies the target-specific binary, and writes SHA-256 output
- `scripts/check-linux-musl.sh`: ELF ABI gate
- `scripts/shelt-ctl.sh`: uses the explicitly named musl executable by default
- `test/compile.test.ts`: target parsing/path/naming tests
- `.github/workflows/code-review.yml`: installs the musl target/toolchain, builds the default musl executable, runs the ABI gate, uploads binary plus checksum
- `.github/workflows/release.yml`: builds and verifies musl, publishes explicitly named musl assets
- `README.md` and `README.zh-CN.md`: static musl compatibility and build semantics

## Local verification results

The musl target was installed successfully through the configured Rust mirror. The final local build used the Rust toolchain's existing `rust-lld` and produced:

- `release/shelt-linux-x86_64-musl`
- `release/shelt-linux-x86_64-musl.sha256`

Verification completed successfully:

- Bun production build
- 35 Bun tests
- TypeScript type checking
- `cargo fmt --check`
- `cargo clippy -- -D warnings`
- 9 Rust tests
- checksum verification
- GitHub Actions YAML parsing
- shell syntax checks for `scripts/check-linux-musl.sh` and `scripts/shelt-ctl.sh`
- an actual compile with relative `CARGO_TARGET_DIR=target`; unit tests also cover relative and absolute custom target directories

Direct ELF inspection showed:

- ELF64 x86-64 static PIE
- no `PT_INTERP` segment
- no `NEEDED` entries, including no `libc.so.6`
- no `GLIBC_` version information
- `ldd` reports `statically linked`

An Alpine 3.20 / musl 1.2.5 container lifecycle run passed `start`, `status`, `/health`, and `stop` with `health={"ok":true}`.

A disposable Debian container also exercised download, runtime compatibility preflight, non-root execution, daemon restart/status, HTTP health, and stop successfully. That test exposed a general directory ownership requirement: callers should set `SHELT_UPLOAD_DIR` to a path writable by the service user when the configured state tree may be owned by another user.

No ALinux 7 / glibc 2.17 image was available locally. Because the binary has no interpreter, no `NEEDED` libraries, and no `GLIBC_` version requirements, the exact ALinux 7 lifecycle remains the final deployment-environment acceptance check rather than an unresolved libc dependency.

## Reproduction commands

```bash
bun run build
bun test
bun run typecheck
$HOME/.cargo/bin/cargo fmt --all -- --check
$HOME/.cargo/bin/cargo clippy --all-targets --all-features -- -D warnings
$HOME/.cargo/bin/cargo test --all-targets --all-features
rust_lld="$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/lib/rustlib/x86_64-unknown-linux-gnu/bin/rust-lld"
CARGO_TARGET_DIR=target \
CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER="$rust_lld" \
bun run compile
bun run check:linux-musl
```

Direct ELF evidence:

```bash
readelf -lW release/shelt-linux-x86_64-musl
readelf -dW release/shelt-linux-x86_64-musl
readelf --version-info release/shelt-linux-x86_64-musl
objdump -p release/shelt-linux-x86_64-musl
ldd release/shelt-linux-x86_64-musl
```

Runtime compatibility should cover `start`, `status`, `/health`, and `stop` in ALinux 7/glibc 2.17 when that environment becomes available. The successful pure-musl Alpine run demonstrates that no glibc runtime is required, but it does not replace that exact-environment check.

## Current local environment

- Rust toolchain: 1.95.0
- Installed targets include `x86_64-unknown-linux-musl`
- Linker used for the successful musl build: the existing Rust `rust-lld`
- No dependency on Zig, `wit.exe`, `musl-gcc`, or `x86_64-linux-musl-gcc`
- ELF tools: GNU `readelf` and `objdump`
- No local ALinux 7/glibc 2.17 image or host was available
- Alpine 3.20 lifecycle and disposable Debian lifecycle were both repeated successfully

## Operational guardrails

Remaining actions must not:

- publish a GitHub Release without a separate release decision
- claim exact ALinux 7 end-to-end acceptance before the binary has run in that environment
- replace the musl final state with an older Ubuntu GNU build workaround

The Shelt source changes may now be submitted using Aone 85976324 as authorized.
