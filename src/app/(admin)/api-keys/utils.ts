export const CREATE_KEY_PERMISSIONS: { value: string; label: string; description: string }[] = [
	{ value: "domains", label: "Manage domains", description: "Add and remove domains, and manage their DNS setup." },
	{ value: "accounts", label: "Manage accounts", description: "Create and update accounts." },
	{ value: "mailboxes", label: "Manage mailboxes", description: "Create, update, and remove mailboxes." },
	{ value: "read", label: "Read mail", description: "Read messages through the API." },
	{ value: "send", label: "Send mail", description: "Send messages through the API." },
	{ value: "jmap", label: "JMAP", description: "Read and send mail from a JMAP client." },
	{ value: "mcp:read", label: "MCP read", description: "List, search, and read messages from an MCP client." },
	{ value: "mcp:draft", label: "MCP drafts", description: "Create, edit, and discard drafts from an MCP client." },
	{ value: "mcp:organize", label: "MCP organize", description: "Mark messages read and move them from an MCP client." },
	{ value: "mcp:request-send", label: "MCP request send", description: "Propose a send that a person confirms in Mailflare. This does not send mail." },
];

export function parseApiKeyScopes(scopes: string): string[] {
	try {
		const parsed = JSON.parse(scopes);
		return Array.isArray(parsed) ? parsed.filter((scope) => typeof scope === "string") : [];
	} catch {
		return [];
	}
}
