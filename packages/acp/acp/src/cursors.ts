/** Signed ACP cursors over exact retained DeepSeek Harness journal events. */

import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { CursorUpdate } from 'acp-v2-sdk/experimental/v2/unstable'

/** Custom ACP v2 replay variant for Fabric cursors. */
export const FABRIC_CURSOR_REPLAY = '_fabric_cursor'

/**
 * Load the private key shared by previews that use the same persistent home.
 * @param path - absolute path in the persistent DSH home.
 * @returns the existing or atomically initialized signing key.
 */
export function cursorKey(path: string): Uint8Array {
  if (!isAbsolute(path)) throw new Error('ACP cursorSigningKeyFile must be an absolute path')
  const read = (): Uint8Array => {
    const key = readFileSync(path)
    if (key.length !== 32) throw new Error('ACP cursor signing key has an invalid size')
    return key
  }
  try {
    return read()
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}`
  try {
    writeFileSync(temporary, randomBytes(32), { flag: 'wx', mode: 0o600 })
    try {
      linkSync(temporary, path)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } finally {
    rmSync(temporary, { force: true })
  }
  return read()
}

/**
 * Announce the exact position after a tool-free assistant message.
 * @param key - private persisted signing key.
 * @param sessionId - source session identity.
 * @param event - native journal entry.
 * @returns a fork and replay cursor when the entry has a supported anchor.
 */
export function cursorAfter(
  key: Uint8Array, sessionId: SessionId, event: SessionEvent,
): (CursorUpdate & { sessionUpdate: 'cursor_update' }) | undefined {
  if (event.type !== 'assistant/message' || event.data.message.content.some(block => block.type === 'tool-call')) {
    return undefined
  }
  const messageId = event.data.message.id
  const hash = createHmac('sha256', key).update(JSON.stringify([sessionId, event.seq, event.time, messageId])).digest('base64url')
  return {
    sessionUpdate: 'cursor_update',
    cursorId: `dsh-cursor:${hash}`,
    anchor: { type: 'agent_message', messageId, position: 'after' },
    capabilities: { fork: {} },
  }
}
