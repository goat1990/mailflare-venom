export type ParsedRecipientAddress = {
	original: string;
	/** The local part as addressed, lower-cased, with any `+tag` and dots kept. */
	addressedLocalPart: string;
	/** The local part with its `+tag` and dots removed. */
	localPart: string;
	domain: string;
	normalizedAddress: string;
};
