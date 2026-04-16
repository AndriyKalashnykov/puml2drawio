import fs from 'node:fs/promises'
import path from 'node:path'

let catalystModule

async function loadCatalyst() {
  if (!catalystModule) {
    catalystModule = await import('../vendor/catalyst/dist/catalyst.mjs')
  }
  return catalystModule
}

export async function convertString(puml, options) {
  const { Catalyst } = await loadCatalyst()
  return Catalyst.convert(puml, { ...options })
}

export async function convertFile(inputPath, outputPath, options) {
  const puml = await fs.readFile(inputPath, 'utf-8')
  const drawio = await convertString(puml, options)
  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, drawio)
  }
  return drawio
}

export function deriveOutputPath({ inputPath, baseDir, outputDir, ext = '.drawio' }) {
  const rel = path.relative(baseDir, inputPath)
  const parsed = path.parse(rel)
  return path.join(outputDir, parsed.dir, `${parsed.name}${ext}`)
}

export async function collectPumlFiles(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.puml'))
    .map((e) => path.join(e.parentPath ?? e.path ?? root, e.name))
    .sort()
}
