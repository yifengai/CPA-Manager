import { describe, expect, it } from 'vitest';
import type { CodexQuotaAccount } from '@/services/api';
import {
  buildAccountPoolBalance,
  buildQuotaCycleProgress,
  buildTodayUsageSummary,
  buildTodayRestoredHistory,
  formatAccountSurvivalDays,
  getAccountSurvivalMs,
  getAccountSurvivalBucketKey,
  getAccountListDisplay,
  getCodexQuotaBusinessStatus,
  getRecoveryDayBucketKey,
  normalizeQuotaErrorReason,
} from './dashboardState';

const createAccount = (overrides: Partial<CodexQuotaAccount> = {}): CodexQuotaAccount => ({
  file: overrides.file ?? `${overrides.account ?? 'account@example.com'}.json`,
  account: overrides.account ?? 'account@example.com',
  email: overrides.email ?? overrides.account ?? 'account@example.com',
  importedAt: overrides.importedAt ?? '2026-05-13 07:32:08',
  disabled: overrides.disabled ?? false,
  status: overrides.status ?? 'available',
  statusText: overrides.statusText ?? '可用',
  plan: overrides.plan ?? 'plus',
  allowed: overrides.allowed ?? true,
  limitReached: overrides.limitReached ?? false,
  currentRemainingPercent: overrides.currentRemainingPercent ?? 80,
  currentUsedPercent: overrides.currentUsedPercent ?? 20,
  currentResetAt: overrides.currentResetAt ?? '2026-05-18 20:00:00',
  longWindowText: overrides.longWindowText ?? '7天',
  longRemainingPercent: overrides.longRemainingPercent ?? 80,
  longUsedPercent: overrides.longUsedPercent ?? 20,
  longResetAt: overrides.longResetAt ?? '2026-05-25 20:00:00',
  creditsBalance: overrides.creditsBalance,
  tokenExpiredAt: overrides.tokenExpiredAt ?? '2026-06-18 20:00:00',
  lastRefreshAt: overrides.lastRefreshAt ?? '2026-05-18 12:00:00',
  latencyMs: overrides.latencyMs ?? 120,
  error: overrides.error ?? '',
  sortRemaining: overrides.sortRemaining ?? overrides.currentRemainingPercent ?? 80,
});

describe('codex quota dashboard state', () => {
  it('normalizes current cycle progress into used and remaining segments', () => {
    expect(buildQuotaCycleProgress(35, 65)).toMatchObject({
      hasData: true,
      usedLabelPercent: 35,
      remainingLabelPercent: 65,
      usedWidthPercent: 35,
      remainingWidthPercent: 65,
    });

    expect(buildQuotaCycleProgress(null, 25)).toMatchObject({
      hasData: true,
      usedLabelPercent: 75,
      remainingLabelPercent: 25,
      usedWidthPercent: 75,
      remainingWidthPercent: 25,
    });

    expect(buildQuotaCycleProgress(120, -10)).toMatchObject({
      hasData: true,
      usedLabelPercent: 100,
      remainingLabelPercent: 0,
      usedWidthPercent: 100,
      remainingWidthPercent: 0,
    });

    expect(buildQuotaCycleProgress(null, null)).toMatchObject({
      hasData: false,
      usedWidthPercent: 0,
      remainingWidthPercent: 0,
    });
  });

  it('estimates account pool balance from a 4M token and GPT-5.5 input price baseline', () => {
    const accounts = [
      createAccount({
        account: 'usable-a@example.com',
        currentRemainingPercent: 50,
      }),
      createAccount({
        account: 'usable-b@example.com',
        currentRemainingPercent: 25,
      }),
      createAccount({
        account: 'disabled@example.com',
        disabled: true,
        status: 'disabled',
        currentRemainingPercent: 100,
      }),
      createAccount({
        account: 'error@example.com',
        status: 'error',
        currentRemainingPercent: 90,
      }),
      createAccount({
        account: 'unknown@example.com',
        currentRemainingPercent: Number.NaN,
      }),
    ];

    expect(buildAccountPoolBalance(accounts, 'available')).toMatchObject({
      accountCount: 2,
      estimatedRemainingTokens: 3_000_000,
      estimatedCalls: 26,
      estimatedValueUsd: 15,
      measurableAccounts: 2,
    });

    expect(buildAccountPoolBalance(accounts, 'inventory')).toMatchObject({
      accountCount: 5,
      estimatedRemainingTokens: 10_600_000,
      estimatedCalls: 90,
      estimatedValueUsd: 53,
      measurableAccounts: 4,
    });
  });

  it('uses runtime estimate settings for public Docker deployments', () => {
    const accounts = [
      createAccount({
        account: 'usable@example.com',
        currentRemainingPercent: 50,
      }),
    ];

    expect(
      buildAccountPoolBalance(accounts, 'available', {
        accountCycleTokens: 2_000_000,
        accountCycleCostUsd: 2,
        accountCycleCalls: 20,
      })
    ).toMatchObject({
      accountCount: 1,
      estimatedRemainingTokens: 1_000_000,
      estimatedCalls: 10,
      estimatedValueUsd: 1,
      measurableAccounts: 1,
    });
  });

  it('formats account survival days from the first import time', () => {
    const now = Date.parse('2026-05-19T16:30:00+08:00');

    expect(getAccountSurvivalMs('2026-05-19 16:02:25', now)).toBe(1_655_000);
    expect(formatAccountSurvivalDays('2026-05-19 16:02:25', now)).toBe('0.1天');
    expect(formatAccountSurvivalDays('2026-05-19 09:18:00', now)).toBe('0.3天');
    expect(formatAccountSurvivalDays('2026-05-18 15:00:00', now)).toBe('1天');
    expect(formatAccountSurvivalDays('2026-05-12 15:00:00', now)).toBe('7天');
    expect(formatAccountSurvivalDays('', now)).toBe('-');
    expect(formatAccountSurvivalDays(undefined, now)).toBe('-');
    expect(getAccountSurvivalMs(undefined, now)).toBeNull();
  });

  it('groups account survival by operational age buckets', () => {
    const now = Date.parse('2026-05-19T16:30:00+08:00');

    expect(getAccountSurvivalBucketKey('2026-05-19 09:18:00', now)).toBe('lt1');
    expect(getAccountSurvivalBucketKey('2026-05-18 16:30:00', now)).toBe('day1To3');
    expect(getAccountSurvivalBucketKey('2026-05-16 16:30:00', now)).toBe('day3To7');
    expect(getAccountSurvivalBucketKey('2026-05-12 16:30:00', now)).toBe('day7To14');
    expect(getAccountSurvivalBucketKey('2026-05-05 16:30:00', now)).toBe('day14Plus');
    expect(getAccountSurvivalBucketKey('', now)).toBe('unknown');
  });

  it('builds concise account-list labels from switch and business status', () => {
    expect(getAccountListDisplay(createAccount())).toMatchObject({
      switchLabel: '启用',
      switchTone: 'enabled',
      businessLabel: '可调用',
      businessTone: 'callable',
      reason: '',
    });
    expect(
      getAccountListDisplay(
        createAccount({
          disabled: true,
          status: 'disabled',
          statusText: '已停用',
        })
      )
    ).toMatchObject({
      switchLabel: '已停用',
      switchTone: 'disabled',
      businessLabel: '可调用',
      businessTone: 'callable',
      reason: '已停用，不进入调用池',
    });
    expect(
      getAccountListDisplay(
        createAccount({
          status: 'limited',
          limitReached: true,
          currentRemainingPercent: 0,
        })
      )
    ).toMatchObject({
      businessLabel: '受限',
      businessTone: 'limited',
      reason: '账号已达调用上限',
    });
  });

  it('summarizes Beijing-day usage tokens and estimated cost', () => {
    const usage = {
      apis: {
        'POST /v1/chat/completions': {
          models: {
            'gpt-5': {
              details: [
                {
                  timestamp: '2026-05-18T09:00:00+08:00',
                  source: 'account-a',
                  auth_index: 1,
                  failed: false,
                  latency_ms: 26_000,
                  tokens: {
                    input_tokens: 2_000_000,
                    cached_tokens: 500_000,
                    output_tokens: 100_000,
                    total_tokens: 2_600_000,
                  },
                },
                {
                  timestamp: '2026-05-17T23:59:59+08:00',
                  source: 'account-a',
                  auth_index: 1,
                  failed: false,
                  tokens: {
                    input_tokens: 1_000_000,
                    output_tokens: 100_000,
                    total_tokens: 1_100_000,
                  },
                },
              ],
            },
          },
        },
        'POST /v1/responses': {
          models: {
            'gpt-5-mini': {
              details: [
                {
                  timestamp: '2026-05-18T15:30:00+08:00',
                  source: 'account-b',
                  auth_index: 2,
                  failed: true,
                  latency_ms: 28_000,
                  tokens: {
                    input_tokens: 100,
                    output_tokens: 20,
                  },
                },
              ],
            },
          },
        },
      },
    };

    const summary = buildTodayUsageSummary(
      usage,
      {
        'gpt-5': {
          prompt: 1,
          completion: 10,
          cache: 0.1,
        },
      },
      Date.parse('2026-05-18T18:00:00+08:00')
    );

    expect(summary).toMatchObject({
      hasUsageData: true,
      requestCount: 2,
      successCount: 1,
      failedCount: 1,
      accountCount: 2,
      pricedRequestCount: 1,
      successRate: 50,
      averageLatencyMs: 27_000,
      totalTokens: 2_600_120,
      inputTokens: 2_000_100,
      outputTokens: 100_020,
      reasoningTokens: 0,
      cachedTokens: 500_000,
      estimatedCostUsd: 2.55,
    });
    expect(summary.inputShare).toBeCloseTo(76.9233, 3);
    expect(summary.outputShare).toBeCloseTo(3.8467, 3);
    expect(summary.cacheHitRate).toBeCloseTo(24.9987, 3);
  });

  it('classifies token invalidation as a login action instead of a generic error', () => {
    const account = createAccount({
      status: 'error',
      statusText: 'Authentication token has been invalidated',
      error: 'token_invalidated',
    });

    expect(normalizeQuotaErrorReason(account)).toBe('Token已失效');
  });

  it('classifies business status independently from the local disabled switch', () => {
    expect(
      getCodexQuotaBusinessStatus(
        createAccount({ disabled: true, status: 'disabled', currentRemainingPercent: 100 })
      )
    ).toBe('callable');
    expect(
      getCodexQuotaBusinessStatus(
        createAccount({ disabled: true, status: 'disabled', currentRemainingPercent: 0 })
      )
    ).toBe('limited');
    expect(
      getCodexQuotaBusinessStatus(
        createAccount({ disabled: true, status: 'disabled', currentRemainingPercent: 5 })
      )
    ).toBe('limited');
    expect(
      getCodexQuotaBusinessStatus(
        createAccount({
          disabled: true,
          status: 'error',
          statusText: 'HTTP 401',
          error: 'token_invalidated',
        })
      )
    ).toBe('error');
    expect(
      getCodexQuotaBusinessStatus(
        createAccount({
          status: 'error',
          statusText: '查询失败',
          error: 'context deadline exceeded',
        })
      )
    ).toBe('unknown');
  });

  it('keeps accounts in today restored history after the reset time rolls to the next window', () => {
    const previous = [
      createAccount({
        file: 'restored.json',
        account: 'restored@example.com',
        currentResetAt: '2026-05-18 15:45:54',
      }),
      createAccount({
        file: 'future.json',
        account: 'future@example.com',
        currentResetAt: '2026-05-18 20:00:00',
      }),
    ];
    const next = [
      createAccount({
        file: 'restored.json',
        account: 'restored@example.com',
        currentResetAt: '2026-05-25 16:30:00',
      }),
      createAccount({
        file: 'future.json',
        account: 'future@example.com',
        currentResetAt: '2026-05-18 20:00:00',
      }),
    ];

    const history = buildTodayRestoredHistory({
      previousAccounts: previous,
      nextAccounts: next,
      existingHistory: [],
      now: Date.parse('2026-05-18T16:30:00+08:00'),
    });

    expect(history).toEqual([
      {
        file: 'restored.json',
        account: 'restored@example.com',
        restoredAt: '2026-05-18 15:45:54',
        detectedAt: '2026-05-18 16:30:00',
        resetAfter: '2026-05-25 16:30:00',
      },
    ]);
  });

  it('keeps only today restored history and deduplicates repeated refreshes', () => {
    const existingHistory = [
      {
        file: 'restored.json',
        account: 'restored@example.com',
        restoredAt: '2026-05-18 15:45:54',
        detectedAt: '2026-05-18 16:20:00',
        resetAfter: '2026-05-25 16:20:00',
      },
      {
        file: 'old.json',
        account: 'old@example.com',
        restoredAt: '2026-05-17 15:45:54',
        detectedAt: '2026-05-17 16:20:00',
        resetAfter: '2026-05-24 16:20:00',
      },
    ];

    const history = buildTodayRestoredHistory({
      previousAccounts: [
        createAccount({
          file: 'restored.json',
          account: 'restored@example.com',
          currentResetAt: '2026-05-18 15:45:54',
        }),
      ],
      nextAccounts: [
        createAccount({
          file: 'restored.json',
          account: 'restored@example.com',
          currentResetAt: '2026-05-25 16:30:00',
        }),
      ],
      existingHistory,
      now: Date.parse('2026-05-18T16:30:00+08:00'),
    });

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      file: 'restored.json',
      restoredAt: '2026-05-18 15:45:54',
    });
  });

  it('groups recovery times by Beijing natural day distance', () => {
    const now = Date.parse('2026-05-18T17:30:00+08:00');

    expect(getRecoveryDayBucketKey('2026-05-18 16:30:00', now)).toBe('restored');
    expect(getRecoveryDayBucketKey('2026-05-18 23:59:59', now)).toBe('today');
    expect(getRecoveryDayBucketKey('2026-05-19 00:00:00', now)).toBe('tomorrow');
    expect(getRecoveryDayBucketKey('2026-05-20 09:00:00', now)).toBe('day2');
    expect(getRecoveryDayBucketKey('2026-05-25 09:00:00', now)).toBe('day7');
    expect(getRecoveryDayBucketKey('2026-05-26 09:00:00', now)).toBe('later');
    expect(getRecoveryDayBucketKey('', now)).toBe('unknown');
  });
});
