/**
 * Read the alternate and canonical declarations out of an exported HTML page.
 *
 * This is a scanner, not an HTML parser, and it says so loudly in the README.
 * It removes comments, stops at `</head>` when there is one, and then reads
 * `<link>` elements. What it cannot see is documented rather than guessed at:
 * links injected by client-side script, links built by a template that never
 * ran, and a `<link>` whose attribute value contains a raw `>`.
 */

const COMMENT = /<!--[\s\S]*?-->/g
const HEAD_END = /<\/head\s*>/i
const LINK_TAG = /<link\b[^>]*>/gi
const ATTRIBUTE = /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'`=<>]+))?/g
const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
})

/** Decode the entity forms that actually turn up in href and hreflang values. */
export function decodeEntities(text) {
  return text.replace(/&(#[Xx][0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (whole, body) => {
    if (body.charAt(0) === '#') {
      const digits = body.charAt(1) === 'x' || body.charAt(1) === 'X' ? body.slice(2) : body.slice(1)
      const radix = body.charAt(1) === 'x' || body.charAt(1) === 'X' ? 16 : 10
      const code = Number.parseInt(digits, radix)
      if (!Number.isInteger(code) || code < 1 || code > 0x10ffff) return whole
      if (code >= 0xd800 && code <= 0xdfff) return whole
      return String.fromCodePoint(code)
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named === undefined ? whole : named
  })
}

function attributesOf(tag) {
  const attributes = new Map()
  ATTRIBUTE.lastIndex = 0
  let match = ATTRIBUTE.exec(tag)
  // The element name itself is the first match; skip it.
  while ((match = ATTRIBUTE.exec(tag)) !== null) {
    const name = match[1].toLowerCase()
    if (attributes.has(name)) continue
    const raw = match[2]
    if (raw === undefined) {
      attributes.set(name, '')
      continue
    }
    const quoted = raw.charAt(0) === '"' || raw.charAt(0) === "'"
    attributes.set(name, decodeEntities(quoted ? raw.slice(1, -1) : raw))
  }
  return attributes
}

function relTokens(value) {
  return new Set(value.trim().toLowerCase().split(/\s+/).filter((token) => token !== ''))
}

/**
 * @param {string} source decoded HTML
 * @param {{maxAlternates: number}} limits
 * @returns {{alternates: Array, canonicals: Array, alternatesFound: number, overflow: boolean}}
 */
export function scanHtml(source, limits) {
  const maxAlternates = limits.maxAlternates
  const withoutComments = source.replace(COMMENT, ' ')
  const headEnd = withoutComments.search(HEAD_END)
  const head = headEnd === -1 ? withoutComments : withoutComments.slice(0, headEnd)

  const alternates = []
  const canonicals = []
  let alternatesFound = 0

  LINK_TAG.lastIndex = 0
  let match
  while ((match = LINK_TAG.exec(head)) !== null) {
    const tag = match[0]
    const attributes = attributesOf(tag)
    const rel = relTokens(attributes.get('rel') ?? '')
    if (rel.has('canonical')) {
      canonicals.push({ href: attributes.get('href'), index: canonicals.length, raw: tag })
    }
    if (!rel.has('alternate')) continue
    if (!attributes.has('hreflang')) continue
    alternatesFound += 1
    if (alternates.length < maxAlternates) {
      alternates.push({
        hreflang: attributes.get('hreflang'),
        href: attributes.get('href'),
        index: alternates.length,
        raw: tag,
      })
    }
  }

  return { alternates, canonicals, alternatesFound, overflow: alternatesFound > maxAlternates }
}
