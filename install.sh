#!/bin/sh
# Installs or updates magicshell from an offline bundle. Never uses the network and never calls sudo.
#
#   install.sh --archive FILE [--system] [--prefix DIR]
#
# Without --system: the program goes to ~/.local/bin (or DIR/bin), nothing else is set up.
# With --system (as root): the program goes to /usr/local/bin, and under systemd the service is
# set up and started. Running it again updates: the new version first checks the existing
# configuration and nothing changes if it refuses it; the program, the unit and the database are
# backed up; the service is restarted (or enabled and started) and must answer /healthz, or all
# three are put back and the old version is started again.
#
# A first system install asks for the settings when a terminal is present. Each question can be
# preset, as needed without a terminal:
#   MAGICSHELL_ENDPOINT    model endpoint base URL ending in /v1 (required)
#   MAGICSHELL_MODEL       the model to ask (required)
#   MAGICSHELL_API_KEY     bearer key for the endpoint; kept in /etc/magicshell/api-key, not in the config
#   MAGICSHELL_PUBLIC_URL  https address users see; empty: reached via localhost only
#   MAGICSHELL_BIND        listen address (default 127.0.0.1:8080)
#   MAGICSHELL_MODE        accounts or open (default accounts)
#   MAGICSHELL_USER        first account in accounts mode; empty: none
#   MAGICSHELL_PASSWORD    its password, at least 12 characters (asked when a terminal is present)
# Other settings:
#   MAGICSHELL_FORCE=1     install even when this version already runs
#   MAGICSHELL_TTY         read the answers from this file instead of the terminal (tests)
#
# The whole script is one function called on the last line, so a cut-off copy runs nothing.
set -eu

say() { printf '%s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() { printf '%s\n' "$*" >&2; exit 1; }

usage() {
  echo "Usage: install.sh --archive FILE [--system] [--prefix DIR]" >&2
  exit 2
}

# The sums of the units earlier releases installed: an unit with one of them is unedited.
KNOWN_UNIT_SUMS="0959e2173b3a82efad5633224abe26a3deec6e2849eca5fea155ccfaaf321b7a 62ecb1e3f2b76828bc2ce0dbde7684e36a0e1a53a9ab55fefbed9defd023334e 793daea9424d15d9d4a3707056630e2a6e83eaa0eb360925003fd227c2426513"

sum_of() { sha256sum "$1" | cut -d' ' -f1; }

# One line of `check-config` output: `fact bind FILE`.
fact() { sed -n "s/^$1=//p" "$2" | head -n 1; }

# A TOML basic string's inside.
toml_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# --- questions (first system install) ------------------------------------------------------

# Opens the answers: a file (tests) or the terminal, when it can really be opened.
open_answers() {
  interactive=0
  if [ -n "${MAGICSHELL_TTY:-}" ]; then
    exec 3< "$MAGICSHELL_TTY"
    interactive=1
  elif { exec 3< /dev/tty; } 2>/dev/null; then
    interactive=1
  fi
}

prompt_out() {
  if [ -n "${MAGICSHELL_TTY:-}" ] || ! { true > /dev/tty; } 2>/dev/null; then cat >&2; else cat > /dev/tty; fi
}

# ask VAR "Question" [default]: a preset value is kept; without a terminal the default is taken.
ask() {
  preset=""
  eval "preset=\${$1+set}"
  if [ "$preset" = set ]; then return 0; fi
  if [ "$interactive" -eq 1 ]; then
    if [ -n "${3:-}" ]; then printf '%s [%s]: ' "$2" "$3" | prompt_out; else printf '%s: ' "$2" | prompt_out; fi
    IFS= read -r answer <&3 || answer=""
    [ -n "$answer" ] || answer=${3:-}
  else
    answer=${3:-}
  fi
  eval "$1=\$answer"
}

# ask_secret VAR "Question": like ask, without echo and without a default.
ask_secret() {
  preset=""
  eval "preset=\${$1+set}"
  if [ "$preset" = set ]; then return 0; fi
  answer=""
  if [ "$interactive" -eq 1 ]; then
    printf '%s: ' "$2" | prompt_out
    if [ -z "${MAGICSHELL_TTY:-}" ]; then stty -echo < /dev/tty 2>/dev/null || true; fi
    IFS= read -r answer <&3 || answer=""
    if [ -z "${MAGICSHELL_TTY:-}" ]; then stty echo < /dev/tty 2>/dev/null || true; fi
    printf '\n' | prompt_out
  fi
  eval "$1=\$answer"
}

# Asks for the settings and writes config.toml (and the api key and its drop-in) into $work/new.
# Nothing outside $work is written here.
first_settings() {
  app=$1
  open_answers
  if [ "$interactive" -eq 1 ]; then
    say "First install: a few settings for /etc/$app/config.toml. Enter takes the value in brackets." | prompt_out
  fi
  ask MAGICSHELL_ENDPOINT "Model endpoint base URL (ending in /v1)"
  case "$MAGICSHELL_ENDPOINT" in
    http://?*|https://?*) ;;
    *) die "Set the model endpoint to an http or https URL (MAGICSHELL_ENDPOINT); nothing was installed." ;;
  esac
  ask MAGICSHELL_MODEL "Model name"
  [ -n "$MAGICSHELL_MODEL" ] || die "Set the model (MAGICSHELL_MODEL); nothing was installed."
  ask_secret MAGICSHELL_API_KEY "API key for the endpoint (empty if it needs none)"
  ask MAGICSHELL_PUBLIC_URL "Public https address users see (empty: localhost only)" ""
  case "$MAGICSHELL_PUBLIC_URL" in
    ''|https://?*|http://localhost*|http://127.0.0.1*) ;;
    *) die "The public address must start with https:// (MAGICSHELL_PUBLIC_URL); nothing was installed." ;;
  esac
  ask MAGICSHELL_BIND "Listen address" "127.0.0.1:8080"
  ask MAGICSHELL_MODE "accounts (sign-in, history on the server) or open (no sign-in)" "accounts"
  # shellcheck disable=SC2153 # set by ask
  case "$MAGICSHELL_MODE" in
    accounts|open) ;;
    *) die "Choose accounts or open (MAGICSHELL_MODE); nothing was installed." ;;
  esac
  if [ "$MAGICSHELL_MODE" = accounts ]; then
    ask MAGICSHELL_USER "First account name (empty: add one later)" ""
    if [ -n "$MAGICSHELL_USER" ]; then
      case "$MAGICSHELL_USER" in
        *[!A-Za-z0-9._-]*) die "Use letters, digits, dots, underscores or hyphens in the account name; nothing was installed." ;;
      esac
      ask_secret MAGICSHELL_PASSWORD "Its password (at least 12 characters)"
      [ "$(printf '%s' "$MAGICSHELL_PASSWORD" | wc -m)" -ge 12 ] \
        || die "The password needs at least 12 characters (MAGICSHELL_PASSWORD); nothing was installed."
    fi
  else
    MAGICSHELL_USER=""
  fi
  if [ "$interactive" -eq 1 ]; then exec 3<&-; fi

  new="$work/new"
  mkdir -p "$new"
  {
    say "# Written by install.sh. Every key is documented in $doc/config.example.toml."
    [ -n "$MAGICSHELL_PUBLIC_URL" ] && say "public_url = \"$(toml_str "${MAGICSHELL_PUBLIC_URL%/}")\""
    say "bind = \"$(toml_str "$MAGICSHELL_BIND")\""
    say 'trusted_proxies = ["127.0.0.1/32", "::1/128"]'
    say "data_dir = \"/var/lib/$app\""
    say ""
    say "[app]"
    say "endpoint = \"$(toml_str "$MAGICSHELL_ENDPOINT")\""
    say "model = \"$(toml_str "$MAGICSHELL_MODEL")\""
    [ -n "$MAGICSHELL_API_KEY" ] && say "api_key = \"file:///run/credentials/$app.service/api-key\""
    [ "$MAGICSHELL_MODE" = accounts ] && say "database = \"$app.db\""
    true
  } > "$new/config.toml"
  if [ -n "$MAGICSHELL_API_KEY" ]; then
    (umask 077 && printf '%s\n' "$MAGICSHELL_API_KEY" > "$new/api-key")
    printf '[Service]\nLoadCredential=api-key:/etc/%s/api-key\n' "$app" > "$new/credentials.conf"
  fi
}

# --- service ---------------------------------------------------------------------------------

# The address /healthz answers on: a wildcard bind is asked on loopback.
health_url() {
  case "$1" in
    0.0.0.0:*) printf 'http://127.0.0.1:%s/healthz' "${1#0.0.0.0:}" ;;
    \[::\]:*) printf 'http://[::1]:%s/healthz' "${1#\[::\]:}" ;;
    *) printf 'http://%s/healthz' "$1" ;;
  esac
}

# Up for good: active, and /healthz answers within 30 s (without curl or wget: still active after 3 s).
healthy() {
  url=$(health_url "$1")
  if command -v curl >/dev/null 2>&1; then
    get() { curl -fsS -m 2 -o /dev/null "$url" 2>/dev/null; }
  elif command -v wget >/dev/null 2>&1; then
    get() { wget -q -T 2 -O /dev/null "$url" 2>/dev/null; }
  else
    sleep 3
    systemctl is-active --quiet "$app"
    return
  fi
  i=0
  while [ "$i" -lt 30 ]; do
    systemctl is-active --quiet "$app" || return 1
    get && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

start_service() {
  systemctl daemon-reload
  if systemctl is-enabled --quiet "$app" 2>/dev/null; then
    systemctl restart "$app"
  else
    systemctl enable --now "$app"
  fi
}

# --- main ------------------------------------------------------------------------------------

main() {
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
  [ -f "$archive" ] || die "Archive not found: $archive"
  if [ "$system" -eq 1 ] && [ "$(id -u)" -ne 0 ]; then
    die "Run as root for --system; this script never calls sudo."
  fi

  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  tar -C "$work" -xzf "$archive"
  set -- "$work"/*/
  [ $# -eq 1 ] && [ -d "$1" ] || die "The archive should contain exactly one directory."
  bundle=${1%/}

  cd "$bundle"
  if ! sha256sum -c --quiet SHA256SUMS > "$work/check.log" 2>&1; then
    bad=$(grep -v ': OK$' "$work/check.log" | head -n 1 | cut -d: -f1)
    die "Checksum mismatch: ${bad:-SHA256SUMS}. The bundle is damaged or was altered."
  fi
  app=$(head -n 1 name)
  case "$app" in
    ''|*[!a-z0-9_-]*) die "The bundle names an invalid app: $app" ;;
  esac

  bin="$prefix/bin/$app"
  doc="$prefix/share/$app"
  new_version=$("./$app" --version 2>/dev/null | cut -d' ' -f2) || new_version=""
  [ -n "$new_version" ] || die "The bundled $app does not run on this machine."
  old_version=""
  [ -x "$bin" ] && old_version=$("$bin" --version 2>/dev/null | cut -d' ' -f2 || true)

  if [ "$system" -eq 0 ]; then
    user_install
  else
    system_install
  fi
}

user_install() {
  if [ "$old_version" = "$new_version" ] && [ "${MAGICSHELL_FORCE:-0}" != 1 ]; then
    say "$app $new_version is already installed in $bin (MAGICSHELL_FORCE=1 installs it again)."
    return 0
  fi
  mkdir -p "$prefix/bin"
  install -m 0755 "$app" "$prefix/bin/.$app.new"
  mv -f "$prefix/bin/.$app.new" "$bin"
  install_docs
  if [ -n "$old_version" ]; then say "Updated $bin from $old_version to $new_version."; else say "Installed $app $new_version in $bin."; fi
  if [ -n "$old_version" ] && command -v pgrep >/dev/null 2>&1 && pgrep -x "$app" >/dev/null 2>&1; then
    say "A $app process is running; restart it to use $new_version."
  fi
}

install_docs() {
  mkdir -p "$doc"
  for f in nginx.conf AIRGAP.md THIRD-PARTY-LICENSES config.example.toml; do
    [ -f "$f" ] && install -m 0644 "$f" "$doc/$f"
  done
  true
}

system_install() {
  conf="/etc/$app/config.toml"
  unit="/etc/systemd/system/$app.service"
  unit_sum_file="$doc/installed-unit.sha256"
  systemd=0
  [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 && systemd=1
  running=0
  [ "$systemd" -eq 1 ] && systemctl is-active --quiet "$app" && running=1
  upgrade=0
  [ -f "$conf" ] && upgrade=1

  if [ "$upgrade" -eq 1 ] && [ "$old_version" = "$new_version" ] && [ "$running" -eq 1 ] && [ "${MAGICSHELL_FORCE:-0}" != 1 ]; then
    say "$app $new_version is already installed and running (MAGICSHELL_FORCE=1 installs it again)."
    return 0
  fi

  # Checked with the new binary before anything changes, with the state directory the unit gives.
  if [ "$upgrade" -eq 1 ]; then
    if ! STATE_DIRECTORY="/var/lib/$app" "./$app" --config "$conf" check-config > "$work/facts" 2> "$work/check.err"; then
      cat "$work/check.err" >&2
      die "$app $new_version refuses $conf, so nothing was changed${old_version:+ and $old_version keeps running}. Fix the file and run the installer again."
    fi
  else
    first_settings "$app"
    if ! STATE_DIRECTORY="/var/lib/$app" "./$app" --config "$work/new/config.toml" check-config > "$work/facts" 2> "$work/check.err"; then
      cat "$work/check.err" >&2
      die "These settings are refused, so nothing was installed."
    fi
  fi
  grep -v '^Not checked: ' "$work/check.err" >&2 || true
  bind=$(fact bind "$work/facts")
  database=$(fact database "$work/facts")

  # --- backups (updates) -----------------------------------------------------------------
  backup="$work/rollback"
  mkdir -p "$backup"
  db_backup=""
  if [ "$upgrade" -eq 1 ]; then
    # Stopped first, so the database files are copied as a whole.
    if [ "$running" -eq 1 ]; then systemctl stop "$app"; fi
    [ -f "$bin" ] && cp -p "$bin" "$backup/$app"
    [ -f "$unit" ] && cp -p "$unit" "$backup/$app.service"
    [ -f "$unit_sum_file" ] && cp -p "$unit_sum_file" "$backup/unit.sha256"
    if [ -n "$database" ] && [ -f "$database" ]; then
      stamp=$(date -u +%Y%m%dT%H%M%SZ)
      db_backup="$(dirname "$database")/backup-${old_version:-unknown}-$stamp.db"
      (umask 077 && cp -p "$database" "$db_backup")
      for x in wal shm; do
        if [ -f "$database-$x" ]; then cp -p "$database-$x" "$db_backup-$x"; fi
      done
      # The two newest stay (the names sort by time within a version; by name across them).
      # shellcheck disable=SC2012
      ls -1t "$(dirname "$database")"/backup-*.db 2>/dev/null | tail -n +3 | while read -r old; do
        rm -f -- "$old" "$old-wal" "$old-shm"
      done
    fi
  fi

  # --- files -------------------------------------------------------------------------------
  mkdir -p "$prefix/bin"
  install -m 0755 "$app" "$prefix/bin/.$app.new"
  mv -f "$prefix/bin/.$app.new" "$bin"
  install_docs

  # The unit is a conffile: an unedited one is replaced, an edited one kept with the new one beside it.
  unit_new=0
  new_sum=$(sum_of "$app.service")
  if [ ! -e "$unit" ]; then
    install -m 0644 "$app.service" "$unit"
  else
    current=$(sum_of "$unit")
    recorded=$(cat "$unit_sum_file" 2>/dev/null || true)
    if [ "$current" = "$new_sum" ]; then
      :
    elif [ "$current" = "$recorded" ] || case " $KNOWN_UNIT_SUMS " in *" $current "*) true ;; *) false ;; esac; then
      install -m 0644 "$app.service" "$unit"
    else
      install -m 0644 "$app.service" "$unit.new"
      unit_new=1
      warn "kept your edited $unit; the new unit is $unit.new. Merge it, and keep local changes in a drop-in (systemctl edit $app)."
    fi
  fi
  printf '%s\n' "$new_sum" > "$unit_sum_file"

  if [ "$upgrade" -eq 0 ]; then
    mkdir -p "/etc/$app"
    # World-readable because the service runs as a dynamic user; the key is root's, read by systemd.
    install -m 0644 "$work/new/config.toml" "$conf"
    if [ -f "$work/new/api-key" ]; then
      install -m 0600 "$work/new/api-key" "/etc/$app/api-key"
      mkdir -p "/etc/systemd/system/$app.service.d"
      install -m 0644 "$work/new/credentials.conf" "/etc/systemd/system/$app.service.d/credentials.conf"
    fi
    say "Wrote $conf."
  fi

  if [ "$systemd" -eq 0 ]; then
    say "Installed $app $new_version. systemd is not running here, so no service was started."
    say "Run it with: $bin --config $conf"
    return 0
  fi

  # --- start, check, roll back -----------------------------------------------------------------
  started=1
  start_service || started=0
  if [ "$started" -eq 1 ] && healthy "$bind"; then
    :
  elif [ "$upgrade" -eq 1 ] && [ -f "$backup/$app" ]; then
    warn "$app $new_version did not come up; putting $old_version back."
    journalctl -u "$app" -n 20 --no-pager >&2 2>/dev/null || true
    systemctl stop "$app" 2>/dev/null || true
    install -m 0755 "$backup/$app" "$prefix/bin/.$app.new"
    mv -f "$prefix/bin/.$app.new" "$bin"
    if [ -f "$backup/$app.service" ]; then cp -p "$backup/$app.service" "$unit"; fi
    if [ "$unit_new" -eq 1 ]; then rm -f "$unit.new"; fi
    if [ -f "$backup/unit.sha256" ]; then cp -p "$backup/unit.sha256" "$unit_sum_file"; else rm -f "$unit_sum_file"; fi
    if [ -n "$db_backup" ]; then
      cp -p "$db_backup" "$database"
      for x in wal shm; do
        rm -f "$database-$x"
        if [ -f "$db_backup-$x" ]; then cp -p "$db_backup-$x" "$database-$x"; fi
      done
    fi
    if start_service && healthy "$bind"; then
      die "$app $old_version runs again. $new_version did not start; see the log above and run the installer again once it is fixed."
    fi
    die "Neither $new_version nor $old_version came up. See: journalctl -u $app -n 50"
  else
    die "$app $new_version did not come up. See: journalctl -u $app -n 50"
  fi

  if [ "$upgrade" -eq 0 ] && [ -n "${MAGICSHELL_USER:-}" ]; then
    if printf '%s\n' "$MAGICSHELL_PASSWORD" | "$bin" --config "$conf" user add "$MAGICSHELL_USER" --password-stdin; then
      :
    else
      warn "the account was not added. Add it with: sudo $bin --config $conf user add $MAGICSHELL_USER"
    fi
  fi

  # --- summary ---------------------------------------------------------------------------------
  say ""
  if [ "$upgrade" -eq 1 ] && [ -n "$old_version" ] && [ "$old_version" != "$new_version" ]; then
    say "Updated $app from $old_version to $new_version; it runs and answers."
  else
    say "Installed $app $new_version; it runs and answers."
  fi
  public=$(sed -n 's/^public_url[[:space:]]*=[[:space:]]*"\(.*\)"/\1/p' "$conf" | head -n 1)
  say "  address   : ${public:-http://$bind} (listening on $bind)"
  say "  config    : $conf"
  [ -n "$db_backup" ] && say "  backup    : $db_backup"
  say "  status    : systemctl status $app"
  say "  logs      : journalctl -u $app -f"
  if [ "$(fact mode "$work/facts")" = accounts ]; then
    say "  accounts  : sudo $bin --config $conf user add NAME"
  fi
  if [ -n "$public" ]; then say "  proxy     : put nginx in front, see $doc/nginx.conf"; fi
}

main "$@"
