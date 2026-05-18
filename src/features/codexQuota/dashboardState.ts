import type { CodexQuotaAccount } from '@/services/api';

export type AccountHealthTone = 'good' | 'watch' | 'danger' | 'disabled';
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

export interface AccountHealth {
  label: string;
  reason: string;
  tone: AccountHealthTone;
  rank: number;
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

const accountCycleTokens = 4_000_000;
const accountCycleCostUsd = 4;
const accountCycleCalls = 34;
const averageTokensPerCall = accountCycleTokens / accountCycleCalls;

export const buildAccountPoolBalance = (
  accounts: CodexQuotaAccount[],
  scope: AccountPoolBalanceScope
): AccountPoolBalance => {
  const scopedAccounts = accounts.filter((account) => {
    if (scope === 'inventory') return true;
    return !account.disabled && account.status === 'available' && !account.limitReached;
  });
  const measurableAccounts = scopedAccounts.filter(
    (account) =>
      typeof account.currentRemainingPercent === 'number' &&
      Number.isFinite(account.currentRemainingPercent)
  );
  const estimatedRemainingTokens = measurableAccounts.reduce((total, account) => {
    const remainingPercent = Math.max(0, Math.min(100, account.currentRemainingPercent ?? 0));
    return total + accountCycleTokens * (remainingPercent / 100);
  }, 0);

  return {
    accountCount: scopedAccounts.length,
    measurableAccounts: measurableAccounts.length,
    estimatedRemainingTokens: Math.round(estimatedRemainingTokens),
    estimatedCalls: Math.round(estimatedRemainingTokens / averageTokensPerCall),
    estimatedValueUsd: Math.round((estimatedRemainingTokens / accountCycleTokens) * accountCycleCostUsd * 10) / 10,
  };
};

export const normalizeQuotaErrorReason = (account: CodexQuotaAccount) => {
  if (account.disabled) return '账号已停用';
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
  if (account.status === 'limited' || account.limitReached) return '账号已达调用上限';
  if (account.status === 'error') return '查询失败';
  return '-';
};

export const isCodexQuotaUnavailable = (account: CodexQuotaAccount) =>
  !account.disabled && account.status === 'error';

export const getAccountHealth = (account: CodexQuotaAccount): AccountHealth => {
  const reason = normalizeQuotaErrorReason(account);
  const remaining = account.currentRemainingPercent;

  if (account.disabled || account.status === 'disabled') {
    return {
      label: '已停用',
      reason: '不会进入调用池',
      tone: 'disabled',
      rank: 5,
    };
  }

  if (reason === 'Token已失效' || reason === '登录凭证无效') {
    return {
      label: '需要重新登录',
      reason,
      tone: 'danger',
      rank: 1,
    };
  }

  if (account.status === 'error') {
    return {
      label: '需要检查',
      reason,
      tone: 'danger',
      rank: 2,
    };
  }

  if (
    account.status === 'limited' ||
    account.limitReached ||
    (typeof remaining === 'number' && remaining <= 10)
  ) {
    return {
      label: '建议停用',
      reason:
        account.status === 'limited' || account.limitReached
          ? '当前周期已受限'
          : '剩余额度不超过10%',
      tone: 'danger',
      rank: 2,
    };
  }

  if (typeof remaining !== 'number') {
    return {
      label: '观察',
      reason: account.plan?.toLowerCase() === 'free' ? 'Free账号额度不参与统计' : '余量数据不完整',
      tone: 'watch',
      rank: 4,
    };
  }

  if (remaining <= 20) {
    return {
      label: '观察',
      reason: '剩余额度偏低',
      tone: 'watch',
      rank: 3,
    };
  }

  return {
    label: '健康',
    reason: '状态正常',
    tone: 'good',
    rank: 6,
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
