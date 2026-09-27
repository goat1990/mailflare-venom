import { runScheduledDatabaseBackup } from "@/lib/backups/runner";
import { runAgentMaintenance } from "@/lib/agent/maintenance";
import { retryStalledWebhookDeliveries } from "@/lib/email/webhooks";

/** Fire the daily 02:00 UTC backup and the periodic sweeps, matching the cron triggers in wrangler.jsonc. */
export function startScheduler(env: CloudflareEnv) {
	let lastRunDay = "";
	const timer = setInterval(() => {
		runAgentMaintenance(env).catch((error) => console.error("Agent maintenance failed", error));
		retryStalledWebhookDeliveries(env).catch((error) => console.error("Webhook retry sweep failed", error));
		const now = new Date();
		const day = now.toISOString().slice(0, 10);
		if (now.getUTCHours() !== 2 || lastRunDay === day) return;
		lastRunDay = day;
		runScheduledDatabaseBackup(env, now).catch((error) => console.error("Scheduled backup failed", error));
	}, 60_000);
	return () => clearInterval(timer);
}
