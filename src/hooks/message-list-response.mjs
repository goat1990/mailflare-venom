function errorMessage(body, fallback) {
	if (body && typeof body === "object" && typeof body.error === "string" && body.error.trim()) {
		return body.error;
	}
	return fallback;
}

/** A failed load is an error. An empty `messages` array is a real empty folder. */
export function readMessageListPayload(responseOk, body) {
	if (!responseOk || !body || typeof body !== "object" || !Array.isArray(body.messages)) {
		return { ok: false, error: errorMessage(body, "Could not load messages") };
	}
	const messages = body.messages;
	return {
		ok: true,
		messages,
		total: typeof body.total === "number" ? body.total : messages.length,
		limit: body.limit,
		offset: body.offset,
	};
}
