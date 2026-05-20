package httpapi

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestProtectCodexAccountPoolDisablesLimitedAccount(t *testing.T) {
	authDir := t.TempDir()
	logDir := t.TempDir()
	writeTestCodexAuth(t, authDir, "limited@example.com.json", false)
	writeProtectionLog(t, logDir, "v1-responses-limited.log", "limited@example.com.json", 429, `{"error":{"message":"rate limit exceeded"}}`, time.Now())

	result, err := protectCodexAccountPool(authDir, logDir, 20, false)
	if err != nil {
		t.Fatalf("protectCodexAccountPool returned error: %v", err)
	}
	if result.ProtectionCount != 1 {
		t.Fatalf("ProtectionCount = %d, want 1; result=%+v", result.ProtectionCount, result)
	}
	if !readDisabledFlag(t, authDir, "limited@example.com.json") {
		t.Fatal("limited account should be disabled")
	}
	if result.Results[0].Action != "protected" {
		t.Fatalf("action = %q, want protected", result.Results[0].Action)
	}
}

func TestProtectCodexAccountPoolObservesSingleTransientFailure(t *testing.T) {
	authDir := t.TempDir()
	logDir := t.TempDir()
	writeTestCodexAuth(t, authDir, "transient@example.com.json", false)
	writeProtectionLog(t, logDir, "v1-responses-timeout.log", "transient@example.com.json", 504, `{"error":{"message":"upstream timeout"}}`, time.Now())

	result, err := protectCodexAccountPool(authDir, logDir, 20, false)
	if err != nil {
		t.Fatalf("protectCodexAccountPool returned error: %v", err)
	}
	if result.ProtectionCount != 0 {
		t.Fatalf("ProtectionCount = %d, want 0; result=%+v", result.ProtectionCount, result)
	}
	if readDisabledFlag(t, authDir, "transient@example.com.json") {
		t.Fatal("single transient failure should not disable account")
	}
	if result.Results[0].Action != "observe" {
		t.Fatalf("action = %q, want observe", result.Results[0].Action)
	}
}

func TestProtectCodexAccountPoolDisablesConsecutiveTransientFailures(t *testing.T) {
	authDir := t.TempDir()
	logDir := t.TempDir()
	writeTestCodexAuth(t, authDir, "flaky@example.com.json", false)
	now := time.Now()
	writeProtectionLog(t, logDir, "v1-responses-timeout-new.log", "flaky@example.com.json", 504, `{"error":{"message":"upstream timeout"}}`, now)
	writeProtectionLog(t, logDir, "v1-responses-timeout-old.log", "flaky@example.com.json", 500, `{"error":{"message":"upstream failed"}}`, now.Add(-time.Minute))

	result, err := protectCodexAccountPool(authDir, logDir, 20, false)
	if err != nil {
		t.Fatalf("protectCodexAccountPool returned error: %v", err)
	}
	if result.ProtectionCount != 1 {
		t.Fatalf("ProtectionCount = %d, want 1; result=%+v", result.ProtectionCount, result)
	}
	if !readDisabledFlag(t, authDir, "flaky@example.com.json") {
		t.Fatal("consecutive transient failures should disable account")
	}
}

func TestProtectCodexAccountPoolStopsConsecutiveCountAfterSuccess(t *testing.T) {
	authDir := t.TempDir()
	logDir := t.TempDir()
	writeTestCodexAuth(t, authDir, "recovered@example.com.json", false)
	now := time.Now()
	writeProtectionLog(t, logDir, "v1-responses-success-new.log", "recovered@example.com.json", 200, `event: response.completed`, now)
	writeProtectionLog(t, logDir, "v1-responses-timeout-old.log", "recovered@example.com.json", 504, `{"error":{"message":"upstream timeout"}}`, now.Add(-time.Minute))

	result, err := protectCodexAccountPool(authDir, logDir, 20, false)
	if err != nil {
		t.Fatalf("protectCodexAccountPool returned error: %v", err)
	}
	if result.ProtectionCount != 0 {
		t.Fatalf("ProtectionCount = %d, want 0; result=%+v", result.ProtectionCount, result)
	}
	if readDisabledFlag(t, authDir, "recovered@example.com.json") {
		t.Fatal("recent successful account should not be disabled")
	}
}

func writeProtectionLog(t *testing.T, dir string, name string, authFile string, status int, response string, modTime time.Time) {
	t.Helper()
	body := `=== REQUEST INFO ===
Version: test
URL: /v1/responses
Method: POST
Timestamp: 2026-05-20T10:00:00+08:00

=== REQUEST BODY ===
{"model":"gpt-5.5","input":[{"role":"user","content":"hello"}]}

=== API REQUEST 1 ===
Timestamp: 2026-05-20T10:00:00+08:00
Upstream URL: https://chatgpt.com/backend-api/codex/responses
HTTP Method: POST
Auth: provider=codex, auth_id=` + authFile + `, label=` + authFile + `, type=oauth

Body:
{"model":"gpt-5.5"}

=== API RESPONSE ===
` + response + `

=== RESPONSE ===
Status: ` + statusText(status) + `

` + response + `
`
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write log: %v", err)
	}
	if err := os.Chtimes(path, modTime, modTime); err != nil {
		t.Fatalf("chtimes log: %v", err)
	}
}

func statusText(status int) string {
	return string(rune('0'+status/100)) + string(rune('0'+status/10%10)) + string(rune('0'+status%10))
}
