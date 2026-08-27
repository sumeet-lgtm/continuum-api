-- Custom tracking domain per SendingDomain
-- e.g. "track.yourdomain.com" overrides api.continuumapi.com for open pixels and click redirects
ALTER TABLE sending_domains ADD COLUMN IF NOT EXISTS tracking_domain TEXT;
