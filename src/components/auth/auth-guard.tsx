"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import type { AuthGuardProps } from "./auth-guard-types";
import { LoadingTransition } from "@/components/loading-transition";

export function AuthGuard({ children, mode = "protected", requireMailbox, requireRole }: AuthGuardProps) {
	const pathname = usePathname();
	const router = useRouter();
	const [authorized, setAuthorized] = useState(mode === "public");
	const [sessionFailed, setSessionFailed] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setSessionFailed(false);

		async function checkSession() {
			try {
				const cookieResponse = await fetch("/api/auth/me", {
					cache: "no-store",
					signal: AbortSignal.timeout(5_000),
				});
				const response = cookieResponse.ok || cookieResponse.status !== 401
					? cookieResponse
					: await authFetch("/api/auth/me", {
						redirectOnUnauthorized: false,
						signal: AbortSignal.timeout(5_000),
					});
				if (cancelled) return;

				if (!response.ok) {
					if (mode === "protected" && response.status === 401) router.replace("/login");
					else if (mode === "protected") setSessionFailed(true);
					return;
				}

				const data = (await response.json()) as { hasMailboxes?: boolean; isSetup?: boolean; user?: { role?: string } };
				if (mode === "public") {
					router.replace("/inbox");
					return;
				}

				if (requireMailbox && data.hasMailboxes === false && data.user?.role === "admin" && data.isSetup === false && pathname !== "/setup") {
					router.replace("/setup");
					return;
				}

				if (pathname === "/setup" && data.isSetup === true) {
					router.replace("/inbox");
					return;
				}

				if (requireRole && data.user?.role !== requireRole) {
					router.replace("/inbox");
					return;
				}

				setAuthorized(true);
			} catch {
				if (!cancelled && mode === "protected") setSessionFailed(true);
			}
		}

		void checkSession();

		return () => {
			cancelled = true;
		};
	}, [mode, pathname, requireMailbox, requireRole, router]);

	if (mode === "public") return <>{children}</>;
	if (sessionFailed) {
		return (
			<div className="flex min-h-dvh items-center justify-center bg-[#f6f8fc] p-6">
				<div className="max-w-md rounded-2xl bg-white px-6 py-8 text-center">
					<p className="text-sm text-neutral-700">Could not verify your session.</p>
					<button
						type="button"
						onClick={() => window.location.reload()}
						className="mt-4 rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
					>
						Try again
					</button>
				</div>
			</div>
		);
	}
	return <LoadingTransition ready={authorized}>{children}</LoadingTransition>;
}
