import type { RequestLogListResponse, RequestLogTrace } from '@/services/api/usageService';

export const REQUEST_LOGS_CACHE_KEY = 'cpa-manager:request-logs:snapshot:v1';

export interface RequestLogsCacheSnapshot {
  listPayload: RequestLogListResponse;
  detail: RequestLogTrace | null;
  selectedTaskId: string;
  selectedRequestId: string;
  serviceBase: string;
  lastRefreshedAt: string | null;
  cachedAt: string;
}

const defaultStorage = (): Storage | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const isSnapshot = (value: unknown): value is RequestLogsCacheSnapshot => {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<RequestLogsCacheSnapshot>;
  return Boolean(
    snapshot.listPayload &&
      typeof snapshot.listPayload === 'object' &&
      Array.isArray(snapshot.listPayload.tasks) &&
      typeof snapshot.selectedTaskId === 'string' &&
      typeof snapshot.selectedRequestId === 'string' &&
      typeof snapshot.serviceBase === 'string' &&
      typeof snapshot.cachedAt === 'string'
  );
};

export const readRequestLogsCache = (
  storage: Storage | null = defaultStorage()
): RequestLogsCacheSnapshot | null => {
  if (!storage) return null;
  try {
    const raw = storage.getItem(REQUEST_LOGS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const writeRequestLogsCache = (
  snapshot: RequestLogsCacheSnapshot,
  storage: Storage | null = defaultStorage()
) => {
  if (!storage) return;
  try {
    storage.setItem(REQUEST_LOGS_CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // 浏览器存储满或被禁用时，不影响页面本身使用。
  }
};

export const clearRequestLogsCache = (storage: Storage | null = defaultStorage()) => {
  if (!storage) return;
  try {
    storage.removeItem(REQUEST_LOGS_CACHE_KEY);
  } catch {
    // 清理缓存失败时继续走刷新流程，由页面错误提示兜底。
  }
};
