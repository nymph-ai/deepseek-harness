/** One standard ACP session's Agent, configuration, prompt, update, and teardown lifecycle. */

import type {} from '@deepseek-ai/dsh-fs'
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import {
  RequestError,
  type McpServer,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionNotification,
  type StopReason,
} from '@agentclientprotocol/sdk'
import type { Agent, AgentHandle, AgentOptions, AgentStatus, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, errorChain, type MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { type Session, type SessionEvent, type SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { AcpContentError, admitAcpPrompt } from './content.ts'
import { turnEndToStopReason } from './codec.ts'
import { mountAcpMcpServers } from './mcp.ts'
import { AcpModelControl } from './model-control.ts'
import { matchPromptContent } from './prompt-content.ts'
import { assistantUpdates, toolCallUpdate, toolResultUpdate } from './updates.ts'

/** Subagent completion and teardown without depending on the subagent package. */
interface SubagentLifecycle {
  /** Dispose subagent descendants below exact host-owned parents child-first. */
  drainDescendants(parents: readonly Agent[]): Promise<void>
  /** Join progressing work in the root's subagent tree without closing future admission. */
  waitForTreeWork(root: Agent): Promise<boolean>
}

/** Inputs shared by fresh and resumed ACP session construction. */
interface AcpSessionBuildOptions {
  cwd: string
  mcpServers: readonly McpServer[]
  agentOptions: AgentOptions
  signal: AbortSignal
  notify: (notification: SessionNotification) => Promise<void>
}

/** Fresh ACP session construction inputs. */
export interface CreateAcpSessionOptions extends AcpSessionBuildOptions {
  sessionId: SessionId
  /** Exact native inherited history and source reference for a fork. */
  fork?: {
    seed: readonly SessionEvent[]
    parentSource: NonNullable<CreateAgentOptions['parentSource']>
  }
}

/** Persisted ACP session construction inputs. */
export interface ResumeAcpSessionOptions extends AcpSessionBuildOptions {
  sessionId: SessionId
}

interface InflightPrompt {
  resolve: (reason: StopReason) => void
  reject: (error: Error) => void
  messageId: string | undefined
  messageQueued: boolean
  turn: number | undefined
  endReason: TurnEndReason | undefined
  admissionDone: Promise<void>
  finishAdmission: () => void
  admissionController: AbortController
  cancellationDone: PromiseWithResolvers<void>
  cancelStartedIdle: boolean
  settlementStarted: boolean
  outputError: Error | undefined
  agentError: Error | undefined
  keyed: {
    id: MessageId
    clientContent: UserMessage['clientContent']
    committed: boolean
    durable: PromiseWithResolvers<void>
  } | undefined
}

/** Standard invalid-parameter failure with protocol-safe detail. */
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/** Standard internal failure with protocol-safe detail. */
function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/**
 * Install switch notices and mount the requested MCP clients in the unpublished Agent scope.
 * @param agentCtx - unpublished Agent scope.
 * @param options - workspace and MCP servers requested for the session.
 */
async function composeAgent(agentCtx: Context, options: AcpSessionBuildOptions): Promise<void> {
  installModelSelection(agentCtx)
  await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd)
}

/**
 * Per-session ACP module. It owns the unpublished Agent composition, model
 * configuration view, one-prompt admission slot, ordered standard updates,
 * and memoized quiescent teardown.
 */
export class AcpSession {
  /** The exact top-level Agent owned by this ACP session. */
  readonly agent: Agent
  private readonly modelControl: AcpModelControl
  private outputTail = Promise.resolve()
  private inflight: InflightPrompt | undefined
  private closing: Promise<void> | undefined
  private readonly keyedInputs = new Map<MessageId, Promise<{ messageId: string } | undefined>>()
  private readonly heldPrompts = new Map<AbortController, Promise<{ messageId: string }>>()
  private foregroundTail = Promise.resolve()

  private constructor(
    private readonly ctx: Context,
    handle: AgentHandle,
    private readonly notify: (notification: SessionNotification) => Promise<void>,
  ) {
    this.agent = handle.agent
    this.modelControl = new AcpModelControl(ctx.llm, handle.agent.model)
    this.disposeAgent = () => handle.dispose()
  }

  private readonly disposeAgent: () => Promise<void>

  /**
   * Compose a fresh Agent and all requested MCP clients before publication.
   * @param ctx - ACP plugin context with Agent, LLM, and persistence services.
   * @param options - fresh session identity, workspace, route, MCP, and notifier.
   * @returns the fully composed per-session module.
   */
  static async create(ctx: Context, options: CreateAcpSessionOptions): Promise<AcpSession> {
    // The header records the canonical spelling of the workspace; see SessionHeader.cwd.
    const fs = ctx.get('fs')
    const cwd = fs === undefined ? options.cwd : fs.processPath(await fs.resolve(options.cwd, { signal: options.signal }))
    const handle = await ctx.agents.create({
      sessionId: options.sessionId,
      meta: { cwd, ...options.fork === undefined ? {} : { isSeeded: true, parentSession: options.fork.parentSource.sessionId } },
      ...options.fork === undefined ? {} : {
        seed: options.fork.seed,
        parentSource: options.fork.parentSource,
        inheritedEventCount: options.fork.parentSource.endSeq,
      },
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: agentCtx => composeAgent(agentCtx, options),
    })
    return new AcpSession(ctx, handle, options.notify)
  }

  /**
   * Restore a persisted Agent and compose the request's fresh MCP connections.
   * The Session's recorded model selection survives; deployment options supply
   * the route only when the Session records neither a selection nor a request.
   * @param ctx - ACP plugin context with Agent, LLM, and persistence services.
   * @param options - persisted identity, workspace, initial route, MCP, and notifier.
   * @returns the restored per-session module.
   */
  static async resume(ctx: Context, options: ResumeAcpSessionOptions): Promise<AcpSession> {
    const handle = await ctx.agents.resume({
      resumeSessionId: options.sessionId,
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: agentCtx => composeAgent(agentCtx, options),
    })
    return new AcpSession(ctx, handle, options.notify)
  }

  /**
   * Whether this module owns an exact Agent reference.
   * @param agent - Agent observed on a scoped runtime event.
   * @returns true only for this session's owned Agent.
   */
  owns(agent: Agent): boolean {
    return this.agent === agent
  }

  /**
   * Whether this module owns an exact Session reference.
   * @param session - Session observed on a durable event.
   * @returns true only for this session's owned Session.
   */
  ownsSession(session: Session): boolean {
    return this.agent.session === session
  }

  /** Whether this root still admits child control. */
  get isOpen(): boolean {
    return this.closing === undefined
  }

  /**
   * Return the complete standard model configuration state.
   * @param signal - optional request cancellation.
   * @returns provider-grouped model and exact-model reasoning options.
   */
  configOptions(signal?: AbortSignal): Promise<SessionConfigOption[]> {
    this.assertActive()
    return this.modelControl.options(signal)
  }

  /**
   * Apply one standard configuration option from the next model step.
   * @param configId - advertised standard option id.
   * @param value - selected standard option value.
   * @param signal - optional request cancellation.
   * @returns the complete resulting option state.
   */
  setConfig(configId: string, value: unknown, signal?: AbortSignal): Promise<SessionConfigOption[]> {
    this.assertActive()
    return this.modelControl.set(configId, value, signal)
  }

  /** Resolve topology state off-chain, then serialize its notification without blocking execution updates. */
  topologyChanged(): void {
    if (this.closing !== undefined) return
    void this.modelControl.options()
      .then((configOptions) => {
        if (this.closing !== undefined) return
        const previous = this.outputTail
        this.outputTail = previous
          .then(() => this.notify({
            sessionId: this.agent.session.id,
            update: { sessionUpdate: 'config_option_update', configOptions },
          }))
          /* v8 ignore start -- the bridge notifier contains transport failure. */
          .catch((error: unknown) => {
            this.ctx.logger.warn(`acp: config-option update failed: ${errorChain(error)}`)
          })
        /* v8 ignore stop */
      })
      /* v8 ignore start -- option discovery contains per-provider failure. */
      .catch((error: unknown) => {
        this.ctx.logger.warn(`acp: config-option update failed: ${errorChain(error)}`)
      })
    /* v8 ignore stop */
  }

  /**
   * Admit one prompt and settle after the root, descendants, and updates finish.
   * @param params - standard ACP prompt request for this session.
   * @param imageEnabled - connection capability advertised at initialization.
   * @param requestSignal - JSON-RPC request cancellation signal.
   * @param keyed - optional native message identity and its durability signal.
   * @returns the correlated standard stop reason after ordered updates drain.
   */
  async prompt(
    params: PromptRequest,
    imageEnabled: boolean,
    requestSignal?: AbortSignal,
    keyed?: InflightPrompt['keyed'],
  ): Promise<PromptResponse> {
    this.assertActive()
    if (this.inflight !== undefined) throw invalidParams('a prompt is already in flight for this session')
    const completion = Promise.withResolvers<StopReason>()
    const admission = Promise.withResolvers<void>()
    const admissionController = new AbortController()
    const inflight: InflightPrompt = {
      resolve: completion.resolve,
      reject: completion.reject,
      messageId: undefined,
      messageQueued: false,
      turn: undefined,
      endReason: undefined,
      admissionDone: admission.promise,
      finishAdmission: admission.resolve,
      admissionController,
      cancellationDone: Promise.withResolvers<void>(),
      cancelStartedIdle: false,
      settlementStarted: false,
      outputError: undefined,
      agentError: undefined,
      keyed,
    }
    this.inflight = inflight
    const onRequestAbort = (): void => { this.cancelPrompt('ACP prompt request cancelled') }
    requestSignal?.addEventListener('abort', onRequestAbort, { once: true })
    /* v8 ignore next -- the SDK dispatches a live signal, then notifies abort through its listener. */
    if (requestSignal?.aborted === true) onRequestAbort()
    try {
      let admissionFailure: unknown
      const promptSelection = this.agent.model.current()
      try {
        if (this.ctx.agents.get(this.agent.id) !== this.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const content = await admitAcpPrompt(
          this.ctx,
          promptSelection,
          params.prompt,
          imageEnabled,
          admissionController.signal,
        )
        admissionController.signal.throwIfAborted()
        if (this.ctx.agents.get(this.agent.id) !== this.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const native = createUserMessage({
          content,
          source: { kind: 'user' },
          ...(keyed?.clientContent !== undefined ? { clientContent: keyed.clientContent } : {}),
        })
        const message = keyed === undefined ? native : Object.freeze({ ...native, id: keyed.id })
        inflight.messageId = message.id
        inflight.messageQueued = true
        try {
          this.agent.followup(message)
        } catch (error: unknown) {
          inflight.messageQueued = false
          throw error
        }
      } catch (error: unknown) {
        admissionFailure = error
      } finally {
        inflight.finishAdmission()
      }

      if (inflight.admissionController.signal.aborted) {
        this.settleAfterQuiescence(inflight)
        return { stopReason: await completion.promise }
      }
      if (admissionFailure !== undefined) {
        this.inflight = undefined
        if (admissionFailure instanceof AcpContentError) {
          throw admissionFailure.kind === 'invalid'
            ? invalidParams(admissionFailure.message)
            : internalError(admissionFailure.message)
        }
        if (admissionFailure instanceof RequestError) throw admissionFailure
        throw internalError(`prompt was not queued: ${(admissionFailure as Error).message}`)
      }

      this.settleAfterQuiescence(inflight)
      return { stopReason: await completion.promise }
    } finally {
      requestSignal?.removeEventListener('abort', onRequestAbort)
    }
  }

  /**
   * Acknowledge native insertion separately from foreground settlement.
   * @param params - the prompt and the session that owns it.
   * @param key - idempotency key scoped to this native session.
   * @param imageEnabled - connection capability used during prompt admission.
   * @param persistence - durable session history used to resolve retained retries.
   * @param signal - JSON-RPC request cancellation signal.
   * @param clientContent - original ACP blocks attached to resource-bearing native prompts.
   * @param onSettled - optional callback for foreground completion of a newly inserted prompt.
   * @returns the stable receipt for a retained or newly persisted user message.
   */
  async promptWithId(
    params: PromptRequest,
    key: string,
    imageEnabled: boolean,
    persistence: SessionPersistence,
    signal: AbortSignal,
    clientContent: UserMessage['clientContent'],
    onSettled?: (reason: StopReason | 'error') => void,
  ): Promise<{ messageId: string }> {
    this.assertActive()
    const id = this.keyedMessageId(key)
    const pending = this.keyedInputs.get(id)
    if (pending !== undefined) {
      const receipt = await pending
      if (receipt !== undefined) {
        if (!await this.hasRetainedInput(id, persistence, signal, clientContent)) throw internalError('the native prompt was not retained')
        return receipt
      }
      return this.promptWithId(params, key, imageEnabled, persistence, signal, clientContent, onSettled)
    }
    const previous = this.foregroundTail
    const released = Promise.withResolvers<void>()
    this.foregroundTail = previous.then(() => released.promise)
    const hold = new AbortController()
    const heldSignal = AbortSignal.any([signal, hold.signal])
    const queued = this.submitKeyed(id, async () => {
      const cancelled = Promise.withResolvers<never>()
      const onAbort = (): void => { cancelled.reject(RequestError.requestCancelled()) }
      const assertNotCancelled = (): void => {
        if (heldSignal.aborted) throw RequestError.requestCancelled()
      }
      heldSignal.addEventListener('abort', onAbort, { once: true })
      let started = false
      try {
        assertNotCancelled()
        // Retained receipts can resolve while foreground work is active. New
        // input waits in its arrival slot until the prior prompt settles.
        if (await Promise.race([this.hasRetainedInput(id, persistence, heldSignal, clientContent), cancelled.promise])) {
          return { messageId: id }
        }
        await Promise.race([previous, cancelled.promise])
        do {
          await Promise.race([this.agent.whenIdle(), cancelled.promise])
        } while (this.agent.status !== 'idle')
        assertNotCancelled()
        this.heldPrompts.delete(hold)
        started = true
        const keyed = { id, clientContent, committed: false, durable: Promise.withResolvers<void>() }
        void this.prompt(params, imageEnabled, signal, keyed).then(({ stopReason }) => {
          if (keyed.committed) onSettled?.(stopReason)
          if (keyed.committed) return
          keyed.durable.reject(stopReason === 'cancelled'
            ? RequestError.requestCancelled()
            : internalError('the prompt settled before a native user message was committed'))
        }, (error: unknown) => {
          if (keyed.committed) onSettled?.('error')
          if (!keyed.committed) keyed.durable.reject(error)
        }).finally(released.resolve)
        await keyed.durable.promise
        return { messageId: id }
      } finally {
        heldSignal.removeEventListener('abort', onAbort)
        if (!started) released.resolve()
      }
    }).finally(() => { this.heldPrompts.delete(hold) })
    this.heldPrompts.set(hold, queued)
    return queued
  }

  /**
   * Deliver input to the accepting native turn and wait for its durable message.
   * @param params - the steering content and the session that owns it.
   * @param key - idempotency key scoped to this native session.
   * @param persistence - durable history for retained retries.
   * @param signal - JSON-RPC request cancellation before turn admission.
   * @returns the retained receipt, or undefined when the turn did not accept input.
   */
  async steerWithId(
    params: PromptRequest,
    key: string,
    persistence: SessionPersistence,
    signal: AbortSignal,
  ): Promise<{ messageId: string } | undefined> {
    this.assertActive()
    const id = this.keyedMessageId(key)
    const pending = this.keyedInputs.get(id)
    if (pending !== undefined) {
      const receipt = await pending
      if (receipt !== undefined && !await this.hasRetainedInput(id, persistence, signal)) {
        throw internalError('the native prompt was not retained')
      }
      return receipt
    }
    const inject = this.agent.runningTurnInjector?.()
    return this.submitKeyed(id, async () => {
      if (await this.hasRetainedInput(id, persistence, signal)) return { messageId: id }
      if (inject === undefined) return undefined
      const content = await admitAcpPrompt(this.ctx, this.agent.model.current(), params.prompt, false, signal)
      signal.throwIfAborted()
      const message = Object.freeze({ ...createUserMessage({ content, source: { kind: 'user' } }), id })
      if (!await inject(message)) return undefined
      if (!await this.ctx.sessions.flush(this.agent.session)) throw internalError('no session durability listener is available')
      return { messageId: id }
    })
  }

  private keyedMessageId(key: string): MessageId {
    return brandString<MessageId>('acp-prompt-v2:' + createHash('sha256')
      .update(JSON.stringify([this.agent.session.id, key])).digest('hex'))
  }

  private async hasRetainedInput(
    id: MessageId, persistence: SessionPersistence, signal: AbortSignal, clientContent?: UserMessage['clientContent'],
  ): Promise<boolean> {
    signal.throwIfAborted()
    const session = this.agent.session
    if (!await this.ctx.sessions.flush(session)) throw internalError('no session durability listener is available')
    signal.throwIfAborted()
    const reader = await persistence.open(session.id, 'read', { signal })
    try {
      const { events } = await reader.read(0, undefined, { signal })
      const event = events.find(event => event.type === 'user/message' && event.data.id === id)
      if (event?.type === 'user/message') {
        matchPromptContent(event.data.clientContent, clientContent)
        return true
      }
      for (const event of events) {
        if (event.type !== 'agent/inbox/spliced') continue
        const admitted = event.data.inserted.find(message => message.id === id)
        if (admitted === undefined || (admitted.clientContent === undefined && clientContent === undefined)) continue
        matchPromptContent(admitted.clientContent, clientContent)
        throw new RequestError(-32000, 'The native DeepSeek Harness inbox admitted this typed prompt before insertion.', {
          kind: 'dsh_prompt_dispatch_unknown',
        })
      }
      return false
    } finally {
      await reader.close()
    }
  }

  private submitKeyed<T extends { messageId: string } | undefined>(id: MessageId, submit: () => Promise<T>): Promise<T> {
    const pending = submit().finally(() => { this.keyedInputs.delete(id) })
    this.keyedInputs.set(id, pending)
    return pending
  }

  /** Cancel the active prompt, or autonomous work when no ACP prompt exists. */
  cancel(): void {
    void this.dropHeldPrompts()
    const inflight = this.inflight
    this.cancelPrompt('ACP prompt cancelled')
    if (inflight === undefined) this.agent.cancel({ kind: 'user' })
  }

  /**
   * Process one durable event and enqueue its standard ACP projections.
   * @param session - exact event-owning Session.
   * @param event - committed durable event.
   * @param legacyTools - include tool updates from the v1 projection.
   */
  onSessionEvent(session: Session, event: SessionEvent, legacyTools = true): void {
    const keyed = this.inflight?.keyed
    if (keyed !== undefined && !keyed.committed && event.type === 'user/message' && event.data.id === keyed.id) {
      keyed.committed = true
      void Promise.resolve().then(async () => {
        if (!await this.ctx.sessions.flush(session)) throw internalError('no session durability listener is available')
        matchPromptContent(event.data.clientContent, keyed.clientContent)
      }).then(keyed.durable.resolve, keyed.durable.reject)
    }
    if (event.type === 'turn/start' && this.inflight?.turn !== undefined) {
      this.inflight.turn = event.data.turn
      this.inflight.endReason = undefined
    }
    try {
      if (event.type === 'assistant/message') {
        const inflight = this.inflight?.turn === event.data.turn ? this.inflight : undefined
        const previous = this.outputTail
        const delivery = previous.then(async () => {
          for (const update of await assistantUpdates(this.ctx, session, event)) {
            await this.notify({ sessionId: this.agent.session.id, update })
          }
        })
        this.outputTail = delivery.catch((error: unknown) => {
          const failure = error as Error
          if (inflight !== undefined) inflight.outputError ??= failure
          this.ctx.logger.warn(`acp: assistant output conversion failed: ${errorChain(error)}`)
        })
      } else if (legacyTools && event.type === 'tool/call') {
        const previous = this.outputTail
        this.outputTail = previous
          .then(() => this.notify({ sessionId: this.agent.session.id, update: toolCallUpdate(event) }))
          /* v8 ignore start -- the bridge notifier contains transport rejection. */
          .catch((error: unknown) => {
            this.ctx.logger.warn(`acp: tool-call update delivery failed: ${errorChain(error)}`)
          })
        /* v8 ignore stop */
      } else if (legacyTools && event.type === 'tool/result') {
        const previous = this.outputTail
        this.outputTail = previous
          .then(async () => this.notify({
            sessionId: this.agent.session.id,
            update: await toolResultUpdate(this.ctx, event),
          }))
          /* v8 ignore start -- supplemental-content conversion failure is contained and cannot fail Agent work. */
          .catch((error: unknown) => {
            this.ctx.logger.warn(`acp: tool-result update delivery failed: ${errorChain(error)}`)
          })
        /* v8 ignore stop */
      }
    } finally {
      const inflight = this.inflight
      if (inflight !== undefined && event.type === 'turn/end' && inflight.turn === event.data.turn) {
        inflight.endReason = event.data.reason
        inflight.agentError = undefined
      }
    }
  }

  /**
   * Correlate an accepted user message with its Agent turn.
   * @param message - claimed durable inbox message.
   * @param turn - allocated Agent turn.
   */
  onInboxClaimed(message: UserMessage, turn: number): void {
    if (this.inflight !== undefined && this.inflight.messageId === message.id) this.inflight.turn = turn
  }

  /**
   * Correlate an Agent interval failure with the active ACP prompt.
   * @param error - original same-process failure.
   */
  onAgentError(error: unknown): void {
    const inflight = this.inflight
    if (inflight === undefined || !inflight.messageQueued) return
    // A later committed turn/end supersedes this live failure. Failed turn
    // start/end appends have no terminal record and keep the failure observable.
    inflight.agentError = new Error(errorChain(error))
    this.settleAfterQuiescence(inflight)
  }

  /**
   * Complete cancelled activity without following a later root driver.
   * @param status - the emitted transition, which may precede a reentrant wake.
   */
  onAgentStatus(status: AgentStatus): void {
    const inflight = this.inflight
    if (inflight === undefined || !inflight.messageQueued || !inflight.admissionController.signal.aborted) return
    // Maintenance remains publicly idle; its next running transition belongs
    // to work released after the maintenance task finished.
    if (status === 'idle' || inflight.cancelStartedIdle) inflight.cancellationDone.resolve(this.outputTail)
  }

  /** Await every update queued before this call. */
  drainUpdates(): Promise<void> {
    return this.outputTail
  }

  /**
   * Cancel, drain, flush, and dispose this session once.
   * @param detail - cancellation detail for any prompt still in admission.
   * @returns the shared quiescent teardown promise.
   */
  close(detail: string): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closing = (async () => {
      const failures: unknown[] = []
      const inflight = this.inflight
      const held = this.dropHeldPrompts()
      this.cancelPrompt(detail)
      if (inflight === undefined || !inflight.messageQueued) this.agent.cancel({ kind: 'user' })
      try {
        await held
        await inflight?.admissionDone
        await this.agent.whenIdle()
        await this.outputTail
      } catch (error: unknown) {
        failures.push(new Error('ACP session activity drain failed', { cause: error }))
      }
      const subagents = this.ctx.get('subagents') as SubagentLifecycle | undefined
      try {
        await subagents?.drainDescendants([this.agent])
      } catch (error: unknown) {
        this.ctx.logger.warn(`acp: subagent teardown failed: ${errorChain(error)}`)
        failures.push(new Error('subagent teardown failed', { cause: error }))
      }
      try {
        await this.ctx.sessions.flush(this.agent.session)
      } catch (error: unknown) {
        failures.push(new Error('ACP session persistence flush failed', { cause: error }))
      }
      try {
        await this.disposeAgent()
      } catch (error: unknown) {
        failures.push(error)
      }
      if (failures.length === 1) throw failures[0]
      /* v8 ignore start -- independent teardown failures can aggregate only under multiple simultaneous provider faults. */
      if (failures.length > 1) {
        throw new AggregateError(failures, `ACP session teardown failed: ${failures.map(errorChain).join('; ')}`)
      }
      /* v8 ignore stop */
    })()
    return this.closing
  }

  private async dropHeldPrompts(): Promise<void> {
    const held = [...this.heldPrompts]
    for (const [controller] of held) controller.abort()
    await Promise.allSettled(held.map(([, pending]) => pending))
  }

  private assertActive(): void {
    if (this.closing !== undefined) throw invalidParams(`session is closing: ${this.agent.session.id}`)
  }

  private cancelPrompt(detail: string): void {
    const inflight = this.inflight
    if (inflight === undefined) return
    const firstCancellation = !inflight.admissionController.signal.aborted
    if (firstCancellation) inflight.cancelStartedIdle = this.agent.status === 'idle'
    inflight.admissionController.abort(new Error(detail))
    this.settleAfterQuiescence(inflight)
    if (!inflight.messageQueued) {
      inflight.cancellationDone.resolve()
      return
    }
    this.agent.cancel({ kind: 'user' })
    if (firstCancellation) {
      const done = inflight.cancellationDone
      // Plugin disposal can detach status observers before this activity retires.
      void this.agent.whenIdle().then(() => { done.resolve(this.outputTail) }, done.reject)
    }
  }

  private settleAfterQuiescence(inflight: InflightPrompt): void {
    if (inflight.settlementStarted) return
    inflight.settlementStarted = true
    void (async () => {
      await inflight.admissionDone
      if (inflight.messageQueued) {
        const subagents = this.ctx.get('subagents') as SubagentLifecycle | undefined
        const cancelled = inflight.cancellationDone.promise
        const isCancelled = (): boolean => inflight.admissionController.signal.aborted
        const idleAt = (seq: Session['seq']): boolean => this.agent.status === 'idle' && this.agent.session.seq === seq
        while (true) {
          await Promise.race([this.agent.whenIdle(), cancelled])
          if (isCancelled()) break
          const idleSeq = this.agent.session.seq
          const children = await Promise.race([subagents?.waitForTreeWork(this.agent), cancelled])
          if (isCancelled()) break
          if (children || !idleAt(idleSeq)) continue
          await this.outputTail
          if (isCancelled() || idleAt(idleSeq)) break
        }
        if (isCancelled()) await cancelled
      }
      /* v8 ignore next -- this prompt owns the slot until this exact settlement clears it. */
      if (this.inflight !== inflight) return
      this.inflight = undefined
      if (inflight.admissionController.signal.aborted) {
        inflight.resolve('cancelled')
        return
      }
      if (inflight.outputError !== undefined) {
        inflight.reject(internalError(`assistant output delivery failed: ${inflight.outputError.message}`))
        return
      }
      if (inflight.agentError !== undefined) {
        inflight.reject(internalError(`turn failed: ${inflight.agentError.message}`))
        return
      }
      const end = inflight.endReason
      if (end === undefined) {
        inflight.resolve('cancelled')
      } else if (end.kind === 'error') {
        inflight.reject(internalError(`turn failed: ${end.error.message}`))
      } else {
        inflight.resolve(turnEndToStopReason(end))
      }
    })()
      /* v8 ignore start -- admissionDone only resolves; idle/output gates contain their own failures. */
      .catch((error: unknown) => {
        if (this.inflight !== inflight) return
        this.inflight = undefined
        inflight.reject(internalError(`prompt settlement failed: ${errorChain(error)}`))
      })
    /* v8 ignore stop */
  }
}
