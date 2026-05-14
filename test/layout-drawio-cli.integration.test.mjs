import { describe, test, expect, beforeAll } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import url from 'node:url'
import { convertFile } from '../src/convert.mjs'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '..', 'src', 'layout-drawio-cli.mjs')
const SAMPLE_PUML = path.resolve(__dirname, '..', 'sample', 'example.puml')
const CATALYST_DIST = path.resolve(__dirname, '..', 'vendor', 'catalyst', 'dist', 'catalyst.mjs')

const vendorReady = fs.existsSync(CATALYST_DIST)
const describeIfReady = vendorReady ? describe : describe.skip

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b) => { stdout += b.toString() })
    child.stderr.on('data', (b) => { stderr += b.toString() })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describeIfReady('layout-drawio-cli — happy + error paths via child_process', () => {
  // Seed a real catalyst-produced drawio so the CLI's layoutDrawio call
  // doesn't hit the no-objects early-return path. The CLI is then exercised
  // through its full code path (argv parse, fs IO, ELK layout, write).
  let seedDrawio
  beforeAll(async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'layout-cli-seed-'))
    const target = path.join(dir, 'seed.drawio')
    await convertFile(SAMPLE_PUML, target, {})
    seedDrawio = await fsp.readFile(target, 'utf-8')
    await fsp.rm(dir, { recursive: true, force: true })
  })

  test('explicit --direction=RIGHT is honoured and reported on stderr', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'layout-cli-'))
    try {
      const input = path.join(dir, 'in.drawio')
      const output = path.join(dir, 'out.drawio')
      await fsp.writeFile(input, seedDrawio)

      const { code, stderr } = await runCli([input, '-o', output, '--direction=RIGHT'])
      expect(code).toBe(0)
      expect(stderr).toContain('direction=RIGHT')
      expect(stderr).not.toContain(', auto')

      const xml = await fsp.readFile(output, 'utf-8')
      expect(xml).toContain('<mxGraphModel')
      expect(xml).toContain('User')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('AUTO direction is reported with `, auto` suffix on stderr', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'layout-cli-auto-'))
    try {
      const input = path.join(dir, 'in.drawio')
      const output = path.join(dir, 'out.drawio')
      await fsp.writeFile(input, seedDrawio)

      const { code, stderr } = await runCli([input, '-o', output])
      expect(code).toBe(0)
      expect(stderr).toMatch(/direction=(DOWN|RIGHT), auto/)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('overwrites input in place when -o is omitted', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'layout-cli-inplace-'))
    try {
      const input = path.join(dir, 'in.drawio')
      await fsp.writeFile(input, seedDrawio)

      const { code } = await runCli([input])
      expect(code).toBe(0)
      const xml = await fsp.readFile(input, 'utf-8')
      expect(xml).toContain('<mxGraphModel')
      // Layout rewrites <mxGeometry> x/y on every mxCell; the size or content
      // of the in-place file will differ from the seeded contents.
      expect(xml).not.toBe(seedDrawio)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('exits 1 when input file does not exist', async () => {
    const missing = path.join(os.tmpdir(), `layout-cli-missing-${Date.now()}.drawio`)
    const { code, stderr } = await runCli([missing])
    expect(code).toBe(1)
    expect(stderr).toContain('layout-drawio:')
  })

  test('exits 1 when --direction is an unknown choice (yargs strict)', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'layout-cli-baddir-'))
    try {
      const input = path.join(dir, 'in.drawio')
      await fsp.writeFile(input, seedDrawio)
      const { code, stderr } = await runCli([input, '--direction=SIDEWAYS'])
      expect(code).toBe(1)
      expect(stderr).toMatch(/Invalid values|Choices/)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })
})
