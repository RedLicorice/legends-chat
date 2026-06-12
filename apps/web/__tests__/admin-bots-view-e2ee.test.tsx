import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminBotsForm } from "@/components/AdminBotsForm";

vi.mock("@/lib/fetch", () => ({
  // Return a generic empty-ok response so existing AdminBotsForm side-paths
  // (overrides fetch, etc.) don't throw — the E2EE section uses raw fetch.
  apiFetch: vi.fn(async () =>
    new Response(JSON.stringify({ overrides: [], bots: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ),
}));

afterEach(() => {
  cleanup();
});

interface BotInput {
  id: string;
  name: string;
  e2ee_state: "disabled" | "pending" | "ready";
  e2ee_device_id: string | null;
  identityKeyFingerprint?: string;
  lastKeysUploadAt?: string;
}

function makeBot(overrides: BotInput) {
  return {
    avatarUrl: null,
    description: null,
    webhookUrl: null,
    isActive: true,
    createdAt: new Date().toISOString(),
    role: "bot",
    roleExpiresAt: null,
    roleFallback: null,
    ...overrides,
  };
}

describe("<AdminBotsForm /> with E2EE sections", () => {
  it("renders an E2EE section per bot row with the correct badge after expand", async () => {
    const bots = [
      makeBot({
        id: "bot-a",
        name: "Alpha",
        e2ee_state: "disabled",
        e2ee_device_id: null,
      }),
      makeBot({
        id: "bot-b",
        name: "Beta",
        e2ee_state: "ready",
        e2ee_device_id: "DEVICE-B-12345",
        identityKeyFingerprint: "abcd1234efgh5678ijkl9012mnop3456",
        lastKeysUploadAt: new Date().toISOString(),
      }),
    ];
    render(<AdminBotsForm bots={bots} topics={[]} assignments={[]} />);

    // Bot rows render in a collapsed state. Click each row's expand chevron.
    // Each row has a single icon-only button; tweak via the bot's name container.
    const allButtons = screen.getAllByRole("button");
    // The chevron buttons have no accessible name; filter by empty textContent.
    const chevrons = allButtons.filter((b) => (b.textContent ?? "").trim() === "");
    expect(chevrons.length).toBeGreaterThanOrEqual(2);

    // Expand the first row, assert "Disabled" badge appears.
    await userEvent.click(chevrons[0]!);
    expect(screen.getByText("Disabled")).toBeInTheDocument();

    // Expand the second row, assert "Ready" badge appears.
    // Re-query chevrons since the DOM has expanded.
    const chevrons2 = screen
      .getAllByRole("button")
      .filter((b) => (b.textContent ?? "").trim() === "");
    // The second bot's chevron is now the last empty-text button.
    await userEvent.click(chevrons2[chevrons2.length - 1]!);
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });
});
