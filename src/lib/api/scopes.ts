/**
 * Scopes an API key can be granted. Kept free of server-only imports so the
 * dashboard's key-creation form can import it without pulling in bcrypt.
 * A key holds one set of these scopes. `send` delivers mail. `mcp:request-send` only opens a review.
 */
export const API_KEY_SCOPES = ["send", "read", "jmap"] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const ADMIN_API_KEY_SCOPES = ["domains", "accounts", "mailboxes"] as const;

export const MCP_MAIL_SCOPES = ["mcp:read", "mcp:draft", "mcp:organize", "mcp:request-send"] as const;

const KNOWN_API_KEY_SCOPES = new Set<string>([...API_KEY_SCOPES, ...ADMIN_API_KEY_SCOPES, ...MCP_MAIL_SCOPES]);

export function acceptedApiKeyScopes(scopes: readonly string[]): string[] | null {
	if (scopes.length === 0) return null;
	for (const scope of scopes) {
		if (!KNOWN_API_KEY_SCOPES.has(scope)) return null;
	}
	return [...scopes];
}
