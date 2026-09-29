import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { agentSendApprovals, apiKeys, mcpKeyMailboxes } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { generateApiKey, parseScopes, scopesToJson } from "@/lib/api-keys";
import { ADMIN_API_KEY_SCOPES, MCP_MAIL_SCOPES, scopesFromCreateRequest } from "@/lib/api/scopes";
import { isFullControlGrant } from "@/lib/mcp/agent-access";
import { newId } from "@/lib/ids";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";

const adminScopes = new Set<string>(ADMIN_API_KEY_SCOPES);
const mcpMailScopes = new Set<string>(MCP_MAIL_SCOPES);
const createKeySchema = z.object({
	name: z.string().trim().min(1).max(100),
	scopes: z.array(z.string()).min(1),
	mailboxIds: z.array(z.string().min(1)).max(30).optional(),
	mcpAllowed: z.boolean().default(false),
});

async function authorize(request: Request) {
	const env = getEnv();
	const session = await requireSessionUser(env, request);
	if (session.error) return { env, user: null, error: session.error };
	if (session.user.role !== "admin") return { env, user: null, error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
	return { env, user: session.user, error: null };
}

export async function GET(request: Request) {
	const access = await authorize(request);
	if (access.error) return access.error;
	const rows = await getDb(access.env).select({
		id: apiKeys.id,
		name: apiKeys.name,
		prefix: apiKeys.prefix,
		kind: apiKeys.kind,
		scopes: apiKeys.scopes,
		createdAt: apiKeys.createdAt,
		lastUsedAt: apiKeys.lastUsedAt,
	}).from(apiKeys).where(eq(apiKeys.userId, access.user!.id));
	return NextResponse.json({ apiKeys: rows.filter((row) => parseScopes(row.scopes).some((scope) => adminScopes.has(scope))) });
}

export async function POST(request: Request) {
	const access = await authorize(request);
	if (access.error) return access.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = createKeySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	const scopes = scopesFromCreateRequest(parsed.data.scopes);
	if (!scopes) return NextResponse.json({ error: "Unknown scope" }, { status: 400 });
	const db = getDb(access.env);
	const fullControl = isFullControlGrant(scopes);
	const mailboxIds = fullControl ? [] : [...new Set(parsed.data.mailboxIds ?? [])];
	for (const mailboxId of mailboxIds) {
		if (!(await getMailboxAccessLevel(db, access.user!, mailboxId))?.canRead) return NextResponse.json({ error: "Mailbox not found" }, { status: 403 });
	}
	const { fullKey, prefix, hash } = generateApiKey();
	const id = newId("key");
	await db.insert(apiKeys).values({
		id,
		kind: parsed.data.mcpAllowed || scopes.some((scope) => mcpMailScopes.has(scope)) ? "mcp" : "legacy",
		userId: access.user!.id,
		name: parsed.data.name,
		prefix,
		keyHash: hash,
		scopes: scopesToJson(scopes),
		mailboxScopeEnabled: mailboxIds.length > 0,
	});
	if (mailboxIds.length) await db.insert(mcpKeyMailboxes).values(mailboxIds.map((mailboxId) => ({ keyId: id, mailboxId })));
	return NextResponse.json({ key: fullKey });
}

export async function DELETE(request: Request) {
	const access = await authorize(request);
	if (access.error) return access.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const id = new URL(request.url).searchParams.get("id");
	if (!id) return NextResponse.json({ error: "Key required" }, { status: 400 });
	const db = getDb(access.env);
	const [key] = await db.select({ id: apiKeys.id, scopes: apiKeys.scopes }).from(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.userId, access.user!.id))).limit(1);
	if (!key || !parseScopes(key.scopes).some((scope) => adminScopes.has(scope))) return NextResponse.json({ error: "Key not found" }, { status: 404 });
	await db.update(agentSendApprovals).set({ status: "cancelled" }).where(and(eq(agentSendApprovals.requestKeyId, id), eq(agentSendApprovals.status, "pending")));
	await db.delete(apiKeys).where(eq(apiKeys.id, id));
	return NextResponse.json({ ok: true });
}
