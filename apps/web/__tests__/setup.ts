// Only adds jest-dom matchers when running in jsdom (tsx component tests).
// In the node environment used by route tests, the DOM helpers are absent and
// the import is a no-op besides extending Vitest's `expect` interface.
import "@testing-library/jest-dom/vitest";
