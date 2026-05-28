"use client";
import type { ReactNode } from "react";
import { Palette, Shield, User } from "lucide-react";
import { SettingsTabs } from "./SettingsTabs";

export function SettingsClient({
  appearance,
  security,
  account,
}: {
  appearance: ReactNode;
  security: ReactNode;
  account: ReactNode;
}) {
  return (
    <SettingsTabs
      tabs={[
        { key: "appearance", label: "Appearance", icon: Palette },
        { key: "security", label: "Security", icon: Shield },
        { key: "account", label: "Account", icon: User },
      ]}
      panels={{ appearance, security, account }}
    />
  );
}
