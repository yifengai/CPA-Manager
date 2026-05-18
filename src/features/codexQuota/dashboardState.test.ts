import { describe, expect, it } from 'vitest';
import type { CodexQuotaAccount } from '@/services/api';
import {
  buildPriorityAccounts,
  buildRefreshReport,
  buildTodayRestoredHistory,
  getAccountHealth,
  getRecoveryDayBucketKey,
  isCodexQuotaUnavailable,
  normalizeQuotaErrorReason,
} from './dashboardState';

const createAccount = (overrides: Partial<CodexQuotaAccount> = {}): CodexQuotaAccount => ({
  file: overrides.file ?? `${overrides.account ?? 'account@example.com'}.json`,
  account: overrides.account ?? 'account@example.com',
  email: overrides.email ?? overrides.account ?? 'account@example.com',
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
  it('classifies token invalidation as a login action instead of a generic error', () => {
    const account = createAccount({
      status: 'error',
      statusText: 'Authentication token has been invalidated',
      error: 'token_invalidated',
    });

    expect(normalizeQuotaErrorReason(account)).toBe('Token已失效');
    expect(getAccountHealth(account)).toMatchObject({
      label: '需要重新登录',
      tone: 'danger',
      rank: 1,
    });
  });

  it('prioritizes accounts that need action before low-balance observation accounts', () => {
    const accounts = [
      createAccount({ account: 'healthy@example.com', currentRemainingPercent: 90 }),
      createAccount({ account: 'low@example.com', currentRemainingPercent: 18 }),
      createAccount({
        account: 'limited@example.com',
        status: 'limited',
        limitReached: true,
        currentRemainingPercent: 0,
      }),
      createAccount({ account: 'disabled@example.com', disabled: true, status: 'disabled' }),
    ];

    expect(buildPriorityAccounts(accounts).map((account) => account.account)).toEqual([
      'limited@example.com',
      'low@example.com',
    ]);
  });

  it('summarizes refresh results with action-oriented counts', () => {
    const report = buildRefreshReport({
      requestedCount: 3,
      refreshedAccounts: [
        createAccount({ account: 'ok@example.com' }),
        createAccount({
          account: 'limited@example.com',
          status: 'limited',
          limitReached: true,
          currentRemainingPercent: 0,
        }),
        createAccount({
          account: 'token@example.com',
          status: 'error',
          error: 'token_invalidated',
        }),
      ],
      startedAt: 1_000,
      endedAt: 2_450,
    });

    expect(report).toMatchObject({
      requestedCount: 3,
      refreshedCount: 3,
      limitedCount: 1,
      errorCount: 1,
      tokenInvalidCount: 1,
      durationText: '1.5秒',
    });
  });

  it('treats only non-disabled query failures as unavailable accounts', () => {
    expect(
      isCodexQuotaUnavailable(
        createAccount({ status: 'error', statusText: 'HTTP 401', error: 'token_invalidated' })
      )
    ).toBe(true);

    expect(
      isCodexQuotaUnavailable(
        createAccount({ status: 'limited', limitReached: true, currentRemainingPercent: 0 })
      )
    ).toBe(false);
    expect(isCodexQuotaUnavailable(createAccount({ currentRemainingPercent: 5 }))).toBe(false);
    expect(
      isCodexQuotaUnavailable(
        createAccount({ disabled: true, status: 'disabled', error: 'HTTP 401' })
      )
    ).toBe(false);
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
