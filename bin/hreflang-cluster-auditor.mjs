#!/usr/bin/env node

import { X_DEFAULT_POLICIES, checkProject, exitCodeFor, formatSummary, renderReport } from '../src/index.mjs'

const HELP = `hreflang-cluster-auditor

Build locale clusters from exported HTML and sitemap files, then check
reciprocal membership, self-links, BCP 47 language tags, canonical agreement
and the configured x-default expectation.

Usage:
  hreflang-cluster-auditor --config FILE [--root DIR] [--x-default POLICY] [--json]

Options:
  --config FILE       Project configuration (required)
  --root DIR          Input root that every declared path resolves against and
                      may not escape, lexically or through a symbolic link.
                      Defaults to the directory holding the config.
  --x-default POLICY  Override config.xDefault: ${X_DEFAULT_POLICIES.join(', ')}
  --json              Suppress the human summary on stderr
  -h, --help          Show this help

Streams:
  stdout  the JSON report and nothing else, so it can be piped into a parser
  stderr  the human summary and any diagnostics

Exit codes:
  0  every cluster was complete and consistent
  1  the audit completed and found a policy failure
  2  invalid configuration, or evidence the tool could not read. A referenced
     page that no input describes is reported incomplete, never as a pass.
     On a configuration error stdout stays empty; on unreadable evidence
     stdout carries an "incomplete" report naming what was not read.

This tool never fetches anything. Every page it reasons about comes from a
file inside the declared input root.
`

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { config: null, root: null, xDefault: undefined, json: false }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }
    if (argument === '--json') options.json = true
    else if (argument === '--config') options.config = takeValue('--config')
    else if (argument === '--root') options.root = takeValue('--root')
    else if (argument === '--x-default') options.xDefault = takeValue('--x-default')
    else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.config === null) throw new Error('--config is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stderr.write(HELP)
    return 0
  }

  let report
  try {
    report = await checkProject({
      config: options.config,
      root: options.root ?? undefined,
      xDefault: options.xDefault,
    })
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  process.stdout.write(renderReport(report))
  if (!options.json) process.stderr.write(formatSummary(report))
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
