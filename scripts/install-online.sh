#!/bin/sh
# Downloads the latest magicshell release bundle for this machine, checks it against SHA256SUMS
# and hands it to the bundled install.sh with the arguments given here (--system, --prefix DIR).
# Needs curl or wget. Never calls sudo. MAGICSHELL_RELEASE_URL replaces the release download address.
set -eu

base=${MAGICSHELL_RELEASE_URL:-https://github.com/overcuriousity/magicshell/releases/latest/download}
base=${base%/}

fail() { echo "$*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || fail "magicshell releases are built for Linux only."
case "$(uname -m)" in
  x86_64|amd64) arch=x86_64 ;;
  aarch64|arm64) arch=aarch64 ;;
  *) fail "Unsupported processor: $(uname -m). Releases exist for x86_64 and aarch64." ;;
esac

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  fail "Install curl or wget first."
fi

if command -v sha256sum >/dev/null 2>&1; then
  verify() { sha256sum -c --quiet "$1"; }
elif command -v shasum >/dev/null 2>&1; then
  verify() { shasum -a 256 -c --quiet "$1"; }
else
  fail "Install sha256sum or shasum to verify the download."
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fetch "$base/SHA256SUMS" "$work/SHA256SUMS" || fail "Could not download $base/SHA256SUMS."
name=$(sed -n "s/^[0-9a-f]*[ *]*\\(magicshell-.*-$arch-unknown-linux-musl-offline\\.tar\\.gz\\)\$/\\1/p" "$work/SHA256SUMS" | head -n 1)
[ -n "$name" ] || fail "SHA256SUMS lists no bundle for $arch."

fetch "$base/$name" "$work/$name" || fail "Could not download $base/$name."
awk -v name="$name" '$2 == name || $2 == "*" name { print; exit }' "$work/SHA256SUMS" > "$work/expected"
(cd "$work" && verify expected) || fail "Checksum mismatch for $name. The download is damaged or was altered."

mkdir "$work/bundle"
tar -C "$work/bundle" -xzf "$work/$name"
set -- "$work/bundle"/*/ "$@"
dir=${1%/}
shift
[ -f "$dir/install.sh" ] || fail "The bundle has no install.sh."
sh "$dir/install.sh" --archive "$work/$name" "$@"
