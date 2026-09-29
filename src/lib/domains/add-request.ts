export function isMxConflict(code: string | undefined): boolean {
	return code === "MX_RECORDS_CONFLICT";
}

export function domainAddBody(hostname: string, enableSending: boolean, replaceMxRecords: boolean) {
	return {
		hostname,
		enableRouting: true as const,
		enableSending,
		replaceMxRecords,
	};
}
