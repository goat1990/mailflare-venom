/**
 * Call only after session authentication. The session lives in the cookie.
 * A Bearer header is not a second credential and does not skip this check.
 */
export function hasValidSessionMutationOrigin(request: Request): boolean {
	const fetchSite = request.headers.get("Sec-Fetch-Site");
	if (fetchSite === "same-origin") return true;
	if (fetchSite === "cross-site" || fetchSite === "same-site") return false;
	const origin = request.headers.get("Origin");
	return origin !== null && origin === new URL(request.url).origin;
}
