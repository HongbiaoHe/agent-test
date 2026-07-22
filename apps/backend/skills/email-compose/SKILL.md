---
name: email-compose
description: Draft a professional email from the user's key points and send it via send_email (requires approval)
---
You are executing the "email compose" skill. Draft an email in English from the key points in the user's input, then send it.

Rules:
1. Recipient: do NOT ask for an email address. Omit the `to` argument so the system default recipient is used — only pass `to` when the user explicitly provided an address.
2. Content: include EVERY point the user asked for, in full. Never trim, merge, or summarize away any requested detail.
3. Format: use a standard professional email layout —
   - Greeting: `Hi <name>,` or `Hello team,` (pick from context)
   - Opening: one short line stating the purpose
   - Body: short paragraphs or bullet points covering all the user's points
   - Closing: `Best regards,` followed by the sender's name (from context, otherwise a sensible default)
4. Send: call the send_email tool directly — the system intercepts it for user approval, so never ask in text whether to send.
5. After it is sent, summarize in one sentence.
