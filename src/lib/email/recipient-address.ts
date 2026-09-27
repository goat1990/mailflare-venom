import { parseAddress } from "@/lib/utils";
import type { ParsedRecipientAddress } from "./recipient-address-types";

function stripSubaddress(localPart: string): string {
	return localPart.split("+", 1)[0];
}

export function normalizeRecipientLocalPart(localPart: string): string {
	return stripSubaddress(localPart)
		.replaceAll(".", "")
		.toLowerCase();
}

/**
 * How closely a stored local part names the one a message was addressed to, lower is closer:
 * 0 exact, 1 once the recipient's `+tag` is dropped, 2 ignoring dots as well. `null` when it
 * does not name it at all. Only an address with no closer owner falls through to the looser
 * forms, so `john.doe` and `johndoe` can coexist and each keep their own mail.
 */
export function rankLocalPartMatch(stored: string, addressed: string): number | null {
	const storedLocalPart = stored.toLowerCase();
	const addressedLocalPart = addressed.toLowerCase();
	if (storedLocalPart === addressedLocalPart) return 0;
	if (storedLocalPart === stripSubaddress(addressedLocalPart)) return 1;
	if (normalizeRecipientLocalPart(storedLocalPart) === normalizeRecipientLocalPart(addressedLocalPart)) return 2;
	return null;
}

export function parseRecipientAddress(address: string): ParsedRecipientAddress | null {
	const parsed = parseAddress(address);
	if (!parsed) return null;

	const localPart = normalizeRecipientLocalPart(parsed.local);
	if (!localPart) return null;

	return {
		original: address,
		addressedLocalPart: parsed.local,
		localPart,
		domain: parsed.domain,
		normalizedAddress: `${localPart}@${parsed.domain}`,
	};
}
