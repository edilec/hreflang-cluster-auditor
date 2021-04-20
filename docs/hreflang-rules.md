# Rule catalog, limits and boundaries

Every rule id below is stable across releases. Renaming one is a breaking change
and is recorded in the changelog.

## Severity decides the exit code

Severity is declared once, in `RULE_SEVERITY` in `src/rules.mjs`, and every
finding takes its severity from that table. A finding built with an unknown rule
id throws. The table in this document is asserted against the code in both
directions by `test/rules.test.mjs`.

That cross-check alone is not the defence, because editing this file and the
code together satisfies it. `test/rules.test.mjs` therefore carries a third,
hand-written copy of the catalog and asserts the status and exit code each rule
produces, and `test/audit.test.mjs` carries one page-set fixture per error the
audit can report and asserts that the finding alone exits 1. A downgrade has to
get past all three.

- any `error` finding, and no missing evidence, means **fail** and exit 1
- `warning` and `info` findings alone mean **pass** and exit 0
- any rule marked *evidence missing* means **incomplete** and exit 2, whatever
  its own severity is

That last row is the important one. `alternate-not-in-inputs` is only a warning,
and it still cannot produce a pass: the tool did not see the page, so it has
nothing to pass on. Report status is computed from the findings themselves
rather than from a separate flag, so there is no single assignment whose removal
would turn an unread input into a green build.

## Rules

| Rule | Severity | Evidence missing | What it reports |
| --- | --- | --- | --- |
| `alternate-limit-exceeded` | error | yes | A page declares more alternates than `maxAlternatesPerPage`. The page is not audited. |
| `alternate-not-in-inputs` | warning | yes | A URL is declared as an alternate but no input describes it, so its reciprocal links could not be checked. |
| `alternate-source-conflict` | error | no | The same URL declares different alternate sets in HTML and in a sitemap. The HTML declaration is used. |
| `canonical-self-link-conflict` | error | no | The page's canonical names a different URL than the page itself, so the canonical and the self-link disagree. |
| `cluster-hreflang-conflict` | error | no | Members of one cluster map the same language tag to different URLs. |
| `cluster-membership-incomplete` | warning | no | Two pages are in the same cluster, and neither declares the other. |
| `duplicate-alternate-entry` | warning | no | A page repeats the same language tag and URL pair. |
| `duplicate-hreflang-tag` | error | no | A page maps one language tag to two different URLs. |
| `html-not-utf8` | error | yes | An exported HTML file could not be decoded as UTF-8. |
| `html-too-large` | error | yes | An exported HTML file is larger than `maxHtmlBytes`. |
| `html-unreadable` | error | yes | An exported HTML file could not be read. |
| `invalid-alternate-url` | error | no | An alternate href is absent, empty, over the URL bound, or not an http(s) URL. |
| `invalid-canonical-url` | error | no | A canonical href is absent, empty, over the URL bound, or not an http(s) URL. |
| `invalid-language-tag` | error | no | An hreflang value is not a well-formed BCP 47 tag and is not `x-default`. |
| `language-tag-not-canonical-case` | info | no | A well-formed tag is written in an unconventional case, such as `EN-us` for `en-US`. Matching is case-insensitive, so nothing a crawler does changes. |
| `missing-canonical` | warning | no | An HTML page declares alternates but no canonical link. |
| `missing-reciprocal-alternate` | error | no | One page declares another as an alternate and the other does not declare it in return. |
| `missing-self-alternate` | error | no | A page does not list itself among its own alternates. |
| `multiple-canonical` | error | no | An HTML page declares more than one canonical link. |
| `multiple-x-default` | error | no | One page declares more than one `x-default` target. |
| `no-pages-checked` | error | yes | No page with alternate declarations was read, so there is no evidence to pass or fail on. |
| `page-limit-exceeded` | error | yes | The inputs describe more pages than `maxPages`. Nothing is audited. |
| `reciprocal-tag-mismatch` | error | no | A page calls a sibling by a tag the sibling does not use for itself. |
| `sitemap-index-not-expanded` | error | yes | The file is a sitemap index. Indexes are not expanded. |
| `sitemap-not-utf8` | error | yes | A sitemap export could not be decoded as UTF-8. |
| `sitemap-too-large` | error | yes | A sitemap export is larger than `maxSitemapBytes`. |
| `sitemap-unparsable` | error | yes | A sitemap export has no `<urlset>`, or a `<url>` entry has no usable `<loc>`. |
| `sitemap-unreadable` | error | yes | A sitemap export could not be read. |
| `sitemap-url-limit-exceeded` | error | yes | A sitemap holds more `<url>` entries than `maxSitemapUrls`. None are audited. |
| `x-default-conflict` | error | no | Members of one cluster send `x-default` to different URLs. |
| `x-default-missing` | error | no | A cluster declares no `x-default` and the configured policy requires one. |
| `x-default-not-allowed` | error | no | A cluster declares an `x-default` and the configured policy forbids one. |

`no-pages-checked` is the guard against a vacuous pass: a run that read nothing
is `incomplete`, never `pass` with `checked: 0`. It is emitted only when no other
evidence-missing finding already explains the absence, so an unreadable export or
an exceeded limit is reported once rather than twice.

## Configurable limits

Each limit is a positive integer in `config.limits`. An unknown limit name is a
configuration error, not a silently ignored key. Exceeding a limit produces the
finding named below and marks the run incomplete; it never truncates silently.

| Limit | Default | Exceeding it reports |
| --- | ---: | --- |
| `maxAlternatesPerPage` | 200 | `alternate-limit-exceeded` |
| `maxHtmlBytes` | 2000000 | `html-too-large` |
| `maxPages` | 5000 | `page-limit-exceeded` |
| `maxSitemapBytes` | 33554432 | `sitemap-too-large` |
| `maxSitemapUrls` | 50000 | `sitemap-url-limit-exceeded` |

Two further bounds are fixed rather than configurable, because a value past them
is malformed rather than large: a language tag over 64 characters and a URL over
2048 characters are reported as invalid.

## Configuration schema

```json
{
  "schemaVersion": "1",
  "pages": [{ "url": "https://example.com/en-us/", "html": "build/en-us.html" }],
  "sitemaps": ["sitemap.xml"],
  "xDefault": "optional",
  "limits": { "maxPages": 5000 }
}
```

- `schemaVersion` must be `"1"`.
- `pages` and `sitemaps` are both optional, and at least one must be non-empty.
- `pages[].url` is the absolute URL the page is served at; `pages[].html` is the
  exported document, relative to the input root.
- `xDefault` is `optional` (default), `required` or `forbidden`, and the
  `--x-default` flag overrides it.
- Unknown keys, unknown limits, unknown `xDefault` values and repeated page URLs
  are configuration errors: stdout stays empty and the process exits 2.

## How a cluster is built

A cluster is a connected component of the "declares as an alternate" graph.
Membership is decided by the resolved href, never by the language tag, so one
malformed tag does not cascade into a fictional reciprocity failure on a page
that does link back.

URL identity is `origin + pathname + search`. The scheme and host are lowercased
by the URL parser and the fragment is dropped, because a fragment never names a
different document. Everything else is preserved exactly: `/en` and `/en/` are
two different pages here.

Language tag identity is the whole lowercased tag. `en-GB` and `en-US` are
different tags that legitimately name different pages, and they are never
collapsed into one `en`.

## Source precedence

A URL may be described by an exported HTML page and by a sitemap entry. When the
two declare different alternate sets, the HTML declaration is used and
`alternate-source-conflict` is reported, because HTML is what a crawler parses
for that page. Sitemap `<url>` entries that carry no alternate links are not part
of any cluster and are skipped, so an ordinary monolingual sitemap entry never
becomes a finding. A page named in `config.pages` is always audited, so a page
declared there with no alternates at all does report `missing-self-alternate`.

## Untrusted input in the report

Every value a finding quotes out of an input document -- an `hreflang`, an
`href`, the raw `<link>` element -- is passed through one bounded,
whitespace-collapsed excerpt of at most 200 characters, in the `message` as
well as in the `evidence` field. A 200000 character attribute produces a
200 character quote, not a 200000 character report.

The report on stdout escapes U+2028 and U+2029. Both are legal raw inside a
JSON string and neither is legal raw inside a JavaScript string literal, so
escaping them keeps the payload parseable by consumers that evaluate it rather
than parse it. The escaping is the only difference from `JSON.stringify`.

## Determinism

Findings sort by `(location.file, location.pointer, ruleId, message)`, each
compared by UTF-16 code unit. `localeCompare` is never used: ICU collation data
varies between Node builds, which has already produced a real ordering bug in
this catalog. Pointers sort as text, so `/pages/10` precedes `/pages/2`.

Nothing reads the clock, a random source or filesystem enumeration order. Two
runs over identical inputs produce byte-identical stdout.

## What this tool cannot conclude

- **Whether a language or region subtag exists.** Only BCP 47 grammar is checked.
  `xx-QQ` is well-formed and meaningless; the IANA registry is not consulted,
  because a snapshot goes stale and this tool makes no network calls.
- **Whether the live site serves what was exported.** The audit reads files. A
  page whose alternates are injected by client-side script, or rewritten at the
  edge, is invisible to it.
- **Whether a referenced page exists.** A URL nothing describes is reported as
  missing evidence, not as a broken link.
- **Transitive cluster completeness beyond declared pairs.** Reciprocity is
  checked pairwise, and pages connected only through a shared alternate are
  reported with the `cluster-membership-incomplete` warning rather than as an
  error, because the relationship is inferred rather than declared.
- **Whether a trailing slash, a query string or a host is the preferred
  spelling.** Identity is compared exactly; deciding which spelling a site
  prefers is a different check.
- **That an HTML file parsed the way a browser would.** The scanner removes
  comments, stops at `</head>`, and reads `<link>` elements. It does not see
  links added by script, and a `<link>` whose attribute value contains a raw `>`
  is read incorrectly.
