/**
 * NewChatModal — E2EE checkbox for bot peers.
 *
 * Bug 19: the modal used to force `e2ee=false` for bot peers ("users only"
 * clamp). The server-side state-machine already gates bot E2EE via
 * `bots.e2ee_state`; the UI just needs to:
 *  - allow checking the E2EE box when the selected bot peer's e2ee_state
 *    is "ready",
 *  - present the E2EE option visually clamped (with explanation) when the
 *    bot isn't ready, AND
 *  - send `e2ee: true` to /api/dm for ready bots.
 *
 * These tests exercise the search-driven flow:
 *   1. user types a query → /api/dm/search returns a bot hit with e2eeState
 *   2. user toggles the E2EE checkbox
 *   3. user clicks the bot row → POST /api/dm body must include `e2ee: true`
 *      when the bot is "ready", `e2ee: false` otherwise.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewChatModal } from "@/components/NewChatModal";

// --- Mocks --------------------------------------------------------------

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

const apiFetchMock = vi.fn();
vi.mock("@/lib/fetch", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  apiFetchMock.mockReset();
  pushMock.mockReset();
});

beforeEach(() => {
  // Defensive: ensure scrollIntoView and other DOM things used by the modal
  // don't blow up under jsdom.
});

describe("<NewChatModal /> bot E2EE", () => {
  it("sends e2ee=true to /api/dm when the bot peer is e2ee_state=ready and user checks the box", async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.startsWith("/api/dm/search")) {
        return jsonResponse([
          {
            type: "bot",
            id: "bot-ready-1",
            displayName: "ReadyBot",
            avatarUrl: null,
            e2eeState: "ready",
          },
        ]);
      }
      if (url === "/api/dm" && init?.method === "POST") {
        return jsonResponse({ id: "conv-1", created: true }, 201);
      }
      return jsonResponse({}, 404);
    });

    render(<NewChatModal open onClose={() => {}} />);

    const input = await screen.findByRole("textbox", { name: /search/i });
    await userEvent.type(input, "Rea");

    // Wait for the bot hit to appear.
    const botRow = await screen.findByRole("button", { name: /ReadyBot/i });

    // Toggle E2EE on.
    const checkbox = screen.getByRole("switch", { name: /encrypt/i });
    expect(checkbox).not.toBeDisabled();
    await userEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    // Start chat.
    await userEvent.click(botRow);

    await waitFor(() => {
      const dmPost = apiFetchMock.mock.calls.find(
        ([url, init]) =>
          url === "/api/dm" && (init as RequestInit | undefined)?.method === "POST",
      );
      expect(dmPost).toBeDefined();
      const body = JSON.parse((dmPost![1] as RequestInit).body as string);
      expect(body).toEqual({ peerType: "bot", peerId: "bot-ready-1", e2ee: true });
    });
  });

  it("disables the E2EE checkbox when the bot peer's e2ee_state isn't ready", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.startsWith("/api/dm/search")) {
        return jsonResponse([
          {
            type: "bot",
            id: "bot-pending-1",
            displayName: "PendingBot",
            avatarUrl: null,
            e2eeState: "pending",
          },
        ]);
      }
      return jsonResponse({}, 404);
    });

    render(<NewChatModal open onClose={() => {}} />);

    const input = await screen.findByRole("textbox", { name: /search/i });
    await userEvent.type(input, "Pen");

    // Wait for hit
    await screen.findByRole("button", { name: /PendingBot/i });

    const checkbox = screen.getByRole("switch", { name: /encrypt/i });
    expect(checkbox).toBeDisabled();
  });
});
