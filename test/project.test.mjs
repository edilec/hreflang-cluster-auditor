import assert from 'node:assert/strict'
import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { ConfigError, byCodeUnit, checkProject, exitCodeFor, validateConfig } from '../src/index.mjs'
import { EVIDENCE_LIMIT } from '../src/rules.mjs'
import { ORIGIN, REPO, configJson, htmlPage, makeProject, removeProject, sitemapXml, triples } from './helpers.mjs'

const CLEAN = join(REPO, 'examples/clean/hreflang.config.json')
const BROKEN = join(REPO, 'examples/broken/hreflang.config.json')

const PAIR = [['en', `${ORIGIN}/en/`], ['fr', `${ORIGIN}/fr/`]]

function pairProject(extra = {}) {
  return {
    'build/en.html': htmlPage({ canonical: `${ORIGIN}/en/`, alternates: PAIR }),
    'build/fr.html': htmlPage({ canonical: `${ORIGIN}/fr/`, alternates: PAIR }),
    'hreflang.config.json': configJson({
      pages: [
        { url: `${ORIGIN}/en/`, html: 'build/en.html' },
        { url: `${ORIGIN}/fr/`, html: 'build/fr.html' },
      ],
      ...extra,
    }),
  }
}

async function withProject(t, files) {
  const root = await makeProject(files)
  t.after(() => removeProject(root))
  return root
}

test('the clean example passes and the broken example fails precisely', async () => {
  const clean = await checkProject({ config: CLEAN })
  assert.equal(clean.status, 'pass')
  assert.equal(exitCodeFor(clean), 0)
  assert.deepEqual(clean.summary, {
    checked: 4,
    errors: 0,
    warnings: 0,
    info: 0,
    clusters: 1,
    alternates: 20,
    xDefault: 'optional',
  })

  const broken = await checkProject({ config: BROKEN })
  assert.equal(broken.status, 'fail')
  assert.equal(exitCodeFor(broken), 1)
  assert.deepEqual(triples(broken), [
    ['missing-reciprocal-alternate', 'build/de-de.html', '/pages/2'],
    ['canonical-self-link-conflict', 'build/en-gb.html', '/pages/1/canonicals/0'],
    ['duplicate-alternate-entry', 'build/en-us.html', '/pages/0/alternates/5'],
    ['language-tag-not-canonical-case', 'build/en-us.html', '/pages/0/alternates/5'],
    ['invalid-language-tag', 'build/fr.html', '/pages/3/alternates/3'],
  ])
  assert.deepEqual(
    { errors: broken.summary.errors, warnings: broken.summary.warnings, info: broken.summary.info },
    { errors: 3, warnings: 1, info: 1 },
  )
})

test('the same inputs produce byte-identical reports', async () => {
  const first = JSON.stringify(await checkProject({ config: BROKEN }))
  const second = JSON.stringify(await checkProject({ config: BROKEN }))
  assert.equal(first, second)
})

test('the report is ordered by code unit, not by locale collation', async (t) => {
  // 'B' precedes 'a' by code unit and follows it under locale collation, so
  // this order inverts if findings are compared with localeCompare.
  const UPPER = `${ORIGIN}/B/`
  const LOWER = `${ORIGIN}/a/`
  const both = [['en', UPPER], ['de', LOWER]]
  const root = await withProject(t, {
    'build/B.html': htmlPage({ alternates: both }),
    'build/a.html': htmlPage({ alternates: both }),
    'hreflang.config.json': configJson({
      pages: [
        { url: UPPER, html: 'build/B.html' },
        { url: LOWER, html: 'build/a.html' },
      ],
    }),
  })
  const report = await checkProject({ config: join(root, 'hreflang.config.json') })
  assert.deepEqual(triples(report), [
    ['missing-canonical', 'build/B.html', '/pages/0'],
    ['missing-canonical', 'build/a.html', '/pages/1'],
  ])
})

test('the alternate signature of a source is ordered by code unit', async (t) => {
  // The signature decides whether two sources agree, and it is reported as the
  // evidence of a conflict. Sorting it by locale collation would reorder that
  // evidence -- and make agreement depend on ICU data.
  const PAGE = `${ORIGIN}/page/`
  const UPPER = `${ORIGIN}/B/`
  const LOWER = `${ORIGIN}/a/`
  const root = await withProject(t, {
    'build/page.html': htmlPage({ canonical: PAGE, alternates: [['en', PAGE]] }),
    'sitemap.xml': sitemapXml([[PAGE, [['en', UPPER], ['en', LOWER]]]]),
    'hreflang.config.json': configJson({
      pages: [{ url: PAGE, html: 'build/page.html' }],
      sitemaps: ['sitemap.xml'],
    }),
  })
  const report = await checkProject({ config: join(root, 'hreflang.config.json') })
  assert.deepEqual(triples(report), [['alternate-source-conflict', 'sitemap.xml', '/sitemaps/0/urls/0']])
  assert.equal(report.findings[0].evidence, `en ${UPPER} | en ${LOWER}`)
})

test('an exported page that could not be read is incomplete, never a pass', async (t) => {
  const files = pairProject()
  delete files['build/fr.html']
  const root = await withProject(t, files)
  const report = await checkProject({ config: join(root, 'hreflang.config.json') })
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.deepEqual(triples(report), [
    ['alternate-not-in-inputs', 'build/en.html', '/pages/0/alternates/1'],
    ['html-unreadable', 'build/fr.html', '/pages/1'],
  ])
  assert.equal(report.summary.checked, 1)
})

test('undecodable bytes are the error, and a literal replacement character is not', async (t) => {
  const legitimate = htmlPage({
    canonical: `${ORIGIN}/en/`,
    alternates: PAIR,
    body: '    <p>A product name written with a stray � character.</p>',
  })
  const root = await withProject(t, {
    ...pairProject(),
    'build/en.html': legitimate,
    'build/fr.html': Buffer.concat([Buffer.from('<html><head>', 'utf8'), Buffer.from([0xff, 0xfe, 0x41]), Buffer.from('</head></html>', 'utf8')]),
  })
  const report = await checkProject({ config: join(root, 'hreflang.config.json') })
  assert.equal(report.status, 'incomplete')
  // The page holding a literal U+FFFD decodes cleanly and is audited; only the
  // page with undecodable bytes is refused.
  assert.deepEqual(triples(report), [
    ['alternate-not-in-inputs', 'build/en.html', '/pages/0/alternates/1'],
    ['html-not-utf8', 'build/fr.html', '/pages/1'],
  ])
  assert.equal(report.summary.checked, 1)
})

test('an undecodable export is incomplete on its own, with nothing else to hide behind', async (t) => {
  // The test above reaches `incomplete` through two evidence-missing findings
  // at once, so it cannot tell which of them carries the status. Here the
  // undecodable page is named by the config and referenced by nothing, so
  // html-not-utf8 is the only finding: if it stops marking evidence missing,
  // this run drops from incomplete/exit 2 to fail/exit 1.
  const root = await withProject(t, {
    'build/en.html': htmlPage({ canonical: `${ORIGIN}/en/`, alternates: [['en', `${ORIGIN}/en/`]] }),
    'build/fr.html': Buffer.concat([
      Buffer.from('<html><head>', 'utf8'),
      Buffer.from([0xff, 0xfe, 0x41]),
      Buffer.from('</head></html>', 'utf8'),
    ]),
    'hreflang.config.json': configJson({
      pages: [
        { url: `${ORIGIN}/en/`, html: 'build/en.html' },
        { url: `${ORIGIN}/fr/`, html: 'build/fr.html' },
      ],
    }),
  })
  const report = await checkProject({ config: join(root, 'hreflang.config.json') })
  assert.deepEqual(triples(report), [['html-not-utf8', 'build/fr.html', '/pages/1']])
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.equal(report.summary.checked, 1)
})

test('a file that stats but cannot be opened is unreadable, not a pass', async (t) => {
  if (process.getuid === undefined || process.getuid() === 0) return
  const root = await withProject(t, pairProject())
  await chmod(join(root, 'build/fr.html'), 0o000)
  t.after(() => chmod(join(root, 'build/fr.html'), 0o644).catch(() => undefined))
  const report = await checkProject({ config: join(root, 'hreflang.config.json') })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(
    triples(report).filter(([ruleId]) => ruleId === 'html-unreadable'),
    [['html-unreadable', 'build/fr.html', '/pages/1']],
  )
  assert.equal(report.findings.find((finding) => finding.ruleId === 'html-unreadable').message.includes('EACCES'), true)
})

test('a path that is not a regular file is refused rather than opened', async (t) => {
  // The guard that produces this reason is the one that keeps the tool from
  // opening a device or a named pipe planted in the input root. Without it the
  // directory below is opened and reported as EISDIR, and a FIFO blocks forever.
  const root = await withProject(t, {
    'build/en.html': htmlPage({ canonical: `${ORIGIN}/en/`, alternates: [['en', `${ORIGIN}/en/`]] }),
    'hreflang.config.json': configJson({
      pages: [
        { url: `${ORIGIN}/en/`, html: 'build/en.html' },
        { url: `${ORIGIN}/fr/`, html: 'build/fr.html' },
      ],
    }),
  })
  await mkdir(join(root, 'build/fr.html'), { recursive: true })
  const report = await checkProject({ config: join(root, 'hreflang.config.json') })
  assert.deepEqual(triples(report), [['html-unreadable', 'build/fr.html', '/pages/1']])
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.equal(
    report.findings[0].message.includes('not a regular file'),
    true,
    report.findings[0].message,
  )
})

test('a huge attribute value is bounded in the message, not only in the evidence', async (t) => {
  // Every one of these findings quotes the offending value back. The quote is
  // untrusted input: without the same bound the evidence field uses, a 20000
  // character attribute becomes a 20000 character message and the report grows
  // to the size of the input.
  const hugeTag = 'e'.repeat(20000)
  const hugeHref = `${ORIGIN}/${'p'.repeat(20000)}`
  const root = await withProject(t, {
    'build/en.html': [
      '<!doctype html>',
      '<html>',
      '  <head>',
      `    <link rel="canonical" href="${hugeHref}">`,
      `    <link rel="alternate" hreflang="${hugeTag}" href="${ORIGIN}/en/">`,
      `    <link rel="alternate" hreflang="en" href="${hugeHref}">`,
      '  </head>',
      '  <body></body>',
      '</html>',
      '',
    ].join('\n'),
    'hreflang.config.json': configJson({ pages: [{ url: `${ORIGIN}/en/`, html: 'build/en.html' }] }),
  })
  const report = await checkProject({ config: join(root, 'hreflang.config.json') })
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId).sort(byCodeUnit),
    ['invalid-alternate-url', 'invalid-canonical-url', 'invalid-language-tag'],
  )
  for (const finding of report.findings) {
    assert.equal(finding.evidence.length <= EVIDENCE_LIMIT, true, `${finding.ruleId} evidence is ${finding.evidence.length} characters`)
    assert.equal(
      finding.message.length <= EVIDENCE_LIMIT + 200,
      true,
      `${finding.ruleId} message is ${finding.message.length} characters`,
    )
    assert.equal(finding.message.includes('e'.repeat(EVIDENCE_LIMIT + 1)), false, `${finding.ruleId} quotes the value in full`)
    assert.equal(finding.message.includes('p'.repeat(EVIDENCE_LIMIT + 1)), false, `${finding.ruleId} quotes the value in full`)
  }
  // A 60 kB page of junk must not become a 60 kB report.
  assert.equal(JSON.stringify(report).length < 4000, true, `the report is ${JSON.stringify(report).length} characters`)
})

test('a byte limit is enforced and reported, not truncated', async (t) => {
  const root = await withProject(t, pairProject({ limits: { maxHtmlBytes: 64 } }))
  const report = await checkProject({ config: join(root, 'hreflang.config.json') })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(
    triples(report).filter(([ruleId]) => ruleId === 'html-too-large'),
    [['html-too-large', 'build/en.html', '/pages/0'], ['html-too-large', 'build/fr.html', '/pages/1']],
  )
  assert.equal(report.summary.checked, 0)
})

test('the alternate limit is enforced for HTML pages and sitemap entries', async (t) => {
  const root = await withProject(t, {
    ...pairProject({ limits: { maxAlternatesPerPage: 1 }, sitemaps: ['sitemap.xml'] }),
    'sitemap.xml': sitemapXml([[`${ORIGIN}/de/`, PAIR]]),
  })
  const report = await checkProject({ config: join(root, 'hreflang.config.json') })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(triples(report), [
    ['alternate-limit-exceeded', 'build/en.html', '/pages/0'],
    ['alternate-limit-exceeded', 'build/fr.html', '/pages/1'],
    ['alternate-limit-exceeded', 'sitemap.xml', '/sitemaps/0/urls/0'],
  ])
  // no-pages-checked is not added on top: the limit findings already say why
  // nothing was audited, and they already force the incomplete status.
  assert.equal(report.summary.checked, 0)
})

test('the page limit is enforced from the config and from the merged inputs', async (t) => {
  const declared = await withProject(t, pairProject({ limits: { maxPages: 1 } }))
  const fromConfig = await checkProject({ config: join(declared, 'hreflang.config.json') })
  assert.deepEqual(triples(fromConfig), [['page-limit-exceeded', null, '/pages']])
  assert.equal(fromConfig.status, 'incomplete')
  assert.equal(fromConfig.summary.checked, 0)

  const merged = await withProject(t, {
    'build/en.html': htmlPage({ canonical: `${ORIGIN}/en/`, alternates: PAIR }),
    'sitemap.xml': sitemapXml([[`${ORIGIN}/fr/`, PAIR]]),
    'hreflang.config.json': configJson({
      pages: [{ url: `${ORIGIN}/en/`, html: 'build/en.html' }],
      sitemaps: ['sitemap.xml'],
      limits: { maxPages: 1 },
    }),
  })
  const fromInputs = await checkProject({ config: join(merged, 'hreflang.config.json') })
  assert.deepEqual(triples(fromInputs), [['page-limit-exceeded', null, '/pages']])
  assert.equal(fromInputs.summary.checked, 0)
})

test('the sitemap url limit is enforced and the sitemap is not partly used', async (t) => {
  const root = await withProject(t, {
    'sitemap.xml': sitemapXml([[`${ORIGIN}/en/`, PAIR], [`${ORIGIN}/fr/`, PAIR]]),
    'hreflang.config.json': configJson({ sitemaps: ['sitemap.xml'], limits: { maxSitemapUrls: 1 } }),
  })
  const report = await checkProject({ config: join(root, 'hreflang.config.json') })
  assert.deepEqual(triples(report), [['sitemap-url-limit-exceeded', 'sitemap.xml', '/sitemaps/0']])
  assert.equal(report.status, 'incomplete')
})

test('the sitemap byte limit is enforced', async (t) => {
  const root = await withProject(t, {
    'sitemap.xml': sitemapXml([[`${ORIGIN}/en/`, PAIR]]),
    'hreflang.config.json': configJson({ sitemaps: ['sitemap.xml'], limits: { maxSitemapBytes: 32 } }),
  })
  const report = await checkProject({ config: join(root, 'hreflang.config.json') })
  assert.deepEqual(triples(report), [['sitemap-too-large', 'sitemap.xml', '/sitemaps/0']])
  assert.equal(report.status, 'incomplete')
})

test('sitemaps that cannot be used are reported rather than guessed at', async (t) => {
  const cases = [
    ['sitemap-unreadable', null],
    ['sitemap-index-not-expanded', '<?xml version="1.0"?>\n<sitemapindex><sitemap><loc>https://example.com/s.xml</loc></sitemap></sitemapindex>\n'],
    ['sitemap-unparsable', '<html><body>not a sitemap</body></html>\n'],
  ]
  for (const [expected, content] of cases) {
    const files = { 'hreflang.config.json': configJson({ sitemaps: ['sitemap.xml'] }) }
    if (content !== null) files['sitemap.xml'] = content
    const root = await withProject(t, files)
    const report = await checkProject({ config: join(root, 'hreflang.config.json') })
    assert.deepEqual(triples(report), [[expected, 'sitemap.xml', '/sitemaps/0']], expected)
    assert.equal(report.status, 'incomplete')
  }
})

test('a sitemap export is not decoded as anything but UTF-8', async (t) => {
  const root = await withProject(t, {
    'sitemap.xml': Buffer.concat([Buffer.from('<urlset><loc>', 'utf8'), Buffer.from([0xc3, 0x28]), Buffer.from('</loc></urlset>', 'utf8')]),
    'hreflang.config.json': configJson({ sitemaps: ['sitemap.xml'] }),
  })
  const report = await checkProject({ config: join(root, 'hreflang.config.json') })
  assert.deepEqual(triples(report), [['sitemap-not-utf8', 'sitemap.xml', '/sitemaps/0']])
  assert.equal(report.status, 'incomplete')
})

test('a url entry without a usable loc is reported', async (t) => {
  const root = await withProject(t, {
    'sitemap.xml': '<urlset>\n<url><xhtml:link rel="alternate" hreflang="en" href="https://example.com/en/"/></url>\n<url><loc>not-a-url</loc><xhtml:link rel="alternate" hreflang="fr" href="https://example.com/fr/"/></url>\n</urlset>\n',
    'hreflang.config.json': configJson({ sitemaps: ['sitemap.xml'] }),
  })
  const report = await checkProject({ config: join(root, 'hreflang.config.json') })
  assert.deepEqual(triples(report), [
    ['sitemap-unparsable', 'sitemap.xml', '/sitemaps/0/urls/0'],
    ['sitemap-unparsable', 'sitemap.xml', '/sitemaps/0/urls/1'],
  ])
  assert.equal(report.status, 'incomplete')
})

test('checking nothing is never a pass', async (t) => {
  const root = await withProject(t, {
    'sitemap.xml': sitemapXml([]),
    'hreflang.config.json': configJson({ sitemaps: ['sitemap.xml'] }),
  })
  const report = await checkProject({ config: join(root, 'hreflang.config.json') })
  assert.equal(report.summary.checked, 0)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.deepEqual(triples(report), [['no-pages-checked', null, '/pages']])
})

test('sitemap entries with no alternate links are not clusters of one', async (t) => {
  const root = await withProject(t, {
    'sitemap.xml': sitemapXml([[`${ORIGIN}/en/`, PAIR], [`${ORIGIN}/fr/`, PAIR], [`${ORIGIN}/about/`, []]]),
    'hreflang.config.json': configJson({ sitemaps: ['sitemap.xml'] }),
  })
  const report = await checkProject({ config: join(root, 'hreflang.config.json') })
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 2)
  assert.equal(report.summary.clusters, 1)
})

test('HTML and sitemap declarations that disagree are reported, and the HTML is used', async (t) => {
  const root = await withProject(t, {
    ...pairProject({ sitemaps: ['sitemap.xml'] }),
    'sitemap.xml': sitemapXml([[`${ORIGIN}/en/`, [...PAIR, ['de', `${ORIGIN}/de/`]]]]),
  })
  const report = await checkProject({ config: join(root, 'hreflang.config.json') })
  assert.deepEqual(triples(report), [['alternate-source-conflict', 'sitemap.xml', '/sitemaps/0/urls/0']])
  assert.equal(report.status, 'fail')
  assert.equal(report.findings[0].message.includes('build/en.html'), true)
})

test('agreeing HTML and sitemap declarations are not a conflict', async (t) => {
  const root = await withProject(t, {
    ...pairProject({ sitemaps: ['sitemap.xml'] }),
    'sitemap.xml': sitemapXml([[`${ORIGIN}/en/`, PAIR], [`${ORIGIN}/fr/`, PAIR]]),
  })
  const report = await checkProject({ config: join(root, 'hreflang.config.json') })
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.checked, 2)
})

test('the x-default policy can be overridden per run', async (t) => {
  const root = await withProject(t, pairProject({ xDefault: 'optional' }))
  const config = join(root, 'hreflang.config.json')
  assert.equal((await checkProject({ config })).status, 'pass')
  const required = await checkProject({ config, xDefault: 'required' })
  assert.deepEqual(triples(required), [['x-default-missing', 'build/en.html', '/pages/0']])
  assert.equal(required.summary.xDefault, 'required')
})

test('a configured x-default policy in the file is honoured', async (t) => {
  const root = await withProject(t, pairProject({ xDefault: 'required' }))
  const report = await checkProject({ config: join(root, 'hreflang.config.json') })
  assert.deepEqual(triples(report), [['x-default-missing', 'build/en.html', '/pages/0']])
})

test('configuration mistakes are refused, not absorbed', async (t) => {
  const root = await withProject(t, pairProject())
  const config = join(root, 'hreflang.config.json')
  const base = {
    schemaVersion: '1',
    pages: [{ url: `${ORIGIN}/en/`, html: 'build/en.html' }],
  }
  const rejected = [
    [{ ...base, xDefaults: 'required' }, /Unknown config key "xDefaults"/],
    [{ ...base, limits: { maxPage: 10 } }, /Unknown limit "maxPage"/],
    [{ ...base, limits: { maxPages: 0 } }, /must be a positive integer/],
    [{ ...base, limits: [] }, /limits must be an object/],
    [{ ...base, xDefault: 'Required' }, /xDefault must be one of/],
    [{ ...base, schemaVersion: '2' }, /Unsupported config schemaVersion/],
    [{ schemaVersion: '1' }, /at least one page or one sitemap/],
    [{ schemaVersion: '1', pages: [{ url: `${ORIGIN}/en/`, html: 'a.html', lang: 'en' }] }, /Unknown key "lang"/],
    [{ schemaVersion: '1', pages: [{ url: '/en/', html: 'a.html' }] }, /is not usable/],
    [{ schemaVersion: '1', pages: [{ url: `${ORIGIN}/en/` }] }, /must name the exported HTML document/],
    [{
      schemaVersion: '1',
      pages: [{ url: `${ORIGIN}/en/`, html: 'a.html' }, { url: `${ORIGIN}/en/`, html: 'b.html' }],
    }, /repeats/],
    [{ schemaVersion: '1', sitemaps: [''] }, /non-empty relative paths/],
  ]
  for (const [document, pattern] of rejected) {
    assert.throws(() => validateConfig(document), pattern, JSON.stringify(document))
    assert.throws(() => validateConfig(document), ConfigError, JSON.stringify(document))
  }
  assert.equal(validateConfig(base).limits.maxPages, 5000)
  await assert.rejects(() => checkProject({ config: join(root, 'missing.json') }), ConfigError)
  await assert.rejects(() => checkProject({ config, xDefault: 'nope' }), /xDefault must be one of/)
})
