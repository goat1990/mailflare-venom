// @ts-ignore — generated at build time
import { default as nextHandler } from "./.open-next/worker.js";
import { processInboundMessage } from "./src/lib/email/inbound";
import { processOutboundQueue, type OutboundQueueMessage } from "./src/lib/email/send";
import { isInboundQueueMessage, isWebhookRetryMessage } from "./worker-utils";
import { processWebhookRetry, retryStalledWebhookDeliveries, type WebhookRetryMessage } from "./src/lib/email/webhooks";
import { forwardMessage } from "./src/lib/email/incoming";
import { intakeIncomingMail } from "./src/lib/email/intake";
import { getUserFromSession } from "./src/lib/auth/session";
import { getSessionTokenFromRequest } from "./src/lib/realtime/utils";
import { runScheduledDatabaseBackup } from "./src/lib/backups/runner";
import { processAgentDraftJob } from "./src/lib/agent/jobs/utils";
import { runAgentMaintenance } from "./src/lib/agent/maintenance";
export { RealtimeHub } from "./src/lib/realtime/hub";

export default {
	async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (url.pathname === "/api/realtime") {
			if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
				return new Response("Expected WebSocket upgrade", { status: 426 });
			}

			const user = await getUserFromSession(env, getSessionTokenFromRequest(request));
			if (!user || user.disabled) {
				return new Response("Unauthorized", { status: 401 });
			}

			const hub = env.REALTIME.getByName(user.id);
			return hub.fetch(new Request("https://mailflare-realtime/connect", request));
		}

		return nextHandler.fetch(request, env, ctx);
	},

	async email(message: ForwardableEmailMessage, env: CloudflareEnv) {
		// Domain routing rules are resolved here rather than in the queue because reject and
		// forward can only be actioned on the live ForwardableEmailMessage. A failed store or
		// enqueue is thrown, not turned into setReject, which is a permanent SMTP failure.
		await intakeIncomingMail(
			env,
			{ from: message.from, to: message.to, raw: await new Response(message.raw).arrayBuffer(), headers: Object.fromEntries(message.headers) },
			{
				reject: (reason) => message.setReject(reason),
				forward: (destination, headers) => forwardMessage(message, destination, headers),
			},
		);
	},

	async queue(batch: MessageBatch, env: CloudflareEnv): Promise<void> {
		for (const msg of batch.messages) {
			try {
				if (isInboundQueueMessage(msg.body)) {
					await processInboundMessage(env, msg.body);
				} else if (typeof msg.body === "object" && msg.body !== null && (msg.body as { kind?: unknown }).kind === "agent.draft" && typeof (msg.body as { jobId?: unknown }).jobId === "string") {
					await processAgentDraftJob(env, (msg.body as { jobId: string }).jobId);
				} else if (isWebhookRetryMessage(msg.body)) {
					await processWebhookRetry(env, msg.body as WebhookRetryMessage);
				} else if (typeof msg.body === "object" && msg.body !== null && (msg.body as { kind?: unknown }).kind === "email.scheduled") {
					await processOutboundQueue(env, msg.body as OutboundQueueMessage);
				} else {
					throw new Error("Unknown queue message type");
				}
				msg.ack();
			} catch (err) {
				console.error("Queue processing failed", err);
				msg.retry({ delaySeconds: 10 });
			}
		}
	},

	async scheduled(controller: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext) {
		if (controller.cron === "0 2 * * *") ctx.waitUntil(runScheduledDatabaseBackup(env, new Date(controller.scheduledTime)));
		ctx.waitUntil(runAgentMaintenance(env));
		ctx.waitUntil(retryStalledWebhookDeliveries(env));
	},
} satisfies ExportedHandler<CloudflareEnv>;
