# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are CalVer `YYYY.M.N`.

## [Unreleased]

## [2026.11.0] - 2026-11-13

### Added

- Guided view and bench for questions of the three System One types (choice, score, yes or no), with distributions, confidence, the request and response, and variant runs beside a baseline.
- Setups (ready-made and your own, JSON export and import) and history with reopen, run again and undo.
- Three modes from one codebase: static Pages site with the visitor's own endpoint, open server, and server with password accounts (`magicshell user add|list|passwd|remove`).
- Pages deploy after a successful CI run on `main`, tag-driven releases with offline bundles for x86_64 and aarch64, `install.sh --archive` and `scripts/install-online.sh`.
