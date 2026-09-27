"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

type ComposeContextValue = {
	open: boolean;
	draftId: string | null;
	openComposer: () => void;
	openDraftComposer: (draftId: string) => void;
	closeComposer: () => void;
};

const ComposeContext = createContext<ComposeContextValue | null>(null);

export function useCompose() {
	const ctx = useContext(ComposeContext);
	if (!ctx) throw new Error("useCompose must be used within ComposeProvider");
	return ctx;
}

export function ComposeProvider({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const [draftId, setDraftId] = useState<string | null>(null);
	const openComposer = useCallback(() => {
		setDraftId(null);
		setOpen(true);
	}, []);
	const openDraftComposer = useCallback((nextDraftId: string) => {
		setDraftId(nextDraftId);
		setOpen(true);
	}, []);
	const closeComposer = useCallback(() => {
		setOpen(false);
		setDraftId(null);
	}, []);
	const value = useMemo(
		() => ({ open, draftId, openComposer, openDraftComposer, closeComposer }),
		[closeComposer, draftId, open, openComposer, openDraftComposer],
	);

	return (
		<ComposeContext.Provider value={value}>
			{children}
		</ComposeContext.Provider>
	);
}
