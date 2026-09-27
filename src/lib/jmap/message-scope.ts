export type MessageListScope =
	| { kind: "mailbox"; mailboxId: string }
	| { kind: "mailboxes"; mailboxIds: string[] }
	| { kind: "empty" };

/**
 * Lists are scoped to mailboxes the caller can read. An empty set is an empty
 * list: matching `messages.user_id` would show mail the caller cannot open.
 */
export function resolveMessageListScope(input: {
	mailboxId?: string | null;
	accessibleMailboxIds: readonly string[];
}): MessageListScope {
	if (input.mailboxId) return { kind: "mailbox", mailboxId: input.mailboxId };
	if (input.accessibleMailboxIds.length > 0) {
		return { kind: "mailboxes", mailboxIds: [...input.accessibleMailboxIds] };
	}
	return { kind: "empty" };
}

export function jmapMailboxScope(accessibleIds: readonly string[]): "ids" | "empty" {
	return accessibleIds.length > 0 ? "ids" : "empty";
}
