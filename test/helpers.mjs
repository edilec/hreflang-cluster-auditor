/** Shared fixture builders. This file defines no tests. */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = fileURLToPath(new URL('..', import.meta.url))
export const BIN = fileURLToPath(new URL('../bin/hreflang-cluster-auditor.mjs', import.meta.url))
export const ORIGIN = 'https://example.com'

/** Write a throwaway project under the system temp directory. */
export async function makeProject(files) {
  const root = await mkdtemp(join(tmpdir(), 'hreflang-auditor-'))
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return root
}

export async function removeProject(root) {
  await rm(root, { recursive: true, force: true })
}

export function configJson(body) {
  return `${JSON.stringify({ schemaVersion: '1', ...body }, null, 2)}\n`
}

/** One exported page. `alternates` is a list of [hreflang, href] pairs. */
export function htmlPage({ canonical = null, alternates = [], extraHead = '', body = '' } = {}) {
  const lines = ['<!doctype html>', '<html>', '  <head>', '    <meta charset="utf-8">']
  if (canonical !== null) lines.push(`    <link rel="canonical" href="${canonical}">`)
  for (const [tag, href] of alternates) {
    lines.push(`    <link rel="alternate" hreflang="${tag}" href="${href}">`)
  }
  if (extraHead !== '') lines.push(extraHead)
  lines.push('  </head>', '  <body>', body, '  </body>', '</html>', '')
  return lines.join('\n')
}

/** One sitemap export. `entries` is a list of [loc, [[hreflang, href], ...]]. */
export function sitemapXml(entries) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:xhtml="http://www.w3.org/1999/xhtml">',
  ]
  for (const [loc, links] of entries) {
    lines.push('  <url>')
    lines.push(`    <loc>${loc}</loc>`)
    for (const [tag, href] of links) {
      lines.push(`    <xhtml:link rel="alternate" hreflang="${tag}" href="${href}"/>`)
    }
    lines.push('  </url>')
  }
  lines.push('</urlset>', '')
  return lines.join('\n')
}

/**
 * A loaded page record of the shape `auditPages` consumes, so the audit can be
 * exercised without touching the filesystem.
 */
export function pageRecord(url, alternates, options = {}) {
  const file = options.file ?? `${new URL(url).pathname.replace(/\W+/g, '-').replace(/^-|-$/g, '')}.html`
  const pointer = options.pointer ?? '/pages/0'
  return {
    url,
    file,
    pointer,
    source: options.source ?? 'HTML',
    hasHtml: options.hasHtml ?? false,
    alternates: alternates.map(([hreflang, href], index) => ({
      hreflang,
      href,
      index,
      pointer: `${pointer}/alternates/${index}`,
      raw: `<link rel="alternate" hreflang="${hreflang}" href="${href}">`,
    })),
    canonicals: (options.canonicals ?? []).map((href, index) => ({
      href,
      index,
      pointer: `${pointer}/canonicals/${index}`,
      raw: `<link rel="canonical" href="${href}">`,
    })),
  }
}

/** A complete, correct four-member cluster with regional variants and x-default. */
export function healthyCluster() {
  const tags = [
    ['en-US', `${ORIGIN}/en-us/`],
    ['en-GB', `${ORIGIN}/en-gb/`],
    ['de-DE', `${ORIGIN}/de-de/`],
    ['fr', `${ORIGIN}/fr/`],
    ['x-default', `${ORIGIN}/en-us/`],
  ]
  return tags.slice(0, 4).map(([, url], index) => pageRecord(url, tags, { pointer: `/pages/${index}` }))
}

export function runCli(args, options = {}) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      {
        cwd: options.cwd ?? REPO,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        // `timeout` kills a child that never returns, so a test can assert that
        // the CLI came back at all instead of hanging the suite with it.
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      },
      (error, stdout, stderr) => {
        resolvePromise({ code: error === null ? 0 : error.code, killed: error !== null && error.killed === true, stdout, stderr })
      },
    )
  })
}

/** The (ruleId, file, pointer) triples of a report, in report order. */
export function triples(report) {
  return report.findings.map((finding) => [finding.ruleId, finding.location.file ?? null, finding.location.pointer ?? null])
}
