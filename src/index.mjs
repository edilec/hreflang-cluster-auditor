/**
 * hreflang-cluster-auditor
 *
 * Build locale clusters out of exported HTML and sitemap files, then check the
 * things an hreflang set actually promises: every member links back, every
 * member links to itself, every language tag is well-formed BCP 47, the
 * canonical agrees with the self-link, and the cluster names at most one
 * x-default -- or exactly one, when that is configured.
 *
 * Nothing is fetched. Every page the audit reasons about comes from a file the
 * configuration named, inside a declared input root that the configuration
 * cannot escape, lexically or through a symbolic link. A URL that is referenced
 * but not supplied is reported as missing evidence, which is `incomplete` and
 * exit 2 -- never a pass.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { auditPages, X_DEFAULT_POLICIES } from './audit.mjs'
import { scanHtml } from './html-scan.mjs'
import { scanSitemap } from './sitemap-scan.mjs'
import {
  EVIDENCE_MISSING_RULES,
  RULE_IDS,
  RULE_SEVERITY,
  at,
  byCodeUnit,
  makeFinding,
  marksEvidenceMissing,
  severityFor,
  sortFindings,
  statusFor,
} from './rules.mjs'
import { normalizeUrl, parseLanguageTag } from './tags.mjs'

export { X_DEFAULT_POLICIES, auditPages } from './audit.mjs'
export { scanHtml, decodeEntities } from './html-scan.mjs'
export { scanSitemap } from './sitemap-scan.mjs'
export {
  EVIDENCE_MISSING_RULES,
  RULE_IDS,
  RULE_SEVERITY,
  SEVERITIES,
  byCodeUnit,
  compareFindings,
  marksEvidenceMissing,
  severityFor,
  sortFindings,
  statusFor,
} from './rules.mjs'
export { MAX_TAG_LENGTH, MAX_URL_LENGTH, X_DEFAULT, normalizeUrl, parseLanguageTag } from './tags.mjs'

export const TOOL_ID = 'hreflang-cluster-auditor'
export const REPORT_SCHEMA_VERSION = '1'
export const CONFIG_SCHEMA_VERSION = '1'

/** Every limit here is enforced; exceeding one is a finding, never a truncation. */
export const DEFAULT_LIMITS = Object.freeze({
  maxPages: 5000,
  maxAlternatesPerPage: 200,
  maxHtmlBytes: 2000000,
  maxSitemapBytes: 33554432,
  maxSitemapUrls: 50000,
})

export const LIMIT_NAMES = Object.freeze(Object.keys(DEFAULT_LIMITS).sort(byCodeUnit))
const CONFIG_KEYS = Object.freeze(['schemaVersion', 'pages', 'sitemaps', 'xDefault', 'limits'])
const PAGE_KEYS = Object.freeze(['url', 'html'])

/** A problem with the configuration itself, not with the site being audited. */
export class ConfigError extends Error {
  constructor(message, rule = null) {
    super(message)
    this.name = 'ConfigError'
    this.rule = rule
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toPosix(value) {
  return value.split(sep).join('/')
}

function escapes(from, target) {
  const rel = relative(from, target)
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

/**
 * The real path a target has once every symbolic link on the way to it is
 * followed.
 *
 * `realpath` needs the whole path to exist, but a file that was never exported
 * must still reach the report as `html-unreadable` rather than as a
 * configuration error. So the deepest existing ancestor is resolved for real and
 * the missing segments are appended literally: a link anywhere along the part
 * that does exist is still followed.
 */
async function realPathOf(target, describe) {
  const tail = []
  let current = target
  for (;;) {
    try {
      const real = await realpath(current)
      return tail.length === 0 ? real : resolve(real, ...tail)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        throw new ConfigError(
          `${describe} could not be resolved (${error.code ?? 'unknown error'})`,
          'input-unresolvable',
        )
      }
      const parent = dirname(current)
      if (parent === current) return target
      tail.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * Resolve a configured input path, refusing to leave the declared root.
 *
 * The lexical check is not the boundary. A symbolic link planted inside the root
 * points wherever it likes, and following one would read a file the
 * configuration never had the right to name and echo its bytes into the report.
 * So the path is confined again after every link on it has been followed,
 * against the real path of the root -- the root may itself sit behind a link, as
 * `/var` does on macOS.
 */
export async function resolveWithin(root, realRoot, candidate, label) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new ConfigError(`${label} must be a non-empty relative path`, 'input-not-relative')
  }
  if (isAbsolute(candidate)) {
    throw new ConfigError(`${label} must be relative to the input root, but "${candidate}" is absolute`, 'input-not-relative')
  }
  const resolved = resolve(root, candidate)
  if (escapes(root, resolved)) {
    throw new ConfigError(`${label} resolves outside the input root: "${candidate}"`, 'input-outside-root')
  }
  const real = await realPathOf(resolved, `${label} ("${candidate}")`)
  if (escapes(realRoot, real)) {
    throw new ConfigError(
      `${label} leaves the input root through a symbolic link: "${candidate}". Nothing was read from it.`,
      'input-escapes-root',
    )
  }
  return resolved
}

export function validateConfig(document, overrides = {}) {
  if (!isRecord(document)) throw new ConfigError('Config must be a JSON object')
  for (const key of Object.keys(document)) {
    if (!CONFIG_KEYS.includes(key)) {
      throw new ConfigError(`Unknown config key "${key}". Known keys: ${CONFIG_KEYS.join(', ')}`)
    }
  }
  if (document.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigError(`Unsupported config schemaVersion: ${document.schemaVersion ?? 'missing'}`)
  }

  const pageSource = document.pages ?? []
  if (!Array.isArray(pageSource)) throw new ConfigError('pages must be an array')
  const seenUrls = new Set()
  const pages = pageSource.map((entry, index) => {
    if (!isRecord(entry)) throw new ConfigError(`pages[${index}] must be an object`)
    for (const key of Object.keys(entry)) {
      if (!PAGE_KEYS.includes(key)) {
        throw new ConfigError(`Unknown key "${key}" in pages[${index}]. Known keys: ${PAGE_KEYS.join(', ')}`)
      }
    }
    const url = normalizeUrl(entry.url)
    if (!url.ok) throw new ConfigError(`pages[${index}].url is not usable: ${url.reason}`)
    if (seenUrls.has(url.url)) throw new ConfigError(`pages[${index}].url repeats ${url.url}`)
    seenUrls.add(url.url)
    if (typeof entry.html !== 'string' || entry.html.trim() === '') {
      throw new ConfigError(`pages[${index}].html must name the exported HTML document for this page`)
    }
    return { index, url: url.url, html: entry.html }
  })

  const sitemaps = document.sitemaps ?? []
  if (!Array.isArray(sitemaps) || sitemaps.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new ConfigError('sitemaps must be an array of non-empty relative paths')
  }
  if (pages.length === 0 && sitemaps.length === 0) {
    throw new ConfigError('Config must declare at least one page or one sitemap to audit')
  }

  const xDefault = overrides.xDefault ?? document.xDefault ?? 'optional'
  if (!X_DEFAULT_POLICIES.includes(xDefault)) {
    throw new ConfigError(
      `xDefault must be one of ${X_DEFAULT_POLICIES.join(', ')}, got "${String(xDefault).slice(0, 40)}"`,
    )
  }

  const limits = { ...DEFAULT_LIMITS }
  if (document.limits !== undefined) {
    if (!isRecord(document.limits)) throw new ConfigError('limits must be an object')
    for (const [name, value] of Object.entries(document.limits)) {
      if (!LIMIT_NAMES.includes(name)) {
        throw new ConfigError(`Unknown limit "${name}". Known limits: ${LIMIT_NAMES.join(', ')}`)
      }
      if (!Number.isInteger(value) || value < 1) throw new ConfigError(`limits.${name} must be a positive integer`)
      limits[name] = value
    }
  }

  return { schemaVersion: CONFIG_SCHEMA_VERSION, pages, sitemaps, xDefault, limits }
}

/**
 * Read a file as UTF-8, strictly.
 *
 * `fatal: true` is the whole point: a file whose bytes are not UTF-8 is reported
 * as undecodable, and encoding validity is never inferred from the decoded text.
 * A document that legitimately contains U+FFFD is not evidence of anything.
 */
async function readTextBounded(file, maxBytes) {
  let info
  try {
    info = await stat(file)
  } catch (error) {
    return { status: 'unreadable', reason: error.code ?? 'unknown error', text: null }
  }
  if (!info.isFile()) return { status: 'unreadable', reason: 'not a regular file', text: null }
  if (info.size > maxBytes) {
    return { status: 'too-large', reason: `${info.size} bytes exceeds the ${maxBytes} byte limit`, text: null }
  }
  let bytes
  try {
    bytes = await readFile(file)
  } catch (error) {
    return { status: 'unreadable', reason: error.code ?? 'unknown error', text: null }
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { status: 'not-utf8', reason: 'the bytes are not valid UTF-8', text: null }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return { status: 'ok', reason: null, text }
}

function signatureOf(record) {
  return record.alternates
    .map((entry) => {
      const target = normalizeUrl(entry.href, record.url)
      return `${String(entry.hreflang ?? '').trim().toLowerCase()} ${target.ok ? target.url : String(entry.href ?? '').trim()}`
    })
    .sort(byCodeUnit)
    .join(' | ')
}

async function loadPages(config, root, realRoot, findings) {
  const byUrl = new Map()

  const add = (record) => {
    const existing = byUrl.get(record.url)
    if (existing === undefined) {
      byUrl.set(record.url, record)
      return
    }
    if (signatureOf(existing) !== signatureOf(record)) {
      findings.push(makeFinding(
        'alternate-source-conflict',
        `${record.url} declares a different alternate set here than in ${existing.file}; the ${existing.source} declaration was used.`,
        at(record.file, record.pointer),
        {
          evidence: signatureOf(record),
          suggestion: 'Export the same alternate set from every source, or audit one source at a time.',
        },
      ))
    }
  }

  for (const page of config.pages) {
    const pointer = `/pages/${page.index}`
    const absolute = await resolveWithin(root, realRoot, page.html, `pages[${page.index}].html`)
    const file = toPosix(relative(root, absolute))
    const read = await readTextBounded(absolute, config.limits.maxHtmlBytes)
    if (read.status === 'unreadable') {
      findings.push(makeFinding('html-unreadable', `The exported HTML for ${page.url} could not be read (${read.reason}).`, at(file, pointer), { suggestion: 'Export the page before auditing, or correct pages[].html.' }))
      continue
    }
    if (read.status === 'too-large') {
      findings.push(makeFinding('html-too-large', `The exported HTML for ${page.url} was not read: ${read.reason}.`, at(file, pointer), { suggestion: 'Raise limits.maxHtmlBytes deliberately, or export a smaller document.' }))
      continue
    }
    if (read.status === 'not-utf8') {
      findings.push(makeFinding('html-not-utf8', `The exported HTML for ${page.url} was not decoded: ${read.reason}.`, at(file, pointer), { suggestion: 'Export the document as UTF-8.' }))
      continue
    }
    const scan = scanHtml(read.text, { maxAlternates: config.limits.maxAlternatesPerPage })
    if (scan.overflow) {
      findings.push(makeFinding('alternate-limit-exceeded', `${page.url} declares ${scan.alternatesFound} alternates, over the limit of ${config.limits.maxAlternatesPerPage}; the page was not audited.`, at(file, pointer), { suggestion: 'Raise limits.maxAlternatesPerPage deliberately, or shrink the cluster.' }))
      continue
    }
    add({
      url: page.url,
      file,
      pointer,
      source: 'HTML',
      hasHtml: true,
      alternates: scan.alternates.map((entry) => ({ ...entry, pointer: `${pointer}/alternates/${entry.index}` })),
      canonicals: scan.canonicals.map((entry) => ({ ...entry, pointer: `${pointer}/canonicals/${entry.index}` })),
    })
  }

  for (const [sitemapIndex, declared] of config.sitemaps.entries()) {
    const pointer = `/sitemaps/${sitemapIndex}`
    const absolute = await resolveWithin(root, realRoot, declared, `sitemaps[${sitemapIndex}]`)
    const file = toPosix(relative(root, absolute))
    const read = await readTextBounded(absolute, config.limits.maxSitemapBytes)
    if (read.status === 'unreadable') {
      findings.push(makeFinding('sitemap-unreadable', `The sitemap export could not be read (${read.reason}).`, at(file, pointer), { suggestion: 'Export the sitemap before auditing, or correct sitemaps[].' }))
      continue
    }
    if (read.status === 'too-large') {
      findings.push(makeFinding('sitemap-too-large', `The sitemap export was not read: ${read.reason}.`, at(file, pointer), { suggestion: 'Raise limits.maxSitemapBytes deliberately, or split the sitemap.' }))
      continue
    }
    if (read.status === 'not-utf8') {
      findings.push(makeFinding('sitemap-not-utf8', `The sitemap export was not decoded: ${read.reason}.`, at(file, pointer), { suggestion: 'Export the sitemap as UTF-8.' }))
      continue
    }
    const scan = scanSitemap(read.text, {
      maxUrls: config.limits.maxSitemapUrls,
      maxAlternates: config.limits.maxAlternatesPerPage,
    })
    if (scan.kind === 'sitemapindex') {
      findings.push(makeFinding('sitemap-index-not-expanded', 'This file is a sitemap index. Indexes are not expanded, because that would mean opening paths chosen by the input document.', at(file, pointer), { suggestion: 'List the child sitemap files in sitemaps[] instead.' }))
      continue
    }
    if (scan.kind !== 'urlset') {
      findings.push(makeFinding('sitemap-unparsable', `The sitemap export was not understood: ${scan.reason}.`, at(file, pointer), { suggestion: 'Supply a sitemap export whose root element is <urlset>.' }))
      continue
    }
    if (scan.overflow) {
      findings.push(makeFinding('sitemap-url-limit-exceeded', `The sitemap holds ${scan.urlsFound} url entries, over the limit of ${config.limits.maxSitemapUrls}; none of them were audited.`, at(file, pointer), { suggestion: 'Raise limits.maxSitemapUrls deliberately, or split the sitemap.' }))
      continue
    }
    for (const entry of scan.entries) {
      const entryPointer = `${pointer}/urls/${entry.index}`
      if (entry.overflow) {
        findings.push(makeFinding('alternate-limit-exceeded', `A sitemap entry declares ${entry.linksFound} alternates, over the limit of ${config.limits.maxAlternatesPerPage}; the entry was not audited.`, at(file, entryPointer), { suggestion: 'Raise limits.maxAlternatesPerPage deliberately, or shrink the cluster.' }))
        continue
      }
      if (entry.loc === null) {
        findings.push(makeFinding('sitemap-unparsable', 'A <url> entry has no <loc> element, so the page it describes is unknown.', at(file, entryPointer), { evidence: entry.raw, suggestion: 'Give every <url> entry a <loc>.' }))
        continue
      }
      const loc = normalizeUrl(entry.loc)
      if (!loc.ok) {
        findings.push(makeFinding('sitemap-unparsable', `A <url> entry has an unusable <loc>: ${loc.reason}.`, at(file, entryPointer), { evidence: entry.loc, suggestion: 'Give every <url> entry an absolute http or https <loc>.' }))
        continue
      }
      if (entry.links.length === 0) continue
      add({
        url: loc.url,
        file,
        pointer: entryPointer,
        source: 'sitemap',
        hasHtml: false,
        alternates: entry.links.map((link) => ({ ...link, pointer: `${entryPointer}/links/${link.index}` })),
        canonicals: [],
      })
    }
  }

  return [...byUrl.values()]
}

export function buildReport(findings, counts) {
  const sorted = sortFindings(findings)
  const summary = {
    checked: counts.checked,
    errors: sorted.filter((finding) => finding.severity === 'error').length,
    warnings: sorted.filter((finding) => finding.severity === 'warning').length,
    info: sorted.filter((finding) => finding.severity === 'info').length,
    clusters: counts.clusters,
    alternates: counts.alternates,
    xDefault: counts.xDefault,
  }
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status: statusFor(sorted),
    summary,
    findings: sorted,
  }
}

/**
 * Audit one project.
 *
 * Throws `ConfigError` when the run never had a subject: a bad config, an
 * unknown key, a path that leaves the input root. Everything that went wrong
 * with the evidence itself comes back inside the report.
 */
export async function checkProject({ config, root, xDefault }) {
  const configPath = resolve(process.cwd(), config)
  let document
  try {
    document = JSON.parse(await readFile(configPath, 'utf8'))
  } catch (error) {
    throw new ConfigError(`Could not load the config (${error.code ?? error.message})`)
  }
  const validated = validateConfig(document, { xDefault })

  const inputRoot = root === undefined || root === null ? dirname(configPath) : resolve(process.cwd(), root)
  let realRoot
  try {
    realRoot = await realpath(inputRoot)
  } catch (error) {
    throw new ConfigError(`The input root could not be resolved (${error.code ?? 'unknown error'})`, 'input-unresolvable')
  }

  const findings = []
  if (validated.pages.length > validated.limits.maxPages) {
    findings.push(makeFinding(
      'page-limit-exceeded',
      `The config declares ${validated.pages.length} pages, over the limit of ${validated.limits.maxPages}; nothing was audited.`,
      at(null, '/pages'),
      { suggestion: 'Raise limits.maxPages deliberately, or audit fewer pages at a time.' },
    ))
    return buildReport(findings, { checked: 0, clusters: 0, alternates: 0, xDefault: validated.xDefault })
  }

  const pages = await loadPages(validated, inputRoot, realRoot, findings)

  if (pages.length > validated.limits.maxPages) {
    findings.push(makeFinding(
      'page-limit-exceeded',
      `The inputs describe ${pages.length} pages, over the limit of ${validated.limits.maxPages}; nothing was audited.`,
      at(null, '/pages'),
      { suggestion: 'Raise limits.maxPages deliberately, or audit fewer pages at a time.' },
    ))
    return buildReport(findings, { checked: 0, clusters: 0, alternates: 0, xDefault: validated.xDefault })
  }

  if (pages.length === 0) {
    if (!findings.some((finding) => marksEvidenceMissing(finding.ruleId))) {
      findings.push(makeFinding(
        'no-pages-checked',
        'No page with alternate declarations was read, so there is no evidence to pass or fail on.',
        at(null, '/pages'),
        { suggestion: 'Declare pages in the config, or supply a sitemap whose url entries carry alternate links.' },
      ))
    }
    return buildReport(findings, { checked: 0, clusters: 0, alternates: 0, xDefault: validated.xDefault })
  }

  const audit = auditPages(pages, { xDefault: validated.xDefault })
  return buildReport([...findings, ...audit.findings], {
    checked: audit.checked,
    clusters: audit.clusters,
    alternates: audit.alternates,
    xDefault: validated.xDefault,
  })
}

/**
 * Serialise the report for stdout.
 *
 * `JSON.stringify` leaves U+2028 and U+2029 raw, and inside a JavaScript string
 * literal those two are line terminators. The payload parses as JSON either
 * way, but an exported file name carrying one would break a consumer that
 * evaluates the payload as JavaScript, so both are escaped here. Nothing else
 * about the text changes.
 */
export function renderReport(report) {
  return `${JSON.stringify(report, null, 2).replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029')}\n`
}

export function exitCodeFor(report) {
  if (report.status === 'pass') return 0
  if (report.status === 'fail') return 1
  return 2
}

/** A human summary. It goes to stderr, because stdout carries only the report. */
export function formatSummary(report) {
  const lines = report.findings.map((finding) => {
    const where = [finding.location.file, finding.location.pointer].filter(Boolean).join(' ')
    return `${finding.severity.toUpperCase().padEnd(7)} ${finding.ruleId.padEnd(31)} ${where}`
  })
  lines.push('')
  lines.push(
    `${report.summary.checked} page(s) in ${report.summary.clusters} cluster(s), `
    + `${report.summary.alternates} alternate declaration(s), x-default policy "${report.summary.xDefault}".`,
  )
  lines.push(
    `${report.summary.errors} error, ${report.summary.warnings} warning, ${report.summary.info} info. `
    + `Status ${report.status}.`,
  )
  return `${lines.join('\n')}\n`
}

/** Exported so the rule catalog can be asserted against the documentation. */
export const CATALOG = Object.freeze({
  ruleIds: RULE_IDS,
  severity: RULE_SEVERITY,
  evidenceMissing: EVIDENCE_MISSING_RULES,
  limits: DEFAULT_LIMITS,
  severityFor,
  parseLanguageTag,
})
