// Post-process a catalyst-produced drawio file: remap the baked C4_blue
// (light) palette to the official C4-PlantUML **C4_superhero** dark theme.
//
// Why a post-processor (same shape as src/layout-drawio.mjs): catalyst
// v1.3.0 `Catalyst.convert()` has no theme/color option — colors are baked
// per C4 element type in vendor/catalyst/src/mx/c4/*.mts. A standalone
// colour-remap stage is the only no-upstream-change way to recolor.
//
// The target palette is NOT invented. It is the official C4-PlantUML
// `C4_superhero` theme, with every hex read empirically from PlantUML
// v1.2026.3's own SVG render of that theme (the installed tool's own
// authoritative resolution — not docs, not memory):
//
//   role       fill       stroke     font
//   Person     #5BC0DE    #7CCDE5    #FFFFFF
//   System     #4E5D6C    #717D89    #FFFFFF
//   Container  #F0AD4E    #F3BD71    #FFFFFF
//   Component  #DF691A    #E58748    #FFFFFF
//   External   #717D89    #3E4A56    #000000
//   Boundary   none       #717D89    #FFFFFF
//   Relation   —          #B25415    #B25415
//   Background #000000  (C4_superhero $BGCOLOR ?= black)
//
// Source: https://github.com/plantuml-stdlib/C4-PlantUML/blob/master/themes/puml-theme-C4_superhero.puml
//
// Remap is ROLE-AWARE, not blind hex substitution: catalyst reuses
// `#404040` for BOTH external-element font and relationship font, so a
// global find/replace would make relationship labels invisible. Instead
// each shape is classified by its distinct catalyst fill/stroke signature
// (vendor/catalyst/src/mx/c4/*.mts) and assigned the dark triple by role.

// Catalyst light fill hex -> role (from vendor/catalyst/src/mx/c4/*.mts).
// Db/Queue variants share the base role fill, which is correct (same role).
const ROLE_BY_FILL = Object.freeze({
  '#08427B': 'person',
  '#1061B0': 'system',
  '#23A2D9': 'container',
  '#63BEF2': 'component',
  '#686868': 'external', // PersonExt
  '#8C8496': 'external', // SystemExt
  '#9B9B9B': 'external', // ContainerExt
  '#B3B3B3': 'external', // ComponentExt
  '#FFFFFF': 'node' // DeploymentNode (white box)
})

// When a shape has no fill (fillColor=none / absent) it is a boundary or a
// relationship — distinguished by stroke (catalyst: Boundary #666666,
// EnterpriseBoundary #444444, Relationship #828282).
const ROLE_BY_STROKE_NOFILL = Object.freeze({
  '#666666': 'boundary',
  '#444444': 'boundary',
  '#828282': 'relationship'
})

// C4_superhero dark triples — empirically extracted from PlantUML v1.2026.3.
const DARK = Object.freeze({
  person: { fill: '#5BC0DE', stroke: '#7CCDE5', font: '#FFFFFF' },
  system: { fill: '#4E5D6C', stroke: '#717D89', font: '#FFFFFF' },
  container: { fill: '#F0AD4E', stroke: '#F3BD71', font: '#FFFFFF' },
  component: { fill: '#DF691A', stroke: '#E58748', font: '#FFFFFF' },
  external: { fill: '#717D89', stroke: '#3E4A56', font: '#000000' },
  // Boundary/DeploymentNode: keep the open frame (no fill), light stroke.
  boundary: { fill: 'none', stroke: '#717D89', font: '#FFFFFF' },
  node: { fill: 'none', stroke: '#717D89', font: '#FFFFFF' },
  // Relationship edges: C4_superhero arrow + arrow-label colour (#B25415).
  relationship: { stroke: '#B25415', font: '#B25415' }
})

const HEX = /#[0-9A-Fa-f]{6}/

function readToken(style, key) {
  const m = style.match(new RegExp(`${key}=(#[0-9A-Fa-f]{6}|none)`, 'i'))
  return m ? m[1].toUpperCase() : null
}

// Replace `key=...` in a style string, or append it if absent.
function setToken(style, key, value) {
  const re = new RegExp(`${key}=(#[0-9A-Fa-f]{6}|none)`, 'i')
  if (re.test(style)) return style.replace(re, `${key}=${value}`)
  return style.endsWith(';') || style === '' ? `${style}${key}=${value};` : `${style};${key}=${value}`
}

function classify(style) {
  const fill = readToken(style, 'fillColor')
  if (fill && fill !== 'NONE' && ROLE_BY_FILL[fill]) return ROLE_BY_FILL[fill]
  if (!fill || fill === 'NONE') {
    const stroke = readToken(style, 'strokeColor')
    if (stroke && ROLE_BY_STROKE_NOFILL[stroke]) return ROLE_BY_STROKE_NOFILL[stroke]
  }
  return null // unknown shape — leave untouched (safe)
}

function remapStyle(style) {
  const role = classify(style)
  if (!role) return style
  const t = DARK[role]
  let out = style
  if (t.fill !== undefined) out = setToken(out, 'fillColor', t.fill)
  if (t.stroke !== undefined) out = setToken(out, 'strokeColor', t.stroke)
  if (t.font !== undefined) out = setToken(out, 'fontColor', t.font)
  return out
}

// Apply the C4_superhero dark remap to a catalyst-produced drawio string.
// Operates on `style="..."` attributes (works for both <mxCell> and the
// drawio C4 <object> wrapper) and sets the canvas background to black.
// Idempotent enough for tests: re-running on already-dark output is a
// no-op for fills/strokes (dark hex are not catalyst light keys).
export function applyDarkTheme(xml) {
  if (typeof xml !== 'string' || xml.length === 0) return xml
  let out = xml.replace(/style="([^"]*)"/g, (_, s) => {
    if (!HEX.test(s)) return `style="${s}"`
    return `style="${remapStyle(s)}"`
  })
  // C4_superhero $BGCOLOR ?= black. drawio reads `background` on
  // <mxGraphModel>; add it if not already present.
  out = out.replace(/<mxGraphModel\b([^>]*?)>/, (full, attrs) =>
    /\bbackground=/.test(attrs)
      ? full.replace(/background="[^"]*"/, 'background="#000000"')
      : `<mxGraphModel${attrs} background="#000000">`
  )
  return out
}
