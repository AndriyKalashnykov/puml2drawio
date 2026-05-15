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
//   1. every leaf shape is >= the conventional C4 element-box minimum for
//      its type, AND
//   2. no two leaf shapes overlap (absolute coords — parent offsets
//      accumulated, since the wrapper keeps drawio parent-relative
//      geometry for nested children).
//
// C4_MIN is NOT invented: it is copied verbatim from catalyst's documented
// convention — vendor/catalyst/src/layout/measureNode.mts and
// vendor/catalyst/tests/layout-quality.test.mts — the per-type C4 element
// dimensions used by C4-PlantUML / Structurizr.

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const CATALYST_DIST = path.resolve(__dirname, '..', 'vendor', 'catalyst', 'dist', 'catalyst.mjs')
const SAMPLE_DIR = path.resolve(__dirname, '..', 'sample')
const FIXTURES = ['c4-context.puml', 'c4-container.puml', 'example.puml']

const vendorReady = fs.existsSync(CATALYST_DIST)
const describeIfReady = vendorReady ? describe : describe.skip

// Source: vendor/catalyst/src/layout/measureNode.mts (the documented C4
// element-box floor used by C4-PlantUML / Structurizr). Keep in sync if
// catalyst's convention ever changes.
const c4Min = (type) =>
  type.startsWith('System') || type.startsWith('Person') ? [220, 140]
    : type.startsWith('Container') ? [200, 120]
      : type.startsWith('Component') ? [180, 100]
        : [160, 90]

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

describeIfReady('layout quality — wrapper re-layout output (no overlap / >= C4 min)', () => {
  const laidByFixture = new Map()

  beforeAll(async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'layout-quality-'))
    try {
      for (const name of FIXTURES) {
        const target = path.join(tmp, name.replace('.puml', '.drawio'))
        // Seed from REAL catalyst output, then run the wrapper's re-layout.
        await convertFile(path.join(SAMPLE_DIR, name), target, {})
        const { xml } = await layoutDrawio(await fsp.readFile(target, 'utf-8'))
        laidByFixture.set(name, xml)
      }
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true })
    }
  })

  test.each(FIXTURES)('%s: every leaf shape is >= its C4 element minimum', (name) => {
    const leaves = shapesOf(laidByFixture.get(name)).filter((s) => s.isLeaf)
    expect(leaves.length, `${name}: no leaf shapes parsed`).toBeGreaterThan(0)
    const undersized = leaves
      .filter((s) => {
        const [mw, mh] = c4Min(s.type)
        return s.width < mw || s.height < mh
      })
      .map((s) => `${s.id}(${s.type}) ${s.width}x${s.height}`)
    expect(undersized, `${name}: leaves smaller than the C4 minimum (would cram on render)`).toEqual([])
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
