#!/usr/bin/env node
// Re-layout a drawio file via elkjs. Standalone from the PUML→drawio path.
//
// Usage:
//   node src/layout-drawio-cli.mjs <input.drawio> -o <output.drawio>
//   node src/layout-drawio-cli.mjs --help
import fs from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { layoutDrawio } from './layout-drawio.mjs'

async function main() {
    const argv = await yargs(hideBin(process.argv))
        .scriptName('layout-drawio')
        .command('$0 <input>', 're-layout a drawio file via elkjs', (y) =>
            y.positional('input', { describe: 'input drawio file', type: 'string' }),
        )
        .option('output', {
            alias: 'o',
            type: 'string',
            describe: 'output drawio file (default: overwrite input)',
        })
        .option('direction', {
            choices: ['DOWN', 'UP', 'LEFT', 'RIGHT'],
            default: 'DOWN',
            describe: 'ELK layout direction',
        })
        .option('nodesep', { type: 'number', default: 60 })
        .option('edgesep', { type: 'number', default: 20 })
        .option('ranksep', { type: 'number', default: 120 })
        .strict()
        .parse()

    const input = argv.input
    if (typeof input !== 'string' || input.length === 0) {
        console.error('layout-drawio: input path required')
        process.exit(2)
    }

    const inputAbs = path.resolve(input)
    const outputAbs = path.resolve(argv.output ?? inputAbs)

    const xmlIn = await fs.readFile(inputAbs, 'utf-8')
    const xmlOut = await layoutDrawio(xmlIn, {
        direction: argv.direction,
        nodesep: argv.nodesep,
        edgesep: argv.edgesep,
        ranksep: argv.ranksep,
    })

    await fs.mkdir(path.dirname(outputAbs), { recursive: true })
    await fs.writeFile(outputAbs, xmlOut)
    console.error(`re-laid: ${inputAbs} -> ${outputAbs}`)
}

if (url.fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch((err) => {
        console.error('layout-drawio:', err.message)
        process.exit(1)
    })
}
