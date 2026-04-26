// BulkJobStatus mirrors the Prisma enum in prisma/schema.prisma.
export type BulkJobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

// ─── Queue payload ────────────────────────────────────────────────────────────

export interface BulkJobPayload {
  jobId: string;
  apiKeyId: string;
  storagePath: string;
  fileName: string;
}

export interface MonitorCheckPayload {
  batchSize: number;
}

export interface MonitorRecheckPayload {
  monitorId: string;
  source:    string;
}

// ─── API response shapes ──────────────────────────────────────────────────────

export interface BulkJobResponse {
  id: string;
  fileName: string;
  status: BulkJobStatus;
  progress: {
    total: number;
    processed: number;
    duplicates: number;
    errors: number;
    percentComplete: number;
  };
  results: {
    valid: number;
    invalid: number;
    risky: number;
    unknown: number;
  };
  errorMessage: string | null;
  exportReady: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
}

export interface BulkJobEmailRow {
  email: string;
  rowIndex: number;
  isDuplicate: boolean;
  status: string | null;
  subStatus: string | null;
  score: number | null;
  domain: string | null;
  isDisposable: boolean | null;
  isRoleAccount: boolean | null;
  mxFound: boolean | null;
  smtpChecked: boolean | null;
  smtpReachable: boolean | null;
  isCatchAll: boolean | null;
  greylisted: boolean;
  durationMs: number | null;
  verificationId: string | null;
  errorMessage: string | null;
  processedAt: string | null;
}

export interface BulkJobResultsResponse {
  jobId: string;
  fileName: string;
  status: BulkJobStatus;
  totalEmails: number;
  data: BulkJobEmailRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
  filters: {
    status: string | null;
    isDuplicate: boolean | null;
  };
}

// ─── Internal worker types ────────────────────────────────────────────────────

export interface ParsedEmail {
  email: string;
  rowIndex: number;
  isDuplicate: boolean;
}

export interface EmailVerificationOutcome {
  rowId: string;         // BulkJobEmail.id
  email: string;
  rowIndex: number;
  isDuplicate: boolean;
  status: string | null;
  subStatus: string | null;
  score: number | null;
  domain: string | null;
  isDisposable: boolean | null;
  isRoleAccount: boolean | null;
  mxFound: boolean | null;
  smtpChecked: boolean | null;
  smtpReachable: boolean | null;
  isCatchAll: boolean | null;
  greylisted: boolean;
  durationMs: number | null;
  verificationId: string | null;
  errorMessage: string | null;
  processedAt: Date;
}
