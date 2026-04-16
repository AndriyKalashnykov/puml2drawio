import { describe, test, expect } from 'vitest'
import { buildParser } from '../src/runner.mjs'

function parse(argv) {
  return buildParser(argv).parse()
}

describe('buildParser', () => {
  test('parses input positional and -o', async () => {
    const argv = await parse(['in.puml', '-o', 'out.drawio'])
    expect(argv.input).toBe('in.puml')
    expect(argv.output).toBe('out.drawio')
  })

  test('accepts layout-direction and numeric flags', async () => {
    const argv = await parse([
      'in.puml',
      '--layout-direction=LR',
      '--nodesep=80',
      '--marginx=10'
    ])
    expect(argv.layoutDirection).toBe('LR')
    expect(argv.nodesep).toBe(80)
    expect(argv.marginx).toBe(10)
  })

  test('fail-fast and quiet default to false', async () => {
    const argv = await parse(['in.puml'])
    expect(argv.failFast).toBe(false)
    expect(argv.quiet).toBe(false)
  })

  test('default output-ext is .drawio', async () => {
    const argv = await parse(['in.puml'])
    expect(argv.outputExt).toBe('.drawio')
  })
})
