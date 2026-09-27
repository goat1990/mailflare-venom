/** Bulk actions in the split pane apply to every message the row stands for. */
export function threadActionIds(selected) {
	return selected.flatMap((message) =>
		message.messageIds && message.messageIds.length > 0 ? message.messageIds : [message.id],
	);
}
