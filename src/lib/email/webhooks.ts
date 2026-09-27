import { and, eq, lte, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import type { AppDatabase } from "@/db";
import { webhookDeliveries, webhooks } from "@/db/schema";
import { newId } from "@/lib/ids";

export type WebhookEventType = "message.inbound" | "message.outbound" | "message.failed";

export const WEBHOOK_EVENT_TYPES: WebhookEventType[] = [
	"message.inbound",
	"message.outbound",
	"message.failed",
];

/** Retry work is carried on the existing outbound queue so no new binding is required. */
export type WebhookRetryMessage = {
	kind: "webhook.retry";
	deliveryId: string;
	/** Attempts already made when the retry was scheduled; a retry that finds more is stale. */
	attempts?: number;
};

export type WebhookDeliveryStatus = "pending" | "delivered" | "failed" | "retrying" | "exhausted";

type WebhookRow = typeof webhooks.$inferSelect;
type DeliveryRow = typeof webhookDeliveries.$inferSelect;

/** The Node runtime resolves hostnames for the private-address check; Workers enforce it with `global_fetch_strictly_public`. */
type WebhookEnv = CloudflareEnv & { HOST_RESOLVER?: (hostname: string) => Promise<string[]> };

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_SNIPPET = 500;
/** A retry whose queue message should have fired this long ago is taken over by the sweep. */
const STALLED_RETRY_MS = 5 * 60_000;
const STALLED_RETRY_BATCH = 20;

/** Exponential backoff, capped at one hour: 1m, 2m, 4m, 8m, 16m... */
export function getRetryDelaySeconds(attempt: number): number {
	return Math.min(60 * 2 ** Math.max(attempt - 1, 0), 3600);
}

export function parseWebhookEvents(events: string): string[] {
	try {
		const parsed = JSON.parse(events);
		return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string") : [];
	} catch {
		return [];
	}
}

export async function dispatchWebhooks(
	env: CloudflareEnv,
	userId: string,
	eventType: WebhookEventType,
	payload: Record<string, unknown>,
): Promise<void> {
	const db = getDb(env);
	const hooks = await db.select().from(webhooks).where(eq(webhooks.userId, userId));
	const body = JSON.stringify({ type: eventType, data: payload });

	// Every delivery is recorded before any is attempted, so one that fails midway leaves the
	// rest pending for the stalled-delivery sweep instead of never created.
	const pending: Array<{ hook: WebhookRow; delivery: PendingDelivery }> = [];
	for (const hook of hooks) {
		if (!hook.enabled) continue;
		if (!parseWebhookEvents(hook.events).includes(eventType)) continue;
		pending.push({ hook, delivery: await createDelivery(db, hook.id, eventType, body) });
	}
	for (const { hook, delivery } of pending) {
		try {
			await attemptDelivery(env, db, hook, delivery);
		} catch (error) {
			console.error(`Webhook delivery ${delivery.id} failed to run`, error);
		}
	}
}

type PendingDelivery = Pick<DeliveryRow, "id" | "payload" | "eventType" | "attempts">;

async function createDelivery(
	db: AppDatabase,
	webhookId: string,
	eventType: string,
	payload: string,
): Promise<PendingDelivery> {
	const id = newId("whd");
	await db.insert(webhookDeliveries).values({
		id,
		webhookId,
		eventType,
		payload,
		status: "pending",
		attempts: 0,
	});
	return { id, payload, eventType, attempts: 0 };
}

/**
 * Runs one delivery attempt and records the outcome, scheduling a retry when it fails. The
 * attempt number is claimed first, so a queued retry, the sweep and the manual retry button
 * cannot send the same attempt twice. Returns null when another runner claimed it.
 */
async function attemptDelivery(
	env: CloudflareEnv,
	db: AppDatabase,
	hook: WebhookRow,
	delivery: PendingDelivery,
): Promise<WebhookDeliveryStatus | null> {
	const now = new Date();
	const [claimed] = await db
		.update(webhookDeliveries)
		.set({ attempts: sql`${webhookDeliveries.attempts} + 1`, lastAttemptAt: now })
		.where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.attempts, delivery.attempts)))
		.returning({ attempts: webhookDeliveries.attempts });
	if (!claimed) return null;
	const attempts = claimed.attempts;
	const startedAt = Date.now();

	let responseStatus: number | null = null;
	let error: string | null = null;
	const blockedReason = await getBlockedWebhookTarget(env, hook.url);

	if (blockedReason) {
		error = blockedReason;
	} else {
		try {
			const signature = await signPayload(hook.secret, delivery.payload);
			const res = await fetch(hook.url, {
				method: "POST",
				redirect: "manual",
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				headers: {
					"Content-Type": "application/json",
					"X-Email-Platform-Signature": signature,
					"X-Email-Platform-Event": delivery.eventType,
					"X-Email-Platform-Delivery": delivery.id,
					"X-Email-Platform-Attempt": String(attempts),
				},
				body: delivery.payload,
			});
			responseStatus = res.status;
			if (!res.ok) {
				error = (await readResponseSnippet(res)) || `Endpoint responded with ${res.status}`;
			}
		} catch (err) {
			error = err instanceof Error ? err.message : "Request failed";
		}
	}

	const durationMs = Date.now() - startedAt;
	const delivered = !error;
	const canRetry = !delivered && !blockedReason && attempts < hook.maxAttempts;
	const status: WebhookDeliveryStatus = delivered ? "delivered" : blockedReason ? "failed" : canRetry ? "retrying" : "exhausted";
	const nextRetryAt = canRetry ? new Date(Date.now() + getRetryDelaySeconds(attempts) * 1000) : null;

	await db
		.update(webhookDeliveries)
		.set({
			status,
			responseStatus,
			error: error ? error.slice(0, MAX_RESPONSE_SNIPPET) : null,
			durationMs,
			nextRetryAt,
		})
		.where(eq(webhookDeliveries.id, delivery.id));

	if (canRetry) {
		await scheduleRetry(env, delivery.id, attempts, getRetryDelaySeconds(attempts));
	}

	return status;
}

async function scheduleRetry(env: CloudflareEnv, deliveryId: string, attempts: number, delaySeconds: number): Promise<void> {
	const message: WebhookRetryMessage = { kind: "webhook.retry", deliveryId, attempts };
	try {
		await env.OUTBOUND_QUEUE.send(message, { delaySeconds });
	} catch (error) {
		// The delivery is already recorded as retrying with nextRetryAt; the sweep picks it up.
		console.error(`Failed to schedule webhook retry for ${deliveryId}`, error);
	}
}

/** Queue consumer entry point for scheduled retries. */
export async function processWebhookRetry(
	env: CloudflareEnv,
	message: WebhookRetryMessage,
): Promise<void> {
	await runDelivery(env, message.deliveryId, { attempts: message.attempts, scheduled: true });
}

/**
 * Runs (or re-runs) a delivery. Used by the retry queue, the stalled-delivery sweep and the
 * manual retry button. Scheduled runs skip deliveries that are no longer waiting, whose attempt
 * already ran, or whose webhook was disabled. Returns null when the delivery or its webhook no
 * longer exists.
 */
export async function runDelivery(
	env: CloudflareEnv,
	deliveryId: string,
	options?: { userId?: string; attempts?: number; scheduled?: boolean },
): Promise<{ status: WebhookDeliveryStatus } | null> {
	const db = getDb(env);
	const [delivery] = await db
		.select()
		.from(webhookDeliveries)
		.where(eq(webhookDeliveries.id, deliveryId))
		.limit(1);
	if (!delivery) return null;

	const [hook] = await db.select().from(webhooks).where(eq(webhooks.id, delivery.webhookId)).limit(1);
	if (!hook) return null;
	if (options?.userId && hook.userId !== options.userId) return null;

	const current = delivery.status as WebhookDeliveryStatus;
	if (options?.scheduled) {
		const waiting = current === "pending" || current === "retrying";
		const stale = options.attempts !== undefined && options.attempts !== delivery.attempts;
		if (!waiting || stale || !hook.enabled) return { status: current };
	}

	return { status: (await attemptDelivery(env, db, hook, delivery)) ?? current };
}

/**
 * Runs deliveries whose retry never arrived (the queue send failed or its message was lost) or
 * that were recorded but never attempted. Called from the cron trigger and the Node scheduler.
 */
export async function retryStalledWebhookDeliveries(env: CloudflareEnv): Promise<void> {
	const db = getDb(env);
	const cutoff = new Date(Date.now() - STALLED_RETRY_MS);
	const stalled = await db
		.select({ id: webhookDeliveries.id, attempts: webhookDeliveries.attempts })
		.from(webhookDeliveries)
		.where(or(
			and(eq(webhookDeliveries.status, "retrying"), lte(webhookDeliveries.nextRetryAt, cutoff)),
			and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.createdAt, cutoff)),
		))
		.limit(STALLED_RETRY_BATCH);
	for (const delivery of stalled) {
		try {
			await runDelivery(env, delivery.id, { attempts: delivery.attempts, scheduled: true });
		} catch (error) {
			console.error(`Stalled webhook delivery ${delivery.id} failed to run`, error);
		}
	}
}

/** Sends a synthetic event so an operator can verify an endpoint from the UI. */
export async function sendTestDelivery(
	env: CloudflareEnv,
	hook: WebhookRow,
): Promise<{ deliveryId: string; status: WebhookDeliveryStatus }> {
	const db = getDb(env);
	const body = JSON.stringify({
		type: "message.inbound",
		test: true,
		data: {
			messageId: "test",
			from: "postmaster@example.com",
			to: "inbox@example.com",
			subject: "Mailflare test delivery",
		},
	});
	const delivery = await createDelivery(db, hook.id, "message.inbound", body);
	const status = (await attemptDelivery(env, db, hook, delivery)) ?? "pending";
	return { deliveryId: delivery.id, status };
}

/**
 * Why a webhook URL may not be called, or null. The endpoint is user-chosen and the request
 * carries a signature, so loopback, private and link-local targets are refused.
 */
export async function getBlockedWebhookTarget(env: CloudflareEnv, url: string): Promise<string | null> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "Webhook URL is invalid";
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "Webhook URL must use http or https";
	const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (hostname === "localhost" || hostname.endsWith(".localhost")) return "Webhook URL points at this host";
	const addresses = isIpAddress(hostname) ? [hostname] : await resolveHostAddresses(env, hostname);
	if (addresses.some(isNonPublicAddress)) return "Webhook URL resolves to a private or loopback address";
	return null;
}

/** A lookup failure is left to the request itself, which records it as a failed attempt. */
async function resolveHostAddresses(env: CloudflareEnv, hostname: string): Promise<string[]> {
	try {
		return (await (env as WebhookEnv).HOST_RESOLVER?.(hostname)) ?? [];
	} catch {
		return [];
	}
}

function isIpAddress(hostname: string): boolean {
	return hostname.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
}

export function isNonPublicAddress(address: string): boolean {
	const value = address.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
	if (!value.includes(":")) return isNonPublicIPv4(value);
	if (value === "::" || value === "::1") return true;
	const embedded = value.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/)?.[1] ?? hexPairToIPv4(value.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/));
	if (embedded) return isNonPublicIPv4(embedded);
	return /^f[cd]/.test(value) || /^fe[89ab]/.test(value) || /^ff/.test(value);
}

function hexPairToIPv4(match: RegExpMatchArray | null): string | null {
	if (!match) return null;
	const high = Number.parseInt(match[1], 16);
	const low = Number.parseInt(match[2], 16);
	return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

function isNonPublicIPv4(address: string): boolean {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const [a, b, c] = parts;
	return a === 0 || a === 10 || a === 127 || a >= 224
		|| (a === 100 && b >= 64 && b <= 127)
		|| (a === 169 && b === 254)
		|| (a === 172 && b >= 16 && b <= 31)
		|| (a === 192 && b === 168)
		|| (a === 192 && b === 0 && c === 0)
		|| (a === 198 && (b === 18 || b === 19));
}

async function readResponseSnippet(res: Response): Promise<string> {
	try {
		const text = await res.text();
		return text.trim().slice(0, MAX_RESPONSE_SNIPPET);
	} catch {
		return "";
	}
}

async function signPayload(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
