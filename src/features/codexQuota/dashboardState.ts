import type { CodexQuotaAccount } from '@/services/api';

export type AccountHealthTone = 'good' | 'watch' | 'danger' | 'disabled';

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

export const normalizeQuotaErrorReason = (account: CodexQuotaAccount) => {
  if (account.disabled) return '账号已停用';
  const text = `${account.statusText} ${account.error}`.toLowerCase();
  if (!text.trim()) return '-';
  if (text.includes('token_invalidated') || text.includes('authentication token has been invalidated')) {
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
      reason: account.status === 'limited' || account.limitReached ? '当前周期已受限' : '剩余额度不超过10%',
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

export const buildSoonRecoveringAccounts = (accounts: CodexQuotaAccount[], now = Date.now(), limit = 6) => {
  const threeDays = 3 * 24 * 60 * 60 * 1000;
  return accounts
    .filter((account) => {
      const resetAt = sortableResetTime(account.currentResetAt);
      return resetAt !== Number.MAX_SAFE_INTEGER && resetAt >= now && resetAt <= now + threeDays;
    })
    .sort((left, right) => sortableResetTime(left.currentResetAt) - sortableResetTime(right.currentResetAt))
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
