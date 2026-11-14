#!/bin/sh
# Offline installer for a magicshell bundle. Never uses the network and never calls sudo.
set -eu

usage() {
  echo "Usage: install.sh --archive FILE [--system] [--prefix DIR]" >&2
  exit 2
}

archive=""
system=0
prefix="${HOME:-}/.local"
while [ $# -gt 0 ]; do
  case "$1" in
    --archive) [ $# -ge 2 ] || usage; archive=$2; shift 2 ;;
    --system) system=1; prefix=/usr/local; shift ;;
    --prefix) [ $# -ge 2 ] || usage; prefix=$2; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done
[ -n "$archive" ] || usage
[ -f "$archive" ] || { echo "Archive not found: $archive" >&2; exit 1; }

if [ "$system" -eq 1 ] && [ "$(id -u)" -ne 0 ]; then
  echo "Run as root for --system; this script never calls sudo." >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tar -C "$work" -xzf "$archive"
set -- "$work"/*/
[ $# -eq 1 ] && [ -d "$1" ] || { echo "The archive should contain exactly one directory." >&2; exit 1; }
bundle=${1%/}

cd "$bundle"
if ! sha256sum -c --quiet SHA256SUMS > "$work/check.log" 2>&1; then
  bad=$(grep -v ': OK$' "$work/check.log" | head -n 1 | cut -d: -f1)
  echo "Checksum mismatch: ${bad:-SHA256SUMS}. The bundle is damaged or was altered." >&2
  exit 1
fi

app=$(head -n 1 name)
case "$app" in
  ''|*[!a-z0-9_-]*) echo "The bundle names an invalid app: $app" >&2; exit 1 ;;
esac

mkdir -p "$prefix/bin"
install -m 0755 "$app" "$prefix/bin/$app"
echo "Installed $prefix/bin/$app"

if [ "$system" -eq 1 ]; then
  install -m 0644 "$app.service" "/etc/systemd/system/$app.service"
  mkdir -p "/etc/$app"
  if [ ! -f "/etc/$app/config.toml" ]; then
    # World-readable because the service runs as a dynamic user; secrets go through LoadCredential=.
    # data_dir is switched on so that shell commands use the service's database, not one of their own.
    sed "s|^# data_dir = \"/var/lib/magicshell\"\$|data_dir = \"/var/lib/$app\"|" config.example.toml > "$work/config.toml"
    if ! grep -q "^data_dir = \"/var/lib/$app\"\$" "$work/config.toml"; then
      echo "The bundled config.example.toml has no data_dir line to switch on." >&2
      exit 1
    fi
    install -m 0644 "$work/config.toml" "/etc/$app/config.toml"
    echo "Wrote /etc/$app/config.toml; set public_url before starting. Keep secrets out of it (see AIRGAP.md)."
  elif ! grep -q '^data_dir[[:space:]]*=' "/etc/$app/config.toml"; then
    echo "Add data_dir = \"/var/lib/$app\" to /etc/$app/config.toml so the user commands find the service's database."
  fi
  echo "Installed /etc/systemd/system/$app.service. Start it with: systemctl daemon-reload && systemctl enable --now $app"
  echo "Add users with: sudo $app --config /etc/$app/config.toml user add NAME"
fi

doc="$prefix/share/$app"
mkdir -p "$doc"
for f in nginx.conf AIRGAP.md THIRD-PARTY-LICENSES config.example.toml; do
  [ -f "$f" ] && install -m 0644 "$f" "$doc/$f"
done
echo "Reverse proxy template: $doc/nginx.conf"
