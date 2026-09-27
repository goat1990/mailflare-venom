import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { seedDemoData } from "@/lib/seed";
import { demoCredentials } from "@/lib/seed-utils";

export async function POST(request: Request) {
	if (process.env.NODE_ENV === "production") {
		return NextResponse.json({ error: "Not available in production" }, { status: 403 });
	}
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const result = await seedDemoData(env);
	return NextResponse.json({
		ok: true,
		credentials: demoCredentials,
		seeded: result,
	});
}
