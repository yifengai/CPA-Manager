package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/seakee/cpa-manager/usage-service/internal/config"
)

func TestParseRequestLogFileExtractsRequestRoutingAndResponses(t *testing.T) {
	logDir := t.TempDir()
	logPath := writeRequestLogFixture(t, logDir, "v1-responses-2026-05-20T010203-deadbeef.log")

	trace, err := parseRequestLogFile(logPath)
	if err != nil {
		t.Fatalf("parseRequestLogFile() error = %v", err)
	}

	if trace.Summary.RequestID != "deadbeef" {
		t.Fatalf("request id = %q, want deadbeef", trace.Summary.RequestID)
	}
	if trace.Summary.Method != "POST" || trace.Summary.Path != "/v1/responses" {
		t.Fatalf("request route = %s %s", trace.Summary.Method, trace.Summary.Path)
	}
	if trace.Summary.Auth != "provider=codex, auth_id=sample-free.json, label=sample@example.com, type=oauth" {
		t.Fatalf("auth = %q", trace.Summary.Auth)
	}
	if len(trace.UserMessages) != 1 || trace.UserMessages[0].Text != "请解释这条请求链路" {
		t.Fatalf("user messages = %#v", trace.UserMessages)
	}
	if trace.FinalText != "这是返回内容。" {
		t.Fatalf("final text = %q", trace.FinalText)
	}
	if trace.Summary.TotalTokens != 123 {
		t.Fatalf("total tokens = %d, want 123", trace.Summary.TotalTokens)
	}
	if len(trace.UpstreamEvents) != 1 || len(trace.ResponsesEvents) != 2 {
		t.Fatalf("event counts upstream=%d responses=%d", len(trace.UpstreamEvents), len(trace.ResponsesEvents))
	}
}

func TestRequestLogsEndpointGroupsTasksAndReturnsDetail(t *testing.T) {
	logDir := t.TempDir()
	writeRequestLogFixture(t, logDir, "v1-responses-2026-05-20T010203-deadbeef.log")
	writeRequestLogFixture(t, logDir, "v1-responses-2026-05-20T010204-feedbabe.log")

	handler := newTestHandlerWithConfig(t, config.Config{RequestLogDir: logDir})
	req := httptest.NewRequest(http.MethodGet, "/v0/management/request-logs/tasks?limit=20", nil)
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var list requestLogListResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if list.Total != 2 || len(list.Tasks) != 1 || list.Tasks[0].RequestCount != 2 {
		t.Fatalf("list = %#v", list)
	}
	if list.Tasks[0].TotalTokens != 246 {
		t.Fatalf("task total tokens = %d, want 246", list.Tasks[0].TotalTokens)
	}

	req = httptest.NewRequest(http.MethodGet, "/v0/management/request-logs/deadbeef", nil)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("detail status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var detail requestLogTrace
	if err := json.Unmarshal(rr.Body.Bytes(), &detail); err != nil {
		t.Fatalf("decode detail: %v", err)
	}
	if detail.Summary.RequestID != "deadbeef" || !strings.Contains(detail.RequestRaw, "请解释") {
		t.Fatalf("detail = %#v", detail.Summary)
	}
}

func writeRequestLogFixture(t *testing.T, dir string, name string) string {
	t.Helper()
	content := `=== REQUEST INFO ===
Timestamp: 2026-05-20T01:02:03+08:00
Method: POST
Path: /v1/responses

=== HEADERS ===
content-type: application/json

=== REQUEST BODY ===
{"model":"gpt-5.5","input":[{"role":"user","content":[{"type":"input_text","text":"请解释这条请求链路"}]}]}

=== API REQUEST 1 ===
Upstream URL: https://chatgpt.com/backend-api/codex/responses
HTTP Method: POST
Auth: provider=codex, auth_id=sample-free.json, label=sample@example.com, type=oauth

Body:
{"model":"gpt-5.5"}

=== API RESPONSE 1 ===
event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"这是返回内容。"}

=== RESPONSE ===
event: response.output_text.done
data: {"type":"response.output_text.done","text":"这是返回内容。"}

event: response.completed
data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":100,"output_tokens":23,"total_tokens":123}}}
`
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
