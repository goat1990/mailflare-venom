/** Fallback polling runs until the socket is open. Reconnects must not cancel it. */
export function realtimeFallbackOn(event) {
	return event !== "open";
}
