"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { HelpCircle, Menu, Sparkles } from "lucide-react";
import { AuthGuard } from "@/components/auth/auth-guard";
import { ComposeProvider } from "@/components/compose/compose-context";
import { FloatingComposer } from "@/components/compose/floating-composer";
import { MailSearchInput } from "@/components/mail-search/mail-search-input";
import { MailSearchProvider } from "@/components/mail-search/mail-search-context";
import { MailboxProvider } from "@/components/mailbox-provider";
import { MailboxSelector } from "@/components/mailbox-selector";
import { AgentPanel } from "@/components/agent/agent-panel";
import { AssistantOpenContext } from "@/components/agent/assistant-open-state";
import { Button } from "@/components/ui/button";
import { LicenseIndicator } from "@/components/license-indicator";
import { DashboardNav } from "@/components/dashboard-nav";
import { SidebarProvider } from "@/components/sidebar-state";
import { SidebarResizeBoundary } from "@/components/sidebar-resize-boundary";
import { ShortcutsProvider } from "@/components/shortcuts";
import clsx from "clsx";
import { useDashboardState } from "./dashboard-state";
import { useAssistantAvailability } from "./use-assistant-availability";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { assistantOpen, setAssistantOpen, assistantFullSize, setAssistantFullSize } = useDashboardState();
  const assistantEnabled = useAssistantAvailability();
  const assistantVisible = assistantEnabled === true && assistantOpen;
  const [narrow, setNarrow] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 480px)");
    const sync = () => setNarrow(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (assistantEnabled === false && (assistantOpen || assistantFullSize)) {
      setAssistantOpen(false);
      setAssistantFullSize(false);
    }
  }, [assistantEnabled, assistantOpen, assistantFullSize, setAssistantOpen, setAssistantFullSize]);

  return (
    <AuthGuard>
      <SidebarProvider>
        <MailboxProvider>
          <ComposeProvider>
            <MailSearchProvider>
              <ShortcutsProvider>
                <div className="flex h-dvh overflow-hidden bg-[#f6f8fc]">
                  {narrow && navOpen && (
                    <button
                      type="button"
                      className="fixed inset-0 z-30 bg-neutral-900/30"
                      aria-label="Close folder navigation"
                      onClick={() => setNavOpen(false)}
                    />
                  )}
                  <aside
                    id="folder-navigation"
                    className={clsx(
                      "min-h-0 shrink-0 bg-[#f6f8fc]",
                      narrow
                        ? "fixed inset-y-0 left-0 z-40 w-72 max-w-[calc(100vw-3rem)] shadow-xl transition-transform duration-200"
                        : "relative",
                      narrow && !navOpen && "-translate-x-full",
                    )}
                    style={narrow ? undefined : { width: "var(--sidebar-width)", transitionDuration: "var(--sidebar-transition-duration)" }}
                    aria-hidden={narrow && !navOpen}
                    inert={narrow && !navOpen ? true : undefined}
                  >
                    <div className="h-full overflow-y-auto overscroll-contain px-3 py-4 scrollbar-gutter-stable">
                      <DashboardNav />
                    </div>
                    {!narrow && <SidebarResizeBoundary />}
                  </aside>
                  <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <header className="flex h-16 w-full shrink-0 items-center gap-3 pr-4 text-sm">
                      {narrow && (
                        <button
                          type="button"
                          className="ml-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-neutral-700 hover:bg-neutral-200"
                          aria-label="Open folders"
                          aria-expanded={navOpen}
                          aria-controls="folder-navigation"
                          onClick={() => setNavOpen(true)}
                        >
                          <Menu className="h-5 w-5" />
                        </button>
                      )}
                      <MailSearchInput />
                      <Link
                        href="/settings/account"
                        className="flex h-10 w-10 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-200"
                        title="Account Settings"
                      >
                        <HelpCircle className="h-5 w-5" />
                      </Link>
                      <LicenseIndicator />
                      {assistantEnabled && <Button type="button" variant="ghost" size="sm" className={assistantOpen ? "bg-blue-50 text-blue-700" : "text-neutral-600"} onClick={() => { setAssistantOpen((current) => !current); setAssistantFullSize(false); }} aria-label={assistantOpen ? "Close email assistant" : "Open email assistant"} aria-expanded={assistantOpen} aria-controls="email-assistant-panel"><Sparkles className="h-5 w-5" /></Button>}
                      <MailboxSelector />
                    </header>
                    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                      <AssistantOpenContext.Provider value={assistantVisible}>
                        <main className={clsx("rounded-t-3xl min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain bg-white scrollbar-gutter-stable")} aria-hidden={assistantVisible && assistantFullSize} inert={assistantVisible && assistantFullSize}>
                          {children}
                        </main>
                      </AssistantOpenContext.Provider>
                      <aside className={clsx(assistantFullSize ? "pl-0" : "pl-4", `min-h-0 min-w-0 shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out motion-reduce:transition-none pr-2 pb-2`, assistantVisible ? "" : "opacity-0")} style={{ width: assistantVisible ? assistantFullSize ? "100%" : "min(390px, 100%)" : "0px" }} aria-hidden={!assistantVisible} inert={!assistantVisible}>
                        {assistantEnabled && <AgentPanel open={assistantVisible} fullSize={assistantFullSize} onToggleFullSize={() => setAssistantFullSize((current) => !current)} onClose={() => { setAssistantOpen(false); setAssistantFullSize(false); }} />}
                      </aside>
                    </div>
                  </div>
                  <FloatingComposer />
                </div>
              </ShortcutsProvider>
            </MailSearchProvider>
          </ComposeProvider>
        </MailboxProvider>
      </SidebarProvider>
    </AuthGuard>
  );
}
