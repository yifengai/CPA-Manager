import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { IconRefreshCw, IconSearch, IconTrash2 } from '@/components/ui/icons';
import { codexQuotaApi, type CodexQuotaAccount, type CodexQuotaResponse } from '@/services/api';
import { useAuthStore, useNotificationStore } from '@/stores';
import styles from './CodexQuotaDashboardPage.module.scss';

type StatusFilter = 'all' | 'available' | 'limited' | 'disabled' | 'error';
type SortMode = 'remaining-asc' | 'remaining-desc' | 'reset-asc' | 'account-asc';

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

export function CodexQuotaDashboardPage() {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);

  const [data, setData] = useState<CodexQuotaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionFile, setActionFile] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [planFilter, setPlanFilter] = useState('all');
  const [sortMode, setSortMode] = useState<SortMode>('remaining-asc');
  const disabled = connectionStatus !== 'connected';

  const loadQuota = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await codexQuotaApi.list();
      setData(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : '账号余量加载失败';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadQuota();
  }, [loadQuota]);

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

  const handleSetDisabled = async (account: CodexQuotaAccount, nextDisabled: boolean) => {
    setActionFile(account.file);
    try {
      await codexQuotaApi.setDisabled(account.file, nextDisabled);
      showNotification(nextDisabled ? '账号已停用' : '账号已启用', 'success');
      await loadQuota();
    } catch (err) {
      const message = err instanceof Error ? err.message : '账号状态更新失败';
      showNotification(`账号状态更新失败：${message}`, 'error');
    } finally {
      setActionFile(null);
    }
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
        <Button onClick={() => void loadQuota()} loading={loading} disabled={disabled} size="sm">
          <IconRefreshCw size={16} />
          <span>刷新余量</span>
        </Button>
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
          <h2>账号列表</h2>
          <span>显示 {visibleAccounts.length} / {data?.accounts.length ?? 0} 个账号</span>
        </div>
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
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
                  <td colSpan={12} className={styles.emptyCell}>正在加载账号余量...</td>
                </tr>
              ) : visibleAccounts.length === 0 ? (
                <tr>
                  <td colSpan={12} className={styles.emptyCell}>没有匹配的账号</td>
                </tr>
              ) : (
                visibleAccounts.map((account) => (
                  <tr key={account.file}>
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
                      {valueOrDash(account.error)}
                    </td>
                    <td>
                      <div className={styles.actions}>
                        <Button
                          size="sm"
                          variant={account.disabled ? 'primary' : 'secondary'}
                          disabled={disabled || actionFile === account.file}
                          loading={actionFile === account.file}
                          onClick={() => void handleSetDisabled(account, !account.disabled)}
                        >
                          {account.disabled ? '启用' : '停用'}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={disabled || actionFile === account.file}
                          onClick={() => confirmDelete(account)}
                          title="归档删除"
                        >
                          <IconTrash2 size={14} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
