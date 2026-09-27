import { NextResponse } from "next/server";
import { assertAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";

async function authorizeAdminRequest(request: Request) {
	const env = getEnv();
	let user: Awaited<ReturnType<typeof requireUser>>;

	try {
		user = await requireUser(env, request);
	} catch {
		return {
			error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
		};
	}

	try {
		assertAdmin(user);
	} catch {
		return {
			error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
		};
	}

	return { env };
}

export async function authorizeMigrationRequest(request: Request) {
	const authorization = await authorizeAdminRequest(request);
	if ("error" in authorization) return authorization;
	if (request.method !== "GET" && request.headers.get("Origin") !== new URL(request.url).origin) {
		return { error: NextResponse.json({ error: "Invalid request origin" }, { status: 403 }) };
	}
	return authorization;
}
