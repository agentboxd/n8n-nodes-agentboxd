import { createHmac, timingSafeEqual } from 'crypto';
import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IHookFunctions,
	type IHttpRequestMethods,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type JsonObject,
	type IWebhookResponseData,
} from 'n8n-workflow';

/** Deliveries older or newer than this are refused, so a captured request can't be replayed later. */
const TOLERANCE_SECONDS = 300;

/** hex(HMAC-SHA256(secret, `${timestamp}.${body}`)), as sent in X-Mailroom-Signature (the header keeps the API's original name). */
export function validSignature(signature: string, timestamp: string, body: string, secret: string, now = Date.now()): boolean {
	if (!/^\d+$/.test(timestamp) || !/^[0-9a-f]{64}$/i.test(signature)) return false;
	if (Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
	const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest();
	return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

/** A 404 from the API: the webhook no longer exists. */
function isNotFound(error: unknown): boolean {
	const e = error as { httpCode?: string | number; response?: { status?: number }; cause?: { status?: number } };
	return String(e?.httpCode) === '404' || e?.response?.status === 404 || e?.cause?.status === 404;
}

async function api(this: IHookFunctions, method: IHttpRequestMethods, path: string, body?: IDataObject): Promise<IDataObject> {
	const credentials = await this.getCredentials('agentboxdApi');
	const baseURL = String(credentials.baseUrl || 'https://api.agentboxd.com').replace(/\/+$/, '');
	try {
		return (await this.helpers.httpRequestWithAuthentication.call(this, 'agentboxdApi', {
			method,
			url: `${baseURL}${path}`,
			body,
			json: true,
		})) as IDataObject;
	} catch (error) {
		// Agentboxd's own message (e.g. "events.0: Invalid option…") instead of a bare HTTP status.
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}
}

export class AgentboxdTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Agentboxd Trigger',
		name: 'agentboxdTrigger',
		icon: { light: 'file:../../icons/agentboxd.svg', dark: 'file:../../icons/agentboxd.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow when an email arrives, is scored, bounces or a draft is sent',
		defaults: { name: 'Agentboxd Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'agentboxdApi', required: true }],
		webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: ['message.received'],
				options: [
					{ name: 'Draft Sent', value: 'draft.sent', description: 'A person approved a draft and it went out' },
					{ name: 'Message Bounced', value: 'message.bounced', description: 'An email could not be delivered' },
					{ name: 'Message Complained', value: 'message.complained', description: 'A recipient marked an email as spam' },
					{
						name: 'Message Enriched',
						value: 'message.enriched',
						description: 'An incoming email was categorised and scored for injection and phishing (use this to act only on safe mail)',
					},
					{ name: 'Message Received', value: 'message.received', description: 'An email arrived in an inbox' },
					{ name: 'Message Sent', value: 'message.sent', description: 'An email left an inbox' },
				],
			},
			{
				displayName: 'Inbox IDs',
				name: 'inboxIds',
				type: 'string',
				default: '',
				placeholder: 'All inboxes',
				description: 'Only these inboxes, separated by commas. Leave empty for every inbox in the workspace.',
			},
			{
				displayName:
					'Mail is untrusted input. Before passing a message to an AI model, check its labels (spf-fail, dmarc-fail, ai:injection-risk, ai:phishing): Message Enriched carries the scores.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node');
				if (!data.webhookId) return false;
				try {
					await api.call(this, 'GET', `/v1/webhooks/${String(data.webhookId)}`);
					return true;
				} catch (error) {
					if (!isNotFound(error)) throw new NodeApiError(this.getNode(), error as JsonObject);
					delete data.webhookId;
					delete data.secret;
					return false;
				}
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const url = this.getNodeWebhookUrl('default');
				const events = this.getNodeParameter('events') as string[];
				const inboxIds = (this.getNodeParameter('inboxIds', '') as string)
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean);
				const hook = await api.call(this, 'POST', '/v1/webhooks', {
					url,
					events,
					...(inboxIds.length ? { inbox_ids: inboxIds } : {}),
				});
				if (!hook.id || !hook.secret) throw new NodeOperationError(this.getNode(), 'Agentboxd did not return a webhook id and secret');
				const data = this.getWorkflowStaticData('node');
				data.webhookId = hook.id;
				data.secret = hook.secret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node');
				if (data.webhookId) {
					try {
						await api.call(this, 'DELETE', `/v1/webhooks/${String(data.webhookId)}`);
					} catch (error) {
						// Already deleted (in the dashboard, say) is fine; any other failure must surface.
						if (!isNotFound(error)) throw new NodeApiError(this.getNode(), error as JsonObject);
					}
				}
				delete data.webhookId;
				delete data.secret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject();
		const secret = String(this.getWorkflowStaticData('node').secret ?? '');
		const signature = String(req.headers['x-mailroom-signature'] ?? '');
		const timestamp = String(req.headers['x-mailroom-timestamp'] ?? '');
		const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
		const body = raw ? raw.toString('utf8') : JSON.stringify(req.body);
		if (!secret || !validSignature(signature, timestamp, body, secret)) {
			const res = this.getResponseObject();
			res.status(401).json({ error: 'invalid signature' });
			return { noWebhookResponse: true };
		}
		const event = this.getBodyData() as IDataObject;
		return { workflowData: [this.helpers.returnJsonArray([event])] };
	}
}
