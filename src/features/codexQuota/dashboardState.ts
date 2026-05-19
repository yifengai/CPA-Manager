import type { CodexQuotaAccount } from '@/services/api';
import {
  calculateCost,
  collectUsageDetails,
  extractTotalTokens,
  type ModelPrice,
} from '@/utils/usage';

export type AccountHealthTone = 'good' | 'watch' | 'danger' | 'disabled';
export type CodexQuotaBusinessStatus = 'callable' | 'limited' | 'error' | 'unknown';
export type RecoveryDayBucketKey =
  | 'restored'
  | 'today'
  | 'tomorrow'
  | 'day2'
  | 'day3'
  | 'day4'
  | 'day5'
  | 'day6'
  | 'day7'
  | 'later'
  | 'unknown';
export type SurvivalBucketKey =
  | 'lt1'
  | 'day1To3'
  | 'day3To7'
  | 'day7To14'
  | 'day14Plus'
  | 'unknown';

export interface AccountHealth {
  label: string;
  reason: string;
  tone: AccountHealthTone;
  rank: number;
}

export interface AccountListDisplay {
  switchLabel: string;
  switchTone: 'enabled' | 'disabled';
  businessLabel: string;
  businessTone: CodexQuotaBusinessStatus;
  reason: string;
}

export interface RefreshReport {
  requestedCount: number;
  refreshedCount: number;
  availableCount: number;
  limitedCount: number;
  errorCount: number;
  tokenInvalidCount: number;
  durationText: string;
}

export interface TodayRestoredAccount {
  file: string;
  account: string;
  restoredAt: string;
  detectedAt: string;
  resetAfter: string;
}

export type AccountPoolBalanceScope = 'available' | 'inventory';

export interface AccountPoolBalance {
  accountCount: number;
  measurableAccounts: number;
  estimatedRemainingTokens: number;
  estimatedCalls: number;
  estimatedValueUsd: number;
}

export interface AccountPoolBalanceSettings {
  accountCycleTokens: number;
  accountCycleCostUsd: number;
  accountCycleCalls: number;
}

export interface QuotaCycleProgress {
  hasData: boolean;
  usedLabelPercent: number | null;
  remainingLabelPercent: number | null;
  usedWidthPercent: number;
  remainingWidthPercent: number;
}

const gpt55InputUsdPerMillionTokens = 5;
const defaultAccountCycleTokens = 4_000_000;

export interface TodayUsageSummary {
  hasUsageData: boolean;
  requestCount: number;
  successCount: number;
  failedCount: number;
  accountCount: number;
  pricedRequestCount: number;
  successRate: number;
  averageLatencyMs: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  inputShare: number;
  outputShare: number;
  cacheHitRate: number;
  estimatedCostUsd: number;
}

export const defaultAccountPoolBalanceSettings: AccountPoolBalanceSettings = {
  accountCycleTokens: defaultAccountCycleTokens,
  accountCycleCostUsd: (defaultAccountCycleTokens / 1_000_000) * gpt55InputUsdPerMillionTokens,
  accountCycleCalls: 34,
};

const clampPercentValue = (value?: number | null) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;

export const buildQuotaCycleProgress = (
  rawUsedPercent?: number | null,
  rawRemainingPercent?: number | null
): QuotaCycleProgress => {
  let usedPercent = clampPercentValue(rawUsedPercent);
  let remainingPercent = clampPercentValue(rawRemainingPercent);

  if (usedPercent === null && remainingPercent !== null) {
    usedPercent = 100 - remainingPercent;
  }
  if (remainingPercent === null && usedPercent !== null) {
    remainingPercent = 100 - usedPercent;
  }
  if (usedPercent === null || remainingPercent === null) {
    return {
      hasData: false,
      usedLabelPercent: usedPercent,
      remainingLabelPercent: remainingPercent,
      usedWidthPercent: 0,
      remainingWidthPercent: 0,
    };
  }

  const total = usedPercent + remainingPercent;
  const usedWidthPercent = total > 0 ? (usedPercent / total) * 100 : 0;

  return {
    hasData: true,
    usedLabelPercent: usedPercent,
    remainingLabelPercent: remainingPercent,
    usedWidthPercent,
    remainingWidthPercent: Math.max(0, 100 - usedWidthPercent),
  };
};

export const getAccountSurvivalMs = (importedAt?: string | null, nowMs = Date.now()) => {
  const text = importedAt?.trim() ?? '';
  if (!text) return null;
  const importedMs = Date.parse(`${text.replace(' ', 'T')}+08:00`);
  if (!Number.isFinite(importedMs) || importedMs > nowMs) return null;
  return nowMs - importedMs;
};

export const formatAccountSurvivalDays = (importedAt?: string | null, nowMs = Date.now()) => {
  const survivalMs = getAccountSurvivalMs(importedAt, nowMs);
  if (survivalMs === null) return '-';
  const rawDays = survivalMs / 86_400_000;
  if (rawDays < 1) {
    return `${Math.max(0.1, Math.round(rawDays * 10) / 10).toFixed(1)}天`;
  }
  return `${Math.floor(rawDays)}天`;
};

export const getAccountSurvivalBucketKey = (
  importedAt?: string | null,
  nowMs = Date.now()
): SurvivalBucketKey => {
  const survivalMs = getAccountSurvivalMs(importedAt, nowMs);
  if (survivalMs === null) return 'unknown';
  const days = survivalMs / 86_400_000;
  if (days < 1) return 'lt1';
  if (days < 3) return 'day1To3';
  if (days < 7) return 'day3To7';
  if (days < 14) return 'day7To14';
  return 'day14Plus';
};

const sanitizeAccountPoolBalanceSettings = (
  settings: AccountPoolBalanceSettings
): AccountPoolBalanceSettings => ({
  accountCycleTokens:
    Number.isFinite(settings.accountCycleTokens) && settings.accountCycleTokens > 0
      ? settings.accountCycleTokens
      : defaultAccountPoolBalanceSettings.accountCycleTokens,
  accountCycleCostUsd:
    Number.isFinite(settings.accountCycleCostUsd) && settings.accountCycleCostUsd > 0
      ? settings.accountCycleCostUsd
      : defaultAccountPoolBalanceSettings.accountCycleCostUsd,
  accountCycleCalls:
    Number.isFinite(settings.accountCycleCalls) && settings.accountCycleCalls > 0
      ? settings.accountCycleCalls
      : defaultAccountPoolBalanceSettings.accountCycleCalls,
});

export const buildAccountPoolBalance = (
  accounts: CodexQuotaAccount[],
  scope: AccountPoolBalanceScope,
  rawSettings: AccountPoolBalanceSettings = defaultAccountPoolBalanceSettings
): AccountPoolBalance => {
  const settings = sanitizeAccountPoolBalanceSettings(rawSettings);
  const averageTokensPerCall = settings.accountCycleTokens / settings.accountCycleCalls;
  const scopedAccounts = accounts.filter((account) => {
    if (scope === 'inventory') return true;
    return (
      !account.disabled &&
      account.status === 'available' &&
      account.allowed !== false &&
      !account.limitReached &&
      typeof account.currentRemainingPercent === 'number' &&
      account.currentRemainingPercent > 0
    );
  });
  const measurableAccounts = scopedAccounts.filter(
    (account) =>
      typeof account.currentRemainingPercent === 'number' &&
      Number.isFinite(account.currentRemainingPercent)
  );
  const estimatedRemainingTokens = measurableAccounts.reduce((total, account) => {
    const remainingPercent = Math.max(0, Math.min(100, account.currentRemainingPercent ?? 0));
    return total + settings.accountCycleTokens * (remainingPercent / 100);
  }, 0);

  return {
    accountCount: scopedAccounts.length,
    measurableAccounts: measurableAccounts.length,
    estimatedRemainingTokens: Math.round(estimatedRemainingTokens),
    estimatedCalls: Math.round(estimatedRemainingTokens / averageTokensPerCall),
    estimatedValueUsd:
      Math.round(
        (estimatedRemainingTokens / settings.accountCycleTokens) * settings.accountCycleCostUsd * 10
      ) / 10,
  };
};

const quotaDiagnosticText = (account: CodexQuotaAccount) =>
  `${account.statusText} ${account.error}`.toLowerCase();

const isAuthQuotaError = (account: CodexQuotaAccount) => {
  const text = quotaDiagnosticText(account);
  return (
    text.includes('缺少token') ||
    text.includes('access_token') ||
    text.includes('token_invalidated') ||
    text.includes('authentication token has been invalidated') ||
    text.includes('401') ||
    text.includes('403') ||
    text.includes('unauthorized') ||
    text.includes('forbidden')
  );
};

export const getCodexQuotaBusinessStatus = (
  account: CodexQuotaAccount
): CodexQuotaBusinessStatus => {
  const remaining = account.currentRemainingPercent;
  if (isAuthQuotaError(account)) return 'error';
  if (account.status === 'error') return 'unknown';
  if (
    typeof remaining !== 'number' ||
    !Number.isFinite(remaining) ||
    account.allowed === undefined ||
    account.limitReached === undefined
  ) {
    return 'unknown';
  }
  if (
    account.status === 'limited' ||
    account.limitReached ||
    account.allowed === false ||
    remaining === 0
  ) {
    return 'limited';
  }
  return 'callable';
};

export const normalizeQuotaErrorReason = (account: CodexQuotaAccount) => {
  const text = `${account.statusText} ${account.error}`.toLowerCase();
  if (!text.trim()) return '-';
  if (
    text.includes('token_invalidated') ||
    text.includes('authentication token has been invalidated')
  ) {
    return 'Token已失效';
  }
  if (text.includes('401') || text.includes('unauthorized')) return '登录凭证无效';
  if (text.includes('timeout') || text.includes('deadline exceeded')) return '查询超时';
  if (text.includes('429') || text.includes('rate limit')) return '接口限流';
  if (text.includes('network') || text.includes('connection')) return '网络连接失败';
  if (
    account.status === 'limited' ||
    account.limitReached ||
    account.allowed === false ||
    account.currentRemainingPercent === 0
  ) {
    return '账号已达调用上限';
  }
  if (account.status === 'error') return '查询失败';
  return '-';
};

export const isCodexQuotaUnavailable = (account: CodexQuotaAccount) =>
  getCodexQuotaBusinessStatus(account) === 'error';

export const getAccountHealth = (account: CodexQuotaAccount): AccountHealth => {
  const reason = normalizeQuotaErrorReason(account);
  const remaining = account.currentRemainingPercent;
  const businessStatus = getCodexQuotaBusinessStatus(account);

  if (businessStatus === 'error' && (reason === 'Token已失效' || reason === '登录凭证无效')) {
    return {
      label: '需要重新登录',
      reason,
      tone: 'danger',
      rank: 1,
    };
  }

  if (businessStatus === 'error') {
    return {
      label: '需要检查',
      reason,
      tone: 'danger',
      rank: 2,
    };
  }

  if (businessStatus === 'unknown') {
    return {
      label: '未知',
      reason: reason === '-' ? '余量数据不完整' : reason,
      tone: 'watch',
      rank: 4,
    };
  }

  if (businessStatus === 'limited') {
    return {
      label: '受限',
      reason: reason === '-' ? '当前周期已受限' : reason,
      tone: 'danger',
      rank: 2,
    };
  }

  if (account.disabled || account.status === 'disabled') {
    return {
      label: '可调用',
      reason: '已停用，不进入调用池',
      tone: 'disabled',
      rank: 5,
    };
  }

  if (typeof remaining === 'number' && remaining <= 20) {
    return {
      label: '观察',
      reason: '剩余额度偏低',
      tone: 'watch',
      rank: 3,
    };
  }

  return {
    label: '可调用',
    reason: '状态正常',
    tone: 'good',
    rank: 6,
  };
};

export const getAccountListDisplay = (account: CodexQuotaAccount): AccountListDisplay => {
  const businessStatus = getCodexQuotaBusinessStatus(account);
  const switchDisabled = account.disabled || account.status === 'disabled';
  const reason = normalizeQuotaErrorReason(account);
  const businessLabels: Record<CodexQuotaBusinessStatus, string> = {
    callable: '可调用',
    limited: '受限',
    error: '异常',
    unknown: '未知',
  };
  const fallbackReasons: Record<CodexQuotaBusinessStatus, string> = {
    callable: '',
    limited: '当前周期已受限',
    error: '账号不可用',
    unknown: '余量数据不完整',
  };

  return {
    switchLabel: switchDisabled ? '已停用' : '启用',
    switchTone: switchDisabled ? 'disabled' : 'enabled',
    businessLabel: businessLabels[businessStatus],
    businessTone: businessStatus,
    reason:
      businessStatus === 'callable' && switchDisabled
        ? '已停用，不进入调用池'
        : reason === '-'
          ? fallbackReasons[businessStatus]
          : reason,
  };
};

const sortableResetTime = (value: string) => {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(value.replace(' ', 'T') + '+08:00');
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
};

const beijingDateKey = (timeMs: number) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timeMs));

const beijingDayStart = (timeMs: number) => Date.parse(`${beijingDateKey(timeMs)}T00:00:00+08:00`);

export const buildTodayUsageSummary = (
  usageData: unknown,
  modelPrices: Record<string, ModelPrice>,
  now = Date.now()
): TodayUsageSummary => {
  if (!usageData) {
    return {
      hasUsageData: false,
      requestCount: 0,
      successCount: 0,
      failedCount: 0,
      accountCount: 0,
      pricedRequestCount: 0,
      successRate: 0,
      averageLatencyMs: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      inputShare: 0,
      outputShare: 0,
      cacheHitRate: 0,
      estimatedCostUsd: 0,
    };
  }

  const todayKey = beijingDateKey(now);
  const details = collectUsageDetails(usageData).filter((detail) => {
    const timestampMs =
      typeof detail.__timestampMs === 'number' && detail.__timestampMs > 0
        ? detail.__timestampMs
        : Date.parse(detail.timestamp);
    return (
      Number.isFinite(timestampMs) && timestampMs > 0 && beijingDateKey(timestampMs) === todayKey
    );
  });
  const accountKeys = new Set<string>();
  let latencyTotal = 0;
  let latencyCount = 0;

  const summary = details.reduce<TodayUsageSummary>(
    (summary, detail) => {
      const totalTokens = Math.max(
        Number(detail.tokens?.total_tokens) || 0,
        extractTotalTokens(detail)
      );
      const inputTokens = Math.max(Number(detail.tokens?.input_tokens) || 0, 0);
      const outputTokens = Math.max(Number(detail.tokens?.output_tokens) || 0, 0);
      const reasoningTokens = Math.max(Number(detail.tokens?.reasoning_tokens) || 0, 0);
      const cachedTokens = Math.max(
        Math.max(Number(detail.tokens?.cached_tokens) || 0, 0),
        Math.max(Number(detail.tokens?.cache_tokens) || 0, 0)
      );
      const cost = calculateCost(detail, modelPrices);
      const accountKey = String(
        detail.auth_index ??
          detail.account_snapshot ??
          detail.auth_label_snapshot ??
          detail.source ??
          ''
      ).trim();
      if (accountKey) accountKeys.add(accountKey);
      if (typeof detail.latency_ms === 'number' && Number.isFinite(detail.latency_ms)) {
        latencyTotal += detail.latency_ms;
        latencyCount += 1;
      }
      summary.requestCount += 1;
      summary.successCount += detail.failed ? 0 : 1;
      summary.failedCount += detail.failed ? 1 : 0;
      summary.pricedRequestCount += cost > 0 ? 1 : 0;
      summary.totalTokens += totalTokens;
      summary.inputTokens += inputTokens;
      summary.outputTokens += outputTokens;
      summary.reasoningTokens += reasoningTokens;
      summary.cachedTokens += cachedTokens;
      summary.estimatedCostUsd += cost;
      return summary;
    },
    {
      hasUsageData: true,
      requestCount: 0,
      successCount: 0,
      failedCount: 0,
      accountCount: 0,
      pricedRequestCount: 0,
      successRate: 0,
      averageLatencyMs: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      inputShare: 0,
      outputShare: 0,
      cacheHitRate: 0,
      estimatedCostUsd: 0,
    }
  );

  if (summary.totalTokens > 0) {
    summary.inputShare = (summary.inputTokens / summary.totalTokens) * 100;
    summary.outputShare = (summary.outputTokens / summary.totalTokens) * 100;
  }
  if (summary.requestCount > 0) {
    summary.successRate = (summary.successCount / summary.requestCount) * 100;
  }
  if (latencyCount > 0) {
    summary.averageLatencyMs = latencyTotal / latencyCount;
  }
  summary.accountCount = accountKeys.size;
  if (summary.inputTokens > 0) {
    summary.cacheHitRate = (summary.cachedTokens / summary.inputTokens) * 100;
  }

  return summary;
};

export const getRecoveryDayBucketKey = (
  resetAtText: string,
  now = Date.now()
): RecoveryDayBucketKey => {
  const resetAt = sortableResetTime(resetAtText);
  if (resetAt === Number.MAX_SAFE_INTEGER) return 'unknown';
  if (resetAt <= now) return 'restored';

  const oneDay = 24 * 60 * 60 * 1000;
  const dayDiff = Math.round((beijingDayStart(resetAt) - beijingDayStart(now)) / oneDay);
  if (dayDiff <= 0) return 'today';
  if (dayDiff === 1) return 'tomorrow';
  if (dayDiff >= 2 && dayDiff <= 7) return `day${dayDiff}` as RecoveryDayBucketKey;
  return 'later';
};

const formatBeijingDateTime = (timeMs: number) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(timeMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
};

export const buildTodayRestoredHistory = ({
  previousAccounts,
  nextAccounts,
  existingHistory,
  now = Date.now(),
}: {
  previousAccounts: CodexQuotaAccount[];
  nextAccounts: CodexQuotaAccount[];
  existingHistory: TodayRestoredAccount[];
  now?: number;
}) => {
  const today = beijingDateKey(now);
  const nextByFile = new Map(nextAccounts.map((account) => [account.file, account]));
  const deduped = new Map<string, TodayRestoredAccount>();

  existingHistory.forEach((record) => {
    const restoredAt = sortableResetTime(record.restoredAt);
    if (restoredAt === Number.MAX_SAFE_INTEGER || beijingDateKey(restoredAt) !== today) return;
    deduped.set(`${record.file}:${record.restoredAt}`, record);
  });

  previousAccounts.forEach((previous) => {
    const previousResetAt = sortableResetTime(previous.currentResetAt);
    if (
      previousResetAt === Number.MAX_SAFE_INTEGER ||
      previousResetAt > now ||
      beijingDateKey(previousResetAt) !== today
    ) {
      return;
    }

    const next = nextByFile.get(previous.file);
    if (!next || next.currentResetAt === previous.currentResetAt) return;
    const nextResetAt = sortableResetTime(next.currentResetAt);
    if (nextResetAt === Number.MAX_SAFE_INTEGER || nextResetAt <= now) return;

    deduped.set(`${previous.file}:${previous.currentResetAt}`, {
      file: previous.file,
      account: next.account || previous.account,
      restoredAt: previous.currentResetAt,
      detectedAt: formatBeijingDateTime(now),
      resetAfter: next.currentResetAt,
    });
  });

  return Array.from(deduped.values()).sort(
    (left, right) => sortableResetTime(right.restoredAt) - sortableResetTime(left.restoredAt)
  );
};

export const buildPriorityAccounts = (accounts: CodexQuotaAccount[], limit = 6) =>
  accounts
    .filter((account) => {
      const health = getAccountHealth(account);
      return health.tone === 'danger' || (health.tone === 'watch' && !account.disabled);
    })
    .sort((left, right) => {
      const leftHealth = getAccountHealth(left);
      const rightHealth = getAccountHealth(right);
      if (leftHealth.rank !== rightHealth.rank) return leftHealth.rank - rightHealth.rank;
      return (left.currentRemainingPercent ?? 999) - (right.currentRemainingPercent ?? 999);
    })
    .slice(0, limit);

export const buildSoonRecoveringAccounts = (
  accounts: CodexQuotaAccount[],
  now = Date.now(),
  limit = 6
) => {
  const threeDays = 3 * 24 * 60 * 60 * 1000;
  return accounts
    .filter((account) => {
      const resetAt = sortableResetTime(account.currentResetAt);
      return resetAt !== Number.MAX_SAFE_INTEGER && resetAt >= now && resetAt <= now + threeDays;
    })
    .sort(
      (left, right) =>
        sortableResetTime(left.currentResetAt) - sortableResetTime(right.currentResetAt)
    )
    .slice(0, limit);
};

const formatDuration = (durationMs: number) => {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '0秒';
  if (durationMs < 1000) return `${Math.round(durationMs)}毫秒`;
  return `${Math.round(durationMs / 100) / 10}秒`;
};

export const buildRefreshReport = ({
  requestedCount,
  refreshedAccounts,
  startedAt,
  endedAt,
}: {
  requestedCount: number;
  refreshedAccounts: CodexQuotaAccount[];
  startedAt: number;
  endedAt: number;
}): RefreshReport => ({
  requestedCount,
  refreshedCount: refreshedAccounts.length,
  availableCount: refreshedAccounts.filter((account) => account.status === 'available').length,
  limitedCount: refreshedAccounts.filter((account) => account.status === 'limited').length,
  errorCount: refreshedAccounts.filter((account) => account.status === 'error').length,
  tokenInvalidCount: refreshedAccounts.filter((account) =>
    normalizeQuotaErrorReason(account).includes('Token')
  ).length,
  durationText: formatDuration(endedAt - startedAt),
});
