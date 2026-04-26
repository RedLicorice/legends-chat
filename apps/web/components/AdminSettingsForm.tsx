"use client";

import { useEffect, useState } from "react";

interface Topic { id: string; title: string; slug: string }

interface Props {
  settings: Record<string, string>;
  topics: Topic[];
}

export function AdminSettingsForm({ settings, topics }: Props) {
  const [communityName, setCommunityName] = useState(settings.community_name ?? "");
  const [communityLogo, setCommunityLogo] = useState(settings.community_logo_url ?? "");
  const [communityBanner, setCommunityBanner] = useState(settings.community_banner_url ?? "");
  const [pwaIcon, setPwaIcon] = useState(settings.pwa_icon_url ?? "");
  const [registrationMode, setRegistrationMode] = useState<string>(settings.registration_mode ?? "telegram_only");
  const [defaultTopicId, setDefaultTopicId] = useState(settings.default_topic_id ?? "");
  const [welcomeMessage, setWelcomeMessage] = useState(settings.welcome_message ?? "Welcome, {nickname}!");
  const [farewellMessage, setFarewellMessage] = useState(settings.farewell_message ?? "Goodbye, {nickname}.");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          community_name: communityName.trim() || null,
          community_logo_url: communityLogo.trim() || null,
          community_banner_url: communityBanner.trim() || null,
          pwa_icon_url: pwaIcon.trim() || null,
          registration_mode: registrationMode,
          default_topic_id: defaultTopicId || null,
          welcome_message: welcomeMessage.trim() || null,
          farewell_message: farewellMessage.trim() || null,
        }),
      });
      if (!res.ok) throw new Error("save failed");
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Community identity */}
      <Section title="Community">
        <Field label="Community name">
          <input
            value={communityName}
            onChange={(e) => setCommunityName(e.target.value)}
            maxLength={80}
            placeholder="My Community"
            className={inputCls}
          />
        </Field>
        <Field label="Logo URL">
          <input
            value={communityLogo}
            onChange={(e) => setCommunityLogo(e.target.value)}
            placeholder="https://example.com/logo.png"
            className={inputCls}
          />
          <p className="mt-1 text-xs text-muted">Shown in the header and browser tab.</p>
        </Field>
        <Field label="Banner URL">
          <input
            value={communityBanner}
            onChange={(e) => setCommunityBanner(e.target.value)}
            placeholder="https://example.com/banner.png"
            className={inputCls}
          />
          <p className="mt-1 text-xs text-muted">Decorative banner shown on the login/register pages.</p>
        </Field>
        <Field label="PWA icon URL">
          <input
            value={pwaIcon}
            onChange={(e) => setPwaIcon(e.target.value)}
            placeholder="https://example.com/icon.png"
            className={inputCls}
          />
          <p className="mt-1 text-xs text-muted">
            Square PNG, at least 512×512. Used as the home screen icon when users install the app.
            Leave blank to use the default purple icon.
          </p>
        </Field>
      </Section>

      {/* Registration */}
      <Section title="Registration">
        <Field label="Registration mode">
          <select
            value={registrationMode}
            onChange={(e) => setRegistrationMode(e.target.value)}
            className={inputCls}
          >
            <option value="closed">Closed — no new registrations</option>
            <option value="telegram_only">Telegram only — link existing Telegram account</option>
            <option value="open">Open — email/username/password</option>
          </select>
          <p className="mt-1 text-xs text-muted">
            In "Telegram only" and "Open" modes, an invitation code may still be required (controlled by the invite flow).
          </p>
        </Field>
      </Section>

      {/* Default channel + messages */}
      <Section title="Welcome flow">
        <Field label="Default channel">
          <select
            value={defaultTopicId}
            onChange={(e) => setDefaultTopicId(e.target.value)}
            className={inputCls}
          >
            <option value="">— none —</option>
            {topics.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
          <p className="mt-1 text-xs text-muted">New members receive system messages in this channel.</p>
        </Field>
        <Field label="Welcome message">
          <input
            value={welcomeMessage}
            onChange={(e) => setWelcomeMessage(e.target.value)}
            maxLength={500}
            placeholder="Welcome, {nickname}!"
            className={inputCls}
          />
          <p className="mt-1 text-xs text-muted">
            Use <code className="rounded bg-panel2 px-1">{"{nickname}"}</code> for their display name.
          </p>
        </Field>
        <Field label="Farewell message">
          <input
            value={farewellMessage}
            onChange={(e) => setFarewellMessage(e.target.value)}
            maxLength={500}
            placeholder="Goodbye, {nickname}."
            className={inputCls}
          />
          <p className="mt-1 text-xs text-muted">
            Use <code className="rounded bg-panel2 px-1">{"{nickname}"}</code> for their display name.
          </p>
        </Field>
      </Section>

      <InviteConfigSection />

      {error && <p className="text-sm text-danger">{error}</p>}
      {saved && <p className="text-sm text-green-400">Settings saved.</p>}

      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save settings"}
      </button>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent";

const ROLES = ["user", "moderator", "admin"] as const;

function InviteConfigSection() {
  const [invitesEnabled, setInvitesEnabled] = useState(true);
  const [quotas, setQuotas] = useState<Record<string, number>>({ user: 1, moderator: 10, admin: 100 });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/invite-config")
      .then((r) => r.json())
      .then((d: { invitesEnabled: boolean; quotas: Record<string, number> }) => {
        setInvitesEnabled(d.invitesEnabled);
        setQuotas((prev) => ({ ...prev, ...d.quotas }));
      })
      .catch(() => {});
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/admin/invite-config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invitesEnabled, quotas }),
      });
      if (!res.ok) throw new Error("save failed");
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Invite flow">
      <Field label="Require invite code">
        <label className="flex cursor-pointer items-center gap-3">
          <div
            role="switch"
            aria-checked={invitesEnabled}
            onClick={() => setInvitesEnabled((v) => !v)}
            className={`relative h-6 w-11 cursor-pointer rounded-full transition-colors ${invitesEnabled ? "bg-accent" : "bg-border"}`}
          >
            <span
              className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-transform ${invitesEnabled ? "translate-x-6" : "translate-x-1"}`}
            />
          </div>
          <span className="text-sm">{invitesEnabled ? "Invite code required" : "Anyone can register without invite"}</span>
        </label>
        <p className="mt-1 text-xs text-muted">When enabled, new users must present a valid invite code during registration.</p>
      </Field>

      <Field label="Daily invite quota per role">
        <div className="space-y-2">
          {ROLES.map((role) => (
            <div key={role} className="flex items-center gap-3">
              <span className="w-24 text-xs font-medium capitalize text-muted">{role}</span>
              <input
                type="number"
                min={0}
                max={9999}
                value={quotas[role] ?? 0}
                onChange={(e) => setQuotas((q) => ({ ...q, [role]: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
                className="w-24 rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm outline-none focus:border-accent"
              />
              <span className="text-xs text-muted">invites / day</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">How many invite codes each role can generate per UTC calendar day. 0 = cannot create invites.</p>
      </Field>

      {error && <p className="text-sm text-danger">{error}</p>}
      {saved && <p className="text-sm text-green-400">Saved.</p>}

      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save invite settings"}
      </button>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-panel p-5 space-y-4">
      <h2 className="font-semibold">{title}</h2>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted">{label}</label>
      {children}
    </div>
  );
}
