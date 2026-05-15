import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'
import { convertString } from '../src/convert.mjs'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const CATALYST_DIST = path.resolve(__dirname, '..', 'vendor', 'catalyst', 'dist', 'catalyst.mjs')
const FIXTURE = path.resolve(__dirname, 'fixtures', 'c4-parity-smoke.puml')

// Only meaningful once the pinned catalyst (CATALYST_REF) is vendored+built.
const describeIfReady = fs.existsSync(CATALYST_DIST) ? describe : describe.skip

/**
 * Guardrail: if the pinned CATALYST_REF regresses to a build that drops
 * Person/System_Ext/boundary shapes, orphans connectors, collapses parallel
 * relations, or omits <diagram id> (the exact defect that shipped into
 * ibm-wm-cert-management), this fails puml2drawio CI instead of silently
 * producing broken diagrams downstream.
 */
describeIfReady('catalyst pin — structural parity smoke', () => {
  // Inventory the fixture intentionally hardcodes (it is fixed content).
  const expectedAliases = ['dev', 'ext', 'sb', 'core', 'db', 'node', 'host']
  const expectedEdges = [
    'dev->core', 'dev->core', 'core->db', 'core->ext', 'core->core', 'core->host',
  ]

  test('every entity + every relation survives, no orphans, has diagram id', async () => {
    const puml = await fsp.readFile(FIXTURE, 'utf-8')
    const xml = await convertString(puml, {})

    const vertexIds = new Set()
    const edges = []
    const re = /<object\b([^>]*)>\s*<mxCell\b([^>]*?)(?:\/>|>)/g
    const attr = (s, n) => (new RegExp(`\\b${n}="([^"]*)"`).exec(s) ?? [])[1]
    let m
    while ((m = re.exec(xml)) !== null) {
      if (/\bvertex="1"/.test(m[2])) {
        const id = attr(m[1], 'id')
        if (id) vertexIds.add(id)
      } else if (/\bedge="1"/.test(m[2])) {
        edges.push(`${attr(m[2], 'source')}->${attr(m[2], 'target')}`)
      }
    }

    // 1. Every shape present.
    for (const a of expectedAliases) {
      expect(vertexIds.has(a), `shape "${a}" missing — catalyst pin regressed`).toBe(true)
    }
    // 2. Every relation present (parallel dev->core counted twice, self-loop kept).
    expect(edges.slice().sort()).toEqual(expectedEdges.slice().sort())
    // 3. No orphan connectors.
    for (const e of edges) {
      const [s, t] = e.split('->')
      expect(vertexIds.has(s) && vertexIds.has(t), `orphan connector ${e}`).toBe(true)
    }
    // 4. drawio-export-acceptable diagram header.
    expect(/<diagram\s+id="[^"]+"\s+name="[^"]+"/.test(xml)).toBe(true)
  })
})
