// Post-process a drawio file: re-run layout via elkjs and rewrite the
// <mxGeometry> coordinates of every shape. Standalone from the PUML→drawio
// path — works on any catalyst-produced (or hand-authored) drawio file.
//
// Why: dagre (inside catalyst) is a layered-graph algorithm and stretches
// diagrams vertically when many siblings share a common parent-edge source.
// ELK's layered algorithm handles these cases much better, and its
// hierarchical mode respects nested containers (C4 boundaries).
import { XMLParser, XMLBuilder } from 'fast-xml-parser'
import ELK from 'elkjs'

const elk = new ELK()

const PARSER = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    preserveOrder: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
})
const BUILDER = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    format: true,
    suppressEmptyNode: true,
})

// Wrap single vs array — fast-xml-parser collapses one-element arrays to
// a single object and we want to iterate uniformly.
function asArray(x) {
    if (x === undefined || x === null) return []
    return Array.isArray(x) ? x : [x]
}

// Extract the list of <object> shape descriptors from the parsed tree
// (which is the drawio-specific "c4" wrapper around <mxCell>).
function getObjects(doc) {
    const root = doc?.mxfile?.diagram?.mxGraphModel?.root
    return asArray(root?.object)
}

function getMxCell(obj) {
    return obj?.mxCell
}

function getGeometry(obj) {
    // `obj` is the outer <object> wrapper; the geometry lives inside its <mxCell>.
    return obj?.mxCell?.mxGeometry
}

function isEdge(obj) {
    return getMxCell(obj)?.['@_edge'] === '1'
}

function alias(obj) {
    return obj['@_id']
}

function parent(obj) {
    return getMxCell(obj)?.['@_parent']
}

function readGeom(obj) {
    const g = getGeometry(obj)
    if (!g) return { x: 0, y: 0, width: 160, height: 80 }
    return {
        x: Number(g['@_x'] ?? 0),
        y: Number(g['@_y'] ?? 0),
        width: Number(g['@_width'] ?? 160),
        height: Number(g['@_height'] ?? 80),
    }
}

function writeGeom(obj, { x, y, width, height }) {
    const g = getGeometry(obj)
    if (!g) return
    g['@_x'] = String(Math.round(x))
    g['@_y'] = String(Math.round(y))
    g['@_width'] = String(Math.round(width))
    g['@_height'] = String(Math.round(height))
}

// Build the ELK graph from our parsed drawio objects. Respects the parent
// hierarchy — every shape with parent=<alias> becomes a child of that
// ELK node. Shapes with parent="1" (or missing parent) become children
// of the ELK root.
function buildElkGraph(objects, elkOptions) {
    const nodesByAlias = new Map()
    const elkNodes = []
    const elkEdges = []
    let edgeCounter = 0

    // Pass 1: build ELK nodes for every shape.
    for (const obj of objects) {
        if (isEdge(obj)) continue
        const a = alias(obj)
        if (!a) continue
        const geom = readGeom(obj)
        const isContainer = (getMxCell(obj)?.['@_style'] ?? '').includes('container=1')
        const elkNode = {
            id: a,
            width: geom.width,
            height: geom.height,
            layoutOptions: isContainer
                ? {
                      'elk.algorithm': 'layered',
                      'elk.direction': 'DOWN',
                      'elk.padding': '[top=40,left=20,bottom=20,right=20]',
                  }
                : {},
            children: [],
        }
        nodesByAlias.set(a, { elkNode, parentAlias: parent(obj) })
    }

    // Pass 2: wire up the hierarchy. Nodes whose parent is "1" or missing
    // go to the ELK root; otherwise they slot into their parent's children.
    for (const { elkNode, parentAlias } of nodesByAlias.values()) {
        const p = parentAlias && parentAlias !== '1' ? nodesByAlias.get(parentAlias) : null
        if (p) {
            p.elkNode.children.push(elkNode)
        } else {
            elkNodes.push(elkNode)
        }
    }

    // Pass 3: edges. Edges attach to the ELK root regardless of whether
    // their endpoints are inside containers — ELK handles cross-container
    // routing automatically.
    for (const obj of objects) {
        if (!isEdge(obj)) continue
        const source = getMxCell(obj)?.['@_source']
        const target = getMxCell(obj)?.['@_target']
        if (!source || !target) continue
        elkEdges.push({
            id: `e${++edgeCounter}`,
            sources: [source],
            targets: [target],
        })
    }

    return {
        id: 'root',
        layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': elkOptions.direction || 'DOWN',
            'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
            'elk.layered.spacing.nodeNodeBetweenLayers': String(elkOptions.ranksep ?? 120),
            'elk.spacing.nodeNode': String(elkOptions.nodesep ?? 60),
            'elk.spacing.edgeNode': String(elkOptions.edgesep ?? 20),
        },
        children: elkNodes,
        edges: elkEdges,
    }
}

// Walk the laid-out ELK graph and apply new geometry back onto each shape.
// ELK produces x/y relative to the containing node; drawio expects geometry
// relative to the shape's parent cell, which aligns naturally.
function applyElkLayout(laid, objectsByAlias) {
    const walk = (node) => {
        const obj = objectsByAlias.get(node.id)
        if (obj) {
            writeGeom(obj, {
                x: node.x ?? 0,
                y: node.y ?? 0,
                width: node.width,
                height: node.height,
            })
        }
        for (const child of node.children ?? []) walk(child)
    }
    for (const child of laid.children ?? []) walk(child)
}

// Compute page size from laid-out root dimensions so the drawio page
// grows to fit the new layout.
function applyPageSize(doc, laid) {
    const model = doc?.mxfile?.diagram?.mxGraphModel
    if (!model) return
    const width = Math.ceil(laid.width ?? Number(model['@_pageWidth'] ?? 800))
    const height = Math.ceil(laid.height ?? Number(model['@_pageHeight'] ?? 600))
    model['@_pageWidth'] = String(width)
    model['@_pageHeight'] = String(height)
}

/**
 * Re-layout a drawio XML string via elkjs.
 * @param {string} xmlIn - drawio XML (a full <mxfile>…</mxfile> document)
 * @param {object} [options]
 * @param {'DOWN'|'UP'|'LEFT'|'RIGHT'} [options.direction='DOWN']
 * @param {number} [options.nodesep=60]
 * @param {number} [options.edgesep=20]
 * @param {number} [options.ranksep=120]
 * @returns {Promise<string>}
 */
export async function layoutDrawio(xmlIn, options = {}) {
    const doc = PARSER.parse(xmlIn)
    const objects = getObjects(doc)
    if (objects.length === 0) {
        return xmlIn
    }

    const objectsByAlias = new Map()
    for (const obj of objects) {
        const a = alias(obj)
        if (a && !isEdge(obj)) objectsByAlias.set(a, obj)
    }

    const graph = buildElkGraph(objects, options)
    const laid = await elk.layout(graph)

    applyElkLayout(laid, objectsByAlias)
    applyPageSize(doc, laid)

    return BUILDER.build(doc)
}
