// Catch-all layout is now a passthrough. The persistent SPA shell lives
// in the root layout (`app/layout.tsx` → `RootShell` → `AppShell`) so it
// stays mounted across every URL change. Anything under here is owned by
// the route group above.
export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
