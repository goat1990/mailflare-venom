import type {
	CfDnsRecord,
	CfEmailRoutingRule,
	CfResponse,
	CfSendingSubdomain,
} from "@/lib/cloudflare-api.types";
import {
	formatCloudflareError,
	getCloudflareAuth,
	getCloudflareAuthHeaders,
	getCloudflareAuthHint,
	getEmailWorkerName,
} from "@/lib/cloudflare-api-utils";
import { decideEmailRoutingRuleAction, isWorkerRouteForAddress } from "@/lib/cloudflare-routing-utils";
import { CloudflareApiError } from "@/lib/cloudflare-api-error";
import { getZoneLookupCandidates } from "@/lib/domains/utils";
export type { CfDnsRecord } from "@/lib/cloudflare-api.types";

export async function cfRequest<T>(
	env: CloudflareEnv,
	path: string,
	init?: RequestInit,
): Promise<T> {
	const auth = getCloudflareAuth(env);
	const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		...init,
		headers: {
			...getCloudflareAuthHeaders(auth),
			"Content-Type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	const json = (await res.json()) as CfResponse<T>;

	if (!json.success) {
		throw new CloudflareApiError(
			`${formatCloudflareError(path, res.status, res.statusText, json.errors ?? [])}${getCloudflareAuthHint(json.errors ?? [])}`,
			res.status,
			path,
			json.errors ?? [],
		);
	}
	return json.result;
}

export async function getZone(
	env: CloudflareEnv,
	zoneId: string,
): Promise<{ id: string; name: string }> {
	return cfRequest<{ id: string; name: string }>(env, `/zones/${zoneId}`);
}

export async function findZoneByHostname(
	env: CloudflareEnv,
	hostname: string,
): Promise<{ id: string; name: string } | null> {
	for (const candidate of getZoneLookupCandidates(hostname)) {
		const zones = await cfRequest<{ id: string; name: string }[]>(
			env,
			`/zones?name=${encodeURIComponent(candidate)}&status=active`,
		);
		const zone = zones.find((z) => z.name === candidate);
		if (zone) return zone;
	}

	return null;
}

export async function getEmailRoutingDns(
	env: CloudflareEnv,
	zoneId: string,
): Promise<{ records: CfDnsRecord[]; missing: CfDnsRecord[] }> {
	const result = await cfRequest<{
		record?: CfDnsRecord[];
		errors?: { missing?: CfDnsRecord }[];
	}>(env, `/zones/${zoneId}/email/routing/dns`);
	return {
		records: result.record ?? [],
		missing: (result.errors ?? [])
			.map((e) => e.missing)
			.filter(Boolean) as CfDnsRecord[],
	};
}

export async function enableEmailRouting(
	env: CloudflareEnv,
	zoneId: string,
	hostname?: string,
) {
	return cfRequest<{ status?: string; enabled?: boolean }>(
		env,
		`/zones/${zoneId}/email/routing/dns`,
		{
			method: "POST",
			...(hostname ? { body: JSON.stringify({ name: hostname }) } : {}),
		},
	);
}

/** Disables Email Routing for the zone, or with `hostname` for that subdomain only. */
export async function disableEmailRouting(env: CloudflareEnv, zoneId: string, hostname?: string) {
	return cfRequest<unknown>(env, `/zones/${zoneId}/email/routing/dns`, {
		method: "DELETE",
		...(hostname ? { body: JSON.stringify({ name: hostname }) } : {}),
	});
}

export async function listSendingSubdomains(
	env: CloudflareEnv,
	zoneId: string,
) {
	return cfRequest<CfSendingSubdomain[]>(
		env,
		`/zones/${zoneId}/email/sending/subdomains`,
	);
}

export async function createSendingSubdomain(
	env: CloudflareEnv,
	zoneId: string,
	hostname: string,
) {
	return cfRequest<{ tag: string; name: string; enabled: boolean }>(
		env,
		`/zones/${zoneId}/email/sending/subdomains`,
		{
			method: "POST",
			body: JSON.stringify({ name: hostname }),
		},
	);
}

export async function deleteSendingSubdomain(
	env: CloudflareEnv,
	zoneId: string,
	subdomainTag: string,
) {
	return cfRequest<unknown>(
		env,
		`/zones/${zoneId}/email/sending/subdomains/${subdomainTag}`,
		{ method: "DELETE" },
	);
}

export async function getSendingSubdomainDns(
	env: CloudflareEnv,
	zoneId: string,
	subdomainTag: string,
): Promise<CfDnsRecord[]> {
	return cfRequest<CfDnsRecord[]>(
		env,
		`/zones/${zoneId}/email/sending/subdomains/${subdomainTag}/dns`,
	);
}

export async function getEmailRoutingSettings(
	env: CloudflareEnv,
	zoneId: string,
) {
	return cfRequest<{ enabled?: boolean; status?: string; name?: string }>(
		env,
		`/zones/${zoneId}/email/routing`,
	);
}

const EMAIL_ROUTING_RULES_PAGE_SIZE = 50;

/** Every rule in the zone; the API pages, and a rule missed on a later page would be created twice or never deleted. */
export async function listEmailRoutingRules(env: CloudflareEnv, zoneId: string) {
	const rules: CfEmailRoutingRule[] = [];
	for (let page = 1; ; page += 1) {
		const batch = await cfRequest<CfEmailRoutingRule[]>(
			env,
			`/zones/${zoneId}/email/routing/rules?page=${page}&per_page=${EMAIL_ROUTING_RULES_PAGE_SIZE}`,
		);
		rules.push(...batch);
		if (batch.length < EMAIL_ROUTING_RULES_PAGE_SIZE) return rules;
	}
}

export async function deleteEmailRoutingRule(
	env: CloudflareEnv,
	zoneId: string,
	ruleId: string,
) {
	return cfRequest<unknown>(
		env,
		`/zones/${zoneId}/email/routing/rules/${ruleId}`,
		{ method: "DELETE" },
	);
}

export async function createEmailRoutingRuleToWorker(
	env: CloudflareEnv,
	zoneId: string,
	address: string,
) {
	const workerName = getEmailWorkerName(env);
	return cfRequest<CfEmailRoutingRule>(
		env,
		`/zones/${zoneId}/email/routing/rules`,
		{
			method: "POST",
			body: JSON.stringify({
				actions: [{ type: "worker", value: [workerName] }],
				enabled: true,
				matchers: [{ type: "literal", field: "to", value: address }],
				name: `Route ${address} to ${workerName}`,
			}),
		},
	);
}

export async function ensureEmailRoutingRuleToWorker(
	env: CloudflareEnv,
	zoneId: string,
	address: string,
) {
	if (zoneId === "manual") return;
	const normalized = address.toLowerCase();
	const workerName = getEmailWorkerName(env);
	const rules = await listEmailRoutingRules(env, zoneId);
	const decision = decideEmailRoutingRuleAction(rules, normalized, workerName);

	if (decision.action === "reuse") return decision.rule;
	if (decision.action === "update" && decision.rule.id) {
		const existing = decision.rule;
		return cfRequest<CfEmailRoutingRule>(
			env,
			`/zones/${zoneId}/email/routing/rules/${existing.id}`,
			{
				method: "PUT",
				body: JSON.stringify({
					actions: [{ type: "worker", value: [workerName] }],
					enabled: true,
					matchers: [{ type: "literal", field: "to", value: normalized }],
					name: existing.name ?? `Route ${normalized} to ${workerName}`,
					priority: existing.priority,
				}),
			},
		);
	}

	return createEmailRoutingRuleToWorker(env, zoneId, normalized);
}

export async function deleteEmailRoutingRuleForAddress(
	env: CloudflareEnv,
	zoneId: string,
	address: string,
): Promise<boolean> {
	if (zoneId === "manual") return false;
	const normalized = address.toLowerCase();
	const workerName = getEmailWorkerName(env);
	const rules = await listEmailRoutingRules(env, zoneId);
	const existing = rules.find((rule) => isWorkerRouteForAddress(rule, normalized, workerName));
	if (!existing?.id) return false;
	await deleteEmailRoutingRule(env, zoneId, existing.id);
	return true;
}
