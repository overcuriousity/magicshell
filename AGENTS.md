# AGENTS.md

magicshell: a browser app and Rust server for experimenting with decision models over the System One format.

## Rules

This app follows the overcuriousity dev manifest **v2026.11.1**:
https://github.com/overcuriousity/overcuriousity-dev-manifest/tree/v2026.11.1/manifest

- Profile: everyday.
- Read the manifest files in number order before changing UI, security or ops. Before declaring work done, run `manifest/99-review-checklist.md` and `oc-check .`.
- Never commit `.superpowers/` or `.claude/`.

### Knowing departures

- Browser-first app of plain ES modules under `web/` instead of server-rendered Askama + htmx.
- No MCP endpoint, OpenAPI document or PWA install (spec non-goals).
- The manifest's categorical chart colours colour choice options and its ordered ramp colours score levels; always paired with a name, a number or a symbol.
- Kit code is copied into `src/kit/` from oc-kit v2026.11.1 instead of depending on oc-kit, so the build has no git dependency (see `src/kit/mod.rs`).
- Below 48rem the top bar carries the title and one action (the Bench/Guided switch); the theme and text-size toggles live in Settings there and in the top bar from 48rem.
- `deny.toml` ignores RUSTSEC-2026-0459 (SQLite, `libsqlite3-sys`) with a written reachability argument, until sqlx allows `libsqlite3-sys >= 0.39`.

### Review checklist items that do not apply

- 3, copy buttons: the only copyable values are the request and response JSON, which have them; there are no tokens or secrets to show.
- 9, destructive actions: deleting a setup or a history entry, and clearing the history, act at once with a 6 s undo notice. Deleting a user is a shell command (`user remove`).
- 12, airgap bundle: built by `scripts/bundle.sh` in the release workflow only; checked locally with a stand-in for `cargo-about`.
- Passkey, OIDC, SSE and htmx rules: the app has none of these.

## Layout

- `src/` the server; `src/kit/` is copied from oc-kit v2026.11.1.
- `web/` the browser app, embedded in the server; `web/js/**/*.test.mjs` are its tests and are not served.
- `tests/` integration tests; `tests/support` starts the app on `127.0.0.1:0`.
- `scripts/` `bundle.sh` (release bundles), `install-online.sh`, `check-contrast.mjs`, `probe.sh`.
- `deploy/` systemd unit and nginx template.

## Commands

- `cargo test`
- `cargo clippy --all-targets -- -D warnings`
- `cargo fmt --check`
- `cargo deny check`
- `node --test 'web/js/**/*.test.mjs'` (Node 22, no npm dependencies)
- `node scripts/check-contrast.mjs`
- `oc-check .`
- `shellcheck install.sh scripts/*.sh`
