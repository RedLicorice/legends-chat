import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminBotsE2eeSection } from "@/components/views/admin/AdminBotsE2eeSection";

const onChange = vi.fn();

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.restoreAllMocks();
  onChange.mockReset();
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ id: "bot-1", e2ee_state: "pending", e2ee_device_id: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
});

function botProps(overrides: Partial<{
  e2ee_state: "disabled" | "pending" | "ready";
  e2ee_device_id: string | null;
  identityKeyFingerprint: string;
  lastKeysUploadAt: string;
}> = {}) {
  return {
    bot: {
      id: "bot-1",
      e2ee_state: "disabled" as const,
      e2ee_device_id: null,
      ...overrides,
    },
    onChange,
  };
}

describe("<AdminBotsE2eeSection />", () => {
  it("renders Disabled badge for state=disabled", () => {
    render(<AdminBotsE2eeSection {...botProps({ e2ee_state: "disabled" })} />);
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  it("renders Pending bot upload badge for state=pending", () => {
    render(<AdminBotsE2eeSection {...botProps({ e2ee_state: "pending" })} />);
    expect(screen.getByText("Pending bot upload")).toBeInTheDocument();
  });

  it("renders Ready badge for state=ready", () => {
    render(<AdminBotsE2eeSection {...botProps({
      e2ee_state: "ready",
      e2ee_device_id: "DEVICE-XYZ-1234567890",
      identityKeyFingerprint: "abcd1234efgh5678ijkl9012mnop3456",
      lastKeysUploadAt: "2026-06-10T12:00:00.000Z",
    })} />);
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("shows truncated device_id + fingerprint + upload time when ready", () => {
    render(<AdminBotsE2eeSection {...botProps({
      e2ee_state: "ready",
      e2ee_device_id: "DEVICE-XYZ-1234567890",
      identityKeyFingerprint: "abcd1234efgh5678ijkl9012mnop3456",
      lastKeysUploadAt: "2026-06-10T12:00:00.000Z",
    })} />);
    expect(screen.getByTestId("e2ee-device-id").textContent).toContain("DEVICE-X");
    expect(screen.getByTestId("e2ee-fingerprint").textContent).toContain("abcd1234 efgh5678 ijkl9012 mnop3456");
    expect(screen.getByTestId("e2ee-last-upload")).toBeInTheDocument();
  });

  it("toggle off fires PATCH {enabled:false}", async () => {
    render(<AdminBotsE2eeSection {...botProps({ e2ee_state: "ready", e2ee_device_id: "D1" })} />);
    const cb = screen.getByRole("switch", { name: /end-to-end encryption/i });
    expect(cb).toBeChecked();
    await userEvent.click(cb);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ enabled: false });
    expect(onChange).toHaveBeenCalled();
  });

  it("toggle on (from disabled) fires PATCH {enabled:true}", async () => {
    render(<AdminBotsE2eeSection {...botProps({ e2ee_state: "disabled" })} />);
    const cb = screen.getByRole("switch", { name: /end-to-end encryption/i });
    expect(cb).not.toBeChecked();
    await userEvent.click(cb);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toEqual({ enabled: true });
  });

  it("rotate button absent when e2ee_device_id is null", () => {
    render(<AdminBotsE2eeSection {...botProps({ e2ee_state: "pending", e2ee_device_id: null })} />);
    expect(screen.queryByRole("button", { name: /rotate identity/i })).toBeNull();
  });

  it("rotate confirm fires PATCH {rotate:true}", async () => {
    render(<AdminBotsE2eeSection {...botProps({ e2ee_state: "ready", e2ee_device_id: "D1" })} />);
    await userEvent.click(screen.getByRole("button", { name: /rotate identity/i }));
    expect(screen.getByText(/wipe its local Olm pickle/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /confirm rotate/i }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toEqual({ rotate: true });
    expect(onChange).toHaveBeenCalled();
  });
});
