# AGENTS.md

magicshell: a browser app and Rust server for experimenting with decision models over the System One format.

## Rules

This app follows the overcuriousity dev manifest **v2026.11.1**:
https://github.com/overcuriousity/overcuriousity-dev-manifest/tree/v2026.11.1/manifest

- Profile: everyday.
- The stack rule for server-rendered Askama and htmx is set aside: the UI is plain ES modules under `web/`.
- Never commit `.superpowers/` or `.claude/`.

## Layout

- `src/` the server; `src/kit/` is copied from oc-kit v2026.11.1 (see `src/kit/mod.rs`).
- `tests/` integration tests; `tests/support` starts the app on `127.0.0.1:0`.

## Commands

- `cargo test`
- `cargo clippy --all-targets -- -D warnings`
- `cargo fmt --check`
- `cargo deny check`
- `node --test 'web/**/*.test.mjs'` (Node 22, no npm dependencies)
- `node scripts/check-contrast.mjs`
