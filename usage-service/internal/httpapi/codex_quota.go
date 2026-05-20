package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	codexQuotaWorkers        = 32
	codexQuotaRequestTimeout = 12 * time.Second
)

var codexUsageURL = "https://chatgpt.com/backend-api/wham/usage"

type codexAuthFile struct {
	File         string `json:"-"`
	Type         string `json:"type"`
	Email        string `json:"email"`
	AccountID    string `json:"account_id"`
	ImportedAt   string `json:"-"`
	Disabled     bool   `json:"disabled"`
	Expired      string `json:"expired"`
	LastRefresh  string `json:"last_refresh"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
}

type codexQuotaAccount struct {
	File                    string  `json:"file"`
	Account                 string  `json:"account"`
	Email                   string  `json:"email"`
	ImportedAt              string  `json:"importedAt"`
	Disabled                bool    `json:"disabled"`
	Status                  string  `json:"status"`
	StatusText              string  `json:"statusText"`
	Plan                    string  `json:"plan"`
	Allowed                 *bool   `json:"allowed,omitempty"`
	LimitReached            *bool   `json:"limitReached,omitempty"`
	CurrentRemainingPercent *int    `json:"currentRemainingPercent,omitempty"`
	CurrentUsedPercent      *int    `json:"currentUsedPercent,omitempty"`
	CurrentResetAt          string  `json:"currentResetAt"`
	LongWindowText          string  `json:"longWindowText"`
	LongRemainingPercent    *int    `json:"longRemainingPercent,omitempty"`
	LongUsedPercent         *int    `json:"longUsedPercent,omitempty"`
	LongResetAt             string  `json:"longResetAt"`
	CreditsBalance          any     `json:"creditsBalance,omitempty"`
	TokenExpiredAt          string  `json:"tokenExpiredAt"`
	LastRefreshAt           string  `json:"lastRefreshAt"`
	LatencyMS               int64   `json:"latencyMs,omitempty"`
	Error                   string  `json:"error"`
	SortRemaining           float64 `json:"sortRemaining"`
}

type codexQuotaSummary struct {
	GeneratedAt string             `json:"generatedAt"`
	Total       int                `json:"total"`
	Available   int                `json:"available"`
	Limited     int                `json:"limited"`
	Disabled    int                `json:"disabled"`
	Errors      int                `json:"errors"`
	Low         int                `json:"low"`
	Critical    int                `json:"critical"`
	Average     *float64           `json:"average"`
	Median      *float64           `json:"median"`
	Plans       map[string]int     `json:"plans"`
	Buckets     []codexQuotaBucket `json:"buckets"`
}

type codexQuotaBucket struct {
	Label string `json:"label"`
	Count int    `json:"count"`
}

type codexQuotaResponse struct {
	Summary  codexQuotaSummary   `json:"summary"`
	Accounts []codexQuotaAccount `json:"accounts"`
}

type codexQuotaActionRequest struct {
	File     string `json:"file"`
	Disabled *bool  `json:"disabled,omitempty"`
}

type codexQuotaRefreshRequest struct {
	Files []string `json:"files"`
}

type codexUsageWindow struct {
	UsedPercent any `json:"used_percent"`
	ResetAt     any `json:"reset_at"`
}

type codexRateLimitInfo struct {
	Allowed         bool              `json:"allowed"`
	LimitReached    bool              `json:"limit_reached"`
	PrimaryWindow   *codexUsageWindow `json:"primary_window"`
	SecondaryWindow *codexUsageWindow `json:"secondary_window"`
}

type codexUsageResponse struct {
	PlanType  string             `json:"plan_type"`
	RateLimit codexRateLimitInfo `json:"rate_limit"`
	Credits   map[string]any     `json:"credits"`
}

func (s *Server) handleCodexQuota(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeIfConfigured(w, r) {
		return
	}
	path := strings.TrimRight(r.URL.Path, "/")
	switch {
	case path == "/v0/management/codex-quota/settings" && r.Method == http.MethodGet:
		s.handleCodexQuotaSettings(w, r)
	case path == "/v0/management/codex-quota" && r.Method == http.MethodGet:
		s.handleCodexQuotaList(w, r)
	case path == "/v0/management/codex-quota/refresh" && r.Method == http.MethodPost:
		s.handleCodexQuotaRefresh(w, r)
	case path == "/v0/management/codex-quota/account" && r.Method == http.MethodPatch:
		s.handleCodexQuotaAccountPatch(w, r)
	case path == "/v0/management/codex-quota/account" && r.Method == http.MethodDelete:
		s.handleCodexQuotaAccountDelete(w, r)
	default:
		methodNotAllowed(w)
	}
}

func (s *Server) handleCodexQuotaSettings(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"accountCycleTokens":  s.cfg.CodexQuotaEstimateTokens,
		"accountCycleCostUsd": s.cfg.CodexQuotaEstimateCostUSD,
		"accountCycleCalls":   s.cfg.CodexQuotaEstimateCalls,
	})
}

func (s *Server) handleCodexQuotaList(w http.ResponseWriter, r *http.Request) {
	accounts, err := loadCodexAuthFiles(s.cfg.CodexAuthDir)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	results := fetchCodexQuotas(r.Context(), accounts)
	results = autoDisableUnavailableCodexAccounts(s.cfg.CodexAuthDir, results)
	sort.Slice(results, func(i, j int) bool {
		left, right := results[i], results[j]
		if statusRank(left.Status) != statusRank(right.Status) {
			return statusRank(left.Status) < statusRank(right.Status)
		}
		if left.SortRemaining != right.SortRemaining {
			return left.SortRemaining < right.SortRemaining
		}
		return strings.ToLower(left.Account) < strings.ToLower(right.Account)
	})
	writeJSON(w, http.StatusOK, codexQuotaResponse{
		Summary:  buildCodexQuotaSummary(results),
		Accounts: results,
	})
}

func (s *Server) handleCodexQuotaRefresh(w http.ResponseWriter, r *http.Request) {
	var req codexQuotaRefreshRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	wanted := map[string]struct{}{}
	for _, file := range req.Files {
		name := filepath.Base(strings.TrimSpace(file))
		if name == "." || name == "/" || !strings.HasSuffix(name, ".json") {
			writeError(w, http.StatusBadRequest, errors.New("invalid auth file name"))
			return
		}
		wanted[name] = struct{}{}
	}
	if len(wanted) == 0 {
		writeError(w, http.StatusBadRequest, errors.New("files are required"))
		return
	}

	accounts, err := loadCodexAuthFiles(s.cfg.CodexAuthDir)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	selected := make([]codexAuthFile, 0, len(wanted))
	for _, account := range accounts {
		if _, ok := wanted[account.File]; ok {
			selected = append(selected, account)
		}
	}
	if len(selected) == 0 {
		writeError(w, http.StatusNotFound, errors.New("selected auth files were not found"))
		return
	}
	results := fetchCodexQuotas(r.Context(), selected)
	results = autoDisableUnavailableCodexAccounts(s.cfg.CodexAuthDir, results)
	sort.Slice(results, func(i, j int) bool {
		return strings.ToLower(results[i].Account) < strings.ToLower(results[j].Account)
	})
	writeJSON(w, http.StatusOK, codexQuotaResponse{
		Summary:  buildCodexQuotaSummary(results),
		Accounts: results,
	})
}

func (s *Server) handleCodexQuotaAccountPatch(w http.ResponseWriter, r *http.Request) {
	var req codexQuotaActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if req.Disabled == nil {
		writeError(w, http.StatusBadRequest, errors.New("disabled is required"))
		return
	}
	account, err := updateCodexAuthDisabled(s.cfg.CodexAuthDir, req.File, *req.Disabled)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":   "ok",
		"file":     account.File,
		"disabled": account.Disabled,
	})
}

func (s *Server) handleCodexQuotaAccountDelete(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	if file == "" {
		var req codexQuotaActionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err == nil {
			file = req.File
		}
	}
	archivedPath, err := archiveCodexAuthFile(s.cfg.CodexAuthDir, s.cfg.DeletedAuthDir, file)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":       "ok",
		"file":         filepath.Base(file),
		"archivedPath": archivedPath,
	})
}

func loadCodexAuthFiles(authDir string) ([]codexAuthFile, error) {
	authDir = strings.TrimSpace(authDir)
	if authDir == "" {
		return nil, errors.New("CPA_CODEX_AUTH_DIR is not configured")
	}
	entries, err := os.ReadDir(authDir)
	if err != nil {
		return nil, fmt.Errorf("read auth dir %s: %w", authDir, err)
	}
	accounts := make([]codexAuthFile, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(authDir, entry.Name())
		importedAt := ""
		if info, err := entry.Info(); err == nil {
			importedAt = timeToBeijing(fileBirthTime(path, info.ModTime()))
		}
		data, err := os.ReadFile(path)
		if err != nil {
			accounts = append(accounts, codexAuthFile{File: entry.Name(), Email: entry.Name(), ImportedAt: importedAt})
			continue
		}
		var account codexAuthFile
		if err := json.Unmarshal(data, &account); err != nil {
			accounts = append(accounts, codexAuthFile{File: entry.Name(), Email: entry.Name(), ImportedAt: importedAt})
			continue
		}
		if account.Type != "codex" {
			continue
		}
		account.File = entry.Name()
		account.ImportedAt = importedAt
		if strings.TrimSpace(account.Email) == "" {
			account.Email = entry.Name()
		}
		accounts = append(accounts, account)
	}
	return accounts, nil
}

func fetchCodexQuotas(ctx context.Context, accounts []codexAuthFile) []codexQuotaAccount {
	results := make([]codexQuotaAccount, len(accounts))
	jobs := make(chan int)
	var wg sync.WaitGroup
	workers := codexQuotaWorkers
	if len(accounts) < workers {
		workers = len(accounts)
	}
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				results[index] = fetchCodexQuota(ctx, accounts[index])
			}
		}()
	}
	for index := range accounts {
		jobs <- index
	}
	close(jobs)
	wg.Wait()
	return results
}

func fetchCodexQuota(ctx context.Context, account codexAuthFile) codexQuotaAccount {
	base := codexQuotaAccount{
		File:           account.File,
		Account:        firstNonEmpty(account.Email, account.AccountID, account.File),
		Email:          account.Email,
		ImportedAt:     account.ImportedAt,
		Disabled:       account.Disabled,
		TokenExpiredAt: isoToBeijing(account.Expired),
		LastRefreshAt:  isoToBeijing(account.LastRefresh),
		LongWindowText: "",
		SortRemaining:  999,
		CurrentResetAt: "",
		LongResetAt:    "",
		CreditsBalance: nil,
	}
	if strings.TrimSpace(account.AccessToken) == "" {
		base.Status = "error"
		base.StatusText = "缺少Token"
		base.Error = "账号文件缺少 access_token"
		return base
	}

	reqCtx, cancel := context.WithTimeout(ctx, codexQuotaRequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, codexUsageURL, nil)
	if err != nil {
		base.Status = "error"
		base.StatusText = "请求失败"
		base.Error = err.Error()
		return base
	}
	req.Header.Set("Authorization", "Bearer "+account.AccessToken)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "cpa-manager")

	started := time.Now()
	res, err := http.DefaultClient.Do(req)
	base.LatencyMS = time.Since(started).Milliseconds()
	if err != nil {
		base.Status = "error"
		base.StatusText = "查询失败"
		base.Error = err.Error()
		return base
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 500))
		base.Status = "error"
		base.StatusText = fmt.Sprintf("HTTP %d", res.StatusCode)
		base.Error = strings.TrimSpace(string(body))
		return base
	}
	var payload codexUsageResponse
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		base.Status = "error"
		base.StatusText = "解析失败"
		base.Error = err.Error()
		return base
	}

	allowed := payload.RateLimit.Allowed
	limitReached := payload.RateLimit.LimitReached
	base.Allowed = &allowed
	base.LimitReached = &limitReached
	base.Plan = payload.PlanType
	base.CreditsBalance = payload.Credits["balance"]
	applyWindow(&base, payload.RateLimit.PrimaryWindow, true)
	if payload.RateLimit.SecondaryWindow == nil {
		base.LongWindowText = "不适用"
	} else {
		base.LongWindowText = "适用"
		applyWindow(&base, payload.RateLimit.SecondaryWindow, false)
	}
	if allowed && !limitReached {
		base.Status = "available"
		base.StatusText = "可用"
	} else {
		base.Status = "limited"
		base.StatusText = "受限"
	}
	if account.Disabled {
		base.Status = "disabled"
		base.StatusText = "已停用"
	}
	if base.CurrentRemainingPercent != nil {
		base.SortRemaining = float64(*base.CurrentRemainingPercent)
	}
	return base
}

func autoDisableUnavailableCodexAccounts(authDir string, accounts []codexQuotaAccount) []codexQuotaAccount {
	updated := make([]codexQuotaAccount, len(accounts))
	copy(updated, accounts)
	for index := range updated {
		account := &updated[index]
		if !shouldAutoDisableCodexQuotaAccount(*account) {
			continue
		}
		originalStatus := account.Status
		originalText := account.StatusText
		if _, err := updateCodexAuthDisabled(authDir, account.File, true); err != nil {
			account.Error = strings.TrimSpace(strings.Join([]string{account.Error, "自动停用失败: " + err.Error()}, " "))
			continue
		}
		account.Disabled = true
		account.Status = "disabled"
		if isLowRemainingCodexQuotaAccount(*account) && originalStatus != "limited" {
			account.StatusText = "已自动停用：低余量"
			account.Error = "余量低于等于5%，默认停用"
			continue
		}
		if originalStatus == "limited" {
			account.StatusText = "已自动停用：受限"
		} else {
			account.StatusText = "已自动停用：异常"
		}
		if strings.TrimSpace(account.Error) == "" {
			account.Error = originalText
		}
	}
	return updated
}

func shouldAutoDisableCodexQuotaAccount(account codexQuotaAccount) bool {
	if account.Disabled {
		return false
	}
	if isLowRemainingCodexQuotaAccount(account) {
		return true
	}
	if account.Status == "limited" {
		return true
	}
	if account.Status != "error" {
		return false
	}
	text := strings.ToLower(strings.TrimSpace(account.StatusText + " " + account.Error))
	if text == "" {
		return false
	}
	return strings.Contains(text, "缺少token") ||
		strings.Contains(text, "access_token") ||
		strings.Contains(text, "token_invalidated") ||
		strings.Contains(text, "authentication token has been invalidated") ||
		strings.Contains(text, "unauthorized") ||
		strings.Contains(text, "http 401") ||
		strings.Contains(text, "http 403")
}

func isLowRemainingCodexQuotaAccount(account codexQuotaAccount) bool {
	return account.CurrentRemainingPercent != nil && *account.CurrentRemainingPercent <= 5
}

func applyWindow(account *codexQuotaAccount, window *codexUsageWindow, primary bool) {
	if window == nil {
		return
	}
	used := intFromAny(window.UsedPercent)
	if used == nil {
		return
	}
	remaining := 100 - *used
	if remaining < 0 {
		remaining = 0
	}
	if remaining > 100 {
		remaining = 100
	}
	resetAt := epochToBeijing(window.ResetAt)
	if primary {
		account.CurrentUsedPercent = used
		account.CurrentRemainingPercent = &remaining
		account.CurrentResetAt = resetAt
		return
	}
	account.LongUsedPercent = used
	account.LongRemainingPercent = &remaining
	account.LongResetAt = resetAt
}

func buildCodexQuotaSummary(accounts []codexQuotaAccount) codexQuotaSummary {
	values := make([]int, 0, len(accounts))
	plans := map[string]int{}
	summary := codexQuotaSummary{
		GeneratedAt: beijingNowText(),
		Total:       len(accounts),
		Plans:       plans,
		Buckets: []codexQuotaBucket{
			{Label: "0%", Count: 0},
			{Label: "1-5%", Count: 0},
			{Label: "6-20%", Count: 0},
			{Label: "21-50%", Count: 0},
			{Label: "51-80%", Count: 0},
			{Label: "81-90%", Count: 0},
			{Label: "91-100%", Count: 0},
		},
	}
	for _, account := range accounts {
		if account.Disabled {
			summary.Disabled++
		} else {
			switch account.Status {
			case "available":
				summary.Available++
			case "limited":
				summary.Limited++
			case "disabled":
				summary.Disabled++
			default:
				summary.Errors++
			}
		}
		if account.Plan != "" {
			plans[account.Plan]++
		}
		if account.CurrentRemainingPercent == nil {
			continue
		}
		value := *account.CurrentRemainingPercent
		values = append(values, value)
		if value <= 10 {
			summary.Critical++
		}
		if value <= 20 {
			summary.Low++
		}
		switch {
		case value == 0:
			summary.Buckets[0].Count++
		case value <= 5:
			summary.Buckets[1].Count++
		case value <= 20:
			summary.Buckets[2].Count++
		case value <= 50:
			summary.Buckets[3].Count++
		case value <= 80:
			summary.Buckets[4].Count++
		case value <= 90:
			summary.Buckets[5].Count++
		default:
			summary.Buckets[6].Count++
		}
	}
	if len(values) > 0 {
		sort.Ints(values)
		var total int
		for _, value := range values {
			total += value
		}
		average := round1(float64(total) / float64(len(values)))
		summary.Average = &average
		if len(values)%2 == 1 {
			median := float64(values[len(values)/2])
			summary.Median = &median
		} else {
			median := round1(float64(values[len(values)/2-1]+values[len(values)/2]) / 2)
			summary.Median = &median
		}
	}
	return summary
}

func updateCodexAuthDisabled(authDir string, file string, disabled bool) (codexAuthFile, error) {
	path, err := safeCodexAuthPath(authDir, file)
	if err != nil {
		return codexAuthFile{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return codexAuthFile{}, err
	}
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		return codexAuthFile{}, err
	}
	if payload["type"] != "codex" {
		return codexAuthFile{}, errors.New("only codex auth files can be updated here")
	}
	payload["disabled"] = disabled
	encoded, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return codexAuthFile{}, err
	}
	encoded = append(encoded, '\n')
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		return codexAuthFile{}, err
	}
	var account codexAuthFile
	if err := json.Unmarshal(encoded, &account); err != nil {
		return codexAuthFile{}, err
	}
	account.File = filepath.Base(path)
	return account, nil
}

func archiveCodexAuthFile(authDir string, deletedDir string, file string) (string, error) {
	path, err := safeCodexAuthPath(authDir, file)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var account codexAuthFile
	if err := json.Unmarshal(data, &account); err != nil {
		return "", err
	}
	if account.Type != "codex" {
		return "", errors.New("only codex auth files can be deleted here")
	}
	stamp := time.Now().Format("20060102-150405")
	targetDir := filepath.Join(deletedDir, stamp)
	if err := os.MkdirAll(targetDir, 0o700); err != nil {
		return "", err
	}
	target := filepath.Join(targetDir, filepath.Base(path))
	if err := os.Rename(path, target); err != nil {
		// Cross-device mounts may not support rename; copy then remove.
		if copyErr := copyAndRemove(path, target); copyErr != nil {
			return "", fmt.Errorf("archive auth file: %w", err)
		}
	}
	return target, nil
}

func safeCodexAuthPath(authDir string, file string) (string, error) {
	authDir = strings.TrimSpace(authDir)
	if authDir == "" {
		return "", errors.New("CPA_CODEX_AUTH_DIR is not configured")
	}
	name := filepath.Base(strings.TrimSpace(file))
	if name == "." || name == "/" || !strings.HasSuffix(name, ".json") {
		return "", errors.New("invalid auth file name")
	}
	path := filepath.Join(authDir, name)
	if _, err := os.Stat(path); err != nil {
		return "", err
	}
	return path, nil
}

func copyAndRemove(source string, target string) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	if err := os.WriteFile(target, data, 0o600); err != nil {
		return err
	}
	return os.Remove(source)
}

func statusRank(status string) int {
	switch status {
	case "limited":
		return 0
	case "error":
		return 1
	case "available":
		return 2
	case "disabled":
		return 3
	default:
		return 4
	}
}

func intFromAny(value any) *int {
	switch typed := value.(type) {
	case nil:
		return nil
	case float64:
		result := int(typed)
		return &result
	case int:
		result := typed
		return &result
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil {
			return nil
		}
		result := int(parsed)
		return &result
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(typed))
		if err != nil {
			return nil
		}
		return &parsed
	default:
		return nil
	}
}

func epochToBeijing(value any) string {
	parsed := intFromAny(value)
	if parsed == nil || *parsed <= 0 {
		return ""
	}
	return time.Unix(int64(*parsed), 0).In(beijingLocation()).Format("2006-01-02 15:04:05")
}

func isoToBeijing(value string) string {
	text := strings.TrimSpace(value)
	if text == "" {
		return ""
	}
	parsed, err := time.Parse(time.RFC3339, text)
	if err != nil {
		return text
	}
	return parsed.In(beijingLocation()).Format("2006-01-02 15:04:05")
}

func timeToBeijing(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.In(beijingLocation()).Format("2006-01-02 15:04:05")
}

func beijingNowText() string {
	return time.Now().In(beijingLocation()).Format("2006-01-02 15:04:05")
}

func beijingLocation() *time.Location {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return time.FixedZone("Asia/Shanghai", 8*60*60)
	}
	return loc
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func round1(value float64) float64 {
	return float64(int(value*10+0.5)) / 10
}
