# n8n-nodes-agentboxd

[Agentboxd](https://agentboxd.com) for [n8n](https://n8n.io): real email inboxes for AI agents. Give a workflow its own address, send and reply, wait for sign-up codes, and start workflows when mail arrives. Every incoming email is checked and scored by [Customs](https://agentboxd.com/customs) before your workflow sees it.

## Install

In n8n: **Settings → Community Nodes → Install**, then enter `n8n-nodes-agentboxd`.

Self-hosted from the command line: `npm install n8n-nodes-agentboxd` in your n8n custom nodes folder. See the [n8n community node docs](https://docs.n8n.io/integrations/community-nodes/installation/).

## Credentials

1. Create an API key at [agentboxd.com/app](https://agentboxd.com/app) → **API keys**. It is free during the public beta, with no card. Give the key only what the workflow needs, for example send and read on one inbox.
2. In n8n, add an **Agentboxd API** credential and paste the key. Leave **Base URL** as `https://api.agentboxd.com` unless you run your own server.

## Nodes

### Agentboxd

| Resource | Operations |
|---|---|
| Inbox | Create (with an optional client ID, so a restarted workflow gets the same inbox back), Get, Get Many, Delete |
| Message | Send, Reply (in the same thread), Get (with labels and AI scores), Get Many, Wait for Next (up to 60 seconds) |
| Verification | Wait for Code: the next sign-up code or magic link, returned as `data.code` / `data.link` with the email's `data.labels` (`data` is null on timeout). **From** takes an address or a domain and is checked against the sender's address, never the display name |
| Draft | Create: an email a person approves and sends from the dashboard |

The node can also be used as a tool by n8n's **AI Agent** node.

### Agentboxd Trigger

Starts the workflow on Message Received, Message Enriched (categorised and scored for prompt injection and phishing), Message Sent, Message Bounced, Message Complained or Draft Sent, for every inbox or only the ones you list. Activating the workflow registers a webhook with Agentboxd, and deactivating it removes the webhook. Each delivery is checked against its HMAC signature and timestamp, and anything unsigned or older than 5 minutes is refused.

## Treat email as untrusted input

Anyone can email your workflow's address. Before passing a message to an AI model, check its labels (`spf-fail`, `dmarc-fail`, `ai:injection-risk`, `ai:phishing`) or its scores (`ai.risk.injection`, `ai.risk.phishing`). Trigger on **Message Enriched** when you want the scores to be there already. **Wait for Code** sets `data.warning` when the email carries one of these labels (or `local:injection-risk`): check it before using the code. For anything that matters, send through a **Draft** a person approves.

## Example: sign up for a service

1. **Agentboxd → Inbox → Create** (client ID `signup-bot`)
2. **HTTP Request**: submit the sign-up form with `{{ $json.address }}`
3. **Agentboxd → Verification → Wait for Code**: inbox ID from step 1, **Since** set to the time just before step 2, **From** set to the service's domain
4. If `{{ $json.data.warning }}` is empty, use `{{ $json.data.code }}` to finish the sign-up

More: the [n8n guide](https://agentboxd.com/guides/n8n-email-automation) and the [API docs](https://agentboxd.com/docs).

## Compatibility

n8n 1.x and later (node API version 1). No runtime dependencies.

## License

[MIT](LICENSE.md)
