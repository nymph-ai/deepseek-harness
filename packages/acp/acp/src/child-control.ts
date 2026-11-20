/** ACP v2 activity for directly owned, in-process DSH subagents. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import type { SessionUpdate, StateUpdate } from 'acp-v2-sdk/experimental/v2/unstable'

type IdleState = Extract<StateUpdate, { state: 'idle' }>
const unconfirmedIdle: IdleState = { state: 'idle', stopReason: null }

interface LiveChild {
  readonly runId: SubagentRunInfo['runId']
  readonly parent: Agent
  readonly agent: Agent
  turn: { number: number; cancelRequested: boolean } | undefined
  ending: IdleState | undefined
  announced: boolean
}

type SendActivity = (parent: SessionId, send: () => Promise<void>) => void
type SendUpdate = (session: SessionId, update: SessionUpdate) => Promise<void>

/** Correlate a child's native activation, live turn, and committed terminal event. */
export class V2ChildControl {
  private readonly children = new Map<SessionId, LiveChild>()

  /**
   * Observe only the exact runtime descendants of this connection's active roots.
   * @param ctx - ACP bridge context with access to the native agent registry.
   * @param parentFor - lookup of the bridge-owned root, excluding closing roots.
   * @param enqueue - serialize child activity against the root's wire updates.
   * @param send - write one session update to the negotiated v2 client.
   */
  constructor(
    private readonly ctx: Context,
    parentFor: (id: SessionId) => Agent | undefined,
    private readonly enqueue: SendActivity,
    private readonly send: SendUpdate,
  ) {
    ctx.on('subagent/start', (run) => {
      const parent = parentFor(run.parentSessionId)
      const agent = ctx.agents.get(run.id)
      if (!run.local || parent === undefined || agent?.runningTurnInjector === undefined || ctx.agents.get(parent.id) !== parent
        || agent.session.header.origin !== 'subagent' || agent.session.header.parentSession !== parent.id) return
      if (ctx.get('subagents')?.rootOf(agent) !== parent) return
      this.children.set(run.id, { runId: run.runId, parent, agent, turn: undefined, ending: undefined, announced: false })
    })
    ctx.on('subagent/end', (run) => {
      const child = this.children.get(run.id)
      if (child?.runId !== run.runId) return
      this.children.delete(run.id)
      if (child.announced) this.publish(child, () => null, false)
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
      this.publish(child, async () => ending !== undefined && await durable ? ending : unconfirmedIdle, false)
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
    if (child === undefined || turn === undefined || turn.cancelRequested || subagents === undefined
      || this.ctx.agents.get(id) !== child.agent || this.ctx.agents.get(child.parent.id) !== child.parent
      || child.agent.runningTurnInjector?.() === undefined) return
    // The active intake excludes a turn another controller already aborted.
    subagents.interrupt(id, { kind: 'ancestor', agent: child.parent })
    turn.cancelRequested = true
  }

  /**
   * Remove the root's live capabilities as soon as close begins.
   * @param parent - exact root session starting close.
   */
  detach(parent: SessionId): void {
    for (const [id, child] of this.children) {
      if (child.parent.id === parent) this.children.delete(id)
    }
  }

  private observeTurn(session: Session, event: SessionEvent): void {
    const child = this.children.get(session.id)
    if (child?.agent.session !== session) return
    if (event.type === 'turn/start') {
      child.turn = { number: event.data.turn, cancelRequested: false }
      child.ending = undefined
      child.announced = true
      this.publish(child, () => ({ state: 'running' }), true)
    } else if (event.type === 'turn/end' && child.turn?.number === event.data.turn) {
      child.ending = idleAfterTurn(event.data.reason, child.turn.cancelRequested)
      child.turn = undefined
    }
  }

  private publish(child: LiveChild, snapshot: () => StateUpdate | null | Promise<StateUpdate>, canCancel: boolean): void {
    this.enqueue(child.parent.id, async () => {
      const state = await snapshot()
      const cwd = child.agent.session.header.cwd
      await this.send(child.parent.id, {
        sessionUpdate: 'subagent_update', sessionId: child.agent.id,
        ...cwd === undefined ? {} : { cwd },
        capabilities: canCancel ? { cancel: {} } : {},
        state,
      })
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
