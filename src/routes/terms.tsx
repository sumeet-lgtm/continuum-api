import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/terms")({
  component: TermsPage,
});

function TermsPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <a href="https://continuumapi.com" className="text-sm text-muted-foreground hover:text-foreground">← continuumapi.com</a>
        <h1 className="text-3xl font-display font-medium mt-8 mb-2">Terms of Service</h1>
        <p className="text-sm text-muted-foreground mb-10">Last updated: August 27, 2026</p>

        <section className="space-y-8 text-sm leading-relaxed">
          <div>
            <h2 className="text-base font-semibold mb-2">1. Acceptance of Terms</h2>
            <p>By accessing or using the Continuum platform ("Service"), you agree to be bound by these Terms of Service. If you do not agree, do not use the Service. Continuum is operated by Sumeet Sutar ("Company", "we", "us").</p>
          </div>

          <div>
            <h2 className="text-base font-semibold mb-2">2. Description of Service</h2>
            <p>Continuum provides email verification, transactional email sending, bulk campaigns, mailing list management, cold outreach sequencing, and related developer infrastructure ("Service"). Access is provided via API keys and a web dashboard.</p>
          </div>

          <div>
            <h2 className="text-base font-semibold mb-2">3. Account Registration</h2>
            <p>You must provide accurate information when creating an account. You are responsible for maintaining the security of your API keys. You must not share API keys or allow unauthorized access to your account.</p>
          </div>

          <div>
            <h2 className="text-base font-semibold mb-2">4. Acceptable Use</h2>
            <p>You agree not to use the Service to:</p>
            <ul className="list-disc pl-5 mt-2 space-y-1 text-muted-foreground">
              <li>Send spam, phishing emails, or unsolicited commercial email to recipients who have not opted in</li>
              <li>Violate CAN-SPAM, GDPR, CASL, or any applicable email marketing law</li>
              <li>Send malware, viruses, or harmful content</li>
              <li>Harvest email addresses without consent</li>
              <li>Abuse rate limits or attempt to circumvent usage quotas</li>
              <li>Resell or sublicense access to the Service without written permission</li>
            </ul>
          </div>

          <div>
            <h2 className="text-base font-semibold mb-2">5. Billing and Payment</h2>
            <p>Paid plans are billed monthly. Payments are processed by Dodo Payments. All fees are non-refundable except where required by law. We may suspend access for non-payment after reasonable notice. Plan limits reset monthly on your billing date.</p>
          </div>

          <div>
            <h2 className="text-base font-semibold mb-2">6. Data and Privacy</h2>
            <p>We process email addresses and sending data on your behalf. You remain the data controller for your recipient lists. We act as a data processor. See our <a href="/privacy" className="underline">Privacy Policy</a> for details on data handling.</p>
          </div>

          <div>
            <h2 className="text-base font-semibold mb-2">7. Service Availability</h2>
            <p>We target 99.9% uptime but do not guarantee uninterrupted service. Scheduled maintenance will be communicated in advance where possible. We are not liable for losses caused by downtime.</p>
          </div>

          <div>
            <h2 className="text-base font-semibold mb-2">8. Termination</h2>
            <p>You may cancel your account at any time. We reserve the right to suspend or terminate accounts that violate these Terms, with or without notice depending on severity. Upon termination, your data may be deleted after 30 days.</p>
          </div>

          <div>
            <h2 className="text-base font-semibold mb-2">9. Limitation of Liability</h2>
            <p>To the maximum extent permitted by law, the Company's total liability for any claim arising from use of the Service is limited to the amount you paid in the 3 months preceding the claim. We are not liable for indirect, incidental, or consequential damages.</p>
          </div>

          <div>
            <h2 className="text-base font-semibold mb-2">10. Changes to Terms</h2>
            <p>We may update these Terms at any time. We will notify you by email or in-dashboard notice at least 14 days before material changes take effect. Continued use after that date constitutes acceptance.</p>
          </div>

          <div>
            <h2 className="text-base font-semibold mb-2">11. Contact</h2>
            <p>For questions about these Terms, contact us at <a href="mailto:support@continuumapi.com" className="underline">support@continuumapi.com</a>.</p>
          </div>
        </section>
      </div>
    </div>
  );
}
