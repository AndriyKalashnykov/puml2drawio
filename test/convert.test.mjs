import { describe, test, expect } from 'vitest'
import { deriveOutputPath, collectPumlFiles } from '../src/convert.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

describe('deriveOutputPath', () => {
  test('preserves relative tree under outputDir', () => {
    const result = deriveOutputPath({
      inputPath: 'src/diagrams/context/main.puml',
      baseDir: 'src/diagrams',
      outputDir: 'build/drawio'
    })
    expect(result).toBe(path.join('build/drawio', 'context', 'main.drawio'))
  })

  test('respects custom extension', () => {
    const result = deriveOutputPath({
      inputPath: 'in/a.puml',
      baseDir: 'in',
      outputDir: 'out',
      ext: '.xml'
    })
    expect(result).toBe(path.join('out', 'a.xml'))
  })

  test('flat input directory', () => {
    const result = deriveOutputPath({
      inputPath: 'diagrams/a.puml',
      baseDir: 'diagrams',
      outputDir: 'out'
    })
    expect(result).toBe(path.join('out', 'a.drawio'))
  })
})

describe('collectPumlFiles', () => {
  test('recursively finds .puml files, sorted, case-insensitive', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-'))
    try {
      await fs.mkdir(path.join(dir, 'nested'), { recursive: true })
      await fs.writeFile(path.join(dir, 'b.puml'), '@startuml\n@enduml\n')
      await fs.writeFile(path.join(dir, 'a.puml'), '@startuml\n@enduml\n')
      await fs.writeFile(path.join(dir, 'nested', 'c.PUML'), '@startuml\n@enduml\n')
      await fs.writeFile(path.join(dir, 'ignore.txt'), 'nope')

      const files = await collectPumlFiles(dir)
      expect(files).toHaveLength(3)
      expect(files.map((f) => path.basename(f))).toEqual(['a.puml', 'b.puml', 'c.PUML'])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('returns empty array for a directory with no .puml files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-empty-'))
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), 'hello')
      await fs.writeFile(path.join(dir, 'config.json'), '{}')
      const files = await collectPumlFiles(dir)
      expect(files).toEqual([])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('finds deeply nested .puml files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'puml2drawio-deep-'))
    try {
      const deep = path.join(dir, 'a', 'b', 'c', 'd')
      await fs.mkdir(deep, { recursive: true })
      await fs.writeFile(path.join(deep, 'deep.puml'), '@startuml\n@enduml\n')
      const files = await collectPumlFiles(dir)
      expect(files).toHaveLength(1)
      expect(path.basename(files[0])).toBe('deep.puml')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
