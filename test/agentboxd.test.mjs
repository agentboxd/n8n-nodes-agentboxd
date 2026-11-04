// Runs against the compiled node in dist/: `npm run build`, then `npm test`.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const { Agentboxd } = require('../dist/nodes/Agentboxd/Agentboxd.node.js');
const {
	encodePathParameters,
	parseSenderFilter,
	pathSegment,
	riskWarning,
	senderAddress,
	senderMatches,
	waitForCode,
} = require('../dist/nodes/Agentboxd/GenericFunctions.js');

const node = { id: '1', name: 'Agentboxd', type: 'n8n-nodes-agentboxd.agentboxd', typeVersion: 1, position: [0, 0], parameters: {} };

describe('request paths', () => {
	const operations = new Agentboxd().description.properties
		.filter((p) => p.name === 'operation')
		.flatMap((p) => p.options.map((o) => ({ resource: p.displayOptions.show.resource[0], ...o })));

	test('no URL is an expression, and every URL with an ID encodes it', () => {
		assert.ok(operations.length > 0);
		for (const op of operations) {
			const url = op.routing.request.url;
			assert.ok(!url.startsWith('=') && !url.includes('$parameter'), `${op.resource}.${op.value}: ${url}`);
			if (url.includes('{')) assert.ok(op.routing.send?.preSend?.includes(encodePathParameters), `${op.resource}.${op.value} does not encode ${url}`);
		}
	});

	const fill = (url, params) =>
		encodePathParameters.call({ getNode: () => node, getNodeParameter: (name, fallback) => params[name] ?? fallback }, { url });

	test('IDs are percent-encoded, so they cannot change the path, query or fragment', async () => {
		const { url } = await fill('/v1/inboxes/{inboxId}/messages/{messageId}/reply', { inboxId: '../../x#', messageId: 'a b/c?d=1' });
		assert.equal(url, '/v1/inboxes/..%2F..%2Fx%23/messages/a%20b%2Fc%3Fd%3D1/reply');
		assert.equal((await fill('/v1/messages/{messageId}', { messageId: ' 0b6c1c0e-1d4e-4b8a-9a52-5c1f3d0f6a11 ' })).url, '/v1/messages/0b6c1c0e-1d4e-4b8a-9a52-5c1f3d0f6a11');
		assert.equal((await fill('/v1/messages/{messageId}', { messageId: '%2e%2e' })).url, '/v1/messages/%252e%252e');
	});

	test('empty, "." and ".." are refused', async () => {
		for (const bad of ['', '   ', '.', '..', ' .. ', undefined, null, {}]) {
			await assert.rejects(fill('/v1/inboxes/{inboxId}', { inboxId: bad }), /Inbox ID (is empty|"\.{1,2}" is not a valid ID)/, String(bad));
		}
		assert.throws(() => pathSegment(node, 'webhookId', '..'), /Webhook ID/);
	});
});

describe('sender check', () => {
	test('reads the address, never the display name', () => {
		assert.equal(senderAddress('"GitHub" <NoReply@GitHub.com>'), 'noreply@github.com');
		assert.equal(senderAddress('noreply@github.com'), 'noreply@github.com');
		assert.equal(senderAddress('"<a@github.com>" <x@evil.tld>'), 'x@evil.tld');
		assert.equal(senderAddress('x@evil.tld (github.com)'), '');
		assert.equal(senderAddress('github.com'), '');
		assert.equal(senderAddress(undefined), '');
	});

	test('a domain matches itself and its subdomains only', () => {
		const github = parseSenderFilter(node, 'GitHub.com');
		assert.deepEqual(github, { domain: 'github.com' });
		assert.deepEqual(parseSenderFilter(node, '@github.com'), { domain: 'github.com' });
		assert.equal(senderMatches(github, 'GitHub <noreply@github.com>'), true);
		assert.equal(senderMatches(github, 'noreply@mail.github.com'), true);
		assert.equal(senderMatches(github, '"github.com" <x@evil.tld>'), false);
		assert.equal(senderMatches(github, 'noreply@evilgithub.com'), false);
		assert.equal(senderMatches(github, 'noreply@github.com.evil.tld'), false);
		assert.equal(senderMatches(github, 'x@evil.tld (github.com)'), false);
	});

	test('an address matches exactly', () => {
		const filter = parseSenderFilter(node, 'NoReply@github.com');
		assert.deepEqual(filter, { address: 'noreply@github.com' });
		assert.equal(senderMatches(filter, 'GitHub <noreply@github.com>'), true);
		assert.equal(senderMatches(filter, 'noreply@mail.github.com'), false);
		assert.equal(senderMatches(filter, '"noreply@github.com" <x@evil.tld>'), false);
	});

	test('anything else is refused, empty means no filter', () => {
		assert.equal(parseSenderFilter(node, ''), undefined);
		assert.equal(parseSenderFilter(node, '  '), undefined);
		for (const bad of ['noreply', 'github', '"x"@github.com', 'a@b@c.com', 'git hub.com', 'github..com']) {
			assert.throws(() => parseSenderFilter(node, bad), /is not an email address or a domain/, bad);
		}
	});
});

describe('risk warning', () => {
	test('only for the risky labels', () => {
		assert.equal(riskWarning([]), null);
		assert.equal(riskWarning(['ai:support', 'spam-ish']), null);
		assert.equal(riskWarning(undefined), null);
		assert.match(riskWarning(['dmarc-fail']), /^Warning: this email failed sender checks.*\(labels: dmarc-fail\)\. Check it before using the code or link\.$/);
		assert.match(riskWarning(['spf-fail']), /failed sender checks/);
		assert.match(riskWarning(['ai:phishing']), /looks like phishing/);
		assert.match(riskWarning(['local:injection-risk']), /prompt injection/);
		const all = riskWarning(['ai:injection-risk', 'spf-fail', 'ai:phishing']);
		assert.match(all, /failed sender checks, so it may not come from who it claims, looks like phishing and may contain a prompt injection/);
		assert.match(all, /\(labels: spf-fail, ai:phishing, ai:injection-risk\)/);
	});
});

describe('Wait for Code', () => {
	/** Answers each request with the next response, keeping what was asked. */
	function api(from, responses) {
		const requests = [];
		const ctx = {
			getNode: () => node,
			getNodeParameter: (name, fallback) => (name === 'options.from' ? from : fallback),
			makeRoutingRequest: async ({ options }) => {
				requests.push({ method: options.method, url: options.url, qs: { ...options.qs } });
				assert.ok(responses.length, `unexpected request ${options.url}`);
				return [{ json: responses.shift() }];
			},
		};
		const requestData = { options: { method: 'GET', url: '/v1/inboxes/abc/verification', qs: { timeout: 30 }, body: {}, headers: {} }, preSend: [], postReceive: [] };
		return { requests, run: () => waitForCode.call(ctx, requestData) };
	}

	test('skips a code whose sender only looks right, and adds labels and a warning', async () => {
		const { requests, run } = api('github.com', [
			{ data: { code: '111111', link: null, message_id: 'm1', from: '"github.com" <x@evil.tld>', received_at: '2026-11-04T10:00:00.000Z' } },
			{ id: 'm1', from: '"github.com" <x@evil.tld>', labels: ['dmarc-fail'], created_at: '2026-11-04T10:00:00.000Z' },
			{ data: { code: '222222', link: null, message_id: 'm2', from: 'GitHub <noreply@github.com>', received_at: '2026-11-04T10:00:05.000Z' } },
			{ id: 'm2', from: 'GitHub <noreply@github.com>', labels: ['ai:injection-risk', 'ai:security'], created_at: '2026-11-04T10:00:05.000Z' },
		]);
		const [item] = await run();
		assert.equal(item.json.data.code, '222222');
		assert.deepEqual(item.json.data.labels, ['ai:injection-risk', 'ai:security']);
		assert.match(item.json.data.warning, /prompt injection/);
		assert.deepEqual(
			requests.map((r) => r.url),
			['/v1/inboxes/abc/verification', '/v1/messages/m1', '/v1/inboxes/abc/verification', '/v1/messages/m2'],
		);
		assert.equal(requests[0].qs.from, 'github.com');
		assert.equal(requests[2].qs.since, '2026-11-04T10:00:00.001Z');
		assert.ok(requests[2].qs.timeout >= 1 && requests[2].qs.timeout <= 30);
		assert.deepEqual(requests[1].qs, {});
	});

	test('a clean match has its labels and no warning', async () => {
		const { run } = api('', [
			{ data: { code: '333333', link: null, message_id: 'm3', from: 'a@b.com' } },
			{ id: 'm3', from: 'a@b.com', labels: [], created_at: '2026-11-04T10:00:00.000Z' },
		]);
		const [item] = await run();
		assert.deepEqual(item.json, { data: { warning: null, code: '333333', link: null, message_id: 'm3', from: 'a@b.com', labels: [] } });
	});

	test('timeout returns data: null', async () => {
		const { requests, run } = api('github.com', [{ data: null }]);
		assert.deepEqual(await run(), [{ json: { data: null } }]);
		assert.equal(requests.length, 1);
	});

	test('a bad From is refused before any request', async () => {
		const { requests, run } = api('noreply', []);
		await assert.rejects(run(), /is not an email address or a domain/);
		assert.equal(requests.length, 0);
	});

	test('a message ID from the API is encoded too', async () => {
		const { requests, run } = api('', [
			{ data: { code: '1', message_id: '../inboxes', from: 'a@b.com' } },
			{ id: 'x', from: 'a@b.com', labels: [] },
		]);
		await run();
		assert.equal(requests[1].url, '/v1/messages/..%2Finboxes');
	});
});
