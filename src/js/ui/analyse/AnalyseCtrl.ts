import * as debounce from 'lodash/debounce'
import router from '../../router'
import * as chess from '../../chess'
import * as chessFormat from '../../utils/chessFormat'
import { build as makeTree, path as treePath, ops as treeOps, TreeWrapper, Tree } from '../../utils/tree'
import redraw from '../../utils/redraw'
import session from '../../session'
import sound from '../../sound'
import socket from '../../socket'
import { openingSensibleVariants } from '../../lichess/variant'
import * as gameApi from '../../lichess/game'
import { isOnlineGameData, Opening } from '../../lichess/interfaces/game'
import settings from '../../settings'
import { handleXhrError, oppositeColor, hasNetwork, noop } from '../../utils'
import promotion from '../shared/offlineRound/promotion'
import continuePopup, { Controller as ContinuePopupController } from '../shared/continuePopup'
import { NotesCtrl } from '../shared/round/notes'
import { getPGN } from '../shared/round/roundXhr'
import * as util from './util'
import cevalCtrl from './ceval/cevalCtrl'
import crazyValid from './crazy/crazyValid'
import explorerCtrl from './explorer/explorerCtrl'
import menu from './menu'
import evalSummary from './evalSummaryPopup'
import analyseSettings from './analyseSettings'
import ground from './ground'
import socketHandler from './analyseSocketHandler'
import { VM, AnalysisData, AnalysisStep, SanToRole, Source, Path, PathObj, ExplorerCtrlInterface, CevalCtrlInterface, MenuInterface, Ceval, CevalEmit } from './interfaces'

const sanToRole: SanToRole = {
  P: 'pawn',
  N: 'knight',
  B: 'bishop',
  R: 'rook',
  Q: 'queen'
}

export default class AnalyseCtrl {
  data: AnalysisData
  orientation: Color
  source: Source
  vm: VM
  settings: MenuInterface
  menu: MenuInterface
  continuePopup: ContinuePopupController
  evalSummary: MenuInterface | null
  notes: NotesCtrl | null

  chessground: Chessground.Controller
  ceval: CevalCtrlInterface
  explorer: ExplorerCtrlInterface
  tree: TreeWrapper

  // current tree state, cursor, and denormalized node lists
  path: Tree.Path
  node: Tree.Node
  nodeList: Tree.Node[]
  mainline: Tree.Node[]

  // other paths
  initialPath: Tree.Path

  private debouncedExplorerSetStep: () => void

  static decomposeUci(uci: string): [Pos, Pos, SanChar] {
    return [<Pos>uci.slice(0, 2), <Pos>uci.slice(2, 4), <SanChar>uci.slice(4, 5)]
  }

  constructor(data: AnalysisData, source: Source, orientation: Color, shouldGoBack: boolean, ply?: number) {
    this.data = data
    this.orientation = orientation
    this.source = source

    this.initialPath = treePath.root

    if (settings.analyse.supportedVariants.indexOf(this.data.game.variant.key) === -1) {
      window.plugins.toast.show(`Analysis board does not support ${this.data.game.variant.name} variant.`, 'short', 'center')
      router.set('/')
    }

    this.settings = analyseSettings.controller(this)
    this.menu = menu.controller(this)
    this.continuePopup = continuePopup.controller()

    this.evalSummary = this.data.analysis ? evalSummary.controller(this) : null
    this.notes = session.isConnected() && this.data.game.speed === 'correspondence' ? new NotesCtrl(this.data) : null


    this.tree = makeTree(treeOps.reconstruct(this.data.treeParts));

    this.ceval = cevalCtrl(this.data.game.variant.key, this.allowCeval(), this.onCevalMsg)
    this.explorer = explorerCtrl(this, true)
    this.debouncedExplorerSetStep = debounce(this.explorer.setStep, this.data.pref.animationDuration + 50)

    const initPly = Number(ply) ||
      (location.hash && parseInt(location.hash.replace(/#/, ''), 10)) ||
      (this.source === 'online' && gameApi.isPlayerPlaying(this.data) ?
        this.tree.lastPly() : this.analyse.firstPly())

    const mainline = treeOps.mainlineNodeList(this.tree.root)
    this.initialPath = treeOps.takePathWhile(mainline, n => n.ply <= initPly)

    const gameMoment = window.moment(this.data.game.createdAt)
    this.vm = {
      shouldGoBack,
      formattedDate: gameMoment.format('L LT'),
      cgConfig: undefined,
      variationMenu: undefined,
      flip: false,
      smallBoard: settings.analyse.smallBoard(),
      analysisProgress: false,
      showBestMove: settings.analyse.showBestMove(),
      showComments: settings.analyse.showComments(),
      computingPGN: false,
      replaying: false
    }

    if (this.isRemoteAnalysable()) {
      this.connectGameSocket()
    } else {
      socket.createDefault()
    }

    this.showGround()
    setTimeout(this.debouncedScroll, 250)
    setTimeout(this.initCeval, 1000)
    window.plugins.insomnia.keepAwake()
  }

  setPath = (path: Tree.Path): void => {
    this.path = path;
    this.nodeList = this.tree.getNodeList(path);
    this.node = treeOps.last(this.nodeList) as Tree.Node;
    this.mainline = treeOps.mainlineNodeList(this.tree.root);
    this.onMainline = this.tree.pathIsMainline(path)
  }

  player = () => {
    return this.data.game.player
  }

  connectGameSocket = () => {
    if (hasNetwork() && isOnlineGameData(this.data)) {
      socket.createGame(
        this.data.url.socket,
        this.data.player.version,
        socketHandler(this, this.data.game.id, this.orientation),
        this.data.url.round
      )
    }
  }

  flip = () => {
    this.vm.flip = !this.vm.flip
    this.chessground.set({
      orientation: this.vm.flip ? oppositeColor(this.orientation) : this.orientation
    })
  }

  toggleBoardSize = () => {
    const newVal = !this.vm.smallBoard
    settings.analyse.smallBoard(newVal)
    this.vm.smallBoard = newVal
  }

  initCeval = () => {
    if (this.ceval.enabled()) {
      if (this.ceval.isInit()) {
        this.startCeval()
      } else {
        this.ceval.init().then(this.startCeval)
      }
    }
  }

  private startCeval = () => {
    if (this.ceval.enabled() && this.canUseCeval()) {
      const steps = this.analyse.getSteps(this.path)
      if (steps) this.ceval.start(this.path, steps)
    }
  }

  private showGround() {
    const node = this.node

    if (this.data.game.variant.key === 'threeCheck' && !node.checkCount) {
      node.checkCount = util.readCheckCount(node.fen)
    }

    const color: Color = node.ply % 2 === 0 ? 'white' : 'black'
    const dests = util.readDests(node.dests)
    const config = {
      fen: node.fen,
      turnColor: color,
      orientation: this.vm.flip ? oppositeColor(this.orientation) : this.orientation,
      movableColor: this.gameOver() ? undefined : color,
      dests: dests || {},
      check: node.check,
      lastMove: node.uci ? chessFormat.uciToMoveOrDrop(node.uci) : undefined
    }

    this.vm.cgConfig = config
    this.data.game.player = color
    if (!this.chessground) {
      this.chessground = ground.make(this.data, config, this.orientation, this.userMove, this.userNewPiece)
    } else {
      this.chessground.set(config)
    }

    if (!dests) this.getStepSituation()
  }

  debouncedScroll = debounce(() => util.autoScroll(document.getElementById('replay')), 200)

  private updateHref = debounce(() => {
    const step = this.node
    if (step) {
      try {
        window.history.replaceState(window.history.state, '', '#' + step.ply)
      } catch (e) { console.error(e) }
    }
  }, 750)

  private debouncedStartCeval = debounce(this.startCeval, 800)

  jump = (path: Tree.Path, direction?: 'forward' | 'backward') => {
    this.setPath(path)
    this.toggleVariationMenu()
    this.showGround()
    this.getOpening()
    if (this.node && this.node.san && direction === 'forward') {
      if (this.node.san.indexOf('x') !== -1) sound.throttledCapture()
      else sound.throttledMove()
    }
    this.ceval.stop()
    this.debouncedExplorerSetStep()
    this.updateHref()
    this.debouncedStartCeval()
    promotion.cancel(this.chessground, this.vm.cgConfig)
  }

  public userJump = (path: Path, direction?: 'forward' | 'backward') => {
    this.jump(path, direction)
  }

  public jumpToMain = (ply: number) => {
    this.userJump([{
      ply: ply,
      variation: undefined
    }])
  }

  public jumpToIndex = (index: number) => {
    this.jumpToMain(index + 1 + (this.data.game.startedAtTurn || 0))
  }

  private canGoForward() {
    let tree = this.analyse.tree
    let ok = false
    this.path.forEach((step: PathObj) => {
      for (let i = 0, nb = tree.length; i < nb; i++) {
        const move = tree[i]
        if (step.ply === move.ply && move.variations && step.variation) {
          tree = move.variations[step.variation - 1]
          break
        } else ok = step.ply < move.ply
      }
    })
    return ok
  }

  private next() {
    if (!this.canGoForward()) return false
    const p = this.path
    p[p.length - 1].ply++
    this.userJump(p, 'forward')

    return true
  }

  private prev() {
    const p = this.path
    const len = p.length
    if (len === 1) {
      if (p[0].ply === this.analyse.firstPly()) return false
      p[0].ply--
    } else {
      if (p[len - 1].ply > p[len - 2].ply) p[len - 1].ply--
      else {
        p.pop()
        p[len - 2].variation = undefined
        if (p[len - 2].ply > 1) p[len - 2].ply--
      }
    }
    this.userJump(p)

    return true
  }

  public fastforward = () => {
    this.vm.replaying = true
    const more = this.next()
    if (!more) {
      this.vm.replaying = false
      this.debouncedScroll()
    }
    return more
  }

  public stopff = () => {
    this.vm.replaying = false
    this.next()
    this.debouncedScroll()
  }

  public rewind = () => {
    this.vm.replaying = true
    const more = this.prev()
    if (!more) {
      this.vm.replaying = false
      this.debouncedScroll()
    }
    return more
  }

  public stoprewind = () => {
    this.vm.replaying = false
    this.prev()
    this.debouncedScroll()
  }

  public canDrop = () => {
    return true
  }

  private sendMove = (orig: Pos, dest: Pos, prom?: Role) => {
    const step = this.node
    if (step) {
      const move: chess.MoveRequest = {
        orig: orig,
        dest: dest,
        variant: this.data.game.variant.key,
        fen: step.fen,
        path: this.pathStr
      }
      if (prom) move.promotion = prom
      chess.move(move)
      .then(this.addNode)
      .catch(err => console.error('send move error', move, err))
    }
  }

  private userMove = (orig: Pos, dest: Pos, capture: boolean) => {
    if (capture) sound.capture()
    else sound.move()
    if (!promotion.start(this.chessground, orig, dest, this.sendMove)) this.sendMove(orig, dest)
  }

  private userNewPiece = (piece: Piece, pos: Pos) => {
    const step = this.node
    if (step) {
      if (crazyValid.drop(piece.role, pos, step.drops)) {
        sound.move()
        const drop = {
          role: piece.role,
          pos: pos,
          variant: this.data.game.variant.key,
          fen: step.fen,
          path: this.pathStr
        }
        chess.drop(drop)
        .then(this.addNode)
        .catch(err => {
          // catching false drops here
          console.error('wrong drop', err)
          this.jump(this.path)
        })
      } else this.jump(this.path)
    }
  }

  public explorerMove = (uci: string) => {
    const move = AnalyseCtrl.decomposeUci(uci)
    if (uci[1] === '@') {
      this.chessground.apiNewPiece({
        color: this.chessground.data.movable.color,
        role: sanToRole[uci[0]]
      }, move[1])
    } else if (!move[2]) {
      this.sendMove(move[0], move[1])
    }
    else {
      this.sendMove(move[0], move[1], sanToRole[move[2].toUpperCase()])
    }
    this.explorer.loading(true)
  }

  addNode = ({ situation, path }: chess.MoveResponse) => {
    const curNode = this.node
    const node = {
      ply: situation.ply,
      dests: situation.dests,
      drops: situation.drops,
      check: situation.check,
      end: situation.end,
      player: situation.player,
      checkCount: situation.checkCount,
      fen: situation.fen,
      uci: situation.uciMoves[0],
      san: situation.pgnMoves[0],
      crazy: situation.crazyhouse,
      pgnMoves: curNode && curNode.pgnMoves ? curNode.pgnMoves.concat(situation.pgnMoves) : undefined
    }
    const newPath = this.tree.addNode(node, path);
    this.jump(newPath)
    this.debouncedScroll()
    redraw()
  }

  public toggleVariationMenu = (path?: Path) => {
    this.vm.variationMenu = path
  }

  public deleteVariation = (path: Path) => {
    const ply = path[0].ply
    const id = path[0].variation
    if (id) {
      this.analyse.deleteVariation(ply, id)
      if (treePath.contains(path, this.path)) this.jumpToMain(ply - 1)
    }
    this.toggleVariationMenu()
  }

  public promoteVariation = (path: Path) => {
    const ply = path[0].ply
    const id = path[0].variation
    if (id) {
      this.analyse.promoteVariation(ply, id)
      if (treePath.contains(path, this.path)) this.jump(this.path.splice(1))
    }
    this.toggleVariationMenu()
  }

  private allowCeval() {
    return (
      this.source === 'offline' || util.isSynthetic(this.data) || !gameApi.playable(this.data)
    ) &&
      gameApi.analysableVariants
      .indexOf(this.data.game.variant.key) !== -1
  }

  private onCevalMsg = (res: CevalEmit) => {
    this.analyse.updateAtPath(res.work.path, (step: AnalysisStep) => {
      if (step.ceval && step.ceval.depth >= res.ceval.depth) return

      if (step.ceval === undefined)
        step.ceval = <Ceval>Object.assign({}, res.ceval)
      else
        step.ceval = <Ceval>Object.assign(step.ceval, res.ceval)

      // get best move in pgn format
      if (step.ceval === undefined || step.ceval.best !== res.ceval.best) {
        if (!res.ceval.best.includes('@')) {
          const move = chessFormat.uciToMove(res.ceval.best)
          chess.move({
            variant: this.data.game.variant.key,
            fen: step.fen,
            orig: move[0],
            dest: move[1],
            promotion: chessFormat.uciToProm(res.ceval.best)
          })
          .then((data: chess.MoveResponse) => {
            if (step.ceval) step.ceval.bestSan = data.situation.pgnMoves[0]
            if (res.work.path === this.path) {
              redraw()
            }
          })
          .catch((err) => {
            console.error('ceval move err', err)
          })
        }
      }

      if (res.ceval.best.includes('@')) {
        step.ceval.bestSan = res.ceval.best
      }

      redraw()

    })
  }

  public gameOver() {
    if (!this.node) return false
    // step.end boolean is fetched async for online games (along with the dests)
    if (this.node.end === undefined) {
      if (this.node.check) {
        const san = this.node.san
        const checkmate = san && san[san.length - 1] === '#'
        return checkmate
      }
    } else {
      return this.node.end
    }
  }

  public canUseCeval = () => {
    return !this.gameOver()
  }

  public nextStepBest = () => {
    return this.analyse.nextStepEvalBest(this.path)
  }

  public hasAnyComputerAnalysis = () => {
    return this.data.analysis || this.ceval.enabled()
  }

  public toggleBestMove = () => {
    this.vm.showBestMove = !this.vm.showBestMove
  }

  public toggleComments = () => {
    this.vm.showComments = !this.vm.showComments
  }

  public sharePGN = () => {
    if (!this.vm.computingPGN) {
      this.vm.computingPGN = true
      if (this.source === 'online') {
        getPGN(this.data.game.id)
        .then((pgn: string) => {
          this.vm.computingPGN = false
          redraw()
          window.plugins.socialsharing.share(pgn)
        })
        .catch(e => {
          this.vm.computingPGN = false
          redraw()
          handleXhrError(e)
        })
      } else {
        const endSituation = this.data.steps[this.data.steps.length - 1]
        const white = this.data.player.color === 'white' ?
        (this.data.game.id === 'offline_ai' ? session.appUser('Anonymous') : 'Anonymous') :
        (this.data.game.id === 'offline_ai' ? this.data.opponent.username : 'Anonymous')
        const black = this.data.player.color === 'black' ?
        (this.data.game.id === 'offline_ai' ? session.appUser('Anonymous') : 'Anonymous') :
        (this.data.game.id === 'offline_ai' ? this.data.opponent.username : 'Anonymous')
        chess.pgnDump({
          variant: this.data.game.variant.key,
          initialFen: this.data.game.initialFen,
          pgnMoves: endSituation.pgnMoves || [],
          white,
          black
        })
        .then((res: chess.PgnDumpResponse) => {
          this.vm.computingPGN = false
          redraw()
          window.plugins.socialsharing.share(res.pgn)
        })
        .catch(e => {
          this.vm.computingPGN = false
          redraw()
          console.error(e)
        })
      }
    }
  }

  public isRemoteAnalysable = () => {
    return !this.data.analysis && !this.vm.analysisProgress &&
      session.isConnected() && isOnlineGameData(this.data) &&
      gameApi.analysable(this.data)
  }

  private getStepSituation = debounce(() => {
    if (this.node && !this.node.dests) {
      chess.situation({
        variant: this.data.game.variant.key,
        fen: this.node.fen,
        path: this.pathStr
      })
      .then(({ situation, path }) => {
        this.analyse.addStepSituationData(situation, treePath.read(path))
        if (path === this.pathStr) {
          this.showGround()
          redraw()
          if (this.gameOver()) this.ceval.stop()
        }
      })
      .catch(err => console.error('get dests error', err))
    }
  }, 50)

  private getOpening = debounce(() => {
    if (
      hasNetwork() && this.node && this.node.opening === undefined &&
      this.node.ply <= 20 && this.node.ply > 0 &&
      openingSensibleVariants.has(this.data.game.variant.key)
    ) {
      let msg: { fen: string, path: string, variant?: VariantKey } = {
        fen: this.node.fen,
        path: this.pathStr
      }
      const variant = this.data.game.variant.key
      if (variant !== 'standard') msg.variant = variant
      this.analyse.updateAtPath(treePath.read(this.pathStr), (step: AnalysisStep) => {
        // flag opening as null in any case to not request twice
        step.opening = null
        socket.ask('opening', 'opening', msg)
        .then((d: { opening: Opening, path: string }) => {
          if (d.opening && d.path) {
            step.opening = d.opening
            if (d.path === this.pathStr) redraw()
          }
        })
        .catch(noop)
      })
    }
  }, 50)
}
