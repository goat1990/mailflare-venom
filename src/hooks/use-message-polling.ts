import { useCallback, useEffect, useState } from "react";
import {
	AUTH_SESSION_CHANGED_EVENT,
	getClientSessionToken,
} from "@/lib/auth/client";
import type {
	MessageRealtimeState,
	NewMessageEvent,
} from "./message-realtime-types";
import {
	getRealtimeWebSocketUrl,
	getReconnectDelay,
	parseNewMessageEvent,
	REALTIME_FALLBACK_INTERVAL_MS,
	REALTIME_HEARTBEAT_INTERVAL_MS,
	realtimeFallbackOn,
	showBrowserNewMessageNotification,
} from "./message-realtime-utils";

export function useMessagePolling(): MessageRealtimeState {
	const [notification, setNotification] = useState<NewMessageEvent | null>(null);
	const dismissNotification = useCallback(() => setNotification(null), []);

	useEffect(() => {
		let socket: WebSocket | null = null;
		let reconnectTimer: number | null = null;
		let heartbeatTimer: number | null = null;
		let fallbackTimer: number | null = null;
		let reconnectAttempt = 0;
		let stopped = false;

		function dispatchMessagesChanged() {
			window.dispatchEvent(new Event("mailflare:messages-changed"));
		}

		function clearReconnectTimers() {
			if (reconnectTimer) window.clearTimeout(reconnectTimer);
			if (heartbeatTimer) window.clearInterval(heartbeatTimer);
			reconnectTimer = null;
			heartbeatTimer = null;
		}

		function stopFallback() {
			if (!fallbackTimer) return;
			window.clearInterval(fallbackTimer);
			fallbackTimer = null;
		}

		function syncFallback(event: "start" | "reconnect" | "open" | "close") {
			if (!realtimeFallbackOn(event)) {
				stopFallback();
				return;
			}
			if (fallbackTimer || stopped) return;
			fallbackTimer = window.setInterval(dispatchMessagesChanged, REALTIME_FALLBACK_INTERVAL_MS);
		}

		function scheduleReconnect() {
			if (stopped) return;
			syncFallback("close");
			if (!getClientSessionToken()) return;
			const delay = getReconnectDelay(reconnectAttempt);
			reconnectAttempt += 1;
			reconnectTimer = window.setTimeout(connect, delay);
		}

		function connect() {
			clearReconnectTimers();
			if (stopped) return;
			syncFallback("reconnect");
			if (!getClientSessionToken()) return;

			socket = new WebSocket(getRealtimeWebSocketUrl());
			socket.onopen = () => {
				reconnectAttempt = 0;
				syncFallback("open");
				heartbeatTimer = window.setInterval(() => {
					if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
				}, REALTIME_HEARTBEAT_INTERVAL_MS);
			};
			socket.onmessage = (message) => {
				if (message.data === "pong" || typeof message.data !== "string") return;
				try {
					const payload = JSON.parse(message.data) as { type?: string; draftId?: string; mailboxId?: string };
					if (payload.type === "agent_draft" && payload.draftId && payload.mailboxId) {
						window.dispatchEvent(new CustomEvent("mailflare:agent-draft", { detail: payload }));
						dispatchMessagesChanged();
						return;
					}
				} catch { /* Ignore malformed notification. */ }
				const event = parseNewMessageEvent(message.data);
				if (!event) return;
				dispatchMessagesChanged();
				setNotification(event);
				showBrowserNewMessageNotification(event);
			};
			socket.onerror = () => socket?.close();
			socket.onclose = scheduleReconnect;
		}

		function restartForSessionChange() {
			if (socket) {
				socket.onclose = null;
				socket.close(1000, "Session changed");
				socket = null;
			}
			clearReconnectTimers();
			stopFallback();
			reconnectAttempt = 0;
			setNotification(null);
			connect();
		}

		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, restartForSessionChange);
		syncFallback("start");
		connect();

		return () => {
			stopped = true;
			window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, restartForSessionChange);
			clearReconnectTimers();
			stopFallback();
			if (socket) {
				socket.onclose = null;
				socket.close(1000, "Client closed");
			}
		};
	}, []);

	useEffect(() => {
		if (!notification) return;
		const timer = window.setTimeout(() => setNotification(null), 8_000);
		return () => window.clearTimeout(timer);
	}, [notification]);

	return { notification, dismissNotification };
}
