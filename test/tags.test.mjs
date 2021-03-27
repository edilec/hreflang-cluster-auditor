import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_TAG_LENGTH, MAX_URL_LENGTH, normalizeUrl, parseLanguageTag } from '../src/index.mjs'

test('well-formed BCP 47 tags parse to their canonical spelling', () => {
  const expected = [
    ['en', 'language', 'en', 'en'],
    ['EN-gb', 'language', 'en-gb', 'en-GB'],
    ['en-US', 'language', 'en-us', 'en-US'],
    ['ast', 'language', 'ast', 'ast'],
    ['zh-Hant-TW', 'language', 'zh-hant-tw', 'zh-Hant-TW'],
    ['zh-cmn-Hans-CN', 'language', 'zh-cmn-hans-cn', 'zh-cmn-Hans-CN'],
    ['es-419', 'language', 'es-419', 'es-419'],
    ['de-DE-1996', 'language', 'de-de-1996', 'de-DE-1996'],
    ['sr-Latn-RS', 'language', 'sr-latn-rs', 'sr-Latn-RS'],
    ['en-US-x-private', 'language', 'en-us-x-private', 'en-US-x-private'],
    ['en-a-bbb-x-y', 'language', 'en-a-bbb-x-y', 'en-a-bbb-x-y'],
    ['x-default', 'x-default', 'x-default', 'x-default'],
    ['X-Default', 'x-default', 'x-default', 'x-default'],
    ['  en-GB  ', 'language', 'en-gb', 'en-GB'],
  ]
  for (const [input, kind, key, canonical] of expected) {
    const parsed = parseLanguageTag(input)
    assert.deepEqual(
      { kind: parsed.kind, key: parsed.key, canonical: parsed.canonical },
      { kind, key, canonical },
      `parsing ${JSON.stringify(input)}`,
    )
  }
})

test('malformed tags are rejected with a reason', () => {
  const rejected = [
    'fr_FR',
    'e',
    '',
    '   ',
    'en-',
    '-en',
    'en--GB',
    'x-custom',
    'de-1996-1996',
    'toolongsubtag',
    'en-a',
    'en-x',
    '123',
    'en-GB-GB',
    'en-GB-a-b-a-c',
    'a'.repeat(MAX_TAG_LENGTH + 1),
  ]
  for (const input of rejected) {
    const parsed = parseLanguageTag(input)
    assert.equal(parsed.kind, 'invalid', `expected ${JSON.stringify(input)} to be rejected`)
    assert.equal(parsed.key, null)
    assert.equal(typeof parsed.reason, 'string')
    assert.equal(parsed.reason.length > 0, true)
  }
  assert.equal(parseLanguageTag(undefined).kind, 'invalid')
  assert.equal(parseLanguageTag(42).kind, 'invalid')
})

test('regional variants are distinct tags and never collapse to their language', () => {
  const gb = parseLanguageTag('en-GB')
  const us = parseLanguageTag('en-US')
  const plain = parseLanguageTag('en')
  assert.equal(gb.key === us.key, false)
  assert.equal(gb.key === plain.key, false)
  assert.deepEqual([gb.key, us.key, plain.key], ['en-gb', 'en-us', 'en'])
})

test('tag identity is case insensitive', () => {
  assert.equal(parseLanguageTag('EN-GB').key, parseLanguageTag('en-gb').key)
  assert.equal(parseLanguageTag('EN-GB').canonical, 'en-GB')
})

test('URL identity keeps path, query and trailing slash and drops the fragment', () => {
  assert.deepEqual(normalizeUrl('https://example.com/en/#top'), {
    ok: true,
    url: 'https://example.com/en/',
    reason: null,
  })
  assert.equal(normalizeUrl('https://example.com/en/?a=1').url, 'https://example.com/en/?a=1')
  assert.equal(normalizeUrl('https://example.com/en').url, 'https://example.com/en')
  assert.equal(normalizeUrl('https://example.com/en').url === normalizeUrl('https://example.com/en/').url, false)
  assert.equal(normalizeUrl('https://EXAMPLE.com/Path').url, 'https://example.com/Path')
  assert.equal(normalizeUrl('HTTPS://example.com/').url, 'https://example.com/')
})

test('a relative alternate resolves against the page that declares it', () => {
  assert.equal(normalizeUrl('/fr/', 'https://example.com/en/').url, 'https://example.com/fr/')
  assert.equal(normalizeUrl('../fr/', 'https://example.com/en/page').url, 'https://example.com/fr/')
  assert.equal(normalizeUrl('//other.example/fr/', 'https://example.com/en/').url, 'https://other.example/fr/')
})

test('unusable URLs are rejected with a reason', () => {
  const rejected = [
    ['/fr/', undefined],
    ['', undefined],
    ['   ', undefined],
    ['ftp://example.com/', undefined],
    ['mailto:someone@example.com', undefined],
    ['javascript:alert(1)', 'https://example.com/en/'],
    [`https://example.com/${'a'.repeat(MAX_URL_LENGTH)}`, undefined],
  ]
  for (const [input, base] of rejected) {
    const parsed = normalizeUrl(input, base)
    assert.equal(parsed.ok, false, `expected ${JSON.stringify(input)} to be rejected`)
    assert.equal(parsed.url, null)
    assert.equal(typeof parsed.reason, 'string')
  }
  assert.equal(normalizeUrl(undefined).ok, false)
  assert.equal(normalizeUrl(null, 'https://example.com/').ok, false)
})
