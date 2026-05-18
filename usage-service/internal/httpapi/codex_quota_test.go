package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

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
	values := []int{0, 20, 50, 80, 90, 100}
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
		{Label: "1-20%", Count: 1},
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

func TestAutoDisableUnavailableCodexAccountsDisablesLimitedAndError(t *testing.T) {
	authDir := t.TempDir()
	writeTestCodexAuth(t, authDir, "limited.json", false)
	writeTestCodexAuth(t, authDir, "error.json", false)
	writeTestCodexAuth(t, authDir, "available.json", false)

	accounts := []codexQuotaAccount{
		{File: "limited.json", Status: "limited", StatusText: "受限"},
		{File: "error.json", Status: "error", StatusText: "HTTP 401", Error: "token invalidated"},
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
		t.Fatalf("error account = %+v, want disabled", updated[1])
	}
	if updated[1].StatusText != "已自动停用：异常" {
		t.Fatalf("error status text = %q", updated[1].StatusText)
	}
	if updated[2].Disabled || updated[2].Status != "available" {
		t.Fatalf("available account = %+v, want unchanged", updated[2])
	}
	if !readDisabledFlag(t, authDir, "limited.json") {
		t.Fatal("limited auth file should be disabled")
	}
	if !readDisabledFlag(t, authDir, "error.json") {
		t.Fatal("error auth file should be disabled")
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
