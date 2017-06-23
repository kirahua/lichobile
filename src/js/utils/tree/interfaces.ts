export type Path = string

export interface ClientEval {
  fen: string
  maxDepth: number
  depth: number
  knps: number
  nodes: number
  millis: number
  pvs: PvData[]
  cloud?: boolean
  cp?: number
  mate?: number
}

export interface ServerEval {
  cp?: number
  mate?: number
}

export interface PvData {
  moves: string[]
  mate?: number
  cp?: number
}

export interface Node {
  id: string
  ply: number
  fen: string
  children: Node[]
  comments?: Comment[]
  dests: string | undefined | null
  drops: string | undefined | null
  check: boolean
  threat?: ClientEval
  ceval?: ClientEval
  eval?: ServerEval
  opening?: Opening
  glyphs?: Glyph[]
  clock?: Clock
  parentClock?: Clock
  shapes?: Shape[]
  comp?: boolean
  san?: string
}

export interface Comment {
  id: string
  text: string
}

export interface Opening {
  eco: string
  symbol: string
}

export interface Glyph {
  name: string
  symbol: string
}

export interface Clock {
}

export interface Shape {
}
