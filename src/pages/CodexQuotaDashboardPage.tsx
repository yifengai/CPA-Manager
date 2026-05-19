import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { IconRefreshCw, IconSearch, IconTrash2 } from '@/components/ui/icons';
import {
  buildAccountPoolBalance,
  buildTodayUsageSummary,
  buildTodayRestoredHistory,
  defaultAccountPoolBalanceSettings,
  formatAccountSurvivalDays,
  getAccountSurvivalBucketKey,
  getAccountSurvivalMs,
  getAccountListDisplay,
  getCodexQuotaBusinessStatus,
  getRecoveryDayBucketKey,
  type AccountPoolBalanceSettings,
  type AccountPoolBalanceScope,
  type CodexQuotaBusinessStatus,
  type RecoveryDayBucketKey,
  type SurvivalBucketKey,
  type TodayUsageSummary,
  type TodayRestoredAccount,
} from '@/features/codexQuota/dashboardState';
import { useUsageData } from '@/features/monitoring/hooks/useUsageData';
import { codexQuotaApi, type CodexQuotaAccount, type CodexQuotaResponse } from '@/services/api';
import { useAuthStore, useNotificationStore } from '@/stores';
import styles from './CodexQuotaDashboardPage.module.scss';

type StatusFilter = 'all' | CodexQuotaBusinessStatus;
type SwitchFilter = 'all' | 'enabled' | 'disabled';
type SortMode =
  | 'remaining-asc'
  | 'remaining-desc'
  | 'reset-asc'
  | 'survival-asc'
  | 'survival-desc'
  | 'account-asc';
type QuotaBucketKey = 'zero' | 'low' | 'mid' | 'healthy' | 'high' | 'full';
type QuickFilter =
  | 'all'
  | CodexQuotaBusinessStatus
  | 'enabled'
  | 'low'
  | 'recovering'
  | 'disabled'
  | `quota:${QuotaBucketKey}`
  | `recovery:${RecoveryDayBucketKey}`
  | `survival:${SurvivalBucketKey}`;

const quotaCacheKey = 'cpa-manager:codex-quota:last-snapshot:v1';
const todayRestoredHistoryCacheKey = 'cpa-manager:codex-quota:today-restored-history:v1';
const todayUsageSummaryCacheKey = 'cpa-manager:codex-quota:today-usage-summary:v1';

const statusOptions = [
  { value: 'all', label: '状态' },
  { value: 'callable', label: '可调用' },
  { value: 'limited', label: '受限' },
  { value: 'error', label: '异常' },
  { value: 'unknown', label: '未知' },
];

const sortOptions = [
  { value: 'remaining-asc', label: '剩余额度从低到高' },
  { value: 'remaining-desc', label: '剩余额度从高到低' },
  { value: 'reset-asc', label: '重置时间从近到远' },
  { value: 'survival-asc', label: '存活时间从短到长' },
  { value: 'survival-desc', label: '存活时间从长到短' },
  { value: 'account-asc', label: '账号名称 A-Z' },
];

const switchOptions = [
  { value: 'all', label: '开关' },
  { value: 'enabled', label: '启用' },
  { value: 'disabled', label: '停用' },
];

const recoveryBuckets: Array<{ key: RecoveryDayBucketKey; label: string }> = [
  { key: 'restored', label: '已重置' },
  { key: 'today', label: '今天' },
  { key: 'tomorrow', label: '明天' },
  { key: 'day2', label: '2天后' },
  { key: 'day3', label: '3天后' },
  { key: 'day4', label: '4天后' },
  { key: 'day5', label: '5天后' },
  { key: 'day6', label: '6天后' },
  { key: 'day7', label: '7天后' },
  { key: 'unknown', label: '未知' },
];

const quotaBucketDefinitions: Array<{ key: QuotaBucketKey; label: string }> = [
  { key: 'zero', label: '0%' },
  { key: 'low', label: '1-20%' },
  { key: 'mid', label: '21-50%' },
  { key: 'healthy', label: '51-80%' },
  { key: 'high', label: '81-90%' },
  { key: 'full', label: '91-100%' },
];

const survivalBuckets: Array<{ key: SurvivalBucketKey; label: string }> = [
  { key: 'lt1', label: '<1天' },
  { key: 'day1To3', label: '1-3天' },
  { key: 'day3To7', label: '3-7天' },
  { key: 'day7To14', label: '7-14天' },
  { key: 'day14Plus', label: '14天以上' },
  { key: 'unknown', label: '未知' },
];

const planLabel = (plan: string) => {
  const normalized = plan.trim().toLowerCase();
  if (!normalized) return '未知';
  if (normalized === 'free') return 'free';
  if (normalized === 'plus') return 'Plus 账号';
  if (normalized === 'pro') return 'Pro 账号';
  if (normalized === 'team') return 'Team 账号';
  return plan;
};

const planBadgeLabel = (plan: string) => plan.trim().toLowerCase() || '未知';

const percent = (value?: number | null) =>
  typeof value === 'number' && Number.isFinite(value) ? `${value}%` : '-';

const valueOrDash = (value?: string | number | null) =>
  value === undefined || value === null || value === '' ? '-' : String(value);

const formatCompactNumber = (value: number) => {
  if (!Number.isFinite(value)) return '-';
  if (Math.abs(value) >= 1_000_000) {
    return `${Math.round((value / 1_000_000) * 10) / 10}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${Math.round((value / 1_000) * 10) / 10}K`;
  }
  return String(Math.round(value));
};

const formatUsd = (value: number) =>
  Number.isFinite(value) ? `$${Number.isInteger(value) ? value : value.toFixed(1)}` : '-';

const formatPercentValue = (value: number) => {
  if (!Number.isFinite(value)) return '-';
  const normalized = Math.max(0, value);
  return `${normalized >= 99.95 ? Math.round(normalized) : normalized.toFixed(1)}%`;
};

const formatAverageLatency = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return '-';
  return `${(value / 1000).toFixed(1)}秒`;
};

const formatUsdPerMillionTokens = (cycleCostUsd: number, cycleTokens: number) => {
  if (!Number.isFinite(cycleCostUsd) || !Number.isFinite(cycleTokens) || cycleTokens <= 0) {
    return '-';
  }
  const value = (cycleCostUsd / cycleTokens) * 1_000_000;
  return `${formatUsd(value)}/1M Tokens`;
};

const sortTime = (value: string) => {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(value.replace(' ', 'T') + '+08:00');
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
};

const sortSurvivalTime = (left: CodexQuotaAccount, right: CodexQuotaAccount, desc = false) => {
  const leftValue = getAccountSurvivalMs(left.importedAt);
  const rightValue = getAccountSurvivalMs(right.importedAt);
  if (leftValue === null && rightValue === null) return left.account.localeCompare(right.account);
  if (leftValue === null) return 1;
  if (rightValue === null) return -1;
  if (leftValue === rightValue) return left.account.localeCompare(right.account);
  return desc ? rightValue - leftValue : leftValue - rightValue;
};

const remainingClass = (account: CodexQuotaAccount) => {
  const value = account.currentRemainingPercent;
  if (account.status === 'limited' || value === 0) return styles.remainingCritical;
  if (typeof value !== 'number') return styles.remainingUnknown;
  if (value <= 20) return styles.remainingLow;
  if (value >= 80) return styles.remainingGood;
  return styles.remainingNormal;
};

const quotaBucketKey = (account: CodexQuotaAccount): QuotaBucketKey | null => {
  const value = account.currentRemainingPercent;
  if (typeof value !== 'number') return null;
  if (value === 0) return 'zero';
  if (value <= 20) return 'low';
  if (value <= 50) return 'mid';
  if (value <= 80) return 'healthy';
  if (value <= 90) return 'high';
  return 'full';
};

const quickFilterLabel = (filter: QuickFilter) => {
  if (filter === 'all') return '全部账号';
  if (filter === 'callable') return '可调用账号';
  if (filter === 'enabled') return '启用账号';
  if (filter === 'limited') return '受限账号';
  if (filter === 'error') return '异常账号';
  if (filter === 'unknown') return '未知账号';
  if (filter === 'low') return '低余量账号';
  if (filter === 'recovering') return '即将重置';
  if (filter === 'disabled') return '已停用';
  if (filter.startsWith('quota:')) {
    const bucket = quotaBucketDefinitions.find((item) => filter === `quota:${item.key}`);
    return bucket ? `余量 ${bucket.label}` : '全部账号';
  }
  if (filter.startsWith('survival:')) {
    const bucket = survivalBuckets.find((item) => filter === `survival:${item.key}`);
    return bucket ? `存活 ${bucket.label}` : '全部账号';
  }
  const bucket = recoveryBuckets.find((item) => filter === `recovery:${item.key}`);
  return bucket ? bucket.label : '全部账号';
};

const matchesQuickFilter = (
  account: CodexQuotaAccount,
  filter: QuickFilter,
  todayRestoredFiles: Set<string> = new Set()
) => {
  if (filter === 'all') return true;
  if (filter === 'enabled') return !account.disabled && account.status !== 'disabled';
  if (filter === 'callable' || filter === 'limited' || filter === 'error' || filter === 'unknown') {
    return getCodexQuotaBusinessStatus(account) === filter;
  }
  if (filter === 'low') {
    return (
      typeof account.currentRemainingPercent === 'number' && account.currentRemainingPercent <= 20
    );
  }
  if (filter === 'recovering') {
    const bucket = getRecoveryDayBucketKey(account.currentResetAt);
    return bucket !== 'restored' && bucket !== 'later' && bucket !== 'unknown';
  }
  if (filter === 'disabled') return account.disabled || account.status === 'disabled';
  if (filter.startsWith('quota:')) return filter === `quota:${quotaBucketKey(account)}`;
  if (filter.startsWith('survival:')) {
    return filter === `survival:${getAccountSurvivalBucketKey(account.importedAt)}`;
  }
  if (filter === 'recovery:restored') {
    return (
      getRecoveryDayBucketKey(account.currentResetAt) === 'restored' ||
      todayRestoredFiles.has(account.file)
    );
  }
  return filter === `recovery:${getRecoveryDayBucketKey(account.currentResetAt)}`;
};

const buildClientSummary = (accounts: CodexQuotaAccount[]): CodexQuotaResponse['summary'] => {
  const buckets = [
    { label: '0%', count: 0 },
    { label: '1-20%', count: 0 },
    { label: '21-50%', count: 0 },
    { label: '51-80%', count: 0 },
    { label: '81-90%', count: 0 },
    { label: '91-100%', count: 0 },
  ];
  const values: number[] = [];
  const plans: Record<string, number> = {};
  const generatedAt = new Date()
    .toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    .replace(/\//g, '-');
  const summary: CodexQuotaResponse['summary'] = {
    generatedAt,
    total: accounts.length,
    available: 0,
    limited: 0,
    disabled: 0,
    errors: 0,
    low: 0,
    critical: 0,
    average: null,
    median: null,
    plans,
    buckets,
  };

  accounts.forEach((account) => {
    if (account.disabled) summary.disabled += 1;
    else if (account.status === 'available') summary.available += 1;
    else if (account.status === 'limited') summary.limited += 1;
    else if (account.status === 'disabled') summary.disabled += 1;
    else summary.errors += 1;

    if (account.plan) plans[account.plan] = (plans[account.plan] ?? 0) + 1;
    const value = account.currentRemainingPercent;
    if (typeof value !== 'number') return;
    values.push(value);
    if (value <= 10) summary.critical += 1;
    if (value <= 20) summary.low += 1;
    if (value === 0) buckets[0].count += 1;
    else if (value <= 20) buckets[1].count += 1;
    else if (value <= 50) buckets[2].count += 1;
    else if (value <= 80) buckets[3].count += 1;
    else if (value <= 90) buckets[4].count += 1;
    else buckets[5].count += 1;
  });

  if (values.length > 0) {
    values.sort((left, right) => left - right);
    const total = values.reduce((sum, value) => sum + value, 0);
    summary.average = Math.round((total / values.length) * 10) / 10;
    const middle = Math.floor(values.length / 2);
    summary.median =
      values.length % 2 === 1
        ? values[middle]
        : Math.round(((values[middle - 1] + values[middle]) / 2) * 10) / 10;
  }
  return summary;
};

const readCachedQuota = () => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(quotaCacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CodexQuotaResponse;
    if (!parsed || !Array.isArray(parsed.accounts) || !parsed.summary) return null;
    return parsed;
  } catch {
    return null;
  }
};

const writeCachedQuota = (payload: CodexQuotaResponse) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(quotaCacheKey, JSON.stringify(payload));
  } catch {
    // localStorage may be unavailable in private mode; the page still works without cache.
  }
};

const readCachedTodayRestoredHistory = () => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(todayRestoredHistoryCacheKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TodayRestoredAccount[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (record) =>
        record &&
        typeof record.file === 'string' &&
        typeof record.account === 'string' &&
        typeof record.restoredAt === 'string' &&
        typeof record.detectedAt === 'string' &&
        typeof record.resetAfter === 'string'
    );
  } catch {
    return [];
  }
};

const writeCachedTodayRestoredHistory = (payload: TodayRestoredAccount[]) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(todayRestoredHistoryCacheKey, JSON.stringify(payload));
  } catch {
    // localStorage may be unavailable in private mode; the page still works without history cache.
  }
};

const emptyTodayUsageSummary = (): TodayUsageSummary => ({
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
});

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const readCachedTodayUsageSummary = (): TodayUsageSummary => {
  if (typeof window === 'undefined') return emptyTodayUsageSummary();
  try {
    const raw = window.localStorage.getItem(todayUsageSummaryCacheKey);
    if (!raw) return emptyTodayUsageSummary();
    const parsed = JSON.parse(raw) as Partial<TodayUsageSummary>;
    if (!parsed || typeof parsed !== 'object') return emptyTodayUsageSummary();
    const fallback = emptyTodayUsageSummary();
    return {
      hasUsageData: parsed.hasUsageData === true,
      requestCount: isFiniteNumber(parsed.requestCount)
        ? parsed.requestCount
        : fallback.requestCount,
      successCount: isFiniteNumber(parsed.successCount)
        ? parsed.successCount
        : fallback.successCount,
      failedCount: isFiniteNumber(parsed.failedCount) ? parsed.failedCount : fallback.failedCount,
      accountCount: isFiniteNumber(parsed.accountCount)
        ? parsed.accountCount
        : fallback.accountCount,
      pricedRequestCount: isFiniteNumber(parsed.pricedRequestCount)
        ? parsed.pricedRequestCount
        : fallback.pricedRequestCount,
      successRate: isFiniteNumber(parsed.successRate) ? parsed.successRate : fallback.successRate,
      averageLatencyMs: isFiniteNumber(parsed.averageLatencyMs)
        ? parsed.averageLatencyMs
        : fallback.averageLatencyMs,
      totalTokens: isFiniteNumber(parsed.totalTokens) ? parsed.totalTokens : fallback.totalTokens,
      inputTokens: isFiniteNumber(parsed.inputTokens) ? parsed.inputTokens : fallback.inputTokens,
      outputTokens: isFiniteNumber(parsed.outputTokens)
        ? parsed.outputTokens
        : fallback.outputTokens,
      reasoningTokens: isFiniteNumber(parsed.reasoningTokens)
        ? parsed.reasoningTokens
        : fallback.reasoningTokens,
      cachedTokens: isFiniteNumber(parsed.cachedTokens)
        ? parsed.cachedTokens
        : fallback.cachedTokens,
      inputShare: isFiniteNumber(parsed.inputShare) ? parsed.inputShare : fallback.inputShare,
      outputShare: isFiniteNumber(parsed.outputShare) ? parsed.outputShare : fallback.outputShare,
      cacheHitRate: isFiniteNumber(parsed.cacheHitRate)
        ? parsed.cacheHitRate
        : fallback.cacheHitRate,
      estimatedCostUsd: isFiniteNumber(parsed.estimatedCostUsd)
        ? parsed.estimatedCostUsd
        : fallback.estimatedCostUsd,
    };
  } catch {
    return emptyTodayUsageSummary();
  }
};

const writeCachedTodayUsageSummary = (payload: TodayUsageSummary) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(todayUsageSummaryCacheKey, JSON.stringify(payload));
  } catch {
    // localStorage may be unavailable in private mode; the page still works without usage cache.
  }
};

export function CodexQuotaDashboardPage() {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const { usage, modelPrices, loadUsage } = useUsageData({ autoLoadUsage: true });

  const [data, setData] = useState<CodexQuotaResponse | null>(() => readCachedQuota());
  const [todayRestoredHistory, setTodayRestoredHistory] = useState<TodayRestoredAccount[]>(() =>
    readCachedTodayRestoredHistory()
  );
  const [todayUsageSummary, setTodayUsageSummary] = useState<TodayUsageSummary>(() =>
    readCachedTodayUsageSummary()
  );
  const [loading, setLoading] = useState(false);
  const [clearingFailedUsage, setClearingFailedUsage] = useState(false);
  const [actionFile, setActionFile] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [switchFilter, setSwitchFilter] = useState<SwitchFilter>('all');
  const [planFilter, setPlanFilter] = useState('all');
  const [sortMode, setSortMode] = useState<SortMode>('remaining-asc');
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all');
  const [poolScope, setPoolScope] = useState<AccountPoolBalanceScope>('available');
  const [poolSettings, setPoolSettings] = useState<AccountPoolBalanceSettings>(
    defaultAccountPoolBalanceSettings
  );
  const [lastRefreshAt, setLastRefreshAt] = useState(
    () => readCachedQuota()?.summary.generatedAt ?? ''
  );
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(() => new Set());
  const disabled = connectionStatus !== 'connected';
  const controlsDisabled = disabled || loading || actionFile !== null;

  const activateQuickFilter = useCallback((filter: QuickFilter) => {
    setQuickFilter(filter);
    setSearch('');
    setStatusFilter('all');
    setSwitchFilter('all');
    setPlanFilter('all');
    setSelectedFiles(new Set());
  }, []);

  useEffect(() => {
    if (disabled) return;
    let cancelled = false;
    codexQuotaApi
      .settings()
      .then((settings) => {
        if (cancelled) return;
        setPoolSettings({
          accountCycleTokens: settings.accountCycleTokens,
          accountCycleCostUsd: settings.accountCycleCostUsd,
          accountCycleCalls: settings.accountCycleCalls,
        });
      })
      .catch(() => {
        if (!cancelled) setPoolSettings(defaultAccountPoolBalanceSettings);
      });
    return () => {
      cancelled = true;
    };
  }, [disabled]);

  useEffect(() => {
    if (!usage) return;
    const nextTodayUsageSummary = buildTodayUsageSummary(usage, modelPrices);
    setTodayUsageSummary(nextTodayUsageSummary);
    writeCachedTodayUsageSummary(nextTodayUsageSummary);
  }, [modelPrices, usage]);

  const loadQuota = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [response, usagePayload] = await Promise.all([codexQuotaApi.list(), loadUsage()]);
      const nextHistory = buildTodayRestoredHistory({
        previousAccounts: data?.accounts ?? [],
        nextAccounts: response.accounts,
        existingHistory: todayRestoredHistory,
      });
      const nextTodayUsageSummary = buildTodayUsageSummary(usagePayload, modelPrices);
      setData(response);
      setTodayRestoredHistory(nextHistory);
      setTodayUsageSummary(nextTodayUsageSummary);
      writeCachedQuota(response);
      writeCachedTodayRestoredHistory(nextHistory);
      writeCachedTodayUsageSummary(nextTodayUsageSummary);
      setLastRefreshAt(response.summary.generatedAt);
      setSelectedFiles((previous) => {
        const existing = new Set(response.accounts.map((account) => account.file));
        const next = new Set<string>();
        previous.forEach((file) => {
          if (existing.has(file)) next.add(file);
        });
        return next;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '账号余量加载失败';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [data?.accounts, loadUsage, modelPrices, todayRestoredHistory]);

  const planOptions = useMemo(() => {
    const plans = new Set<string>();
    data?.accounts.forEach((account) => {
      plans.add(account.plan || '未知');
    });
    return [
      { value: 'all', label: '类型' },
      ...Array.from(plans)
        .sort((left, right) => left.localeCompare(right))
        .map((plan) => ({ value: plan, label: planLabel(plan) })),
    ];
  }, [data?.accounts]);

  const todayRestoredFiles = useMemo(() => {
    const files = new Set<string>();
    const existingFiles = new Set<string>();
    (data?.accounts ?? []).forEach((account) => {
      existingFiles.add(account.file);
      if (getRecoveryDayBucketKey(account.currentResetAt) === 'restored') files.add(account.file);
    });
    todayRestoredHistory.forEach((record) => {
      if (existingFiles.has(record.file)) files.add(record.file);
    });
    return files;
  }, [data?.accounts, todayRestoredHistory]);

  const todayRestoredRecords = useMemo(
    () => new Map(todayRestoredHistory.map((record) => [record.file, record])),
    [todayRestoredHistory]
  );

  const visibleAccounts = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = (data?.accounts ?? []).filter((account) => {
      if (!matchesQuickFilter(account, quickFilter, todayRestoredFiles)) return false;
      if (statusFilter !== 'all' && getCodexQuotaBusinessStatus(account) !== statusFilter) {
        return false;
      }
      if (switchFilter === 'enabled' && (account.disabled || account.status === 'disabled')) {
        return false;
      }
      if (switchFilter === 'disabled' && !account.disabled && account.status !== 'disabled') {
        return false;
      }
      if (planFilter !== 'all' && (account.plan || '未知') !== planFilter) return false;
      if (!query) return true;
      return [
        account.account,
        account.email,
        account.file,
        account.importedAt,
        formatAccountSurvivalDays(account.importedAt),
        account.statusText,
        account.plan,
        account.error,
      ]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });

    return filtered.sort((left, right) => {
      if (sortMode === 'remaining-desc') {
        return (right.currentRemainingPercent ?? -1) - (left.currentRemainingPercent ?? -1);
      }
      if (sortMode === 'reset-asc') {
        return sortTime(left.currentResetAt) - sortTime(right.currentResetAt);
      }
      if (sortMode === 'survival-asc') {
        return sortSurvivalTime(left, right);
      }
      if (sortMode === 'survival-desc') {
        return sortSurvivalTime(left, right, true);
      }
      if (sortMode === 'account-asc') {
        return left.account.localeCompare(right.account);
      }
      return (left.currentRemainingPercent ?? 999) - (right.currentRemainingPercent ?? 999);
    });
  }, [
    data?.accounts,
    planFilter,
    quickFilter,
    search,
    sortMode,
    statusFilter,
    switchFilter,
    todayRestoredFiles,
  ]);

  const recoverySummary = useMemo(() => {
    const initial: Record<RecoveryDayBucketKey, number> = {
      restored: 0,
      today: 0,
      tomorrow: 0,
      day2: 0,
      day3: 0,
      day4: 0,
      day5: 0,
      day6: 0,
      day7: 0,
      later: 0,
      unknown: 0,
    };
    (data?.accounts ?? []).forEach((account) => {
      initial[getRecoveryDayBucketKey(account.currentResetAt)] += 1;
    });
    initial.restored = todayRestoredFiles.size;
    return initial;
  }, [data?.accounts, todayRestoredFiles]);

  const selectedAccounts = useMemo(() => {
    if (!data || selectedFiles.size === 0) return [];
    return data.accounts.filter((account) => selectedFiles.has(account.file));
  }, [data, selectedFiles]);

  const visibleSelectableCount = visibleAccounts.length;
  const selectedVisibleCount = visibleAccounts.filter((account) =>
    selectedFiles.has(account.file)
  ).length;
  const allVisibleSelected =
    visibleSelectableCount > 0 && selectedVisibleCount === visibleSelectableCount;
  const selectedEnabledCount = selectedAccounts.filter((account) => !account.disabled).length;
  const selectedDisabledCount = selectedAccounts.filter((account) => account.disabled).length;

  const toggleSelected = (file: string) => {
    setSelectedFiles((previous) => {
      const next = new Set(previous);
      if (next.has(file)) {
        next.delete(file);
      } else {
        next.add(file);
      }
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelectedFiles((previous) => {
      const next = new Set(previous);
      if (allVisibleSelected) {
        visibleAccounts.forEach((account) => next.delete(account.file));
      } else {
        visibleAccounts.forEach((account) => next.add(account.file));
      }
      return next;
    });
  };

  const executeSetDisabled = async (
    targets: CodexQuotaAccount[],
    nextDisabled: boolean,
    successText: (count: number) => string
  ) => {
    if (targets.length === 0) {
      showNotification(nextDisabled ? '没有需要停用的账号' : '没有需要启用的账号', 'info');
      return;
    }
    setActionFile(targets.length === 1 ? (targets[0]?.file ?? '__batch__') : '__batch__');
    try {
      const results = await Promise.allSettled(
        targets.map((account) => codexQuotaApi.setDisabled(account.file, nextDisabled))
      );
      const failed = results.filter((result) => result.status === 'rejected').length;
      const success = results.length - failed;
      if (failed > 0) {
        showNotification(`操作完成：成功 ${success} 个，失败 ${failed} 个`, 'warning');
      } else {
        showNotification(successText(success), 'success');
      }
      await loadQuota();
    } finally {
      setActionFile(null);
    }
  };

  const handleSetDisabled = async (account: CodexQuotaAccount, nextDisabled: boolean) => {
    await executeSetDisabled([account], nextDisabled, () =>
      nextDisabled ? '账号已停用' : '账号已启用'
    );
  };

  const handleBatchSetDisabled = async (nextDisabled: boolean) => {
    const targets = selectedAccounts.filter((account) => account.disabled !== nextDisabled);
    if (targets.length === 0) {
      showNotification(
        nextDisabled ? '选中的账号已经是停用状态' : '选中的账号已经是启用状态',
        'info'
      );
      return;
    }
    await executeSetDisabled(targets, nextDisabled, (count) =>
      nextDisabled ? `已停用 ${count} 个账号` : `已启用 ${count} 个账号`
    );
  };

  const handleRefreshTargets = async (targets: CodexQuotaAccount[], actionKey: string) => {
    if (!data || targets.length === 0) {
      showNotification('请先选择要刷新的账号', 'info');
      return;
    }
    setActionFile(actionKey);
    setError('');
    try {
      const targetFiles = targets.map((account) => account.file);
      const response = await codexQuotaApi.refreshSelected(targetFiles);
      const refreshed = new Map(response.accounts.map((account) => [account.file, account]));
      const accounts = data.accounts.map((account) => refreshed.get(account.file) ?? account);
      const summary = buildClientSummary(accounts);
      summary.generatedAt = response.summary.generatedAt;
      const mergedPayload = { summary, accounts };
      const nextHistory = buildTodayRestoredHistory({
        previousAccounts: data.accounts,
        nextAccounts: accounts,
        existingHistory: todayRestoredHistory,
      });
      setData(mergedPayload);
      setTodayRestoredHistory(nextHistory);
      writeCachedQuota(mergedPayload);
      writeCachedTodayRestoredHistory(nextHistory);
      setLastRefreshAt(response.summary.generatedAt);
      setSelectedFiles((previous) => {
        const existing = new Set(accounts.map((account) => account.file));
        const next = new Set<string>();
        previous.forEach((file) => {
          if (existing.has(file)) next.add(file);
        });
        return next;
      });
      showNotification(`已刷新 ${response.accounts.length} 个账号`, 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : '刷新选中账号失败';
      showNotification(`刷新账号失败：${message}`, 'error');
    } finally {
      setActionFile(null);
    }
  };

  const handleRefreshSelected = async () => {
    await handleRefreshTargets(selectedAccounts, '__refresh_selected__');
  };

  const confirmDelete = (account: CodexQuotaAccount) => {
    showConfirmation({
      title: '删除账号文件',
      message: `确认删除 ${account.account}？文件会先归档到 /data/deleted-auths，便于后续恢复。`,
      confirmText: '删除',
      cancelText: '取消',
      variant: 'danger',
      onConfirm: async () => {
        setActionFile(account.file);
        try {
          await codexQuotaApi.deleteAccount(account.file);
          showNotification('账号文件已归档删除', 'success');
          await loadQuota();
        } catch (err) {
          const message = err instanceof Error ? err.message : '删除失败';
          showNotification(`删除失败：${message}`, 'error');
        } finally {
          setActionFile(null);
        }
      },
    });
  };

  const confirmBatchDelete = () => {
    const targets = [...selectedAccounts];
    if (targets.length === 0) return;
    showConfirmation({
      title: '批量删除账号文件',
      message: `确认删除选中的 ${targets.length} 个账号？文件会先归档到 /data/deleted-auths，便于后续恢复。`,
      confirmText: '批量删除',
      cancelText: '取消',
      variant: 'danger',
      onConfirm: async () => {
        setActionFile('__batch__');
        try {
          const results = await Promise.allSettled(
            targets.map((account) => codexQuotaApi.deleteAccount(account.file))
          );
          const failed = results.filter((result) => result.status === 'rejected').length;
          const success = results.length - failed;
          if (failed > 0) {
            showNotification(`批量删除完成：成功 ${success} 个，失败 ${failed} 个`, 'warning');
          } else {
            showNotification(`已归档删除 ${success} 个账号`, 'success');
          }
          await loadQuota();
        } finally {
          setActionFile(null);
        }
      },
    });
  };

  const confirmClearFailedUsage = () => {
    showConfirmation({
      title: '清除失败调用记录',
      message:
        '将删除 Usage Service 中所有失败调用记录，并从用量与消耗统计中移除这些失败记录。成功调用记录不会受影响。',
      confirmText: '清除',
      cancelText: '取消',
      variant: 'danger',
      onConfirm: async () => {
        setClearingFailedUsage(true);
        try {
          const result = await codexQuotaApi.clearFailedUsage();
          const usagePayload = await loadUsage();
          const nextTodayUsageSummary = buildTodayUsageSummary(usagePayload, modelPrices);
          setTodayUsageSummary(nextTodayUsageSummary);
          writeCachedTodayUsageSummary(nextTodayUsageSummary);
          showNotification(`已清除 ${result.deleted} 条失败调用记录`, 'success');
        } catch (err) {
          const message = err instanceof Error ? err.message : '清除失败';
          showNotification(`清除失败调用记录失败：${message}`, 'error');
        } finally {
          setClearingFailedUsage(false);
        }
      },
    });
  };

  const summary = data?.summary;
  const activeQuickFilterLabel = quickFilter === 'all' ? '' : quickFilterLabel(quickFilter);
  const businessStatusCounts = useMemo(() => {
    const counts: Record<CodexQuotaBusinessStatus, number> = {
      callable: 0,
      limited: 0,
      error: 0,
      unknown: 0,
    };
    (data?.accounts ?? []).forEach((account) => {
      counts[getCodexQuotaBusinessStatus(account)] += 1;
    });
    return counts;
  }, [data?.accounts]);
  const accountPoolBalance = useMemo(
    () => buildAccountPoolBalance(data?.accounts ?? [], poolScope, poolSettings),
    [data?.accounts, poolScope, poolSettings]
  );
  const averageTokensPerCall = poolSettings.accountCycleTokens / poolSettings.accountCycleCalls;
  const gpt55InputPriceText = formatUsdPerMillionTokens(
    poolSettings.accountCycleCostUsd,
    poolSettings.accountCycleTokens
  );
  const accountPoolRule = `计算规则：单账号满额按 ${formatCompactNumber(
    poolSettings.accountCycleTokens
  )} Tokens，等价价值按 GPT-5.5 输入价 ${gpt55InputPriceText} 折算，当前余量按账号剩余百分比累加。`;
  const quotaBucketCounts = useMemo(() => {
    const counts: Record<QuotaBucketKey, number> = {
      zero: 0,
      low: 0,
      mid: 0,
      healthy: 0,
      high: 0,
      full: 0,
    };
    (data?.accounts ?? []).forEach((account) => {
      const key = quotaBucketKey(account);
      if (key) counts[key] += 1;
    });
    return counts;
  }, [data?.accounts]);
  const survivalCounts = useMemo(() => {
    const counts: Record<SurvivalBucketKey, number> = {
      lt1: 0,
      day1To3: 0,
      day3To7: 0,
      day7To14: 0,
      day14Plus: 0,
      unknown: 0,
    };
    (data?.accounts ?? []).forEach((account) => {
      counts[getAccountSurvivalBucketKey(account.importedAt)] += 1;
    });
    return counts;
  }, [data?.accounts]);
  const quickViews: Array<{ filter: QuickFilter; label: string; count: number | string }> = [
    { filter: 'all', label: '全部', count: summary?.total ?? '-' },
    { filter: 'callable', label: '可调用', count: businessStatusCounts.callable },
    { filter: 'limited', label: '受限', count: businessStatusCounts.limited },
    { filter: 'error', label: '异常', count: businessStatusCounts.error },
    { filter: 'unknown', label: '未知', count: businessStatusCounts.unknown },
    {
      filter: 'enabled',
      label: '启用',
      count:
        data?.accounts.filter((account) => !account.disabled && account.status !== 'disabled')
          .length ?? '-',
    },
    {
      filter: 'disabled',
      label: '停用',
      count:
        data?.accounts.filter((account) => account.disabled || account.status === 'disabled')
          .length ?? '-',
    },
  ];
  const quotaBucketViews = quotaBucketDefinitions.map((definition) => ({
    filter: `quota:${definition.key}` as QuickFilter,
    label: definition.label,
    count: quotaBucketCounts[definition.key],
  }));
  const recoveryViews: Array<{ filter: QuickFilter; label: string; count: number }> =
    recoveryBuckets.map((bucket) => ({
      filter: `recovery:${bucket.key}`,
      label: bucket.label,
      count: recoverySummary[bucket.key],
    }));
  const survivalViews: Array<{ filter: QuickFilter; label: string; count: number }> =
    survivalBuckets.map((bucket) => ({
      filter: `survival:${bucket.key}`,
      label: bucket.label,
      count: survivalCounts[bucket.key],
    }));

  return (
    <div className={styles.container}>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Codex账号余量</h1>
          <p className={styles.description}>
            统一查看账号可用状态、当前周期剩余额度、重置时间，并直接启用、停用或归档删除账号。
          </p>
        </div>
        <div className={styles.refreshGroup}>
          <span className={styles.refreshTime}>当前刷新时间：{lastRefreshAt || '未刷新'}</span>
          <Button onClick={() => void loadQuota()} loading={loading} disabled={disabled} size="sm">
            <span>刷新余量</span>
          </Button>
          <Button
            onClick={confirmClearFailedUsage}
            loading={clearingFailedUsage}
            disabled={disabled || clearingFailedUsage}
            size="sm"
            variant="danger"
          >
            清除失败记录
          </Button>
        </div>
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      <section className={styles.accountPoolPanel}>
        <div className={styles.accountPoolHeader}>
          <div>
            <h2>账号池余量看板</h2>
            <span>{accountPoolRule}</span>
          </div>
          <div className={styles.scopeSwitch} aria-label="账号池统计范围">
            <button
              type="button"
              className={poolScope === 'available' ? styles.activeScopeButton : ''}
              aria-pressed={poolScope === 'available'}
              onClick={() => setPoolScope('available')}
            >
              当前可用池
            </button>
            <button
              type="button"
              className={poolScope === 'inventory' ? styles.activeScopeButton : ''}
              aria-pressed={poolScope === 'inventory'}
              onClick={() => setPoolScope('inventory')}
            >
              全部库存
            </button>
          </div>
        </div>
        <div className={styles.accountPoolMetrics}>
          <div className={styles.accountPoolMetricCard}>
            <span>{poolScope === 'available' ? '可调用账号' : '库存账号'}</span>
            <strong>{accountPoolBalance.accountCount}</strong>
            <small>{poolScope === 'available' ? '当前进入调用池' : '含停用账号'}</small>
          </div>
          <div className={`${styles.accountPoolMetricCard} ${styles.accountPoolMetricTokens}`}>
            <span>估算剩余 Tokens</span>
            <strong>{formatCompactNumber(accountPoolBalance.estimatedRemainingTokens)}</strong>
            <small>{accountPoolBalance.measurableAccounts} 个账号参与计算</small>
          </div>
          <div className={`${styles.accountPoolMetricCard} ${styles.accountPoolMetricCalls}`}>
            <span>预计可调用</span>
            <strong>{accountPoolBalance.estimatedCalls}</strong>
            <small>按平均 {formatCompactNumber(averageTokensPerCall)} Tokens/次换算</small>
          </div>
          <div className={`${styles.accountPoolMetricCard} ${styles.accountPoolMetricValue}`}>
            <span>等价价值</span>
            <strong>{formatUsd(accountPoolBalance.estimatedValueUsd)}</strong>
            <small>按 GPT-5.5 输入价 {gpt55InputPriceText} 换算</small>
          </div>
        </div>
        <div className={styles.todayUsagePanel}>
          <div className={styles.todayUsageHeader}>
            <h3>今日消耗</h3>
          </div>
          <div className={styles.todayUsageMetrics}>
            <div className={styles.accountPoolMetricCard}>
              <span>总调用</span>
              <strong>
                {todayUsageSummary.hasUsageData ? todayUsageSummary.requestCount : '-'}
              </strong>
              <small>
                {todayUsageSummary.hasUsageData ? `${todayUsageSummary.accountCount} 账号` : '-'}
              </small>
            </div>
            <div className={`${styles.accountPoolMetricCard} ${styles.accountPoolMetricSuccess}`}>
              <span>调用成功率</span>
              <strong>
                {todayUsageSummary.hasUsageData
                  ? formatPercentValue(todayUsageSummary.successRate)
                  : '-'}
              </strong>
              <small>
                {todayUsageSummary.hasUsageData
                  ? formatAverageLatency(todayUsageSummary.averageLatencyMs)
                  : '-'}
              </small>
            </div>
            <div className={`${styles.accountPoolMetricCard} ${styles.accountPoolMetricFailure}`}>
              <span>失败总数</span>
              <strong>
                {todayUsageSummary.hasUsageData ? todayUsageSummary.failedCount : '-'}
              </strong>
              <small>失败调用</small>
            </div>
            <div className={`${styles.accountPoolMetricCard} ${styles.accountPoolMetricCost}`}>
              <span>预估花费</span>
              <strong>
                {todayUsageSummary.hasUsageData
                  ? formatUsd(todayUsageSummary.estimatedCostUsd)
                  : '-'}
              </strong>
              <small>
                {todayUsageSummary.hasUsageData
                  ? `${todayUsageSummary.pricedRequestCount}/${todayUsageSummary.requestCount} 次可计价`
                  : '-'}
              </small>
            </div>
            <div className={`${styles.accountPoolMetricCard} ${styles.accountPoolMetricUsage}`}>
              <span>总 Tokens</span>
              <strong>
                {todayUsageSummary.hasUsageData
                  ? formatCompactNumber(todayUsageSummary.totalTokens)
                  : '-'}
              </strong>
              <small>
                推理 Tokens{' '}
                {todayUsageSummary.hasUsageData
                  ? formatCompactNumber(todayUsageSummary.reasoningTokens)
                  : '-'}
              </small>
            </div>
            <div className={`${styles.accountPoolMetricCard} ${styles.accountPoolMetricInput}`}>
              <span>输入 Tokens</span>
              <strong>
                {todayUsageSummary.hasUsageData
                  ? formatCompactNumber(todayUsageSummary.inputTokens)
                  : '-'}
              </strong>
              <small>
                占比{' '}
                {todayUsageSummary.hasUsageData
                  ? formatPercentValue(todayUsageSummary.inputShare)
                  : '-'}
              </small>
            </div>
            <div className={`${styles.accountPoolMetricCard} ${styles.accountPoolMetricOutput}`}>
              <span>输出 Tokens</span>
              <strong>
                {todayUsageSummary.hasUsageData
                  ? formatCompactNumber(todayUsageSummary.outputTokens)
                  : '-'}
              </strong>
              <small>
                占比{' '}
                {todayUsageSummary.hasUsageData
                  ? formatPercentValue(todayUsageSummary.outputShare)
                  : '-'}
              </small>
            </div>
            <div className={`${styles.accountPoolMetricCard} ${styles.accountPoolMetricCache}`}>
              <span>缓存 Tokens</span>
              <strong>
                {todayUsageSummary.hasUsageData
                  ? formatCompactNumber(todayUsageSummary.cachedTokens)
                  : '-'}
              </strong>
              <small>
                命中率{' '}
                {todayUsageSummary.hasUsageData
                  ? formatPercentValue(todayUsageSummary.cacheHitRate)
                  : '-'}
              </small>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.filterPanel}>
        <div className={styles.filterRow}>
          <h2>账号状态：</h2>
          <div className={styles.filterButtonGroup}>
            {quickViews.map((view) => (
              <button
                key={view.filter}
                type="button"
                className={quickFilter === view.filter ? styles.activeControlButton : ''}
                aria-pressed={quickFilter === view.filter}
                onClick={() => activateQuickFilter(view.filter)}
              >
                <span>{view.label}</span>
                <strong>{view.count}</strong>
              </button>
            ))}
          </div>
        </div>
        <div className={styles.filterRow}>
          <h2>余量分布：</h2>
          <div className={styles.filterButtonGroup}>
            {quotaBucketViews.map((bucket) => (
              <button
                key={bucket.filter}
                type="button"
                className={quickFilter === bucket.filter ? styles.activeControlButton : ''}
                aria-pressed={quickFilter === bucket.filter}
                onClick={() => activateQuickFilter(bucket.filter)}
              >
                <span>{bucket.label}</span>
                <strong>{bucket.count}</strong>
              </button>
            ))}
          </div>
        </div>
        <div className={styles.filterRow}>
          <h2>重置时间：</h2>
          <div className={styles.filterButtonGroup}>
            {recoveryViews.map((view) => (
              <button
                key={view.filter}
                type="button"
                className={quickFilter === view.filter ? styles.activeControlButton : ''}
                aria-pressed={quickFilter === view.filter}
                onClick={() => activateQuickFilter(view.filter)}
              >
                <span>{view.label}</span>
                <strong>{view.count}</strong>
              </button>
            ))}
          </div>
        </div>
        <div className={styles.filterRow}>
          <h2>存活周期：</h2>
          <div className={styles.filterButtonGroup}>
            {survivalViews.map((view) => (
              <button
                key={view.filter}
                type="button"
                className={quickFilter === view.filter ? styles.activeControlButton : ''}
                aria-pressed={quickFilter === view.filter}
                onClick={() => activateQuickFilter(view.filter)}
              >
                <span>{view.label}</span>
                <strong>{view.count}</strong>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.toolbar}>
        <Input
          aria-label="搜索账号"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="输入账号、邮箱、状态或错误原因"
          rightElement={<IconSearch size={16} />}
        />
        <div className={styles.toolbarControl}>
          <Select
            id="codex-quota-status"
            ariaLabel="状态"
            triggerClassName={styles.toolbarSelectTrigger}
            value={statusFilter}
            options={statusOptions}
            onChange={(value) => setStatusFilter(value as StatusFilter)}
          />
        </div>
        <div className={styles.toolbarControl}>
          <Select
            id="codex-quota-switch"
            ariaLabel="开关状态"
            triggerClassName={styles.toolbarSelectTrigger}
            value={switchFilter}
            options={switchOptions}
            onChange={(value) => setSwitchFilter(value as SwitchFilter)}
          />
        </div>
        <div className={styles.toolbarControl}>
          <Select
            id="codex-quota-plan"
            ariaLabel="账号类型"
            triggerClassName={styles.toolbarSelectTrigger}
            value={planFilter}
            options={planOptions}
            onChange={setPlanFilter}
          />
        </div>
        <div className={styles.toolbarControl}>
          <Select
            id="codex-quota-sort"
            ariaLabel="排序"
            triggerClassName={styles.toolbarSelectTrigger}
            value={sortMode}
            options={sortOptions}
            onChange={(value) => setSortMode(value as SortMode)}
          />
        </div>
      </section>

      <section className={styles.tablePanel}>
        <div className={styles.tableHeader}>
          <div>
            <h2>账号列表</h2>
            <span>
              显示 {visibleAccounts.length} / {data?.accounts.length ?? 0} 个账号
              {activeQuickFilterLabel ? ` · 当前面板筛选：${activeQuickFilterLabel}` : ''}
            </span>
          </div>
          <div className={styles.batchActions}>
            <span>已选 {selectedFiles.size} 个</span>
            <Button
              size="sm"
              variant="secondary"
              disabled={controlsDisabled || selectedFiles.size === 0}
              loading={actionFile === '__refresh_selected__'}
              onClick={() => void handleRefreshSelected()}
            >
              <IconRefreshCw size={14} />
              <span>刷新已选</span>
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={controlsDisabled || selectedDisabledCount === 0}
              onClick={() => void handleBatchSetDisabled(false)}
            >
              批量启用
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={controlsDisabled || selectedEnabledCount === 0}
              onClick={() => void handleBatchSetDisabled(true)}
            >
              批量停用
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={controlsDisabled || selectedFiles.size === 0}
              onClick={confirmBatchDelete}
            >
              批量删除
            </Button>
          </div>
        </div>
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th className={styles.selectColumn}>
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    disabled={visibleAccounts.length === 0 || controlsDisabled}
                    aria-label="选择当前列表账号"
                    onChange={toggleAllVisible}
                  />
                </th>
                <th>账号与状态</th>
                <th>当前周期</th>
                <th>重置时间</th>
                <th>导入时间</th>
                <th>存活</th>
                <th>凭证与刷新</th>
                <th className={styles.actionsColumn}>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                <tr>
                  <td colSpan={8} className={styles.emptyCell}>
                    正在加载账号余量...
                  </td>
                </tr>
              ) : !data ? (
                <tr>
                  <td colSpan={8} className={styles.emptyCell}>
                    点击“刷新余量”开始查询账号状态
                  </td>
                </tr>
              ) : visibleAccounts.length === 0 ? (
                <tr>
                  <td colSpan={8} className={styles.emptyCell}>
                    没有匹配的账号
                  </td>
                </tr>
              ) : (
                visibleAccounts.map((account) => {
                  const accountDisplay = getAccountListDisplay(account);
                  const restoredRecord = todayRestoredRecords.get(account.file);
                  return (
                    <tr key={account.file}>
                      <td className={styles.selectColumn}>
                        <input
                          type="checkbox"
                          checked={selectedFiles.has(account.file)}
                          disabled={controlsDisabled}
                          aria-label={`选择 ${account.account}`}
                          onChange={() => toggleSelected(account.file)}
                        />
                      </td>
                      <td>
                        <div className={styles.accountCell}>
                          <div className={styles.accountTitleRow}>
                            <div className={styles.accountIdentity}>
                              <span className={styles.planBadge}>
                                {planBadgeLabel(account.plan)}
                              </span>
                              <strong>{account.account}</strong>
                            </div>
                            <span
                              className={`${styles.accountSwitchPill} ${styles[`switch_${accountDisplay.switchTone}`]}`}
                            >
                              {accountDisplay.switchLabel}
                            </span>
                          </div>
                          <div className={styles.accountMetaRow}>
                            <span
                              className={`${styles.businessPill} ${styles[`business_${accountDisplay.businessTone}`]}`}
                            >
                              {accountDisplay.businessLabel}
                            </span>
                            {accountDisplay.reason ? <small>{accountDisplay.reason}</small> : null}
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className={styles.metricStack}>
                          <div className={styles.metricPrimaryRow}>
                            <span className={`${styles.remainingPill} ${remainingClass(account)}`}>
                              剩余 {percent(account.currentRemainingPercent)}
                            </span>
                            <small>已用 {percent(account.currentUsedPercent)}</small>
                          </div>
                          <div className={styles.quotaProgressTrack}>
                            <span
                              className={styles.quotaProgressBar}
                              style={{
                                width:
                                  typeof account.currentRemainingPercent === 'number'
                                    ? `${Math.max(0, Math.min(100, account.currentRemainingPercent))}%`
                                    : '0%',
                              }}
                            />
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className={styles.metricStack}>
                          <span>{valueOrDash(account.currentResetAt)}</span>
                          {restoredRecord ? (
                            <small>
                              今日已重置 {restoredRecord.restoredAt}，新周期{' '}
                              {restoredRecord.resetAfter}
                            </small>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <div className={styles.metricStack}>
                          <span>{valueOrDash(account.importedAt)}</span>
                        </div>
                      </td>
                      <td>
                        <div className={styles.metricStack}>
                          <span>{formatAccountSurvivalDays(account.importedAt)}</span>
                        </div>
                      </td>
                      <td>
                        <div className={styles.metricStack}>
                          <span>过期 {valueOrDash(account.tokenExpiredAt)}</span>
                          <small>刷新 {valueOrDash(account.lastRefreshAt)}</small>
                        </div>
                      </td>
                      <td className={styles.actionsColumn}>
                        <div className={styles.actions}>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={controlsDisabled}
                            loading={actionFile === `refresh:${account.file}`}
                            onClick={() =>
                              void handleRefreshTargets([account], `refresh:${account.file}`)
                            }
                            title="刷新这个账号"
                          >
                            <IconRefreshCw size={14} />
                          </Button>
                          <Button
                            size="sm"
                            variant={account.disabled ? 'primary' : 'secondary'}
                            disabled={controlsDisabled}
                            loading={actionFile === account.file}
                            onClick={() => void handleSetDisabled(account, !account.disabled)}
                          >
                            {account.disabled ? '启用' : '停用'}
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={controlsDisabled}
                            onClick={() => confirmDelete(account)}
                            title="归档删除"
                          >
                            <IconTrash2 size={14} />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
