package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const codexProtectionTransientFailureThreshold = 2

type codexProtectionResponse struct {
	GeneratedAt      string                         `json:"generatedAt"`
	LogDir           string                         `json:"logDir"`
	ScannedRequests  int                            `json:"scannedRequests"`
	MatchedAccounts  int                            `json:"matchedAccounts"`
	ProtectionCount  int                            `json:"protectionCount"`
	AlreadyDisabled  int                            `json:"alreadyDisabled"`
	ObservationCount int                            `json:"observationCount"`
	DryRun           bool                           `json:"dryRun"`
	Results          []codexProtectionAccountResult `json:"results"`
}

type codexProtectionAccountResult struct {
	File                string         `json:"file"`
	Label               string         `json:"label"`
	Action              string         `json:"action"`
	Reason              string         `json:"reason"`
	Failures            int            `json:"failures"`
	ConsecutiveFailures int            `json:"consecutiveFailures"`
	LastSeenAt          string         `json:"lastSeenAt"`
	LastFailureAt       string         `json:"lastFailureAt"`
	FailureTypes        map[string]int `json:"failureTypes"`
}

type codexProtectionAccountStats struct {
	file                string
	label               string
	total               int
	failures            int
	consecutiveFailures int
	lastSeenAt          string
	lastFailureAt       string
	seenSuccess         bool
	failureTypes        map[string]int
	consecutiveTypes    map[string]int
}

type codexProtectionFailure struct {
	failed   bool
	category string
	reason   string
}

func (s *Server) handleCodexQuotaProtect(w http.ResponseWriter, r *http.Request) {
	limit := requestLogLimitFromQuery(r)
	dryRun := strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("dryRun")), "true")
	response, err := protectCodexAccountPool(s.cfg.CodexAuthDir, s.cfg.RequestLogDir, limit, dryRun)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func protectCodexAccountPool(authDir string, logDir string, limit int, dryRun bool) (codexProtectionResponse, error) {
	files, err := listRequestLogFiles(logDir, limit)
	if err != nil {
		return codexProtectionResponse{}, err
	}
	statsByFile := map[string]*codexProtectionAccountStats{}
	scanned := 0
	for _, file := range files {
		trace, err := parseRequestLogFile(file)
		if err != nil {
			continue
		}
		scanned++
		failure := classifyCodexProtectionFailure(trace)
		seenInRequest := map[string]struct{}{}
		for _, routing := range trace.Routing {
			meta := parseRequestLogAuthMeta(routing.Auth)
			if strings.ToLower(meta["provider"]) != "codex" {
				continue
			}
			authFile := filepath.Base(strings.TrimSpace(meta["auth_id"]))
			if authFile == "" || authFile == "." || !strings.HasSuffix(authFile, ".json") {
				continue
			}
			if _, ok := seenInRequest[authFile]; ok {
				continue
			}
			seenInRequest[authFile] = struct{}{}
			stats := statsByFile[authFile]
			if stats == nil {
				stats = &codexProtectionAccountStats{
					file:             authFile,
					label:            strings.TrimSpace(meta["label"]),
					failureTypes:     map[string]int{},
					consecutiveTypes: map[string]int{},
				}
				statsByFile[authFile] = stats
			}
			recordCodexProtectionTrace(stats, trace, failure)
		}
	}

	results := make([]codexProtectionAccountResult, 0, len(statsByFile))
	for _, stats := range statsByFile {
		result := buildCodexProtectionResult(authDir, stats, dryRun)
		results = append(results, result)
	}
	sort.Slice(results, func(i, j int) bool {
		leftRank, rightRank := codexProtectionActionRank(results[i].Action), codexProtectionActionRank(results[j].Action)
		if leftRank != rightRank {
			return leftRank < rightRank
		}
		return strings.ToLower(results[i].File) < strings.ToLower(results[j].File)
	})

	response := codexProtectionResponse{
		GeneratedAt:     beijingNowText(),
		LogDir:          logDir,
		ScannedRequests: scanned,
		MatchedAccounts: len(results),
		DryRun:          dryRun,
		Results:         results,
	}
	for _, result := range results {
		switch result.Action {
		case "protected":
			response.ProtectionCount++
		case "already_disabled":
			response.AlreadyDisabled++
		case "observe":
			response.ObservationCount++
		}
	}
	return response, nil
}

func recordCodexProtectionTrace(stats *codexProtectionAccountStats, trace requestLogTrace, failure codexProtectionFailure) {
	stats.total++
	if stats.lastSeenAt == "" {
		stats.lastSeenAt = trace.Summary.UpdatedAt
	}
	if !failure.failed {
		stats.seenSuccess = true
		return
	}
	stats.failures++
	stats.failureTypes[failure.category]++
	if stats.lastFailureAt == "" {
		stats.lastFailureAt = trace.Summary.UpdatedAt
	}
	if !stats.seenSuccess {
		stats.consecutiveFailures++
		stats.consecutiveTypes[failure.category]++
	}
}

func buildCodexProtectionResult(authDir string, stats *codexProtectionAccountStats, dryRun bool) codexProtectionAccountResult {
	result := codexProtectionAccountResult{
		File:                stats.file,
		Label:               firstNonEmpty(stats.label, strings.TrimSuffix(stats.file, filepath.Ext(stats.file))),
		Action:              "keep",
		Reason:              "最近请求未触发保护规则",
		Failures:            stats.failures,
		ConsecutiveFailures: stats.consecutiveFailures,
		LastSeenAt:          stats.lastSeenAt,
		LastFailureAt:       stats.lastFailureAt,
		FailureTypes:        cloneStringIntMap(stats.failureTypes),
	}
	shouldProtect, reason := shouldProtectCodexAccount(stats)
	if !shouldProtect {
		if stats.consecutiveFailures > 0 {
			result.Action = "observe"
			result.Reason = reason
		}
		return result
	}
	disabled, err := readCodexAuthDisabled(authDir, stats.file)
	if err != nil {
		result.Action = "error"
		result.Reason = err.Error()
		return result
	}
	if disabled {
		result.Action = "already_disabled"
		result.Reason = reason
		return result
	}
	if dryRun {
		result.Action = "would_protect"
		result.Reason = reason
		return result
	}
	if _, err := updateCodexAuthDisabled(authDir, stats.file, true); err != nil {
		result.Action = "error"
		result.Reason = err.Error()
		return result
	}
	result.Action = "protected"
	result.Reason = reason
	return result
}

func shouldProtectCodexAccount(stats *codexProtectionAccountStats) (bool, string) {
	if stats.consecutiveFailures <= 0 {
		return false, "最近请求未失败"
	}
	if stats.consecutiveTypes["auth"] > 0 {
		return true, "认证失败，已从调用池移出"
	}
	if stats.consecutiveTypes["permission"] > 0 {
		return true, "权限或访问被拒绝，已从调用池移出"
	}
	if stats.consecutiveTypes["limited"] > 0 {
		return true, "账号受限或额度耗尽，已从调用池移出"
	}
	if stats.consecutiveFailures >= codexProtectionTransientFailureThreshold {
		return true, fmt.Sprintf("连续失败 %d 次，已触发保护停用", stats.consecutiveFailures)
	}
	return false, "仅出现一次短暂失败，先观察"
}

func classifyCodexProtectionFailure(trace requestLogTrace) codexProtectionFailure {
	statusCode := requestLogHTTPStatus(trace.Sections)
	text := strings.ToLower(strings.Join([]string{
		trace.Summary.Status,
		firstRequestLogSection(trace.Sections, "API RESPONSE"),
		firstRequestLogSection(trace.Sections, "RESPONSE"),
	}, "\n"))
	failed := trace.Summary.HasError || statusCode >= 400 || hasFailureEvent(trace.UpstreamEvents) || hasFailureEvent(trace.ResponsesEvents)
	if !failed {
		return codexProtectionFailure{}
	}
	switch {
	case statusCode == http.StatusUnauthorized ||
		strings.Contains(text, "unauthorized") ||
		strings.Contains(text, "invalid token") ||
		strings.Contains(text, "token expired"):
		return codexProtectionFailure{failed: true, category: "auth", reason: "认证失败"}
	case statusCode == http.StatusForbidden ||
		strings.Contains(text, "forbidden") ||
		strings.Contains(text, "no access"):
		return codexProtectionFailure{failed: true, category: "permission", reason: "访问被拒绝"}
	case statusCode == http.StatusTooManyRequests ||
		strings.Contains(text, "rate limit") ||
		strings.Contains(text, "too many requests") ||
		strings.Contains(text, "limit reached") ||
		strings.Contains(text, "quota") ||
		strings.Contains(text, "exceeded"):
		return codexProtectionFailure{failed: true, category: "limited", reason: "账号受限"}
	case statusCode == http.StatusRequestTimeout ||
		strings.Contains(text, "timeout") ||
		strings.Contains(text, "deadline exceeded"):
		return codexProtectionFailure{failed: true, category: "timeout", reason: "请求超时"}
	case statusCode >= 500:
		return codexProtectionFailure{failed: true, category: "upstream", reason: "上游错误"}
	default:
		return codexProtectionFailure{failed: true, category: "error", reason: "请求失败"}
	}
}

func hasFailureEvent(events []requestLogEvent) bool {
	for _, event := range events {
		value := strings.ToLower(strings.Join([]string{event.Event, event.Type, event.Summary}, " "))
		if strings.Contains(value, "failed") || strings.Contains(value, "error") {
			return true
		}
	}
	return false
}

func requestLogHTTPStatus(sections []requestLogSection) int {
	response := firstRequestLogSection(sections, "RESPONSE")
	for _, line := range strings.Split(response, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "Status:") {
			continue
		}
		raw := strings.TrimSpace(strings.TrimPrefix(line, "Status:"))
		status, err := strconv.Atoi(raw)
		if err == nil {
			return status
		}
	}
	return 0
}

func parseRequestLogAuthMeta(raw string) map[string]string {
	meta := map[string]string{}
	for _, part := range strings.Split(raw, ",") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		meta[strings.ToLower(strings.TrimSpace(key))] = strings.TrimSpace(value)
	}
	return meta
}

func readCodexAuthDisabled(authDir string, file string) (bool, error) {
	path, err := safeCodexAuthPath(authDir, file)
	if err != nil {
		return false, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		return false, err
	}
	if payload["type"] != "codex" {
		return false, errors.New("only codex auth files can be protected")
	}
	disabled, _ := payload["disabled"].(bool)
	return disabled, nil
}

func cloneStringIntMap(input map[string]int) map[string]int {
	if len(input) == 0 {
		return map[string]int{}
	}
	output := make(map[string]int, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

func codexProtectionActionRank(action string) int {
	switch action {
	case "protected", "would_protect":
		return 0
	case "already_disabled":
		return 1
	case "observe":
		return 2
	case "error":
		return 3
	default:
		return 4
	}
}
