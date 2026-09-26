import assert from 'node:assert/strict'
import test from 'node:test'

import { decodeEntities, scanHtml, scanSitemap } from '../src/index.mjs'

const LIMITS = { maxAlternates: 10 }

test('link elements in the head are read with their rel, hreflang and href', () => {
  const source = [
    '<html><head>',
    '<link rel="canonical" href="https://example.com/en/">',
    '<link rel="alternate" hreflang="en-GB" href="https://example.com/en-gb/">',
    "<link rel='alternate' hreflang='fr' href='/fr/'>",
    '<link rel=alternate hreflang=de href=/de/>',
    '<link rel="ALTERNATE" hreflang="es" href="/es/">',
    '</head><body></body></html>',
  ].join('\n')
  const scan = scanHtml(source, LIMITS)
  assert.deepEqual(
    scan.alternates.map((entry) => [entry.hreflang, entry.href]),
    [['en-GB', 'https://example.com/en-gb/'], ['fr', '/fr/'], ['de', '/de/'], ['es', '/es/']],
  )
  assert.deepEqual(scan.canonicals.map((entry) => entry.href), ['https://example.com/en/'])
  assert.equal(scan.overflow, false)
  assert.equal(scan.alternatesFound, 4)
})

test('commented-out links, body links and non-hreflang alternates are not declarations', () => {
  const source = [
    '<html><head>',
    '<!-- <link rel="alternate" hreflang="it" href="/it/"> -->',
    '<link rel="alternate" type="application/rss+xml" href="/feed.xml">',
    '<link rel="stylesheet" href="/site.css">',
    '<link rel="alternate" hreflang="en" href="/en/">',
    '</head><body>',
    '<link rel="alternate" hreflang="pt" href="/pt/">',
    '</body></html>',
  ].join('\n')
  const scan = scanHtml(source, LIMITS)
  assert.deepEqual(scan.alternates.map((entry) => entry.hreflang), ['en'])
  assert.deepEqual(scan.canonicals, [])
})

test('a document with no head element is scanned whole', () => {
  const scan = scanHtml('<link rel="alternate" hreflang="en" href="/en/">', LIMITS)
  assert.deepEqual(scan.alternates.map((entry) => entry.href), ['/en/'])
})

test('entity references in attribute values are decoded', () => {
  const scan = scanHtml('<head><link rel="alternate" hreflang="en" href="/en/?a=1&amp;b=2&#61;3"></head>', LIMITS)
  assert.equal(scan.alternates[0].href, '/en/?a=1&b=2=3')
  assert.equal(decodeEntities('&lt;&gt;&quot;&apos;&amp;'), '<>"\'&')
  assert.equal(decodeEntities('&#x41;&#66;'), 'AB')
  assert.equal(decodeEntities('&notarealentity;&#xD800;'), '&notarealentity;&#xD800;')
})

test('a rel list containing alternate still counts', () => {
  const scan = scanHtml('<head><link rel="alternate  nofollow" hreflang="en" href="/en/"></head>', LIMITS)
  assert.deepEqual(scan.alternates.map((entry) => entry.hreflang), ['en'])
})

test('valueless attributes do not derail the scan', () => {
  const scan = scanHtml(
    '<head><link rel="alternate" hreflang="en" href="/en/" data-generated>'
    + '<link rel hreflang="fr" href="/fr/"></head>',
    LIMITS,
  )
  assert.deepEqual(scan.alternates.map((entry) => [entry.hreflang, entry.href]), [['en', '/en/']])
})

test('more alternates than the limit is reported, not truncated silently', () => {
  const links = Array.from({ length: 4 }, (unused, index) => `<link rel="alternate" hreflang="e${index}" href="/${index}/">`)
  const scan = scanHtml(`<head>${links.join('')}</head>`, { maxAlternates: 3 })
  assert.equal(scan.overflow, true)
  assert.equal(scan.alternatesFound, 4)
  assert.equal(scan.alternates.length, 3)
})

test('sitemap url entries and their alternate links are read', () => {
  const source = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    '  <url>',
    '    <loc><![CDATA[https://example.com/en/]]></loc>',
    '    <xhtml:link rel="alternate" hreflang="en" href="https://example.com/en/"/>',
    '    <xhtml:link rel="alternate" hreflang="fr" href="https://example.com/fr/?a=1&amp;b=2"/>',
    '  </url>',
    '  <url>',
    '    <loc>https://example.com/fr/</loc>',
    '    <link rel="alternate" hreflang="fr" href="https://example.com/fr/"/>',
    '  </url>',
    '</urlset>',
  ].join('\n')
  const scan = scanSitemap(source, { maxUrls: 10, maxAlternates: 10 })
  assert.equal(scan.kind, 'urlset')
  assert.deepEqual(scan.entries.map((entry) => entry.loc), ['https://example.com/en/', 'https://example.com/fr/'])
  assert.deepEqual(
    scan.entries[0].links.map((link) => [link.hreflang, link.href]),
    [['en', 'https://example.com/en/'], ['fr', 'https://example.com/fr/?a=1&b=2']],
  )
  assert.equal(scan.entries[1].links.length, 1)
  assert.equal(scan.overflow, false)
})

test('a sitemap index is identified rather than expanded', () => {
  const source = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '  <sitemap><loc>https://example.com/sitemap-en.xml</loc></sitemap>',
    '</sitemapindex>',
  ].join('\n')
  const scan = scanSitemap(source, { maxUrls: 10, maxAlternates: 10 })
  assert.equal(scan.kind, 'sitemapindex')
  assert.deepEqual(scan.entries, [])
})

test('a document that is not a sitemap is refused rather than guessed at', () => {
  const scan = scanSitemap('<html><body>not a sitemap</body></html>', { maxUrls: 10, maxAlternates: 10 })
  assert.equal(scan.kind, 'unknown')
  assert.equal(scan.reason, 'no <urlset> element was found, so this is not a sitemap export')
  assert.deepEqual(scan.entries, [])
})

test('a url entry with no loc is kept so it can be reported', () => {
  const source = '<urlset><url><xhtml:link rel="alternate" hreflang="en" href="/en/"/></url></urlset>'
  const scan = scanSitemap(source, { maxUrls: 10, maxAlternates: 10 })
  assert.equal(scan.entries.length, 1)
  assert.equal(scan.entries[0].loc, null)
})

test('sitemap limits are reported, not truncated silently', () => {
  const urls = Array.from(
    { length: 3 },
    (unused, index) => `<url><loc>https://example.com/${index}/</loc></url>`,
  )
  const scan = scanSitemap(`<urlset>${urls.join('')}</urlset>`, { maxUrls: 2, maxAlternates: 10 })
  assert.equal(scan.overflow, true)
  assert.equal(scan.urlsFound, 3)

  const links = Array.from(
    { length: 3 },
    (unused, index) => `<xhtml:link rel="alternate" hreflang="e${index}" href="/${index}/"/>`,
  )
  const inner = scanSitemap(
    `<urlset><url><loc>https://example.com/</loc>${links.join('')}</url></urlset>`,
    { maxUrls: 10, maxAlternates: 2 },
  )
  assert.equal(inner.entries[0].overflow, true)
  assert.equal(inner.entries[0].linksFound, 3)
  assert.equal(inner.overflowEntry, inner.entries[0])
})
