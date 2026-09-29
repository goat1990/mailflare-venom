import { MCP_MAIL_SCOPES } from "@/lib/api/scopes";

const MAIL_SCOPES = new Set<string>(MCP_MAIL_SCOPES);

export type AgentMailbox = { id: string; domainId: string };
export type AgentDomain = { id: string };

export type AgentGrant = {
	scopes: readonly string[];
	listedMailboxIds: readonly string[];
	ownerDomains: readonly AgentDomain[];
	ownerMailboxes: readonly AgentMailbox[];
};

export type AgentDomainDecision = { allowed: true; mailboxIds: string[] } | { allowed: false };

export function isFullControlGrant(scopes: readonly string[]): boolean {
	const mail = scopes.some((scope) => MAIL_SCOPES.has(scope));
	const admin = scopes.includes("domains") || scopes.includes("mailboxes");
	return mail && admin;
}

export function mcpDeliveryAllowed(scopes: readonly string[]): boolean {
	return scopes.includes("send");
}

export function ownerDomainsForGrant(ownedDomainIds: readonly string[], mailboxes: readonly { domainId: string }[]): AgentDomain[] {
	return [...new Set([...ownedDomainIds, ...mailboxes.map((mailbox) => mailbox.domainId)])].map((id) => ({ id }));
}

function mailboxesOnDomain(grant: AgentGrant, domainId: string): string[] {
	const listed = new Set(grant.listedMailboxIds);
	return grant.ownerMailboxes
		.filter((mailbox) => mailbox.domainId === domainId && (isFullControlGrant(grant.scopes) || listed.has(mailbox.id)))
		.map((mailbox) => mailbox.id);
}

export function resolveAgentDomain(grant: AgentGrant, domainId: string): AgentDomainDecision {
	if (!grant.ownerDomains.some((domain) => domain.id === domainId)) return { allowed: false };
	const mailboxIds = mailboxesOnDomain(grant, domainId);
	if (!isFullControlGrant(grant.scopes) && mailboxIds.length === 0) return { allowed: false };
	return { allowed: true, mailboxIds };
}

export function resolveAgentAccess(grant: AgentGrant): { mailboxIds: string[]; domainIds: string[] } {
	const domainIds = grant.ownerDomains
		.map((domain) => domain.id)
		.filter((domainId) => resolveAgentDomain(grant, domainId).allowed);
	const allowedDomains = new Set(domainIds);
	const listed = new Set(grant.listedMailboxIds);
	const mailboxIds = grant.ownerMailboxes
		.filter((mailbox) => allowedDomains.has(mailbox.domainId) && (isFullControlGrant(grant.scopes) || listed.has(mailbox.id)))
		.map((mailbox) => mailbox.id);
	return { mailboxIds, domainIds };
}
