/** Validate each selected child against its native creator catalog and journal. */

import type { Context } from '@deepseek-ai/cordis'
import { RequestError } from '@agentclientprotocol/sdk'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

export interface ChildHistory {
  readonly header: SessionHeader
  readonly label: string | undefined
  readonly events: readonly SessionEvent[]
  readonly children: ReadonlyMap<SessionSeq, ChildHistory>
}

function unavailable(): RequestError {
  return new RequestError(-32000, 'The selected DSH child history is unavailable or does not belong to this session.', {
    kind: 'dsh_child_history_unavailable',
  })
}

export function localCatalogChild(event: SessionEvent) {
  const type: string = event.type
  if (type !== 'subagent/catalog') return undefined
  const data: unknown = event.data
  if (typeof data !== 'object' || data === null || !('mode' in data)) throw unavailable()
  if (data.mode === 'external' || data.mode === 'unknown') return undefined
  if ((data.mode !== 'one-shot' && data.mode !== 'continuable') || !('version' in data)
    || (data.version !== 0 && data.version !== 1 && (data.version !== 3 || data.mode !== 'continuable'))
    || !('childId' in data) || typeof data.childId !== 'string' || data.childId.length === 0
    || !('childCreatedAt' in data) || typeof data.childCreatedAt !== 'number'
    || !Number.isSafeInteger(data.childCreatedAt) || data.childCreatedAt < 0) throw unavailable()
  const label = 'label' in data ? data.label : undefined
  if (label !== undefined && typeof label !== 'string') throw unavailable()
  return { childId: brandString<SessionId>(data.childId), childCreatedAt: data.childCreatedAt, label }
}

/**
 * Read every selected local child before any part of the replay is published.
 * @param ctx - bridge context used to detect a child still attached locally.
 * @param persistence - authoritative native session storage.
 * @param parentId - verified root session ID.
 * @param inheritedEventCount - exact inherited cut from the root read handle.
 * @param selected - the root's retained event suffix requested by the client.
 * @param signal - request cancellation propagated to read-only handles.
 * @returns validated settled child trees by own catalog occurrence.
 */
export async function readChildHistories(
  ctx: Context,
  persistence: SessionPersistence,
  parentId: SessionId,
  inheritedEventCount: SessionLogOffset,
  selected: readonly SessionEvent[],
  signal: AbortSignal,
): Promise<ReadonlyMap<SessionSeq, ChildHistory>> {
  const seen = new Set<SessionId>([parentId])
  const histories = await collectChildHistories(ctx, persistence, parentId, inheritedEventCount, selected, signal, seen)
  for (const child of seen) {
    if (child !== parentId && ctx.sessions.get(child) !== undefined) throw unavailable()
  }
  return histories
}

async function collectChildHistories(
  ctx: Context,
  persistence: SessionPersistence,
  parentId: SessionId,
  inheritedEventCount: SessionLogOffset,
  selected: readonly SessionEvent[],
  signal: AbortSignal,
  seen: Set<SessionId>,
): Promise<ReadonlyMap<SessionSeq, ChildHistory>> {
  const histories = new Map<SessionSeq, ChildHistory>()
  for (const event of selected) {
    if (event.seq < inheritedEventCount) continue
    const entry = localCatalogChild(event)
    if (entry === undefined) continue
    const { childId, childCreatedAt, label } = entry
    if (seen.has(childId) || ctx.sessions.get(childId) !== undefined) throw unavailable()
    seen.add(childId)
    try {
      let header: SessionHeader
      let events: readonly SessionEvent[]
      let childInherited: SessionLogOffset
      {
        await using reader = await persistence.open(childId, 'read', { signal })
        header = reader.header
        childInherited = reader.inheritedEventCount
        if (header.id !== childId || header.origin !== 'subagent' || header.parentSession !== parentId
          || header.createdAt !== childCreatedAt) throw unavailable()
        events = (await reader.read(childInherited, undefined, { signal })).events
      }
      const phase = events.findLast(entry => entry.type === 'turn/start' || entry.type === 'turn/end')
      if (phase?.type !== 'turn/end' || phase.data.reason.kind === 'forked' || phase.data.reason.kind === 'interrupted'
        || ctx.sessions.get(childId) !== undefined) throw unavailable()
      const children = await collectChildHistories(ctx, persistence, childId, childInherited, events, signal, seen)
      histories.set(event.seq, { header, label, events, children })
    } catch (error: unknown) {
      signal.throwIfAborted()
      if (error instanceof RequestError) throw error
      throw unavailable()
    }
  }
  return histories
}
