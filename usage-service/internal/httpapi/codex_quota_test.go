package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/seakee/cpa-manager/usage-service/internal/usage"
)

func TestLoadCodexAuthFilesIncludesImportedAt(t *testing.T) {
	authDir := t.TempDir()
	writeTestCodexAuth(t, authDir, "imported.json", false)

	accounts, err := loadCodexAuthFiles(authDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(accounts) != 1 {
		t.Fatalf("account count = %d, want 1", len(accounts))
	}
	if accounts[0].ImportedAt == "" {
		t.Fatal("importedAt should be populated")
	}
	if _, err := time.ParseInLocation("2006-01-02 15:04:05", accounts[0].ImportedAt, beijingLocation()); err != nil {
		t.Fatalf("importedAt = %q, want Beijing timestamp: %v", accounts[0].ImportedAt, err)
	}
}

func TestFetchCodexQuotaIncludesImportedAt(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"plan_type": "free",
			"rate_limit": {
				"allowed": true,
				"limit_reached": false,
				"primary_window": {
					"used_percent": 10,
					"reset_at": 1770000000
				}
			},
			"credits": {}
		}`))
	}))
	defer upstream.Close()

	previousURL := codexUsageURL
	codexUsageURL = upstream.URL
	t.Cleanup(func() {
		codexUsageURL = previousURL
	})

	account := fetchCodexQuota(context.Background(), codexAuthFile{
		File:        "imported@example.com.json",
		Email:       "imported@example.com",
		ImportedAt:  "2026-05-19 16:02:25",
		AccessToken: "token",
	})

	if account.ImportedAt != "2026-05-19 16:02:25" {
		t.Fatalf("importedAt = %q, want %q", account.ImportedAt, "2026-05-19 16:02:25")
	}
}

func TestFetchCodexQuotaQueriesDisabledAccountsButKeepsThemDisabled(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer disabled-token" {
			t.Fatalf("authorization header = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"plan_type": "plus",
			"rate_limit": {
				"allowed": true,
				"limit_reached": false,
				"primary_window": {
					"used_percent": 25,
					"reset_at": 1770000000
				}
			},
			"credits": {}
		}`))
	}))
	defer upstream.Close()

	previousURL := codexUsageURL
	codexUsageURL = upstream.URL
	t.Cleanup(func() {
		codexUsageURL = previousURL
	})

	account := fetchCodexQuota(context.Background(), codexAuthFile{
		File:        "disabled@example.com.json",
		Email:       "disabled@example.com",
		Disabled:    true,
		AccessToken: "disabled-token",
	})

	if account.Status != "disabled" {
		t.Fatalf("status = %q, want disabled", account.Status)
	}
	if account.CurrentRemainingPercent == nil || *account.CurrentRemainingPercent != 75 {
		t.Fatalf("remaining = %v, want 75", account.CurrentRemainingPercent)
	}
	if account.CurrentResetAt == "" {
		t.Fatal("current reset time should be populated for disabled accounts")
	}
}

func TestBuildCodexQuotaSummaryCountsDisabledByLocalSwitch(t *testing.T) {
	remaining := 90
	accounts := []codexQuotaAccount{
		{Status: "available", CurrentRemainingPercent: &remaining},
		{Disabled: true, Status: "available", CurrentRemainingPercent: &remaining},
	}

	summary := buildCodexQuotaSummary(accounts)

	if summary.Available != 1 {
		t.Fatalf("available = %d, want 1", summary.Available)
	}
	if summary.Disabled != 1 {
		t.Fatalf("disabled = %d, want 1", summary.Disabled)
	}
}

func TestBuildCodexQuotaSummarySplitsHighBalanceBuckets(t *testing.T) {
	values := []int{0, 3, 20, 50, 80, 90, 100}
	accounts := make([]codexQuotaAccount, 0, len(values))
	for _, value := range values {
		remaining := value
		accounts = append(accounts, codexQuotaAccount{
			Status:                  "available",
			CurrentRemainingPercent: &remaining,
		})
	}

	summary := buildCodexQuotaSummary(accounts)

	want := []codexQuotaBucket{
		{Label: "0%", Count: 1},
		{Label: "1-3%", Count: 1},
		{Label: "4-20%", Count: 1},
		{Label: "21-50%", Count: 1},
		{Label: "51-80%", Count: 1},
		{Label: "81-90%", Count: 1},
		{Label: "91-100%", Count: 1},
	}
	if len(summary.Buckets) != len(want) {
		t.Fatalf("bucket count = %d, want %d", len(summary.Buckets), len(want))
	}
	for index := range want {
		if summary.Buckets[index] != want[index] {
			t.Fatalf("bucket[%d] = %+v, want %+v", index, summary.Buckets[index], want[index])
		}
	}
}

func TestApplyCodexCycleUsageAggregatesCurrentWindowByAccount(t *testing.T) {
	accounts := []codexQuotaAccount{
		{
			File:           "alice@example.com.json",
			Account:        "alice@example.com",
			Email:          "alice@example.com",
			CurrentResetAt: "2026-05-22 00:00:00",
		},
		{
			File:           "bob@example.com.json",
			Account:        "bob@example.com",
			Email:          "bob@example.com",
			CurrentResetAt: "2026-05-22 00:00:00",
		},
	}
	inWindow := time.Date(2026, 5, 20, 10, 0, 0, 0, beijingLocation()).UnixMilli()
	outOfWindow := time.Date(2026, 5, 14, 23, 59, 0, 0, beijingLocation()).UnixMilli()

	updated := applyCodexCycleUsage(accounts, []usage.Event{
		{
			TimestampMS:          inWindow,
			AuthFileSnapshot:     "alice@example.com.json",
			AuthProviderSnapshot: "codex",
			InputTokens:          100,
			OutputTokens:         20,
			CachedTokens:         30,
			TotalTokens:          150,
		},
		{
			TimestampMS:          inWindow + 1000,
			AccountSnapshot:      "alice@example.com",
			AuthProviderSnapshot: "codex",
			InputTokens:          50,
			OutputTokens:         10,
			ReasoningTokens:      5,
			TotalTokens:          65,
		},
		{
			TimestampMS:          inWindow,
			AccountSnapshot:      "bob@example.com",
			AuthProviderSnapshot: "claude",
			TotalTokens:          999,
		},
		{
			TimestampMS:     outOfWindow,
			AccountSnapshot: "alice@example.com",
			TotalTokens:     999,
		},
		{
			TimestampMS:     inWindow,
			AccountSnapshot: "alice@example.com",
			TotalTokens:     999,
			Failed:          true,
		},
	})

	if updated[0].CurrentCycleUsage == nil {
		t.Fatal("alice cycle usage should be populated")
	}
	if updated[0].CurrentCycleUsage.RequestCount != 2 {
		t.Fatalf("request count = %d, want 2", updated[0].CurrentCycleUsage.RequestCount)
	}
	if updated[0].CurrentCycleUsage.TotalTokens != 215 {
		t.Fatalf("total tokens = %d, want 215", updated[0].CurrentCycleUsage.TotalTokens)
	}
	if updated[0].CurrentCycleUsage.InputTokens != 150 {
		t.Fatalf("input tokens = %d, want 150", updated[0].CurrentCycleUsage.InputTokens)
	}
	if updated[0].CurrentCycleUsage.OutputTokens != 30 {
		t.Fatalf("output tokens = %d, want 30", updated[0].CurrentCycleUsage.OutputTokens)
	}
	if updated[0].CurrentCycleUsage.WindowStartAt != "2026-05-15 00:00:00" {
		t.Fatalf("window start = %q", updated[0].CurrentCycleUsage.WindowStartAt)
	}
	if updated[1].CurrentCycleUsage == nil {
		t.Fatal("bob cycle usage should be populated with zero usage")
	}
	if updated[1].CurrentCycleUsage.TotalTokens != 0 {
		t.Fatalf("bob total tokens = %d, want 0", updated[1].CurrentCycleUsage.TotalTokens)
	}
}

func TestApplyCodexCycleUsageUsesWeeklyResetWhenCurrentResetMissing(t *testing.T) {
	remaining := 75
	used := 25
	accounts := []codexQuotaAccount{
		{
			File:                 "weekly@example.com.json",
			Account:              "weekly@example.com",
			Email:                "weekly@example.com",
			CurrentResetAt:       "",
			LongRemainingPercent: &remaining,
			LongUsedPercent:      &used,
			LongResetAt:          "2026-05-28 10:08:36",
		},
	}
	inWindow := time.Date(2026, 5, 22, 10, 0, 0, 0, beijingLocation()).UnixMilli()

	updated := applyCodexCycleUsage(accounts, []usage.Event{
		{
			TimestampMS:          inWindow,
			AuthFileSnapshot:     "weekly@example.com.json",
			AuthProviderSnapshot: "codex",
			InputTokens:          400,
			OutputTokens:         20,
			TotalTokens:          420,
		},
	})

	if updated[0].CurrentCycleUsage == nil {
		t.Fatal("weekly cycle usage should be populated from long reset time")
	}
	if updated[0].CurrentCycleUsage.WindowEndAt != "2026-05-28 10:08:36" {
		t.Fatalf("window end = %q", updated[0].CurrentCycleUsage.WindowEndAt)
	}
	if updated[0].CurrentCycleUsage.TotalTokens != 420 {
		t.Fatalf("total tokens = %d, want 420", updated[0].CurrentCycleUsage.TotalTokens)
	}
}

func TestAutoDisableUnavailableCodexAccountsDisablesLimitedAndAuthError(t *testing.T) {
	authDir := t.TempDir()
	writeTestCodexAuth(t, authDir, "limited.json", false)
	writeTestCodexAuth(t, authDir, "low.json", false)
	writeTestCodexAuth(t, authDir, "buffer.json", false)
	writeTestCodexAuth(t, authDir, "error.json", false)
	writeTestCodexAuth(t, authDir, "timeout.json", false)
	writeTestCodexAuth(t, authDir, "available.json", false)
	lowRemaining := 3
	bufferRemaining := 4

	accounts := []codexQuotaAccount{
		{File: "limited.json", Status: "limited", StatusText: "受限"},
		{File: "low.json", Status: "available", StatusText: "可用", CurrentRemainingPercent: &lowRemaining},
		{File: "buffer.json", Status: "available", StatusText: "可用", CurrentRemainingPercent: &bufferRemaining},
		{File: "error.json", Status: "error", StatusText: "HTTP 401", Error: "token invalidated"},
		{File: "timeout.json", Status: "error", StatusText: "查询失败", Error: "context deadline exceeded"},
		{File: "available.json", Status: "available", StatusText: "可用"},
	}

	updated := autoDisableUnavailableCodexAccounts(authDir, accounts)

	if !updated[0].Disabled || updated[0].Status != "disabled" {
		t.Fatalf("limited account = %+v, want disabled", updated[0])
	}
	if updated[0].StatusText != "已自动停用：受限" {
		t.Fatalf("limited status text = %q", updated[0].StatusText)
	}
	if !updated[1].Disabled || updated[1].Status != "disabled" {
		t.Fatalf("low remaining account = %+v, want disabled", updated[1])
	}
	if updated[1].StatusText != "已自动停用：低余量" {
		t.Fatalf("low remaining status text = %q", updated[1].StatusText)
	}
	if updated[1].Error != "余量低于等于3%，默认停用" {
		t.Fatalf("low remaining error = %q", updated[1].Error)
	}
	if updated[2].Disabled || updated[2].Status != "available" {
		t.Fatalf("buffer account = %+v, want unchanged available", updated[2])
	}
	if !updated[3].Disabled || updated[3].Status != "disabled" {
		t.Fatalf("error account = %+v, want disabled", updated[3])
	}
	if updated[3].StatusText != "已自动停用：异常" {
		t.Fatalf("error status text = %q", updated[3].StatusText)
	}
	if updated[4].Disabled || updated[4].Status != "error" {
		t.Fatalf("timeout account = %+v, want unchanged error", updated[4])
	}
	if updated[5].Disabled || updated[5].Status != "available" {
		t.Fatalf("available account = %+v, want unchanged", updated[5])
	}
	if !readDisabledFlag(t, authDir, "limited.json") {
		t.Fatal("limited auth file should be disabled")
	}
	if !readDisabledFlag(t, authDir, "low.json") {
		t.Fatal("low remaining auth file should be disabled")
	}
	if readDisabledFlag(t, authDir, "buffer.json") {
		t.Fatal("buffer auth file should stay enabled")
	}
	if !readDisabledFlag(t, authDir, "error.json") {
		t.Fatal("error auth file should be disabled")
	}
	if readDisabledFlag(t, authDir, "timeout.json") {
		t.Fatal("timeout auth file should stay enabled")
	}
	if readDisabledFlag(t, authDir, "available.json") {
		t.Fatal("available auth file should stay enabled")
	}
}

func writeTestCodexAuth(t *testing.T, authDir string, name string, disabled bool) {
	t.Helper()
	payload := map[string]any{
		"type":         "codex",
		"email":        name + "@example.com",
		"access_token": "token",
		"disabled":     disabled,
	}
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(authDir, name), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func readDisabledFlag(t *testing.T, authDir string, name string) bool {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(authDir, name))
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatal(err)
	}
	disabled, _ := payload["disabled"].(bool)
	return disabled
}
