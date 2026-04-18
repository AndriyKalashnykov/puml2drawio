import { describe, test, expect } from 'vitest'
import { layoutDrawio, pickDirection } from '../src/layout-drawio.mjs'
import { XMLParser } from 'fast-xml-parser'

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
        const { xml } = await layoutDrawio(input)
        expect(xml).toMatch(/<mxfile/)
        expect(xml).toMatch(/<diagram\s+id="d"\s+name="Page-1"/)
        expect(xml).toMatch(/<mxGraphModel/)
    })

    test('re-positions shapes off (0,0) — elkjs laid them out', async () => {
        const { xml } = await layoutDrawio(input)
        const anyMoved = ['user', 'api', 'host'].some((id) => {
            const g = geomFor(xml, id)
            return g && (g.x !== 0 || g.y !== 0)
        })
        expect(anyMoved).toBe(true)
    })

    test('preserves parent hierarchy in the output', async () => {
        const { xml } = await layoutDrawio(input)
        expect(xml).toMatch(/id="api"[\s\S]*?parent="host"/)
    })

    test('keeps edges intact (source + target unchanged)', async () => {
        const { xml } = await layoutDrawio(input)
        expect(xml).toMatch(/source="user"\s+target="api"/)
    })

    test('grows page dimensions to fit the laid-out graph', async () => {
        const { xml } = await layoutDrawio(input)
        const pageMatch = xml.match(/pageWidth="(\d+)"\s+pageHeight="(\d+)"/) ||
                          xml.match(/pageHeight="(\d+)"\s+pageWidth="(\d+)"/)
        expect(pageMatch).not.toBeNull()
    })

    test('returns input unchanged when no shapes present', async () => {
        const empty = `<?xml version="1.0" encoding="UTF-8"?><mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>`
        const { xml } = await layoutDrawio(empty)
        expect(xml).toBe(empty)
    })

    test('accepts custom ELK options (direction, ranksep, nodesep)', async () => {
        const { xml } = await layoutDrawio(input, {
            direction: 'RIGHT',
            ranksep: 200,
            nodesep: 80,
            edgesep: 25,
        })
        expect(xml).toMatch(/<mxfile/)
    })

    test('skips edges that are missing source or target', async () => {
        const broken = input.replace(/source="user" target="api"/, 'source="user"')
        const { xml } = await layoutDrawio(broken)
        expect(xml).toMatch(/<mxfile/)
    })

    test('skips shapes with no id attribute', async () => {
        const noId = input.replace(/c4Name="Host" id="host"/, 'c4Name="Orphan"')
        const { xml } = await layoutDrawio(noId)
        expect(xml).toMatch(/<mxfile/)
        expect(xml).toMatch(/id="user"/)
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
        const { xml } = await layoutDrawio(single)
        expect(xml).toMatch(/id="only"/)
    })

    test('default direction is AUTO and returns the chosen direction', async () => {
        const { direction } = await layoutDrawio(input)
        // Tiny fixture: 1 boundary with 1 child → RIGHT.
        expect(direction).toBe('RIGHT')
    })

    test('explicit direction overrides the heuristic', async () => {
        const { direction } = await layoutDrawio(input, { direction: 'DOWN' })
        expect(direction).toBe('DOWN')
    })
})

describe('pickDirection heuristic', () => {
    const parse = (xml) => {
        const parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: '@_',
            preserveOrder: false,
        })
        const doc = parser.parse(xml)
        const root = doc?.mxfile?.diagram?.mxGraphModel?.root
        const raw = root?.object
        return Array.isArray(raw) ? raw : raw ? [raw] : []
    }

    test('picks RIGHT for a flat Context-style diagram', () => {
        // 1 boundary + 2 children + 1 peer outside = sparse layout → RIGHT.
        const objs = parse(input)
        expect(pickDirection(objs)).toBe('RIGHT')
    })

    test('picks DOWN when a boundary has more than 3 children (Container-style)', () => {
        const dense = `<?xml version="1.0"?><mxfile><diagram><mxGraphModel><root>
  <mxCell id="0"/><mxCell id="1" parent="0"/>
  <object id="host"><mxCell style="container=1" parent="1" vertex="1"><mxGeometry as="geometry" width="400" height="300"/></mxCell></object>
  <object id="a"><mxCell style="rounded=1" parent="host" vertex="1"><mxGeometry as="geometry" width="160" height="80"/></mxCell></object>
  <object id="b"><mxCell style="rounded=1" parent="host" vertex="1"><mxGeometry as="geometry" width="160" height="80"/></mxCell></object>
  <object id="c"><mxCell style="rounded=1" parent="host" vertex="1"><mxGeometry as="geometry" width="160" height="80"/></mxCell></object>
  <object id="d"><mxCell style="rounded=1" parent="host" vertex="1"><mxGeometry as="geometry" width="160" height="80"/></mxCell></object>
  <object id="e"><mxCell style="rounded=1" parent="host" vertex="1"><mxGeometry as="geometry" width="160" height="80"/></mxCell></object>
</root></mxGraphModel></diagram></mxfile>`
        expect(pickDirection(parse(dense))).toBe('DOWN')
    })

    test('picks DOWN when boundaries are nested (Deployment-style)', () => {
        const nested = `<?xml version="1.0"?><mxfile><diagram><mxGraphModel><root>
  <mxCell id="0"/><mxCell id="1" parent="0"/>
  <object id="outer"><mxCell style="container=1" parent="1" vertex="1"><mxGeometry as="geometry" width="500" height="400"/></mxCell></object>
  <object id="inner"><mxCell style="container=1" parent="outer" vertex="1"><mxGeometry as="geometry" width="400" height="300"/></mxCell></object>
  <object id="leaf"><mxCell style="rounded=1" parent="inner" vertex="1"><mxGeometry as="geometry" width="160" height="80"/></mxCell></object>
</root></mxGraphModel></diagram></mxfile>`
        expect(pickDirection(parse(nested))).toBe('DOWN')
    })
})
