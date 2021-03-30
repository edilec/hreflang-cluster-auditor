# Hreflang Cluster Auditor

Build locale clusters from exported HTML and sitemap files, then check the
things an hreflang set actually promises: every member links back, every member
links to itself, every language tag is well-formed BCP 47, the canonical agrees
with the self-link, and the cluster names at most one `x-default`.

- **Repository:** [edilec/hreflang-cluster-auditor](https://github.com/edilec/hreflang-cluster-auditor)
- **Area:** SEO & Search
- **License:** MIT

Regional variants are the point of the exercise. `en-GB` and `en-US` are
different tags that legitimately name different pages, and this tool never
collapses them into one `en` or reports them as duplicates of each other. An
`x-default` is optional unless you configure it as required.

Nothing is fetched. Every page the audit reasons about comes from a file inside
a declared input root, and a URL that some page names but no input describes is
reported as missing evidence rather than quietly assumed correct.

## Install

Node 22 or newer. No runtime dependencies, no dev dependencies, Node built-ins
only.

```sh
npm install hreflang-cluster-auditor
```

## Use

```sh
npx hreflang-cluster-auditor --config examples/clean/hreflang.config.json
npx hreflang-cluster-auditor --config site/hreflang.config.json --root site --json
```

```
--config FILE       Project configuration (required)
--root DIR          Input root every declared path resolves against and may not
                    escape. Defaults to the directory holding the config.
--x-default POLICY  Override config.xDefault: optional, required, forbidden
--json              Suppress the human summary on stderr
-h, --help          Show help
```

stdout carries the JSON report and nothing else. stderr carries the human
summary and diagnostics.

| Exit | Meaning |
| ---: | --- |
| `0` | every cluster was complete and consistent |
| `1` | the audit completed and found a policy failure |
| `2` | invalid configuration, or evidence the tool could not read |

Exit 2 has two shapes. A configuration error means the run never had a subject,
so stdout stays **empty** and the message goes to stderr. Evidence that could
not be read means the run had a subject and failed to obtain evidence about it,
so stdout carries a report with status `incomplete` naming exactly what was not
read.

## Configuration

```json
{
  "schemaVersion": "1",
  "pages": [
    { "url": "https://example.com/en-us/", "html": "build/en-us.html" },
    { "url": "https://example.com/fr/", "html": "build/fr.html" }
  ],
  "sitemaps": ["sitemap.xml"],
  "xDefault": "optional",
  "limits": { "maxPages": 5000 }
}
```

At least one of `pages` and `sitemaps` must be non-empty. Unknown keys, unknown
limit names, unknown `xDefault` values and repeated page URLs are configuration
errors rather than ignored input: a one-character typo must not turn a real
failure into a green run.

The full rule catalog, the limits and the configuration schema are in
[docs/hreflang-rules.md](./docs/hreflang-rules.md).

## What it reports

Run it against the two example projects in `examples/`:

```
$ npx hreflang-cluster-auditor --config examples/broken/hreflang.config.json
ERROR   missing-reciprocal-alternate    build/de-de.html /pages/2
ERROR   canonical-self-link-conflict    build/en-gb.html /pages/1/canonicals/0
WARNING duplicate-alternate-entry       build/en-us.html /pages/0/alternates/5
INFO    language-tag-not-canonical-case build/en-us.html /pages/0/alternates/5
ERROR   invalid-language-tag            build/fr.html /pages/3/alternates/3

4 page(s) in 1 cluster(s), 20 alternate declaration(s), x-default policy "optional".
3 error, 1 warning, 1 info. Status fail.
```

The clean example declares the same four-page cluster with `en-US`, `en-GB`,
`de-DE`, `fr` and an `x-default`, from both HTML and a sitemap, and passes with
no findings.

Severity is declared once, in one frozen `ruleId -> severity` table, and every
finding takes its severity from it. A finding built with an unknown rule id
throws. The table is asserted against the documented catalog in both directions,
so a rule cannot be quietly downgraded in either place.

## Limits and non-goals

This tool reads files and compares declarations. It **cannot** conclude:

- **That a language or region subtag exists.** Only BCP 47 grammar is checked.
  `xx-QQ` is well-formed and meaningless. The IANA subtag registry is not
  consulted, because a bundled snapshot goes stale and this tool makes no
  network calls.
- **That the live site serves what was exported.** A page whose alternates are
  injected by client-side script, or rewritten at the edge, is invisible to it.
- **That a referenced page exists.** A URL no input describes is reported as
  missing evidence, not as a broken link, and makes the run `incomplete`.
- **That a cluster is complete beyond declared pairs.** Reciprocity is checked
  pairwise. Pages connected only through a shared alternate get the
  `cluster-membership-incomplete` warning, because that relationship is inferred
  rather than declared.
- **Which URL spelling a site prefers.** Identity is `origin + pathname +
  search`; `/en` and `/en/` are two different pages here. Choosing between them
  is a different check with a different tool.
- **That an HTML file parsed the way a browser would.** The scanner removes
  comments, stops at `</head>`, and reads `<link>` elements. It does not see
  links added by script, and a `<link>` whose attribute value contains a raw `>`
  is read incorrectly.
- **Anything about a sitemap index.** Indexes are not expanded, because that
  would mean opening paths chosen by the input document. List the child files
  instead.

It also never writes to the site it audits, never fetches anything, and refuses
any configured path that leaves the input root, whether by spelling or through a
symbolic link.

## Determinism

Findings sort by `(location.file, location.pointer, ruleId, message)`, each
compared by UTF-16 code unit. `localeCompare` is never used: ICU collation data
varies between Node builds. Nothing reads the clock, a random source or
filesystem enumeration order, so two runs over identical inputs produce
byte-identical stdout.

## Development

```sh
npm run check   # lint, tests, the clean example, and a packaging dry run
```

`npm test` runs the suite alone and `npm run test:coverage` adds coverage over
`src/`.

## License

MIT. See [LICENSE](./LICENSE).
