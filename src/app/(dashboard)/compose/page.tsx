"use client";

import { useEffect } from "react";
import { useCompose } from "@/components/compose/compose-context";

export default function ComposePage() {
	const { open, openComposer } = useCompose();

	useEffect(() => {
		openComposer();
	}, [openComposer]);

	return (
		<div className="h-full overflow-auto p-8">
			<div className="mb-6">
				<h1 className="text-2xl font-normal text-neutral-900">Compose</h1>
				<p className="mt-1 text-sm text-neutral-500">Write a new email. Drafts save automatically.</p>
			</div>
			{!open && (
				<button
					type="button"
					onClick={openComposer}
					className="rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
				>
					Open composer
				</button>
			)}
		</div>
	);
}
