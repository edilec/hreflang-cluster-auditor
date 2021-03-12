/**
 * Language tags and URL identity.
 *
 * The tag parser checks BCP 47 *well-formedness* -- the grammar of RFC 5646
 * section 2.1 -- and nothing else. It does not consult the IANA subtag registry,
 * so `xx-QQ` is well-formed here and still meaningless to a search engine. That
 * boundary is deliberate: a registry snapshot goes stale, and this tool makes no
 * network calls, so claiming registry validity would be claiming more than the
 * evidence supports.
 *
 * Regional variants are the reason this file exists at all. `en-GB` and `en-US`
 * are different tags that legitimately point at different pages, so tag identity
 * is the full lowercased tag and never just its language subtag.
 */

export const X_DEFAULT = 'x-default'

/** Fixed bounds, not configurable: a tag or URL beyond these is malformed. */
export const MAX_TAG_LENGTH = 64
export const MAX_URL_LENGTH = 2048

const ALPHA = /^[a-z]+$/
const DIGIT = /^[0-9]+$/
const ALNUM = /^[a-z0-9]+$/

function invalid(reason) {
  return { kind: 'invalid', key: null, canonical: null, reason }
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 * Parse one hreflang value.
 *
 * Returns `kind` `x-default`, `language` or `invalid`. `key` is the identity
 * used for every comparison (lowercased, so case never splits a cluster) and
 * `canonical` is the conventional casing (`en-GB`, `zh-Hant-TW`).
 */
export function parseLanguageTag(raw) {
  if (typeof raw !== 'string') return invalid('the hreflang attribute is absent')
  const trimmed = raw.trim()
  if (trimmed === '') return invalid('the hreflang attribute is empty')
  if (trimmed.length > MAX_TAG_LENGTH) {
    return invalid(`the tag is ${trimmed.length} characters, over the ${MAX_TAG_LENGTH} character bound`)
  }
  const lower = trimmed.toLowerCase()
  if (lower === X_DEFAULT) return { kind: 'x-default', key: X_DEFAULT, canonical: X_DEFAULT, reason: null }

  const parts = lower.split('-')
  for (const part of parts) {
    if (part === '') return invalid('it has an empty subtag, so a separator is doubled or trailing')
    if (!ALNUM.test(part)) return invalid(`the subtag "${part}" is not made of ASCII letters and digits`)
    if (part.length > 8) return invalid(`the subtag "${part}" is longer than the 8 character maximum`)
  }
  if (parts[0] === 'x') {
    return invalid('only "x-default" is meaningful as a private-use hreflang value')
  }

  const language = parts[0]
  if (!ALPHA.test(language)) return invalid(`the primary language subtag "${language}" must be letters only`)
  if (language.length < 2) return invalid(`the primary language subtag "${language}" is shorter than 2 characters`)

  const shaped = [language]
  let index = 1

  if (language.length <= 3) {
    let extlangs = 0
    while (index < parts.length && extlangs < 3 && parts[index].length === 3 && ALPHA.test(parts[index])) {
      shaped.push(parts[index])
      index += 1
      extlangs += 1
    }
  }

  if (index < parts.length && parts[index].length === 4 && ALPHA.test(parts[index])) {
    shaped.push(titleCase(parts[index]))
    index += 1
  }

  if (index < parts.length
    && ((parts[index].length === 2 && ALPHA.test(parts[index])) || (parts[index].length === 3 && DIGIT.test(parts[index])))) {
    shaped.push(parts[index].toUpperCase())
    index += 1
  }

  const variants = new Set()
  while (index < parts.length) {
    const part = parts[index]
    const isVariant = (part.length >= 5 && part.length <= 8) || (part.length === 4 && DIGIT.test(part.charAt(0)))
    if (!isVariant) break
    if (variants.has(part)) return invalid(`the variant subtag "${part}" is repeated`)
    variants.add(part)
    shaped.push(part)
    index += 1
  }

  const singletons = new Set()
  while (index < parts.length && parts[index].length === 1 && parts[index] !== 'x') {
    const singleton = parts[index]
    if (singletons.has(singleton)) return invalid(`the extension singleton "${singleton}" is repeated`)
    singletons.add(singleton)
    shaped.push(singleton)
    index += 1
    let members = 0
    while (index < parts.length && parts[index].length >= 2 && parts[index].length <= 8) {
      shaped.push(parts[index])
      index += 1
      members += 1
    }
    if (members === 0) return invalid(`the extension "${singleton}" carries no subtags`)
  }

  if (index < parts.length && parts[index] === 'x') {
    shaped.push('x')
    index += 1
    let members = 0
    while (index < parts.length) {
      shaped.push(parts[index])
      index += 1
      members += 1
    }
    if (members === 0) return invalid('the private-use section "x" carries no subtags')
  }

  if (index < parts.length) {
    return invalid(`the subtag "${parts[index]}" does not fit the BCP 47 grammar in that position`)
  }

  return { kind: 'language', key: lower, canonical: shaped.join('-'), reason: null }
}

/**
 * Normalise a URL to the identity this tool compares.
 *
 * Scheme and host are lowercased by the URL parser, the fragment is dropped
 * because it never names a different document, and everything else -- including
 * the trailing slash and the query -- is preserved exactly. `/en` and `/en/` are
 * therefore two different pages here; deciding which spelling a site prefers is
 * a different check with a different tool.
 */
export function normalizeUrl(raw, base = undefined) {
  if (typeof raw !== 'string') return { ok: false, url: null, reason: 'the href attribute is absent' }
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, url: null, reason: 'the href attribute is empty' }
  if (trimmed.length > MAX_URL_LENGTH) {
    return { ok: false, url: null, reason: `the URL is ${trimmed.length} characters, over the ${MAX_URL_LENGTH} character bound` }
  }
  let url
  try {
    url = base === undefined ? new URL(trimmed) : new URL(trimmed, base)
  } catch {
    return { ok: false, url: null, reason: base === undefined ? 'it is not an absolute URL' : 'it could not be resolved as a URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, url: null, reason: `the scheme "${url.protocol.slice(0, -1)}" is neither http nor https` }
  }
  return { ok: true, url: `${url.origin}${url.pathname}${url.search}`, reason: null }
}
