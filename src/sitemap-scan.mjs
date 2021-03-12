/**
 * Read `<url>` entries and their `xhtml:link` alternates out of a sitemap
 * export.
 *
 * Like the HTML side this is a bounded scanner rather than a general XML
 * parser. It understands the shape the sitemap protocol actually defines --
 * `urlset` / `url` / `loc` plus alternate `link` elements in any namespace
 * prefix -- and it refuses anything else instead of guessing. A sitemap index
 * names other files; expanding one would mean reading paths chosen by the input
 * document, so it is reported as unexpanded evidence, not followed.
 */

import { decodeEntities } from './html-scan.mjs'

const URL_BLOCK = /<url(?:\s[^>]*)?>([\s\S]*?)<\/url\s*>/gi
const LOC = /<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc\s*>/i
const LINK_TAG = /<(?:[A-Za-z_][-A-Za-z0-9_.]*:)?link\b[^>]*?\/?>/gi
const ATTRIBUTE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*')/g
const CDATA = /^<!\[CDATA\[([\s\S]*?)\]\]>$/

function textOf(raw) {
  const trimmed = raw.trim()
  const cdata = CDATA.exec(trimmed)
  return cdata === null ? decodeEntities(trimmed) : cdata[1].trim()
}

function attributesOf(tag) {
  const attributes = new Map()
  ATTRIBUTE.lastIndex = 0
  let match
  while ((match = ATTRIBUTE.exec(tag)) !== null) {
    const name = match[1].toLowerCase()
    if (attributes.has(name)) continue
    attributes.set(name, decodeEntities(match[2].slice(1, -1)))
  }
  return attributes
}

/**
 * @param {string} source decoded sitemap XML
 * @param {{maxUrls: number, maxAlternates: number}} limits
 * @returns {{kind: string, entries: Array, urlsFound: number, overflow: boolean,
 *            overflowEntry: object|null, reason: string|null}}
 */
export function scanSitemap(source, limits) {
  const empty = { kind: 'unknown', entries: [], urlsFound: 0, overflow: false, overflowEntry: null, reason: null }
  if (/<sitemapindex[\s>]/i.test(source)) {
    return { ...empty, kind: 'sitemapindex', reason: 'the document is a sitemap index' }
  }
  if (!/<urlset[\s>]/i.test(source)) {
    return { ...empty, reason: 'no <urlset> element was found, so this is not a sitemap export' }
  }

  const entries = []
  let urlsFound = 0
  let overflowEntry = null

  URL_BLOCK.lastIndex = 0
  let block
  while ((block = URL_BLOCK.exec(source)) !== null) {
    urlsFound += 1
    if (entries.length >= limits.maxUrls) continue
    const body = block[1]
    const loc = LOC.exec(body)
    const links = []
    let linksFound = 0
    LINK_TAG.lastIndex = 0
    let tag
    while ((tag = LINK_TAG.exec(body)) !== null) {
      const attributes = attributesOf(tag[0])
      const rel = (attributes.get('rel') ?? '').trim().toLowerCase()
      if (rel !== 'alternate') continue
      if (!attributes.has('hreflang')) continue
      linksFound += 1
      if (links.length < limits.maxAlternates) {
        links.push({
          hreflang: attributes.get('hreflang'),
          href: attributes.get('href'),
          index: links.length,
          raw: tag[0],
        })
      }
    }
    const entry = {
      loc: loc === null ? null : textOf(loc[1]),
      links,
      linksFound,
      overflow: linksFound > limits.maxAlternates,
      index: entries.length,
      raw: block[0],
    }
    if (entry.overflow && overflowEntry === null) overflowEntry = entry
    entries.push(entry)
  }

  return {
    kind: 'urlset',
    entries,
    urlsFound,
    overflow: urlsFound > limits.maxUrls,
    overflowEntry,
    reason: null,
  }
}
