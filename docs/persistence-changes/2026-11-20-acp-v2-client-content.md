---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-20-acp-v2-client-content

English | [中文](2026-11-20-acp-v2-client-content.zh.md)

## Summary

Stores optional original client content on durable UserMessage values. ACP v2 records original ordered blocks when a prompt contains resource links.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing V4 records and old text receipts remain valid. Older readers use the same model-facing content and source fields, so the optional metadata does not change reconstruction. ACP v2 typed retries require stored content and reject older flattened entries.

<a id="verification"></a>
## Verification

The ACP bridge tests cover native user-message retention, cold replay and same-key typed retry without another provider call.

<a id="dev-note"></a>
## Dev Note

None.
