function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A shorter cid must not match the prefix of a longer one (`cid:img` inside `cid:img2`). */
export function replaceCidReference(html, contentId, url) {
	const id = contentId.replace(/^<|>$/g, "");
	if (!id) return html;
	const pattern = new RegExp(`cid:${escapeRegExp(id)}(?![A-Za-z0-9@._+-])`, "g");
	return html.replace(pattern, () => url);
}
