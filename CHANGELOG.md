# Changelog

## Unreleased

- IDs in request URLs are percent-encoded, and an empty ID, `.` or `..` is refused with an error instead of being sent.
- Wait for Code returns the email's labels, and `data.warning` when it failed sender checks (`spf-fail`, `dmarc-fail`) or was flagged (`ai:phishing`, `ai:injection-risk`, `local:injection-risk`).
- Wait for Code: **From** is matched against the sender's address (an exact address, or a domain and its subdomains) instead of any text in the From header, so the display name no longer counts. A value that is neither an address nor a domain is refused.
- Release workflow: GitHub Actions pinned to commit SHAs, dependencies installed without install scripts, and the npm OIDC permission limited to the job that publishes.

## 0.1.0

- Agentboxd node: inboxes (create, get, list, delete), messages (send, reply, get, list, wait for the next one), verification codes and drafts. Usable as an AI Agent tool.
- Agentboxd Trigger: message received, enriched, sent, bounced, complained and draft sent, with signed and time-checked deliveries.
