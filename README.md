# magicshell

Experiment with decision models over the System One format. A browser app with a guided view and a bench, served by a small Rust server.

Licence: MIT OR Apache-2.0.

## Decision models

A decision model does not write text. It takes a situation and typed questions, scores the allowed answers and returns a probability for each. The request format is System One; llama.cpp serves it at `/v1/systemone`. There are three question types:

- `choice`: pick one of 2 to 8 named options, each with an optional description. The result is the pick and one probability per option.
- `score`: rate on 2 to 10 ordered levels. The result is the expected level and one probability per level.
- `noul`: a yes-or-no question. The result is the probability of yes.

`choice` and `score` also return a confidence, which says how concentrated the distribution is, not whether the answer is right. All questions of one request are read together.

## The app

- **Guided view** (opens by default): pick a kind of question, write it, add the details, read the answer as a verdict and bars.
- **Bench**: one situation, up to 8 typed questions, distributions per question, the exact request and response, and a variant run beside a baseline (without descriptions, neutral option names, reversed order).
- **Why?** (accounts mode): after a result, ask the model again once per word of the situation with that word left out. Words are marked by how far their absence moved the answer: shade for strength, two colours for direction, ⇄ where the answer flips; the numbers show on hover, tap or focus. It costs one extra call per word, can be stopped, and is kept with the run in History. Offered in the guided view, the bench (baseline only) and a History entry.
- **Setups**: ready-made and your own, exported and imported as JSON. **History**: every run, reopened, run again or loaded as baseline.
- **Suggestions**: fields suggest what was typed before, from History, setups and ready scales, in grey; Tab takes the next word (a button under the field does the same on touch devices, and wherever the text has filled the field). Empty question, context and situation fields offer recent values; the guide's new-option field offers often-used ones. Nothing leaves the app and the browser's autofill is not used.

## Two modes

| | Open | Accounts |
|---|---|---|
| Sign-in | none | username and password, or single sign-on (OIDC) |
| History and setups | browser storage | server database, per user |
| Why? | no | yes |

In both, the endpoint, key and model are server configuration, and the browser talks only to its own server, which calls the endpoint. The browser never sees the key.

## Install

The standard install is a system service under systemd. As root:

```sh
curl -fsSL https://raw.githubusercontent.com/overcuriousity/magicshell/main/scripts/install-online.sh | sh -s -- --system
```

The script downloads the latest release bundle for x86_64 or aarch64, checks it against `SHA256SUMS` and runs the bundled `install.sh`. It never calls `sudo`. A system install puts these in place:

| Path | What |
|---|---|
| `/usr/local/bin/magicshell` | the program |
| `/etc/systemd/system/magicshell.service` | the hardened unit; the service runs as its own dynamic user |
| `/etc/magicshell/config.toml` | the configuration, with `data_dir = "/var/lib/magicshell"` |
| `/var/lib/magicshell/` | the database; created at the first start and private to the service |

To try magicshell without a service, leave out `--system`: it installs to `~/.local/bin` (or `--prefix DIR`) and needs no root.

Without network: `AIRGAP.md`.

## Run

As a service, after setting `endpoint`, `model` and `public_url` in `/etc/magicshell/config.toml`:

```sh
systemctl daemon-reload && systemctl enable --now magicshell
journalctl -u magicshell -f
```

By hand:

```sh
magicshell --config config.toml
```

It listens on `127.0.0.1:8080`. `config.example.toml` documents every key; any key can be set as `MAGICSHELL__KEY` or `MAGICSHELL__SECTION__KEY`, and a key ending in `_FILE` reads its value from a file.

| Key | Meaning |
|---|---|
| `public_url` | https address users see; required unless reached via localhost |
| `bind` | listen address, default `127.0.0.1:8080` |
| `trusted_proxies` | addresses whose `X-Forwarded-*` headers are believed |
| `data_dir` | where the database lives. The system install sets `/var/lib/magicshell`. Unset: the service's state directory under systemd, otherwise `~/.local/share/magicshell` |
| `[app] endpoint` | model endpoint base URL ending in `/v1` (required) |
| `[app] model` | the model to ask (required) |
| `[app] api_key` | bearer key; `file://` reads it from a file |
| `[app] database` | SQLite file name; setting it turns accounts on |
| `[app] runs_per_minute` | runs per client (open) or per user (accounts), default 60 |
| `[app] why_max_words` | longest situation "Why?" accepts, default 300; 0 turns "Why?" off; well above 300 a result over many questions can become too large to keep |
| `[app] why_per_minute` | "Why?" questions per user, counted apart from runs, default 600 |
| `[app] upstream_timeout_secs` | seconds to wait for the model, default 60 |
| `[auth.oidc] issuer` | the provider's issuer URL, exactly as its discovery document states it; setting this section turns single sign-on on |
| `[auth.oidc] client_id` | the client registered at the provider |
| `[auth.oidc] client_secret` | its secret; `file://` reads it from a file |
| `[auth.oidc] scopes` | default `["openid", "profile"]` |
| `[auth.oidc] auto_provision` | create an account at a person's first sign-in, default `false` |
| `[auth.oidc] display_name` | the label of the sign-in button, default `Sign in with SSO` |

Without `database` the server is open: everyone who can reach it can run questions. Use that only on a trusted network.

## Users

Accounts mode has no sign-up. With passwords, accounts are created from the shell; with single sign-on they come from the provider (next section).

On a system install, first set `database = "magicshell.db"` under `[app]` in `/etc/magicshell/config.toml` and restart the service; the restart creates the database. Then, as root and while the service is running:

```sh
sudo /usr/local/bin/magicshell --config /etc/magicshell/config.toml user add NAME
sudo /usr/local/bin/magicshell --config /etc/magicshell/config.toml user list
sudo /usr/local/bin/magicshell --config /etc/magicshell/config.toml user passwd NAME
sudo /usr/local/bin/magicshell --config /etc/magicshell/config.toml user remove NAME
```

- Root, because `/var/lib/magicshell` belongs to the service alone.
- The full path, because `sudo` on some systems does not search `/usr/local/bin`.
- While the service is running, because secrets handed over with `LoadCredential=` exist only then, and the commands read the same configuration.
- The commands must see the same `data_dir` as the service: a config written by an installer before 2026.11.6 has none, so add `data_dir = "/var/lib/magicshell"` to it first.

When you run magicshell by hand, use the same user and the same configuration as the server:

```sh
magicshell --config config.toml user add NAME
```

`add` and `passwd` ask for the password twice (at least 12 characters). `remove` deletes the user's setups and history. The commands work on the server's database and never create one: if there is none where they look, they say where they looked and stop.

## Sign-in through OIDC

Setting `[auth.oidc]` makes your identity provider the only way in: the sign-in page shows one button, and the password form is gone. It needs `[app] database` and `public_url`.

```toml
[auth.oidc]
issuer = "https://cloud.example"
client_id = "magicshell"
client_secret = "file:///run/credentials/magicshell.service/oidc-secret"
auto_provision = true
```

On a system install, keep the client secret out of `config.toml` (it is world-readable) and hand it to the service as a credential, as `AIRGAP.md` describes for the model key:

```sh
printf '%s' 'the-client-secret' | install -m 0600 /dev/stdin /etc/magicshell/oidc-secret
systemctl edit magicshell   # add: [Service] LoadCredential=oidc-secret:/etc/magicshell/oidc-secret
systemctl restart magicshell
```

- Register a client at the provider with the redirect URI `https://<host of public_url>/auth/oidc/callback` (scheme, host and port of `public_url`, no further path) and the scopes `openid profile`. With Nextcloud this is its OIDC identity provider app, and the issuer is the Nextcloud address as its `/.well-known/openid-configuration` states it.
- `auto_provision = true` gives everyone the provider admits an account at their first sign-in. With `false`, only people who already have one get in.
- An account belongs to the provider's issuer and subject, never to an e-mail address or a name. The name shown is the provider's user name at the first sign-in.
- Password accounts stay in the database but cannot sign in, and nobody's setups or history move over. `user list` and `user remove` still work; `user add` and `user passwd` refuse.
- Signing out ends the magicshell session only, not the one at the provider.
- The provider's signing keys are read once. After replacing them at the provider, restart magicshell.

## Development

```sh
cargo run -- --config config.toml
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo deny check
node --test 'web/js/**/*.test.mjs'
node scripts/check-contrast.mjs
oc-check .
```

`scripts/probe.sh` posts the fixture requests to a real endpoint (needs `jq`; set `MAGICSHELL_ENDPOINT`, `MAGICSHELL_MODEL` and optionally `MAGICSHELL_KEY`).

Releases are tag-driven: tag `vYYYY.M.N` matching `Cargo.toml` and a `CHANGELOG.md` section.

See `ROADMAP.md` for what comes later, `SECURITY.md` for reporting problems and `AGENTS.md` for the rules this repository follows.
