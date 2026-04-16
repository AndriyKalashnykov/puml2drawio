#!/usr/bin/env node
import { runCli } from './runner.mjs'

const code = await runCli({ argv: process.argv.slice(2) })
process.exit(code)
