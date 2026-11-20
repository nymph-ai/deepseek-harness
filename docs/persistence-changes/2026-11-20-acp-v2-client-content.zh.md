---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-20-acp-v2-client-content

[English](2026-11-20-acp-v2-client-content.md) | 中文

## 概述

在持久化的 UserMessage 中存储可选的客户端原始内容。ACP v2 在提示包含资源链接时保存按原顺序排列的内容块。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-20-acp-v2-client-content
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-timeline-priority-notice"
    after: "5f73d51681996b7799a86c7fdd6e0fb62d68dc4a49e006468a47b7bc36c777de"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "0a5b179247312f5c2643a86241032cab5e4a08c88e5ca232aba2a820b7ea3995"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "0d8f04f889924577169fe2f48bf09643a2c0f2420cb8b37d596373ce424a6eb6"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有的 V4 记录和旧的文本回执仍然有效。旧读取器继续使用相同的模型内容和来源字段，因此可选元数据不会改变会话重建。ACP v2 的类型化重试需要已保存的原始内容，并拒绝仅保存展平文本的旧记录。

<a id="verification"></a>
## 验证

ACP 桥接测试检验原生用户消息存储、重启后回放和同键类型化重试，并确认没有额外的模型请求。

<a id="dev-note"></a>
## 开发备注

无。
