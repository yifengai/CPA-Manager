import { describe, expect, it } from 'vitest';
import {
  clearRequestLogsCache,
  readRequestLogsCache,
  writeRequestLogsCache,
  type RequestLogsCacheSnapshot,
} from './requestLogsCache';

const createStorage = (): Storage => {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
};

const snapshot: RequestLogsCacheSnapshot = {
  listPayload: {
    generatedAt: '2026-05-20 10:00:00',
    logDir: '/request-logs',
    total: 1,
    tasks: [
      {
        id: 'task-1',
        title: '测试任务',
        updatedAt: '2026-05-20 10:00:01',
        requestCount: 1,
        requests: [
          {
            requestId: 'req-1',
            logName: 'req-1.json',
            logPath: '/request-logs/req-1.json',
            updatedAt: '2026-05-20 10:00:01',
            method: 'POST',
            path: '/v1/responses',
            upstreamUrl: 'https://example.com/v1/responses',
            auth: 'account.json',
            status: '已完成',
            completed: true,
            hasError: false,
            userCount: 1,
            upstreamEvents: 2,
            responsesEvents: 3,
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            userPath: 'input[0].content[0].text',
            userPreview: '你好',
            finalPreview: '你好，有什么可以帮你',
          },
        ],
      },
    ],
    latest: undefined,
  },
  detail: null,
  selectedTaskId: 'task-1',
  selectedRequestId: 'req-1',
  serviceBase: 'http://127.0.0.1:18317',
  lastRefreshedAt: '2026-05-20T02:00:00.000Z',
  cachedAt: '2026-05-20T02:00:03.000Z',
};

describe('request logs browser cache', () => {
  it('reads back the latest cached request-log snapshot', () => {
    const storage = createStorage();

    writeRequestLogsCache(snapshot, storage);

    expect(readRequestLogsCache(storage)).toEqual(snapshot);
  });

  it('returns null for missing or malformed cache values', () => {
    const storage = createStorage();

    expect(readRequestLogsCache(storage)).toBeNull();

    storage.setItem('cpa-manager:request-logs:snapshot:v1', '{');

    expect(readRequestLogsCache(storage)).toBeNull();
  });

  it('clears the cached snapshot before a manual refresh', () => {
    const storage = createStorage();
    writeRequestLogsCache(snapshot, storage);

    clearRequestLogsCache(storage);

    expect(readRequestLogsCache(storage)).toBeNull();
  });
});
