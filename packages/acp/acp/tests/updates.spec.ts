import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createToolResultMessage, type ToolCallId, type MessageId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { assistantUpdates, toolCallUpdate, toolResultUpdate, V2ToolUpdates } from '../src/updates.ts'

/** Minimal committed assistant event for pure update projection tests. */
function assistantEvent(
  content: SessionEvent<'assistant/message'>['data']['message']['content'],
  usage?: SessionEvent<'assistant/message'>['data']['usage'],
): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    surfaceOp: 'append',
    seq: SessionSeq(0),
    time: 0,
    data: {
      stream: [],
      turn: 1,
      step: 1,
      message: {
        id: brandString<MessageId>('message-1'),
        role: 'assistant',
        source: { kind: 'model', provider: 'mock', model: 'mock' },
        content,
      },
      ...usage === undefined ? {} : { usage },
    },
  }
}

describe('standard ACP update projection', () => {
  it('omits empty reasoning, unsupported assistant blocks, and absent usage', async () => {
    const ctx = { get: () => undefined } as unknown as Context
    const session = { requestContext: () => undefined } as unknown as Session
    const event = assistantEvent([
      { type: 'reasoning', text: '' },
      { type: 'tool-call', id: brandString<ToolCallId>('call-hidden'), name: 'hidden', arguments: '{}' },
    ])

    await expect(assistantUpdates(ctx, session, event)).resolves.toEqual([])
  })

  it('requires both measured usage and context capacity', async () => {
    const meter = { measure: vi.fn(() => ({ totalTokens: 7 })) }
    const withMeter = { get: (name: string) => name === 'tokenMeter' ? meter : undefined } as unknown as Context
    const withoutMeter = { get: () => undefined } as unknown as Context
    const withCapacity = { requestContext: () => ({ contextWindow: 100 }) } as unknown as Session
    const withoutCapacity = { requestContext: () => undefined } as unknown as Session
    const event = assistantEvent([{ type: 'text', text: 'done' }], { inputTokens: 1, outputTokens: 1 })

    expect((await assistantUpdates(withMeter, withoutCapacity, event)).map(update => update.sessionUpdate))
      .toEqual(['agent_message_chunk'])
    expect((await assistantUpdates(withoutMeter, withCapacity, event)).map(update => update.sessionUpdate))
      .toEqual(['agent_message_chunk'])
    expect(meter.measure).not.toHaveBeenCalled()
  })

  it('preserves malformed tool input and projects a failed result without hidden content', async () => {
    const call = toolCallUpdate({
      type: 'tool/call',
      seq: SessionSeq(0),
      time: 0,
      data: { turn: 1, step: 1, callId: brandString<ToolCallId>('call-bad'), name: 'broken', arguments: '{' },
    })
    const result = await toolResultUpdate({ get: () => undefined } as unknown as Context, {
      type: 'tool/result',
      surfaceOp: 'append',
      seq: SessionSeq(0),
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: brandString<MessageId>('tool-message'),
          role: 'tool',
          toolCallId: brandString<ToolCallId>('call-bad'),
          isError: true,
          source: { kind: 'tool', callId: brandString<ToolCallId>('call-bad') },
          content: [{ type: 'reasoning', text: 'hidden' }],
        },
      },
    })

    expect(call).toMatchObject({ rawInput: '{' })
    expect(result).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-bad',
      status: 'failed',
      content: [],
    })
  })

  it('issues a cancellation for the exact linked native occurrence', async () => {
    const ctx = new Context()
    const tools = new V2ToolUpdates()
    const callId = brandString<ToolCallId>('same-provider-id')
    const call: SessionEvent<'tool/call'> = {
      type: 'tool/call', seq: SessionSeq(1), time: 0,
      data: { callId, name: 'read', arguments: '{}', turn: 1, step: 1 },
    }
    await expect(tools.observe(ctx, call)?.()).resolves.toMatchObject({
      toolCallId: 'dsh-tool:1', status: 'pending',
    })
    expect(tools.forApproval(callId)).toBe('dsh-tool:1')
    await expect(tools.observe(ctx, { ...call, seq: SessionSeq(2) })?.()).resolves.toMatchObject({
      toolCallId: 'dsh-tool:2', status: 'pending',
    })
    expect(tools.forApproval(callId)).toBeUndefined()

    const result: SessionEvent<'tool/result'> = {
      type: 'tool/result', seq: SessionSeq(3), time: 0, surfaceOp: 'append', sourceEventSeqs: [call.seq],
      data: {
        turn: 1, step: 1,
        message: createToolResultMessage({ callId, isError: true, content: [{ type: 'text', text: 'Cancelled' }] }),
        error: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' },
      },
    }
    expect(tools.observe(ctx, { ...result, sourceEventSeqs: [SessionSeq(0)] })).toBeUndefined()
    await expect(tools.observe(ctx, result)?.()).resolves.toEqual({
      sessionUpdate: 'tool_call_update', toolCallId: 'dsh-tool:1', status: 'cancelled',
      content: [{ type: 'content', content: { type: 'text', text: 'Cancelled' } }],
      rawOutput: { error: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' } },
    })
    expect(tools.forApproval(callId)).toBe('dsh-tool:2')
    expect(tools.observe(ctx, result)).toBeUndefined()
  })
})
