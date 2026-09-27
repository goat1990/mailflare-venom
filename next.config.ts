import type { NextConfig } from "next";
import { getSecurityHeaders } from "./src/lib/security/headers";
import { createDevWranglerConfig } from "./scripts/dev-wrangler-config";

const nextConfig: NextConfig = {
	turbopack: {
		root: import.meta.dirname,
	},
  allowedDevOrigins: ['mail.dev'],
	typescript: {
    // !! WARN !!
    // Dangerously allow production builds to successfully complete
    // even if your project has type errors.
    ignoreBuildErrors: true,
	  },
	// Native and server-only packages used by the self-hosted runtime; never bundle them.
	serverExternalPackages: ["better-sqlite3", "nodemailer", "smtp-server", "ws"],
	async headers() {
		return [
			{
				source: "/(.*)",
				headers: getSecurityHeaders(),
			},
		];
	},
};

export default nextConfig;

// Enable calling `getCloudflareContext()` in `next dev`. The self-hosted
// runtime provides its own env, so it skips this.
// See https://opennext.js.org/cloudflare/bindings#local-access-to-bindings.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
if (process.env.MAILFLARE_RUNTIME !== "node") {
	initOpenNextCloudflareForDev({ configPath: createDevWranglerConfig() });
	if (process.env.NODE_ENV === "development") {
		console.warn("next dev provides bindings only: worker.ts's email, queue and cron handlers and the realtime Durable Object do not run. Use `npm run preview` for the Worker, or `npm run dev:node` for the self-hosted process.");
	}
}
