import type { CfEmailRoutingRule } from "@/lib/cloudflare-api.types";

export type EmailRoutingRuleDecision =
	| { action: "reuse"; rule: CfEmailRoutingRule }
	| { action: "update"; rule: CfEmailRoutingRule }
	| { action: "create" };

function isCatchAllRule(rule: CfEmailRoutingRule): boolean {
	return Boolean(rule.matchers?.some((matcher) => matcher.type === "all"));
}

function routesLiteralAddress(rule: CfEmailRoutingRule, normalizedAddress: string): boolean {
	return Boolean(
		rule.matchers?.some(
			(matcher) =>
				matcher.type === "literal" &&
				matcher.field === "to" &&
				matcher.value?.toLowerCase() === normalizedAddress,
		),
	);
}

export function isWorkerRouteForAddress(
	rule: CfEmailRoutingRule,
	address: string,
	workerName: string,
): boolean {
	if (isCatchAllRule(rule)) return false;
	const normalizedAddress = address.toLowerCase();
	const sendsToWorker = rule.actions?.some(
		(action) => action.type === "worker" && (action.value?.length ? action.value.includes(workerName) : true),
	);
	return Boolean(routesLiteralAddress(rule, normalizedAddress) && sendsToWorker);
}

/**
 * Cloudflare allows one literal `to` rule per address (409 code 2014 otherwise).
 * Reuse a rule that already delivers to this Worker. Update any other literal
 * `to` rule — a forward, or a disabled worker rule — instead of creating another.
 * Catch-all rules (`matcher.type === "all"`) are left alone.
 */
export function decideEmailRoutingRuleAction(
	rules: readonly CfEmailRoutingRule[],
	address: string,
	workerName: string,
): EmailRoutingRuleDecision {
	const normalizedAddress = address.toLowerCase();
	const literalRules = rules.filter(
		(rule) => !isCatchAllRule(rule) && routesLiteralAddress(rule, normalizedAddress),
	);
	const workerRule = literalRules.find((rule) => isWorkerRouteForAddress(rule, normalizedAddress, workerName));
	if (workerRule?.enabled) return { action: "reuse", rule: workerRule };
	if (workerRule) return { action: "update", rule: workerRule };
	const addressRule = literalRules[0];
	if (addressRule) return { action: "update", rule: addressRule };
	return { action: "create" };
}
