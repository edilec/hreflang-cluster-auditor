# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-28

### Added

- Locale cluster construction from exported HTML pages and sitemap `urlset`
  files, keyed by resolved URL rather than by language tag.
- Checks for reciprocal membership, self-links, BCP 47 well-formedness,
  canonical agreement with the self-link, per-page and per-cluster `x-default`
  consistency, and the configured `x-default` policy.
- A frozen `ruleId -> severity` catalog of 32 rules, asserted against
  `docs/hreflang-rules.md` in both directions.
- Five configurable limits, each enforced and each reporting a named finding
  rather than truncating silently.
- `hreflang-cluster-auditor` CLI with `--config`, `--root`, `--x-default`,
  `--json` and `--help`, emitting the v1 report envelope on stdout.
- Clean and deliberately broken example projects under `examples/`.

### Fixed

- Values quoted out of an input document are bounded in a finding's `message`
  as well as in its `evidence`. `invalid-language-tag`, `invalid-alternate-url`
  and `invalid-canonical-url` previously embedded the raw attribute, so a
  200000 character `hreflang` produced a 200000 character message and a report
  the size of the input.
- stdout escapes U+2028 and U+2029. Both are legal raw in JSON and are line
  terminators in a JavaScript string literal, so a file name carrying one
  produced a payload that parsed as JSON but broke a consumer evaluating it.
