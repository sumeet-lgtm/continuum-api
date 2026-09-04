import { createFileRoute } from "@tanstack/react-router";
import React, { useEffect, useState } from "react";
import { toast } from "sonner";
import { Palette, Upload, Sparkles, Eye, Check } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/dashboard/brand-kit")({
  head: () => ({ meta: [{ title: "Brand Kit — Continuum API" }] }),
  component: BrandKitPage,
});

interface BrandKit {
  id?: string;
  logo_url?: string | null;
  primary_color?: string;
  font_family?: string;
  company_name?: string | null;
  from_name?: string | null;
  footer_text?: string | null;
  website_url?: string | null;
}

const FONT_OPTIONS = [
  { label: "System default",  value: "Arial, sans-serif" },
  { label: "Inter",           value: "'Inter', sans-serif" },
  { label: "Georgia (serif)", value: "Georgia, serif" },
  { label: "Roboto",          value: "'Roboto', sans-serif" },
  { label: "Source Sans Pro", value: "'Source Sans Pro', sans-serif" },
  { label: "Helvetica",       value: "Helvetica, Arial, sans-serif" },
];

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function EmailPreview({ kit }: { kit: BrandKit }) {
  const color   = kit.primary_color ?? "#000000";
  const font    = kit.font_family   ?? "Arial, sans-serif";
  const logo    = kit.logo_url;
  const company = kit.company_name  ?? "Your Company";
  const footer  = kit.footer_text   ?? `© ${new Date().getFullYear()} ${company}`;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 py-2 border-b border-border bg-muted/30 flex items-center gap-2">
        <Eye className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Email preview</span>
      </div>
      <div className="p-4" style={{ fontFamily: font }}>
        {/* Header */}
        <div className="rounded-t-md px-6 py-4 text-center mb-0" style={{ backgroundColor: color }}>
          {logo ? (
            <img src={logo} alt={company} className="h-8 mx-auto object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          ) : (
            <p className="text-white font-semibold text-sm">{company}</p>
          )}
        </div>
        {/* Body */}
        <div className="border border-t-0 border-border rounded-b-md px-6 py-5 bg-white dark:bg-background">
          <p className="text-sm font-medium mb-2" style={{ fontFamily: font }}>{"Hi {{first_name}},"}</p>
          <p className="text-sm text-muted-foreground mb-4" style={{ fontFamily: font }}>
            Your payment of <strong>$99.00</strong> has been received. Thank you for your continued trust in {company}.
          </p>
          <a
            href="#"
            style={{ backgroundColor: color, fontFamily: font }}
            className="inline-block rounded-md px-4 py-2 text-sm text-white font-medium no-underline"
          >
            View Receipt
          </a>
          <div className="mt-6 pt-4 border-t border-border text-center text-[11px] text-muted-foreground" style={{ fontFamily: font }}>
            {footer}
          </div>
        </div>
      </div>
    </div>
  );
}

function BrandKitPage() {
  const { primaryKey } = useAuth();
  const [kit, setKit]   = useState<BrandKit>({
    logo_url:      null,
    primary_color: "#000000",
    font_family:   "Arial, sans-serif",
    company_name:  null,
    from_name:     null,
    footer_text:   null,
    website_url:   null,
  });
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [detecting,  setDetecting]  = useState(false);
  const [saved,      setSaved]      = useState(false);

  useEffect(() => {
    if (!primaryKey?.keyRaw) return;
    api.withKey.get<BrandKit>("/v1/brand-kit", primaryKey.keyRaw)
      .then((data) => { if (data && Object.keys(data).length > 0) setKit((k) => ({ ...k, ...data })); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [primaryKey]);

  const save = async () => {
    if (!primaryKey?.keyRaw) return;
    setSaving(true);
    try {
      const updated = await api.withKey.patch<BrandKit>("/v1/brand-kit", kit, primaryKey.keyRaw);
      setKit((k) => ({ ...k, ...updated }));
      setSaved(true);
      toast.success("Brand kit saved");
      setTimeout(() => setSaved(false), 2000);
    } catch {
      toast.error("Failed to save brand kit");
    } finally {
      setSaving(false);
    }
  };

  const autoDetect = async () => {
    if (!primaryKey?.keyRaw || !kit.website_url?.trim()) {
      toast.error("Enter your website URL first");
      return;
    }
    setDetecting(true);
    try {
      const data = await api.withKey.post<{
        logo: string | null;
        primaryColor: string | null;
        fontFamily: string | null;
        companyName: string | null;
      }>("/v1/brand/extract", { url: kit.website_url }, primaryKey.keyRaw);

      setKit((k) => ({
        ...k,
        logo_url:      data.logo      ?? k.logo_url,
        primary_color: data.primaryColor ?? k.primary_color,
        font_family:   data.fontFamily   ?? k.font_family,
        company_name:  data.companyName  ?? k.company_name,
      }));
      toast.success("Brand assets detected from your website");
    } catch {
      toast.error("Could not detect brand from URL");
    } finally {
      setDetecting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        {[...Array(4)].map((_, i) => <div key={i} className="h-32 rounded-lg border border-border bg-card animate-pulse" />)}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-display font-medium tracking-tight">Brand Kit</h1>
          <p className="text-sm text-muted-foreground">
            Your logo, color, font, and footer are automatically applied to all transactional emails and templates.
          </p>
        </div>
        <Button onClick={save} disabled={saving}>
          {saved ? <><Check className="h-4 w-4 mr-1.5" /> Saved</> : saving ? "Saving…" : "Save Brand Kit"}
        </Button>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: settings */}
        <div className="space-y-4">
          <Section title="Auto-detect from website" description="Paste your website URL and we'll extract your logo, brand color, and font automatically.">
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1.5">
                <Label>Website URL</Label>
                <Input
                  placeholder="https://yourcompany.com"
                  value={kit.website_url ?? ""}
                  onChange={(e) => setKit((k) => ({ ...k, website_url: e.target.value }))}
                />
              </div>
              <Button variant="outline" onClick={autoDetect} disabled={detecting}>
                <Sparkles className="h-4 w-4 mr-1.5" />
                {detecting ? "Detecting…" : "Auto-detect"}
              </Button>
            </div>
          </Section>

          <Section title="Logo" description="Direct image URL. Use a transparent PNG or SVG for best results.">
            <div className="space-y-1.5">
              <Label>Logo URL</Label>
              <Input
                placeholder="https://yourcompany.com/logo.png"
                value={kit.logo_url ?? ""}
                onChange={(e) => setKit((k) => ({ ...k, logo_url: e.target.value || null }))}
              />
            </div>
            {kit.logo_url && (
              <div className="h-14 rounded-md border border-border bg-muted/30 flex items-center justify-center p-2">
                <img src={kit.logo_url} alt="Logo preview" className="max-h-full max-w-full object-contain" />
              </div>
            )}
          </Section>

          <Section title="Brand color & typography">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Primary color</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={kit.primary_color ?? "#000000"}
                    onChange={(e) => setKit((k) => ({ ...k, primary_color: e.target.value }))}
                    className="h-9 w-12 rounded-md border border-input cursor-pointer p-0.5"
                  />
                  <Input
                    value={kit.primary_color ?? "#000000"}
                    onChange={(e) => setKit((k) => ({ ...k, primary_color: e.target.value }))}
                    className="font-mono text-sm"
                    maxLength={7}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Font family</Label>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={kit.font_family ?? "Arial, sans-serif"}
                  onChange={(e) => setKit((k) => ({ ...k, font_family: e.target.value }))}
                >
                  {FONT_OPTIONS.map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
              </div>
            </div>
          </Section>

          <Section title="Sender identity & footer">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Company name</Label>
                  <Input
                    placeholder="Acme Inc."
                    value={kit.company_name ?? ""}
                    onChange={(e) => setKit((k) => ({ ...k, company_name: e.target.value || null }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Default from name</Label>
                  <Input
                    placeholder="Acme Support"
                    value={kit.from_name ?? ""}
                    onChange={(e) => setKit((k) => ({ ...k, from_name: e.target.value || null }))}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Footer text <span className="text-muted-foreground font-normal">(required for CAN-SPAM compliance)</span></Label>
                <textarea
                  className="w-full min-h-[64px] resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder={`© ${new Date().getFullYear()} Acme Inc. · 123 Main St, San Francisco, CA 94107 · Unsubscribe`}
                  value={kit.footer_text ?? ""}
                  onChange={(e) => setKit((k) => ({ ...k, footer_text: e.target.value || null }))}
                />
                <p className="text-xs text-muted-foreground">CAN-SPAM requires a physical mailing address. GDPR requires a clear unsubscribe mechanism.</p>
              </div>
            </div>
          </Section>
        </div>

        {/* Right: live preview */}
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Live preview</p>
          <EmailPreview kit={kit} />
          <p className="text-xs text-muted-foreground">
            This preview updates in real time. Brand kit settings are automatically injected into all emails sent via templates.
          </p>
        </div>
      </div>
    </div>
  );
}
