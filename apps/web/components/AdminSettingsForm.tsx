"use client";
import { apiFetch } from "@/lib/fetch";

import { useEffect, useState } from "react";
import { Palette, Shield, MessageSquare, Upload, Radio, Link2 } from "lucide-react";
import { ImageUrlField } from "@/components/ImageUrlField";
import { SettingsTabs } from "@/components/SettingsTabs";
import { Toggle } from "@/components/ui/Toggle";

interface Topic { id: string; title: string; slug: string }

interface Props {
  settings: Record<string, string>;
  topics: Topic[];
}

const inputCls =
  "w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent";

function useSectionSave(keys: string[], getValues: () => Record<string, unknown>) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await apiFetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(getValues()),
      });
      if (!res.ok) throw new Error("save failed");
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return { saving, error, saved, save };
}

function SaveBar({ saving, error, saved, onSave }: { saving: boolean; error: string | null; saved: boolean; onSave: () => void }) {
  return (
    <div className="flex items-center gap-3 border-t border-border pt-4 mt-2">
      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save"}
      </button>
      {error && <p className="text-sm text-danger">{error}</p>}
      {saved && <p className="text-sm text-green-400">Saved.</p>}
    </div>
  );
}

export function AdminSettingsForm({ settings, topics }: Props) {
  const [communityName, setCommunityName] = useState(settings.community_name ?? "");
  const [communityLogo, setCommunityLogo] = useState(settings.community_logo_url ?? "");
  const [communityBanner, setCommunityBanner] = useState(settings.community_banner_url ?? "");
  const [pwaIcon, setPwaIcon] = useState(settings.pwa_icon_url ?? "");
  const [bannerInTopics, setBannerInTopics] = useState(settings.banner_in_topics === "true");
  const [bannerTopicHeight, setBannerTopicHeight] = useState(settings.banner_topic_height ?? "180");
  const [bannerTopicOverlap, setBannerTopicOverlap] = useState(settings.banner_topic_overlap ?? "60");
  const [bannerOverlayEnabled, setBannerOverlayEnabled] = useState(settings.banner_overlay_enabled === "true");
  const [bannerOverlayOpacity, setBannerOverlayOpacity] = useState(settings.banner_overlay_opacity ?? "40");
  const [bannerFadeEnabled, setBannerFadeEnabled] = useState(settings.banner_fade_enabled !== "false");
  const [registrationMode, setRegistrationMode] = useState<string>(settings.registration_mode ?? "telegram_only");
  const [requirePasskey, setRequirePasskey] = useState(settings.require_passkey_at_registration === "true");
  const [magicLinkDisabled, setMagicLinkDisabled] = useState(settings.magic_link_login_disabled === "true");
  const [defaultTopicId, setDefaultTopicId] = useState(settings.default_topic_id ?? "");
  const [welcomeMessage, setWelcomeMessage] = useState(settings.welcome_message ?? "Welcome, {nickname}!");
  const [farewellMessage, setFarewellMessage] = useState(settings.farewell_message ?? "Goodbye, {nickname}.");
  const [giphyEnabled, setGiphyEnabled] = useState(settings.giphy_enabled === "true");
  const [giphyApiKey, setGiphyApiKey] = useState(settings.giphy_api_key ?? "");
  const [sidebarCompactDefault, setSidebarCompactDefault] = useState<string>(settings.sidebar_compact_default ?? "minimal");
  const [p2pMaxParticipants, setP2pMaxParticipants] = useState(settings.p2p_max_participants ?? "5");
  const [stunServers, setStunServers] = useState(
    settings.stun_servers
      ? (JSON.parse(settings.stun_servers) as { urls: string }[]).map((s) => s.urls).join("\n")
      : "stun:stun.l.google.com:19302\nstun:stun1.l.google.com:19302",
  );
  const [turnUrl, setTurnUrl] = useState(settings.turn_url ?? "");
  const [turnUsername, setTurnUsername] = useState(settings.turn_username ?? "");
  const [turnCredential, setTurnCredential] = useState(settings.turn_credential ?? "");
  const [uploadResizeCap, setUploadResizeCap] = useState(settings.upload_resize_cap ?? "2560");
  const [uploadJpegQuality, setUploadJpegQuality] = useState(settings.upload_jpeg_quality ?? "85");
  const [uploadMaxSizeImageMb, setUploadMaxSizeImageMb] = useState(settings.upload_max_size_image_mb ?? "10");
  const [uploadMaxSizeFileMb, setUploadMaxSizeFileMb] = useState(settings.upload_max_size_file_mb ?? "50");
  const [uploadAllowOriginal, setUploadAllowOriginal] = useState((settings.upload_allow_original ?? "true") === "true");
  const [uploadOriginalPerHour, setUploadOriginalPerHour] = useState(settings.upload_original_per_hour ?? "10");
  const [uploadOriginalPerDay, setUploadOriginalPerDay] = useState(settings.upload_original_per_day ?? "50");
  const [shlinkEnabled, setShlinkEnabled] = useState(settings.shlink_enabled === "true");
  const [shlinkHost, setShlinkHost] = useState(settings.shlink_host ?? "");
  const [shlinkApiKey, setShlinkApiKey] = useState(settings.shlink_api_key ?? "");
  const [shlinkDefaultDomain, setShlinkDefaultDomain] = useState(settings.shlink_default_domain ?? "");
  const [shlinkTagWithUser, setShlinkTagWithUser] = useState(settings.shlink_tag_with_user === "true");
  const [shlinkWrapRegex, setShlinkWrapRegex] = useState(settings.shlink_wrap_regex ?? "");
  const [stripTrackingParams, setStripTrackingParams] = useState(settings.strip_tracking_params === "true");
  const [extLinkInterstitial, setExtLinkInterstitial] = useState((settings.external_link_interstitial_enabled ?? "true") !== "false");
  const [extLinkWhitelist, setExtLinkWhitelist] = useState(settings.external_link_whitelist ?? "");

  const community = useSectionSave([], () => ({
    community_name: communityName.trim() || null,
    community_logo_url: communityLogo.trim() || null,
    community_banner_url: communityBanner.trim() || null,
    pwa_icon_url: pwaIcon.trim() || null,
    banner_in_topics: String(bannerInTopics),
    banner_topic_height: bannerTopicHeight || "180",
    banner_topic_overlap: bannerTopicOverlap || "60",
    banner_overlay_enabled: String(bannerOverlayEnabled),
    banner_overlay_opacity: bannerOverlayOpacity || "40",
    banner_fade_enabled: String(bannerFadeEnabled),
  }));

  const registration = useSectionSave([], () => ({
    registration_mode: registrationMode,
    require_passkey_at_registration: requirePasskey ? "true" : "false",
    magic_link_login_disabled: magicLinkDisabled ? "true" : "false",
  }));

  const welcome = useSectionSave([], () => ({
    default_topic_id: defaultTopicId || null,
    welcome_message: welcomeMessage.trim() || null,
    farewell_message: farewellMessage.trim() || null,
  }));

  const giphy = useSectionSave([], () => ({
    giphy_enabled: String(giphyEnabled),
    giphy_api_key: giphyApiKey.trim() || null,
  }));

  const sidebar = useSectionSave([], () => ({
    sidebar_compact_default: sidebarCompactDefault,
  }));

  const p2p = useSectionSave([], () => ({
    p2p_max_participants: p2pMaxParticipants || "5",
    stun_servers: JSON.stringify(
      stunServers.split("\n").map((u) => u.trim()).filter(Boolean).map((urls) => ({ urls })),
    ),
    turn_url: turnUrl.trim() || null,
    turn_username: turnUsername.trim() || null,
    turn_credential: turnCredential.trim() || null,
  }));

  const linkWrap = useSectionSave([], () => ({
    shlink_enabled: String(shlinkEnabled),
    shlink_host: shlinkHost.trim() || null,
    shlink_api_key: shlinkApiKey.trim() || null,
    shlink_default_domain: shlinkDefaultDomain.trim() || null,
    shlink_tag_with_user: String(shlinkTagWithUser),
    shlink_wrap_regex: shlinkWrapRegex.trim() || null,
    strip_tracking_params: String(stripTrackingParams),
    external_link_interstitial_enabled: String(extLinkInterstitial),
    external_link_whitelist: extLinkWhitelist.trim() || null,
  }));

  const uploads = useSectionSave([], () => ({
    upload_resize_cap: uploadResizeCap || "2560",
    upload_jpeg_quality: uploadJpegQuality || "85",
    upload_max_size_image_mb: uploadMaxSizeImageMb || "10",
    upload_max_size_file_mb: uploadMaxSizeFileMb || "50",
    upload_allow_original: String(uploadAllowOriginal),
    upload_original_per_hour: uploadOriginalPerHour || "10",
    upload_original_per_day: uploadOriginalPerDay || "50",
  }));

  return (
    <div className="space-y-6">
      <SettingsTabs
        tabs={[
          { key: "branding", label: "Branding", icon: Palette },
          { key: "access", label: "Access", icon: Shield },
          { key: "content", label: "Content", icon: MessageSquare },
          { key: "media", label: "Media", icon: Upload },
          { key: "realtime", label: "Realtime", icon: Radio },
          { key: "integrations", label: "Integrations", icon: Link2 },
        ]}
        panels={{
          branding: (
            <>
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
          <ImageUrlField
            value={communityLogo}
            onChange={setCommunityLogo}
            bucket="avatars"
            placeholder="https://example.com/logo.png"
            hint="Shown in the header and browser tab. JPEG, PNG, GIF, WebP · max 10 MB."
          />
        </Field>
        <Field label="Banner URL">
          <ImageUrlField
            value={communityBanner}
            onChange={setCommunityBanner}
            bucket="avatars"
            placeholder="https://example.com/banner.png"
            hint="Decorative banner on login/register pages and optionally in topics. JPEG, PNG, GIF, WebP · max 10 MB."
          />
        </Field>

        <Field label="Show banner in topics">
          <label className="flex cursor-pointer items-center gap-3">
            <Toggle checked={bannerInTopics} onChange={setBannerInTopics} />
            <span className="text-sm">{bannerInTopics ? "Banner shown as topic background" : "Banner hidden in topics"}</span>
          </label>
        </Field>

        {bannerInTopics && (
          <>
            <Field label="Banner height (px)">
              <input type="number" min="60" max="600" value={bannerTopicHeight} onChange={(e) => setBannerTopicHeight(e.target.value)} className={inputCls} />
              <p className="mt-1 text-xs text-muted">Total height of the banner area in the topic view.</p>
            </Field>
            <Field label="Content overlap (px)">
              <input type="number" min="0" max="400" value={bannerTopicOverlap} onChange={(e) => setBannerTopicOverlap(e.target.value)} className={inputCls} />
              <p className="mt-1 text-xs text-muted">How many pixels of the banner the content slides over.</p>
            </Field>
            <Field label="Semi-transparent overlay">
              <label className="flex cursor-pointer items-center gap-3">
                <Toggle checked={bannerOverlayEnabled} onChange={setBannerOverlayEnabled} />
                <span className="text-sm">{bannerOverlayEnabled ? "Overlay enabled" : "No overlay"}</span>
              </label>
            </Field>
            {bannerOverlayEnabled && (
              <Field label="Overlay opacity (0–100)">
                <div className="flex items-center gap-3">
                  <input type="range" min="0" max="100" value={bannerOverlayOpacity} onChange={(e) => setBannerOverlayOpacity(e.target.value)} className="flex-1 accent-accent" />
                  <span className="w-10 text-right text-sm tabular-nums">{bannerOverlayOpacity}%</span>
                </div>
              </Field>
            )}
            <Field label="Fade to background">
              <label className="flex cursor-pointer items-center gap-3">
                <Toggle checked={bannerFadeEnabled} onChange={setBannerFadeEnabled} />
                <span className="text-sm">{bannerFadeEnabled ? "Banner fades to transparent at the bottom" : "Hard edge"}</span>
              </label>
            </Field>
          </>
        )}

        <Field label="PWA icon URL">
          <ImageUrlField
            value={pwaIcon}
            onChange={setPwaIcon}
            bucket="avatars"
            placeholder="https://example.com/icon.png"
            hint="Square PNG, at least 512×512. Used as the home screen icon when users install the app."
          />
        </Field>
        <SaveBar {...community} onSave={community.save} />
      </Section>
            </>
          ),
          access: (
            <>
              {/* Registration */}
              <Section title="Registration">
        <Field label="Registration mode">
          <select value={registrationMode} onChange={(e) => setRegistrationMode(e.target.value)} className={inputCls}>
            <option value="closed">Closed — no new registrations</option>
            <option value="telegram_only">Telegram only — link existing Telegram account</option>
            <option value="open">Open — email/username/password</option>
          </select>
          <p className="mt-1 text-xs text-muted">In "Telegram only" and "Open" modes, an invitation code may still be required.</p>
        </Field>
        <div className="flex items-start gap-2 text-sm">
          <Toggle
            checked={requirePasskey}
            onChange={setRequirePasskey}
            aria-label="Require passkey at registration"
          />
          <span className="mt-2">
            <span className="font-medium">Require passkey at registration</span>
            <span className="block text-xs text-muted">New users via Telegram must complete passkey setup before their session is issued.</span>
          </span>
        </div>
        <div className="flex items-start gap-2 text-sm">
          <Toggle
            checked={magicLinkDisabled}
            onChange={setMagicLinkDisabled}
            aria-label="Passkey-only login"
          />
          <span className="mt-2">
            <span className="font-medium">Passkey-only login</span>
            <span className="block text-xs text-muted">Bot is funnel only. Existing users with passkeys authenticate inside the app. Users without passkeys are exempt.</span>
          </span>
        </div>
        <SaveBar {...registration} onSave={registration.save} />
      </Section>
              <InviteConfigSection />
            </>
          ),
          content: (
            <>
              {/* Welcome flow */}
              <Section title="Welcome flow">
        <Field label="Default channel">
          <select value={defaultTopicId} onChange={(e) => setDefaultTopicId(e.target.value)} className={inputCls}>
            <option value="">— none —</option>
            {topics.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
          <p className="mt-1 text-xs text-muted">New members receive system messages in this channel.</p>
        </Field>
        <Field label="Welcome message">
          <input value={welcomeMessage} onChange={(e) => setWelcomeMessage(e.target.value)} maxLength={500} placeholder="Welcome, {nickname}!" className={inputCls} />
          <p className="mt-1 text-xs text-muted">Use <code className="rounded bg-panel2 px-1">{"{nickname}"}</code> for their display name.</p>
        </Field>
        <Field label="Farewell message">
          <input value={farewellMessage} onChange={(e) => setFarewellMessage(e.target.value)} maxLength={500} placeholder="Goodbye, {nickname}." className={inputCls} />
          <p className="mt-1 text-xs text-muted">Use <code className="rounded bg-panel2 px-1">{"{nickname}"}</code> for their display name.</p>
        </Field>
        <SaveBar {...welcome} onSave={welcome.save} />
      </Section>

      {/* Sidebar */}
      <Section title="Sidebar">
        <Field label="Default collapsed sidebar style">
          <select value={sidebarCompactDefault} onChange={(e) => setSidebarCompactDefault(e.target.value)} className={inputCls}>
            <option value="minimal">Minimal — button in header (no space used)</option>
            <option value="strip">Strip — icon bar at the side</option>
          </select>
          <p className="mt-1 text-xs text-muted">When users collapse the sidebar, this controls what happens. Users can override this in their own settings.</p>
        </Field>
        <SaveBar {...sidebar} onSave={sidebar.save} />
      </Section>
            </>
          ),
          realtime: (
            <>
              {/* P2P */}
              <Section title="P2P channels">
        <Field label="Default max participants">
          <input type="number" min="2" max="100" value={p2pMaxParticipants} onChange={(e) => setP2pMaxParticipants(e.target.value)} className={inputCls} />
          <p className="mt-1 text-xs text-muted">Max simultaneous peers in a P2P channel (2–100). Per-topic overrides take precedence.</p>
        </Field>
        <Field label="STUN servers (one URL per line)">
          <textarea value={stunServers} onChange={(e) => setStunServers(e.target.value)} rows={3} className={`${inputCls} font-mono resize-y`} placeholder="stun:stun.l.google.com:19302" />
          <p className="mt-1 text-xs text-muted">Public STUN servers for WebRTC NAT traversal. Leave as default if unsure.</p>
        </Field>
        <Field label="TURN server URL">
          <input value={turnUrl} onChange={(e) => setTurnUrl(e.target.value)} placeholder="turn:turn.example.com:3478" className={inputCls} />
          <p className="mt-1 text-xs text-muted">Optional. Needed for users behind strict NAT (~15%). Leave blank to skip.</p>
        </Field>
        <Field label="TURN username">
          <input value={turnUsername} onChange={(e) => setTurnUsername(e.target.value)} className={inputCls} />
        </Field>
        <Field label="TURN credential">
          <input type="password" value={turnCredential} onChange={(e) => setTurnCredential(e.target.value)} className={inputCls} />
        </Field>
        <SaveBar {...p2p} onSave={p2p.save} />
      </Section>
            </>
          ),
          media: (
            <>
              {/* Uploads */}
              <Section title="Uploads">
        <Field label="Resize cap (px)">
          <input type="number" min="0" max="8192" value={uploadResizeCap} onChange={(e) => setUploadResizeCap(e.target.value)} className={inputCls} />
          <p className="mt-1 text-xs text-muted">Longest-edge px for client re-encode. 0 disables resize.</p>
        </Field>
        <Field label="JPEG quality (1–100)">
          <input type="number" min="1" max="100" value={uploadJpegQuality} onChange={(e) => setUploadJpegQuality(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Max image size (MB)">
          <input type="number" min="1" max="200" value={uploadMaxSizeImageMb} onChange={(e) => setUploadMaxSizeImageMb(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Max file size (MB)">
          <input type="number" min="1" max="2000" value={uploadMaxSizeFileMb} onChange={(e) => setUploadMaxSizeFileMb(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Allow native-resolution uploads">
          <label className="flex cursor-pointer items-center gap-3">
            <Toggle checked={uploadAllowOriginal} onChange={setUploadAllowOriginal} />
            <span className="text-sm">{uploadAllowOriginal ? "Users may opt to keep originals (rate-limited)" : "All uploads stripped and resized"}</span>
          </label>
        </Field>
        <Field label="Originals per hour">
          <input type="number" min="0" max="1000" value={uploadOriginalPerHour} onChange={(e) => setUploadOriginalPerHour(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Originals per day">
          <input type="number" min="0" max="10000" value={uploadOriginalPerDay} onChange={(e) => setUploadOriginalPerDay(e.target.value)} className={inputCls} />
        </Field>
        <SaveBar {...uploads} onSave={uploads.save} />
      </Section>
            </>
          ),
          integrations: (
            <>
              {/* Giphy */}
              <Section title="GIF — Giphy integration">
                <Field label="Enable Giphy">
                  <label className="flex cursor-pointer items-center gap-3">
                    <Toggle checked={giphyEnabled} onChange={setGiphyEnabled} />
                    <span className="text-sm">{giphyEnabled ? "Giphy search enabled" : "Giphy disabled (library only)"}</span>
                  </label>
                </Field>
                <Field label="Giphy API key">
                  <input type="password" value={giphyApiKey} onChange={(e) => setGiphyApiKey(e.target.value)} placeholder="Paste your Giphy API key" className={inputCls} />
                  <p className="mt-1 text-xs text-muted">Required when Giphy is enabled. Get one at developers.giphy.com.</p>
                </Field>
                <SaveBar {...giphy} onSave={giphy.save} />
              </Section>

              {/* Link wrapping */}
              <Section title="Link wrapping">
                <Field label="Strip tracking parameters">
                  <label className="flex cursor-pointer items-center gap-3">
                    <Toggle checked={stripTrackingParams} onChange={setStripTrackingParams} />
                    <span className="text-sm">{stripTrackingParams ? "Tracking params removed from outbound links" : "Links sent as-is"}</span>
                  </label>
                  <p className="mt-1 text-xs text-muted">Removes utm_*, fbclid, igsh, and host-scoped trackers (Twitter/X, YouTube, TikTok, Amazon). Works independently of Shlink.</p>
                </Field>
                <Field label="Enable Shlink shortener">
                  <label className="flex cursor-pointer items-center gap-3">
                    <Toggle checked={shlinkEnabled} onChange={setShlinkEnabled} />
                    <span className="text-sm">{shlinkEnabled ? "External links wrapped via Shlink" : "Shlink disabled"}</span>
                  </label>
                  <p className="mt-1 text-xs text-muted">Self-hosted URL shortener. Processing happens server-side; API key never reaches the browser.</p>
                </Field>
                {shlinkEnabled && (
                  <>
                    <Field label="Shlink host URL">
                      <input value={shlinkHost} onChange={(e) => setShlinkHost(e.target.value)} placeholder="https://s.example.com" className={inputCls} />
                      <p className="mt-1 text-xs text-muted">Base URL of your Shlink instance, no trailing slash.</p>
                    </Field>
                    <Field label="Shlink API key">
                      <input type="password" value={shlinkApiKey} onChange={(e) => setShlinkApiKey(e.target.value)} placeholder="Paste your Shlink API key" className={inputCls} />
                      <p className="mt-1 text-xs text-muted">Found under "API keys" in Shlink's web UI.</p>
                    </Field>
                    <Field label="Default domain (optional)">
                      <input value={shlinkDefaultDomain} onChange={(e) => setShlinkDefaultDomain(e.target.value)} placeholder="s.example.com" className={inputCls} />
                      <p className="mt-1 text-xs text-muted">Override the short-URL host for multi-domain Shlink setups. Leave blank to use Shlink's default.</p>
                    </Field>
                    <Field label="Tag with sender user ID">
                      <label className="flex cursor-pointer items-center gap-3">
                        <Toggle checked={shlinkTagWithUser} onChange={setShlinkTagWithUser} />
                        <span className="text-sm">{shlinkTagWithUser ? "Each short URL tagged user:<id>" : "No per-sender tagging"}</span>
                      </label>
                      <p className="mt-1 text-xs text-muted">Lets admins attribute clicks to senders in Shlink stats. Privacy implication: the bare user ID is stored on the Shlink server alongside the short URL.</p>
                    </Field>
                    <Field label="Wrap filter (regex)">
                      <input value={shlinkWrapRegex} onChange={(e) => setShlinkWrapRegex(e.target.value)} placeholder="^https?://(.+\.ru|suspicious\.com)/" className={`${inputCls} font-mono`} />
                      <p className="mt-1 text-xs text-muted">Only URLs matching this regex are wrapped. Empty = wrap nothing (strip-only mode). Tested against the full URL after tracking-param strip. Invalid regex disables wrap.</p>
                    </Field>
                  </>
                )}
                <Field label="External-link warning dialog">
                  <label className="flex cursor-pointer items-center gap-3">
                    <Toggle checked={extLinkInterstitial} onChange={setExtLinkInterstitial} />
                    <span className="text-sm">{extLinkInterstitial ? "Confirm before leaving the app" : "Links open without warning"}</span>
                  </label>
                  <p className="mt-1 text-xs text-muted">Shows the destination URL in a dialog. User must explicitly click "Open link" to proceed. Modifier-click (Ctrl/Cmd/middle) bypasses for power users.</p>
                </Field>
                {extLinkInterstitial && (
                  <Field label="Whitelist (skip warning for these hosts)">
                    <textarea
                      value={extLinkWhitelist}
                      onChange={(e) => setExtLinkWhitelist(e.target.value)}
                      rows={4}
                      placeholder={"youtube.com\ngithub.com\nwikipedia.org"}
                      className={`${inputCls} font-mono resize-y`}
                    />
                    <p className="mt-1 text-xs text-muted">One hostname per line (or comma-separated). Subdomains match automatically (e.g. <code className="rounded bg-panel2 px-1">youtube.com</code> covers <code className="rounded bg-panel2 px-1">m.youtube.com</code>). Same-origin URLs always skip.</p>
                  </Field>
                )}
                <SaveBar {...linkWrap} onSave={linkWrap.save} />
              </Section>
            </>
          ),
        }}
      />
    </div>
  );
}


const ROLES = ["user", "moderator", "admin"] as const;

function InviteConfigSection() {
  const [invitesEnabled, setInvitesEnabled] = useState(true);
  const [quotas, setQuotas] = useState<Record<string, number>>({ user: 1, moderator: 10, admin: 100 });
  const [codePrefix, setCodePrefix] = useState("LGND");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/admin/invite-config")
      .then((r) => r.json())
      .then((d: { invitesEnabled: boolean; quotas: Record<string, number>; codePrefix?: string }) => {
        setInvitesEnabled(d.invitesEnabled);
        setQuotas((prev) => ({ ...prev, ...d.quotas }));
        if (d.codePrefix) setCodePrefix(d.codePrefix);
      })
      .catch(() => {});
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await apiFetch("/api/admin/invite-config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invitesEnabled, quotas, codePrefix: codePrefix.trim() || "LGND" }),
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
          <Toggle checked={invitesEnabled} onChange={setInvitesEnabled} />
          <span className="text-sm">{invitesEnabled ? "Invite code required" : "Anyone can register without invite"}</span>
        </label>
        <p className="mt-1 text-xs text-muted">When enabled, new users must present a valid invite code during registration.</p>
      </Field>
      <Field label="Invite code prefix">
        <div className="flex items-center gap-2">
          <input
            value={codePrefix}
            onChange={(e) => setCodePrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
            maxLength={8}
            placeholder="LGND"
            className="w-32 rounded-lg border border-border bg-panel2 px-3 py-2 text-sm font-mono outline-none focus:border-accent"
          />
          <span className="text-sm text-muted">#XXXXXX</span>
        </div>
        <p className="mt-1 text-xs text-muted">Prefix for generated invite codes. Existing codes keep their original prefix.</p>
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
      <SaveBar saving={saving} error={error} saved={saved} onSave={save} />
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

