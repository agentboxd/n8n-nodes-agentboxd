import type { IAuthenticateGeneric, Icon, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

export class AgentboxdApi implements ICredentialType {
	name = 'agentboxdApi';

	displayName = 'Agentboxd API';

	icon: Icon = { light: 'file:../icons/agentboxd.svg', dark: 'file:../icons/agentboxd.dark.svg' };

	documentationUrl = 'https://agentboxd.com/docs/quickstart';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			placeholder: 'mr_…',
			description:
				'Create one at agentboxd.com/app → API keys. Give it only the permissions this workflow needs (for example send and read on one inbox).',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.agentboxd.com',
			description: 'Change only if you run your own Agentboxd server',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}',
			url: '/v1/account',
			method: 'GET',
		},
	};
}
