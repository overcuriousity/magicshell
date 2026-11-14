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

version=$("./$app" --version 2>/dev/null | cut -d" " -f2 || true)
bin="$prefix/bin/$app"
updating=0
[ -e "$bin" ] && updating=1

# systemd is running, and the service with it: an update restarts it, so the new version runs.
systemd=0
[ "$system" -eq 1 ] && [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 && systemd=1
running=0
[ "$systemd" -eq 1 ] && systemctl is-active --quiet "$app" && running=1

mkdir -p "$prefix/bin"
# A new file renamed over the old one: a running program keeps its own copy, and nothing ever
# sees half a binary.
install -m 0755 "$app" "$prefix/bin/.$app.new"
mv -f "$prefix/bin/.$app.new" "$bin"
if [ "$updating" -eq 1 ]; then echo "Updated $bin to ${version:-the bundled version}"; else echo "Installed $bin"; fi

if [ "$system" -eq 1 ]; then
  # Local changes to the unit belong in a drop-in (systemctl edit), so the unit itself is replaced.
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
  echo "Installed /etc/systemd/system/$app.service."
  [ "$systemd" -eq 1 ] && systemctl daemon-reload
  if [ "$running" -eq 1 ]; then
    systemctl restart "$app"
    sleep 1
    if systemctl is-active --quiet "$app"; then
      echo "Restarted $app; it now runs $("$bin" --version 2>/dev/null || echo "the new version")."
    else
      echo "$app did not come back after the restart. See: journalctl -u $app -n 50" >&2
      exit 1
    fi
  elif [ "$systemd" -eq 1 ] && systemctl is-enabled --quiet "$app" 2>/dev/null; then
    echo "$app is enabled but not running. Start it with: systemctl start $app"
  else
    echo "Start it with: systemctl daemon-reload && systemctl enable --now $app"
  fi
  echo "Add users with: sudo $bin --config /etc/$app/config.toml user add NAME"
elif [ "$updating" -eq 1 ] && command -v pgrep >/dev/null 2>&1 && pgrep -x "$app" >/dev/null 2>&1; then
  echo "A $app process is running; restart it to use the new version."
fi

doc="$prefix/share/$app"
mkdir -p "$doc"
for f in nginx.conf AIRGAP.md THIRD-PARTY-LICENSES config.example.toml; do
  [ -f "$f" ] && install -m 0644 "$f" "$doc/$f"
done
echo "Reverse proxy template: $doc/nginx.conf"
