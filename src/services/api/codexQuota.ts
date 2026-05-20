import { apiClient } from './client';

const CODEX_QUOTA_REQUEST_TIMEOUT_MS = 180 * 1000;

export type CodexQuotaStatus = 'available' | 'limited' | 'disabled' | 'error';

export interface CodexQuotaSummary {
  generatedAt: string;
  total: number;
  available: number;
  limited: number;
  disabled: number;
  errors: number;
  low: number;
  critical: number;
  average?: number | null;
  median?: number | null;
  plans: Record<string, number>;
  buckets: Array<{ label: string; count: number }>;
}

export interface CodexQuotaAccount {
  file: string;
  account: string;
  email: string;
  importedAt: string;
  disabled: boolean;
  status: CodexQuotaStatus;
  statusText: string;
  plan: string;
  allowed?: boolean;
  limitReached?: boolean;
  currentRemainingPercent?: number;
  currentUsedPercent?: number;
  currentResetAt: string;
  longWindowText: string;
  longRemainingPercent?: number;
  longUsedPercent?: number;
  longResetAt: string;
  creditsBalance?: unknown;
  tokenExpiredAt: string;
  lastRefreshAt: string;
  latencyMs?: number;
  error: string;
  sortRemaining: number;
}

export interface CodexQuotaResponse {
  summary: CodexQuotaSummary;
  accounts: CodexQuotaAccount[];
}

export interface ClearFailedUsageResponse {
  deleted: number;
}

export interface CodexQuotaProtectionResult {
  file: string;
  label: string;
  action: 'protected' | 'already_disabled' | 'observe' | 'keep' | 'error' | 'would_protect';
  reason: string;
  failures: number;
  consecutiveFailures: number;
  lastSeenAt: string;
  lastFailureAt: string;
  failureTypes: Record<string, number>;
}

export interface CodexQuotaProtectionResponse {
  generatedAt: string;
  logDir: string;
  scannedRequests: number;
  matchedAccounts: number;
  protectionCount: number;
  alreadyDisabled: number;
  observationCount: number;
  dryRun: boolean;
  results: CodexQuotaProtectionResult[];
}

export interface CodexQuotaSettings {
  accountCycleTokens: number;
  accountCycleCostUsd: number;
  accountCycleCalls: number;
}

export const codexQuotaApi = {
  settings: () => apiClient.get<CodexQuotaSettings>('/codex-quota/settings'),

  list: () =>
    apiClient.get<CodexQuotaResponse>('/codex-quota', {
      timeout: CODEX_QUOTA_REQUEST_TIMEOUT_MS,
    }),

  refreshSelected: (files: string[]) =>
    apiClient.post<CodexQuotaResponse>('/codex-quota/refresh', { files }, {
      timeout: CODEX_QUOTA_REQUEST_TIMEOUT_MS,
    }),

  setDisabled: (file: string, disabled: boolean) =>
    apiClient.patch<{ status: 'ok'; file: string; disabled: boolean }>('/codex-quota/account', {
      file,
      disabled,
    }),

  deleteAccount: (file: string) =>
    apiClient.delete<{ status: 'ok'; file: string; archivedPath: string }>('/codex-quota/account', {
      params: { file },
    }),

  clearFailedUsage: () => apiClient.delete<ClearFailedUsageResponse>('/usage/failed'),

  protectAccountPool: () =>
    apiClient.post<CodexQuotaProtectionResponse>('/codex-quota/protect', undefined, {
      timeout: CODEX_QUOTA_REQUEST_TIMEOUT_MS,
    }),
};
