#!/usr/bin/env bash
set -euo pipefail

binary="${1:-release/shelt-linux-x86_64-musl}"

if [[ ! -f "$binary" ]]; then
  echo "Missing Linux musl executable: $binary" >&2
  exit 1
fi

if readelf -lW "$binary" | grep -q ' INTERP '; then
  echo "Linux musl executable must not contain a PT_INTERP segment" >&2
  readelf -lW "$binary" >&2
  exit 1
fi

if readelf -dW "$binary" | grep -Eq 'NEEDED.*libc\.so\.6'; then
  echo "Linux musl executable must not depend on libc.so.6" >&2
  readelf -dW "$binary" >&2
  exit 1
fi

if readelf --version-info "$binary" | grep -q 'GLIBC_'; then
  echo "Linux musl executable must not contain GLIBC_ version requirements" >&2
  readelf --version-info "$binary" >&2
  exit 1
fi

printf 'Verified static Linux musl ABI: %s\n' "$binary"
