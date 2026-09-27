"use client";

import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSidebar } from "@/components/sidebar-state";
import { useAssistantOpen } from "@/components/agent/assistant-open-state";
import { readColumnWidth, readInitialColumnWidth, saveColumnWidth } from "@/components/column-width-preferences";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { BulkMessageSelectionPane } from "./bulk-message-selection-pane";
import { MessageFolderPage } from "./message-folder-page";
import { MessageListVisibilityContext } from "./message-list-visibility";
import { readInitialMessageListVisible, saveMessageListVisible } from "./message-list-visibility-utils";
import type { MessageSplitLayoutProps, SelectedMessage } from "./types";

export function MessageSplitLayout({
	children,
	config,
}: MessageSplitLayoutProps) {
	const pathname = usePathname();
	const [selectedMessages, setSelectedMessages] = useState<SelectedMessage[]>([]);
	const [listWidth, setListWidth] = useState(360);
	const [widthReady, setWidthReady] = useState(false);
	const [containerWidth, setContainerWidth] = useState(0);
	const [manualListVisible, setManualListVisible] = useState(true);
	const containerRef = useRef<HTMLDivElement>(null);
	const startWidth = useRef(listWidth);
	const resizedWidth = useRef(listWidth);
	const { userId, setForcedMinimal } = useSidebar();
	const assistantOpen = useAssistantOpen();
	const listVisible = !assistantOpen && manualListVisible;
	const detailPrefix = `${config.hrefPrefix}/`;
	const selectedMessageId = pathname.startsWith(detailPrefix)
		? pathname.slice(detailPrefix.length).split("/")[0]
		: undefined;
	const renderedListWidth = Math.max(250, Math.min(listWidth, (containerWidth || 1000) - 280));

	useLayoutEffect(() => {
		setListWidth(readInitialColumnWidth("message-list", 360, 250, 1200));
		setManualListVisible(readInitialMessageListVisible());
		const frame = requestAnimationFrame(() => setWidthReady(true));
		return () => cancelAnimationFrame(frame);
	}, []);

	useEffect(() => {
		if (!userId) return;
		const savedWidth = readColumnWidth(userId, "message-list", readInitialColumnWidth("message-list", 360, 250, 1200), 250, 1200);
		setListWidth(savedWidth);
		saveColumnWidth(userId, "message-list", savedWidth);
	}, [userId]);

	useLayoutEffect(() => {
		if (!selectedMessageId) {
			setForcedMinimal(false);
			return;
		}
		const container = containerRef.current;
		if (!container) return;
		setContainerWidth(container.clientWidth);
		const observer = new ResizeObserver(() => setContainerWidth(container.clientWidth));
		observer.observe(container);
		return () => observer.disconnect();
	}, [selectedMessageId, setForcedMinimal]);

	useEffect(() => () => setForcedMinimal(false), [setForcedMinimal]);

	const showDetail = Boolean(selectedMessageId);

	return (
		<div
			ref={containerRef}
			className={`h-full min-h-0 overflow-hidden ${showDetail ? "lg:grid lg:transition-[grid-template-columns] lg:ease-in-out motion-reduce:transition-none" : ""}`}
			style={showDetail ? { gridTemplateColumns: `${listVisible ? renderedListWidth : 0}px minmax(0,1fr)`, transitionDuration: widthReady ? "300ms" : "0ms" } : undefined}
		>
			<aside
				className={showDetail
					? `relative hidden min-h-0 min-w-0 overflow-hidden bg-white lg:block ${listVisible ? "border-r border-neutral-200" : "pointer-events-none"}`
					: "h-full min-h-0 min-w-0 overflow-hidden bg-white"}
				aria-hidden={showDetail ? !listVisible : undefined}
				inert={showDetail ? !listVisible : undefined}
			>
				<div
					className={showDetail
						? `h-full overflow-hidden transition-transform duration-300 ease-in-out motion-reduce:transition-none ${listVisible ? "translate-x-0" : "-translate-x-full"}`
						: "h-full overflow-hidden"}
					style={showDetail ? { width: renderedListWidth } : undefined}
				>
					<MessageFolderPage
						config={config}
						compact={showDetail}
						selectedMessageId={selectedMessageId}
						selection={{ selectedMessages, setSelectedMessages }}
					/>
				</div>
				{showDetail && (
					<ResizeHandle
						label="Resize message list"
						onResizeStart={() => { startWidth.current = listWidth; resizedWidth.current = listWidth; }}
						onResize={(delta) => {
							const requestedWidth = startWidth.current + delta;
							setForcedMinimal(requestedWidth < 250);
							resizedWidth.current = Math.max(250, Math.min(requestedWidth, Math.max(250, (containerRef.current?.clientWidth ?? 1000) - 280)));
							setListWidth(resizedWidth.current);
						}}
						onResizeEnd={() => saveColumnWidth(userId, "message-list", resizedWidth.current)}
					/>
				)}
			</aside>
			{showDetail && (
				<MessageListVisibilityContext.Provider value={{ visible: listVisible, toggle: () => { const visible = !manualListVisible; setManualListVisible(visible); saveMessageListVisible(visible); } }}>
					<section className="min-h-0 min-w-0 overflow-hidden bg-white">
						{selectedMessages.length > 0 ? (
							<BulkMessageSelectionPane
								selectedMessages={selectedMessages}
								onClearSelection={() => setSelectedMessages([])}
							/>
						) : (
							children
						)}
					</section>
				</MessageListVisibilityContext.Provider>
			)}
		</div>
	);
}
