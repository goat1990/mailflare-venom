import { cookies } from "next/headers";
import { SESSION_COOKIE, getUserFromSession } from "@/lib/auth/session";

function sessionCookieFromRequest(request?: Request): string | undefined {
	const header = request?.headers.get("Cookie");
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const [name, ...valueParts] = part.trim().split("=");
		if (name === SESSION_COOKIE) {
			const value = valueParts.join("=");
			return value ? decodeURIComponent(value) : undefined;
		}
	}
	return undefined;
}

/** The session cookie is the only browser credential. Authorization is not a session. */
export async function getCurrentUser(env: CloudflareEnv, request?: Request) {
	const jar = await cookies();
	const token = jar.get(SESSION_COOKIE)?.value ?? sessionCookieFromRequest(request);
	const user = await getUserFromSession(env, token);
	return user?.disabled ? null : user;
}

export async function requireUser(env: CloudflareEnv, request?: Request) {
	const user = await getCurrentUser(env, request);
	if (!user) throw new Error("Unauthorized");
	return user;
}
