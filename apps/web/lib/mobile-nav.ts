// Pure routing helpers for the mobile drill-down. No React, no DOM — unit-tested.

/** Routes that are drill-down ROOTS (level 0): the full-screen list / nav. */
export const LIST_ROOTS: ReadonlySet<string> = new Set(["/", "/c", "/admin"]);

/**
 * Drill-down depth for a path. 0 = list root, 1 = detail, 2 = thread (a detail
 * with `?thread=`). A list root is never promoted by a thread param.
 */
export function routeLevel(path: string, hasThread: boolean): 0 | 1 | 2 {
  if (LIST_ROOTS.has(path)) return 0;
  return hasThread ? 2 : 1;
}

/** Where Back goes when there's no in-app history to pop (cold deep-link). */
export function backTarget(path: string): string {
  return path === "/admin" || path.startsWith("/admin/") ? "/admin" : "/";
}
