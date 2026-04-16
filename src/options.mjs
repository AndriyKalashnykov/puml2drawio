export const DEFAULTS = Object.freeze({
  layoutDirection: 'TB',
  nodesep: 50,
  edgesep: 10,
  ranksep: 50,
  marginx: 20,
  marginy: 20
})

export const ENV_MAP = Object.freeze({
  layoutDirection: 'CATALYST_LAYOUT_DIRECTION',
  nodesep: 'CATALYST_NODESEP',
  edgesep: 'CATALYST_EDGESEP',
  ranksep: 'CATALYST_RANKSEP',
  marginx: 'CATALYST_MARGINX',
  marginy: 'CATALYST_MARGINY'
})

const NUMERIC_KEYS = new Set(['nodesep', 'edgesep', 'ranksep', 'marginx', 'marginy'])
const VALID_DIRECTIONS = new Set(['TB', 'BT', 'LR', 'RL'])

function coerceNumber(key, raw) {
  const num = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`Invalid numeric value for ${key}: ${raw}`)
  }
  return num
}

function coerceDirection(raw) {
  const v = String(raw).toUpperCase()
  if (!VALID_DIRECTIONS.has(v)) {
    throw new Error(`Invalid layoutDirection: ${raw} (expected one of ${[...VALID_DIRECTIONS].join(', ')})`)
  }
  return v
}

// Precedence: explicit flag > env var > default. Returns a frozen new object.
export function resolveOptions(flags = {}, env = process.env) {
  const out = {}
  for (const key of Object.keys(DEFAULTS)) {
    const flagVal = flags[key]
    const envVal = env[ENV_MAP[key]]
    let raw
    if (flagVal !== undefined && flagVal !== null) {
      raw = flagVal
    } else if (envVal !== undefined && envVal !== '') {
      raw = envVal
    } else {
      raw = DEFAULTS[key]
    }
    if (NUMERIC_KEYS.has(key)) {
      out[key] = coerceNumber(key, raw)
    } else if (key === 'layoutDirection') {
      out[key] = coerceDirection(raw)
    } else {
      out[key] = raw
    }
  }
  return Object.freeze(out)
}
