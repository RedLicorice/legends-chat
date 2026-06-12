/**
 * DmRightPane — chatCrypto initialization for bot peers in E2EE DMs.
 *
 * Bug 20: peerId was derived as `peer?.type === "user" ? peer.id : null`,
 * so bot peers always yielded null → chatCrypto null → "encryption not
 * initialized". The server-side state-machine already permits E2EE
 * conversations against ready bots, so the UI must build an Olm
 * chat-crypto for them.
 *
 * We mock ChatPane to capture the `chatCrypto` prop without rendering the
 * full message stream, and mock `@/lib/chat-crypto` so the test doesn't
 * have to spin up the wasm crypto stack.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { DmPayload } from "@/lib/hooks/use-dm";

// --- Mocks --------------------------------------------------------------

const useDmMock = vi.fn();
vi.mock("@/lib/hooks/use-dm", () => ({
  useDm: (...args: unknown[]) => useDmMock(...args),
}));

vi.mock("@/components/AppShell", () => ({
  useAppShell: () => ({
    openSidebar: vi.fn(),
    expandDesktopSidebar: vi.fn(),
    desktopCollapsed: false,
    compactMode: "full" as const,
  }),
}));

vi.mock("@/lib/chat-source/dm", () => ({
  createDmChatSource: vi.fn(() => ({
    /* stub source — DmRightPane checks for null; the ChatPane mock ignores it. */
    __stub: true,
  })),
}));

// Track the args we pass to createOlmChatCrypto so we can assert on the
// matrix id that DmRightPane derives for the bot peer.
const olmFactoryCalls: Array<unknown[]> = [];
vi.mock("@/lib/chat-crypto", () => ({
  createOlmChatCrypto: (...args: unknown[]) => {
    olmFactoryCalls.push(args);
    return { kind: "olm", __crypto_stub: true };
  },
}));

// Capture the chatCrypto prop passed into ChatPane so we can verify
// DmRightPane actually wires it through (the bug is that it doesn't).
const chatPaneProps: Array<{ chatCrypto: unknown }> = [];
vi.mock("@/components/ChatPane", () => ({
  ChatPane: (props: { chatCrypto: unknown }) => {
    chatPaneProps.push({ chatCrypto: props.chatCrypto });
    return null;
  },
}));

vi.mock("@/components/PWASplash", () => ({
  PWASplash: () => null,
}));

// Import the SUT after the mocks are in place so its module-load resolves
// against the mocked deps.
const { DmRightPane } = await import("@/components/views/DmRightPane");

// --- Helpers ------------------------------------------------------------

function dmPayload(overrides: Partial<DmPayload["conversation"]> = {}): DmPayload {
  return {
    user: {
      id: "user-self",
      displayName: "Self",
      avatarUrl: null,
      role: "user",
      permissions: [],
      presenceOptOut: false,
    },
    chatItems: [],
    conversation: {
      id: "conv-1",
      isE2ee: true,
      e2eeRoomId: "room-key-1",
      state: "accepted",
      peer: {
        type: "bot",
        id: "bot-1",
        displayName: "ReadyBot",
        avatarUrl: null,
      },
      ...overrides,
    },
  };
}

afterEach(() => {
  cleanup();
  useDmMock.mockReset();
  olmFactoryCalls.length = 0;
  chatPaneProps.length = 0;
});

describe("<DmRightPane /> with bot peer in E2EE DM", () => {
  it("initializes a non-null chatCrypto for a bot peer", () => {
    useDmMock.mockReturnValue({ data: dmPayload(), status: "ready" });
    render(<DmRightPane id="conv-1" />);
    expect(chatPaneProps.length).toBeGreaterThan(0);
    const lastProps = chatPaneProps[chatPaneProps.length - 1]!;
    expect(lastProps.chatCrypto).not.toBeNull();
    expect(olmFactoryCalls.length).toBe(1);
  });

  it("passes a bot-namespaced matrix id to the Olm chat-crypto factory", () => {
    useDmMock.mockReturnValue({ data: dmPayload(), status: "ready" });
    render(<DmRightPane id="conv-1" />);
    const [, peerArg] = olmFactoryCalls[0]!;
    // The peer arg should identify a bot principal — either a Matrix bot id
    // string or a principal object. Bug 20's fix passes the namespaced
    // Matrix id so the lower layer doesn't conflate bot/user UUIDs.
    if (typeof peerArg === "string") {
      expect(peerArg).toMatch(/^@bot\.bot-1:/);
    } else {
      expect(peerArg).toEqual({ type: "bot", id: "bot-1" });
    }
  });
});
