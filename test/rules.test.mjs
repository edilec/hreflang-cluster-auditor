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
  byCodeUnit,
  marksEvidenceMissing,
  severityFor,
  sortFindings,
  statusFor,
} from '../src/index.mjs'
import { makeFinding } from '../src/rules.mjs'

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

test('the severity table is frozen and complete', () => {
  assert.equal(Object.isFrozen(RULE_SEVERITY), true)
  assert.equal(RULE_IDS.length, Object.keys(RULE_SEVERITY).length)
  assert.deepEqual(RULE_IDS, [...RULE_IDS].sort(byCodeUnit))
  for (const ruleId of RULE_IDS) {
    assert.equal(SEVERITIES.includes(RULE_SEVERITY[ruleId]), true, `${ruleId} has an unknown severity`)
  }
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

test('byCodeUnit orders by code unit, not by locale collation', () => {
  const names = ['MAX_DUPLICATE_URL_ENTRIES', 'MAX_DUPLICATE_URLS']
  assert.deepEqual([...names].sort(byCodeUnit), ['MAX_DUPLICATE_URLS', 'MAX_DUPLICATE_URL_ENTRIES'])
  assert.equal(byCodeUnit('a', 'a'), 0)
})
