import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { IconRefreshCw, IconSearch, IconTrash2 } from '@/components/ui/icons';
import { codexQuotaApi, type CodexQuotaAccount, type CodexQuotaResponse } from '@/services/api';
import { useAuthStore, useNotificationStore } from '@/stores';
import styles from './CodexQuotaDashboardPage.module.scss';

type StatusFilter = 'all' | 'available' | 'limited' | 'disabled' | 'error';
type SortMode = 'remaining-asc' | 'remaining-desc' | 'reset-asc' | 'account-asc';
type RiskGroupKey = 'needsAction' | 'low' | 'normal' | 'disabled';

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

const normalizedErrorReason = (account: CodexQuotaAccount) => {
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

const recoveryBucketKey = (account: CodexQuotaAccount) => {
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

export function CodexQuotaDashboardPage() {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);

  const [data, setData] = useState<CodexQuotaResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionFile, setActionFile] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [planFilter, setPlanFilter] = useState('all');
  const [sortMode, setSortMode] = useState<SortMode>('remaining-asc');
  const [lastRefreshAt, setLastRefreshAt] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(() => new Set());
  const disabled = connectionStatus !== 'connected';
  const controlsDisabled = disabled || loading || actionFile !== null;

  const loadQuota = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await codexQuotaApi.list();
      setData(response);
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
  }, [data?.accounts, planFilter, search, sortMode, statusFilter]);

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
      tokenInvalid: accounts.filter((account) => normalizedErrorReason(account).includes('Token')),
    };
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

      <section className={styles.summaryGrid} aria-label="账号余量总览">
        <div className={styles.summaryCard}>
          <span>账号总数</span>
          <strong>{summary?.total ?? '-'}</strong>
          <small>本次纳入统计</small>
        </div>
        <div className={styles.summaryCard}>
          <span>可用账号</span>
          <strong>{summary?.available ?? '-'}</strong>
          <small>可继续调用</small>
        </div>
        <div className={styles.summaryCard}>
          <span>受限账号</span>
          <strong>{summary?.limited ?? '-'}</strong>
          <small>建议暂停使用</small>
        </div>
        <div className={styles.summaryCard}>
          <span>失败/不可用</span>
          <strong>{summary?.errors ?? '-'}</strong>
          <small>优先检查 Token</small>
        </div>
        <div className={styles.summaryCard}>
          <span>低余量账号</span>
          <strong>{summary?.low ?? '-'}</strong>
          <small>剩余 20% 及以下</small>
        </div>
        <div className={styles.summaryCard}>
          <span>平均剩余额度</span>
          <strong>{typeof summary?.average === 'number' ? `${summary.average}%` : '-'}</strong>
          <small>中位数 {typeof summary?.median === 'number' ? `${summary.median}%` : '-'}</small>
        </div>
      </section>

      <section className={styles.insightGrid}>
        <div className={styles.panel}>
          <h2>处理建议</h2>
          <div className={styles.recommendations}>
            <div className={styles.recommendationDanger}>
              <strong>立即处理</strong>
              <span>失败/不可用账号 {summary?.errors ?? 0} 个，优先重新登录或刷新 Token。</span>
            </div>
            <div className={styles.recommendationWarn}>
              <strong>暂停使用</strong>
              <span>受限账号 {summary?.limited ?? 0} 个，低于 10% 的账号 {summary?.critical ?? 0} 个。</span>
            </div>
            <div className={styles.recommendationInfo}>
              <strong>Free说明</strong>
              <span>Free 账号通常没有长周期额度，显示“不适用”是正常情况。</span>
            </div>
          </div>
        </div>
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
            <div><strong>{recoverySummary.hour}</strong><span>1小时内恢复</span></div>
            <div><strong>{recoverySummary.today}</strong><span>今天恢复</span></div>
            <div><strong>{recoverySummary.tomorrow}</strong><span>明天恢复</span></div>
            <div><strong>{recoverySummary.soon}</strong><span>3天内恢复</span></div>
            <div><strong>{recoverySummary.later}</strong><span>超过3天</span></div>
            <div><strong>{recoverySummary.unknown}</strong><span>未知/不适用</span></div>
          </div>
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
            <span>显示 {visibleAccounts.length} / {data?.accounts.length ?? 0} 个账号</span>
          </div>
          <div className={styles.batchActions}>
            <span>已选 {selectedFiles.size} 个</span>
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
                <th>账号邮箱</th>
                <th>当前可用状态</th>
                <th>账号类型</th>
                <th>当前周期剩余额度</th>
                <th>当前周期已用额度</th>
                <th>当前额度恢复时间</th>
                <th>长周期额度</th>
                <th>长周期剩余额度</th>
                <th>登录凭证过期时间</th>
                <th>最近刷新时间</th>
                <th>不可用原因</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                <tr>
                  <td colSpan={13} className={styles.emptyCell}>正在加载账号余量...</td>
                </tr>
              ) : !data ? (
                <tr>
                  <td colSpan={13} className={styles.emptyCell}>点击“刷新余量”开始查询账号状态</td>
                </tr>
              ) : visibleAccounts.length === 0 ? (
                <tr>
                  <td colSpan={13} className={styles.emptyCell}>没有匹配的账号</td>
                </tr>
              ) : (
                groupedVisibleAccounts.flatMap((group) => [
                  <tr className={styles.groupRow} key={`group-${group.key}`}>
                    <td colSpan={13}>
                      <strong>{group.title}</strong>
                      <span>{group.description}</span>
                      <em>{group.accounts.length} 个</em>
                    </td>
                  </tr>,
                  ...group.accounts.map((account) => (
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
                          <small>{account.file}</small>
                        </div>
                      </td>
                      <td>
                        <span className={`${styles.statusPill} ${statusClass(account.status)}`}>
                          {account.statusText}
                        </span>
                      </td>
                      <td>{planLabel(account.plan)}</td>
                      <td>
                        <span className={`${styles.remainingPill} ${remainingClass(account)}`}>
                          {percent(account.currentRemainingPercent)}
                        </span>
                      </td>
                      <td>{percent(account.currentUsedPercent)}</td>
                      <td>{valueOrDash(account.currentResetAt)}</td>
                      <td>{valueOrDash(account.longWindowText)}</td>
                      <td>{percent(account.longRemainingPercent)}</td>
                      <td>{valueOrDash(account.tokenExpiredAt)}</td>
                      <td>{valueOrDash(account.lastRefreshAt)}</td>
                      <td className={styles.errorText} title={account.error}>
                        {normalizedErrorReason(account)}
                      </td>
                      <td>
                        <div className={styles.actions}>
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
                  )),
                ])
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
