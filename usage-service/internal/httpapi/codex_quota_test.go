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

	"github.com/seakee/cpa-manager/usage-service/internal/config"
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

func TestHandleCodexQuotaListOnlyQueriesAndDoesNotDisableAuth(t *testing.T) {
	authDir := t.TempDir()
	writeTestCodexAuth(t, authDir, "limited@example.com.json", false)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"plan_type": "free",
			"rate_limit": {
				"allowed": false,
				"limit_reached": true,
				"primary_window": {
					"used_percent": 100,
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

	server := &Server{cfg: configWithCodexAuthDir(authDir)}
	req := httptest.NewRequest(http.MethodGet, "/v0/management/codex-quota", nil)
	recorder := httptest.NewRecorder()

	server.handleCodexQuotaList(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if readDisabledFlag(t, authDir, "limited@example.com.json") {
		t.Fatal("querying quota should not write disabled=true to auth file")
	}
	var payload codexQuotaResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Accounts) != 1 || payload.Accounts[0].Status != "limited" {
		t.Fatalf("accounts = %+v, want limited account in response", payload.Accounts)
	}
}

func configWithCodexAuthDir(authDir string) config.Config {
	return config.Config{CodexAuthDir: authDir}
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
