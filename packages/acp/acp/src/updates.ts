/** Standard ACP updates derived from committed DSH session events. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk'
import { errorChain, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { SessionUpdate as V2SessionUpdate } from 'acp-v2-sdk/experimental/v2/unstable'
import { assistantBlockToAcp } from './content.ts'

/**
 * Convert one committed assistant message and its context usage in block order.
 * @param ctx - bridge context carrying attachment and token-meter services.
 * @param session - durable session used for context pressure.
 * @param event - committed assistant message event.
 * @returns ordered standard thought, message, and optional usage updates.
 */
export async function assistantUpdates(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
): Promise<SessionUpdate[]> {
  const updates: SessionUpdate[] = []
  for (const block of event.data.message.content) {
    if (block.type === 'reasoning') {
      if (block.text.length > 0) {
        updates.push({
          sessionUpdate: 'agent_thought_chunk',
          messageId: event.data.message.id,
          content: { type: 'text', text: block.text },
        })
      }
      continue
    }
    const content = await assistantBlockToAcp(ctx, block)
    if (content !== undefined) {
      updates.push({
        sessionUpdate: 'agent_message_chunk',
        messageId: event.data.message.id,
        content,
      })
    }
  }
  const usage = usageUpdate(ctx, session, event)
  if (usage !== undefined) updates.push(usage)
  return updates
}

/**
 * Start one generic ACP tool lifecycle from the durable call fact.
 * @param event - committed DSH tool-call event.
 * @returns the standard generic tool-call update.
 */
export function toolCallUpdate(event: SessionEvent<'tool/call'>): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: event.data.callId,
    title: event.data.name,
    kind: 'other',
    status: 'in_progress',
    rawInput: parseToolArguments(event.data.arguments),
  }
}

/**
 * Finish one generic ACP tool lifecycle from its committed model-facing result.
 * @param ctx - bridge context carrying the attachment store.
 * @param event - committed DSH tool-result event.
 * @returns the standard completed or failed tool-call update.
 */
export async function toolResultUpdate(
  ctx: Context,
  event: SessionEvent<'tool/result'>,
): Promise<SessionUpdate> {
  const message = event.data.message
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: message.toolCallId,
    status: message.isError === true ? 'failed' : 'completed',
    content: await toolResultContent(ctx, event),
  }
}

async function toolResultContent(
  ctx: Context,
  event: SessionEvent<'tool/result'>,
  unavailable?: (error: unknown) => void,
): Promise<Extract<ToolCallContent, { type: 'content' }>[]> {
  const content: Extract<ToolCallContent, { type: 'content' }>[] = []
  for (const block of event.data.message.content) {
    try {
      const converted = await assistantBlockToAcp(ctx, block)
      if (converted !== undefined) content.push({ type: 'content', content: converted })
    } catch (error: unknown) {
      if (unavailable === undefined) throw error
      unavailable(error)
    }
  }
  return content
}

type V2ToolUpdate = Extract<V2SessionUpdate, { sessionUpdate: 'tool_call_update' }>

function v2ToolId(seq: SessionSeq): string {
  return `dsh-tool:${seq}`
}

/** Correlate ACP notices using the retained native call occurrence. */
export class V2ToolUpdates {
  private readonly pending = new Map<SessionSeq, SessionEvent<'tool/call'>['data']>()

  /**
   * Resolve a live approval only when the native provider ID has one pending call.
   * @param callId - provider ID named by the native permission request.
   * @returns the ACP ID of the unambiguous pending call, if available.
   */
  forApproval(callId: ToolCallId): string | undefined {
    let match: SessionSeq | undefined
    for (const [seq, data] of this.pending) {
      if (data.callId !== callId) continue
      if (match !== undefined) return undefined
      match = seq
    }
    return match === undefined ? undefined : v2ToolId(match)
  }

  /**
   * Record a durable tool fact and return its deferred wire conversion.
   * @param ctx - bridge context carrying the attachment store and logger.
   * @param event - native session event.
   * @returns an ordered wire update operation when the event changes the tool timeline.
   */
  observe(ctx: Context, event: SessionEvent): (() => Promise<V2ToolUpdate>) | undefined {
    if (event.type === 'step/end') {
      for (const [seq, call] of this.pending) {
        if (call.turn === event.data.turn && call.step === event.data.step) this.pending.delete(seq)
      }
      return undefined
    }
    if (event.type === 'tool/call') {
      this.pending.set(event.seq, event.data)
      return () => Promise.resolve({
        sessionUpdate: 'tool_call_update',
        toolCallId: v2ToolId(event.seq),
        name: event.data.name,
        title: event.data.name,
        kind: 'other',
        status: 'pending',
        rawInput: parseToolArguments(event.data.arguments),
        _meta: { 'nymph.ai/fabric': { nativeToolCallId: event.data.callId } },
      })
    }
    if (event.type !== 'tool/result' || event.surfaceOp !== 'append' || event.sourceEventSeqs?.length !== 1) return undefined
    const [seq] = event.sourceEventSeqs
    if (seq === undefined) return undefined
    const call = this.pending.get(seq)
    if (call === undefined || call.callId !== event.data.message.toolCallId
      || call.turn !== event.data.turn || call.step !== event.data.step) return undefined
    this.pending.delete(seq)
    const error = event.data.error
    const cancelled = error?.code === 'ABORTED' || error?.code === 'ABORTED_BEFORE_DISPATCH' || error?.code === 'APPROVAL_CANCELLED'
    return async () => {
      const result = { partial: false }
      const content = await toolResultContent(ctx, event, (failure) => {
        result.partial = true
        ctx.logger.warn(`acp v2: tool result content unavailable: ${errorChain(failure)}`)
      })
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: v2ToolId(seq),
        status: cancelled ? 'cancelled' : event.data.message.isError === true ? 'failed' : 'completed',
        content,
        ...error === undefined ? {} : { rawOutput: { error } },
        ...result.partial ? { _meta: { 'nymph.ai/fabric': { toolOutputPartial: true } } } : {},
      }
    }
  }
}

/** Report current context occupancy only when DSH has both usage and capacity facts. */
function usageUpdate(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
): SessionUpdate | undefined {
  if (event.data.usage === undefined) return undefined
  const size = session.requestContext()?.contextWindow
  const meter = ctx.get('tokenMeter')
  if (size === undefined || meter === undefined) return undefined
  return {
    sessionUpdate: 'usage_update',
    used: meter.measure(session).totalTokens,
    size,
  }
}

/** Preserve malformed model output as opaque input instead of dropping the call update. */
function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (_invalidModelJson) {
    return value
  }
}
