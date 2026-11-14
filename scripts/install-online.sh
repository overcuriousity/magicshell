#!/bin/sh
# Downloads a magicshell release bundle for this machine, checks it and hands it to the bundled
# install.sh with the arguments given here (--system, --prefix DIR). Running it again updates.
#
#   curl -fsSL https://raw.githubusercontent.com/overcuriousity/magicshell/main/scripts/install-online.sh | sudo sh -s -- --system
#
# Needs curl or wget. Never calls sudo. Settings, passed after sudo (sudo VAR=value sh -s -- ...):
#   MAGICSHELL_VERSION      release tag to install, for example v2026.11.8; default: the latest
#   MAGICSHELL_VERIFY=1|0   1: require a verified build provenance attestation (needs the gh CLI);
#                           0: skip it; unset: verify when gh is installed, warn if that fails
#   MAGICSHELL_RELEASE_URL  replaces the download address (mirrors, tests)
# The bundled install.sh reads the settings of a first install (MAGICSHELL_ENDPOINT, ...); see it.
#
# The whole script is one function called on the last line, so a cut-off download runs nothing.
set -eu

fail() { echo "$*" >&2; exit 1; }

main() {
  repo=overcuriousity/magicshell
  # Before the download: `sudo curl ... | sh` runs this script as the calling user.
  for arg in "$@"; do
    if [ "$arg" = --system ] && [ "$(id -u)" -ne 0 ]; then
      fail "--system needs root. Put sudo on the sh after the pipe: curl -fsSL https://raw.githubusercontent.com/$repo/main/scripts/install-online.sh | sudo sh -s -- --system"
    fi
  done

  if [ -n "${MAGICSHELL_VERSION:-}" ]; then
    base=https://github.com/$repo/releases/download/$MAGICSHELL_VERSION
  else
    base=https://github.com/$repo/releases/latest/download
  fi
  base=${MAGICSHELL_RELEASE_URL:-$base}
  base=${base%/}

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

  echo "Downloading $name"
  fetch "$base/$name" "$work/$name" || fail "Could not download $base/$name."
  awk -v name="$name" '$2 == name || $2 == "*" name { print; exit }' "$work/SHA256SUMS" > "$work/expected"
  (cd "$work" && verify expected) || fail "Checksum mismatch for $name. The download is damaged or was altered."

  # The checksum comes from the same server as the bundle: it shows the download is intact, the
  # attestation shows this repository's release workflow built it.
  case "${MAGICSHELL_VERIFY:-}" in
    0) ;;
    *)
      if command -v gh >/dev/null 2>&1; then
        if gh attestation verify "$work/$name" --repo "$repo" > "$work/attestation.log" 2>&1; then
          echo "Build provenance verified."
        elif [ "${MAGICSHELL_VERIFY:-}" = 1 ]; then
          cat "$work/attestation.log" >&2
          fail "The build provenance attestation did not verify (MAGICSHELL_VERIFY=1)."
        else
          echo "Warning: could not verify the build provenance (gh may need 'gh auth login'); relying on the checksum." >&2
        fi
      elif [ "${MAGICSHELL_VERIFY:-}" = 1 ]; then
        fail "MAGICSHELL_VERIFY=1 needs the GitHub CLI (gh) to verify the build provenance."
      fi
      ;;
  esac

  mkdir "$work/bundle"
  tar -C "$work/bundle" -xzf "$work/$name"
  set -- "$work/bundle"/*/ "$@"
  dir=${1%/}
  shift
  [ -f "$dir/install.sh" ] || fail "The bundle has no install.sh."
  sh "$dir/install.sh" --archive "$work/$name" "$@"
}

main "$@"
