# Airgapped install

Every release can be installed on a machine with no network access.

## What to carry across

Download these from the release page on a connected machine:

| File | Purpose |
|---|---|
| `magicshell-<version>-x86_64-unknown-linux-musl-offline.tar.gz` (or `aarch64`) | static binary, `install.sh`, systemd unit, nginx template, example config, licences, `SHA256SUMS` |
| `install.sh` | the installer, also inside each bundle |
| `SHA256SUMS` | checksums of the release files |
| `magicshell-<version>-src-vendored.tar.gz` | optional: source with every dependency vendored, to build without network |

Check the downloads before you carry them across:

```sh
sha256sum -c SHA256SUMS --ignore-missing
```

The release also carries build-provenance attestations. On a connected machine, check them with `gh attestation verify <file> --repo overcuriousity/magicshell`.

## Install

The installer never uses the network and never calls `sudo`.

For your user only, into `~/.local/bin`:

```sh
sh install.sh --archive magicshell-<version>-x86_64-unknown-linux-musl-offline.tar.gz
```

As a system service (the standard install), run as root. This installs to `/usr/local/bin`, sets up a hardened systemd unit and creates `/etc/magicshell/config.toml` with `data_dir = "/var/lib/magicshell"`, where the service keeps its database:

```sh
sh install.sh --archive magicshell-<version>-x86_64-unknown-linux-musl-offline.tar.gz --system
```

The installer checks every file against the bundle's `SHA256SUMS`. If any file has changed, it stops with "Checksum mismatch".

Accounts are then managed as root, with the service's configuration: `sudo /usr/local/bin/magicshell --config /etc/magicshell/config.toml user add NAME` (see "Users" in the README).

## The model key

Keep the key out of `config.toml`; it is world-readable so the service's dynamic user can read it. Put it in a root-only file and hand it to the service as a credential:

```sh
printf '%s' 'the-key' | install -m 0600 /dev/stdin /etc/magicshell/api-key
systemctl edit magicshell   # add: [Service] LoadCredential=api-key:/etc/magicshell/api-key
```

and in `config.toml` under `[app]`: `api_key = "file:///run/credentials/magicshell.service/api-key"`. The endpoint must be reachable from the server; no other outbound connection is made.

## TLS on an airgapped network

magicshell never terminates TLS itself. It listens on `127.0.0.1:8080`, and nginx on the same machine serves https. Plain http over the network is not supported, because secure cookies require https.

Use either of these:
- A certificate from your local CA. This is best: browsers trust it once the CA is installed on each client.
- A self-signed certificate. Browsers will warn until each client trusts it.

```sh
openssl req -x509 -newkey rsa:3072 -sha256 -days 825 -nodes \
  -keyout /etc/ssl/private/magicshell.lan.key -out /etc/ssl/certs/magicshell.lan.pem \
  -subj "/CN=magicshell.lan" -addext "subjectAltName=DNS:magicshell.lan"
```

Then:
1. Copy `nginx.conf` from the bundle (also in `~/.local/share/magicshell/` or `/usr/local/share/magicshell/`) to `/etc/nginx/conf.d/magicshell.conf`. Replace `magicshell.example.org` and the certificate paths, then reload nginx.
2. Set the address users type in `/etc/magicshell/config.toml`:

   ```toml
   public_url = "https://magicshell.lan"
   ```

magicshell refuses to start if `public_url` is not https, except for `localhost`.

## Build from source without network

```sh
tar -xzf magicshell-<version>-src-vendored.tar.gz
cd magicshell-<version>
SQLX_OFFLINE=true cargo build --release --offline --locked -p magicshell
```

The archive's `.cargo/config.toml` points Cargo at the bundled `vendor/` directory. Fonts, icons and htmx are already inside the source tree.

## Secrets

`config.toml` is world-readable so the service's dynamic user can read it. Put the API key in a root-only file and hand it to the service as a credential:

```sh
printf '%s' 'the-api-key' | install -m 0600 /dev/stdin /etc/magicshell/api-key
systemctl edit magicshell   # add: [Service] LoadCredential=api-key:/etc/magicshell/api-key
```

and in `config.toml`, under `[app]`: `api_key = "file:///run/credentials/magicshell.service/api-key"`.
