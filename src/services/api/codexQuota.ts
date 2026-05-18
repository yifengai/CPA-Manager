import { apiClient } from './client';

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

export const codexQuotaApi = {
  list: () => apiClient.get<CodexQuotaResponse>('/codex-quota'),

  refreshSelected: (files: string[]) =>
    apiClient.post<CodexQuotaResponse>('/codex-quota/refresh', { files }),

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
};
