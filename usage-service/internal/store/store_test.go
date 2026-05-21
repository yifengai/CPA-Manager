package store

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/seakee/cpa-manager/usage-service/internal/usage"
)

func TestStorePersistsAccountSnapshot(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})

	_, err = db.InsertEvents(context.Background(), []usage.Event{
		{
			EventHash:            "event-1",
			TimestampMS:          1_778_000_000_000,
			Timestamp:            "2026-05-06T00:00:00Z",
			Model:                "gpt-test",
			Endpoint:             "POST /v1/chat/completions",
			AuthIndex:            "auth-1",
			AccountSnapshot:      "alice@example.com",
			AuthLabelSnapshot:    "Alice",
			AuthFileSnapshot:     "alice.json",
			AuthProviderSnapshot: "codex",
			AuthSnapshotAtMS:     1_778_000_000_100,
			CreatedAtMS:          1_778_000_000_200,
		},
	})
	if err != nil {
		t.Fatalf("insert events: %v", err)
	}

	events, err := db.RecentEvents(context.Background(), 10)
	if err != nil {
		t.Fatalf("recent events: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("len(events) = %d, want 1", len(events))
	}
	event := events[0]
	if event.AccountSnapshot != "alice@example.com" {
		t.Fatalf("AccountSnapshot = %q", event.AccountSnapshot)
	}
	if event.AuthLabelSnapshot != "Alice" {
		t.Fatalf("AuthLabelSnapshot = %q", event.AuthLabelSnapshot)
	}
	if event.AuthFileSnapshot != "alice.json" {
		t.Fatalf("AuthFileSnapshot = %q", event.AuthFileSnapshot)
	}
	if event.AuthProviderSnapshot != "codex" {
		t.Fatalf("AuthProviderSnapshot = %q", event.AuthProviderSnapshot)
	}
	if event.AuthSnapshotAtMS != 1_778_000_000_100 {
		t.Fatalf("AuthSnapshotAtMS = %d", event.AuthSnapshotAtMS)
	}

	payload := usage.BuildPayload(events)
	detail := payload.APIs["POST /v1/chat/completions"].Models["gpt-test"].Details[0]
	if detail.AccountSnapshot != "alice@example.com" {
		t.Fatalf("payload AccountSnapshot = %q", detail.AccountSnapshot)
	}
	if detail.AuthProviderSnapshot != "codex" {
		t.Fatalf("payload AuthProviderSnapshot = %q", detail.AuthProviderSnapshot)
	}
}

func TestDeleteFailedEventsOnlyRemovesFailedUsage(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})

	_, err = db.InsertEvents(context.Background(), []usage.Event{
		{
			EventHash:   "success-event",
			TimestampMS: 1,
			Timestamp:   "2026-05-18T00:00:00Z",
			Model:       "gpt-test",
			TotalTokens: 100,
			CreatedAtMS: 1,
		},
		{
			EventHash:   "failed-event",
			TimestampMS: 2,
			Timestamp:   "2026-05-18T00:01:00Z",
			Model:       "gpt-test",
			TotalTokens: 200,
			Failed:      true,
			CreatedAtMS: 2,
		},
	})
	if err != nil {
		t.Fatalf("insert events: %v", err)
	}

	deleted, err := db.DeleteFailedEvents(context.Background())
	if err != nil {
		t.Fatalf("delete failed events: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("deleted = %d, want 1", deleted)
	}

	events, err := db.RecentEvents(context.Background(), 10)
	if err != nil {
		t.Fatalf("recent events: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("len(events) = %d, want 1", len(events))
	}
	if events[0].EventHash != "success-event" {
		t.Fatalf("remaining event = %q, want success-event", events[0].EventHash)
	}
}

func TestUsageEventsSinceFiltersByTimestamp(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})

	_, err = db.InsertEvents(context.Background(), []usage.Event{
		{
			EventHash:   "old-event",
			TimestampMS: 1000,
			Timestamp:   "2026-05-18T00:00:00Z",
			Model:       "gpt-test",
			TotalTokens: 100,
			CreatedAtMS: 1000,
		},
		{
			EventHash:   "new-event",
			TimestampMS: 2000,
			Timestamp:   "2026-05-18T00:00:01Z",
			Model:       "gpt-test",
			TotalTokens: 200,
			CreatedAtMS: 2000,
		},
	})
	if err != nil {
		t.Fatalf("insert events: %v", err)
	}

	events, err := db.UsageEventsSince(context.Background(), 1500)
	if err != nil {
		t.Fatalf("usage events since: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("len(events) = %d, want 1", len(events))
	}
	if events[0].EventHash != "new-event" {
		t.Fatalf("event = %q, want new-event", events[0].EventHash)
	}
}
