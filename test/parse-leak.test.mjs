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

/**
 * The output contract of `parseFailureDetail`, pinned against the adversarial
 * document the cases above do not reach.
 *
 * A config whose own text reads `at position 1` makes V8 write
 * `Unexpected token 'a', "at position 1" is not valid JSON`. Two things in the
 * helper keep that config out of the detail, and they work together: the
 * quoting shape is recognised FIRST, and `PARSE_POSITION` is anchored to the
 * END of the message, so an offset found INSIDE a quoted span cannot be
 * mistaken for the offset V8 appended. Rebuild that branch as the unanchored
 * `slice` other tools in this catalog once used and the first case below fails
 * with the config in the message. (Swapping only the order, with the anchor
 * kept, does not fail -- measured. The anchor is carrying that half.)
 */

const EXPECT_LOWER_A = "unexpected token 'a'"
const EXPECT_BRACE = "unexpected token '}'"
const GENERIC = 'it could not be parsed as JSON'

/** The detail for a document that must not parse. */
function detailOf(document) {
  let thrown = null
  try {
    JSON.parse(document)
  } catch (error) {
    thrown = error
  }
  assert.notEqual(thrown, null, `${JSON.stringify(document)} was supposed to be unparseable`)
  return parseFailureDetail(thrown)
}

/** No prefix of `document` from four characters up survives into the detail. */
function assertNoPrefixOf(document, detail, label) {
  for (let length = Math.min(document.length, 40); length >= 4; length -= 1) {
    const prefix = document.slice(0, length)
    assert.equal(detail.includes(prefix), false, `${label}: the detail carries ${JSON.stringify(prefix)}`)
  }
}

test('a document whose own text reads "at position 1" does not smuggle itself out', () => {
  const detail = detailOf('at position 1')
  assert.equal(detail.includes('"'), false, `a quoted span survived: ${detail}`)
  assert.equal(detail.includes('at position 1'), false, `the document came back: ${detail}`)
  assert.equal(detail, EXPECT_LOWER_A)
})

test('a document that is nothing but a credential never appears in the detail', () => {
  const detail = detailOf(CANARY)
  assert.equal(detail.includes(CANARY), false, `the canary came back: ${detail}`)
  assertNoPrefixOf(CANARY, detail, 'credential-only document')
})

test('a long document does not leak the ten characters V8 quotes from its head', () => {
  const document = `${CANARY} followed by a great deal of content nobody should read back`
  const detail = detailOf(document)
  assertNoPrefixOf(document, detail, 'long document')
})

test('a quoted span carrying a newline is still recognised as the quoting shape', () => {
  // Without the `s` flag the quoting branch misses this message entirely and
  // the detail collapses to the generic sentence.
  const detail = detailOf('}x\n')
  assert.equal(detail.includes('"'), false, `a quoted span survived: ${detail}`)
  assert.equal(detail, EXPECT_BRACE)
})

test('the genuinely safe positional form keeps its position, line and column', () => {
  // A helper that answered the generic sentence for everything would pass every
  // leak case above while destroying every diagnostic. This is the pin.
  const detail = detailOf('{"a": 1 "b": 2}')
  assert.match(detail, /at position 8 \(line 1 column 9\)$/)
  assert.equal(detail.includes('"'), false, `a quoted span survived: ${detail}`)
  assert.notEqual(detail, GENERIC)
})

test('an empty document keeps V8 own words, unchanged', () => {
  assert.equal(detailOf(''), 'Unexpected end of JSON input')
})
