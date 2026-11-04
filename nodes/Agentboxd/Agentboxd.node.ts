import { NodeConnectionTypes, type INodeProperties, type INodeType, type INodeTypeDescription } from 'n8n-workflow';
import { encodePathParameters, waitForCode } from './GenericFunctions';

/** "a@x.com, b@y.com" → ["a@x.com", "b@y.com"] (the API takes a string or a list). */
const RECIPIENTS = '={{ $value.split(",").map((s) => s.trim()).filter(Boolean) }}';
/** Only send a field when it was filled in. */
const unlessEmpty = (property: string) => ({ send: { type: 'body' as const, property, value: '={{ $value === "" ? undefined : $value }}' } });

const show = (resource: string, operation: string[]) => ({ show: { resource: [resource], operation } });

/** For a URL with IDs in it, e.g. '/v1/inboxes/{inboxId}': each `{name}` is filled with the encoded parameter. */
const ENCODE_PATH = { preSend: [encodePathParameters] };

const inboxId = (resource: string, operation: string[], description = 'ID of the inbox (inbox.id)'): INodeProperties => ({
	displayName: 'Inbox ID',
	name: 'inboxId',
	type: 'string',
	required: true,
	default: '',
	description,
	displayOptions: show(resource, operation),
});

const limit = (resource: string, operation: string[]): INodeProperties => ({
	displayName: 'Limit',
	name: 'limit',
	type: 'number',
	typeOptions: { minValue: 1, maxValue: 100 },
	default: 50,
	description: 'Max number of results to return',
	displayOptions: show(resource, operation),
	routing: { send: { type: 'query', property: 'limit' } },
});

// ---------------------------------------------------------------- inbox

const inboxOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['inbox'] } },
	default: 'create',
	options: [
		{
			name: 'Create',
			value: 'create',
			description: 'Create an inbox with a real email address',
			action: 'Create an inbox',
			routing: { request: { method: 'POST', url: '/v1/inboxes' } },
		},
		{
			name: 'Delete',
			value: 'delete',
			description: 'Delete an inbox and its mail',
			action: 'Delete an inbox',
			routing: { request: { method: 'DELETE', url: '/v1/inboxes/{inboxId}' }, send: ENCODE_PATH },
		},
		{
			name: 'Get',
			value: 'get',
			description: 'Get an inbox',
			action: 'Get an inbox',
			routing: { request: { method: 'GET', url: '/v1/inboxes/{inboxId}' }, send: ENCODE_PATH },
		},
		{
			name: 'Get Many',
			value: 'getAll',
			description: 'List the workspace’s inboxes',
			action: 'Get many inboxes',
			routing: {
				request: { method: 'GET', url: '/v1/inboxes' },
				output: { postReceive: [{ type: 'rootProperty', properties: { property: 'data' } }] },
			},
		},
	],
};

const inboxFields: INodeProperties[] = [
	inboxId('inbox', ['get', 'delete']),
	limit('inbox', ['getAll']),
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: show('inbox', ['create']),
		options: [
			{
				displayName: 'Client ID',
				name: 'client_id',
				type: 'string',
				default: '',
				description:
					'Your own ID for this inbox. Creating again with the same client ID returns the same inbox, so a restarted workflow never makes duplicates.',
				routing: unlessEmpty('client_id'),
			},
			{
				displayName: 'Display Name',
				name: 'display_name',
				type: 'string',
				default: '',
				description: 'Name shown in the From header, e.g. Support Bot',
				routing: unlessEmpty('display_name'),
			},
			{
				displayName: 'Username',
				name: 'username',
				type: 'string',
				default: '',
				description: 'The part before the @ (random if empty)',
				routing: unlessEmpty('username'),
			},
		],
	},
];

// ---------------------------------------------------------------- message

const messageOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['message'] } },
	default: 'send',
	options: [
		{
			name: 'Get',
			value: 'get',
			description: 'Get a message with its labels and AI scores',
			action: 'Get a message',
			routing: { request: { method: 'GET', url: '/v1/messages/{messageId}' }, send: ENCODE_PATH },
		},
		{
			name: 'Get Many',
			value: 'getAll',
			description: 'List an inbox’s messages, newest first',
			action: 'Get many messages',
			routing: {
				request: { method: 'GET', url: '/v1/inboxes/{inboxId}/messages' },
				send: ENCODE_PATH,
				output: { postReceive: [{ type: 'rootProperty', properties: { property: 'data' } }] },
			},
		},
		{
			name: 'Reply',
			value: 'reply',
			description: 'Reply in the same thread',
			action: 'Reply to a message',
			routing: { request: { method: 'POST', url: '/v1/inboxes/{inboxId}/messages/{messageId}/reply' }, send: ENCODE_PATH },
		},
		{
			name: 'Send',
			value: 'send',
			description: 'Send an email from an inbox',
			action: 'Send a message',
			routing: { request: { method: 'POST', url: '/v1/inboxes/{inboxId}/messages/send' }, send: ENCODE_PATH },
		},
		{
			name: 'Wait for Next',
			value: 'wait',
			description: 'Wait up to 60 seconds for the next email to arrive',
			action: 'Wait for the next message',
			routing: { request: { method: 'GET', url: '/v1/inboxes/{inboxId}/messages/wait' }, send: ENCODE_PATH },
		},
	],
};

const messageFields: INodeProperties[] = [
	inboxId('message', ['getAll', 'reply', 'send', 'wait'], 'ID of the inbox the message is in, or sends from'),
	{
		displayName: 'Message ID',
		name: 'messageId',
		type: 'string',
		required: true,
		default: '',
		displayOptions: show('message', ['get', 'reply']),
	},
	{
		displayName: 'To',
		name: 'to',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'ada@example.com, grace@example.com',
		description: 'One or more addresses, separated by commas',
		displayOptions: show('message', ['send']),
		routing: { send: { type: 'body', property: 'to', value: RECIPIENTS } },
	},
	{
		displayName: 'Subject',
		name: 'subject',
		type: 'string',
		required: true,
		default: '',
		displayOptions: show('message', ['send']),
		routing: { send: { type: 'body', property: 'subject' } },
	},
	{
		displayName: 'Text',
		name: 'text',
		type: 'string',
		typeOptions: { rows: 5 },
		default: '',
		description: 'Plain-text body. Give text, HTML or both.',
		displayOptions: show('message', ['send', 'reply']),
		routing: unlessEmpty('text'),
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: show('message', ['send', 'reply']),
		options: [
			{
				displayName: 'BCC',
				name: 'bcc',
				type: 'string',
				default: '',
				description: 'Addresses separated by commas (send only)',
				routing: { send: { type: 'body', property: 'bcc', value: RECIPIENTS } },
			},
			{
				displayName: 'CC',
				name: 'cc',
				type: 'string',
				default: '',
				description: 'Addresses separated by commas (send only)',
				routing: { send: { type: 'body', property: 'cc', value: RECIPIENTS } },
			},
			{
				displayName: 'HTML',
				name: 'html',
				type: 'string',
				typeOptions: { rows: 5 },
				default: '',
				routing: unlessEmpty('html'),
			},
			{
				displayName: 'Labels',
				name: 'labels',
				type: 'string',
				default: '',
				description: 'Your own labels, separated by commas',
				routing: { send: { type: 'body', property: 'labels', value: RECIPIENTS } },
			},
			{
				displayName: 'Reply All',
				name: 'reply_all',
				type: 'boolean',
				default: false,
				description: 'Whether to reply to everyone on the thread (reply only)',
				routing: { send: { type: 'body', property: 'reply_all' } },
			},
		],
	},
	limit('message', ['getAll']),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: show('message', ['getAll', 'wait']),
		options: [
			{
				displayName: 'Direction',
				name: 'direction',
				type: 'options',
				options: [
					{ name: 'Inbound', value: 'inbound' },
					{ name: 'Outbound', value: 'outbound' },
				],
				default: 'inbound',
				routing: { send: { type: 'query', property: 'direction' } },
			},
			{
				displayName: 'From Contains',
				name: 'from',
				type: 'string',
				default: '',
				description: 'Wait for Next only: text the From header contains, display name included. It does not prove who sent the email: check the labels.',
				routing: { send: { type: 'query', property: 'from', value: '={{ $value === "" ? undefined : $value }}' } },
			},
			{
				displayName: 'Labels',
				name: 'labels',
				type: 'string',
				default: '',
				placeholder: 'ai:support,ai:urgent',
				description: 'Get Many only: messages with all of these labels, separated by commas',
				routing: { send: { type: 'query', property: 'labels', value: '={{ $value === "" ? undefined : $value }}' } },
			},
			{
				displayName: 'Since',
				name: 'since',
				type: 'dateTime',
				default: '',
				description:
					'Wait for Next only: count mail that arrived after this time. Set it to just before you sent or triggered the email, so a reply that arrives quickly is not missed.',
				routing: { send: { type: 'query', property: 'since', value: '={{ $value === "" ? undefined : new Date($value).toISOString() }}' } },
			},
			{
				displayName: 'Subject Contains',
				name: 'subject',
				type: 'string',
				default: '',
				description: 'Wait for Next only: part of the subject',
				routing: { send: { type: 'query', property: 'subject', value: '={{ $value === "" ? undefined : $value }}' } },
			},
			{
				displayName: 'Timeout (Seconds)',
				name: 'timeout',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 60 },
				default: 30,
				description: 'Wait for Next only: how long to wait, 1–60 seconds',
				routing: { send: { type: 'query', property: 'timeout' } },
			},
			{
				displayName: 'Unread Only',
				name: 'is_read',
				type: 'boolean',
				default: false,
				description: 'Whether to return only unread messages (Get Many only)',
				routing: { send: { type: 'query', property: 'is_read', value: '={{ $value ? "false" : undefined }}' } },
			},
		],
	},
];

// ---------------------------------------------------------------- verification

const verificationOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['verification'] } },
	default: 'wait',
	options: [
		{
			name: 'Wait for Code',
			value: 'wait',
			description:
				'Wait for the next sign-up code or magic link and return it with the email’s labels, and a warning when it failed sender checks or was flagged (data is null on timeout)',
			action: 'Wait for a verification code',
			routing: {
				request: { method: 'GET', url: '/v1/inboxes/{inboxId}/verification' },
				// Checking the sender and adding the labels takes more than one request (see waitForCode).
				send: { ...ENCODE_PATH, paginate: true },
				operations: { pagination: waitForCode },
			},
		},
	],
};

const verificationFields: INodeProperties[] = [
	inboxId('verification', ['wait'], 'ID of the inbox you signed up with'),
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show('verification', ['wait']),
		options: [
			{
				displayName: 'From',
				name: 'from',
				type: 'string',
				default: '',
				placeholder: 'github.com',
				description:
					'Only codes from this sender: a full address (noreply@github.com) or a domain (github.com, which also matches its subdomains). Checked against the sender’s address, never the display name.',
			},
			{
				displayName: 'Since',
				name: 'since',
				type: 'dateTime',
				default: '',
				description:
					'Only codes received after this time. Set it to just before you submitted the sign-up form, so an older code is never returned.',
				routing: { send: { type: 'query', property: 'since', value: '={{ $value === "" ? undefined : new Date($value).toISOString() }}' } },
			},
			{
				displayName: 'Timeout (Seconds)',
				name: 'timeout',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 60 },
				default: 60,
				routing: { send: { type: 'query', property: 'timeout' } },
			},
		],
	},
];

// ---------------------------------------------------------------- draft

const draftOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['draft'] } },
	default: 'create',
	options: [
		{
			name: 'Create',
			value: 'create',
			description: 'Save an email for a person to approve and send from the dashboard',
			action: 'Create a draft',
			routing: { request: { method: 'POST', url: '/v1/inboxes/{inboxId}/drafts' }, send: ENCODE_PATH },
		},
	],
};

const draftFields: INodeProperties[] = [
	inboxId('draft', ['create']),
	{
		displayName: 'Reply To Message ID',
		name: 'reply_to_message_id',
		type: 'string',
		default: '',
		description: 'To draft a reply: recipients, subject and threading are filled in from this message',
		displayOptions: show('draft', ['create']),
		routing: unlessEmpty('reply_to_message_id'),
	},
	{
		displayName: 'To',
		name: 'to',
		type: 'string',
		default: '',
		description: 'For a new email: addresses separated by commas',
		displayOptions: show('draft', ['create']),
		routing: { send: { type: 'body', property: 'to', value: '={{ $value === "" ? undefined : $value.split(",").map((s) => s.trim()).filter(Boolean) }}' } },
	},
	{
		displayName: 'Subject',
		name: 'subject',
		type: 'string',
		default: '',
		displayOptions: show('draft', ['create']),
		routing: unlessEmpty('subject'),
	},
	{
		displayName: 'Text',
		name: 'text',
		type: 'string',
		typeOptions: { rows: 5 },
		default: '',
		displayOptions: show('draft', ['create']),
		routing: unlessEmpty('text'),
	},
];

export class Agentboxd implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Agentboxd',
		name: 'agentboxd',
		icon: { light: 'file:../../icons/agentboxd.svg', dark: 'file:../../icons/agentboxd.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Real email inboxes for AI agents: create inboxes, send and reply, and wait for sign-up codes',
		defaults: { name: 'Agentboxd' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'agentboxdApi', required: true }],
		requestDefaults: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}',
			headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
		},
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Draft', value: 'draft' },
					{ name: 'Inbox', value: 'inbox' },
					{ name: 'Message', value: 'message' },
					{ name: 'Verification', value: 'verification' },
				],
				default: 'message',
			},
			inboxOperations,
			...inboxFields,
			messageOperations,
			...messageFields,
			verificationOperations,
			...verificationFields,
			draftOperations,
			...draftFields,
		],
	};
}
