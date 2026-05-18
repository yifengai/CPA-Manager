import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { IconRefreshCw, IconSearch, IconTrash2 } from '@/components/ui/icons';
import {
  buildRefreshReport,
  buildSoonRecoveringAccounts,
  getAccountHealth,
  normalizeQuotaErrorReason,
  type RefreshReport,
} from '@/features/codexQuota/dashboardState';
import { codexQuotaApi, type CodexQuotaAccount, type CodexQuotaResponse } from '@/services/api';
import { useAuthStore, useNotificationStore } from '@/stores';
import styles from './CodexQuotaDashboardPage.module.scss';

type StatusFilter = 'all' | 'available' | 'limited' | 'disabled' | 'error';
type SortMode = 'remaining-asc' | 'remaining-desc' | 'reset-asc' | 'account-asc';
type RiskGroupKey = 'needsAction' | 'low' | 'normal' | 'disabled';
type RecoveryBucketKey = 'hour' | 'today' | 'tomorrow' | 'soon' | 'later' | 'unknown';
type QuickFilter =
  | 'all'
  | 'action'
  | 'available'
  | 'limited'
  | 'error'
  | 'low'
  | 'recovering'
  | 'disabled'
  | `recovery:${RecoveryBucketKey}`;

const quotaCacheKey = 'cpa-manager:codex-quota:last-snapshot:v1';

const statusOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'available', label: '可用' },
  { value: 'limited', label: '受限' },
  { value: 'disabled', label: '已停用' },
  { value: 'error', label: '失败/不可用' },
];

const sortOptions = [
  { value: 'remaining-asc', label: '剩余额度从低到高' },
  { value: 'remaining-desc', label: '剩余额度从高到低' },
  { value: 'reset-asc', label: '恢复时间从近到远' },
  { value: 'account-asc', label: '账号名称 A-Z' },
];

const recoveryBuckets: Array<{ key: RecoveryBucketKey; label: string }> = [
  { key: 'hour', label: '1小时内恢复' },
  { key: 'today', label: '今天恢复' },
  { key: 'tomorrow', label: '明天恢复' },
  { key: 'soon', label: '3天内恢复' },
  { key: 'later', label: '超过3天' },
  { key: 'unknown', label: '未知/不适用' },
];

const planLabel = (plan: string) => {
  const normalized = plan.trim().toLowerCase();
  if (!normalized) return '未知';
  if (normalized === 'free') return 'Free 免费账号';
  if (normalized === 'plus') return 'Plus 账号';
  if (normalized === 'pro') return 'Pro 账号';
  if (normalized === 'team') return 'Team 账号';
  return plan;
};

const percent = (value?: number | null) =>
  typeof value === 'number' && Number.isFinite(value) ? `${value}%` : '-';

const valueOrDash = (value?: string | number | null) =>
  value === undefined || value === null || value === '' ? '-' : String(value);

const sortTime = (value: string) => {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(value.replace(' ', 'T') + '+08:00');
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
};

const statusClass = (status: string) => {
  if (status === 'available') return styles.statusAvailable;
  if (status === 'limited') return styles.statusLimited;
  if (status === 'disabled') return styles.statusDisabled;
  return styles.statusError;
};

const remainingClass = (account: CodexQuotaAccount) => {
  const value = account.currentRemainingPercent;
  if (account.status === 'limited' || value === 0) return styles.remainingCritical;
  if (typeof value !== 'number') return styles.remainingUnknown;
  if (value <= 20) return styles.remainingLow;
  if (value >= 80) return styles.remainingGood;
  return styles.remainingNormal;
};

const riskGroupKey = (account: CodexQuotaAccount): RiskGroupKey => {
  if (account.disabled || account.status === 'disabled') return 'disabled';
  const remaining = account.currentRemainingPercent;
  if (
    account.status === 'error' ||
    account.status === 'limited' ||
    account.limitReached ||
    (typeof remaining === 'number' && remaining <= 10)
  ) {
    return 'needsAction';
  }
  if (typeof remaining === 'number' && remaining <= 20) return 'low';
  return 'normal';
};

const recoveryBucketKey = (account: CodexQuotaAccount): RecoveryBucketKey => {
  const resetAt = sortTime(account.currentResetAt);
  if (resetAt === Number.MAX_SAFE_INTEGER) return 'unknown';
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  const oneDay = 24 * oneHour;
  if (resetAt <= now + oneHour) return 'hour';
  if (resetAt <= now + oneDay) return 'today';
  if (resetAt <= now + 2 * oneDay) return 'tomorrow';
  if (resetAt > now + 3 * oneDay) return 'later';
  return 'soon';
};

const previewAccountNames = (accounts: CodexQuotaAccount[]) =>
  accounts
    .slice(0, 8)
    .map((account) => account.account)
    .join('、');

const quickFilterLabel = (filter: QuickFilter) => {
  if (filter === 'all') return '全部账号';
  if (filter === 'action') return '只看异常';
  if (filter === 'available') return '可用账号';
  if (filter === 'limited') return '受限账号';
  if (filter === 'error') return '失败/不可用';
  if (filter === 'low') return '低余量账号';
  if (filter === 'recovering') return '即将恢复';
  if (filter === 'disabled') return '已停用';
  const bucket = recoveryBuckets.find((item) => filter === `recovery:${item.key}`);
  return bucket ? bucket.label : '全部账号';
};

const matchesQuickFilter = (account: CodexQuotaAccount, filter: QuickFilter) => {
  if (filter === 'all') return true;
  if (filter === 'action') return getAccountHealth(account).tone === 'danger';
  if (filter === 'available') return account.status === 'available';
  if (filter === 'limited') return account.status === 'limited';
  if (filter === 'error') return account.status === 'error';
  if (filter === 'low') {
    return typeof account.currentRemainingPercent === 'number' && account.currentRemainingPercent <= 20;
  }
  if (filter === 'recovering') {
    const bucket = recoveryBucketKey(account);
    return bucket === 'hour' || bucket === 'today' || bucket === 'tomorrow' || bucket === 'soon';
  }
  if (filter === 'disabled') return account.disabled || account.status === 'disabled';
  return filter === `recovery:${recoveryBucketKey(account)}`;
};

const buildClientSummary = (accounts: CodexQuotaAccount[]): CodexQuotaResponse['summary'] => {
  const buckets = [
    { label: '0%', count: 0 },
    { label: '1-20%', count: 0 },
    { label: '21-50%', count: 0 },
    { label: '51-80%', count: 0 },
    { label: '81-100%', count: 0 },
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
    if (account.status === 'available') summary.available += 1;
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
    else buckets[4].count += 1;
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

export function CodexQuotaDashboardPage() {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);

  const [data, setData] = useState<CodexQuotaResponse | null>(() => readCachedQuota());
  const [loading, setLoading] = useState(false);
  const [actionFile, setActionFile] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [planFilter, setPlanFilter] = useState('all');
  const [sortMode, setSortMode] = useState<SortMode>('remaining-asc');
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all');
  const [lastRefreshAt, setLastRefreshAt] = useState(() => readCachedQuota()?.summary.generatedAt ?? '');
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(() => new Set());
  const [refreshReport, setRefreshReport] = useState<RefreshReport | null>(null);
  const [healthHeroVisible, setHealthHeroVisible] = useState(true);
  const disabled = connectionStatus !== 'connected';
  const controlsDisabled = disabled || loading || actionFile !== null;

  const activateQuickFilter = useCallback((filter: QuickFilter) => {
    setQuickFilter(filter);
    setSearch('');
    setStatusFilter('all');
    setPlanFilter('all');
    setSelectedFiles(new Set());
  }, []);

  const loadQuota = useCallback(async () => {
    setLoading(true);
    setError('');
    const startedAt = performance.now();
    try {
      const response = await codexQuotaApi.list();
      setData(response);
      writeCachedQuota(response);
      setLastRefreshAt(response.summary.generatedAt);
      setRefreshReport(
        buildRefreshReport({
          requestedCount: response.accounts.length,
          refreshedAccounts: response.accounts,
          startedAt,
          endedAt: performance.now(),
        })
      );
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
  }, []);

  const planOptions = useMemo(() => {
    const plans = new Set<string>();
    data?.accounts.forEach((account) => {
      plans.add(account.plan || '未知');
    });
    return [
      { value: 'all', label: '全部账号类型' },
      ...Array.from(plans)
        .sort((left, right) => left.localeCompare(right))
        .map((plan) => ({ value: plan, label: planLabel(plan) })),
    ];
  }, [data?.accounts]);

  const visibleAccounts = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = (data?.accounts ?? []).filter((account) => {
      if (!matchesQuickFilter(account, quickFilter)) return false;
      if (statusFilter !== 'all' && account.status !== statusFilter) return false;
      if (planFilter !== 'all' && (account.plan || '未知') !== planFilter) return false;
      if (!query) return true;
      return [
        account.account,
        account.email,
        account.file,
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
      if (sortMode === 'account-asc') {
        return left.account.localeCompare(right.account);
      }
      return (left.currentRemainingPercent ?? 999) - (right.currentRemainingPercent ?? 999);
    });
  }, [data?.accounts, planFilter, quickFilter, search, sortMode, statusFilter]);

  const groupedVisibleAccounts = useMemo(() => {
    const groups: Array<{
      key: RiskGroupKey;
      title: string;
      description: string;
      accounts: CodexQuotaAccount[];
    }> = [
      { key: 'needsAction', title: '需要处理', description: '受限、失败、Token异常或剩余不超过 10%', accounts: [] },
      { key: 'low', title: '低余量观察', description: '剩余额度 11%-20%，建议减少分配', accounts: [] },
      { key: 'normal', title: '正常可用', description: '适合优先承接任务', accounts: [] },
      { key: 'disabled', title: '已停用', description: '不会进入调用池', accounts: [] },
    ];
    const groupMap = new Map(groups.map((group) => [group.key, group]));
    visibleAccounts.forEach((account) => {
      groupMap.get(riskGroupKey(account))?.accounts.push(account);
    });
    return groups.filter((group) => group.accounts.length > 0);
  }, [visibleAccounts]);

  const recoverySummary = useMemo(() => {
    const initial = { hour: 0, today: 0, tomorrow: 0, soon: 0, later: 0, unknown: 0 };
    (data?.accounts ?? []).forEach((account) => {
      initial[recoveryBucketKey(account)] += 1;
    });
    return initial;
  }, [data?.accounts]);

  const suggestedTargets = useMemo(() => {
    const accounts = data?.accounts ?? [];
    return {
      limited: accounts.filter((account) => !account.disabled && account.status === 'limited'),
      critical: accounts.filter(
        (account) =>
          !account.disabled &&
          typeof account.currentRemainingPercent === 'number' &&
          account.currentRemainingPercent <= 10
      ),
      disabled: accounts.filter((account) => account.disabled),
      tokenInvalid: accounts.filter((account) => normalizeQuotaErrorReason(account).includes('Token')),
    };
  }, [data?.accounts]);

  const soonRecoveringAccounts = useMemo(
    () => buildSoonRecoveringAccounts(data?.accounts ?? []),
    [data?.accounts]
  );

  const healthCounts = useMemo(() => {
    const counts = { good: 0, watch: 0, danger: 0, disabled: 0 };
    (data?.accounts ?? []).forEach((account) => {
      counts[getAccountHealth(account).tone] += 1;
    });
    return counts;
  }, [data?.accounts]);

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
    setActionFile(targets.length === 1 ? targets[0]?.file ?? '__batch__' : '__batch__');
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
    await executeSetDisabled([account], nextDisabled, () => (nextDisabled ? '账号已停用' : '账号已启用'));
  };

  const handleBatchSetDisabled = async (nextDisabled: boolean) => {
    const targets = selectedAccounts.filter((account) => account.disabled !== nextDisabled);
    if (targets.length === 0) {
      showNotification(nextDisabled ? '选中的账号已经是停用状态' : '选中的账号已经是启用状态', 'info');
      return;
    }
    await executeSetDisabled(
      targets,
      nextDisabled,
      (count) => (nextDisabled ? `已停用 ${count} 个账号` : `已启用 ${count} 个账号`)
    );
  };

  const handleRefreshTargets = async (targets: CodexQuotaAccount[], actionKey: string) => {
    if (!data || targets.length === 0) {
      showNotification('请先选择要刷新的账号', 'info');
      return;
    }
    const startedAt = performance.now();
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
      setData(mergedPayload);
      writeCachedQuota(mergedPayload);
      setLastRefreshAt(response.summary.generatedAt);
      setRefreshReport(
        buildRefreshReport({
          requestedCount: targetFiles.length,
          refreshedAccounts: response.accounts,
          startedAt,
          endedAt: performance.now(),
        })
      );
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

  const confirmSuggestedSetDisabled = (
    title: string,
    targets: CodexQuotaAccount[],
    nextDisabled: boolean,
    successText: (count: number) => string
  ) => {
    if (targets.length === 0) {
      showNotification('没有符合条件的账号', 'info');
      return;
    }
    showConfirmation({
      title,
      message: (
        <div className={styles.confirmPreview}>
          <p>将影响 {targets.length} 个账号。</p>
          <p>{previewAccountNames(targets)}{targets.length > 8 ? ` 等 ${targets.length} 个` : ''}</p>
        </div>
      ),
      confirmText: nextDisabled ? '确认停用' : '确认启用',
      cancelText: '取消',
      variant: nextDisabled ? 'danger' : 'primary',
      onConfirm: () => executeSetDisabled(targets, nextDisabled, successText),
    });
  };

  const confirmSuggestedDelete = (targets: CodexQuotaAccount[]) => {
    if (targets.length === 0) {
      showNotification('没有符合条件的账号', 'info');
      return;
    }
    showConfirmation({
      title: '删除 Token 失效账号',
      message: (
        <div className={styles.confirmPreview}>
          <p>将归档删除 {targets.length} 个账号文件。</p>
          <p>{previewAccountNames(targets)}{targets.length > 8 ? ` 等 ${targets.length} 个` : ''}</p>
        </div>
      ),
      confirmText: '确认删除',
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
          showNotification(
            failed > 0 ? `归档删除完成：成功 ${success} 个，失败 ${failed} 个` : `已归档删除 ${success} 个账号`,
            failed > 0 ? 'warning' : 'success'
          );
          await loadQuota();
        } finally {
          setActionFile(null);
        }
      },
    });
  };

  const summary = data?.summary;
  const activeQuickFilterLabel = quickFilter === 'all' ? '' : quickFilterLabel(quickFilter);
  const availableRate =
    summary && summary.total > 0 ? Math.round((summary.available / summary.total) * 100) : null;
  const healthHeadline = !summary
    ? '等待刷新账号池'
    : healthCounts.danger > 0
      ? `有 ${healthCounts.danger} 个账号需要处理`
      : healthCounts.watch > 0
        ? `有 ${healthCounts.watch} 个账号需要观察`
        : '账号池状态健康';
  const healthDescription = !summary
    ? '点击刷新余量后，这里会汇总可用率、异常账号和即将恢复账号。'
    : `可用率 ${availableRate ?? 0}% · 健康 ${healthCounts.good} 个 · 观察 ${healthCounts.watch} 个 · 已停用 ${healthCounts.disabled} 个`;
  const quickViews: Array<{ filter: QuickFilter; label: string; count: number | string }> = [
    { filter: 'all', label: '全部', count: summary?.total ?? '-' },
    { filter: 'action', label: '只看异常', count: healthCounts.danger },
    { filter: 'low', label: '低余量', count: summary?.low ?? '-' },
    { filter: 'recovering', label: '即将恢复', count: soonRecoveringAccounts.length },
    { filter: 'disabled', label: '已停用', count: summary?.disabled ?? '-' },
  ];

  const summaryCards: Array<{
    key: string;
    label: string;
    value: string | number;
    meta: string;
    filter?: QuickFilter;
  }> = [
    { key: 'total', label: '账号总数', value: summary?.total ?? '-', meta: '本次纳入统计', filter: 'all' },
    { key: 'available', label: '可用账号', value: summary?.available ?? '-', meta: '可继续调用', filter: 'available' },
    { key: 'limited', label: '受限账号', value: summary?.limited ?? '-', meta: '建议暂停使用', filter: 'limited' },
    { key: 'error', label: '失败/不可用', value: summary?.errors ?? '-', meta: '优先检查 Token', filter: 'error' },
    { key: 'low', label: '低余量账号', value: summary?.low ?? '-', meta: '剩余 20% 及以下', filter: 'low' },
    {
      key: 'average',
      label: '平均剩余额度',
      value: typeof summary?.average === 'number' ? `${summary.average}%` : '-',
      meta: `中位数 ${typeof summary?.median === 'number' ? `${summary.median}%` : '-'}`,
    },
  ];

  return (
    <div className={styles.container}>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Codex账号余量</h1>
          <p className={styles.description}>
            统一查看账号可用状态、当前周期剩余额度、恢复时间，并直接启用、停用或归档删除账号。
          </p>
        </div>
        <div className={styles.refreshGroup}>
          <span className={styles.refreshTime}>当前刷新时间：{lastRefreshAt || '未刷新'}</span>
          <Button onClick={() => void loadQuota()} loading={loading} disabled={disabled} size="sm">
            <IconRefreshCw size={16} />
            <span>刷新余量</span>
          </Button>
        </div>
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      {healthHeroVisible ? (
        <section className={styles.healthHero}>
          <button
            type="button"
            className={styles.healthHeroClose}
            aria-label="关闭账号池健康概览"
            title="关闭"
            onClick={() => setHealthHeroVisible(false)}
          >
            ×
          </button>
          <div className={styles.healthHeroMain}>
            <span className={styles.kicker}>账号池健康</span>
            <strong>{healthHeadline}</strong>
            <small>{healthDescription}</small>
          </div>
          <div className={styles.healthHeroMetrics}>
            <div>
              <span>可用率</span>
              <strong>{availableRate === null ? '-' : `${availableRate}%`}</strong>
            </div>
            <div>
              <span>需处理</span>
              <strong>{healthCounts.danger}</strong>
            </div>
            <div>
              <span>即将恢复</span>
              <strong>{soonRecoveringAccounts.length}</strong>
            </div>
          </div>
          {refreshReport ? (
            <div className={styles.refreshReport}>
              <span>最近刷新结果</span>
              <strong>
                成功 {refreshReport.availableCount} · 受限 {refreshReport.limitedCount} · 失败{' '}
                {refreshReport.errorCount}
              </strong>
              <small>
                请求 {refreshReport.requestedCount} 个，返回 {refreshReport.refreshedCount} 个，用时{' '}
                {refreshReport.durationText}
                {refreshReport.tokenInvalidCount > 0 ? `，Token失效 ${refreshReport.tokenInvalidCount} 个` : ''}
              </small>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className={styles.summaryGrid} aria-label="账号余量总览">
        {summaryCards.map((card) =>
          card.filter ? (
            <button
              key={card.key}
              type="button"
              className={[
                styles.summaryCard,
                styles.clickableCard,
                quickFilter === card.filter ? styles.activeCard : '',
              ].filter(Boolean).join(' ')}
              aria-pressed={quickFilter === card.filter}
              onClick={() => {
                if (card.filter) activateQuickFilter(card.filter);
              }}
            >
              <span>{card.label}</span>
              <strong>{card.value}</strong>
              <small>{card.meta}</small>
            </button>
          ) : (
            <div className={styles.summaryCard} key={card.key}>
              <span>{card.label}</span>
              <strong>{card.value}</strong>
              <small>{card.meta}</small>
            </div>
          )
        )}
      </section>

      <section className={styles.insightGrid}>
        <div className={styles.panel}>
          <h2>当前周期余量分布</h2>
          <div className={styles.bucketList}>
            {(summary?.buckets ?? []).map((bucket) => {
              const max = Math.max(...(summary?.buckets ?? []).map((item) => item.count), 1);
              return (
                <div className={styles.bucketRow} key={bucket.label}>
                  <span>{bucket.label}</span>
                  <div className={styles.bucketTrack}>
                    <div
                      className={styles.bucketFill}
                      style={{ width: `${(bucket.count / max) * 100}%` }}
                    />
                  </div>
                  <strong>{bucket.count}</strong>
                </div>
              );
            })}
          </div>
        </div>
        <div className={styles.panel}>
          <h2>恢复时间看板</h2>
          <div className={styles.recoveryGrid}>
            {recoveryBuckets.map((bucket) => {
              const filter: QuickFilter = `recovery:${bucket.key}`;
              return (
                <button
                  key={bucket.key}
                  type="button"
                  className={[
                    styles.recoveryCard,
                    quickFilter === filter ? styles.activeCard : '',
                  ].filter(Boolean).join(' ')}
                  aria-pressed={quickFilter === filter}
                  onClick={() => activateQuickFilter(filter)}
                >
                  <strong>{recoverySummary[bucket.key]}</strong>
                  <span>{bucket.label}</span>
                </button>
              );
            })}
          </div>
          {soonRecoveringAccounts.length > 0 ? (
            <button
              type="button"
              className={styles.recoveryShortcut}
              onClick={() => {
                activateQuickFilter('recovering');
                setSortMode('reset-asc');
              }}
            >
              按最早恢复查看 {soonRecoveringAccounts.length} 个账号
            </button>
          ) : null}
        </div>
        <div className={styles.panel}>
          <h2>一键建议操作</h2>
          <div className={styles.quickActions}>
            <Button
              size="sm"
              variant="secondary"
              disabled={controlsDisabled || suggestedTargets.limited.length === 0}
              onClick={() =>
                confirmSuggestedSetDisabled(
                  '停用所有受限账号',
                  suggestedTargets.limited,
                  true,
                  (count) => `已停用 ${count} 个受限账号`
                )
              }
            >
              停用受限账号（{suggestedTargets.limited.length}）
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={controlsDisabled || suggestedTargets.critical.length === 0}
              onClick={() =>
                confirmSuggestedSetDisabled(
                  '停用低于 10% 账号',
                  suggestedTargets.critical,
                  true,
                  (count) => `已停用 ${count} 个低余量账号`
                )
              }
            >
              停用低于10%（{suggestedTargets.critical.length}）
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={controlsDisabled || suggestedTargets.disabled.length === 0}
              onClick={() =>
                confirmSuggestedSetDisabled(
                  '启用已停用账号',
                  suggestedTargets.disabled,
                  false,
                  (count) => `已启用 ${count} 个账号`
                )
              }
            >
              启用已停用（{suggestedTargets.disabled.length}）
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={controlsDisabled || suggestedTargets.tokenInvalid.length === 0}
              onClick={() => confirmSuggestedDelete(suggestedTargets.tokenInvalid)}
            >
              删除Token失效（{suggestedTargets.tokenInvalid.length}）
            </Button>
          </div>
        </div>
      </section>

      <section className={styles.viewSwitch} aria-label="账号视图">
        {quickViews.map((view) => (
          <button
            key={view.filter}
            type="button"
            className={quickFilter === view.filter ? styles.activeViewButton : ''}
            aria-pressed={quickFilter === view.filter}
            onClick={() => activateQuickFilter(view.filter)}
          >
            <span>{view.label}</span>
            <strong>{view.count}</strong>
          </button>
        ))}
      </section>

      <section className={styles.toolbar}>
        <Input
          label="搜索账号"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="输入邮箱、文件名、状态或错误原因"
          rightElement={<IconSearch size={16} />}
        />
        <div className={styles.toolbarControl}>
          <label htmlFor="codex-quota-status">状态</label>
          <Select
            id="codex-quota-status"
            value={statusFilter}
            options={statusOptions}
            onChange={(value) => setStatusFilter(value as StatusFilter)}
          />
        </div>
        <div className={styles.toolbarControl}>
          <label htmlFor="codex-quota-plan">账号类型</label>
          <Select
            id="codex-quota-plan"
            value={planFilter}
            options={planOptions}
            onChange={setPlanFilter}
          />
        </div>
        <div className={styles.toolbarControl}>
          <label htmlFor="codex-quota-sort">排序</label>
          <Select
            id="codex-quota-sort"
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
                <th>账号信息</th>
                <th>健康判断</th>
                <th>当前状态</th>
                <th>当前周期</th>
                <th>长周期</th>
                <th>凭证/刷新</th>
                <th>不可用原因</th>
                <th className={styles.actionsColumn}>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                <tr>
                  <td colSpan={9} className={styles.emptyCell}>正在加载账号余量...</td>
                </tr>
              ) : !data ? (
                <tr>
                  <td colSpan={9} className={styles.emptyCell}>点击“刷新余量”开始查询账号状态</td>
                </tr>
              ) : visibleAccounts.length === 0 ? (
                <tr>
                  <td colSpan={9} className={styles.emptyCell}>没有匹配的账号</td>
                </tr>
              ) : (
                groupedVisibleAccounts.flatMap((group) => [
                  <tr className={styles.groupRow} key={`group-${group.key}`}>
                    <td colSpan={9}>
                      <strong>{group.title}</strong>
                      <span>{group.description}</span>
                      <em>{group.accounts.length} 个</em>
                    </td>
                  </tr>,
                  ...group.accounts.map((account) => {
                    const health = getAccountHealth(account);
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
                            <strong>{account.account}</strong>
                            <small>{planLabel(account.plan)} · {account.file}</small>
                          </div>
                        </td>
                        <td>
                          <div className={styles.healthCell}>
                            <span className={`${styles.healthPill} ${styles[`health_${health.tone}`]}`}>
                              {health.label}
                            </span>
                            <small>{health.reason}</small>
                          </div>
                        </td>
                        <td>
                          <span className={`${styles.statusPill} ${statusClass(account.status)}`}>
                            {account.statusText}
                          </span>
                        </td>
                        <td>
                          <div className={styles.metricStack}>
                            <span className={`${styles.remainingPill} ${remainingClass(account)}`}>
                              剩余 {percent(account.currentRemainingPercent)}
                            </span>
                            <small>已用 {percent(account.currentUsedPercent)}</small>
                            <small>恢复 {valueOrDash(account.currentResetAt)}</small>
                          </div>
                        </td>
                        <td>
                          <div className={styles.metricStack}>
                            <strong>{valueOrDash(account.longWindowText)}</strong>
                            <small>剩余 {percent(account.longRemainingPercent)}</small>
                          </div>
                        </td>
                        <td>
                          <div className={styles.metricStack}>
                            <span>过期 {valueOrDash(account.tokenExpiredAt)}</span>
                            <small>刷新 {valueOrDash(account.lastRefreshAt)}</small>
                          </div>
                        </td>
                        <td className={styles.errorText} title={account.error}>
                          {normalizeQuotaErrorReason(account)}
                        </td>
                        <td className={styles.actionsColumn}>
                          <div className={styles.actions}>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={controlsDisabled}
                              loading={actionFile === `refresh:${account.file}`}
                              onClick={() => void handleRefreshTargets([account], `refresh:${account.file}`)}
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
                  }),
                ])
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
