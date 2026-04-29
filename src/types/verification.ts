// VerificationStatus mirrors the Prisma enum in prisma/schema.prisma.
// After `prisma generate` succeeds you may re-export from @prisma/client instead.
export type VerificationStatus = 'valid' | 'invalid' | 'risky' | 'unknown';

export interface VerificationChecks {
  syntaxValid:   boolean;
  mxFound:       boolean;
  mxRecords:     string[];
  isDisposable:  boolean;
  isRoleAccount: boolean;
  smtpChecked:   boolean;
  smtpReachable: boolean | null;
  isCatchAll:    boolean | null;
  greylisted:    boolean;
  spfValid?:     boolean;
  dmarcValid?:   boolean;
  dkimFound?:    boolean;
  blacklisted?:  boolean;
  blacklists?:   string[];
}

export interface VerificationResult {
  id:          string;
  email:       string;
  domain:      string;
  status:      VerificationStatus;
  subStatus:   string | null;
  checks:      VerificationChecks;
  score:       number;
  durationMs:  number;
  checkedAt:   Date;
}

export interface EngineInput {
  email:     string;
  apiKeyId:  string;
  bulkJobId: string | undefined;
  sourceIp:  string | undefined;
}

// ─── Engine sub-types ─────────────────────────────────────────────────────────

export interface SmtpProbeResult {
  checked:     boolean;
  reachable:   boolean | null;
  isCatchAll:  boolean | null;
  greylisted:  boolean;
  rawResponse: string | null;
  error:       string | null;
}

export interface MxLookupResult {
  found:   boolean;
  records: string[];  // MX hostnames sorted by priority ascending (lowest = first)
  error:   string | null;
}

export interface SyntaxResult {
  valid:  boolean;
  reason: string | null;
}

export interface ScorerInput {
  syntaxValid:   boolean;
  mxFound:       boolean;
  isDisposable:  boolean;
  isRoleAccount: boolean;
  smtpChecked:   boolean;
  smtpReachable: boolean | null;
  isCatchAll:    boolean | null;
  greylisted:    boolean;
  spfValid?:     boolean;
  dmarcValid?:   boolean;
  dkimFound?:    boolean;
  blacklisted?:  boolean;
}

export interface ScorerOutput {
  status:    VerificationStatus;
  subStatus: string | null;
  score:     number;
}

// ─── Timing breakdown per engine stage ───────────────────────────────────────

export interface EngineTimings {
  syntaxMs:     number;
  mxMs:         number;
  disposableMs: number;
  roleMs:       number;
  smtpMs:       number;
  totalMs:      number;
}
