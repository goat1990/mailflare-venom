"use client";

import type {
	AuthFetchOptions,
	AuthSessionChangedDetail,
	AuthSessionResponse,
} from "./client-types";

const SESSION_STORAGE_KEY = "mailflare-session-token";
/** Presence flag only. The session secret stays in the httpOnly cookie. */
const CLIENT_SESSION_MARKER = "1";
export const AUTH_SESSION_CHANGED_EVENT = "mailflare:auth-session-changed";

function dispatchAuthSessionChanged(authenticated: boolean): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent<AuthSessionChangedDetail>(AUTH_SESSION_CHANGED_EVENT, {
			detail: { authenticated },
		}),
	);
}

export function getClientSessionToken(): string | null {
	if (typeof window === "undefined") return null;
	const value = localStorage.getItem(SESSION_STORAGE_KEY);
	if (!value) return null;
	if (value === CLIENT_SESSION_MARKER) return value;
	localStorage.setItem(SESSION_STORAGE_KEY, CLIENT_SESSION_MARKER);
	return CLIENT_SESSION_MARKER;
}

export function setClientSessionToken(_token: string): void {
	markClientSessionPresent();
}

export function clearClientSessionToken(): void {
	localStorage.removeItem(SESSION_STORAGE_KEY);
	dispatchAuthSessionChanged(false);
}

export function getAuthHeaders(headers?: HeadersInit): Headers {
	return new Headers(headers);
}

function markClientSessionPresent(): void {
	const previous = localStorage.getItem(SESSION_STORAGE_KEY);
	localStorage.setItem(SESSION_STORAGE_KEY, CLIENT_SESSION_MARKER);
	if (previous !== CLIENT_SESSION_MARKER) dispatchAuthSessionChanged(true);
}

export async function authFetch(input: RequestInfo | URL, init: AuthFetchOptions = {}): Promise<Response> {
	const { redirectOnUnauthorized = true, headers, ...requestInit } = init;
	const response = await fetch(input, {
		...requestInit,
		headers: getAuthHeaders(headers),
	});

	if (response.status === 401 && redirectOnUnauthorized && typeof window !== "undefined") {
		clearClientSessionToken();
		window.location.assign("/login");
	}

	return response;
}

export async function persistAuthSession(response: Response): Promise<AuthSessionResponse> {
	const data = (await response.json()) as AuthSessionResponse;
	if (response.ok && typeof window !== "undefined") markClientSessionPresent();
	return data;
}
