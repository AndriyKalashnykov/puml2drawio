import { describe, test, expect } from 'vitest'
import { resolveOptions, DEFAULTS, ENV_MAP } from '../src/options.mjs'

describe('resolveOptions', () => {
  test('returns defaults when no flags or env', () => {
    const result = resolveOptions({}, {})
    expect(result).toEqual(DEFAULTS)
  })

  test('returns a frozen object', () => {
    const result = resolveOptions({}, {})
    expect(Object.isFrozen(result)).toBe(true)
  })

  test('flag overrides env, env overrides default', () => {
    const env = { [ENV_MAP.nodesep]: '99', [ENV_MAP.edgesep]: '77' }
    const result = resolveOptions({ nodesep: 5 }, env)
    expect(result.nodesep).toBe(5)
    expect(result.edgesep).toBe(77)
    expect(result.ranksep).toBe(DEFAULTS.ranksep)
  })

  test('coerces numeric env vars from string to number', () => {
    const env = { [ENV_MAP.marginx]: '42' }
    const result = resolveOptions({}, env)
    expect(result.marginx).toBe(42)
    expect(typeof result.marginx).toBe('number')
  })

  test('rejects negative numeric values', () => {
    expect(() => resolveOptions({ nodesep: -1 }, {})).toThrow(/Invalid numeric value/)
  })

  test('rejects non-numeric numeric env vars', () => {
    const env = { [ENV_MAP.nodesep]: 'abc' }
    expect(() => resolveOptions({}, env)).toThrow(/Invalid numeric value/)
  })

  test('accepts empty env string as missing (uses default)', () => {
    const env = { [ENV_MAP.nodesep]: '' }
    const result = resolveOptions({}, env)
    expect(result.nodesep).toBe(DEFAULTS.nodesep)
  })

  test('layoutDirection is case-normalized', () => {
    const result = resolveOptions({ layoutDirection: 'lr' }, {})
    expect(result.layoutDirection).toBe('LR')
  })

  test('layoutDirection validates against TB|BT|LR|RL', () => {
    expect(() => resolveOptions({ layoutDirection: 'XY' }, {})).toThrow(/Invalid layoutDirection/)
  })

  test('undefined and null flag values fall through to env/default', () => {
    const env = { [ENV_MAP.nodesep]: '7' }
    expect(resolveOptions({ nodesep: undefined }, env).nodesep).toBe(7)
    expect(resolveOptions({ nodesep: null }, env).nodesep).toBe(7)
  })
})
