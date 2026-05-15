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

  test('batch accumulates errors and exits 1 when a write fails (no --fail-fast)', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-batch-err-'))
    try {
      const inputDir = path.join(dir, 'in')
      const outputDir = path.join(dir, 'out')
      await fsp.mkdir(inputDir, { recursive: true })
      await fsp.copyFile(SAMPLE_PUML, path.join(inputDir, 'a.puml'))
      await fsp.copyFile(SAMPLE_PUML, path.join(inputDir, 'b.puml'))
      await fsp.copyFile(SAMPLE_PUML, path.join(inputDir, 'c.puml'))
      // Pre-create b.drawio as a DIRECTORY at the output target — writeFile
      // will fail with EISDIR, deterministically without touching file modes.
      await fsp.mkdir(path.join(outputDir, 'b.drawio'), { recursive: true })

      const { code, stderr } = await run([inputDir, '-o', outputDir, '--quiet'])
      expect(code).toBe(1)
      expect(stderr).toContain('failed:')
      expect(stderr).toContain('b.puml')
      // a and c still converted despite b failing.
      expect(await fsp.readFile(path.join(outputDir, 'a.drawio'), 'utf-8')).toContain('<mxGraphModel')
      expect(await fsp.readFile(path.join(outputDir, 'c.drawio'), 'utf-8')).toContain('<mxGraphModel')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('--fail-fast stops batch on first error (no later files attempted)', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-batch-ff-'))
    try {
      const inputDir = path.join(dir, 'in')
      const outputDir = path.join(dir, 'out')
      await fsp.mkdir(inputDir, { recursive: true })
      // Files are processed in sorted order — `a.puml` fails first, `b.puml`
      // and `c.puml` must NOT be attempted under --fail-fast.
      await fsp.copyFile(SAMPLE_PUML, path.join(inputDir, 'a.puml'))
      await fsp.copyFile(SAMPLE_PUML, path.join(inputDir, 'b.puml'))
      await fsp.copyFile(SAMPLE_PUML, path.join(inputDir, 'c.puml'))
      await fsp.mkdir(path.join(outputDir, 'a.drawio'), { recursive: true })

      const { code, stderr } = await run([inputDir, '-o', outputDir, '--quiet', '--fail-fast'])
      expect(code).toBe(1)
      expect(stderr).toContain('failed:')
      expect(stderr).toContain('a.puml')
      // b.drawio and c.drawio must not have been written.
      await expect(fsp.access(path.join(outputDir, 'b.drawio'))).rejects.toThrow()
      await expect(fsp.access(path.join(outputDir, 'c.drawio'))).rejects.toThrow()
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
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

  test('stdin -> nested -o path creates missing parent directories', async () => {
    // runStdin's `fs.mkdir(path.dirname(output), { recursive: true })` +
    // writeFile branch — covered for batch (deeply-nested tree) and single
    // file, but never for stdin mode with a nested -o target.
    const samplePuml = await fsp.readFile(SAMPLE_PUML, 'utf-8')
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-stdin-nested-'))
    try {
      const output = path.join(dir, 'a', 'b', 'c', 'out.drawio')
      const { code, stdout, stderr } = await run(['-', '-o', output], { stdinChunks: samplePuml })
      expect(code).toBe(0)
      expect(stdout).toBe('') // written to file, not stdout
      expect(stderr).toBe('')
      expect(await fsp.readFile(output, 'utf-8')).toContain('<mxGraphModel')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('non-quiet batch interleaves converted: and failed: on stderr', async () => {
    // The `batch accumulates errors` test runs --quiet, so the non-quiet
    // stderr interleave (converted: a/c alongside failed: b) is otherwise
    // unasserted.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-batch-verbose-'))
    try {
      const inputDir = path.join(dir, 'in')
      const outputDir = path.join(dir, 'out')
      await fsp.mkdir(inputDir, { recursive: true })
      await fsp.copyFile(SAMPLE_PUML, path.join(inputDir, 'a.puml'))
      await fsp.copyFile(SAMPLE_PUML, path.join(inputDir, 'b.puml'))
      await fsp.copyFile(SAMPLE_PUML, path.join(inputDir, 'c.puml'))
      // Force b to fail deterministically (EISDIR), same idiom as the
      // --quiet sibling test.
      await fsp.mkdir(path.join(outputDir, 'b.drawio'), { recursive: true })

      const { code, stderr } = await run([inputDir, '-o', outputDir])
      expect(code).toBe(1)
      expect(stderr).toContain('converted:')
      expect(stderr).toContain('a.puml')
      expect(stderr).toContain('c.puml')
      expect(stderr).toContain('failed:')
      expect(stderr).toContain('b.puml')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('glob input expands and converts, preserving the static-prefix tree', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-glob-'))
    try {
      const inputDir = path.join(dir, 'in')
      const outputDir = path.join(dir, 'out')
      await fsp.mkdir(path.join(inputDir, 'nested'), { recursive: true })
      await fsp.copyFile(SAMPLE_PUML, path.join(inputDir, 'a.puml'))
      await fsp.copyFile(SAMPLE_PUML, path.join(inputDir, 'nested', 'b.puml'))
      await fsp.writeFile(path.join(inputDir, 'skip.txt'), 'not puml')

      const { code, stderr } = await run([`${inputDir}/**/*.puml`, '-o', outputDir])
      expect(code).toBe(0)
      // baseDir = static prefix (inputDir) → tree preserved under outputDir.
      expect(await fsp.readFile(path.join(outputDir, 'a.drawio'), 'utf-8')).toContain('<mxGraphModel')
      expect(await fsp.readFile(path.join(outputDir, 'nested', 'b.drawio'), 'utf-8')).toContain('<mxGraphModel')
      expect(stderr).toContain('converted:')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('glob input requires --output (exit 2)', async () => {
    const { code, stderr } = await run(['sample/*.puml'])
    expect(code).toBe(2)
    expect(stderr).toContain('--output is required when input is a glob pattern')
  })

  test('glob matching no .puml fails with a descriptive error (exit 1)', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-glob-empty-'))
    try {
      const { code, stderr } = await run([`${dir}/*.puml`, '-o', path.join(dir, 'out')])
      expect(code).toBe(1)
      expect(stderr).toContain('No .puml files matched glob')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('--output-ext applies in single-file mode when -o is a directory', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-ext-single-'))
    try {
      const input = path.join(dir, 'diagram.puml')
      const outDir = path.join(dir, 'out')
      await fsp.mkdir(outDir, { recursive: true })
      await fsp.copyFile(SAMPLE_PUML, input)

      const { code } = await run([input, '-o', outDir, '--output-ext', '.xml'])
      expect(code).toBe(0)
      // Derived <stem><ext> inside the directory, batch-consistent.
      expect(await fsp.readFile(path.join(outDir, 'diagram.xml'), 'utf-8')).toContain('<mxGraphModel')
      expect(await fsp.readdir(outDir)).toEqual(['diagram.xml'])
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('--output-ext is ignored when single-file -o is an explicit file path', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-ext-file-'))
    try {
      const input = path.join(dir, 'in.puml')
      const out = path.join(dir, 'explicit.drawio')
      await fsp.copyFile(SAMPLE_PUML, input)

      const { code } = await run([input, '-o', out, '--output-ext', '.xml'])
      expect(code).toBe(0)
      // Explicit file path wins; --output-ext does not rewrite it.
      expect(await fsp.readFile(out, 'utf-8')).toContain('<mxGraphModel')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('--summary emits a JSON report to stdout in batch mode', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-sum-batch-'))
    try {
      const inputDir = path.join(dir, 'in')
      const outputDir = path.join(dir, 'out')
      await fsp.mkdir(inputDir, { recursive: true })
      await fsp.copyFile(SAMPLE_PUML, path.join(inputDir, 'a.puml'))
      await fsp.copyFile(SAMPLE_PUML, path.join(inputDir, 'b.puml'))

      const { code, stdout } = await run([inputDir, '-o', outputDir, '--summary', '--quiet'])
      expect(code).toBe(0)
      const summary = JSON.parse(stdout.trim())
      expect(summary.total).toBe(2)
      expect(summary.converted).toBe(2)
      expect(summary.failed).toBe(0)
      expect(summary.files.map((f) => f.status)).toEqual(['converted', 'converted'])
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('--summary records failures and still emits JSON before non-zero exit', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-sum-fail-'))
    try {
      const inputDir = path.join(dir, 'in')
      const outputDir = path.join(dir, 'out')
      await fsp.mkdir(inputDir, { recursive: true })
      await fsp.copyFile(SAMPLE_PUML, path.join(inputDir, 'a.puml'))
      await fsp.copyFile(SAMPLE_PUML, path.join(inputDir, 'b.puml'))
      await fsp.mkdir(path.join(outputDir, 'b.drawio'), { recursive: true }) // EISDIR on b

      const { code, stdout } = await run([inputDir, '-o', outputDir, '--summary', '--quiet'])
      expect(code).toBe(1)
      const summary = JSON.parse(stdout.trim())
      expect(summary.total).toBe(2)
      expect(summary.converted).toBe(1)
      expect(summary.failed).toBe(1)
      const failed = summary.files.find((f) => f.status === 'failed')
      expect(failed.input).toContain('b.puml')
      expect(typeof failed.error).toBe('string')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('--summary in single/stdin mode goes to stderr, drawio stays on stdout', async () => {
    const samplePuml = await fsp.readFile(SAMPLE_PUML, 'utf-8')
    const { code, stdout, stderr } = await run(['-', '--summary'], { stdinChunks: samplePuml })
    expect(code).toBe(0)
    expect(stdout).toContain('<mxGraphModel') // drawio uncorrupted on stdout
    const summary = JSON.parse(stderr.trim())
    expect(summary.total).toBe(1)
    expect(summary.converted).toBe(1)
    expect(summary.files[0].input).toBe('-')
  })

  test('leading-magic glob (no static prefix) → globBaseDir "." anchors output at cwd', async () => {
    // `*.puml` has a metachar in its FIRST segment → globBaseDir returns '.',
    // so deriveOutputPath roots the tree at the process cwd. Exercise that
    // branch by chdir-ing into a tmp dir and using a cwd-relative glob.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-globdot-'))
    const cwd0 = process.cwd()
    try {
      await fsp.copyFile(SAMPLE_PUML, path.join(dir, 'top.puml'))
      process.chdir(dir)
      const { code } = await run(['*.puml', '-o', 'out'])
      expect(code).toBe(0)
      // baseDir='.' → rel path 'top.puml' → out/top.drawio
      expect(await fsp.readFile(path.join(dir, 'out', 'top.drawio'), 'utf-8')).toContain('<mxGraphModel')
    } finally {
      process.chdir(cwd0)
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('single-file -o to a nonexistent nested path writes verbatim (isDirectory catch branch, no ext rewrite)', async () => {
    // isDirectory(output) stat-throws on the not-yet-created path → false →
    // runSingle treats -o as a file path (no --output-ext derivation);
    // convertFile mkdirs the parents. Asserts the catch branch + verbatim.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-single-nested-'))
    try {
      const input = path.join(dir, 'in.puml')
      const out = path.join(dir, 'a', 'b', 'out.custom')
      await fsp.copyFile(SAMPLE_PUML, input)
      const { code } = await run([input, '-o', out, '--output-ext', '.xml'])
      expect(code).toBe(0)
      // Written at the verbatim nested path; --output-ext NOT applied.
      expect(await fsp.readFile(out, 'utf-8')).toContain('<mxGraphModel')
      await expect(fsp.access(path.join(dir, 'a', 'b', 'in.xml'))).rejects.toThrow()
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('glob yields entries but none are .puml → exit 1 (post-filter empty branch)', async () => {
    // Distinct from the no-match case: fs.glob DOES return files, but the
    // .puml filter empties the list → same descriptive error, different path.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-glob-nonpuml-'))
    try {
      await fsp.writeFile(path.join(dir, 'a.txt'), 'x')
      await fsp.writeFile(path.join(dir, 'b.md'), '# y')
      const { code, stderr } = await run([`${dir}/*.*`, '-o', path.join(dir, 'out')])
      expect(code).toBe(1)
      expect(stderr).toContain('No .puml files matched glob')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })
})
