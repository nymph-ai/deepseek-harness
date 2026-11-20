/**
 * Automation-only Agent Client Protocol server over JSON-RPC stdio.
 *
 * The bridge exposes persistent harness sessions to trusted programmatic
 * clients. It carries standard configuration, MCP mounts, prompt content,
 * committed semantic updates, cancellation, and one-shot permission decisions;
 * presentation and human-interaction features stay with the harness's UI modules.
 *
 * @module @deepseek-ai/dsh-acp
 */

import type { Context } from '@deepseek-ai/cordis'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { errorChain } from '@deepseek-ai/dsh-llm'
import {
  agent as createAcpAgentApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentContext,
  type AuthenticateRequest,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SessionNotification,
  type SessionConfigOption,
  type Stream,
} from '@agentclientprotocol/sdk'
import * as v2 from 'acp-v2-sdk/experimental/v2/unstable'
import { buildForkSeed, SessionLogOffset, type SessionEvent, type SessionId, type SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
// Side-effect type import: declaration-merges the approval waterfall answered below.
import type {} from '@deepseek-ai/dsh-user-approval'
import { supportsAcpImagePrompts } from './content.ts'
import { AcpMcpConfigError } from './mcp.ts'
import { AcpModelConfigError } from './model-control.ts'
import { retainPromptContent, storedPromptContent } from './prompt-content.ts'
import { AcpSession, type CreateAcpSessionOptions } from './session.ts'
import { cursorAfter, cursorKey, FABRIC_CURSOR_REPLAY } from './cursors.ts'
import { V2ToolUpdates } from './updates.ts'

const DEFAULT_SESSION_LIST_PAGE_SIZE = 100

export const name = 'acp'
/** Core services required by the standard automation controls. */
export const inject = ['agents', 'llm', 'sessionPersistence', 'sessions']

/** Preserve invalid-parameter detail in the SDK wire error message. */
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/** Preserve failed-turn detail; plain handler errors become a generic wire internal error. */
function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

function parseKeyedPrompt(value: unknown): PromptRequest & { idempotencyKey: string } {
  if (typeof value !== 'object' || value === null || !('sessionId' in value)
    || typeof value.sessionId !== 'string' || !('idempotencyKey' in value) || typeof value.idempotencyKey !== 'string'
    || value.idempotencyKey.length === 0 || Array.from(value.idempotencyKey).length > 255 || !('prompt' in value)
    || !Array.isArray(value.prompt) || value.prompt.length === 0) {
    throw invalidParams('expected a sessionId, 1–255 character idempotencyKey, and a nonempty prompt')
  }
  return {
    sessionId: value.sessionId,
    idempotencyKey: value.idempotencyKey,
    prompt: value.prompt.map((block: unknown) => {
      if (typeof block === 'object' && block !== null && 'type' in block) {
        if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
          return { type: 'text', text: block.text }
        }
        if (block.type === 'resource_link' && 'name' in block && typeof block.name === 'string'
          && 'uri' in block && typeof block.uri === 'string') {
          return { type: 'resource_link', name: block.name, uri: block.uri }
        }
      }
      throw invalidParams('the ACP v2 preview accepts text and resource links')
    }),
  }
}

function parseSteering(value: unknown): ReturnType<typeof parseKeyedPrompt> {
  if (typeof value !== 'object' || value === null) throw invalidParams('expected steering parameters')
  const meta = '_meta' in value ? value._meta : undefined
  const steering = typeof meta === 'object' && meta !== null && 'steering' in meta ? meta.steering : undefined
  if (steering === undefined) return parseKeyedPrompt({ ...value, idempotencyKey: randomUUID() })
  if (typeof steering !== 'object' || steering === null
    || ('idleBehavior' in steering && steering.idleBehavior !== 'promptRequired')) {
    throw invalidParams('unsupported steering idle behavior')
  }
  const key = 'idempotencyKey' in steering ? steering.idempotencyKey : randomUUID()
  return parseKeyedPrompt({ ...value, idempotencyKey: key })
}

async function v2Result<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error: unknown) {
    if (error instanceof RequestError) throw new v2.RequestError(error.code, error.message, error.data)
    throw error
  }
}

function v2Config(options: SessionConfigOption[] | null | undefined): v2.SessionConfigOption[] {
  return (options ?? []).flatMap((option) => {
    if (option.type !== 'select') return []
    const { id, options, ...fields } = option
    return [{
      ...fields,
      configId: id,
      options: options.map((value) => {
        if (!('group' in value)) return value
        const { group, ...details } = value
        return { groupId: group, ...details }
      }) as v2.SessionConfigSelectOptions,
    }]
  })
}

function v2Message(event: SessionEvent): Extract<v2.SessionUpdate, { sessionUpdate: 'user_message' | 'agent_message' }> | undefined {
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return undefined
  if (event.type === 'user/message' && event.data.source.kind !== 'user') return undefined
  const message = event.type === 'user/message' ? event.data : event.data.message
  const original = event.type === 'user/message' ? storedPromptContent(event.data.clientContent) : undefined
  const content = original ?? message.content.flatMap(block => block.type === 'text'
    ? [{ type: 'text' as const, text: block.text }]
    : [])
  return event.type === 'user/message'
    ? { sessionUpdate: 'user_message', messageId: message.id, content }
    : { sessionUpdate: 'agent_message', messageId: message.id, content }
}

function v2Settlement(reason: PromptResponse['stopReason'] | 'error'): v2.SessionUpdate {
  const idle = { sessionUpdate: 'state_update', state: 'idle' } as const
  switch (reason) {
    case 'error':
      return { ...idle, stopReason: 'error', error: { code: -32603, message: 'DeepSeek Harness turn failed' } }
    case 'cancelled':
      return { ...idle, stopReason: 'cancelled' }
    case 'max_tokens':
      return { ...idle, stopReason: 'max_tokens' }
    case 'refusal':
      return { ...idle, stopReason: 'refusal' }
    default:
      return { ...idle, stopReason: 'end_turn' }
  }
}

/** Plugin config: the provider/model selection used for each ACP-created agent. */
export interface AcpConfig {
  /** Provider route for created agents. */
  provider?: string
  /** Model name for created agents. */
  model?: string
  /** Maximum summaries returned by one session/list page. */
  sessionListPageSize?: number
  /** Opt in to the text-focused ACP v2 preview alongside ACP v1. */
  protocolV2?: boolean
  /** Absolute persistent signing key path to enable native ACP v2 cursors. */
  cursorSigningKeyFile?: string
  /** Runtime-only transport override; production uses stdio. */
  stream?: Stream
}

export const Config: Schema<AcpConfig> = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
  sessionListPageSize: Schema.natural().min(1).default(DEFAULT_SESSION_LIST_PAGE_SIZE),
  protocolV2: Schema.boolean().default(false),
  cursorSigningKeyFile: Schema.string(),
})

/**
 * Mount the automation-only ACP server.
 * @param ctx - Cordis context carrying the agent factory and session events.
 * @param config - Initial provider/model selection and optional test transport.
 */
export function apply(ctx: Context, config: AcpConfig): void {
  // ACP handlers execute outside this plugin's injection scope, so capture the
  // injected service during apply rather than reading it lazily in a callback.
  const persistence = ctx.sessionPersistence
  const logger = ctx.logger
  const sessionListPageSize = resolveSessionListPageSize(config.sessionListPageSize)
  const sessions = new Map<SessionId, AcpSession>()
  const activating = new Set<SessionId>()
  let closed = false
  let imagePromptEnabled = false
  let v2Client: v2.AgentContext | undefined
  const v2Updates = new Map<SessionId, Promise<void>>()
  const v2Tools = new Map<SessionId, V2ToolUpdates>()
  const signingKey = config.protocolV2 === true && config.cursorSigningKeyFile !== undefined
    ? cursorKey(config.cursorSigningKeyFile)
    : undefined

  const sendV2 = async (sessionId: SessionId, update: v2.SessionUpdate): Promise<void> => {
    await v2Client?.notify(v2.methods.client.session.update, { sessionId, update })
  }


  const enqueueV2 = (sessionId: SessionId, send: () => Promise<void>): Promise<void> => {
    const tail = v2Updates.get(sessionId) ?? Promise.resolve()
    const sent = tail.then(send)
    v2Updates.set(sessionId, sent.catch((error: unknown) => {
      logger.warn(`acp v2: session/update failed: ${String(error)}`)
    }))
    return sent
  }

  const notifyV2 = (sessionId: SessionId, update: v2.SessionUpdate): Promise<void> =>
    enqueueV2(sessionId, () => sendV2(sessionId, update))

  const readHistory = async (sessionId: SessionId, cwd: string, signal: AbortSignal): Promise<readonly SessionEvent[]> => {
    const header = (await persistence.stat(sessionId, { signal }))?.header
    if (header === undefined || header.origin === 'subagent' || !await sameDirectory(header.cwd, cwd)) {
      throw invalidParams(`session has no retained history in this cwd: ${sessionId}`)
    }
    const live = sessions.get(sessionId)?.agent.session
    if (live !== undefined && !await ctx.sessions.flush(live)) {
      throw internalError('no session durability listener is available')
    }
    const reader = await persistence.open(sessionId, 'read', { signal })
    try {
      return (await reader.read(0, undefined, { signal })).events
    } finally {
      await reader.close()
    }
  }

  const resolveCursor = (sessionId: SessionId, events: readonly SessionEvent[], id: string): SessionSeq => {
    if (signingKey !== undefined) {
      for (const event of events) {
        if (cursorAfter(signingKey, sessionId, event)?.cursorId === id) return event.seq
      }
    }
    throw invalidParams('unrecognized or stale cursor for this DSH session')
  }

  /** Return the bridge-owned record for an agent, rejecting same-id impostors. */
  const ownedRecord = (agent: Parameters<AcpSession['owns']>[0]): AcpSession | undefined => {
    const record = sessions.get(agent.session.id)
    return record?.owns(agent) === true ? record : undefined
  }

  const assertOpen = (): void => {
    if (closed) throw internalError('the ACP bridge has been disposed')
  }

  const requireSession = (sessionId: SessionId): AcpSession => {
    const record = sessions.get(sessionId)
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
    return record
  }

  /** Send one ordered protocol update while containing transport-only failure. */
  const notify = async (notification: SessionNotification): Promise<void> => {
    try {
      if (v2Client !== undefined) {
        const { update } = notification
        const id = brandString<SessionId>(notification.sessionId)
        if (update.sessionUpdate === 'config_option_update') {
          await notifyV2(id, { sessionUpdate: 'config_option_update', configOptions: v2Config(update.configOptions) })
        } else if (update.sessionUpdate === 'usage_update') {
          await notifyV2(id, update)
        }
        return
      }
      await conn.notify(methods.client.session.update, notification)
    /* v8 ignore start -- the ACP SDK contains notification-handler failures; only a transport write failure reaches this guard. */
    } catch (error: unknown) {
      logger.warn(`acp: session/update failed: ${String(error)}`)
    }
    /* v8 ignore stop */
  }

  ctx.on('session/event', (session, event) => {
    const record = sessions.get(session.header.id)
    if (record?.ownsSession(session) !== true) return
    record.onSessionEvent(session, event, v2Client === undefined)
    if (v2Client !== undefined) {
      if (event.type === 'turn/start') {
        v2Tools.set(session.id, new V2ToolUpdates())
        void notifyV2(session.header.id, { sessionUpdate: 'state_update', state: 'running' }).catch(() => {})
      }
      const update = v2Message(event)
      const tool = v2Tools.get(session.id)?.observe(ctx, event)
      if (event.type === 'turn/end') v2Tools.delete(session.id)
      if (update === undefined && tool === undefined) return
      void enqueueV2(session.id, async () => {
        if (tool !== undefined) {
          await sendV2(session.id, await tool())
          return
        }
        if (update !== undefined) await sendV2(session.id, update)
        const cursor = signingKey === undefined ? undefined : cursorAfter(signingKey, session.id, event)
        if (cursor !== undefined && await ctx.sessions.flush(session)) await sendV2(session.id, cursor)
      }).catch(() => {})
    }
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    ownedRecord(agent)?.onInboxClaimed(message, turn)
  })

  ctx.on('agent/error', ({ agent, error }) => {
    ownedRecord(agent)?.onAgentError(error)
  })

  ctx.on('agent/status', ({ agent, status }) => {
    ownedRecord(agent)?.onAgentStatus(status)
  })

  ctx.on('llm/adapters-updated', () => {
    for (const record of sessions.values()) record.topologyChanged()
  })

  // Permission requests are a machine policy channel for ACP clients such as
  // dsh-subagent-acp. The bridge offers one-shot choices only and never infers a
  // durable grant from an unknown client response.
  ctx.on('approval/request', (request, next) => {
    const record = ownedRecord(request.agent)
    if (record === undefined || request.callId === undefined) return next()
    const callId = request.callId
    return record.drainUpdates().then(async () => {
      const params: RequestPermissionRequest = {
        sessionId: record.agent.session.id,
        toolCall: { toolCallId: callId },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      }
      let response
      if (v2Client !== undefined) {
        await v2Updates.get(record.agent.session.id)
        const toolCallId = v2Tools.get(record.agent.session.id)?.forApproval(callId)
        if (toolCallId === undefined) return 'rejected'
        response = await v2Client.request(v2.methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          title: 'DeepSeek Harness requests permission',
          subject: { type: 'tool_call', toolCall: { toolCallId } },
          options: params.options,
        })
      } else {
        response = await conn.request(methods.client.session.requestPermission, params)
      }
      const { outcome } = response
      if (outcome.outcome === 'cancelled') return 'cancelled'
      return 'optionId' in outcome && outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
    })
  })

  const implementation = {
    async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
      // Single-version agent: the spec's "same version if supported, else
      // the latest supported" both resolve to this server's one version.
      imagePromptEnabled = await supportsAcpImagePrompts(ctx, config.provider, config.model)
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
        agentCapabilities: {
          mcpCapabilities: { http: true },
          promptCapabilities: { image: imagePromptEnabled, audio: false, embeddedContext: false },
          sessionCapabilities: { close: {}, list: {}, resume: {} },
        },
        authMethods: [],
      }
    },

    authenticate(_params: AuthenticateRequest): Promise<void> {
      return Promise.resolve()
    },

    async newSession(
      params: NewSessionRequest, signal: AbortSignal, fork?: CreateAcpSessionOptions['fork'],
    ): Promise<NewSessionResponse> {
      assertOpen()
      validateWorkspaceParams(params)
      const sessionId = brandString<SessionId>(randomUUID())
      // No preset composition: the ACP bundle keeps the model-facing rows in
      // the host plane, so this agent reads them from the global layer. A
      // deployment that configures a roster has to join one here first
      // (@deepseek-ai/dsh-agent-preset-registry README, "Composing a child agent").
      let record: AcpSession
      try {
        record = await AcpSession.create(ctx, {
          sessionId,
          cwd: params.cwd,
          mcpServers: params.mcpServers,
          agentOptions: agentOptions(config),
          ...fork === undefined ? {} : { fork },
          signal,
          notify,
        })
      } catch (error: unknown) {
        if (error instanceof AcpMcpConfigError) throw invalidParams(error.message)
        throw error
      }
      /* v8 ignore next 4 -- a real stdio close can race an in-flight create. */
      if (closed) {
        await record.close('connection closed during session/new')
        throw internalError('connection closed during session/new')
      }
      sessions.set(sessionId, record)
      try {
        const configOptions = await record.configOptions(signal)
        assertOpen()
        // The attached log writer's flush materializes an empty session durably.
        await ctx.sessions.flush(record.agent.session)
        assertOpen()
        return { sessionId, configOptions }
      } catch (error: unknown) {
        sessions.delete(sessionId)
        await record.close('session/new activation failed')
        throw error
      }
    },

    async resumeSession(params: ResumeSessionRequest, signal: AbortSignal): Promise<ResumeSessionResponse> {
      assertOpen()
      validateWorkspaceParams(params)
      const sessionId = brandString<SessionId>(params.sessionId)
      if (sessions.has(sessionId) || activating.has(sessionId) || ctx.sessions.get(sessionId) !== undefined) {
        throw invalidParams(`session is already active: ${sessionId}`)
      }
      activating.add(sessionId)
      return (async (): Promise<ResumeSessionResponse> => {
        const persisted = (await persistence.stat(sessionId, { signal }))?.header
        if (persisted === undefined || persisted.origin === 'subagent') {
          throw invalidParams(`session is not resumable: ${sessionId}`)
        }
        if (!await sameDirectory(persisted.cwd, params.cwd)) {
          throw invalidParams(`session cwd does not match: ${params.cwd}`)
        }
        let record: AcpSession
        try {
          record = await AcpSession.resume(ctx, {
            sessionId,
            cwd: params.cwd,
            mcpServers: params.mcpServers ?? [],
            agentOptions: agentOptions(config),
            signal,
            notify,
          })
        } catch (error: unknown) {
          if (error instanceof AcpMcpConfigError) throw invalidParams(error.message)
          throw error
        }
        /* v8 ignore start -- the persisted header was checked before resume; the factory restores that exact header. */
        if (!await sameDirectory(record.agent.session.header.cwd, params.cwd)) {
          await record.close('session/resume cwd mismatch')
          throw invalidParams(`session cwd does not match: ${params.cwd}`)
        }
        /* v8 ignore stop */
        /* v8 ignore next 4 -- a real stdio close can race an in-flight resume. */
        if (closed) {
          await record.close('connection closed during session/resume')
          throw internalError('connection closed during session/resume')
        }
        sessions.set(sessionId, record)
        try {
          return { configOptions: await record.configOptions(signal) }
        } catch (error: unknown) {
          sessions.delete(sessionId)
          await record.close('session/resume option discovery failed')
          throw error
        }
      })().finally(() => { activating.delete(sessionId) })
    },

    async listSessions(params: ListSessionsRequest, signal: AbortSignal): Promise<ListSessionsResponse> {
      assertOpen()
      if (params.cwd !== undefined && params.cwd !== null && !isAbsolute(params.cwd)) {
        throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
      }
      let cursor: SessionListCursor | undefined
      try {
        cursor = decodeSessionListCursor(params.cursor)
      } catch (error: unknown) {
        throw invalidParams((error as Error).message)
      }
      const listed = await persistence.list({ signal })
      const filtered = await Promise.all(listed.map(async ({ header }) => {
        if (
          sessions.has(header.id)
            || activating.has(header.id)
            || ctx.sessions.get(header.id) !== undefined
            || header.origin === 'subagent'
            || header.cwd === undefined
            || !isAbsolute(header.cwd)
        ) return undefined
        if (params.cwd !== undefined && params.cwd !== null && !await sameDirectory(header.cwd, params.cwd)) {
          return undefined
        }
        return { sessionId: header.id, cwd: header.cwd, createdAt: header.createdAt }
      }))
      const entries = filtered
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
        .sort((left, right) => right.createdAt - left.createdAt || compareSessionIds(left.sessionId, right.sessionId))
      const remaining = cursor === undefined
        ? entries
        : entries.filter(entry => isAfterSessionListCursor(entry, cursor))
      const page = remaining.slice(0, sessionListPageSize)
      const next = remaining.length > page.length ? page.at(-1) : undefined
      return {
        sessions: page.map(({ sessionId, cwd }) => ({ sessionId, cwd })),
        ...next === undefined ? {} : { nextCursor: encodeSessionListCursor(next) },
      }
    },

    async setSessionConfigOption(
      params: SetSessionConfigOptionRequest,
      signal: AbortSignal,
    ): Promise<SetSessionConfigOptionResponse> {
      assertOpen()
      const record = requireSession(brandString<SessionId>(params.sessionId))
      try {
        return { configOptions: await record.setConfig(params.configId, params.value, signal) }
      } catch (error: unknown) {
        if (error instanceof AcpModelConfigError) throw invalidParams(error.message)
        throw error
      }
    },

    async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
      assertOpen()
      const sessionId = brandString<SessionId>(params.sessionId)
      const record = requireSession(sessionId)
      try {
        await record.close('ACP session closed')
      } catch (error: unknown) {
        throw internalError(`session close failed: ${errorChain(error)}`)
      } finally {
        if (sessions.get(sessionId) === record) sessions.delete(sessionId)
      }
      return {}
    },

    async prompt(params: PromptRequest, requestSignal: AbortSignal): Promise<PromptResponse> {
      assertOpen()
      const record = requireSession(brandString<SessionId>(params.sessionId))
      return record.prompt(params, imagePromptEnabled, requestSignal)
    },

    cancel(params: CancelNotification): Promise<void> {
      sessions.get(brandString<SessionId>(params.sessionId))?.cancel()
      return Promise.resolve()
    },
  }

  /* v8 ignore next 4 -- production stdio wiring; tests inject config.stream. */
  const stream: Stream = config.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
  const app = createAcpAgentApp({ name: 'deepseek-harness-acp' })
    .onRequest(methods.agent.initialize, ({ params }) => implementation.initialize(params))
    .onRequest(methods.agent.authenticate, async ({ params }) => {
      await implementation.authenticate(params)
      return {}
    })
    .onRequest(methods.agent.session.new, ({ params, signal }) => implementation.newSession(params, signal))
    .onRequest(methods.agent.session.list, ({ params, signal }) => implementation.listSessions(params, signal))
    .onRequest(methods.agent.session.resume, ({ params, signal }) => implementation.resumeSession(params, signal))
    .onRequest(methods.agent.session.close, ({ params }) => implementation.closeSession(params))
    .onRequest(methods.agent.session.setConfigOption, ({ params, signal }) => implementation.setSessionConfigOption(params, signal))
    .onRequest(methods.agent.session.prompt, ({ params, signal }) => implementation.prompt(params, signal))
    .onNotification(methods.agent.session.cancel, ({ params }) => implementation.cancel(params))
  let conn: AgentContext
  const connectV1 = (transport: Stream) => {
    const connection = app.connect(transport)
    conn = connection.client
    return connection
  }
  const v2App = v2.agent({ name: 'deepseek-harness-acp' })
    .onConnect(({ client }) => { v2Client = client })
    .onRequest(v2.methods.agent.initialize, () => ({
      protocolVersion: 2,
      info: { name: 'deepseek-harness-acp', version: '0.0.1' },
      capabilities: { session: signingKey === undefined ? {} : { fork: {} } },
      _meta: {
        'nymph.ai/fabric': {
          keyedTextPrompts: true,
          keyedTextSteering: true,
          ...signingKey === undefined ? {} : { replayFromCursor: FABRIC_CURSOR_REPLAY },
        },
        steering: { supported: true },
      },
    }))
    .onRequest(v2.methods.agent.session.new, ({ params, signal }) => v2Result(async () => {
      if (params.additionalDirectories?.length || params.mcpServers?.length
        || params.configOptions?.length || params.systemPrompt != null) {
        throw invalidParams('this ACP v2 preview accepts a primary cwd only')
      }
      const { sessionId, configOptions } = await implementation.newSession({ cwd: params.cwd, mcpServers: [] }, signal)
      return { sessionId, configOptions: v2Config(configOptions) }
    }))
    .onRequest(v2.methods.agent.session.list, ({ params, signal }) => v2Result(() => implementation.listSessions(params, signal)))
    .onRequest(v2.methods.agent.session.resume, ({ params, signal }) => v2Result(async () => {
      if (params.additionalDirectories?.length || params.mcpServers?.length || params.systemPrompt != null) {
        throw invalidParams('this ACP v2 preview accepts a primary cwd only')
      }
      const sessionId = brandString<SessionId>(params.sessionId)
      let replayCursorId: string | undefined
      const replay = params.replayFrom
      if (replay != null && replay.type !== 'start') {
        if (signingKey === undefined || replay.type !== FABRIC_CURSOR_REPLAY
          || typeof replay.cursorId !== 'string' || !/^dsh-cursor:[A-Za-z0-9_-]{43}$/.test(replay.cursorId)) {
          throw invalidParams('unsupported or malformed DSH replay cursor')
        }
        const events = await readHistory(sessionId, params.cwd, signal)
        resolveCursor(sessionId, events, replay.cursorId)
        replayCursorId = replay.cursorId
      }
      const { configOptions } = await implementation.resumeSession({ sessionId, cwd: params.cwd, mcpServers: [] }, signal)
      try {
        await enqueueV2(sessionId, async () => {
          if (replay != null) {
            const events = await readHistory(sessionId, params.cwd, signal)
            const start = replayCursorId === undefined ? 0 : resolveCursor(sessionId, events, replayCursorId) + 1
            const tools = new V2ToolUpdates()
            for (const event of events.slice(start)) {
              const update = v2Message(event)
              if (update === undefined) {
                const tool = tools.observe(ctx, event)
                if (tool !== undefined) await sendV2(sessionId, await tool())
                continue
              }
              await sendV2(sessionId, update)
              const cursor = signingKey === undefined ? undefined : cursorAfter(signingKey, sessionId, event)
              if (cursor !== undefined) await sendV2(sessionId, cursor)
            }
            await sendV2(sessionId, { sessionUpdate: 'replay_complete' })
          }
          await sendV2(sessionId, { sessionUpdate: 'state_update', state: 'idle', stopReason: null })
        })
      } catch (error: unknown) {
        await implementation.closeSession({ sessionId })
        v2Updates.delete(sessionId)
        v2Tools.delete(sessionId)
        throw error
      }
      return { configOptions: v2Config(configOptions) }
    }))
    .onRequest(v2.methods.agent.session.prompt, ({ params, signal }) => v2Result(() => {
      const prompt = parseKeyedPrompt({ ...params, idempotencyKey: params.idempotencyKey ?? randomUUID() })
      const id = brandString<SessionId>(params.sessionId)
      return requireSession(id).promptWithId(prompt, prompt.idempotencyKey, false, persistence, signal, retainPromptContent(params.prompt), (reason) => {
        void notifyV2(id, v2Settlement(reason)).catch(() => {})
      })
    }))
    .onRequest('_session/steering', value => value, ({ params, signal }) => v2Result(async () => {
      const steering = parseSteering(params)
      const id = brandString<SessionId>(steering.sessionId)
      const receipt = await requireSession(id).steerWithId(steering, steering.idempotencyKey, persistence, signal)
      return receipt === undefined
        ? { outcome: 'promptRequired', reason: 'noRunningTurn' }
        : { outcome: 'injected', ...receipt }
    }))
    .onNotification(v2.methods.agent.session.cancel, ({ params }) => implementation.cancel(params))
    .onRequest(v2.methods.agent.session.close, ({ params }) => v2Result(async () => {
      const id = brandString<SessionId>(params.sessionId)
      const response = await implementation.closeSession(params)
      await v2Updates.get(id)
      v2Updates.delete(id)
      v2Tools.delete(id)
      return response
    }))
    .onRequest(v2.methods.agent.session.setConfigOption, ({ params, signal }) => v2Result(async () => {
      if (params.type !== 'id' || typeof params.value !== 'string') throw invalidParams('config options use string IDs')
      const { configOptions } = await implementation.setSessionConfigOption({
        sessionId: params.sessionId, configId: params.configId, value: params.value,
      }, signal)
      return { configOptions: v2Config(configOptions) }
    }))
  const v2WithCursors = signingKey === undefined
    ? v2App
    : v2App.onRequest(v2.methods.agent.session.fork, ({ params, signal }) => v2Result(async () => {
      if (!isAbsolute(params.cwd) || params.additionalDirectories?.length || params.mcpServers?.length
        || params.configOptions?.length || params.systemPrompt != null) {
        throw invalidParams('this ACP v2 preview accepts a primary cwd only')
      }
      const parent = brandString<SessionId>(params.sessionId)
      const events = await readHistory(parent, params.cwd, signal)
      const boundary = params.cursorId == null ? events.at(-1)?.seq : resolveCursor(parent, events, params.cursorId)
      signal.throwIfAborted()
      const { sessionId, configOptions } = await implementation.newSession({ cwd: params.cwd, mcpServers: [] }, signal, {
        seed: boundary === undefined ? [] : buildForkSeed(events, boundary),
        parentSource: { sessionId: parent, endSeq: SessionLogOffset(boundary === undefined ? 0 : boundary + 1) },
      })
      return { sessionId, configOptions: v2Config(configOptions) }
    }))
  const connection = config.protocolV2 === true
    ? v2.agentProtocolRouter().withV1({ connect: connectV1 }).withV2(v2WithCursors).connect(stream)
    : connectV1(stream)

  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    if (quiescing !== undefined) return quiescing
    closed = true
    const records = [...sessions.values()]
    // AcpSession.close cancels synchronously before its first await, so every owned
    // prompt stops before any descendant or persistence drain can block.
    quiescing = (async () => {
      const disposals = await Promise.allSettled(records.map(record => record.close('ACP bridge disposed')))
      for (const record of records) {
        /* v8 ignore next -- closed blocks concurrent handlers; each captured record remains mapped until this loop. */
        if (sessions.get(record.agent.session.id) === record) sessions.delete(record.agent.session.id)
      }
      const failures: unknown[] = []
      for (const result of disposals) {
        if (result.status === 'rejected') failures.push(result.reason as unknown)
      }
      if (failures.length > 0) {
        // The production consumer logs this AggregateError through `String`,
        // which renders only its message. Embed every per-session diagnostic,
        // including nested causes and aggregate members, in that message.
        const detail = failures.map(failure => errorChain(failure)).join('; ')
        throw new AggregateError(
          failures,
          `ACP agent teardown failed for ${failures.length} session(s): ${detail}`,
        )
      }
    })()
    return quiescing
  }

  /* v8 ignore start -- production transport rejection and teardown failure. */
  void connection.closed
    .catch((error: unknown) => {
      logger.warn(`acp: connection closed with an error: ${String(error)}`)
    })
    .then(quiesce)
    .catch((error: unknown) => {
      logger.warn(`acp: connection-close teardown failed: ${String(error)}`)
    })
  /* v8 ignore stop */

  ctx.effect(() => quiesce, 'acp.connection')
}

/**
 * Build per-agent options from plugin config without assigning absent optional fields.
 * @param config - ACP provider/model configuration.
 * @returns the configured fields only.
 */
function agentOptions(config: AcpConfig): { provider?: string; model?: string } {
  return {
    ...config.provider !== undefined ? { provider: config.provider } : {},
    ...config.model !== undefined ? { model: config.model } : {},
  }
}

interface SessionListCursor {
  createdAt: number
  sessionId: string
}

/** Resolve and validate the deployment-owned session page limit. */
function resolveSessionListPageSize(value: number | undefined): number {
  const resolved = value ?? DEFAULT_SESSION_LIST_PAGE_SIZE
  /* v8 ignore start -- Cordis applies the positive-integer Config schema; this protects direct apply callers. */
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error('acp: sessionListPageSize must be a positive safe integer')
  }
  /* v8 ignore stop */
  return resolved
}

/** Decode an opaque keyset cursor without assigning meaning to client metadata. */
function decodeSessionListCursor(value: string | null | undefined): SessionListCursor | undefined {
  if (value === undefined || value === null) return undefined
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('session/list cursor is invalid')
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const createdAt: unknown = Array.isArray(decoded) ? decoded[0] : undefined
    const sessionId: unknown = Array.isArray(decoded) ? decoded[1] : undefined
    if (
      !Array.isArray(decoded)
      || decoded.length !== 2
      || typeof createdAt !== 'number'
      || !Number.isSafeInteger(createdAt)
      || createdAt < 0
      || typeof sessionId !== 'string'
      || sessionId.length === 0
    ) throw new Error('invalid cursor fields')
    const canonical = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
    if (canonical !== value) throw new Error('non-canonical cursor')
    return { createdAt, sessionId }
  } catch (_invalidCursor) {
    throw new Error('session/list cursor is invalid')
  }
}

/** Encode the last returned ordering key as an opaque continuation token. */
function encodeSessionListCursor(entry: SessionListCursor): string {
  return Buffer.from(JSON.stringify([entry.createdAt, entry.sessionId]), 'utf8').toString('base64url')
}

/** Test whether an entry follows the cursor in newest-first list order. */
function isAfterSessionListCursor(entry: SessionListCursor, cursor: SessionListCursor): boolean {
  return entry.createdAt < cursor.createdAt
    || (entry.createdAt === cursor.createdAt && compareSessionIds(entry.sessionId, cursor.sessionId) > 0)
}

/** Compare opaque session ids by stable UTF-8 bytes, independent of process locale. */
function compareSessionIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

/** Reject workspace features outside the automation contract. */
function validateWorkspaceParams(params: { cwd: string; additionalDirectories?: string[] | null }): void {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  if (
    params.additionalDirectories !== undefined
    && params.additionalDirectories !== null
    && params.additionalDirectories.length > 0
  ) {
    throw invalidParams('additionalDirectories is not supported')
  }
}

/** Compare existing directories by physical identity and missing paths lexically. */
async function sameDirectory(left: string | undefined, right: string): Promise<boolean> {
  if (left === undefined) return false
  try {
    const [realLeft, realRight] = await Promise.all([realpath(left), realpath(right)])
    return realLeft === realRight
  } catch (_unresolvablePath) {
    return resolve(left) === resolve(right)
  }
}
