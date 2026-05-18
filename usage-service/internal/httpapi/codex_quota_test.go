package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
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
