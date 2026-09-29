/**
 * A new mailbox is one local part on one domain. Extra addresses are more rows,
 * or an explicit "use all domains" choice on that mailbox later.
 */
export const NEW_MAILBOX_USES_ALL_DOMAINS = false;

export function mailboxAddress(localPart: string, hostname: string): string {
	return `${localPart.trim().toLowerCase()}@${hostname.trim().toLowerCase()}`;
}

export function listMailboxAddresses(input: {
	localPart: string;
	primaryHostname: string;
	useAllDomains: boolean;
	otherHostnames: readonly string[];
	aliasAddresses: readonly string[];
}): string[] {
	const primaryAddress = mailboxAddress(input.localPart, input.primaryHostname);
	const aliases = input.aliasAddresses.map((address) => address.toLowerCase());
	if (!input.useAllDomains) {
		return [...new Set([primaryAddress, ...aliases])];
	}
	return [
		...new Set([
			primaryAddress,
			...input.otherHostnames.map((hostname) => mailboxAddress(input.localPart, hostname)),
			...aliases,
		]),
	];
}
