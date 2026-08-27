import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <a href="https://continuumapi.com" className="text-sm text-muted-foreground hover:text-foreground">← continuumapi.com</a>
        <h1 className="text-3xl font-semibold mt-8 mb-2">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground mb-10">Last updated: August 27, 2026</p>

        <section className="space-y-8 text-sm leading-relaxed">
          <div>
            <h2 className="text-base font-semibold mb-2">1. Overview</h2>
            <p>Continuum API ("we", "us") is committed to protecting the privacy of our customers and their end-users. This policy explains what data we collect, how we use it, and your rights regarding that data.</p>
          </div>

          <div>
            <h2 className="text-base font-semibold mb-2">2. Data We Collect</h2>
            <ul className="list-disc pl-5 mt-2 space-y-1 text-muted-foreground">
              <li><strong className="text-foreground">Account data:</strong> Name, email address, and authentication credentials when you sign up</li>
              <li><strong className="text-foreground">Usage data:</strong> API request logs, verification counts, sending statistics, and billing history</li>
              <li><strong className="text-foreground">Email sending data:</strong> Recipient addresses, message content, delivery status, open/click events that you send through the Service</li>
              <li><strong className="text-foreground">Technical data:</strong> IP addresses, user agent strings, and timestamps for security and rate-limiting purposes</li>
            </ul>
          </div>

          <div>
            <h2 className="text-base font-semibold mb-2">3. How We Use Your Data</h2>
            <ul className="list-disc pl-5 mt-2 space-y-1 text-muted-foreground">
              <li>To provide, operate, and improve the Service</li>
              <li>To process payments and manage your subscription</li>
              <li>To send transactional emails (receipts, alerts, security notices)</li>
              <li>To enforce our Terms of Service and prevent abuse</li>
              <li>To generate anonymized aggregate analytics</li>
            </ul>
          </div>

          <div>
            <h2 className="text-base font-semibold mb-2">4. Data You Process Through Us</h2>
            <p>When you use Continuum API to send emails or verify addresses, you are the data controller for your recipients' data. We act as a data processor on your behalf. We do not sell, share, or use your recipients' data for any purpose other than delivering the Service to you.</p>
          </div>

          <div>
            <h2 className="text-base font-semibold mb-2">5. Data Retention</h2>
            <p>Account data is retained for the life of your account plus 30 days after deletion. Sent message logs are retained for 90 days on paid plans, 30 days on free accounts. Verification results are retained for 60 days.</p>
          </div>

          <div>
            <h2 className="text-base font-semibold mb-2">6. Third-Party Services</h2>
            <ul className="list-disc pl-5 mt-2 space-y-1 text-muted-foreground">
              <li><strong className="text-foreground">Amazon SES:</strong> Used to deliver transactional emails</li>
              <li><strong className="text-foreground">MillionVerifier:</strong> Used for email verification lookups</li>
              <li><strong className="text-foreground">Dodo Payments:</strong> Used to process subscription payments</li>
              <li><strong className="text-foreground">WorkOS:</strong> Used for authentication (SSO, Google, GitHub login)</li>
              <li><strong className="text-foreground">Supabase:</strong> Used for database hosting (data stored in US region)</li>
            </ul>
          </div>

          <div>
            <h2 className="text-base font-semibold mb-2">7. Cookies</h2>
            <p>We use session cookies for authentication and local storage to remember your dashboard preferences. We do not use third-party advertising cookies. Tracking pixels embedded in emails you send are processed solely to provide delivery analytics to you.</p>
          </div>

          <div>
            <h2 className="text-base font-semibold mb-2">8. Your Rights</h2>
            <p>Depending on your jurisdiction, you may have the right to access, correct, export, or delete your personal data. To exercise these rights, email <a href="mailto:privacy@continuumapi.com" className="underline">privacy@continuumapi.com</a>. We respond within 30 days.</p>
          </div>

          <div>
            <h2 className="text-base font-semibold mb-2">9. Security</h2>
            <p>We encrypt data in transit (TLS 1.2+) and at rest. API keys are hashed before storage. DKIM private keys are encrypted with AES-256-GCM. We do not store payment card details — all payment data is handled by Dodo Payments.</p>
          </div>

          <div>
            <h2 className="text-base font-semibold mb-2">10. Contact</h2>
            <p>For privacy questions or data requests, contact <a href="mailto:privacy@continuumapi.com" className="underline">privacy@continuumapi.com</a>.</p>
          </div>
        </section>
      </div>
    </div>
  );
}
