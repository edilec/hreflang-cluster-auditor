import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ConfigError, checkProject, resolveWithin } from '../src/index.mjs'
import { ORIGIN, configJson, htmlPage, runCli } from './helpers.mjs'

const SECRET = 'TOP-SECRET-CONTENT-THAT-MUST-NEVER-REACH-A-REPORT'
const PAIR = [['en', `${ORIGIN}/en/`], ['fr', `${ORIGIN}/fr/`]]

/**
 * A site directory with a sibling directory outside it. The outside directory
 * holds a document the configuration has no right to name.
 */
async function makeSite(t, { pages, sitemaps = [] }) {
  const parent = await mkdtemp(join(tmpdir(), 'hreflang-confinement-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const site = join(parent, 'site')
  const outside = join(parent, 'outside')
  await mkdir(join(site, 'build'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(
    join(outside, 'secret.html'),
    htmlPage({ canonical: `${ORIGIN}/en/`, alternates: PAIR, body: `    <p>${SECRET}</p>` }),
  )
  await writeFile(join(outside, 'secret.txt'), `${SECRET}\n`)
  await writeFile(join(site, 'build', 'en.html'), htmlPage({ canonical: `${ORIGIN}/en/`, alternates: PAIR }))
  await writeFile(join(site, 'build', 'fr.html'), htmlPage({ canonical: `${ORIGIN}/fr/`, alternates: PAIR }))
  await writeFile(join(site, 'hreflang.config.json'), configJson({ pages, sitemaps }))
  return { parent, site, outside, config: join(site, 'hreflang.config.json') }
}

async function refusal(t, options) {
  const site = await makeSite(t, options)
  const error = await checkProject({ config: site.config }).then(
    () => null,
    (thrown) => thrown,
  )
  assert.equal(error instanceof ConfigError, true, 'expected a ConfigError')
  assert.equal(error.message.includes(SECRET), false, 'the refusal echoed out-of-root content')
  return { site, error }
}

test('a lexical escape from the input root is refused', async (t) => {
  const { error } = await refusal(t, { pages: [{ url: `${ORIGIN}/en/`, html: '../outside/secret.html' }] })
  assert.equal(error.rule, 'input-outside-root')
})

test('an absolute input path is refused', async (t) => {
  const { error } = await refusal(t, { pages: [{ url: `${ORIGIN}/en/`, html: '/etc/hosts' }] })
  assert.equal(error.rule, 'input-not-relative')
})

test('a symbolic link to a file outside the root is refused after resolution', async (t) => {
  const site = await makeSite(t, { pages: [{ url: `${ORIGIN}/en/`, html: 'build/linked.html' }] })
  await symlink(join(site.outside, 'secret.html'), join(site.site, 'build', 'linked.html'))

  const error = await checkProject({ config: site.config }).then(() => null, (thrown) => thrown)
  assert.equal(error instanceof ConfigError, true)
  assert.equal(error.rule, 'input-escapes-root')
  assert.equal(error.message.includes(SECRET), false)

  const run = await runCli(['--config', site.config])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '', 'a configuration refusal must leave stdout empty')
  assert.equal(run.stderr.includes(SECRET), false)
  assert.equal(run.stderr.includes('symbolic link'), true)
})

test('a symbolic link to a directory outside the root is refused after resolution', async (t) => {
  const site = await makeSite(t, { pages: [{ url: `${ORIGIN}/en/`, html: 'build/away/secret.html' }] })
  await symlink(site.outside, join(site.site, 'build', 'away'))

  const run = await runCli(['--config', site.config])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.equal(run.stderr.includes(SECRET), false)
  assert.equal(run.stderr.includes('input root'), true)
})

test('a sitemap path may not leave the root through a link either', async (t) => {
  const site = await makeSite(t, { pages: [], sitemaps: ['linked-sitemap.xml'] })
  await symlink(join(site.outside, 'secret.txt'), join(site.site, 'linked-sitemap.xml'))

  const run = await runCli(['--config', site.config])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.equal(run.stderr.includes(SECRET), false)
})

test('a relative path that stays inside the root is allowed', async (t) => {
  const site = await makeSite(t, {
    pages: [
      { url: `${ORIGIN}/en/`, html: 'build/../build/en.html' },
      { url: `${ORIGIN}/fr/`, html: './build/fr.html' },
    ],
  })
  const report = await checkProject({ config: site.config })
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.checked, 2)
})

test('a root that is itself reached through a symbolic link still works', async (t) => {
  const site = await makeSite(t, {
    pages: [
      { url: `${ORIGIN}/en/`, html: 'build/en.html' },
      { url: `${ORIGIN}/fr/`, html: 'build/fr.html' },
    ],
  })
  const linkedRoot = join(site.parent, 'linked-site')
  await symlink(site.site, linkedRoot)

  const report = await checkProject({ config: join(linkedRoot, 'hreflang.config.json'), root: linkedRoot })
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 2)
})

test('an input root that does not exist is a configuration error', async (t) => {
  const site = await makeSite(t, { pages: [{ url: `${ORIGIN}/en/`, html: 'build/en.html' }] })
  const error = await checkProject({ config: site.config, root: join(site.parent, 'absent') })
    .then(() => null, (thrown) => thrown)
  assert.equal(error instanceof ConfigError, true)
  assert.equal(error.rule, 'input-unresolvable')
})

test('an empty or non-string input path is refused before anything is opened', async (t) => {
  const site = await makeSite(t, { pages: [{ url: `${ORIGIN}/en/`, html: 'build/en.html' }] })
  const real = await realpath(site.site)
  for (const candidate of ['   ', '', null, 42]) {
    const error = await resolveWithin(site.site, real, candidate, 'pages[0].html')
      .then(() => null, (thrown) => thrown)
    assert.equal(error instanceof ConfigError, true, JSON.stringify(candidate))
    assert.equal(error.rule, 'input-not-relative')
  }
  // The config layer refuses an empty html path before resolution is reached.
  const blank = await makeSite(t, { pages: [{ url: `${ORIGIN}/en/`, html: '  ' }] })
  await assert.rejects(() => checkProject({ config: blank.config }), /must name the exported HTML document/)
})
