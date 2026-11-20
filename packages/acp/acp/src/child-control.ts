/** ACP v2 activity for rooted, in-process DSH subagents. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import type { SessionUpdate, StateUpdate } from 'acp-v2-sdk/experimental/v2/unstable'
import { SessionHandleClosedError, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { localCatalogChild } from './child-history.ts'

type IdleState = Extract<StateUpdate, { state: 'idle' }>
const unconfirmedIdle: IdleState = { state: 'idle', stopReason: null }

interface LiveTurn {
  readonly start: SessionEvent<'turn/start'>
  canCancel: boolean
  cancelRequested: boolean
}

interface LiveChild {
  readonly runId: SubagentRunInfo['runId']
  readonly root: Agent
  readonly parentId: SessionId
  readonly agent: Agent
  turn: LiveTurn | undefined
  ending: IdleState | undefined
  announced: boolean
}

interface OwnershipEdge {
  readonly parentId: SessionId
  readonly child: SessionHeader
  readonly label: string | undefined
}

type SendActivity = (parent: SessionId, send: () => Promise<void>) => void
type SendUpdate = (session: SessionId, update: SessionUpdate) => Promise<void>

/** Correlate a child's native activation, live turn, and committed terminal event. */
export class V2ChildControl {
  private readonly children = new Map<SessionId, LiveChild>()
  private readonly associations = new WeakMap<Agent, Set<SessionId>>()

  /**
   * Observe only the exact runtime descendants of this connection's active roots.
   * @param ctx - ACP bridge context with access to the native agent registry.
   * @param persistence - native retained catalog, header and turn evidence.
   * @param rootFor - lookup of the bridge-owned root, excluding closing roots.
   * @param enqueue - serialize child activity against the root's wire updates.
   * @param send - write one session update to the negotiated v2 client.
   */
  constructor(
    private readonly ctx: Context,
    private readonly persistence: SessionPersistence,
    private readonly rootFor: (id: SessionId) => Agent | undefined,
    private readonly enqueue: SendActivity,
    private readonly send: SendUpdate,
  ) {
    ctx.on('subagent/start', (run) => {
      const agent = ctx.agents.get(run.id)
      if (!run.local || agent?.runningTurnInjector === undefined
        || agent.session.header.origin !== 'subagent' || agent.session.header.parentSession !== run.parentSessionId) return
      const root = this.ownedRoot(agent)
      if (root === undefined) return
      this.children.set(run.id, {
        runId: run.runId, root, parentId: run.parentSessionId, agent, turn: undefined, ending: undefined, announced: false,
      })
    })
    ctx.on('subagent/end', (run) => {
      const child = this.children.get(run.id)
      if (child?.runId !== run.runId) return
      this.children.delete(run.id)
      if (child.announced) this.publish(child, () => null)
    })
    ctx.on('session/event', (session, event) => { this.observeTurn(session, event) })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      const child = this.children.get(agent.id)
      if (child?.agent !== agent || !child.announced) return
      const ending = child.ending
      child.turn = undefined
      child.ending = undefined
      child.announced = false
      const durable = ending === undefined ? undefined : ctx.sessions.flush(agent.session).catch((error: unknown) => {
        ctx.logger.warn(`acp v2: cannot flush child terminal state: ${String(error)}`)
        return false
      })
      this.publish(child, async () => ending !== undefined && await durable ? ending : unconfirmedIdle)
    })
  }

  /**
   * Interrupt the current native turn under ancestor authority. Absent, stale,
   * already-aborting, and unannounced children accept no client mutation.
   * @param id - child session id carried by the v2 notification.
   */
  cancel(id: SessionId): void {
    const child = this.children.get(id)
    const subagents = this.ctx.get('subagents')
    const turn = child?.turn
    if (child === undefined || turn?.canCancel !== true || turn.cancelRequested || subagents === undefined
      || !this.isCurrentTurn(child, turn)) return
    // The active intake excludes a turn another controller already aborted.
    subagents.interrupt(id, { kind: 'ancestor', agent: child.root })
    // A silent native no-op leaves intake available. Only an observed abort
    // of this exact turn may later attribute the native parent reason to ACP.
    turn.cancelRequested = child.agent.runningTurnInjector?.() === undefined
  }

  /**
   * Remove the root's live capabilities as soon as close begins.
   * @param parent - exact root session starting close.
   */
  detach(parent: SessionId): void {
    const root = this.rootFor(parent)
    if (root !== undefined) this.associations.delete(root)
    for (const [id, child] of this.children) {
      if (child.root.id === parent) this.children.delete(id)
    }
  }

  private observeTurn(session: Session, event: SessionEvent): void {
    const child = this.children.get(session.id)
    if (child?.agent.session !== session) return
    if (event.type === 'turn/start') {
      const turn: LiveTurn = { start: event, canCancel: false, cancelRequested: false }
      child.turn = turn
      child.ending = undefined
      child.announced = true
      this.publish(child, () => ({ state: 'running' }), turn)
    } else if (event.type === 'turn/end' && child.turn?.start.data.turn === event.data.turn) {
      child.ending = idleAfterTurn(event.data.reason, child.turn.cancelRequested)
      child.turn = undefined
    }
  }

  private ownedRoot(agent: Agent): Agent | undefined {
    try {
      const root = this.ctx.get('subagents')?.rootOf(agent)
      if (root !== undefined && root !== agent && this.rootFor(root.id) === root) return root
    } catch (error: unknown) {
      this.ctx.logger.debug(`acp v2: child runtime owner is no longer available: ${String(error)}`)
    }
  }

  private isCurrentTurn(child: LiveChild, turn: LiveTurn): boolean {
    return this.children.get(child.agent.id) === child && child.turn === turn
      && this.ownedRoot(child.agent) === child.root && child.agent.runningTurnInjector?.() !== undefined
  }

  /** Read the exact live turn and every creator edge outside inherited history. */
  private async retainedPath(child: LiveChild, turn: LiveTurn): Promise<readonly OwnershipEdge[] | undefined> {
    const { agent, root } = child
    const seen = new Set([agent.id])
    let header: SessionHeader
    if (!await this.ctx.sessions.flush(agent.session)) return
    {
      await using leaf = await this.persistence.open(agent.id, 'read')
      header = leaf.header
      if (header.id !== agent.id || header.createdAt !== agent.session.header.createdAt || header.parentSession !== child.parentId
        || turn.start.seq < leaf.inheritedEventCount) return
      const [event] = (await leaf.read(turn.start.seq, 1)).events
      if (event?.type !== 'turn/start' || event.seq !== turn.start.seq || event.data.turn !== turn.start.data.turn) return
    }
    const edges: OwnershipEdge[] = []
    while (header.origin === 'subagent' && header.parentSession !== undefined) {
      const parentId = header.parentSession
      if (seen.has(parentId)) return
      seen.add(parentId)
      const live = this.ctx.sessions.get(parentId)
      if (live !== undefined) {
        try {
          if (!await this.ctx.sessions.flush(live) && this.ctx.sessions.get(parentId) !== undefined) return
        } catch (error: unknown) {
          const current = this.ctx.sessions.get(parentId)
          // Disposal can close the writer before it detaches the Session.
          // The read handle waits for the closing writer's final drain.
          if (current !== undefined
            && (current !== live || !(error instanceof SessionHandleClosedError) || error.sessionId !== parentId)) throw error
        }
      }
      await using reader = await this.persistence.open(parentId, 'read')
      if (reader.header.id !== parentId || (live !== undefined && reader.header.createdAt !== live.header.createdAt)) return
      const { events } = await reader.read(reader.inheritedEventCount)
      const catalog = events.map(localCatalogChild).filter(entry => entry?.childId === header.id)
      if (catalog.length !== 1 || catalog[0]?.childCreatedAt !== header.createdAt) return
      edges.push({ parentId, child: header, label: catalog[0].label })
      header = reader.header
      if (parentId === root.id) {
        if (header.createdAt === root.session.header.createdAt && header.origin === root.session.header.origin) return edges.reverse()
        return
      }
    }
  }

  private publish(child: LiveChild, snapshot: () => StateUpdate | null | Promise<StateUpdate>, turn?: LiveTurn): void {
    this.enqueue(child.root.id, async () => {
      if (this.rootFor(child.root.id) !== child.root) return
      const known = this.associations.get(child.root) ?? new Set<SessionId>()
      this.associations.set(child.root, known)
      if (turn !== undefined && child.parentId !== child.root.id) {
        const path = await this.retainedPath(child, turn).catch((error: unknown) => {
          this.ctx.logger.debug(`acp v2: child retained ancestry is unavailable: ${String(error)}`)
          return undefined
        })
        if (path === undefined || this.rootFor(child.root.id) !== child.root) return
        for (const edge of path.slice(0, -1)) {
          if (known.has(edge.child.id)) continue
          await this.send(edge.parentId, {
            sessionUpdate: 'subagent_update', sessionId: edge.child.id,
            ...edge.label === undefined ? {} : { title: edge.label },
            ...edge.child.cwd === undefined ? {} : { cwd: edge.child.cwd },
          })
          known.add(edge.child.id)
        }
      } else if (turn === undefined && !known.has(child.agent.id)) return
      const state = await snapshot()
      if (this.rootFor(child.root.id) !== child.root) return
      const canCancel = turn !== undefined && this.isCurrentTurn(child, turn)
      if (turn !== undefined) turn.canCancel = canCancel
      const cwd = child.agent.session.header.cwd
      await this.send(child.parentId, {
        sessionUpdate: 'subagent_update', sessionId: child.agent.id,
        ...cwd === undefined ? {} : { cwd },
        capabilities: canCancel ? { cancel: {} } : {},
        state,
      })
      known.add(child.agent.id)
      if (state !== null) await this.send(child.agent.id, { sessionUpdate: 'state_update', ...state })
    })
  }
}

function idleAfterTurn(reason: SessionEvent<'turn/end'>['data']['reason'], cancelRequested: boolean): IdleState {
  switch (reason.kind) {
    case 'aborted': return cancelRequested && reason.reason.kind === 'parent'
      ? { state: 'idle', stopReason: 'cancelled' }
      : unconfirmedIdle
    case 'completed': return { state: 'idle', stopReason: 'end_turn' }
    case 'max-tokens': return { state: 'idle', stopReason: 'max_tokens' }
    case 'blocked': return { state: 'idle', stopReason: 'refusal' }
    case 'error': return { state: 'idle', stopReason: 'error', error: { code: -32603, message: 'DeepSeek Harness child turn failed' } }
    default: return unconfirmedIdle
  }
}
