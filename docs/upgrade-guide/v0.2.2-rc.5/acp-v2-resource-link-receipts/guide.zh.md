---
kind: upgrade-guide
description: "ACP v2 重试带资源链接的提示词时，存档中的原生消息必须含有原始的类型化内容块。"
---

# ACP v2 资源链接提示词的回执

[English](guide.md) | 中文

## 变更

早期 ACP v2 分支预览版处理含资源链接的提示词时，只保存渲染后的文本和消息 ID。现在桥接在原生消息中保存原始顺序的内容块，在返回带幂等键的回执前核对这些内容块。如果旧的原生消息缺少这些内容块，类型化重试会返回 `dsh_prompt_witness_unavailable`。[持久化记录](../../../persistence-changes/2026-11-20-acp-v2-client-content.zh.md)

## 迁移

1. 每次发送 ACP v2 `session/prompt` 时，保存原来的 `sessionId`、`idempotencyKey` 和按顺序排列的 `prompt` 内容块。重试时一起使用这些值。
2. 如果已知旧回执的 `messageId`，使用带 `replayFrom: { "type": "start" }` 的 `session/resume` 在存档中定位原消息。
3. 如果旧的类型化重试返回 `dsh_prompt_witness_unavailable`，将未经确认的提交保持为未决状态。仅为新提交分配新键。
