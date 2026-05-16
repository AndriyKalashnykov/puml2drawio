import { describe, test, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'
import { convertString } from '../src/convert.mjs'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const CATALYST_DIST = path.resolve(__dirname, '..', 'vendor', 'catalyst', 'dist', 'catalyst.mjs')
const SAMPLE_PUML = path.resolve(__dirname, '..', 'sample', 'example.puml')

const vendorReady = fs.existsSync(CATALYST_DIST)
const d = vendorReady ? describe : describe.skip

// sample/example.puml is Person + System + Container — exercises three
// distinct C4 roles end-to-end through real catalyst + the dark remap.
d('theme integration — C4_superhero dark remap over real catalyst output', () => {
  let puml
  beforeAll(async () => {
    puml = await fsp.readFile(SAMPLE_PUML, 'utf-8')
  })

  test('default (light) is catalyst output, unchanged', async () => {
    const light = await convertString(puml, { theme: 'light' })
    expect(light).toContain('#08427B') // catalyst Person fill survives
    expect(light).not.toContain('background="#000000"')
  })

  test('dark: every catalyst light fill is gone, C4_superhero darks present', async () => {
    const dark = await convertString(puml, { theme: 'dark' })
    // catalyst C4_blue fills for the three sample roles must be remapped away
    for (const lightHex of ['#08427B', '#1061B0', '#23A2D9']) {
      expect(dark).not.toContain(lightHex)
    }
    // C4_superhero dark fills present (Person / System / Container)
    expect(dark).toContain('#5BC0DE')
    expect(dark).toContain('#4E5D6C')
    expect(dark).toContain('#F0AD4E')
    // canvas background set to black
    expect(dark).toMatch(/<mxGraphModel\b[^>]*background="#000000"/)
  })

  test('dark output is still well-formed drawio', async () => {
    const dark = await convertString(puml, { theme: 'dark' })
    expect(dark).toContain('<mxGraphModel')
    expect(dark).toContain('<mxCell')
    expect(dark).toContain('</mxfile>')
  })
})
