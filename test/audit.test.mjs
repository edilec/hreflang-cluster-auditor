import assert from 'node:assert/strict'
import test from 'node:test'

import { RULE_IDS, auditPages, buildReport, byCodeUnit, exitCodeFor, sortFindings, statusFor } from '../src/index.mjs'
import { ORIGIN, healthyCluster, pageRecord } from './helpers.mjs'

function ruleIdsOf(findings) {
  return sortFindings(findings).map((finding) => finding.ruleId)
}

function run(pages, xDefault = 'optional') {
  return auditPages(pages, { xDefault })
}

const A = `${ORIGIN}/a/`
const B = `${ORIGIN}/b/`
const COUNTS = { checked: 0, clusters: 0, alternates: 0, xDefault: 'optional' }

/** Every error the audit itself can report. The loader's errors live in project.test.mjs. */
const AUDIT_ERRORS = [
  'canonical-self-link-conflict',
  'cluster-hreflang-conflict',
  'duplicate-hreflang-tag',
  'invalid-alternate-url',
  'invalid-canonical-url',
  'invalid-language-tag',
  'missing-reciprocal-alternate',
  'missing-self-alternate',
  'multiple-canonical',
  'multiple-x-default',
  'reciprocal-tag-mismatch',
  'x-default-conflict',
  'x-default-missing',
  'x-default-not-allowed',
]

/**
 * One page set per error, so the catalog's severities are pinned by behaviour
 * and not only by the table they are declared in: a rule downgraded to
 * `warning` in `src/rules.mjs` (and in the documentation alongside it) turns
 * the run these fixtures provoke from exit 1 into exit 0.
 */
const ERROR_FIXTURES = [
  ['canonical-self-link-conflict', 'optional', () => [
    pageRecord(A, [['en', A]], { file: 'a.html', hasHtml: true, canonicals: [B] }),
  ]],
  ['cluster-hreflang-conflict', 'optional', () => [
    pageRecord(A, [['en', A], ['de', B]], { file: 'a.html' }),
    pageRecord(B, [['en', B], ['de', A]], { file: 'b.html' }),
  ]],
  ['duplicate-hreflang-tag', 'optional', () => [
    pageRecord(A, [['en', A], ['en', B]], { file: 'a.html' }),
    pageRecord(B, [['en', A], ['en', B]], { file: 'b.html' }),
  ]],
  ['invalid-alternate-url', 'optional', () => [
    pageRecord(A, [['en', A], ['de', 'mailto:someone@example.com']], { file: 'a.html' }),
  ]],
  ['invalid-canonical-url', 'optional', () => [
    pageRecord(A, [['en', A]], { file: 'a.html', hasHtml: true, canonicals: ['mailto:someone@example.com'] }),
  ]],
  ['invalid-language-tag', 'optional', () => [
    pageRecord(A, [['en', A], ['not a tag', A]], { file: 'a.html' }),
  ]],
  ['missing-reciprocal-alternate', 'optional', () => [
    pageRecord(A, [['en', A], ['de', B]], { file: 'a.html' }),
    pageRecord(B, [['de', B]], { file: 'b.html' }),
  ]],
  ['missing-self-alternate', 'optional', () => [
    pageRecord(A, [['de', B]], { file: 'a.html' }),
    pageRecord(B, [['de', B]], { file: 'b.html' }),
  ]],
  ['multiple-canonical', 'optional', () => [
    pageRecord(A, [['en', A]], { file: 'a.html', hasHtml: true, canonicals: [A, A] }),
  ]],
  ['multiple-x-default', 'optional', () => [
    pageRecord(A, [['en', A], ['de', B], ['x-default', A], ['x-default', B]], { file: 'a.html' }),
    pageRecord(B, [['en', A], ['de', B]], { file: 'b.html' }),
  ]],
  ['reciprocal-tag-mismatch', 'optional', () => [
    pageRecord(A, [['en', A], ['de', B]], { file: 'a.html' }),
    pageRecord(B, [['en', A], ['fr', B]], { file: 'b.html' }),
  ]],
  ['x-default-conflict', 'optional', () => [
    pageRecord(A, [['en', A], ['de', B], ['x-default', A]], { file: 'a.html' }),
    pageRecord(B, [['en', A], ['de', B], ['x-default', B]], { file: 'b.html' }),
  ]],
  ['x-default-missing', 'required', () => [
    pageRecord(A, [['en', A], ['de', B]], { file: 'a.html' }),
    pageRecord(B, [['en', A], ['de', B]], { file: 'b.html' }),
  ]],
  ['x-default-not-allowed', 'forbidden', () => [
    pageRecord(A, [['en', A], ['de', B], ['x-default', A]], { file: 'a.html' }),
    pageRecord(B, [['en', A], ['de', B], ['x-default', A]], { file: 'b.html' }),
  ]],
]

test('every error the audit can report has a fixture', () => {
  assert.deepEqual(ERROR_FIXTURES.map(([ruleId]) => ruleId).sort(byCodeUnit), AUDIT_ERRORS)
  for (const ruleId of AUDIT_ERRORS) {
    assert.equal(RULE_IDS.includes(ruleId), true, `${ruleId} is not a rule`)
  }
})

test('each error the audit reports fails the run and exits 1 on its own', () => {
  for (const [ruleId, xDefault, build] of ERROR_FIXTURES) {
    const reported = sortFindings(run(build(), xDefault).findings).filter((finding) => finding.ruleId === ruleId)
    assert.equal(reported.length > 0, true, `the ${ruleId} fixture no longer reports ${ruleId}`)
    for (const finding of reported) {
      assert.equal(finding.severity, 'error', `${ruleId} is no longer an error`)
    }
    assert.equal(statusFor(reported), 'fail', `${ruleId} alone no longer fails the run`)
    assert.equal(exitCodeFor(buildReport(reported, COUNTS)), 1, `${ruleId} alone no longer exits 1`)
  }
})

test('a complete cluster of regional variants with an x-default is not a failure', () => {
  const audit = run(healthyCluster())
  assert.deepEqual(audit.findings, [])
  assert.equal(statusFor(audit.findings), 'pass')
  assert.deepEqual(
    { checked: audit.checked, clusters: audit.clusters, alternates: audit.alternates },
    { checked: 4, clusters: 1, alternates: 20 },
  )
})

test('ordering inside the audit is by code unit, not by locale collation', () => {
  // 'B' precedes 'a' by code unit and follows it under locale collation. Each
  // case below is decided by one of the audit's own sorts: which URLs a message
  // lists, which page a cluster finding is reported against, which referrer is
  // named, and which member a cluster is described as starting at.
  const UPPER = `${ORIGIN}/B/`
  const LOWER = `${ORIGIN}/a/`
  const MISSING = `${ORIGIN}/missing/`
  const upper = (alternates) => pageRecord(UPPER, alternates, { file: 'B.html', pointer: '/pages/0' })
  const lower = (alternates) => pageRecord(LOWER, alternates, { file: 'a.html', pointer: '/pages/1' })
  const only = (audit, ruleId) => sortFindings(audit.findings).filter((finding) => finding.ruleId === ruleId)

  const conflicts = only(run([
    upper([['en', UPPER], ['de', LOWER]]),
    lower([['en', LOWER], ['de', UPPER]]),
  ]), 'cluster-hreflang-conflict')
  assert.equal(conflicts.length, 2)
  for (const finding of conflicts) {
    assert.equal(finding.location.file, 'B.html', finding.message)
    assert.equal(finding.message.includes(`${UPPER}, ${LOWER}`), true, finding.message)
  }

  const unknown = only(run([
    upper([['en', UPPER], ['de', LOWER], ['fr', MISSING]]),
    lower([['en', UPPER], ['de', LOWER], ['fr', MISSING]]),
  ]), 'alternate-not-in-inputs')
  assert.equal(unknown.length, 1)
  assert.equal(unknown[0].location.file, 'B.html')
  assert.equal(unknown[0].message.includes(`including ${UPPER},`), true, unknown[0].message)

  const missing = only(run([
    upper([['en', UPPER], ['de', LOWER]]),
    lower([['en', UPPER], ['de', LOWER]]),
  ], 'required'), 'x-default-missing')
  assert.deepEqual(missing.map((finding) => finding.location), [{ file: 'B.html', pointer: '/pages/0' }])
  assert.equal(missing[0].message.includes(`starting at ${UPPER}`), true, missing[0].message)

  const xConflict = only(run([
    upper([['en', UPPER], ['de', LOWER], ['x-default', UPPER]]),
    lower([['en', UPPER], ['de', LOWER], ['x-default', LOWER]]),
  ]), 'x-default-conflict')
  assert.equal(xConflict.length, 1)
  assert.equal(xConflict[0].location.file, 'B.html')
  assert.equal(xConflict[0].message.includes(`${UPPER}, ${LOWER}`), true, xConflict[0].message)
})

test('a missing reciprocal alternate is reported once, on the page that fails to link back', () => {
  const pages = healthyCluster().map((page) => {
    if (page.url !== `${ORIGIN}/de-de/`) return page
    return { ...page, alternates: page.alternates.filter((entry) => entry.href !== `${ORIGIN}/fr/`) }
  })
  const audit = run(pages)
  assert.deepEqual(audit.findings, [{
    ruleId: 'missing-reciprocal-alternate',
    severity: 'error',
    message: `${ORIGIN}/fr/ declares ${ORIGIN}/de-de/ as the "de-de" alternate, but ${ORIGIN}/de-de/ does not declare ${ORIGIN}/fr/ in return.`,
    location: { file: 'de-de.html', pointer: '/pages/2' },
    evidence: `<link rel="alternate" hreflang="de-DE" href="${ORIGIN}/de-de/">`,
    suggestion: `Add an alternate on ${ORIGIN}/de-de/ pointing at ${ORIGIN}/fr/.`,
  }])
  assert.equal(statusFor(audit.findings), 'fail')
})

test('the audit does not depend on the order pages arrive in', () => {
  const pages = healthyCluster().map((page) => (
    page.url === `${ORIGIN}/de-de/`
      ? { ...page, alternates: page.alternates.filter((entry) => entry.href !== `${ORIGIN}/fr/`) }
      : page
  ))
  const forward = JSON.stringify(sortFindings(run(pages).findings))
  const backward = JSON.stringify(sortFindings(run([...pages].reverse()).findings))
  assert.equal(forward, backward)
  assert.equal(forward.includes('missing-reciprocal-alternate'), true)
})

test('an x-default is optional by default, required or forbidden on request', () => {
  const withDefault = healthyCluster()
  const withoutDefault = withDefault.map((page) => ({
    ...page,
    alternates: page.alternates.filter((entry) => entry.hreflang !== 'x-default'),
  }))

  assert.deepEqual(ruleIdsOf(run(withDefault, 'optional').findings), [])
  assert.deepEqual(ruleIdsOf(run(withoutDefault, 'optional').findings), [])
  assert.deepEqual(ruleIdsOf(run(withDefault, 'required').findings), [])
  assert.deepEqual(ruleIdsOf(run(withoutDefault, 'required').findings), ['x-default-missing'])
  assert.deepEqual(ruleIdsOf(run(withDefault, 'forbidden').findings), ['x-default-not-allowed'])

  const missing = run(withoutDefault, 'required').findings[0]
  assert.deepEqual(missing.location, { file: 'de-de.html', pointer: '/pages/2' })
  assert.equal(missing.severity, 'error')
})

test('two x-default targets in one cluster conflict', () => {
  const pages = healthyCluster().map((page) => (
    page.url === `${ORIGIN}/fr/`
      ? {
        ...page,
        alternates: page.alternates.map((entry) => (
          entry.hreflang === 'x-default' ? { ...entry, href: `${ORIGIN}/fr/` } : entry
        )),
      }
      : page
  ))
  const findings = sortFindings(run(pages).findings)
  assert.deepEqual(ruleIdsOf(findings), ['x-default-conflict'])
  assert.equal(
    findings[0].message,
    `Members of this cluster send x-default to 2 different URLs: ${ORIGIN}/en-us/, ${ORIGIN}/fr/.`,
  )
  assert.deepEqual(findings[0].location, { file: 'de-de.html', pointer: '/pages/2/alternates/4' })
})

test('one page naming two x-default targets is reported on that page', () => {
  const pages = [
    pageRecord(`${ORIGIN}/a/`, [
      ['en', `${ORIGIN}/a/`],
      ['de', `${ORIGIN}/b/`],
      ['x-default', `${ORIGIN}/a/`],
      ['x-default', `${ORIGIN}/b/`],
    ], { file: 'a.html', pointer: '/pages/0' }),
    pageRecord(`${ORIGIN}/b/`, [
      ['en', `${ORIGIN}/a/`],
      ['de', `${ORIGIN}/b/`],
      ['x-default', `${ORIGIN}/a/`],
    ], { file: 'b.html', pointer: '/pages/1' }),
  ]
  const findings = sortFindings(run(pages).findings)
  assert.deepEqual(ruleIdsOf(findings), ['multiple-x-default'])
  assert.deepEqual(findings[0].location, { file: 'a.html', pointer: '/pages/0/alternates/3' })
})

test('a malformed language tag does not cascade into a false reciprocity failure', () => {
  const pages = [
    pageRecord(`${ORIGIN}/a/`, [['en', `${ORIGIN}/a/`], ['de', `${ORIGIN}/b/`]], { file: 'a.html', pointer: '/pages/0' }),
    pageRecord(`${ORIGIN}/b/`, [['en_US', `${ORIGIN}/a/`], ['de', `${ORIGIN}/b/`]], { file: 'b.html', pointer: '/pages/1' }),
  ]
  const findings = sortFindings(run(pages).findings)
  assert.deepEqual(ruleIdsOf(findings), ['invalid-language-tag'])
  assert.deepEqual(findings[0].location, { file: 'b.html', pointer: '/pages/1/alternates/0' })
})

test('a page that does not list itself is reported', () => {
  const pages = [
    pageRecord(`${ORIGIN}/a/`, [['en', `${ORIGIN}/b/`]], { file: 'a.html', pointer: '/pages/0' }),
    pageRecord(`${ORIGIN}/b/`, [['en', `${ORIGIN}/b/`], ['de', `${ORIGIN}/a/`]], { file: 'b.html', pointer: '/pages/1' }),
  ]
  const findings = sortFindings(run(pages).findings)
  assert.deepEqual(ruleIdsOf(findings), ['missing-self-alternate'])
  assert.deepEqual(findings[0].location, { file: 'a.html', pointer: '/pages/0' })
})

test('a sibling called by a tag it does not use for itself is reported', () => {
  const pages = [
    pageRecord(`${ORIGIN}/a/`, [['en', `${ORIGIN}/a/`], ['de', `${ORIGIN}/b/`]], { file: 'a.html', pointer: '/pages/0' }),
    pageRecord(`${ORIGIN}/b/`, [['en', `${ORIGIN}/a/`], ['de-AT', `${ORIGIN}/b/`]], { file: 'b.html', pointer: '/pages/1' }),
  ]
  const findings = sortFindings(run(pages).findings)
  assert.deepEqual(ruleIdsOf(findings), ['reciprocal-tag-mismatch'])
  assert.equal(
    findings[0].message,
    `${ORIGIN}/a/ calls ${ORIGIN}/b/ the "de" alternate, but ${ORIGIN}/b/ self-links as "de-at".`,
  )
})

test('one tag pointing at two URLs is reported on the page and across the cluster', () => {
  const onePage = [
    pageRecord(`${ORIGIN}/a/`, [
      ['en', `${ORIGIN}/a/`],
      ['de', `${ORIGIN}/a/`],
      ['de', `${ORIGIN}/b/`],
    ], { file: 'a.html', pointer: '/pages/0' }),
    pageRecord(`${ORIGIN}/b/`, [
      ['en', `${ORIGIN}/a/`],
      ['de', `${ORIGIN}/b/`],
    ], { file: 'b.html', pointer: '/pages/1' }),
  ]
  assert.deepEqual(ruleIdsOf(run(onePage).findings), ['cluster-hreflang-conflict', 'duplicate-hreflang-tag'])

  const acrossCluster = [
    pageRecord(`${ORIGIN}/a/`, [['en', `${ORIGIN}/a/`], ['de', `${ORIGIN}/b/`], ['fr', `${ORIGIN}/c/`]], { file: 'a.html', pointer: '/pages/0' }),
    pageRecord(`${ORIGIN}/b/`, [['en', `${ORIGIN}/a/`], ['de', `${ORIGIN}/c/`], ['fr', `${ORIGIN}/c/`]], { file: 'b.html', pointer: '/pages/1' }),
    pageRecord(`${ORIGIN}/c/`, [['en', `${ORIGIN}/a/`], ['de', `${ORIGIN}/b/`], ['fr', `${ORIGIN}/c/`]], { file: 'c.html', pointer: '/pages/2' }),
  ]
  assert.deepEqual(
    ruleIdsOf(run(acrossCluster).findings),
    ['cluster-hreflang-conflict', 'missing-self-alternate', 'reciprocal-tag-mismatch'],
  )
})

test('repeating the same tag and URL pair is a warning, not a failure', () => {
  const pages = [pageRecord(`${ORIGIN}/a/`, [['en', `${ORIGIN}/a/`], ['en', `${ORIGIN}/a/`]], { file: 'a.html' })]
  const findings = sortFindings(run(pages).findings)
  assert.deepEqual(ruleIdsOf(findings), ['duplicate-alternate-entry'])
  assert.equal(statusFor(findings), 'pass')
})

test('an unconventionally cased tag is information, not a failure', () => {
  const pages = [pageRecord(`${ORIGIN}/a/`, [['EN', `${ORIGIN}/a/`]], { file: 'a.html' })]
  const findings = sortFindings(run(pages).findings)
  assert.deepEqual(ruleIdsOf(findings), ['language-tag-not-canonical-case'])
  assert.equal(findings[0].severity, 'info')
  assert.equal(statusFor(findings), 'pass')
})

test('an unusable alternate href is reported and declares nothing', () => {
  const pages = [
    pageRecord(`${ORIGIN}/a/`, [['en', `${ORIGIN}/a/`], ['de', 'mailto:someone@example.com']], { file: 'a.html' }),
  ]
  const audit = run(pages)
  assert.deepEqual(ruleIdsOf(audit.findings), ['invalid-alternate-url'])
  assert.equal(audit.clusters, 1)
})

test('pages joined only through a shared alternate are warned about, not failed', () => {
  const pages = [
    pageRecord(`${ORIGIN}/a/`, [['en', `${ORIGIN}/a/`], ['de', `${ORIGIN}/b/`], ['fr', `${ORIGIN}/c/`]], { file: 'a.html', pointer: '/pages/0' }),
    pageRecord(`${ORIGIN}/b/`, [['en', `${ORIGIN}/a/`], ['de', `${ORIGIN}/b/`]], { file: 'b.html', pointer: '/pages/1' }),
    pageRecord(`${ORIGIN}/c/`, [['en', `${ORIGIN}/a/`], ['fr', `${ORIGIN}/c/`]], { file: 'c.html', pointer: '/pages/2' }),
  ]
  const findings = sortFindings(run(pages).findings)
  assert.deepEqual(ruleIdsOf(findings), ['cluster-membership-incomplete', 'cluster-membership-incomplete'])
  assert.deepEqual(
    findings.map((finding) => [finding.location.file, finding.message]),
    [
      ['b.html', `${ORIGIN}/b/ does not declare ${ORIGIN}/c/, although both belong to the same alternate cluster.`],
      ['c.html', `${ORIGIN}/c/ does not declare ${ORIGIN}/b/, although both belong to the same alternate cluster.`],
    ],
  )
  assert.equal(statusFor(findings), 'pass')
})

test('an alternate no input describes makes the run incomplete, not a pass', () => {
  const pages = [pageRecord(`${ORIGIN}/a/`, [['en', `${ORIGIN}/a/`], ['es', `${ORIGIN}/es/`]], { file: 'a.html' })]
  const findings = sortFindings(run(pages).findings)
  assert.deepEqual(ruleIdsOf(findings), ['alternate-not-in-inputs'])
  assert.equal(findings[0].severity, 'warning')
  assert.equal(statusFor(findings), 'incomplete')
  assert.equal(
    findings[0].message,
    `${ORIGIN}/es/ is declared as an alternate by 1 page(s), including ${ORIGIN}/a/, but no input describes it, so its reciprocal links were not checked.`,
  )
})

test('canonical declarations are checked only for exported HTML pages', () => {
  const alternates = [['en', `${ORIGIN}/a/`]]
  const cases = [
    [[], ['missing-canonical']],
    [[`${ORIGIN}/a/`], []],
    [[`${ORIGIN}/b/`], ['canonical-self-link-conflict']],
    [[`${ORIGIN}/a/`, `${ORIGIN}/a/`], ['multiple-canonical']],
    [['mailto:someone@example.com'], ['invalid-canonical-url']],
  ]
  for (const [canonicals, expected] of cases) {
    const page = pageRecord(`${ORIGIN}/a/`, alternates, { file: 'a.html', hasHtml: true, canonicals })
    assert.deepEqual(ruleIdsOf(run([page]).findings), expected, `canonicals ${JSON.stringify(canonicals)}`)
  }
  const sitemapOnly = pageRecord(`${ORIGIN}/a/`, alternates, { file: 'sitemap.xml', hasHtml: false })
  assert.deepEqual(ruleIdsOf(run([sitemapOnly]).findings), [])
})

test('an unknown x-default policy is a programming error, not a silent default', () => {
  assert.throws(() => auditPages(healthyCluster(), { xDefault: 'Optional' }), /Unknown x-default policy/)
  assert.throws(() => auditPages(healthyCluster(), {}), /Unknown x-default policy/)
})
