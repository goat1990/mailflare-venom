import type { McpAgentInstructionsProps } from "./mcp-agent-instructions-types";

export function buildMcpAgentPrompt(origin: string, { mode, apiKey, delivers }: McpAgentInstructionsProps): string {
	const serverUrl = `${origin || "https://your-mailflare-domain"}/mcp`;
	const instructions = delivers
		? "Call list_mailboxes for the domains and mailboxes this owner can access right now, including domains added after this key was created. Use send to deliver mail. Do not open a Mailflare review page. Domain and mailbox management tools on this key follow the same owner."
		: mode === "mail"
		? "Call list_mailboxes to find the mailboxes this key can access. Use only the tools and mailbox IDs returned by this server. Sending mail requires a review request and confirmation in Mailflare."
		: "Use only the admin management tools and permissions exposed by this key. This key cannot read or send mail.";

	return `Connect to my Mailflare MCP server using these settings:\nServer URL: ${serverUrl}\nTransport: Streamable HTTP\nAuthorization header: Bearer ${apiKey}\n\n${instructions}\nDo not print the API key in your replies or logs. If you cannot configure the MCP connection directly, tell me which settings to enter in my client.`;
}
