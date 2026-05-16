import { describe, test, expect } from 'vitest'
import { applyDarkTheme } from '../src/theme-drawio.mjs'

// Catalyst light palette (vendor/catalyst/src/mx/c4/*.mts) and the
// C4_superhero dark targets (empirically read from PlantUML v1.2026.3).
describe('applyDarkTheme — role-aware C4_superhero remap', () => {
  test('Person fill/stroke/font remap', () => {
    const xml = '<mxCell style="rounded=0;fillColor=#08427B;strokeColor=#073B6F;fontColor=#ffffff;"/>'
    const out = applyDarkTheme(xml)
    expect(out).toContain('fillColor=#5BC0DE')
    expect(out).toContain('strokeColor=#7CCDE5')
    expect(out).toContain('fontColor=#FFFFFF')
    expect(out).not.toContain('#08427B')
  })

  test('System (and Db/Queue share the role)', () => {
    const out = applyDarkTheme('<mxCell style="fillColor=#1061B0;strokeColor=#0D5091;fontColor=#ffffff;"/>')
    expect(out).toContain('fillColor=#4E5D6C')
    expect(out).toContain('strokeColor=#717D89')
  })

  test('Container and Component map to distinct dark hues', () => {
    const c = applyDarkTheme('<mxCell style="fillColor=#23A2D9;strokeColor=#0E7DAD;"/>')
    expect(c).toContain('fillColor=#F0AD4E')
    const cm = applyDarkTheme('<mxCell style="fillColor=#63BEF2;strokeColor=#2086C9;"/>')
    expect(cm).toContain('fillColor=#DF691A')
  })

  test('all four external element fills collapse to the external role', () => {
    for (const ext of ['#686868', '#8C8496', '#9B9B9B', '#B3B3B3']) {
      const out = applyDarkTheme(`<mxCell style="fillColor=${ext};strokeColor=#4D4D4D;fontColor=#ffffff;"/>`)
      expect(out).toContain('fillColor=#717D89')
      expect(out).toContain('strokeColor=#3E4A56')
      expect(out).toContain('fontColor=#000000')
    }
  })

  test('boundary (fill=none) keyed by stroke, keeps open frame', () => {
    const out = applyDarkTheme('<mxCell style="dashed=1;fillColor=none;strokeColor=#666666;fontColor=#333333;"/>')
    expect(out).toContain('fillColor=none')
    expect(out).toContain('strokeColor=#717D89')
    expect(out).toContain('fontColor=#FFFFFF')
  })

  // The correctness trap: catalyst reuses #404040 for BOTH external font
  // and relationship font, and #828282-stroke is a relationship edge.
  // A relationship must NOT be recolored using the external rule (which
  // would turn its label #000000 — invisible on the black canvas).
  test('relationship edge keyed by #828282 stroke, gets arrow colour (not external)', () => {
    const edge = '<mxCell edge="1" style="edgeStyle=orthogonalEdgeStyle;strokeColor=#828282;fontColor=#404040;"/>'
    const out = applyDarkTheme(edge)
    expect(out).toContain('strokeColor=#B25415')
    expect(out).toContain('fontColor=#B25415')
    expect(out).not.toContain('fontColor=#000000') // would be the external mistake
  })

  test('unknown shapes are left untouched (safe)', () => {
    const xml = '<mxCell style="rounded=1;fillColor=#123456;strokeColor=#abcdef;"/>'
    expect(applyDarkTheme(xml)).toBe(xml)
  })

  test('sets the canvas background to black (adds attr when absent)', () => {
    expect(applyDarkTheme('<mxGraphModel dx="100">')).toContain('background="#000000"')
  })

  test('replaces an existing background attr', () => {
    const out = applyDarkTheme('<mxGraphModel background="#ffffff" dx="1">')
    expect(out).toContain('background="#000000"')
    expect(out).not.toContain('background="#ffffff"')
  })

  test('idempotent: re-running on dark output does not corrupt fills', () => {
    const once = applyDarkTheme('<mxCell style="fillColor=#08427B;strokeColor=#073B6F;"/>')
    expect(applyDarkTheme(once)).toBe(once)
  })

  test('non-string / empty input passes through', () => {
    expect(applyDarkTheme('')).toBe('')
    expect(applyDarkTheme(null)).toBe(null)
  })
})
