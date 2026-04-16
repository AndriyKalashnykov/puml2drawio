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
        describe: 'Input .puml file, directory (recurses), or "-" for stdin',
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
      describe: 'Output file extension used in batch mode'
    })
    .option('layout-direction', {
      type: 'string',
      choices: ['TB', 'BT', 'LR', 'RL'],
      describe: 'Dagre layout direction (env: CATALYST_LAYOUT_DIRECTION)'
    })
    .option('nodesep', { type: 'number', describe: 'Node separation (env: CATALYST_NODESEP)' })
    .option('edgesep', { type: 'number', describe: 'Edge separation (env: CATALYST_EDGESEP)' })
    .option('ranksep', { type: 'number', describe: 'Rank separation (env: CATALYST_RANKSEP)' })
    .option('marginx', { type: 'number', describe: 'X margin (env: CATALYST_MARGINX)' })
    .option('marginy', { type: 'number', describe: 'Y margin (env: CATALYST_MARGINY)' })
    .option('fail-fast', { type: 'boolean', default: false, describe: 'Stop on first batch error' })
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
    marginy: argv.marginy
  }
}

async function readStdin(stdin) {
  const chunks = []
  for await (const chunk of stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf-8')
}

async function runStdin({ output, options, stdin, stdout }) {
  const puml = await readStdin(stdin)
  const drawio = await convertString(puml, options)
  if (output) {
    await fs.mkdir(path.dirname(output), { recursive: true })
    await fs.writeFile(output, drawio)
  } else {
    stdout.write(drawio)
  }
}

async function runSingle({ input, output, options, stdout }) {
  if (output) {
    await convertFile(input, output, options)
  } else {
    const drawio = await convertFile(input, null, options)
    stdout.write(drawio)
  }
}

async function runBatch({ input, output, options, outputExt, failFast, quiet, stderr }) {
  const files = await collectPumlFiles(input)
  if (files.length === 0) {
    throw new Error(`No .puml files found under ${input}`)
  }
  const errors = []
  for (const file of files) {
    const target = deriveOutputPath({
      inputPath: file,
      baseDir: input,
      outputDir: output,
      ext: outputExt
    })
    try {
      await convertFile(file, target, options)
      if (!quiet) stderr.write(`converted: ${file} -> ${target}\n`)
    } catch (err) {
      errors.push({ file, err })
      stderr.write(`failed:    ${file}: ${err.message}\n`)
      if (failFast) break
    }
  }
  if (errors.length > 0) {
    throw new Error(`${errors.length} of ${files.length} file(s) failed to convert`)
  }
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
      await runStdin({ output, options, stdin, stdout })
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
        stderr
      })
      return 0
    }
    await runSingle({ input, output, options, stdout })
    return 0
  } catch (err) {
    stderr.write(`error: ${err.message}\n`)
    return 1
  }
}
