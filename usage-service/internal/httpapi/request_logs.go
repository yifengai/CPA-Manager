package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	defaultRequestLogLimit = 80
	maxRequestLogLimit     = 300
	textPreviewLimit       = 160
	detailTextLimit        = 30000
	eventDetailLimit       = 500
)

var requestLogSectionRe = regexp.MustCompile(`(?m)^=== (.*?) ===\s*$`)

type requestLogListResponse struct {
	GeneratedAt string             `json:"generatedAt"`
	LogDir      string             `json:"logDir"`
	Total       int                `json:"total"`
	Tasks       []requestLogTask   `json:"tasks"`
	Latest      *requestLogSummary `json:"latest,omitempty"`
}

type requestLogTask struct {
	ID           string              `json:"id"`
	Title        string              `json:"title"`
	UpdatedAt    string              `json:"updatedAt"`
	RequestCount int                 `json:"requestCount"`
	Requests     []requestLogSummary `json:"requests"`
}

type requestLogTrace struct {
	Summary              requestLogSummary   `json:"summary"`
	RequestInfo          map[string]string   `json:"requestInfo"`
	Headers              map[string]string   `json:"headers"`
	RequestRaw           string              `json:"requestRaw"`
	RequestJSON          any                 `json:"requestJson,omitempty"`
	UserMessages         []requestLogMessage `json:"userMessages"`
	Routing              []requestLogRouting `json:"routing"`
	UpstreamEvents       []requestLogEvent   `json:"upstreamEvents"`
	ResponsesEvents      []requestLogEvent   `json:"responsesEvents"`
	UpstreamEventCounts  []requestLogCount   `json:"upstreamEventCounts"`
	ResponsesEventCounts []requestLogCount   `json:"responsesEventCounts"`
	FinalText            string              `json:"finalText"`
	Sections             []requestLogSection `json:"sections,omitempty"`
}

type requestLogSummary struct {
	RequestID       string `json:"requestId"`
	LogName         string `json:"logName"`
	LogPath         string `json:"logPath"`
	UpdatedAt       string `json:"updatedAt"`
	Method          string `json:"method"`
	Path            string `json:"path"`
	UpstreamURL     string `json:"upstreamUrl"`
	Auth            string `json:"auth"`
	Status          string `json:"status"`
	Completed       bool   `json:"completed"`
	HasError        bool   `json:"hasError"`
	UserCount       int    `json:"userCount"`
	UpstreamEvents  int    `json:"upstreamEvents"`
	ResponsesEvents int    `json:"responsesEvents"`
	InputTokens     int64  `json:"inputTokens"`
	OutputTokens    int64  `json:"outputTokens"`
	TotalTokens     int64  `json:"totalTokens"`
	UserPath        string `json:"userPath"`
	UserPreview     string `json:"userPreview"`
	FinalPreview    string `json:"finalPreview"`
}

type requestLogMessage struct {
	Index   int    `json:"index"`
	Path    string `json:"path"`
	Text    string `json:"text"`
	Preview string `json:"preview"`
	Chars   int    `json:"chars"`
	Current bool   `json:"current"`
}

type requestLogRouting struct {
	Title       string            `json:"title"`
	Method      string            `json:"method"`
	UpstreamURL string            `json:"upstreamUrl"`
	Auth        string            `json:"auth"`
	Body        string            `json:"body,omitempty"`
	Meta        map[string]string `json:"meta,omitempty"`
}

type requestLogEvent struct {
	Event   string `json:"event"`
	Type    string `json:"type"`
	Summary string `json:"summary"`
	RawData string `json:"rawData"`
	Data    any    `json:"data,omitempty"`
}

type requestLogCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type requestLogSection struct {
	Title   string `json:"title"`
	Content string `json:"content"`
}

func (s *Server) handleRequestLogs(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeIfConfigured(w, r) {
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}

	path := strings.TrimRight(r.URL.Path, "/")
	switch {
	case path == "/v0/management/request-logs" || path == "/v0/management/request-logs/tasks":
		s.handleRequestLogList(w, r)
	case path == "/v0/management/request-logs/latest":
		s.handleRequestLogLatest(w, r)
	case strings.HasPrefix(path, "/v0/management/request-logs/"):
		id := strings.TrimPrefix(path, "/v0/management/request-logs/")
		s.handleRequestLogDetail(w, r, id)
	default:
		methodNotAllowed(w)
	}
}

func (s *Server) handleRequestLogList(w http.ResponseWriter, r *http.Request) {
	limit := requestLogLimitFromQuery(r)
	summaries, err := loadRequestLogSummaries(s.cfg.RequestLogDir, limit)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	response := requestLogListResponse{
		GeneratedAt: beijingNowText(),
		LogDir:      s.cfg.RequestLogDir,
		Total:       len(summaries),
		Tasks:       groupRequestLogTasks(summaries),
	}
	if len(summaries) > 0 {
		latest := summaries[0]
		response.Latest = &latest
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) handleRequestLogLatest(w http.ResponseWriter, r *http.Request) {
	files, err := listRequestLogFiles(s.cfg.RequestLogDir, 1)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if len(files) == 0 {
		writeError(w, http.StatusNotFound, errors.New("no request logs found"))
		return
	}
	trace, err := parseRequestLogFile(files[0])
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, trace)
}

func (s *Server) handleRequestLogDetail(w http.ResponseWriter, _ *http.Request, id string) {
	file, err := findRequestLogFile(s.cfg.RequestLogDir, id)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	trace, err := parseRequestLogFile(file)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, trace)
}

func requestLogLimitFromQuery(r *http.Request) int {
	limit := defaultRequestLogLimit
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	if limit > maxRequestLogLimit {
		return maxRequestLogLimit
	}
	return limit
}

func loadRequestLogSummaries(logDir string, limit int) ([]requestLogSummary, error) {
	files, err := listRequestLogFiles(logDir, limit)
	if err != nil {
		return nil, err
	}
	summaries := make([]requestLogSummary, 0, len(files))
	for _, file := range files {
		trace, err := parseRequestLogFile(file)
		if err != nil {
			summaries = append(summaries, requestLogSummary{
				RequestID: requestIDFromLogName(filepath.Base(file)),
				LogName:   filepath.Base(file),
				LogPath:   file,
				UpdatedAt: fileUpdatedAt(file),
				Status:    "解析失败: " + err.Error(),
				HasError:  true,
			})
			continue
		}
		summaries = append(summaries, trace.Summary)
	}
	return summaries, nil
}

func listRequestLogFiles(logDir string, limit int) ([]string, error) {
	logDir = strings.TrimSpace(logDir)
	if logDir == "" {
		return nil, errors.New("request log directory is not configured")
	}
	info, err := os.Stat(logDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, nil
		}
		return nil, fmt.Errorf("stat request log directory: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("request log path is not a directory: %s", logDir)
	}

	patterns := []string{
		filepath.Join(logDir, "v1-responses-*.log"),
		filepath.Join(logDir, "error-v1-responses-*.log"),
	}
	seen := map[string]struct{}{}
	files := make([]string, 0)
	for _, pattern := range patterns {
		matches, err := filepath.Glob(pattern)
		if err != nil {
			return nil, err
		}
		for _, file := range matches {
			if _, ok := seen[file]; ok {
				continue
			}
			seen[file] = struct{}{}
			files = append(files, file)
		}
	}
	sort.Slice(files, func(i, j int) bool {
		left, leftErr := os.Stat(files[i])
		right, rightErr := os.Stat(files[j])
		if leftErr != nil || rightErr != nil {
			return files[i] > files[j]
		}
		return left.ModTime().After(right.ModTime())
	})
	if limit > 0 && len(files) > limit {
		files = files[:limit]
	}
	return files, nil
}

func findRequestLogFile(logDir string, id string) (string, error) {
	id = filepath.Base(strings.TrimSpace(id))
	if id == "" || id == "." || id == "/" {
		return "", errors.New("request log id is required")
	}
	files, err := listRequestLogFiles(logDir, 0)
	if err != nil {
		return "", err
	}
	for _, file := range files {
		name := filepath.Base(file)
		stem := strings.TrimSuffix(name, filepath.Ext(name))
		if name == id || stem == id || requestIDFromLogName(name) == id {
			return file, nil
		}
	}
	return "", fmt.Errorf("request log %s was not found", id)
}

func parseRequestLogFile(path string) (requestLogTrace, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return requestLogTrace{}, err
	}
	return parseRequestLogText(path, string(data))
}

func parseRequestLogText(path string, text string) (requestLogTrace, error) {
	sections := parseRequestLogSections(text)
	if len(sections) == 0 {
		return requestLogTrace{}, errors.New("no request log sections found")
	}
	requestInfo := parseRequestLogKeyValues(firstRequestLogSection(sections, "REQUEST INFO"))
	headers := parseRequestLogHeaders(firstRequestLogSection(sections, "HEADERS"))
	requestRaw, requestJSON := extractRequestLogBody(sections)
	userMessages := extractRequestLogUserMessages(requestJSON)
	routing := extractRequestLogRouting(sections)

	upstreamEvents := make([]requestLogEvent, 0)
	responsesEvents := make([]requestLogEvent, 0)
	for _, section := range sections {
		switch {
		case strings.HasPrefix(section.Title, "API RESPONSE"):
			upstreamEvents = append(upstreamEvents, parseRequestLogSSEEvents(section.Content)...)
		case section.Title == "RESPONSE":
			responsesEvents = append(responsesEvents, parseRequestLogSSEEvents(section.Content)...)
		}
	}

	finalText := firstNonEmpty(
		extractReadableResponseText(responsesEvents),
		extractReadableResponseText(upstreamEvents),
	)
	completed := firstCompletedResponse(responsesEvents)
	if completed == nil {
		completed = firstCompletedResponse(upstreamEvents)
	}
	usage := usageFromCompletedEvent(completed)

	firstRouting := requestLogRouting{}
	if len(routing) > 0 {
		firstRouting = routing[0]
	}
	latestUser := requestLogMessage{}
	if len(userMessages) > 0 {
		latestUser = userMessages[len(userMessages)-1]
	}
	completedOK := completed != nil
	status := "进行中或未捕获完成事件"
	if completedOK {
		status = "已完成"
	}
	hasError := strings.HasPrefix(filepath.Base(path), "error-")
	if hasError && completedOK {
		status = "已完成，存在错误日志标记"
	} else if hasError {
		status = "错误或未完成"
	}

	trace := requestLogTrace{
		RequestInfo:          requestInfo,
		Headers:              headers,
		RequestRaw:           limitText(requestRaw, detailTextLimit),
		RequestJSON:          requestJSON,
		UserMessages:         userMessages,
		Routing:              routing,
		UpstreamEvents:       limitRequestLogEvents(upstreamEvents, eventDetailLimit),
		ResponsesEvents:      limitRequestLogEvents(responsesEvents, eventDetailLimit),
		UpstreamEventCounts:  eventCountsForRequestLogs(upstreamEvents),
		ResponsesEventCounts: eventCountsForRequestLogs(responsesEvents),
		FinalText:            limitText(finalText, detailTextLimit),
		Sections:             limitRequestLogSections(sections),
	}
	trace.Summary = requestLogSummary{
		RequestID:       requestIDFromLogName(filepath.Base(path)),
		LogName:         filepath.Base(path),
		LogPath:         path,
		UpdatedAt:       fileUpdatedAt(path),
		Method:          firstNonEmpty(requestInfo["Method"], requestInfo["HTTP Method"], firstRouting.Method),
		Path:            firstNonEmpty(requestInfo["Path"], requestInfo["URL"]),
		UpstreamURL:     firstRouting.UpstreamURL,
		Auth:            firstRouting.Auth,
		Status:          status,
		Completed:       completedOK,
		HasError:        hasError,
		UserCount:       len(userMessages),
		UpstreamEvents:  len(upstreamEvents),
		ResponsesEvents: len(responsesEvents),
		InputTokens:     usage.InputTokens,
		OutputTokens:    usage.OutputTokens,
		TotalTokens:     usage.TotalTokens,
		UserPath:        latestUser.Path,
		UserPreview:     compactRequestLogText(latestUser.Text, textPreviewLimit),
		FinalPreview:    compactRequestLogText(finalText, textPreviewLimit),
	}
	return trace, nil
}

func parseRequestLogSections(text string) []requestLogSection {
	matches := requestLogSectionRe.FindAllStringSubmatchIndex(text, -1)
	sections := make([]requestLogSection, 0, len(matches))
	for index, match := range matches {
		title := strings.TrimSpace(text[match[2]:match[3]])
		start := match[1]
		end := len(text)
		if index+1 < len(matches) {
			end = matches[index+1][0]
		}
		sections = append(sections, requestLogSection{
			Title:   title,
			Content: strings.Trim(text[start:end], "\n"),
		})
	}
	return sections
}

func firstRequestLogSection(sections []requestLogSection, title string) string {
	for _, section := range sections {
		if section.Title == title {
			return section.Content
		}
	}
	return ""
}

func parseRequestLogKeyValues(text string) map[string]string {
	values := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line == "Headers:" || line == "Body:" {
			if line == "Headers:" || line == "Body:" {
				break
			}
			continue
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		values[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	return values
}

func parseRequestLogHeaders(text string) map[string]string {
	headersText := text
	if after, ok := strings.CutPrefix(text, "Headers:\n"); ok {
		headersText = after
	}
	headers := map[string]string{}
	for _, line := range strings.Split(headersText, "\n") {
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		headers[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	return headers
}

func extractRequestLogBody(sections []requestLogSection) (string, any) {
	raw := strings.TrimSpace(firstRequestLogSection(sections, "REQUEST BODY"))
	if raw == "" {
		for _, section := range sections {
			if strings.HasPrefix(section.Title, "API REQUEST") {
				raw = requestLogSectionBody(section.Content)
				break
			}
		}
	}
	return raw, loadRequestLogJSON(raw)
}

func requestLogSectionBody(text string) string {
	if _, body, ok := strings.Cut(text, "Body:\n"); ok {
		return strings.TrimSpace(body)
	}
	if _, body, ok := strings.Cut(text, "Body:"); ok {
		return strings.TrimSpace(body)
	}
	return strings.TrimSpace(text)
}

func loadRequestLogJSON(raw string) any {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return nil
	}
	return value
}

func extractRequestLogUserMessages(value any) []requestLogMessage {
	messages := make([]requestLogMessage, 0)
	var walk func(any, string)
	walk = func(current any, path string) {
		switch typed := current.(type) {
		case map[string]any:
			role, _ := typed["role"].(string)
			if role == "user" {
				text := contentToRequestLogText(typed["content"])
				if text == "" {
					text = stringFromAny(typed["text"])
				}
				if text != "" {
					messages = append(messages, requestLogMessage{
						Index:   len(messages) + 1,
						Path:    pathOrRoot(path),
						Text:    text,
						Preview: compactRequestLogText(text, textPreviewLimit),
						Chars:   len([]rune(text)),
					})
				}
			}
			for key, child := range typed {
				childPath := key
				if path != "" {
					childPath = path + "." + key
				}
				walk(child, childPath)
			}
		case []any:
			for index, child := range typed {
				walk(child, fmt.Sprintf("%s[%d]", pathOrRoot(path), index))
			}
		}
	}
	walk(value, "$")
	for index := range messages {
		messages[index].Current = index == len(messages)-1
	}
	return messages
}

func contentToRequestLogText(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			if text := contentToRequestLogText(item); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n")
	case map[string]any:
		for _, key := range []string{"text", "content", "input_text", "value"} {
			if text := stringFromAny(typed[key]); text != "" {
				return text
			}
		}
		if nested := contentToRequestLogText(typed["content"]); nested != "" {
			return nested
		}
		if nested := contentToRequestLogText(typed["parts"]); nested != "" {
			return nested
		}
	}
	return ""
}

func extractRequestLogRouting(sections []requestLogSection) []requestLogRouting {
	routing := make([]requestLogRouting, 0)
	for _, section := range sections {
		if !strings.HasPrefix(section.Title, "API REQUEST") {
			continue
		}
		meta := parseRequestLogKeyValues(section.Content)
		auth := ""
		for _, line := range strings.Split(section.Content, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "Auth:") {
				auth = strings.TrimSpace(strings.TrimPrefix(line, "Auth:"))
				break
			}
		}
		routing = append(routing, requestLogRouting{
			Title:       section.Title,
			Method:      firstNonEmpty(meta["HTTP Method"], meta["Method"]),
			UpstreamURL: meta["Upstream URL"],
			Auth:        auth,
			Body:        limitText(requestLogSectionBody(section.Content), detailTextLimit),
			Meta:        meta,
		})
	}
	return routing
}

func parseRequestLogSSEEvents(raw string) []requestLogEvent {
	body := requestLogSectionBody(raw)
	events := make([]requestLogEvent, 0)
	eventName := ""
	dataLines := make([]string, 0)

	flush := func() {
		if eventName == "" && len(dataLines) == 0 {
			return
		}
		rawData := strings.TrimSpace(strings.Join(dataLines, "\n"))
		var parsed any
		if rawData != "" && rawData != "[DONE]" {
			parsed = loadRequestLogJSON(rawData)
		}
		eventType := ""
		if parsedMap, ok := parsed.(map[string]any); ok {
			eventType = stringFromAny(parsedMap["type"])
		}
		event := requestLogEvent{
			Event:   eventName,
			Type:    eventType,
			RawData: rawData,
			Data:    parsed,
		}
		event.Summary = summarizeRequestLogEvent(event)
		events = append(events, event)
		eventName = ""
		dataLines = dataLines[:0]
	}

	for _, line := range strings.Split(body, "\n") {
		switch {
		case strings.HasPrefix(line, "event:"):
			if eventName != "" || len(dataLines) > 0 {
				flush()
			}
			eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			dataLines = append(dataLines, strings.TrimLeft(strings.TrimPrefix(line, "data:"), " "))
		case strings.TrimSpace(line) == "":
			flush()
		}
	}
	flush()
	return events
}

func summarizeRequestLogEvent(event requestLogEvent) string {
	data, ok := event.Data.(map[string]any)
	if !ok {
		return compactRequestLogText(event.RawData, 120)
	}
	typ := firstNonEmpty(stringFromAny(data["type"]), event.Event)
	parts := []string{}
	if typ != "" {
		parts = append(parts, "type="+typ)
	}
	if status := stringFromAny(data["status"]); status != "" {
		parts = append(parts, "status="+status)
	}
	if response, ok := data["response"].(map[string]any); ok {
		if status := stringFromAny(response["status"]); status != "" {
			parts = append(parts, "response.status="+status)
		}
		if usage, ok := response["usage"].(map[string]any); ok {
			if total := int64FromAny(usage["total_tokens"]); total > 0 {
				parts = append(parts, fmt.Sprintf("tokens=%d", total))
			}
		}
	}
	if item, ok := data["item"].(map[string]any); ok {
		if itemType := stringFromAny(item["type"]); itemType != "" {
			parts = append(parts, "item="+itemType)
		}
	}
	if delta := stringFromAny(data["delta"]); delta != "" {
		parts = append(parts, "delta="+compactRequestLogText(delta, 70))
	}
	return strings.Join(parts, " | ")
}

func extractReadableResponseText(events []requestLogEvent) string {
	messageTexts := make([]string, 0)
	doneTexts := make([]string, 0)
	deltaParts := make([]string, 0)
	for _, event := range events {
		data, ok := event.Data.(map[string]any)
		if !ok {
			continue
		}
		switch stringFromAny(data["type"]) {
		case "response.output_text.delta":
			deltaParts = append(deltaParts, stringFromAny(data["delta"]))
		case "response.output_text.done":
			if text := stringFromAny(data["text"]); text != "" {
				doneTexts = append(doneTexts, text)
			}
		case "response.output_item.done":
			item, _ := data["item"].(map[string]any)
			if stringFromAny(item["type"]) != "message" {
				continue
			}
			content, _ := item["content"].([]any)
			for _, part := range content {
				partMap, _ := part.(map[string]any)
				if text := stringFromAny(partMap["text"]); text != "" {
					messageTexts = append(messageTexts, text)
				}
			}
		}
	}
	for _, candidates := range [][]string{messageTexts, doneTexts} {
		unique := uniqueNonEmptyStrings(candidates)
		if len(unique) > 0 {
			return strings.Join(unique, "\n\n")
		}
	}
	return strings.Join(deltaParts, "")
}

func firstCompletedResponse(events []requestLogEvent) map[string]any {
	for index := len(events) - 1; index >= 0; index-- {
		data, ok := events[index].Data.(map[string]any)
		if ok && stringFromAny(data["type"]) == "response.completed" {
			return data
		}
	}
	return nil
}

type requestLogUsage struct {
	InputTokens  int64
	OutputTokens int64
	TotalTokens  int64
}

func usageFromCompletedEvent(event map[string]any) requestLogUsage {
	if event == nil {
		return requestLogUsage{}
	}
	response, _ := event["response"].(map[string]any)
	usage, _ := response["usage"].(map[string]any)
	return requestLogUsage{
		InputTokens:  int64FromAny(usage["input_tokens"]),
		OutputTokens: int64FromAny(usage["output_tokens"]),
		TotalTokens:  int64FromAny(usage["total_tokens"]),
	}
}

func eventCountsForRequestLogs(events []requestLogEvent) []requestLogCount {
	counts := map[string]int{}
	for _, event := range events {
		name := firstNonEmpty(event.Event, event.Type, "unknown")
		counts[name]++
	}
	result := make([]requestLogCount, 0, len(counts))
	for name, count := range counts {
		result = append(result, requestLogCount{Name: name, Count: count})
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Count != result[j].Count {
			return result[i].Count > result[j].Count
		}
		return result[i].Name < result[j].Name
	})
	return result
}

func limitRequestLogEvents(events []requestLogEvent, limit int) []requestLogEvent {
	if limit <= 0 || len(events) <= limit {
		return events
	}
	return events[:limit]
}

func limitRequestLogSections(sections []requestLogSection) []requestLogSection {
	result := make([]requestLogSection, 0, len(sections))
	for _, section := range sections {
		result = append(result, requestLogSection{
			Title:   section.Title,
			Content: limitText(section.Content, detailTextLimit),
		})
	}
	return result
}

func groupRequestLogTasks(summaries []requestLogSummary) []requestLogTask {
	taskMap := map[string]int{}
	tasks := make([]requestLogTask, 0)
	for _, summary := range summaries {
		key := requestLogTaskKey(summary)
		index, ok := taskMap[key]
		if !ok {
			title := firstNonEmpty(summary.UserPreview, summary.Path, summary.LogName, "未解析到任务内容")
			task := requestLogTask{
				ID:        fmt.Sprintf("task-%d", len(tasks)+1),
				Title:     title,
				UpdatedAt: summary.UpdatedAt,
				Requests:  []requestLogSummary{},
			}
			tasks = append(tasks, task)
			index = len(tasks) - 1
			taskMap[key] = index
		}
		tasks[index].Requests = append(tasks[index].Requests, summary)
		tasks[index].RequestCount = len(tasks[index].Requests)
		if summary.UpdatedAt > tasks[index].UpdatedAt {
			tasks[index].UpdatedAt = summary.UpdatedAt
		}
	}
	return tasks
}

func requestLogTaskKey(summary requestLogSummary) string {
	key := strings.ToLower(strings.TrimSpace(summary.UserPreview))
	if key != "" {
		return key
	}
	return firstNonEmpty(summary.LogName, summary.RequestID, "unknown")
}

func requestIDFromLogName(name string) string {
	name = filepath.Base(name)
	name = strings.TrimSuffix(name, filepath.Ext(name))
	parts := strings.Split(name, "-")
	if len(parts) == 0 {
		return name
	}
	return parts[len(parts)-1]
}

func fileUpdatedAt(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return ""
	}
	return info.ModTime().In(beijingLocation()).Format("2006-01-02 15:04:05")
}

func stringFromAny(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case json.Number:
		return typed.String()
	case fmt.Stringer:
		return typed.String()
	default:
		return ""
	}
}

func int64FromAny(value any) int64 {
	switch typed := value.(type) {
	case float64:
		return int64(typed)
	case float32:
		return int64(typed)
	case int:
		return int64(typed)
	case int64:
		return typed
	case json.Number:
		parsed, _ := typed.Int64()
		return parsed
	case string:
		parsed, _ := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		return parsed
	default:
		return 0
	}
}

func compactRequestLogText(text string, limit int) string {
	text = strings.Join(strings.Fields(text), " ")
	if limit <= 0 || len([]rune(text)) <= limit {
		return text
	}
	runes := []rune(text)
	return string(runes[:limit]) + "..."
}

func limitText(text string, limit int) string {
	if limit <= 0 || len([]rune(text)) <= limit {
		return text
	}
	runes := []rune(text)
	return string(runes[:limit]) + fmt.Sprintf("\n\n... 已截断，原文共 %d 字。", len(runes))
}

func uniqueNonEmptyStrings(values []string) []string {
	seen := map[string]struct{}{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func pathOrRoot(path string) string {
	if strings.TrimSpace(path) == "" {
		return "$"
	}
	return path
}
