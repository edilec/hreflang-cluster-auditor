/**
 * The audit itself: pure, synchronous, and independent of how the pages were
 * read off disk.
 *
 * A cluster is a connected component of the "declares as an alternate" graph.
 * Membership is decided by the href, not by the tag, so an entry whose hreflang
 * value is malformed still counts as a declaration -- otherwise one typo in a
 * language tag would cascade into a fictional reciprocity failure on a page that
 * does link back.
 *
 * A URL that some page names but no input describes is not a pass and not a
 * failure: it is missing evidence. The tool cannot see that page's declarations,
 * so it refuses to conclude anything about the reciprocity of that edge.
 *
 * Every attribute value quoted back into a message goes through `excerpt`, the
 * same bound the `evidence` field uses. A message is untrusted input too: a
 * 200000 character hreflang must not become a 200000 character message.
 */

import { at, byCodeUnit, excerpt, makeFinding } from './rules.mjs'
import { X_DEFAULT, normalizeUrl, parseLanguageTag } from './tags.mjs'

export const X_DEFAULT_POLICIES = Object.freeze(['optional', 'required', 'forbidden'])

const MAX_LISTED_URLS = 3

function listUrls(urls) {
  const shown = urls.slice(0, MAX_LISTED_URLS).join(', ')
  return urls.length > MAX_LISTED_URLS ? `${shown} and ${urls.length - MAX_LISTED_URLS} more` : shown
}

function describeTags(tagKeys) {
  const tags = [...tagKeys].sort(byCodeUnit)
  return tags.length === 0 ? 'an alternate with no usable language tag' : `the "${tags.join('", "')}" alternate`
}

function bySite(a, b) {
  return byCodeUnit(a.file, b.file) || byCodeUnit(a.pointer, b.pointer) || byCodeUnit(a.target, b.target)
}

function resolvePage(page, findings) {
  const declarations = new Map()
  const tagTargets = new Map()
  const selfTags = new Set()
  const seenPairs = new Set()
  let xDefault = null
  let alternates = 0

  for (const entry of page.alternates) {
    alternates += 1
    const target = normalizeUrl(entry.href, page.url)
    if (!target.ok) {
      findings.push(makeFinding(
        'invalid-alternate-url',
        `The alternate href ${JSON.stringify(excerpt(entry.href ?? ''))} could not be used: ${target.reason}.`,
        at(page.file, entry.pointer),
        { evidence: entry.raw, suggestion: 'Use an absolute http or https URL, or a path that resolves against this page.' },
      ))
      continue
    }

    const tag = parseLanguageTag(entry.hreflang)
    let tagKey = null
    if (tag.kind === 'invalid') {
      findings.push(makeFinding(
        'invalid-language-tag',
        `The hreflang value ${JSON.stringify(excerpt(entry.hreflang ?? ''))} is not a well-formed BCP 47 tag: ${tag.reason}.`,
        at(page.file, entry.pointer),
        { evidence: entry.raw, suggestion: 'Use a BCP 47 tag such as "en", "en-GB" or "zh-Hant-TW", or the literal "x-default".' },
      ))
    } else {
      tagKey = tag.key
      if (tag.canonical !== String(entry.hreflang).trim()) {
        findings.push(makeFinding(
          'language-tag-not-canonical-case',
          `The hreflang value ${JSON.stringify(String(entry.hreflang).trim())} is well-formed but conventionally written "${tag.canonical}".`,
          at(page.file, entry.pointer),
          { evidence: entry.raw, suggestion: `Write it as "${tag.canonical}". Matching is case-insensitive, so this changes nothing a crawler does.` },
        ))
      }
    }

    const declaration = declarations.get(target.url) ?? { tagKeys: new Set(), entry }
    if (tagKey !== null) declaration.tagKeys.add(tagKey)
    declarations.set(target.url, declaration)

    if (tagKey === null) continue

    const pairKey = `${tagKey} ${target.url}`
    if (seenPairs.has(pairKey)) {
      findings.push(makeFinding(
        'duplicate-alternate-entry',
        `This page declares hreflang "${tagKey}" for ${target.url} more than once.`,
        at(page.file, entry.pointer),
        { evidence: entry.raw, suggestion: 'Remove the repeated link element.' },
      ))
      continue
    }
    seenPairs.add(pairKey)

    if (tagKey === X_DEFAULT) {
      if (xDefault === null) {
        xDefault = { target: target.url, file: page.file, pointer: entry.pointer, raw: entry.raw }
      } else {
        findings.push(makeFinding(
          'multiple-x-default',
          `This page declares a second x-default pointing at ${target.url}; ${xDefault.target} was declared first.`,
          at(page.file, entry.pointer),
          { evidence: entry.raw, suggestion: 'A page may name exactly one x-default fallback.' },
        ))
      }
    } else {
      const previous = tagTargets.get(tagKey)
      if (previous === undefined) {
        tagTargets.set(tagKey, { target: target.url, file: page.file, pointer: entry.pointer, raw: entry.raw })
      } else {
        findings.push(makeFinding(
          'duplicate-hreflang-tag',
          `This page maps hreflang "${tagKey}" to both ${previous.target} and ${target.url}.`,
          at(page.file, entry.pointer),
          { evidence: entry.raw, suggestion: 'One language tag may name exactly one URL on a page.' },
        ))
      }
      if (target.url === page.url) selfTags.add(tagKey)
    }
  }

  if (!declarations.has(page.url)) {
    findings.push(makeFinding(
      'missing-self-alternate',
      `${page.url} does not declare itself among its own alternates.`,
      at(page.file, page.pointer),
      { suggestion: 'Every member of an hreflang cluster links to itself as well as to its siblings.' },
    ))
  }

  if (page.hasHtml) {
    if (page.canonicals.length === 0) {
      findings.push(makeFinding(
        'missing-canonical',
        `${page.url} declares alternates but no canonical link, so the self-link cannot be confirmed against a canonical.`,
        at(page.file, page.pointer),
        { suggestion: 'Add <link rel="canonical"> pointing at this page.' },
      ))
    } else if (page.canonicals.length > 1) {
      findings.push(makeFinding(
        'multiple-canonical',
        `${page.url} declares ${page.canonicals.length} canonical links; at most one is meaningful.`,
        at(page.file, page.canonicals[1].pointer),
        { evidence: page.canonicals[1].raw, suggestion: 'Keep one canonical link and delete the rest.' },
      ))
    } else {
      const canonical = normalizeUrl(page.canonicals[0].href, page.url)
      if (!canonical.ok) {
        findings.push(makeFinding(
          'invalid-canonical-url',
          `The canonical href ${JSON.stringify(excerpt(page.canonicals[0].href ?? ''))} could not be used: ${canonical.reason}.`,
          at(page.file, page.canonicals[0].pointer),
          { evidence: page.canonicals[0].raw, suggestion: 'Use an absolute http or https URL.' },
        ))
      } else if (canonical.url !== page.url) {
        findings.push(makeFinding(
          'canonical-self-link-conflict',
          `${page.url} self-links as an alternate but its canonical names ${canonical.url}, so the two disagree about which URL is this page.`,
          at(page.file, page.canonicals[0].pointer),
          { evidence: page.canonicals[0].raw, suggestion: 'Point the canonical at this page; a cross-language canonical removes the page from the cluster.' },
        ))
      }
    }
  }

  return { page, declarations, tagTargets, selfTags, xDefault, alternates }
}

function buildComponents(states) {
  const adjacency = new Map()
  const touch = (node) => {
    if (!adjacency.has(node)) adjacency.set(node, new Set())
    return adjacency.get(node)
  }
  for (const [url, state] of states) {
    touch(url)
    for (const target of state.declarations.keys()) {
      touch(url).add(target)
      touch(target).add(url)
    }
  }

  const sortedNodes = [...adjacency.keys()].sort(byCodeUnit)
  const seen = new Set()
  const components = []
  for (const node of sortedNodes) {
    if (seen.has(node)) continue
    seen.add(node)
    const members = []
    const queue = [node]
    while (queue.length > 0) {
      const current = queue.shift()
      members.push(current)
      for (const neighbour of [...adjacency.get(current)].sort(byCodeUnit)) {
        if (seen.has(neighbour)) continue
        seen.add(neighbour)
        queue.push(neighbour)
      }
    }
    components.push(members.sort(byCodeUnit))
  }
  return components
}

function auditCluster(members, states, xDefaultPolicy, findings) {
  const known = members.filter((member) => states.has(member))
  const unknown = members.filter((member) => !states.has(member))

  for (const target of unknown) {
    const referrers = known.filter((url) => states.get(url).declarations.has(target)).sort(byCodeUnit)
    const referrer = states.get(referrers[0])
    const entry = referrer.declarations.get(target).entry
    findings.push(makeFinding(
      'alternate-not-in-inputs',
      `${target} is declared as an alternate by ${referrers.length} page(s), including ${referrers[0]}, but no input describes it, so its reciprocal links were not checked.`,
      at(referrer.page.file, entry.pointer),
      { evidence: entry.raw, suggestion: 'Add that page to the audited inputs, or remove the alternate if the page does not exist.' },
    ))
  }

  for (const a of known) {
    const stateA = states.get(a)
    for (const b of known) {
      if (a === b) continue
      const stateB = states.get(b)
      const aDeclaresB = stateA.declarations.get(b)
      const bDeclaresA = stateB.declarations.has(a)
      if (aDeclaresB !== undefined && !bDeclaresA) {
        findings.push(makeFinding(
          'missing-reciprocal-alternate',
          `${a} declares ${b} as ${describeTags(aDeclaresB.tagKeys)}, but ${b} does not declare ${a} in return.`,
          at(stateB.page.file, stateB.page.pointer),
          { evidence: aDeclaresB.entry.raw, suggestion: `Add an alternate on ${b} pointing at ${a}.` },
        ))
      } else if (aDeclaresB === undefined && !bDeclaresA) {
        findings.push(makeFinding(
          'cluster-membership-incomplete',
          `${a} does not declare ${b}, although both belong to the same alternate cluster.`,
          at(stateA.page.file, stateA.page.pointer),
          { suggestion: 'Every member of a cluster declares every other member, including itself.' },
        ))
      }
    }
  }

  const tagSites = new Map()
  for (const url of known) {
    for (const [tagKey, site] of states.get(url).tagTargets) {
      const sites = tagSites.get(tagKey) ?? []
      sites.push(site)
      tagSites.set(tagKey, sites)
    }
  }
  for (const tagKey of [...tagSites.keys()].sort(byCodeUnit)) {
    const sites = [...tagSites.get(tagKey)].sort(bySite)
    const targets = [...new Set(sites.map((site) => site.target))].sort(byCodeUnit)
    if (targets.length < 2) continue
    findings.push(makeFinding(
      'cluster-hreflang-conflict',
      `Members of this cluster map hreflang "${tagKey}" to ${targets.length} different URLs: ${listUrls(targets)}.`,
      at(sites[0].file, sites[0].pointer),
      { evidence: sites[0].raw, suggestion: 'One language tag names one URL across the whole cluster.' },
    ))
  }

  for (const url of known) {
    const state = states.get(url)
    for (const [tagKey, site] of state.tagTargets) {
      const targetState = states.get(site.target)
      if (targetState === undefined || site.target === url) continue
      if (targetState.selfTags.size === 0 || targetState.selfTags.has(tagKey)) continue
      const selfTags = [...targetState.selfTags].sort(byCodeUnit).join('", "')
      findings.push(makeFinding(
        'reciprocal-tag-mismatch',
        `${url} calls ${site.target} the "${tagKey}" alternate, but ${site.target} self-links as "${selfTags}".`,
        at(site.file, site.pointer),
        { evidence: site.raw, suggestion: 'Use the tag the target page uses for itself, or correct the target page self-link.' },
      ))
    }
  }

  const xSites = known
    .map((url) => states.get(url).xDefault)
    .filter((site) => site !== null)
    .sort(bySite)
  const xTargets = [...new Set(xSites.map((site) => site.target))].sort(byCodeUnit)

  if (xTargets.length === 0) {
    if (xDefaultPolicy === 'required') {
      const page = states.get(known[0]).page
      findings.push(makeFinding(
        'x-default-missing',
        `No member of the cluster starting at ${known[0]} declares an x-default, and the configured policy requires one.`,
        at(page.file, page.pointer),
        { suggestion: 'Add an x-default alternate naming the fallback page, or set xDefault to "optional".' },
      ))
    }
  } else {
    if (xDefaultPolicy === 'forbidden') {
      findings.push(makeFinding(
        'x-default-not-allowed',
        `This cluster declares an x-default pointing at ${xSites[0].target}, and the configured policy forbids one.`,
        at(xSites[0].file, xSites[0].pointer),
        { evidence: xSites[0].raw, suggestion: 'Remove the x-default alternates, or set xDefault to "optional".' },
      ))
    }
    if (xTargets.length > 1) {
      findings.push(makeFinding(
        'x-default-conflict',
        `Members of this cluster send x-default to ${xTargets.length} different URLs: ${listUrls(xTargets)}.`,
        at(xSites[0].file, xSites[0].pointer),
        { evidence: xSites[0].raw, suggestion: 'Every member of a cluster must name the same x-default fallback.' },
      ))
    }
  }
}

/**
 * @param {Array} pages loaded page records, each already carrying its own
 *   normalised URL, relative file and documented pointer
 * @param {{xDefault: string}} options
 */
export function auditPages(pages, options) {
  const xDefaultPolicy = options.xDefault
  if (!X_DEFAULT_POLICIES.includes(xDefaultPolicy)) {
    throw new Error(`Unknown x-default policy "${xDefaultPolicy}"`)
  }
  const findings = []
  const states = new Map()
  let alternates = 0

  for (const page of [...pages].sort((a, b) => byCodeUnit(a.url, b.url))) {
    const state = resolvePage(page, findings)
    alternates += state.alternates
    states.set(page.url, state)
  }

  const components = buildComponents(states)
  for (const members of components) auditCluster(members, states, xDefaultPolicy, findings)

  return { findings, checked: states.size, clusters: components.length, alternates }
}
