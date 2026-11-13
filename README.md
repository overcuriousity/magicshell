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
- **Setups**: ready-made and your own, exported and imported as JSON. **History**: every run, reopened, run again or loaded as baseline.

## Two modes

| | Open | Accounts |
|---|---|---|
| Sign-in | none | username and password |
| History and setups | browser storage | server database, per user |

In both, the endpoint, key and model are server configuration, and the browser talks only to its own server, which calls the endpoint. The browser never sees the key.

## Install

Online, to `~/.local/bin`, no sudo:

```sh
curl -fsSL https://raw.githubusercontent.com/overcuriousity/magicshell/main/scripts/install-online.sh | sh
```

The script downloads the latest release bundle for x86_64 or aarch64, checks it against `SHA256SUMS` and runs the bundled `install.sh`. Pass `--system` (as root) for `/usr/local/bin` with a systemd unit and `/etc/magicshell/config.toml`, or `--prefix DIR`: `curl ... | sh -s -- --system`.

Without network: `AIRGAP.md`.

## Run

```sh
magicshell --config config.toml
```

It listens on `127.0.0.1:8080`. `config.example.toml` documents every key; any key can be set as `MAGICSHELL__KEY` or `MAGICSHELL__SECTION__KEY`, and a key ending in `_FILE` reads its value from a file.

| Key | Meaning |
|---|---|
| `public_url` | https address users see; required unless reached via localhost |
| `bind` | listen address, default `127.0.0.1:8080` |
| `trusted_proxies` | addresses whose `X-Forwarded-*` headers are believed |
| `data_dir` | where the database lives |
| `[app] endpoint` | model endpoint base URL ending in `/v1` (required) |
| `[app] model` | the model to ask (required) |
| `[app] api_key` | bearer key; `file://` reads it from a file |
| `[app] database` | SQLite file name; setting it turns accounts on |
| `[app] runs_per_minute` | runs per client (open) or per user (accounts), default 60 |
| `[app] upstream_timeout_secs` | seconds to wait for the model, default 60 |

Without `database` the server is open: everyone who can reach it can run questions. Use that only on a trusted network.

## Users

Accounts mode has no sign-up. Create accounts from the shell, with the same configuration:

```sh
magicshell --config config.toml user add NAME
magicshell --config config.toml user list
magicshell --config config.toml user passwd NAME
magicshell --config config.toml user remove NAME
```

`add` and `passwd` ask for the password twice (at least 12 characters). `remove` deletes the user's setups and history.

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
