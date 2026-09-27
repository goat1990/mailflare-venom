function escapeHtml(value) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Draft HTML is untrusted. Strip active content and leave formatting in place. */
export function sanitizeComposerHtml(html) {
	const next = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<script\b[^>]*>[\s\S]*/gi, "")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<\/?(?:iframe|object|embed|link|meta|base|form|svg|math|script|style)\b[^>]*>/gi, "")
		.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
		.replace(/\s(?:href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi, "");
	if (/<\s*\/?\s*script/i.test(next) || /\son[a-z]+\s*=/i.test(next)) {
		return escapeHtml(html);
	}
	return next;
}
