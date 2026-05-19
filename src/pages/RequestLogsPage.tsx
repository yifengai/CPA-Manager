import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { IconFileText, IconRefreshCw, IconSearch, IconTimer } from '@/components/ui/icons';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useInterval } from '@/hooks/useInterval';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import {
  clearRequestLogsCache,
  readRequestLogsCache,
  writeRequestLogsCache,
} from '@/features/requestLogs/requestLogsCache';
import {
  isUsageServiceId,
  normalizeUsageServiceBase,
  usageServiceApi,
  type RequestLogCount,
  type RequestLogEvent,
  type RequestLogListResponse,
  type RequestLogRouting,
  type RequestLogSummary,
  type RequestLogTask,
  type RequestLogTrace,
} from '@/services/api/usageService';
import { useAuthStore, useNotificationStore, useUsageServiceStore } from '@/stores';
import { copyToClipboard } from '@/utils/clipboard';
import { detectApiBaseFromLocation } from '@/utils/connection';
import styles from './RequestLogsPage.module.scss';

type DetailTab = 'routing' | 'responses' | 'upstream' | 'raw';

const AUTO_REFRESH_MS = 10000;
const REQUEST_LOG_LIMIT = 180;

const FLOW_STEPS = [
  {
    title: '客户端请求',
    summary: '用户或工具把请求发送到 /v1/responses。',
  },
  {
    title: 'CLIProxyAPI 接收',
    summary: '本地代理接收请求并写入 request-log。',
  },
  {
    title: '账号池分发',
    summary: '代理选择账号、认证文件和上游地址。',
  },
  {
    title: '上游响应',
    summary: '上游以 SSE 或完整响应返回结果。',
  },
  {
    title: '返回客户端',
    summary: '代理组装 Responses 数据并回传。',
  },
];

const numberFormatter = new Intl.NumberFormat('zh-CN');

const stringify = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const textIncludes = (value: string | undefined, query: string) =>
  (value ?? '').toLowerCase().includes(query);

const toneForSummary = (summary?: RequestLogSummary) => {
  if (!summary) return 'idle';
  if (summary.hasError) return 'bad';
  if (summary.completed) return 'good';
  return 'warn';
};

const requestLabel = (request: RequestLogSummary) =>
  request.requestId || request.logName || request.path || '未知请求';

const truncateText = (text: string, maxLength: number) => {
  const trimmed = text.trim();
  if (Array.from(trimmed).length <= maxLength) return trimmed;
  return `${Array.from(trimmed).slice(0, maxLength).join('')}...`;
};

function RequestLogsMetric({ label, value, meta }: { label: string; value: string; meta: string }) {
  return (
    <div className={styles.metricCard}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{meta}</small>
    </div>
  );
}

function EventCountChips({ counts }: { counts: RequestLogCount[] }) {
  if (!counts.length) {
    return <span className={styles.muted}>暂无事件统计</span>;
  }
  return (
    <div className={styles.eventChips}>
      {counts.map((item) => (
        <span key={item.name}>
          {item.name}
          <strong>{item.count}</strong>
        </span>
      ))}
    </div>
  );
}

function EventTable({ events }: { events: RequestLogEvent[] }) {
  if (!events.length) {
    return <div className={styles.emptyInline}>暂无 SSE 事件。</div>;
  }
  return (
    <div className={styles.tableScroller}>
      <table className={styles.eventTable}>
        <thead>
          <tr>
            <th>#</th>
            <th>event</th>
            <th>type</th>
            <th>摘要</th>
            <th>data</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event, index) => (
            <tr key={`${event.event}-${event.type}-${index}`}>
              <td>{index + 1}</td>
              <td>
                <code>{event.event || '-'}</code>
              </td>
              <td>
                <code>{event.type || '-'}</code>
              </td>
              <td>{event.summary || '-'}</td>
              <td>
                <details>
                  <summary>查看</summary>
                  <pre>{stringify(event.data ?? event.rawData)}</pre>
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RoutingTable({ routing }: { routing: RequestLogRouting[] }) {
  if (!routing.length) {
    return <div className={styles.emptyInline}>暂无分发记录。</div>;
  }
  return (
    <div className={styles.tableScroller}>
      <table className={styles.routingTable}>
        <thead>
          <tr>
            <th>阶段</th>
            <th>方法</th>
            <th>上游地址</th>
            <th>账号选择</th>
          </tr>
        </thead>
        <tbody>
          {routing.map((item, index) => (
            <tr key={`${item.title}-${index}`}>
              <td>{item.title}</td>
              <td>{item.method || '-'}</td>
              <td>{item.upstreamUrl || '-'}</td>
              <td>{item.auth || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RequestLogsPage() {
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const usageServiceEnabled = useUsageServiceStore((state) => state.enabled);
  const configuredUsageServiceBase = useUsageServiceStore((state) => state.serviceBase);
  const { showNotification } = useNotificationStore();

  const [autoRefresh, setAutoRefresh] = useLocalStorage('requestLogs.autoRefresh', false);
  const [activeTab, setActiveTab] = useState<DetailTab>('routing');
  const [searchQuery, setSearchQuery] = useState('');
  const [cachedSnapshot] = useState(() => readRequestLogsCache());
  const [listPayload, setListPayload] = useState<RequestLogListResponse | null>(
    () => cachedSnapshot?.listPayload ?? null
  );
  const [detail, setDetail] = useState<RequestLogTrace | null>(() => cachedSnapshot?.detail ?? null);
  const [selectedTaskId, setSelectedTaskId] = useState(() => cachedSnapshot?.selectedTaskId ?? '');
  const [selectedRequestId, setSelectedRequestId] = useState(
    () => cachedSnapshot?.selectedRequestId ?? ''
  );
  const [serviceBase, setServiceBase] = useState(() => cachedSnapshot?.serviceBase ?? '');
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(
    () => (cachedSnapshot?.lastRefreshedAt ? new Date(cachedSnapshot.lastRefreshedAt) : null)
  );
  const selectedRequestIdRef = useRef('');
  const selectedTaskIdRef = useRef('');
  const loadingListRef = useRef(false);

  useEffect(() => {
    selectedRequestIdRef.current = selectedRequestId;
  }, [selectedRequestId]);

  useEffect(() => {
    selectedTaskIdRef.current = selectedTaskId;
  }, [selectedTaskId]);

  const resolveUsageServiceBase = useCallback(async (): Promise<string> => {
    if (usageServiceEnabled && configuredUsageServiceBase) {
      return configuredUsageServiceBase;
    }

    const candidates = Array.from(
      new Set(
        [apiBase, detectApiBaseFromLocation()]
          .map((value) => normalizeUsageServiceBase(value || ''))
          .filter(Boolean)
      )
    );

    for (const candidate of candidates) {
      try {
        const info = await usageServiceApi.getInfo(candidate);
        if (isUsageServiceId(info.service)) {
          return candidate;
        }
      } catch {
        // 常规 CPA Management API 没有 Usage Service metadata。
      }
    }

    return '';
  }, [apiBase, configuredUsageServiceBase, usageServiceEnabled]);

  const loadDetailFromBase = useCallback(
    async (base: string, requestId: string) => {
      if (!base || !requestId) return null;
      setLoadingDetail(true);
      try {
        const payload = await usageServiceApi.getRequestLogDetail(base, requestId, managementKey);
        setDetail(payload);
        setSelectedRequestId(payload.summary.requestId || requestId);
        return payload;
      } finally {
        setLoadingDetail(false);
      }
    },
    [managementKey]
  );

  const loadList = useCallback(
    async (preferredRequestId?: string) => {
      if (loadingListRef.current) return;
      loadingListRef.current = true;
      setLoadingList(true);
      setError('');
      try {
        const base = await resolveUsageServiceBase();
        if (!base) {
          throw new Error('未找到可读取请求日志的 CPA-manager 服务');
        }
        setServiceBase(base);

        const payload = await usageServiceApi.getRequestLogs(
          base,
          managementKey,
          REQUEST_LOG_LIMIT
        );
        setListPayload(payload);
        const refreshedAt = new Date();
        setLastRefreshedAt(refreshedAt);

        const flatRequests = payload.tasks.flatMap((task) => task.requests);
        const selectedTask = payload.tasks.find((task) => task.id === selectedTaskIdRef.current);
        const preferredTask = preferredRequestId
          ? payload.tasks.find((task) =>
              task.requests.some((request) => request.requestId === preferredRequestId)
            )
          : undefined;
        const selectedRequest = selectedTask?.requests.find(
          (request) => request.requestId === selectedRequestIdRef.current
        );
        const nextTask = preferredTask ?? selectedTask ?? payload.tasks[0];
        const nextRequest =
          (preferredRequestId
            ? flatRequests.find((request) => request.requestId === preferredRequestId)
            : selectedRequest) ??
          nextTask?.requests[0] ??
          payload.latest;
        const nextTaskId = nextTask?.id || '';
        const nextRequestId = nextRequest?.requestId || '';

        if (nextTaskId) {
          setSelectedTaskId(nextTaskId);
        }
        if (nextRequestId) {
          setSelectedRequestId(nextRequestId);
          const nextDetail = await loadDetailFromBase(base, nextRequestId);
          writeRequestLogsCache({
            listPayload: payload,
            detail: nextDetail,
            selectedTaskId: nextTaskId,
            selectedRequestId: nextRequestId,
            serviceBase: base,
            lastRefreshedAt: refreshedAt.toISOString(),
            cachedAt: new Date().toISOString(),
          });
        } else {
          setDetail(null);
          setSelectedTaskId('');
          setSelectedRequestId('');
          writeRequestLogsCache({
            listPayload: payload,
            detail: null,
            selectedTaskId: '',
            selectedRequestId: '',
            serviceBase: base,
            lastRefreshedAt: refreshedAt.toISOString(),
            cachedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      } finally {
        setLoadingList(false);
        loadingListRef.current = false;
      }
    },
    [loadDetailFromBase, managementKey, resolveUsageServiceBase]
  );

  const loadDetail = useCallback(
    async (requestId: string) => {
      setError('');
      try {
        const base = serviceBase || (await resolveUsageServiceBase());
        if (!base) {
          throw new Error('未找到可读取请求日志的 CPA-manager 服务');
        }
        setServiceBase(base);
        const nextDetail = await loadDetailFromBase(base, requestId);
        writeRequestLogsCache({
          listPayload: listPayload ?? {
            generatedAt: new Date().toISOString(),
            logDir: '',
            total: 0,
            tasks: [],
          },
          detail: nextDetail,
          selectedTaskId: selectedTaskIdRef.current,
          selectedRequestId: nextDetail?.summary.requestId || requestId,
          serviceBase: base,
          lastRefreshedAt: lastRefreshedAt ? lastRefreshedAt.toISOString() : null,
          cachedAt: new Date().toISOString(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      }
    },
    [lastRefreshedAt, listPayload, loadDetailFromBase, resolveUsageServiceBase, serviceBase]
  );

  const refreshLogs = useCallback(
    async (forceClearCache = false) => {
      if (forceClearCache) {
        clearRequestLogsCache();
      }
      await loadList(selectedRequestIdRef.current || undefined);
    },
    [loadList]
  );

  useHeaderRefresh(() => refreshLogs(true));

  useInterval(
    () => {
      void refreshLogs();
    },
    autoRefresh ? AUTO_REFRESH_MS : null
  );

  const filteredTasks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const tasks = listPayload?.tasks ?? [];
    if (!query) return tasks;
    return tasks
      .map((task) => {
        const taskMatched = textIncludes(task.title, query) || textIncludes(task.updatedAt, query);
        const requests = task.requests.filter(
          (request) =>
            taskMatched ||
            textIncludes(request.requestId, query) ||
            textIncludes(request.logName, query) ||
            textIncludes(request.path, query) ||
            textIncludes(request.auth, query) ||
            textIncludes(request.userPreview, query) ||
            textIncludes(request.finalPreview, query)
        );
        return requests.length ? { ...task, requests, requestCount: requests.length } : null;
      })
      .filter((task): task is RequestLogTask => Boolean(task));
  }, [listPayload?.tasks, searchQuery]);

  const selectedTask = useMemo(
    () => filteredTasks.find((task) => task.id === selectedTaskId) ?? filteredTasks[0] ?? null,
    [filteredTasks, selectedTaskId]
  );

  const selectedTaskRequests = useMemo(() => selectedTask?.requests ?? [], [selectedTask]);

  const selectedRequest = useMemo(
    () =>
      selectedTaskRequests.find((request) => request.requestId === selectedRequestId) ??
      selectedTaskRequests[0] ??
      null,
    [selectedRequestId, selectedTaskRequests]
  );

  useEffect(() => {
    if (!selectedTask) {
      if (selectedTaskId) setSelectedTaskId('');
      if (selectedRequestId) setSelectedRequestId('');
      setDetail(null);
      return;
    }

    if (selectedTask.id !== selectedTaskId) {
      setSelectedTaskId(selectedTask.id);
    }

    if (!selectedRequest) {
      if (selectedRequestId) setSelectedRequestId('');
      setDetail(null);
      return;
    }

    if (selectedRequest.requestId !== selectedRequestId) {
      setSelectedRequestId(selectedRequest.requestId);
    }

    if (detail?.summary.requestId !== selectedRequest.requestId) {
      setDetail(null);
    }
  }, [
    detail?.summary.requestId,
    selectedRequest,
    selectedRequestId,
    selectedTask,
    selectedTaskId,
  ]);

  const metrics = useMemo(() => {
    const requests = (listPayload?.tasks ?? []).flatMap((task) => task.requests);
    return {
      total: requests.length,
      tasks: listPayload?.tasks.length ?? 0,
      completed: requests.filter((request) => request.completed).length,
      errors: requests.filter((request) => request.hasError).length,
      events: requests.reduce(
        (sum, request) => sum + request.upstreamEvents + request.responsesEvents,
        0
      ),
      tokens: requests.reduce((sum, request) => sum + (request.totalTokens || 0), 0),
    };
  }, [listPayload?.tasks]);

  const currentMessage =
    detail?.userMessages.find((message) => message.current) ??
    detail?.userMessages[detail.userMessages.length - 1];
  const rawRequestText = detail?.requestJson ? stringify(detail.requestJson) : detail?.requestRaw;
  const lastRefreshedLabel = lastRefreshedAt
    ? lastRefreshedAt.toLocaleString('zh-CN', { hour12: false })
    : cachedSnapshot
      ? '浏览器缓存'
      : '尚未读取';

  const handleCopy = async (text: string, label: string) => {
    const copied = await copyToClipboard(text);
    showNotification(copied ? `${label}已复制` : `${label}复制失败`, copied ? 'success' : 'error');
  };

  return (
    <div className={styles.container}>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>请求日志</h1>
          <p className={styles.description}>
            按任务归档、按请求切换，在详情区查看请求体、账号分发、SSE 事件和最终 Responses。
          </p>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.refreshTime}>
            <IconTimer size={14} />
            {lastRefreshedLabel}
          </span>
          <ToggleSwitch
            checked={autoRefresh}
            onChange={setAutoRefresh}
            label="自动刷新"
            ariaLabel="自动刷新请求日志"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void refreshLogs(true)}
            loading={loadingList}
          >
            <IconRefreshCw size={15} />
            刷新
          </Button>
        </div>
      </div>

      <section className={styles.flowPanel} aria-label="请求链路流程">
        {FLOW_STEPS.map((step, index) => (
          <div key={step.title} className={styles.flowStep}>
            <span className={styles.flowIndex}>{index + 1}</span>
            <div>
              <strong>{step.title}</strong>
              <small>{step.summary}</small>
            </div>
          </div>
        ))}
      </section>

      <section className={styles.metricGrid}>
        <RequestLogsMetric
          label="请求记录"
          value={numberFormatter.format(metrics.total)}
          meta={`${numberFormatter.format(metrics.tasks)} 个任务`}
        />
        <RequestLogsMetric
          label="已完成"
          value={numberFormatter.format(metrics.completed)}
          meta={`异常 ${numberFormatter.format(metrics.errors)}`}
        />
        <RequestLogsMetric
          label="SSE 事件"
          value={numberFormatter.format(metrics.events)}
          meta="上游 + Responses"
        />
        <RequestLogsMetric
          label="Tokens"
          value={numberFormatter.format(metrics.tokens)}
          meta={serviceBase || listPayload?.logDir || '等待连接'}
        />
      </section>

      {error && <div className={styles.errorBox}>{error}</div>}

      <section className={styles.workbench}>
        <Card
          className={styles.historyPanel}
          title={
            <div className={styles.panelTitle}>
              <IconFileText size={16} />
              任务历史
            </div>
          }
          extra={<span className={styles.panelMeta}>{listPayload?.total ?? 0} 条</span>}
        >
          <Input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="搜索任务、请求、账号或返回内容"
            rightElement={<IconSearch size={15} />}
          />

          {loadingList && !listPayload ? (
            <div className={styles.loadingBlock}>
              <LoadingSpinner size={18} />
              <span>正在读取请求日志...</span>
            </div>
          ) : filteredTasks.length ? (
            <div className={styles.taskList}>
              {filteredTasks.map((task) => {
                const completedCount = task.requests.filter((request) => request.completed).length;
                const errorCount = task.requests.filter((request) => request.hasError).length;
                const activeCount = task.requests.length - completedCount - errorCount;
                const isActive = selectedTask?.id === task.id;
                return (
                  <button
                    key={task.id}
                    type="button"
                    className={`${styles.taskItem} ${isActive ? styles.taskItemActive : ''}`}
                    onClick={() => {
                      setSelectedTaskId(task.id);
                      selectedTaskIdRef.current = task.id;
                      const firstRequest = task.requests[0];
                      if (firstRequest) {
                        setSelectedRequestId(firstRequest.requestId);
                        selectedRequestIdRef.current = firstRequest.requestId;
                        void loadDetail(firstRequest.requestId);
                      }
                    }}
                  >
                    <span className={styles.taskItemTop}>
                      <strong>{truncateText(task.title || '未解析任务', 64)}</strong>
                      <span>{task.requestCount} 条</span>
                    </span>
                    <span className={styles.taskItemPreview}>
                      最近请求 {task.requests[0]?.requestId || '-'}
                    </span>
                    <span className={styles.taskItemTime}>{task.updatedAt || '-'}</span>
                    <span className={styles.taskItemMeta}>
                      <em className={styles.good}>已完成 {completedCount}</em>
                      <em className={styles.warn}>进行中 {activeCount}</em>
                      <em className={styles.bad}>异常 {errorCount}</em>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
          <EmptyState
            title="暂无请求日志"
            description="当前还没有可显示的浏览器缓存。请点击右上角刷新，从 CLIProxyAPI 重新读取最新请求日志。"
            action={
              <Button size="sm" variant="secondary" onClick={() => void refreshLogs(true)}>
                <IconRefreshCw size={15} />
                重新读取
              </Button>
            }
          />
          )}
        </Card>

        <Card
          className={styles.requestPanel}
          title={
            <div className={styles.panelTitle}>
              <IconTimer size={16} />
              请求列表
            </div>
          }
          extra={
            selectedTask ? (
              <span className={styles.panelMeta}>
                {selectedTask.requests.length} 条 · {selectedTask.updatedAt || '-'}
              </span>
            ) : (
              <span className={styles.panelMeta}>请选择任务</span>
            )
          }
        >
          {selectedTask ? (
            <div className={styles.requestList}>
              <div className={styles.requestListHeader}>
                <strong>{truncateText(selectedTask.title || '未解析任务', 42)}</strong>
                <span>点击下面任一请求查看详情</span>
              </div>
              {selectedTask.requests.map((request) => {
                const active = selectedRequest?.requestId === request.requestId;
                return (
                  <button
                    key={`${selectedTask.id}-${request.requestId}`}
                    type="button"
                    className={`${styles.requestItem} ${active ? styles.requestItemActive : ''}`}
                    onClick={() => {
                      setSelectedRequestId(request.requestId);
                      selectedRequestIdRef.current = request.requestId;
                      void loadDetail(request.requestId);
                    }}
                  >
                    <span className={styles.requestItemTop}>
                      <strong>{requestLabel(request)}</strong>
                      <em className={styles[toneForSummary(request)]}>{request.status}</em>
                    </span>
                    <span className={styles.requestPreview}>
                      {truncateText(
                        request.userPreview || request.finalPreview || request.path || '未解析请求',
                        88
                      )}
                    </span>
                    <span className={styles.requestMeta}>
                      {request.updatedAt || '-'} · SSE {request.responsesEvents}/
                      {request.upstreamEvents} · Tokens {request.totalTokens || '-'}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <EmptyState
              title="没有可显示的请求"
              description="先在左侧选一个任务，再在中间切换请求。"
            />
          )}
        </Card>

        <Card className={styles.detailPanel}>
          {loadingDetail && !detail ? (
            <div className={styles.loadingBlock}>
              <LoadingSpinner size={20} />
              <span>正在加载详情...</span>
            </div>
          ) : detail ? (
            <>
              <div className={styles.detailHeader}>
                <div>
                  <div className={styles.detailKicker}>当前请求</div>
                  <h2>{requestLabel(detail.summary)}</h2>
                  <p>
                    {detail.summary.method || '-'} {detail.summary.path || '-'} ·{' '}
                    {detail.summary.updatedAt || '-'}
                  </p>
                </div>
                <div className={styles.detailBadges}>
                  <span className={styles[toneForSummary(detail.summary)]}>
                    {detail.summary.status}
                  </span>
                  <span>Tokens {detail.summary.totalTokens || '-'}</span>
                </div>
              </div>

              <div className={styles.primaryDetailGrid}>
                <section>
                  <div className={styles.sectionHead}>
                    <h3>用户请求</h3>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleCopy(currentMessage?.text || '', '用户请求')}
                      disabled={!currentMessage?.text}
                    >
                      复制
                    </Button>
                  </div>
                  <pre>{currentMessage?.text || '未解析到 role=user 的请求内容。'}</pre>
                </section>
                <section>
                  <div className={styles.sectionHead}>
                    <h3>返回内容</h3>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleCopy(detail.finalText || '', '返回内容')}
                      disabled={!detail.finalText}
                    >
                      复制
                    </Button>
                  </div>
                  <pre>
                    {detail.finalText ||
                      '暂未解析到最终返回内容。若是工具调用或推理型请求，可以切换到 Responses SSE / 上游 SSE 查看流式过程。'}
                  </pre>
                </section>
              </div>

              <div className={styles.tabBar}>
                {[
                  ['routing', '分发情况'],
                  ['responses', 'Responses SSE'],
                  ['upstream', '上游 SSE'],
                  ['raw', '原始请求'],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={activeTab === key ? styles.tabActive : ''}
                    onClick={() => setActiveTab(key as DetailTab)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className={styles.tabPanel}>
                {activeTab === 'routing' && <RoutingTable routing={detail.routing} />}
                {activeTab === 'responses' && (
                  <>
                    <EventCountChips counts={detail.responsesEventCounts} />
                    <EventTable events={detail.responsesEvents} />
                  </>
                )}
                {activeTab === 'upstream' && (
                  <>
                    <EventCountChips counts={detail.upstreamEventCounts} />
                    <EventTable events={detail.upstreamEvents} />
                  </>
                )}
                {activeTab === 'raw' && (
                  <div className={styles.rawGrid}>
                    <section>
                      <h3>请求体</h3>
                      <pre>{rawRequestText || '暂无请求体。'}</pre>
                    </section>
                    <section>
                      <h3>请求头</h3>
                      <pre>{stringify(detail.headers) || '暂无请求头。'}</pre>
                    </section>
                  </div>
                )}
              </div>
            </>
          ) : (
            <EmptyState
              title="请选择一条请求"
              description="先选择任务，再选择请求，详情区会展示完整链路。"
            />
          )}
        </Card>
      </section>
    </div>
  );
}
