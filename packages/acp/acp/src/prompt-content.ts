/** Retain original ACP v2 blocks on the native message that acknowledges their insertion. */

import { isDeepStrictEqual } from 'node:util'
import { RequestError } from '@agentclientprotocol/sdk'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { ContentBlock } from 'acp-v2-sdk/experimental/v2/unstable'

const format = 'acp-v2'

/**
 * Record validated resource links and the surrounding text in their original block order.
 * @param blocks - SDK-validated ACP v2 prompt blocks.
 * @returns native client content for a resource-bearing prompt.
 */
export function retainPromptContent(blocks: readonly ContentBlock[]): UserMessage['clientContent'] {
  if (!blocks.some(ContentBlock.isResourceLink)) return undefined
  return { format, json: JSON.stringify(blocks) }
}

/**
 * Read the typed ACP input from its native user message.
 * @param content - original client content carried by the native message.
 * @returns the stored blocks, undefined for another format or a legacy message, or null for invalid ACP data.
 */
export function storedPromptContent(content: UserMessage['clientContent']): ContentBlock[] | null | undefined {
  if (content?.format !== format) return undefined
  try {
    const blocks: unknown = JSON.parse(content.json)
    if (!Array.isArray(blocks) || !blocks.every((block: unknown): block is ContentBlock => {
      if (typeof block !== 'object' || block === null || !('type' in block) || typeof block.type !== 'string') return false
      const candidate = block as ContentBlock
      return ContentBlock.isText(candidate) || ContentBlock.isResourceLink(candidate)
    }) || !blocks.some(ContentBlock.isResourceLink)) return null
    return blocks
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

/**
 * Validate that a native message certifies a retry's resource-bearing submission.
 * @param retained - original client content carried by the native message.
 * @param requested - original client content supplied with the request when it uses resource links.
 */
export function matchPromptContent(retained: UserMessage['clientContent'], requested: UserMessage['clientContent']): void {
  const previous = storedPromptContent(retained)
  if (previous === null || (previous === undefined && requested !== undefined)) {
    throw new RequestError(-32000, 'The native DeepSeek Harness message has no exact typed prompt.', {
      kind: 'dsh_prompt_witness_unavailable',
    })
  }
  if (!isDeepStrictEqual(previous, storedPromptContent(requested))) {
    throw RequestError.invalidParams(undefined, 'This idempotency key is already bound to different typed content.')
  }
}
