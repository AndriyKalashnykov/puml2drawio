import { describe, test, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import url from 'node:url'
import { runCli } from '../src/runner.mjs'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const CATALYST_DIST = path.resolve(__dirname, '..', 'vendor', 'catalyst', 'dist', 'catalyst.mjs')
const SAMPLE_PUML = path.resolve(__dirname, '..', 'sample', 'example.puml')

const vendorReady = fs.existsSync(CATALYST_DIST)
const describeIfReady = vendorReady ? describe : describe.skip

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf-8')
}

// Safe test helper: sets up PassThrough stdio, wires collect() BEFORE runCli,
// ends the streams only AFTER runCli resolves. This prevents
// ERR_STREAM_WRITE_AFTER_END when runCli writes to stderr/stdout (e.g. on
// yargs parse errors or progress lines).
async function run(argv, { env = {}, stdinChunks = null } = {}) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const outP = collect(stdout)
  const errP = collect(stderr)
  if (stdinChunks != null) {
    stdin.end(stdinChunks)
  }
  const code = await runCli({ argv, env, stdin, stdout, stderr })
  stdout.end()
  stderr.end()
  return { code, stdout: await outP, stderr: await errP }
}

describeIfReady('runCli integration — full pipeline through catalyst', () => {
  test('stdin -> stdout converts to mxGraphModel', async () => {
    const samplePuml = await fsp.readFile(SAMPLE_PUML, 'utf-8')
    const { code, stdout, stderr } = await run(['-'], { stdinChunks: samplePuml })
    expect(code).toBe(0)
    expect(stdout).toContain('<mxGraphModel')
    expect(stderr).toBe('')
  })

  test('single file -> stdout (no -o)', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-run-'))
    try {
      const input = path.join(dir, 'in.puml')
      await fsp.copyFile(SAMPLE_PUML, input)
      const { code, stdout } = await run([input])
      expect(code).toBe(0)
      expect(stdout).toContain('<mxGraphModel')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('single file -> file writes valid drawio', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-run-'))
    try {
      const input = path.join(dir, 'in.puml')
      const output = path.join(dir, 'out.drawio')
      await fsp.copyFile(SAMPLE_PUML, input)
      const { code } = await run([input, '-o', output])
      expect(code).toBe(0)
      expect(await fsp.readFile(output, 'utf-8')).toContain('<mxGraphModel')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('directory -> directory batch preserves tree', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-run-'))
    try {
      const inputDir = path.join(dir, 'in')
      const outputDir = path.join(dir, 'out')
      await fsp.mkdir(path.join(inputDir, 'nested'), { recursive: true })
      await fsp.copyFile(SAMPLE_PUML, path.join(inputDir, 'a.puml'))
      await fsp.copyFile(SAMPLE_PUML, path.join(inputDir, 'nested', 'b.puml'))

      const { code } = await run([inputDir, '-o', outputDir, '--quiet'])
      expect(code).toBe(0)
      expect(await fsp.readFile(path.join(outputDir, 'a.drawio'), 'utf-8')).toContain('<mxGraphModel')
      expect(await fsp.readFile(path.join(outputDir, 'nested', 'b.drawio'), 'utf-8')).toContain('<mxGraphModel')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('deeply nested directory (3+ levels) preserves tree', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-deep-'))
    try {
      const inputDir = path.join(dir, 'in')
      const outputDir = path.join(dir, 'out')
      const deep = path.join(inputDir, 'a', 'b', 'c')
      await fsp.mkdir(deep, { recursive: true })
      await fsp.copyFile(SAMPLE_PUML, path.join(inputDir, 'top.puml'))
      await fsp.copyFile(SAMPLE_PUML, path.join(deep, 'deep.puml'))

      const { code } = await run([inputDir, '-o', outputDir, '--quiet'])
      expect(code).toBe(0)
      expect(await fsp.readFile(path.join(outputDir, 'top.drawio'), 'utf-8')).toContain('<mxGraphModel')
      expect(await fsp.readFile(path.join(outputDir, 'a', 'b', 'c', 'deep.drawio'), 'utf-8')).toContain('<mxGraphModel')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('non-.puml files in input directory are ignored', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-mixed-'))
    try {
      const inputDir = path.join(dir, 'in')
      const outputDir = path.join(dir, 'out')
      await fsp.mkdir(inputDir, { recursive: true })
      await fsp.copyFile(SAMPLE_PUML, path.join(inputDir, 'real.puml'))
      await fsp.writeFile(path.join(inputDir, 'README.md'), '# notes')
      await fsp.writeFile(path.join(inputDir, 'config.json'), '{}')

      const { code } = await run([inputDir, '-o', outputDir, '--quiet'])
      expect(code).toBe(0)
      const outputs = await fsp.readdir(outputDir)
      expect(outputs).toEqual(['real.drawio'])
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('--output-ext changes batch output extension', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-ext-'))
    try {
      const inputDir = path.join(dir, 'in')
      const outputDir = path.join(dir, 'out')
      await fsp.mkdir(inputDir, { recursive: true })
      await fsp.copyFile(SAMPLE_PUML, path.join(inputDir, 'a.puml'))

      const { code } = await run([inputDir, '-o', outputDir, '--output-ext', '.xml', '--quiet'])
      expect(code).toBe(0)
      expect(await fsp.readdir(outputDir)).toEqual(['a.xml'])
      expect(await fsp.readFile(path.join(outputDir, 'a.xml'), 'utf-8')).toContain('<mxGraphModel')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('--quiet suppresses per-file progress on stderr', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-quiet-'))
    try {
      const inputDir = path.join(dir, 'in')
      const outputDir1 = path.join(dir, 'out1')
      const outputDir2 = path.join(dir, 'out2')
      await fsp.mkdir(inputDir, { recursive: true })
      await fsp.copyFile(SAMPLE_PUML, path.join(inputDir, 'a.puml'))
      await fsp.copyFile(SAMPLE_PUML, path.join(inputDir, 'b.puml'))

      const quiet = await run([inputDir, '-o', outputDir1, '--quiet'])
      expect(quiet.code).toBe(0)
      expect(quiet.stderr).toBe('')

      const verbose = await run([inputDir, '-o', outputDir2])
      expect(verbose.code).toBe(0)
      expect(verbose.stderr).toContain('converted:')
      expect(verbose.stderr).toContain('a.puml')
      expect(verbose.stderr).toContain('b.puml')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('multiple sequential single-file invocations (shell-loop pattern)', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-loop-'))
    try {
      const inputs = ['one.puml', 'two.puml', 'three.puml']
      for (const name of inputs) {
        await fsp.copyFile(SAMPLE_PUML, path.join(dir, name))
      }
      for (const name of inputs) {
        const input = path.join(dir, name)
        const output = path.join(dir, name.replace('.puml', '.drawio'))
        const { code } = await run([input, '-o', output])
        expect(code).toBe(0)
        expect(await fsp.readFile(output, 'utf-8')).toContain('<mxGraphModel')
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('exits 2 when directory input has no -o', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-run-'))
    try {
      await fsp.copyFile(SAMPLE_PUML, path.join(dir, 'a.puml'))
      const { code, stderr } = await run([dir])
      expect(code).toBe(2)
      expect(stderr).toContain('--output is required when input is a directory')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('exits 2 on invalid --layout-direction (yargs choices)', async () => {
    const { code } = await run(['in.puml', '--layout-direction=XYZ'])
    expect(code).toBe(2)
  })

  test('exits 1 when input file does not exist', async () => {
    const missing = path.join(os.tmpdir(), `puml2drawio-missing-${Date.now()}.puml`)
    const { code, stderr } = await run([missing])
    expect(code).toBe(1)
    expect(stderr).toContain('error:')
  })

  test('empty directory fails with descriptive error (exit 1)', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-empty-'))
    const outDir = path.join(dir, 'out')
    try {
      const { code, stderr } = await run([dir, '-o', outDir])
      expect(code).toBe(1)
      expect(stderr).toContain('No .puml files found')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })
})
