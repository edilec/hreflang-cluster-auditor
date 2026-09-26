import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_LIMITS,
  EVIDENCE_MISSING_RULES,
  RULE_IDS,
  RULE_SEVERITY,
  SEVERITIES,
  buildReport,
  byCodeUnit,
  exitCodeFor,
  renderReport,
  marksEvidenceMissing,
  severityFor,
  sortFindings,
  statusFor,
} from '../src/index.mjs'
import { EVIDENCE_LIMIT, excerpt, makeFinding } from '../src/rules.mjs'

const DOC = fileURLToPath(new URL('../docs/hreflang-rules.md', import.meta.url))

async function documentedRules() {
  const text = await readFile(DOC, 'utf8')
  const rules = new Map()
  for (const line of text.split('\n')) {
    const match = /^\| `([a-z0-9-]+)` \| (error|warning|info) \| (yes|no) \|/.exec(line)
    if (match === null) continue
    assert.equal(rules.has(match[1]), false, `docs list ${match[1]} twice`)
    rules.set(match[1], { severity: match[2], evidenceMissing: match[3] === 'yes' })
  }
  return rules
}

async function documentedLimits() {
  const text = await readFile(DOC, 'utf8')
  const limits = new Map()
  for (const line of text.split('\n')) {
    const match = /^\| `(max[A-Za-z]+)` \| ([0-9]+) \| `([a-z-]+)` \|/.exec(line)
    if (match === null) continue
    limits.set(match[1], { value: Number(match[2]), rule: match[3] })
  }
  return limits
}

/**
 * The catalog, written out by hand.
 *
 * `docs/hreflang-rules.md` holds the other copy, and the cross-check between
 * the documentation and the table is defeated by editing both sides at once --
 * which is exactly the shape a silent severity downgrade takes. This third copy
 * is deliberate duplication: each row states, independently of `src/rules.mjs`,
 * what a run holding one finding of that rule reports and exits with.
 */
const CATALOG = [
  // ruleId, severity, marks evidence missing, status of a run holding only it
  ['alternate-limit-exceeded', 'error', true, 'incomplete'],
  ['alternate-not-in-inputs', 'warning', true, 'incomplete'],
  ['alternate-source-conflict', 'error', false, 'fail'],
  ['canonical-self-link-conflict', 'error', false, 'fail'],
  ['cluster-hreflang-conflict', 'error', false, 'fail'],
  ['cluster-membership-incomplete', 'warning', false, 'pass'],
  ['duplicate-alternate-entry', 'warning', false, 'pass'],
  ['duplicate-hreflang-tag', 'error', false, 'fail'],
  ['html-not-utf8', 'error', true, 'incomplete'],
  ['html-too-large', 'error', true, 'incomplete'],
  ['html-unreadable', 'error', true, 'incomplete'],
  ['invalid-alternate-url', 'error', false, 'fail'],
  ['invalid-canonical-url', 'error', false, 'fail'],
  ['invalid-language-tag', 'error', false, 'fail'],
  ['language-tag-not-canonical-case', 'info', false, 'pass'],
  ['missing-canonical', 'warning', false, 'pass'],
  ['missing-reciprocal-alternate', 'error', false, 'fail'],
  ['missing-self-alternate', 'error', false, 'fail'],
  ['multiple-canonical', 'error', false, 'fail'],
  ['multiple-x-default', 'error', false, 'fail'],
  ['no-pages-checked', 'error', true, 'incomplete'],
  ['page-limit-exceeded', 'error', true, 'incomplete'],
  ['reciprocal-tag-mismatch', 'error', false, 'fail'],
  ['sitemap-index-not-expanded', 'error', true, 'incomplete'],
  ['sitemap-not-utf8', 'error', true, 'incomplete'],
  ['sitemap-too-large', 'error', true, 'incomplete'],
  ['sitemap-unparsable', 'error', true, 'incomplete'],
  ['sitemap-unreadable', 'error', true, 'incomplete'],
  ['sitemap-url-limit-exceeded', 'error', true, 'incomplete'],
  ['x-default-conflict', 'error', false, 'fail'],
  ['x-default-missing', 'error', false, 'fail'],
  ['x-default-not-allowed', 'error', false, 'fail'],
]

const CATALOG_IDS = CATALOG.map(([ruleId]) => ruleId)
const EXIT_CODE = { pass: 0, fail: 1, incomplete: 2 }
const COUNTS = { checked: 0, clusters: 0, alternates: 0, xDefault: 'optional' }

test('the severity table is frozen, complete and in code unit order', () => {
  assert.equal(Object.isFrozen(RULE_SEVERITY), true)
  assert.equal(Object.isFrozen(RULE_IDS), true)
  // Not `[...RULE_IDS].sort(byCodeUnit)`: re-sorting an array with the
  // comparator it was built from cannot fail. Adjacent pairs are compared
  // directly instead, and the whole list is pinned against CATALOG.
  for (let index = 1; index < RULE_IDS.length; index += 1) {
    assert.equal(RULE_IDS[index - 1] < RULE_IDS[index], true, `${RULE_IDS[index]} is out of code unit order`)
  }
  assert.deepEqual([...RULE_IDS], CATALOG_IDS)
  assert.deepEqual(Object.keys(RULE_SEVERITY).sort(byCodeUnit), CATALOG_IDS)
  for (const ruleId of RULE_IDS) {
    assert.equal(SEVERITIES.includes(RULE_SEVERITY[ruleId]), true, `${ruleId} has an unknown severity`)
  }
})

test('every rule pins its own severity, evidence class, status and exit code', () => {
  assert.deepEqual(CATALOG_IDS, [...RULE_IDS], 'CATALOG and RULE_IDS list different rules')
  for (const [ruleId, severity, evidenceMissing, status] of CATALOG) {
    assert.equal(RULE_SEVERITY[ruleId], severity, `${ruleId} severity differs from the pinned catalog`)
    assert.equal(marksEvidenceMissing(ruleId), evidenceMissing, `${ruleId} evidence class differs from the pinned catalog`)
    const finding = makeFinding(ruleId, 'message', {})
    assert.equal(finding.severity, severity, `${ruleId} finding severity differs from the pinned catalog`)
    assert.equal(statusFor([finding]), status, `${ruleId} alone no longer reports ${status}`)
    assert.equal(
      exitCodeFor(buildReport([finding], COUNTS)),
      EXIT_CODE[status],
      `${ruleId} alone no longer exits ${EXIT_CODE[status]}`,
    )
  }
  assert.deepEqual(
    CATALOG.filter(([, , evidenceMissing]) => evidenceMissing).map(([ruleId]) => ruleId),
    [...EVIDENCE_MISSING_RULES],
  )
})

test('an excerpt of untrusted input is collapsed and bounded', () => {
  assert.equal(excerpt('  a\n\t b  '), 'a b')
  assert.equal(excerpt('a\u2028b\u2029c'), 'a b c', 'the separators are whitespace too')
  assert.equal(excerpt(''), '')

  const atBound = 'x'.repeat(EVIDENCE_LIMIT)
  assert.equal(excerpt(atBound), atBound, 'a value exactly at the bound is not truncated')

  const past = excerpt('x'.repeat(EVIDENCE_LIMIT * 100))
  assert.equal(past.length, EVIDENCE_LIMIT)
  assert.equal(past, `${'x'.repeat(EVIDENCE_LIMIT - 3)}...`)

  // Collapsing happens before the bound, so padding is not a way past it.
  assert.equal(excerpt('y '.repeat(EVIDENCE_LIMIT * 2)).length, EVIDENCE_LIMIT)
})

test('the rendered report escapes the separators JSON leaves raw', () => {
  const report = buildReport(
    [makeFinding('missing-canonical', 'a\u2028b\u2029c', { file: 'build/odd\u2028name.html' })],
    COUNTS,
  )
  const text = renderReport(report)
  assert.deepEqual(JSON.parse(text), report, 'the payload no longer parses as JSON')
  assert.equal(/[\u2028\u2029]/u.test(text), false, 'a raw line separator reached stdout')
  assert.equal(text.includes('\\u2028'), true)
  assert.equal(text.endsWith('}\n'), true)
})

test('an unknown rule id throws instead of defaulting to something harmless', () => {
  assert.throws(() => severityFor('missing-reciprocal-alternates'), /Unknown ruleId/)
  assert.throws(() => makeFinding('not-a-rule', 'message', {}), /Unknown ruleId/)
  assert.throws(() => marksEvidenceMissing('not-a-rule'), /Unknown ruleId/)
})

test('every finding takes its severity from the table', () => {
  for (const ruleId of RULE_IDS) {
    assert.equal(makeFinding(ruleId, 'message', {}).severity, RULE_SEVERITY[ruleId])
  }
})

test('the documented catalog and the code agree in both directions', async () => {
  const documented = await documentedRules()
  assert.deepEqual([...documented.keys()].sort(byCodeUnit), [...RULE_IDS])
  for (const ruleId of RULE_IDS) {
    assert.equal(documented.get(ruleId).severity, RULE_SEVERITY[ruleId], `${ruleId} severity differs from the docs`)
    assert.equal(
      documented.get(ruleId).evidenceMissing,
      marksEvidenceMissing(ruleId),
      `${ruleId} evidence column differs from the code`,
    )
  }
  const documentedMissing = [...documented.entries()]
    .filter(([, value]) => value.evidenceMissing)
    .map(([ruleId]) => ruleId)
    .sort(byCodeUnit)
  assert.deepEqual(documentedMissing, [...EVIDENCE_MISSING_RULES])
})

test('the documented limits and the defaults agree in both directions', async () => {
  const documented = await documentedLimits()
  assert.deepEqual([...documented.keys()].sort(byCodeUnit), Object.keys(DEFAULT_LIMITS).sort(byCodeUnit))
  for (const [name, entry] of documented) {
    assert.equal(entry.value, DEFAULT_LIMITS[name], `${name} default differs from the docs`)
    assert.equal(RULE_SEVERITY[entry.rule] !== undefined, true, `${name} names an unknown rule`)
    assert.equal(marksEvidenceMissing(entry.rule), true, `${name} must report missing evidence when exceeded`)
  }
})

test('each evidence-missing rule alone forces incomplete, whatever its severity', () => {
  for (const ruleId of EVIDENCE_MISSING_RULES) {
    const finding = makeFinding(ruleId, 'message', {})
    assert.equal(statusFor([finding]), 'incomplete', `${ruleId} did not force incomplete`)
  }
})

test('a warning-severity evidence rule still cannot produce a pass', () => {
  // alternate-not-in-inputs is the one rule where severity alone would allow a
  // pass. If its membership of EVIDENCE_MISSING_RULES is removed this fails.
  assert.equal(RULE_SEVERITY['alternate-not-in-inputs'], 'warning')
  assert.equal(statusFor([makeFinding('alternate-not-in-inputs', 'message', {})]), 'incomplete')
})

test('status is a function of the findings', () => {
  assert.equal(statusFor([]), 'pass')
  assert.equal(statusFor([makeFinding('missing-canonical', 'm', {})]), 'pass')
  assert.equal(statusFor([makeFinding('language-tag-not-canonical-case', 'm', {})]), 'pass')
  assert.equal(statusFor([makeFinding('missing-self-alternate', 'm', {})]), 'fail')
  assert.equal(
    statusFor([makeFinding('missing-self-alternate', 'm', {}), makeFinding('html-unreadable', 'm', {})]),
    'incomplete',
  )
})

test('findings sort by file, then pointer, then rule, then message', () => {
  const findings = [
    makeFinding('missing-self-alternate', 'b', { file: 'b.html', pointer: '/pages/1' }),
    makeFinding('missing-canonical', 'a', { file: 'b.html', pointer: '/pages/1' }),
    makeFinding('missing-canonical', 'a', { file: 'a.html', pointer: '/pages/2' }),
    makeFinding('missing-canonical', 'z', { file: 'a.html', pointer: '/pages/10' }),
    makeFinding('missing-canonical', 'a', { file: 'a.html', pointer: '/pages/10' }),
  ]
  const sorted = sortFindings(findings).map((finding) => [
    finding.location.file,
    finding.location.pointer,
    finding.ruleId,
    finding.message,
  ])
  assert.deepEqual(sorted, [
    ['a.html', '/pages/10', 'missing-canonical', 'a'],
    ['a.html', '/pages/10', 'missing-canonical', 'z'],
    ['a.html', '/pages/2', 'missing-canonical', 'a'],
    ['b.html', '/pages/1', 'missing-canonical', 'a'],
    ['b.html', '/pages/1', 'missing-self-alternate', 'b'],
  ])
  assert.equal(sortFindings(findings) !== findings, true)
})

test('findings are ordered by code unit at every level, not by locale collation', () => {
  // 'B' precedes 'a' by code unit and follows it under locale collation, so a
  // comparison swapped for localeCompare at any level inverts one of these.
  const order = (findings) => sortFindings(findings).map((finding) => finding.message)

  assert.deepEqual(
    order([
      makeFinding('missing-canonical', 'lower', { file: 'build/a.html', pointer: '/pages/1' }),
      makeFinding('missing-canonical', 'upper', { file: 'build/B.html', pointer: '/pages/0' }),
    ]),
    ['upper', 'lower'],
    'location.file is not compared by code unit',
  )
  assert.deepEqual(
    order([
      makeFinding('missing-canonical', 'lower', { file: 'one.html', pointer: '/pages/a' }),
      makeFinding('missing-canonical', 'upper', { file: 'one.html', pointer: '/pages/B' }),
    ]),
    ['upper', 'lower'],
    'location.pointer is not compared by code unit',
  )
  assert.deepEqual(
    order([
      makeFinding('missing-canonical', 'https://example.com/a/ has no canonical', { file: 'one.html', pointer: '/pages/0' }),
      makeFinding('missing-canonical', 'https://example.com/B/ has no canonical', { file: 'one.html', pointer: '/pages/0' }),
    ]),
    ['https://example.com/B/ has no canonical', 'https://example.com/a/ has no canonical'],
    'message is not compared by code unit',
  )
  assert.deepEqual(
    sortFindings([
      makeFinding('missing-canonical', 'm', { file: 'one.html', pointer: '/pages/0' }),
      makeFinding('invalid-canonical-url', 'm', { file: 'one.html', pointer: '/pages/0' }),
    ]).map((finding) => finding.ruleId),
    ['invalid-canonical-url', 'missing-canonical'],
    'ruleId is not compared by code unit',
  )
})

test('byCodeUnit orders by code unit, not by locale collation', () => {
  const names = ['MAX_DUPLICATE_URL_ENTRIES', 'MAX_DUPLICATE_URLS']
  assert.deepEqual([...names].sort(byCodeUnit), ['MAX_DUPLICATE_URLS', 'MAX_DUPLICATE_URL_ENTRIES'])
  assert.equal(byCodeUnit('a', 'a'), 0)
})
