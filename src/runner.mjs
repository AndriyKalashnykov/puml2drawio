import fs from 'node:fs/promises'
import path from 'node:path'
import yargs from 'yargs'
import { resolveOptions } from './options.mjs'
import {
  collectPumlFiles,
  convertFile,
  convertString,
  deriveOutputPath
} from './convert.mjs'

export function buildParser(argv) {
  return yargs(argv)
    .scriptName('puml2drawio')
    .usage('$0 <input> [options]\n\nConvert PlantUML C4 diagrams to draw.io XML.')
    .command('$0 <input>', 'Convert input', (y) =>
      y.positional('input', {
        describe: 'Input .puml file, directory (recurses), glob pattern, or "-" for stdin',
        type: 'string'
      })
    )
    .option('output', {
      alias: 'o',
      type: 'string',
      describe: 'Output file (single input) or directory (batch). Default: stdout for single/stdin.'
    })
    .option('output-ext', {
      type: 'string',
      default: '.drawio',
      describe: 'Output file extension. Used in batch/glob mode, and in single-file mode when --output (-o) is a directory. Not applicable to stdin (no source filename to derive a stem from).'
    })
    .option('layout-direction', {
      type: 'string',
      choices: ['TB', 'BT', 'LR', 'RL'],
      describe: 'Layout direction (env: CATALYST_LAYOUT_DIRECTION)'
    })
    .option('nodesep', { type: 'number', describe: 'Node separation (env: CATALYST_NODESEP)' })
    .option('edgesep', { type: 'number', describe: 'Edge separation (env: CATALYST_EDGESEP)' })
    .option('ranksep', { type: 'number', describe: 'Rank separation (env: CATALYST_RANKSEP)' })
    .option('marginx', { type: 'number', describe: 'X margin (env: CATALYST_MARGINX)' })
    .option('marginy', { type: 'number', describe: 'Y margin (env: CATALYST_MARGINY)' })
    .option('theme', {
      type: 'string',
      choices: ['light', 'dark'],
      describe:
        'Color theme. "light" (default) = catalyst C4_blue. "dark" = official C4-PlantUML C4_superhero remap (env: CATALYST_THEME)'
    })
    .option('fail-fast', { type: 'boolean', default: false, describe: 'Stop on first batch error' })
    .option('exclude', {
      type: 'string',
      describe:
        'Comma/space-separated glob(s) of input files to skip in directory/glob batch mode (matched against the collected path AND its basename). Single-file/stdin input is never excluded.'
    })
    .option('skip-unsupported', {
      type: 'boolean',
      default: false,
      describe:
        'Loudly SKIP (warn + count in --summary as "skipped") files catalyst rejects as an unsupported diagram TYPE (C4_Sequence / zero convertible C4 elements) instead of failing the batch. Genuine conversion errors still fail loud. Single-file/stdin still fails loud.'
    })
    .option('summary', {
      type: 'boolean',
      default: false,
      describe: 'Emit a JSON conversion summary {total,converted,failed,files[]}. Batch/glob: to stdout. Single/stdin: to stderr (stdout still carries the drawio).'
    })
    .option('quiet', { alias: 'q', type: 'boolean', default: false })
    .strict()
    .help()
    .version()
}

function flagsFromArgv(argv) {
  return {
    layoutDirection: argv.layoutDirection,
    nodesep: argv.nodesep,
    edgesep: argv.edgesep,
    ranksep: argv.ranksep,
    marginx: argv.marginx,
    marginy: argv.marginy,
    theme: argv.theme
  }
}

async function readStdin(stdin) {
  const chunks = []
  for await (const chunk of stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf-8')
}

// Glob metacharacters per POSIX / node:fs glob (`*` `?` `[...]` `{...}`).
// A lone `-` is stdin (handled before this); a real path has none of these.
const GLOB_RE = /[*?[\]{}]/

function isGlobPattern(s) {
  return GLOB_RE.test(s)
}

// The static leading directory of a glob — every path segment up to (not
// including) the first segment containing a metacharacter. Output paths are
// derived relative to this, exactly as batch mode uses the input directory.
// `diagrams/**/*.puml` -> `diagrams`; `**/*.puml` -> `.`; `a/b/c*.puml` -> `a/b`.
function globBaseDir(pattern) {
  const segs = []
  for (const seg of pattern.split('/')) {
    if (GLOB_RE.test(seg)) break
    segs.push(seg)
  }
  return segs.length > 0 ? segs.join('/') : '.'
}

async function emitSummary(stream, files) {
  const converted = files.filter((f) => f.status === 'converted').length
  const skipped = files.filter((f) => f.status === 'skipped').length
  stream.write(
    JSON.stringify({
      total: files.length,
      converted,
      skipped,
      failed: files.length - converted - skipped,
      files
    }) + '\n'
  )
}

// catalyst (>= v1.4.1) throws a STABLE sentinel for input it refuses by
// TYPE (C4_Sequence/dynamic) or because nothing converts — distinct from a
// genuine conversion error. `--skip-unsupported` keys off these messages
// only; every other failure still fails loud.
const UNSUPPORTED_RE =
  /unsupported C4-PlantUML diagram type|no convertible C4 elements found/i
function isUnsupportedTypeError(err) {
  return UNSUPPORTED_RE.test(err && err.message ? err.message : String(err))
}

// Split a comma/space-separated --exclude string into globs; returns a
// predicate true when `file` should be skipped. Patterns match the
// collected path OR its basename, so both `**/sequence-*.puml` and
// `sequence-leaf-cert-lifecycle.puml` work.
function makeExcluder(excludeStr) {
  const pats = String(excludeStr || '')
    .split(/[,\s]+/)
    .filter(Boolean)
  if (pats.length === 0) return () => false
  return (file) =>
    pats.some(
      (p) => path.matchesGlob(file, p) || path.matchesGlob(path.basename(file), p)
    )
}

// Shared many-file engine for both directory batch and glob input. `files`
// is a pre-resolved, sorted list; `baseDir` anchors the output tree.
async function convertMany({
  files,
  baseDir,
  output,
  options,
  outputExt,
  failFast,
  quiet,
  summary,
  skipUnsupported,
  stdout,
  stderr
}) {
  const results = []
  const errors = []
  for (const file of files) {
    const target = deriveOutputPath({
      inputPath: file,
      baseDir,
      outputDir: output,
      ext: outputExt
    })
    try {
      await convertFile(file, target, options)
      results.push({ input: file, output: target, status: 'converted' })
      if (!quiet) stderr.write(`converted: ${file} -> ${target}\n`)
    } catch (err) {
      if (skipUnsupported && isUnsupportedTypeError(err)) {
        // Loud skip: catalyst refuses this file by diagram TYPE (not a
        // broken file). Reported in --summary as "skipped"; NOT counted
        // as a failure, so the end-of-batch throw does not fire for it.
        results.push({ input: file, output: target, status: 'skipped', reason: err.message })
        stderr.write(`skipped:   ${file}: ${err.message}\n`)
        continue
      }
      results.push({ input: file, output: target, status: 'failed', error: err.message })
      errors.push({ file, err })
      stderr.write(`failed:    ${file}: ${err.message}\n`)
      if (failFast) break
    }
  }
  // Emit the summary BEFORE throwing so a partially-failed batch still
  // reports machine-readable results (CI dashboards rely on this).
  if (summary) await emitSummary(stdout, results)
  if (errors.length > 0) {
    throw new Error(`${errors.length} of ${files.length} file(s) failed to convert`)
  }
}

async function isDirectory(p) {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function runStdin({ output, options, stdin, stdout, stderr, summary }) {
  const puml = await readStdin(stdin)
  const drawio = await convertString(puml, options)
  let target = null
  if (output) {
    await fs.mkdir(path.dirname(output), { recursive: true })
    await fs.writeFile(output, drawio)
    target = output
  } else {
    stdout.write(drawio)
  }
  // stdin has no source filename, so --output-ext cannot derive a stem here
  // (by design — see the option's describe). Summary goes to stderr so it
  // never corrupts the drawio on stdout.
  if (summary) await emitSummary(stderr, [{ input: '-', output: target, status: 'converted' }])
}

async function runSingle({ input, output, options, outputExt, stdout, stderr, summary }) {
  let target = null
  if (output) {
    // --output-ext support in single-file mode: when -o is a directory,
    // derive `<inputStem><outputExt>` inside it (batch-consistent). When -o
    // is a file path, it is used verbatim (the path's own extension wins).
    if (await isDirectory(output)) {
      const stem = path.basename(input, path.extname(input))
      target = path.join(output, `${stem}${outputExt}`)
    } else {
      target = output
    }
    await convertFile(input, target, options)
  } else {
    const drawio = await convertFile(input, null, options)
    stdout.write(drawio)
  }
  if (summary) await emitSummary(stderr, [{ input, output: target, status: 'converted' }])
}

async function runBatch(args) {
  const all = await collectPumlFiles(args.input)
  if (all.length === 0) {
    throw new Error(`No .puml files found under ${args.input}`)
  }
  const exclude = makeExcluder(args.exclude)
  const files = all.filter((f) => !exclude(f))
  await convertMany({ ...args, files, baseDir: args.input })
}

async function runGlob(args) {
  const matches = []
  for await (const entry of fs.glob(args.pattern)) matches.push(entry)
  const all = matches
    .filter((f) => f.toLowerCase().endsWith('.puml'))
    .sort()
  if (all.length === 0) {
    throw new Error(`No .puml files matched glob ${args.pattern}`)
  }
  const exclude = makeExcluder(args.exclude)
  const files = all.filter((f) => !exclude(f))
  await convertMany({ ...args, files, baseDir: globBaseDir(args.pattern) })
}

// Yargs v17 strips a lone `-` positional (it treats `-` as an incomplete option
// prefix), which would prevent `puml2drawio -` from reaching stdin mode. Swap
// `-` for a private-use-area sentinel before parsing and map back after. The
// sentinel is never a real filename so round-tripping it through yargs is safe.
const STDIN_SENTINEL = '\uE000-stdin'

function preprocessStdinSentinel(argv) {
  return argv.map((arg) => (arg === '-' ? STDIN_SENTINEL : arg))
}

export async function runCli({
  argv,
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  let parsed
  try {
    parsed = await buildParser(preprocessStdinSentinel(argv)).parseAsync()
  } catch (err) {
    stderr.write(`error: ${err.message}\n`)
    return 2
  }
  if (parsed.input === STDIN_SENTINEL) {
    parsed.input = '-'
  }

  let options
  try {
    options = resolveOptions(flagsFromArgv(parsed), env)
  } catch (err) {
    stderr.write(`error: ${err.message}\n`)
    return 2
  }

  const input = parsed.input
  const output = parsed.output

  try {
    if (input === '-') {
      await runStdin({ output, options, stdin, stdout, stderr, summary: parsed.summary })
      return 0
    }
    // Glob must be detected BEFORE fs.stat — a pattern like
    // `diagrams/**/*.puml` is not a real path and would ENOENT.
    if (isGlobPattern(input)) {
      if (!output) {
        stderr.write('error: --output is required when input is a glob pattern\n')
        return 2
      }
      await runGlob({
        pattern: input,
        output,
        options,
        outputExt: parsed.outputExt,
        failFast: parsed.failFast,
        quiet: parsed.quiet,
        summary: parsed.summary,
        exclude: parsed.exclude,
        skipUnsupported: parsed.skipUnsupported,
        stdout,
        stderr
      })
      return 0
    }
    const stat = await fs.stat(input)
    if (stat.isDirectory()) {
      if (!output) {
        stderr.write('error: --output is required when input is a directory\n')
        return 2
      }
      await runBatch({
        input,
        output,
        options,
        outputExt: parsed.outputExt,
        failFast: parsed.failFast,
        quiet: parsed.quiet,
        summary: parsed.summary,
        exclude: parsed.exclude,
        skipUnsupported: parsed.skipUnsupported,
        stdout,
        stderr
      })
      return 0
    }
    await runSingle({
      input,
      output,
      options,
      outputExt: parsed.outputExt,
      stdout,
      stderr,
      summary: parsed.summary
    })
    return 0
  } catch (err) {
    stderr.write(`error: ${err.message}\n`)
    return 1
  }
}
