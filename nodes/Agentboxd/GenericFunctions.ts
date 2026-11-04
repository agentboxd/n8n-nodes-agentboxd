import {
	NodeOperationError,
	type DeclarativeRestApiSettings,
	type IDataObject,
	type IExecutePaginationFunctions,
	type IExecuteSingleFunctions,
	type IHttpRequestOptions,
	type INode,
	type INodeExecutionData,
} from 'n8n-workflow';

// ---------------------------------------------------------------- request paths

const PATH_LABELS: Record<string, string> = { inboxId: 'Inbox ID', messageId: 'Message ID', webhookId: 'Webhook ID' };

/**
 * A parameter value as one URL path segment. It is percent-encoded, so it can never add path segments, a
 * query or a fragment, and an empty value, "." or ".." is refused instead of being sent.
 */
export function pathSegment(node: INode, name: string, value: unknown): string {
	const label = PATH_LABELS[name] ?? name;
	const segment = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
	if (segment === '') throw new NodeOperationError(node, `${label} is empty`, { description: `Set ${label} to the ID returned by Agentboxd.` });
	if (segment === '.' || segment === '..') {
		throw new NodeOperationError(node, `${label} "${segment}" is not a valid ID`, { description: `Set ${label} to the ID returned by Agentboxd.` });
	}
	return encodeURIComponent(segment);
}

/** Request URLs name their parameters as `{inboxId}`; anything that is not a placeholder is left as is. */
const PLACEHOLDER = /\{(\w+)\}/g;

/** preSend for every operation with an ID in its URL: fills each `{name}` with the encoded parameter value. */
export async function encodePathParameters(this: IExecuteSingleFunctions, requestOptions: IHttpRequestOptions): Promise<IHttpRequestOptions> {
	const node = this.getNode();
	requestOptions.url = requestOptions.url.replace(PLACEHOLDER, (_match, name: string) => pathSegment(node, name, this.getNodeParameter(name, '')));
	return requestOptions;
}

// ---------------------------------------------------------------- senders

/** A bare address: no spaces, quotes, angle brackets, comments or list separators. */
const ADDRESS = /^[^\s@<>()",;]+@[^\s@<>()",;]+$/;

/**
 * The sender's address from a From value such as `"GitHub" <noreply@github.com>`, lowercased, or '' when
 * it holds no single plain address. The display name is never part of the result.
 */
export function senderAddress(from: unknown): string {
	if (typeof from !== 'string') return '';
	const value = from.trim();
	const angle = /<([^<>]*)>$/.exec(value);
	const address = (angle ? angle[1] : value).trim().toLowerCase();
	return ADDRESS.test(address) ? address : '';
}

export type SenderFilter = { address: string } | { domain: string };

const filterError = (node: INode, value: string) =>
	new NodeOperationError(node, `From "${value}" is not an email address or a domain`, {
		description: 'Use a full address (ada@example.com) or a domain (example.com, which also matches its subdomains).',
	});

/** The From option: a full address (exact match) or a domain (that domain or any subdomain). Empty: no filter. */
export function parseSenderFilter(node: INode, value: unknown): SenderFilter | undefined {
	const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
	if (raw === '') return undefined;
	if (!raw.startsWith('@') && raw.includes('@')) {
		if (!ADDRESS.test(raw)) throw filterError(node, raw);
		return { address: raw };
	}
	const domain = raw.replace(/^@/, '').replace(/\.$/, '');
	const labels = domain.split('.');
	if (labels.length < 2 || labels.some((l) => l === '' || /[\s@<>()",;/\\]/.test(l))) throw filterError(node, raw);
	return { domain };
}

/** Whether the sender's address (never its display name) matches the filter. */
export function senderMatches(filter: SenderFilter, from: unknown): boolean {
	const address = senderAddress(from);
	if (!address) return false;
	if ('address' in filter) return address === filter.address;
	const domain = address.slice(address.lastIndexOf('@') + 1).replace(/\.$/, '');
	return domain === filter.domain || domain.endsWith(`.${filter.domain}`);
}

// ---------------------------------------------------------------- labels

const SENDER_CHECK_LABELS = ['dmarc-fail', 'spf-fail'];
const PHISHING_LABELS = ['ai:phishing'];
const INJECTION_LABELS = ['ai:injection-risk', 'local:injection-risk'];
export const RISK_LABELS = [...SENDER_CHECK_LABELS, ...PHISHING_LABELS, ...INJECTION_LABELS];

const sentence = (parts: string[]) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/** A warning to show next to a code or link from an email that failed sender checks or was flagged, else null. */
export function riskWarning(labels: unknown): string | null {
	const list = Array.isArray(labels) ? labels.filter((l): l is string => typeof l === 'string') : [];
	const found = RISK_LABELS.filter((l) => list.includes(l));
	if (!found.length) return null;
	const reasons: string[] = [];
	if (found.some((l) => SENDER_CHECK_LABELS.includes(l))) reasons.push('failed sender checks, so it may not come from who it claims');
	if (found.some((l) => PHISHING_LABELS.includes(l))) reasons.push('looks like phishing');
	if (found.some((l) => INJECTION_LABELS.includes(l))) reasons.push('may contain a prompt injection');
	return `Warning: this email ${sentence(reasons)} (labels: ${found.join(', ')}). Check it before using the code or link.`;
}

// ---------------------------------------------------------------- wait for code

/** The API's default when no timeout is given. */
const DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * Wait for Code. The API matches `from` as text anywhere in the From header, so each code it returns is
 * checked here against the sender's address, and one that does not match is skipped while the wait goes on
 * for a newer one. The message's labels are added to the result, with a warning when it failed sender
 * checks or was flagged as phishing or prompt injection.
 *
 * Runs as the operation's pagination function, the declarative way to make more than one request.
 */
export async function waitForCode(this: IExecutePaginationFunctions, requestData: DeclarativeRestApiSettings.ResultOptions): Promise<INodeExecutionData[]> {
	const node = this.getNode();
	const filter = parseSenderFilter(node, this.getNodeParameter('options.from', ''));
	const qs: IDataObject = { ...(requestData.options.qs as IDataObject) };
	delete qs.from;
	if (filter) qs.from = 'address' in filter ? filter.address : filter.domain; // narrows the search; the check below decides
	const deadline = Date.now() + (Number(qs.timeout) || DEFAULT_TIMEOUT_SECONDS) * 1000;
	const request = (options: Partial<DeclarativeRestApiSettings.HttpRequestOptions>) =>
		this.makeRoutingRequest({ ...requestData, options: { ...requestData.options, ...options } });
	let skipped = 0;

	for (;;) {
		const [result] = await request({ qs });
		const data = (result?.json.data ?? null) as IDataObject | null;
		if (!data) break;

		const [fetched] = await request({ method: 'GET', url: `/v1/messages/${pathSegment(node, 'messageId', data.message_id)}`, qs: {} });
		const message = (fetched?.json ?? {}) as IDataObject;
		const labels = Array.isArray(message.labels) ? message.labels : [];
		if (!filter || senderMatches(filter, message.from ?? data.from)) {
			return [{ json: { data: { warning: riskWarning(labels), ...data, labels } } }];
		}

		// Not from the sender asked for: wait for a newer code only.
		skipped++;
		const createdAt = Date.parse(String(message.created_at ?? data.received_at ?? ''));
		const remaining = Math.floor((deadline - Date.now()) / 1000);
		if (Number.isNaN(createdAt) || remaining < 1) break;
		qs.since = new Date(createdAt + 1).toISOString();
		qs.timeout = remaining;
	}

	const note = skipped
		? `Ignored ${skipped} email${skipped === 1 ? '' : 's'} with a code from a sender that did not match "${String(qs.from)}".`
		: null;
	return [{ json: { data: null, ...(note ? { warning: note } : {}) } }];
}
