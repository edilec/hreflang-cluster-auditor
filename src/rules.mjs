/**
 * The rule catalog.
 *
 * Severity decides whether a run passes or fails, so it is declared exactly
 * once, here, and every finding takes its severity from this table. A finding
 * built with an unknown rule id throws rather than defaulting to something
 * harmless: a typo must not invent a rule that silently cannot fail.
 *
 * `EVIDENCE_MISSING_RULES` is the second half of the same idea. A run whose
 * evidence was missing, truncated or undecodable is `incomplete`, never `pass`,
 * and that is derived from the findings themselves rather than from a separate
 * mutable flag -- there is no single assignment whose deletion would quietly
 * turn an unread input into a green build.
 */

/** Deterministic order: UTF-16 code unit, never locale collation. */
export function byCodeUnit(a, b) {
  return a === b ? 0 : a < b ? -1 : 1
}

export const SEVERITIES = Object.freeze(['error', 'warning', 'info'])

export const RULE_SEVERITY = Object.freeze({
  'alternate-limit-exceeded': 'error',
  'alternate-not-in-inputs': 'warning',
  'alternate-source-conflict': 'error',
  'canonical-self-link-conflict': 'error',
  'cluster-hreflang-conflict': 'error',
  'cluster-membership-incomplete': 'warning',
  'duplicate-alternate-entry': 'warning',
  'duplicate-hreflang-tag': 'error',
  'html-not-utf8': 'error',
  'html-too-large': 'error',
  'html-unreadable': 'error',
  'invalid-alternate-url': 'error',
  'invalid-canonical-url': 'error',
  'invalid-language-tag': 'error',
  'language-tag-not-canonical-case': 'info',
  'missing-canonical': 'warning',
  'missing-reciprocal-alternate': 'error',
  'missing-self-alternate': 'error',
  'multiple-canonical': 'error',
  'multiple-x-default': 'error',
  'no-pages-checked': 'error',
  'page-limit-exceeded': 'error',
  'reciprocal-tag-mismatch': 'error',
  'sitemap-index-not-expanded': 'error',
  'sitemap-not-utf8': 'error',
  'sitemap-too-large': 'error',
  'sitemap-unparsable': 'error',
  'sitemap-unreadable': 'error',
  'sitemap-url-limit-exceeded': 'error',
  'x-default-conflict': 'error',
  'x-default-missing': 'error',
  'x-default-not-allowed': 'error',
})

export const RULE_IDS = Object.freeze(Object.keys(RULE_SEVERITY).sort(byCodeUnit))

/**
 * Rules that mean the tool did not obtain the evidence it needed. Any one of
 * them makes the whole report `incomplete` and the process exit 2, whatever the
 * rule's own severity is -- `alternate-not-in-inputs` is only a warning, and it
 * still may not produce a pass.
 */
export const EVIDENCE_MISSING_RULES = Object.freeze([
  'alternate-limit-exceeded',
  'alternate-not-in-inputs',
  'html-not-utf8',
  'html-too-large',
  'html-unreadable',
  'no-pages-checked',
  'page-limit-exceeded',
  'sitemap-index-not-expanded',
  'sitemap-not-utf8',
  'sitemap-too-large',
  'sitemap-unparsable',
  'sitemap-unreadable',
  'sitemap-url-limit-exceeded',
].sort(byCodeUnit))

const EVIDENCE_MISSING_SET = new Set(EVIDENCE_MISSING_RULES)

export const EVIDENCE_LIMIT = 200

export function severityFor(ruleId) {
  const severity = RULE_SEVERITY[ruleId]
  if (severity === undefined) throw new Error(`Unknown ruleId "${ruleId}"`)
  return severity
}

export function marksEvidenceMissing(ruleId) {
  severityFor(ruleId)
  return EVIDENCE_MISSING_SET.has(ruleId)
}

/** A bounded, whitespace-collapsed excerpt of untrusted input. */
export function excerpt(text) {
  const flat = String(text).replace(/\s+/gu, ' ').trim()
  return flat.length > EVIDENCE_LIMIT ? `${flat.slice(0, EVIDENCE_LIMIT - 3)}...` : flat
}

export function at(file, pointer) {
  const location = {}
  if (file !== null && file !== undefined) location.file = file
  if (pointer !== null && pointer !== undefined) location.pointer = pointer
  return location
}

export function makeFinding(ruleId, message, location, extra = {}) {
  const finding = { ruleId, severity: severityFor(ruleId), message, location }
  if (extra.evidence !== undefined) finding.evidence = excerpt(extra.evidence)
  if (extra.suggestion !== undefined) finding.suggestion = extra.suggestion
  return finding
}

/** Findings sort by (file, pointer, ruleId, message), each by code unit. */
export function compareFindings(a, b) {
  return (
    byCodeUnit(a.location.file ?? '', b.location.file ?? '')
    || byCodeUnit(a.location.pointer ?? '', b.location.pointer ?? '')
    || byCodeUnit(a.ruleId, b.ruleId)
    || byCodeUnit(a.message, b.message)
  )
}

export function sortFindings(findings) {
  return [...findings].sort(compareFindings)
}

/**
 * Status is a function of the findings, so no separate flag can be deleted to
 * turn an unread input into a pass.
 */
export function statusFor(findings) {
  for (const finding of findings) {
    if (EVIDENCE_MISSING_SET.has(finding.ruleId)) return 'incomplete'
  }
  for (const finding of findings) {
    if (finding.severity === 'error') return 'fail'
  }
  return 'pass'
}
