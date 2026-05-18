import { describe, test, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import url from 'node:url'
import { XMLParser } from 'fast-xml-parser'
import { convertFile } from '../src/convert.mjs'
import { layoutDrawio } from '../src/layout-drawio.mjs'

// Visual-correctness gate for the wrapper's elkjs re-layout post-processor
// (src/layout-drawio.mjs). catalyst v1.3.0 already runs its OWN
// tests/layout-quality.test.mts against its LayoutEngine output — but the
// wrapper RE-LAYS-OUT every <mxGeometry> independently, and that re-layout
// has no quality gate. parity.integration.test.mjs is structural and
// coordinate-blind BY DESIGN (it asserts shapes/edges survive, never
// positions), so it provably cannot catch the class of bug where the
// re-layout under-sizes or overlaps leaf shapes. This closes that gap:
//   1. the re-layout never shrinks a leaf below the size catalyst
//      emitted for it (catalyst v1.7.0 / ADR 0010 / ADR 0011 replaced
//      the old fixed per-type `C4_MIN` floor with content-fit measured
//      sizing — `PUML_LEAF_BOX`; the invariant is now "never smaller
//      than catalyst's content-fit box", not "≥ a fixed minimum"), AND
//   2. no two leaf shapes overlap (absolute coords — parent offsets
//      accumulated, since the wrapper keeps drawio parent-relative
//      geometry for nested children).
//
// Comparing the re-laid size against catalyst's OWN emitted size (rather
// than a hardcoded table) tracks catalyst's current content-fit contract
// version-independently — there is no fixed minimum to copy any more.

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const CATALYST_DIST = path.resolve(__dirname, '..', 'vendor', 'catalyst', 'dist', 'catalyst.mjs')
const SAMPLE_DIR = path.resolve(__dirname, '..', 'sample')
const FIXTURES = ['c4-context.puml', 'c4-container.puml', 'example.puml']

const vendorReady = fs.existsSync(CATALYST_DIST)
const describeIfReady = vendorReady ? describe : describe.skip

function asArray(v) {
  return Array.isArray(v) ? v : v ? [v] : []
}

// Parse a drawio document into a flat shape list with absolute coords.
// Each <object> wraps an <mxCell> (style + parent) with an <mxGeometry>.
// Boundaries/containers carry `container=1` in the style; leaves do not.
function shapesOf(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
  const doc = parser.parse(xml)
  const root = doc?.mxfile?.diagram?.mxGraphModel?.root
  const objects = asArray(root?.object)

  const byId = new Map()
  for (const o of objects) {
    const cell = o.mxCell
    if (!cell || cell['@_vertex'] !== '1') continue
    const g = cell.mxGeometry
    if (!g) continue
    byId.set(o['@_id'], {
      id: o['@_id'],
      type: o['@_c4Type'] ?? '',
      parent: cell['@_parent'],
      isLeaf: !String(cell['@_style'] ?? '').includes('container=1'),
      x: Number(g['@_x'] ?? 0),
      y: Number(g['@_y'] ?? 0),
      width: Number(g['@_width'] ?? 0),
      height: Number(g['@_height'] ?? 0)
    })
  }

  // Accumulate parent offsets → absolute coords (drawio child geometry is
  // relative to its container parent; "1"/"0" are the model roots).
  const absOf = (s, seen = new Set()) => {
    if (!s || seen.has(s.id)) return { x: s?.x ?? 0, y: s?.y ?? 0 }
    seen.add(s.id)
    const p = byId.get(s.parent)
    if (!p) return { x: s.x, y: s.y }
    const pa = absOf(p, seen)
    return { x: s.x + pa.x, y: s.y + pa.y }
  }

  return [...byId.values()].map((s) => {
    const { x, y } = absOf(s)
    return { ...s, x, y }
  })
}

const overlaps = (a, b) =>
  a.x < b.x + b.width && a.x + a.width > b.x &&
  a.y < b.y + b.height && a.y + a.height > b.y

describeIfReady('layout quality — wrapper re-layout output (no overlap / no shrink vs catalyst)', () => {
  const laidByFixture = new Map()
  const catalystByFixture = new Map()

  beforeAll(async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'layout-quality-'))
    try {
      for (const name of FIXTURES) {
        const target = path.join(tmp, name.replace('.puml', '.drawio'))
        // Seed from REAL catalyst output, capture its emitted sizes, then
        // run the wrapper's re-layout and compare against THEM.
        await convertFile(path.join(SAMPLE_DIR, name), target, {})
        const catalystXml = await fsp.readFile(target, 'utf-8')
        catalystByFixture.set(name, catalystXml)
        const { xml } = await layoutDrawio(catalystXml)
        laidByFixture.set(name, xml)
      }
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true })
    }
  })

  // catalyst guarantees every leaf is ≥ its content-fit box (ADR 0010);
  // the wrapper's re-layout must not undo that. 1px slack absorbs integer
  // rounding in the elkjs re-layout.
  test.each(FIXTURES)('%s: re-layout never shrinks a leaf below catalyst\'s emitted size', (name) => {
    const before = new Map(
      shapesOf(catalystByFixture.get(name)).filter((s) => s.isLeaf).map((s) => [s.id, s]))
    const after = shapesOf(laidByFixture.get(name)).filter((s) => s.isLeaf)
    expect(after.length, `${name}: no leaf shapes parsed`).toBeGreaterThan(0)
    const shrunk = after
      .filter((s) => {
        const b = before.get(s.id)
        return b && (s.width < b.width - 1 || s.height < b.height - 1)
      })
      .map((s) => {
        const b = before.get(s.id)
        return `${s.id}(${s.type}) ${s.width}x${s.height} < catalyst ${b.width}x${b.height}`
      })
    expect(shrunk, `${name}: re-layout shrank leaves below catalyst's content-fit size (would cram on render)`).toEqual([])
  })

  test.each(FIXTURES)('%s: no two leaf shapes overlap', (name) => {
    const leaves = shapesOf(laidByFixture.get(name)).filter((s) => s.isLeaf)
    const hits = []
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        if (overlaps(leaves[i], leaves[j])) hits.push(`${leaves[i].id}~${leaves[j].id}`)
      }
    }
    expect(hits, `${name}: overlapping leaf shapes after re-layout`).toEqual([])
  })
})
