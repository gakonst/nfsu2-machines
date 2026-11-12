#!/usr/bin/env sh
# Fetch the pinned Zig toolchain into ./zig/, verifying its checksum.
# A shell script because it is the bootstrap that obtains Zig (as tempoxyz/zempo's zig/download.sh).
set -eu

ZIG_RELEASE="0.16.0"
ZIG_MIRROR="https://ziglang.org/download"
ZIG_CHECKSUMS=$(cat <<CHECKSUMS
x86_64-linux 70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00
aarch64-linux ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17
aarch64-macos b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489
x86_64-macos 0387557ed1877bc6a2e1802c8391953baddba76081876301c522f52977b52ba7
CHECKSUMS
)

ZIG_ARCH="$(uname -m)"
[ "$ZIG_ARCH" = "arm64" ] && ZIG_ARCH="aarch64"
ZIG_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
[ "$ZIG_OS" = "darwin" ] && ZIG_OS="macos"
ZIG_TARGET="$ZIG_ARCH-$ZIG_OS"
ZIG_CHECKSUM="$(printf '%s\n' "$ZIG_CHECKSUMS" | awk -v t="$ZIG_TARGET" '$1 == t { print $2 }')"
[ -n "$ZIG_CHECKSUM" ] || { printf 'zig/download.sh: unsupported target %s\n' "$ZIG_TARGET" >&2; exit 1; }

ZIG_DIRECTORY="$(cd "$(dirname "$0")" && pwd)"
ZIG_TARBALL="zig-$ZIG_TARGET-$ZIG_RELEASE.tar.xz"
if [ -x "$ZIG_DIRECTORY/zig" ] && [ "$("$ZIG_DIRECTORY/zig" version 2>/dev/null || echo none)" = "$ZIG_RELEASE" ]; then
    printf 'zig %s already present\n' "$ZIG_RELEASE"; exit 0
fi
printf 'downloading %s\n' "$ZIG_TARBALL"
curl --fail --silent --show-error --location --output "/tmp/$ZIG_TARBALL" "$ZIG_MIRROR/$ZIG_RELEASE/$ZIG_TARBALL"
if command -v sha256sum >/dev/null; then SUM="$(sha256sum "/tmp/$ZIG_TARBALL" | cut -d' ' -f1)"; else SUM="$(shasum -a 256 "/tmp/$ZIG_TARBALL" | cut -d' ' -f1)"; fi
[ "$SUM" = "$ZIG_CHECKSUM" ] || { printf 'zig/download.sh: CHECKSUM MISMATCH (%s)\n' "$SUM" >&2; rm -f "/tmp/$ZIG_TARBALL"; exit 1; }
rm -rf "$ZIG_DIRECTORY/lib" "$ZIG_DIRECTORY/doc" "$ZIG_DIRECTORY/zig"
tar -xJf "/tmp/$ZIG_TARBALL" -C "$ZIG_DIRECTORY" --strip-components=1
rm -f "/tmp/$ZIG_TARBALL"
printf 'zig %s ready\n' "$("$ZIG_DIRECTORY/zig" version)"
