import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, useRef } from "react";
import { useAuth } from "@/lib/auth-context";
import { Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Continuum API — Email Infrastructure for Developers" },
      { name: "description", content: "Replace Sendgrid, Mailchimp, Smartlead, MillionVerifier, and Warmbox with one API. Email verification, transactional sending, campaigns, cold outreach sequences, inbox warmup, and analytics." },
    ],
  }),
  component: Index,
});

function Index() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && user) void navigate({ to: "/dashboard" });
  }, [loading, user, navigate]);

  if (loading || user) {
    return (
      <div style={{ background: "#000", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/10 border-t-white" />
      </div>
    );
  }

  return <LandingPage />;
}

// ── Inline brand colours for dark landing (bypasses light token system) ──
const C = {
  bg: "#000",
  surface: "#0a0a0a",
  border: "#1c1c1c",
  text: "#fff",
  muted: "#555",
  dim: "#333",
  faint: "#141414",
} as const;

const spin = `@keyframes _cont_spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`;

function LogoDark({ size = 28 }: { size?: number }) {
  return (
    <>
      <style>{spin}</style>
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="#fff" />
        <circle
          cx="16" cy="16" r="9.5"
          stroke="#000" strokeWidth="2.8" strokeDasharray="9 3" strokeLinecap="round"
          style={{ transformOrigin: "16px 16px", animation: "_cont_spin 10s linear infinite" }}
        />
      </svg>
    </>
  );
}

// ── Animated terminal component ──────────────────────────────────────────
const PHASES = [
  {
    prompt: `curl -X POST https://api.continuumapi.com/v1/verify \\
  -H "X-API-Key: ck_live_3f8a..." \\
  -d '{"email":"cto@acmecorp.com"}'`,
    response: `{
  "email":      "cto@acmecorp.com",
  "status":     "valid",
  "score":      98,
  "disposable": false,
  "mx":         "aspmx.l.google.com"
}`,
  },
  {
    prompt: `curl -X POST https://api.continuumapi.com/v1/send \\
  -H "X-API-Key: ck_live_3f8a..." \\
  -d '{"to":"user@company.com","subject":"Welcome"}'`,
    response: `{
  "id":        "msg_01HX9K...",
  "status":    "queued",
  "scheduled": false
}`,
  },
];

function TerminalDemo() {
  const [phaseIdx, setPhaseIdx] = useState(0);
  const [cmdText, setCmdText] = useState("");
  const [resText, setResText] = useState("");
  const [stage, setStage] = useState<"typing-cmd" | "pause" | "typing-res" | "hold">("typing-cmd");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const phase = PHASES[phaseIdx % PHASES.length]!;

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    if (stage === "typing-cmd") {
      if (cmdText.length < phase.prompt.length) {
        timerRef.current = setTimeout(() => setCmdText(phase.prompt.slice(0, cmdText.length + 1)), 18);
      } else {
        timerRef.current = setTimeout(() => setStage("pause"), 400);
      }
    } else if (stage === "pause") {
      timerRef.current = setTimeout(() => setStage("typing-res"), 300);
    } else if (stage === "typing-res") {
      if (resText.length < phase.response.length) {
        timerRef.current = setTimeout(() => setResText(phase.response.slice(0, resText.length + 1)), 8);
      } else {
        timerRef.current = setTimeout(() => setStage("hold"), 2800);
      }
    } else if (stage === "hold") {
      timerRef.current = setTimeout(() => {
        setCmdText("");
        setResText("");
        setStage("typing-cmd");
        setPhaseIdx(i => i + 1);
      }, 400);
    }

    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [stage, cmdText, resText, phase]);

  return (
    <div style={{ background: "#080808", border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}>
      {/* title bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 16px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#1c1c1c" }} />
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#1c1c1c" }} />
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#1c1c1c" }} />
        <span style={{ marginLeft: 8, color: "#2a2a2a", fontSize: 10 }}>bash</span>
      </div>
      {/* terminal body */}
      <div style={{ padding: "18px 20px", minHeight: 280 }}>
        <div>
          <span style={{ color: "#333" }}>$ </span>
          <span style={{ color: "#aaa", whiteSpace: "pre-wrap" }}>{cmdText}</span>
          {stage === "typing-cmd" && <span style={{ color: "#aaa", animation: "blink 1s step-end infinite" }}>▌</span>}
        </div>
        {resText && (
          <pre style={{ margin: "14px 0 0", color: "#666", whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
            {resText.split("\n").map((line, i) => {
              const m = line.match(/^(\s*"[\w_]+":\s*)(.+)(,?)$/);
              if (m) return (
                <span key={i} style={{ display: "block" }}>
                  <span style={{ color: "#444" }}>{m[1]}</span>
                  <span style={{ color: "#ccc" }}>{m[2]}</span>
                  <span style={{ color: "#444" }}>{m[3]}</span>
                </span>
              );
              return <span key={i} style={{ display: "block", color: "#333" }}>{line}</span>;
            })}
            {stage === "typing-res" && resText.length < phase.response.length && (
              <span style={{ color: "#555" }}>▌</span>
            )}
          </pre>
        )}
      </div>
      <style>{`@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}`}</style>
    </div>
  );
}

// ── Feature row data ─────────────────────────────────────────────────────
const FEATURES = [
  {
    category: "Verify",
    headline: "Know your list before you send",
    bullets: ["SMTP-level verification", "6 external providers", "Disposable & role detection", "Bulk jobs up to 10M rows", "MX & DNS intelligence"],
  },
  {
    category: "Send",
    headline: "One API for every email type",
    bullets: ["Transactional emails", "Newsletter campaigns", "Cold outreach sequences", "Multi-mailbox rotation", "A/B testing per step"],
  },
  {
    category: "Deliverability",
    headline: "Land in the inbox, stay there",
    bullets: ["Inbox warmup engine", "Placement testing (Gmail/Outlook/Yahoo)", "Reply detection & unified inbox", "Domain health scoring", "Real-time analytics"],
  },
];

const STATS = [
  { num: "8", label: "email tools in one API" },
  { num: "99.9%", label: "delivery rate on warm domains" },
  { num: "<30ms", label: "verification latency" },
  { num: "$29", label: "to replace your whole stack" },
];

// ── Landing page ─────────────────────────────────────────────────────────
function LandingPage() {
  const s: React.CSSProperties = { background: C.bg, color: C.text, minHeight: "100vh", fontFamily: "ui-sans-serif, system-ui, sans-serif" };

  return (
    <div style={s}>

      {/* Nav */}
      <nav style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 48px", borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, background: "rgba(0,0,0,0.9)", backdropFilter: "blur(12px)", zIndex: 50 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <LogoDark size={28} />
          <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.01em" }}>
            Continuum <span style={{ fontWeight: 400, color: C.muted }}>API</span>
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <a href="https://app.continuumapi.com/dashboard/billing" style={{ fontSize: 13, color: C.muted, textDecoration: "none" }}>Pricing</a>
          <Link to="/login" style={{ display: "inline-block", fontSize: 13, color: C.text, textDecoration: "none", border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 14px", transition: "border-color 0.15s" }}>
            Sign in →
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 60, padding: "100px 48px 80px", maxWidth: 1100, margin: "0 auto", alignItems: "center" }}>
        <div>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, border: `1px solid ${C.border}`, borderRadius: 20, padding: "4px 12px", marginBottom: 28, fontSize: 11, color: C.muted, fontFamily: "ui-monospace, monospace", letterSpacing: "0.05em" }}>
            VERIFY · SEND · CAMPAIGN · SEQUENCE · WARMUP
          </div>
          <h1 style={{ fontSize: 52, fontWeight: 700, lineHeight: 1.05, letterSpacing: "-0.03em", margin: "0 0 20px", color: C.text }}>
            Replace 5 email<br />tools with one API.
          </h1>
          <p style={{ fontSize: 17, lineHeight: 1.6, color: C.muted, margin: "0 0 36px", maxWidth: 420 }}>
            Email verification, transactional sending, newsletter campaigns, cold outreach sequences, inbox warmup — all from one API, one dashboard, one bill.
          </p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Link
              to="/login"
              style={{ display: "inline-block", background: C.text, color: C.bg, textDecoration: "none", fontSize: 14, fontWeight: 600, padding: "11px 22px", borderRadius: 7 }}
            >
              Get started free →
            </Link>
            <a
              href="https://api.continuumapi.com"
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: "inline-block", background: "transparent", color: C.muted, textDecoration: "none", fontSize: 14, fontWeight: 500, padding: "11px 22px", borderRadius: 7, border: `1px solid ${C.border}` }}
            >
              View API docs
            </a>
          </div>
        </div>

        <div>
          <TerminalDemo />
        </div>
      </section>

      {/* Stats row */}
      <div style={{ borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", maxWidth: 1100, margin: "0 auto" }}>
          {STATS.map((s, i) => (
            <div key={i} style={{ padding: "28px 48px", borderRight: i < 3 ? `1px solid ${C.border}` : "none" }}>
              <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", color: C.text }}>{s.num}</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 4, lineHeight: 1.4 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Features */}
      <section style={{ padding: "80px 48px", maxWidth: 1100, margin: "0 auto" }}>
        <p style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: C.dim, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 16 }}>PLATFORM</p>
        <h2 style={{ fontSize: 36, fontWeight: 700, letterSpacing: "-0.025em", margin: "0 0 60px", color: C.text }}>
          Everything your email stack<br />needs. Nothing more.
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 2 }}>
          {FEATURES.map((f, i) => (
            <div key={i} style={{ background: C.faint, border: `1px solid ${C.border}`, borderRadius: 10, padding: "32px 28px" }}>
              <div style={{ fontSize: 10, fontFamily: "ui-monospace, monospace", color: C.dim, letterSpacing: "0.15em", marginBottom: 14, textTransform: "uppercase" }}>{f.category}</div>
              <h3 style={{ fontSize: 16, fontWeight: 600, color: C.text, margin: "0 0 20px", lineHeight: 1.3 }}>{f.headline}</h3>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {f.bullets.map((b, j) => (
                  <li key={j} style={{ fontSize: 13, color: C.muted, display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: C.dim, fontSize: 10 }}>—</span>
                    {b}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* Tools replaced */}
      <section style={{ borderTop: `1px solid ${C.border}`, padding: "60px 48px", maxWidth: 1100, margin: "0 auto" }}>
        <p style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: C.dim, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 24, textAlign: "center" }}>REPLACES</p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          {["Sendgrid", "Mailchimp", "Smartlead", "Instantly", "MillionVerifier", "Warmbox", "Postmark", "Resend"].map(t => (
            <span key={t} style={{ fontSize: 12, color: C.dim, border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 12px", textDecoration: "line-through", textDecorationColor: C.border }}>
              {t}
            </span>
          ))}
        </div>
        <p style={{ textAlign: "center", color: C.muted, fontSize: 13, marginTop: 20 }}>
          One API key. One invoice. One place to look when deliverability breaks.
        </p>
      </section>

      {/* CTA */}
      <section style={{ borderTop: `1px solid ${C.border}`, padding: "80px 48px", textAlign: "center" }}>
        <LogoDark size={48} />
        <h2 style={{ fontSize: 40, fontWeight: 700, letterSpacing: "-0.03em", margin: "24px 0 14px", color: C.text }}>Start building today.</h2>
        <p style={{ fontSize: 15, color: C.muted, marginBottom: 32 }}>Free plan included. No credit card required.</p>
        <Link
          to="/login"
          style={{ display: "inline-block", background: C.text, color: C.bg, textDecoration: "none", fontSize: 15, fontWeight: 600, padding: "13px 28px", borderRadius: 8 }}
        >
          Create free account →
        </Link>
      </section>

      {/* Footer */}
      <footer style={{ borderTop: `1px solid ${C.border}`, padding: "28px 48px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <LogoDark size={20} />
          <span style={{ fontSize: 12, color: C.dim }}>© 2026 Continuum API</span>
        </div>
        <div style={{ display: "flex", gap: 20 }}>
          {[
            { label: "Pricing", href: "/dashboard/billing" },
            { label: "Privacy", href: "/privacy" },
            { label: "Terms", href: "/terms" },
          ].map(l => (
            <a key={l.label} href={l.href} style={{ fontSize: 12, color: C.dim, textDecoration: "none" }}>{l.label}</a>
          ))}
          <a href="mailto:sumeet@continuumapi.com" style={{ fontSize: 12, color: C.dim, textDecoration: "none" }}>Contact</a>
        </div>
      </footer>
    </div>
  );
}
