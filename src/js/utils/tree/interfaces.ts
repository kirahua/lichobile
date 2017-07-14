export namespace Tree {
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
    retried?: boolean
  }

  export interface ServerEval {
    cp?: number
    mate?: number
    best?: Uci
  }

  export interface PvData {
    moves: string[]
    mate?: number
    cp?: number
  }

  export interface Node {
    id: string
    ply: Ply
    uci: Uci
    fen: Fen
    children: Node[]
    comments?: Comment[]
    dests?: string
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
    threefold?: boolean
    fail?: boolean
    puzzle?: string
  }

  export interface Comment {
    id: string
    by: string | {
      id: string
      name: string
    }
    text: string
  }

  export interface Opening {
    name: string
    eco: string
  }

  export interface Glyph {
    name: string
    symbol: string
  }

  export type Clock = number

  export interface Shape {
  }
}
