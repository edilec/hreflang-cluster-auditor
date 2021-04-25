import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { makeProject, removeProject, runCli } from './helpers.mjs'
import { parseFailureDetail } from '../src/rules.mjs'

/**
 * A config that does not parse is the config nothing has validated, and V8
 * hands its content straight back inside the error message:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON` is the whole
 * config when it is short, and a window around the offence when it is not.
 * `Could not load the config (...)` interpolated that message, so a config file
 * holding a credential was reproduced on stderr, where a CI log keeps it.
 *
 * `excerpt` does not fix it. It collapses whitespace and trims from the END,
 * while the quoted span sits at the FRONT, far inside the 200-character bound.
 *
 * The canary is AWS's own published documentation placeholder, not a
 * credential. It is checked down to eight characters, because half a leak is
 * still a leak.
 */

const CANARY = 'AKIAIOSFODNN7EXAMPLE'
const SHORTEST_PREFIX = 8

function assertNoCanary(stream, where) {
  for (let length = CANARY.length; length >= SHORTEST_PREFIX; length -= 1) {
    const prefix = CANARY.slice(0, length)
    assert.ok(
      !stream.includes(prefix),
      `${where} carries ${length} characters of the canary: ${JSON.stringify(stream)}`,
    )
  }
}

test('a config that is nothing but a credential is not echoed back', async () => {
  const root = await makeProject({ 'hreflang.config.json': CANARY })
  try {
    const run = await runCli(['--config', join(root, 'hreflang.config.json')])
    assert.equal(run.code, 2, 'an unparseable config is a refusal')
    assertNoCanary(run.stdout, 'stdout')
    assertNoCanary(run.stderr, 'stderr')
  } finally {
    await removeProject(root)
  }
})

test('a credential inside an unparseable config is not echoed either', async () => {
  // V8 quotes a WINDOW around the offence, not only the head of the file, so a
  // secret in the middle of a broken config leaks just as readily.
  const root = await makeProject({
    'hreflang.config.json': `{"schemaVersion": "1", "token": ${CANARY}}`,
  })
  try {
    const run = await runCli(['--config', join(root, 'hreflang.config.json')])
    assert.equal(run.code, 2)
    assertNoCanary(run.stdout, 'stdout')
    assertNoCanary(run.stderr, 'stderr')
  } finally {
    await removeProject(root)
  }
})

test('a config that merely CONTAINS "at position" does not smuggle itself through', async () => {
  // Looking for `at position` before recognising the quoting shape would keep
  // the quoted span whenever the file supplied that phrase itself.
  const root = await makeProject({
    'hreflang.config.json': `${CANARY} at position 9 (line 1 column 10)`,
  })
  try {
    const run = await runCli(['--config', join(root, 'hreflang.config.json')])
    assertNoCanary(run.stdout, 'stdout')
    assertNoCanary(run.stderr, 'stderr')
    assert.equal(run.stderr.includes("unexpected token 'A'"), true)
  } finally {
    await removeProject(root)
  }
})

test('the refusal still says where the config broke', async () => {
  const root = await makeProject({ 'hreflang.config.json': '{"schemaVersion": "1" "pages": []}' })
  try {
    const run = await runCli(['--config', join(root, 'hreflang.config.json')])
    assert.equal(run.code, 2)
    // A diagnostic that says nothing is a different defect: position, line and
    // column are V8's useful half and none of them is config content.
    assert.match(run.stderr, /at position 22 \(line 1 column 23\)/)
  } finally {
    await removeProject(root)
  }
})

test('a config that cannot be read is still reported by its errno, not by a parse detail', async () => {
  const run = await runCli(['--config', 'examples/clean/does-not-exist.json'])
  assert.equal(run.code, 2)
  assert.equal(run.stderr.includes('ENOENT'), true)
})

test('parseFailureDetail keeps the position and drops the quoted config', () => {
  const cases = [
    [CANARY, "unexpected token 'A'"],
    [`{"a": ${CANARY}}`, "unexpected token 'A'"],
    ['ssn 123-45-6789', "unexpected token 's'"],
    [
      '{"a": 1 "b": 2}',
      "Expected ',' or '}' after property value in JSON at position 8 (line 1 column 9)",
    ],
    [`{"a":"${CANARY}`, 'Unterminated string in JSON at position 26 (line 1 column 27)'],
    ['', 'Unexpected end of JSON input'],
  ]
  for (const [text, expected] of cases) {
    try {
      JSON.parse(text)
      assert.fail(`${JSON.stringify(text)} was supposed to be unparseable`)
    } catch (error) {
      assert.equal(parseFailureDetail(error), expected)
    }
  }
})

test('a non-Error, and an error with no message, still produce a usable detail', () => {
  assert.equal(parseFailureDetail(undefined), 'it could not be parsed as JSON')
  assert.equal(parseFailureDetail({}), 'it could not be parsed as JSON')
  assert.equal(parseFailureDetail(new Error('')), 'it could not be parsed as JSON')
})
