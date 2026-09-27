export function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Everything a password change or reset must invalidate besides the new password. */
export const REVOKED_ON_PASSWORD_RESET = ["sessions", "passwordResetTokens", "loginChallenges", "apiKeys"] as const;

export type RevokedCredentialKind = (typeof REVOKED_ON_PASSWORD_RESET)[number];

export function revokedCredentialKinds(): readonly RevokedCredentialKind[] {
	return REVOKED_ON_PASSWORD_RESET;
}

/** Recovery and forwarding addresses redirect account mail, so they need the current password. */
export function profileChangeNeedsCurrentPassword(
	current: { resetEmail: string | null; forwardingEmail: string | null },
	next: { resetEmail: string | null; forwardingEmail?: string | null },
): boolean {
	const forwarding = next.forwardingEmail === undefined ? current.forwardingEmail : next.forwardingEmail;
	return (next.resetEmail ?? null) !== (current.resetEmail ?? null) || (forwarding ?? null) !== (current.forwardingEmail ?? null);
}
