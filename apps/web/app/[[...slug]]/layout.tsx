import { AppShell } from "@/components/AppShell";

// Persistent SPA shell. Lives at the catch-all layout boundary so Next 15
// reuses the same React tree across every authed URL — slug change, query
// string toggle, push and pop — without unmounting AppShell or its views.
// The catch-all page is an empty marker; the actual UI is dispatched by
// AppShell via usePathname().
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AppShell />
      {children}
    </>
  );
}
