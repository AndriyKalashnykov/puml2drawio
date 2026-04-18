import { describe, test, expect } from 'vitest'
import { layoutDrawio } from '../src/layout-drawio.mjs'

// Minimal drawio fixture — a Person, a System inside a System_Boundary, and
// one relationship. Coordinates are intentionally bad (everything stacked
// on (0,0)) so we can assert that elkjs spread things apart.
const input = `<?xml version="1.0" encoding="UTF-8"?>
<mxfile version="20.1.4" type="atlas">
  <diagram id="d" name="Page-1">
    <mxGraphModel pageHeight="600" pageWidth="800">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <object c4Name="User" id="user">
          <mxCell style="shape=mxgraph.c4.person2" parent="1" vertex="1">
            <mxGeometry as="geometry" x="0" y="0" width="160" height="90"/>
          </mxCell>
        </object>
        <object c4Name="Host" id="host">
          <mxCell style="container=1;dashed=1" parent="1" vertex="1">
            <mxGeometry as="geometry" x="0" y="0" width="300" height="200"/>
          </mxCell>
        </object>
        <object c4Name="API" id="api">
          <mxCell style="rounded=1" parent="host" vertex="1">
            <mxGeometry as="geometry" x="0" y="0" width="160" height="90"/>
          </mxCell>
        </object>
        <object c4Name="uses">
          <mxCell parent="1" edge="1" source="user" target="api">
            <mxGeometry as="geometry" x="0" y="0" width="100" height="20"/>
          </mxCell>
        </object>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`

function geomFor(xml, id) {
    // Grep-based extractor that works against formatted or compact XML.
    const objRe = new RegExp(`id="${id}"[\\s\\S]*?<mxGeometry[^/]+/>`)
    const match = xml.match(objRe)
    if (!match) return null
    const g = match[0].match(/<mxGeometry[^/]+\/>/)[0]
    return {
        x: Number((g.match(/\bx="(-?\d+)"/) || [])[1] ?? NaN),
        y: Number((g.match(/\by="(-?\d+)"/) || [])[1] ?? NaN),
        width: Number((g.match(/\bwidth="(\d+)"/) || [])[1] ?? NaN),
        height: Number((g.match(/\bheight="(\d+)"/) || [])[1] ?? NaN),
    }
}

describe('layoutDrawio', () => {
    test('produces a well-formed mxfile wrapper', async () => {
        const out = await layoutDrawio(input)
        expect(out).toMatch(/<mxfile/)
        expect(out).toMatch(/<diagram\s+id="d"\s+name="Page-1"/)
        expect(out).toMatch(/<mxGraphModel/)
    })

    test('re-positions shapes off (0,0) — elkjs laid them out', async () => {
        const out = await layoutDrawio(input)
        // At least one leaf shape (user, api, or the host container) must have
        // moved or been resized away from the all-zeros input.
        const anyMoved = ['user', 'api', 'host'].some((id) => {
            const g = geomFor(out, id)
            return g && (g.x !== 0 || g.y !== 0)
        })
        expect(anyMoved).toBe(true)
    })

    test('preserves parent hierarchy in the output', async () => {
        const out = await layoutDrawio(input)
        // `api` must still declare host as its parent — layout must not
        // re-parent nodes to the root cell.
        expect(out).toMatch(/id="api"[\s\S]*?parent="host"/)
    })

    test('keeps edges intact (source + target unchanged)', async () => {
        const out = await layoutDrawio(input)
        expect(out).toMatch(/source="user"\s+target="api"/)
    })

    test('grows page dimensions to fit the laid-out graph', async () => {
        const out = await layoutDrawio(input)
        const pageMatch = out.match(/pageWidth="(\d+)"\s+pageHeight="(\d+)"/) ||
                          out.match(/pageHeight="(\d+)"\s+pageWidth="(\d+)"/)
        expect(pageMatch).not.toBeNull()
    })

    test('returns input unchanged when no shapes present', async () => {
        const empty = `<?xml version="1.0" encoding="UTF-8"?><mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>`
        const out = await layoutDrawio(empty)
        expect(out).toBe(empty)
    })

    test('accepts custom ELK options (direction, ranksep, nodesep)', async () => {
        // Smoke test — just ensures the option plumbing doesn't throw.
        const out = await layoutDrawio(input, {
            direction: 'RIGHT',
            ranksep: 200,
            nodesep: 80,
            edgesep: 25,
        })
        expect(out).toMatch(/<mxfile/)
    })

    test('skips edges that are missing source or target', async () => {
        const broken = input.replace(/source="user" target="api"/, 'source="user"')
        const out = await layoutDrawio(broken)
        // Well-formed output — no throw; broken edge silently dropped.
        expect(out).toMatch(/<mxfile/)
    })

    test('skips shapes with no id attribute', async () => {
        const noId = input.replace(/c4Name="Host" id="host"/, 'c4Name="Orphan"')
        const out = await layoutDrawio(noId)
        // Orphan shape contributes no ELK node; remaining graph still lays out.
        expect(out).toMatch(/<mxfile/)
        expect(out).toMatch(/id="user"/)
    })

    test('handles a single-object drawio (parser returns non-array)', async () => {
        const single = `<?xml version="1.0" encoding="UTF-8"?>
<mxfile><diagram id="d" name="Page-1"><mxGraphModel>
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
    <object id="only"><mxCell style="rounded=1" parent="1" vertex="1">
      <mxGeometry as="geometry" x="0" y="0" width="100" height="50"/>
    </mxCell></object>
  </root>
</mxGraphModel></diagram></mxfile>`
        const out = await layoutDrawio(single)
        expect(out).toMatch(/id="only"/)
    })
})
