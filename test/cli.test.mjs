import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { ORIGIN, REPO, configJson, htmlPage, makeProject, removeProject, runCli } from './helpers.mjs'

const CLEAN = 'examples/clean/hreflang.config.json'
const BROKEN = 'examples/broken/hreflang.config.json'
const PAIR = [['en', `${ORIGIN}/en/`], ['fr', `${ORIGIN}/fr/`]]

test('--help explains the tool and writes nothing to stdout', async () => {
  const run = await runCli(['--help'])
  assert.equal(run.code, 0)
  assert.equal(run.stdout, '')
  assert.equal(run.stderr.includes('Usage:'), true)
  assert.equal(run.stderr.includes('--x-default POLICY'), true)
  assert.equal(run.stderr.includes('never fetches anything'), true)
})

test('a usage mistake exits 2 with an empty stdout', async () => {
  for (const argv of [['--nope'], [], ['--config'], ['--x-default']]) {
    const run = await runCli(argv)
    assert.equal(run.code, 2, JSON.stringify(argv))
    assert.equal(run.stdout, '', JSON.stringify(argv))
    assert.equal(run.stderr.includes('Usage:'), true)
  }
})

test('an unusable configuration exits 2 with an empty stdout and no report', async () => {
  const run = await runCli(['--config', 'examples/clean/does-not-exist.json'])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.equal(run.stderr.includes('Could not load the config'), true)

  const bad = await runCli(['--config', CLEAN, '--x-default', 'sometimes'])
  assert.equal(bad.code, 2)
  assert.equal(bad.stdout, '')
  assert.equal(bad.stderr.includes('xDefault must be one of'), true)
})

test('the clean example exits 0 and puts only JSON on stdout', async () => {
  const run = await runCli(['--config', CLEAN])
  assert.equal(run.code, 0)
  const report = JSON.parse(run.stdout)
  assert.deepEqual(
    { schemaVersion: report.schemaVersion, tool: report.tool, status: report.status, findings: report.findings },
    { schemaVersion: '1', tool: 'hreflang-cluster-auditor', status: 'pass', findings: [] },
  )
  assert.equal(run.stderr.includes('4 page(s) in 1 cluster(s)'), true)
  assert.equal(run.stderr.includes('Status pass.'), true)
})

test('--json keeps stderr empty', async () => {
  const run = await runCli(['--config', CLEAN, '--json'])
  assert.equal(run.code, 0)
  assert.equal(run.stderr, '')
  assert.equal(JSON.parse(run.stdout).status, 'pass')
})

test('the broken example exits 1 and names the page that fails to link back', async () => {
  const run = await runCli(['--config', BROKEN, '--json'])
  assert.equal(run.code, 1)
  const report = JSON.parse(run.stdout)
  assert.equal(report.status, 'fail')
  const reciprocal = report.findings.filter((finding) => finding.ruleId === 'missing-reciprocal-alternate')
  assert.equal(reciprocal.length, 1)
  assert.deepEqual(reciprocal[0].location, { file: 'build/de-de.html', pointer: '/pages/2' })
  assert.equal(reciprocal[0].message.includes(`${ORIGIN}/fr/`), true)
})

test('two runs over the same inputs write byte-identical stdout', async () => {
  const first = await runCli(['--config', BROKEN, '--json'])
  const second = await runCli(['--config', BROKEN, '--json'])
  assert.equal(first.stdout, second.stdout)
  assert.equal(first.stdout.length > 0, true)
  assert.equal(first.code, second.code)
})

test('--x-default is wired through to the audit', async () => {
  const required = await runCli(['--config', CLEAN, '--json', '--x-default', 'required'])
  assert.equal(required.code, 0)
  assert.equal(JSON.parse(required.stdout).summary.xDefault, 'required')

  const forbidden = await runCli(['--config', CLEAN, '--json', '--x-default', 'forbidden'])
  assert.equal(forbidden.code, 1)
  const report = JSON.parse(forbidden.stdout)
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['x-default-not-allowed'])
  assert.equal(report.summary.xDefault, 'forbidden')
})

test('--root moves the input root the declared paths resolve against', async (t) => {
  const root = await makeProject({
    'build/en.html': htmlPage({ canonical: `${ORIGIN}/en/`, alternates: PAIR }),
    'build/fr.html': htmlPage({ canonical: `${ORIGIN}/fr/`, alternates: PAIR }),
    'config/hreflang.config.json': configJson({
      pages: [
        { url: `${ORIGIN}/en/`, html: 'build/en.html' },
        { url: `${ORIGIN}/fr/`, html: 'build/fr.html' },
      ],
    }),
  })
  t.after(() => removeProject(root))
  const config = join(root, 'config/hreflang.config.json')

  const withoutRoot = await runCli(['--config', config, '--json'])
  assert.equal(withoutRoot.code, 2)
  assert.deepEqual(
    JSON.parse(withoutRoot.stdout).findings.map((finding) => finding.ruleId),
    ['html-unreadable', 'html-unreadable'],
  )

  const withRoot = await runCli(['--config', config, '--root', root, '--json'])
  assert.equal(withRoot.code, 0)
  assert.deepEqual(JSON.parse(withRoot.stdout).findings, [])
})

test('unreadable evidence exits 2 and still carries a report saying what was not read', async (t) => {
  const root = await makeProject({
    'build/en.html': htmlPage({ canonical: `${ORIGIN}/en/`, alternates: PAIR }),
    'hreflang.config.json': configJson({
      pages: [
        { url: `${ORIGIN}/en/`, html: 'build/en.html' },
        { url: `${ORIGIN}/fr/`, html: 'build/fr.html' },
      ],
    }),
  })
  t.after(() => removeProject(root))

  const run = await runCli(['--config', join(root, 'hreflang.config.json')])
  assert.equal(run.code, 2)
  const report = JSON.parse(run.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(
    report.findings.map((finding) => [finding.ruleId, finding.location.file]),
    [['alternate-not-in-inputs', 'build/en.html'], ['html-unreadable', 'build/fr.html']],
  )
  assert.equal(run.stderr.includes('Status incomplete.'), true)
})

test('reported file locations stay relative to the input root', async (t) => {
  const root = await makeProject({
    'build/en.html': htmlPage({ alternates: [['en', `${ORIGIN}/en/`]] }),
    'hreflang.config.json': configJson({ pages: [{ url: `${ORIGIN}/en/`, html: 'build/en.html' }] }),
  })
  t.after(() => removeProject(root))

  const run = await runCli(['--config', join(root, 'hreflang.config.json'), '--json'])
  assert.equal(run.stdout.includes(root), false, 'a host path leaked into the report')
  assert.deepEqual(
    JSON.parse(run.stdout).findings.map((finding) => [finding.ruleId, finding.location.file]),
    [['missing-canonical', 'build/en.html']],
  )
})

test('the packaged bin runs from the repository root', async () => {
  const run = await runCli(['--config', join(REPO, CLEAN), '--json'], { cwd: REPO })
  assert.equal(run.code, 0)
  assert.equal(JSON.parse(run.stdout).summary.checked, 4)
})
