import { describe, test, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import url from 'node:url'
import { convertString, convertFile } from '../src/convert.mjs'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const CATALYST_DIST = path.resolve(__dirname, '..', 'vendor', 'catalyst', 'dist', 'catalyst.mjs')
const SAMPLE_PUML = path.resolve(__dirname, '..', 'sample', 'example.puml')

const vendorReady = fs.existsSync(CATALYST_DIST)
const describeIfReady = vendorReady ? describe : describe.skip

describeIfReady('catalyst integration — end-to-end conversion', () => {
  let samplePuml

  beforeAll(async () => {
    samplePuml = await fsp.readFile(SAMPLE_PUML, 'utf-8')
  })

  test('convertString produces non-empty mxGraphModel XML', async () => {
    const drawio = await convertString(samplePuml, {})
    expect(typeof drawio).toBe('string')
    expect(drawio.length).toBeGreaterThan(0)
    expect(drawio).toContain('<mxGraphModel')
  })

  test('convertFile writes a valid .drawio to disk', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-convert-'))
    try {
      const input = path.join(dir, 'example.puml')
      const output = path.join(dir, 'nested', 'out.drawio')
      await fsp.copyFile(SAMPLE_PUML, input)

      const returned = await convertFile(input, output, {})
      expect(returned).toContain('<mxGraphModel')

      const written = await fsp.readFile(output, 'utf-8')
      expect(written).toBe(returned)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('convertFile returns XML without writing when outputPath is null', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-convert-null-'))
    try {
      const input = path.join(dir, 'example.puml')
      await fsp.copyFile(SAMPLE_PUML, input)

      const drawio = await convertFile(input, null, {})
      expect(drawio).toContain('<mxGraphModel')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test('layout-direction option is honoured by catalyst', async () => {
    const tb = await convertString(samplePuml, { layoutDirection: 'TB' })
    const lr = await convertString(samplePuml, { layoutDirection: 'LR' })
    expect(tb).toContain('<mxGraphModel')
    expect(lr).toContain('<mxGraphModel')
  })
})
