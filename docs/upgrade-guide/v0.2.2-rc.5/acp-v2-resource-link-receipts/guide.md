---
kind: upgrade-guide
description: "ACP v2 retries for resource-link prompts require the original typed blocks in the retained native message."
---

# ACP v2 receipts for resource-link prompts

English | [中文](guide.zh.md)

## Change

Earlier ACP v2 fork previews retained only the rendered text and message ID for resource-link prompts. The bridge now stores the original ordered blocks on the native message and verifies them before returning a keyed receipt. A legacy native entry without those blocks returns `dsh_prompt_witness_unavailable` for a typed retry. [Persistence record](../../../persistence-changes/2026-11-20-acp-v2-client-content.md)

## Migration

1. Keep the original `sessionId`, `idempotencyKey`, and ordered `prompt` blocks for each ACP v2 `session/prompt` submission. Reuse them together when retrying.
2. For a legacy receipt with a known `messageId`, use `session/resume` with `replayFrom: { "type": "start" }` to locate the original message in retained history.
3. If a legacy typed retry returns `dsh_prompt_witness_unavailable`, leave an unconfirmed submission unresolved. Allocate a new key only for a new submission.
