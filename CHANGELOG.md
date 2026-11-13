# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are CalVer `YYYY.M.N`.

## [Unreleased]

## [2026.11.4] - 2026-11-13

### Changed

- The guide's first step offers the four kinds of question as buttons with an icon and a hint, two by two, instead of a dropdown; a button goes straight on to the question.
- Every field has a visible lead: type and key on each bench card, "Description (optional)" for each option (also where the rows stack on narrow screens), "Levels, lowest first", the name in Save as setup, and the guide's new option and own levels.
- The magicshell title in the top bar starts over: it clears what was entered in the guide and the bench and opens the guide at step 1, with an Undo. History and setups stay.

### Added

- A footer with the app's version on every page; `/api/config` reports the version.

## [2026.11.3] - 2026-11-13

### Security

- Changing a password, in the app or with `magicshell user passwd`, ends every other session of that user; the session that changed it stays signed in under a new id. Sessions from before this version end once, at the first request after the upgrade.
- Signing out clears the drafts of the bench and the guide also when the browser's session storage is full, and drops runs handed between views.

### Changed

- The bench keeps the variant B and the results of A and B when you visit another view or sign in, not only A.
- Switching from an untouched bench to Guided view leaves the guide's draft alone.
- A full browser makes room by removing only as many of the oldest history entries as needed, and says how many; saving a setup makes room the same way.
- Restoring a history entry older than the 500 kept is refused with a sentence instead of being dropped without a word.
- History offers Try again when its list cannot be loaded.
- Setups: an import that stops part way says how many setups it saved; Export with no own setups explains why there is nothing to export.
- A reply from the model endpoint larger than 1 MiB is refused; a negative history duration is refused.
- A proxy's error page or text is no longer shown as the app's own sentence.
- Rate limits keep limiting after a panic elsewhere instead of letting everything through.

## [2026.11.2] - 2026-11-13

### Changed

- Dependencies: rand 0.10 and tower-http 0.7; CI uses actions/setup-node 7.1.0.

## [2026.11.1] - 2026-11-13

### Removed

- The static Pages site and the bring-your-own-key mode: the browser only talks to its own magicshell server. Two modes remain, open and accounts. Without its server the page shows one line saying so.

### Fixed

- The systemd unit started an unknown `serve` subcommand and failed; it now starts the server with no subcommand.

## [2026.11.0] - 2026-11-13

### Added

- Guided view and bench for questions of the three System One types (choice, score, yes or no), with distributions, confidence, the request and response, and variant runs beside a baseline.
- Setups (ready-made and your own, JSON export and import) and history with reopen, run again and undo.
- Three modes from one codebase: static Pages site with the visitor's own endpoint, open server, and server with password accounts (`magicshell user add|list|passwd|remove`).
- Pages deploy after a successful CI run on `main`, tag-driven releases with offline bundles for x86_64 and aarch64, `install.sh --archive` and `scripts/install-online.sh`.
