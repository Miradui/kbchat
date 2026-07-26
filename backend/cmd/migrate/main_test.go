package main

import (
	"os"
	"regexp"
	"testing"
)

func TestWorkspacePreferenceMigrationCanBeReapplied(t *testing.T) {
	sql, err := os.ReadFile("../../migrations/008_kb_workspace_preference.sql")
	if err != nil {
		t.Fatalf("read workspace preference migration: %v", err)
	}

	createTable := regexp.MustCompile(`(?i)CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+knowledge_base_workspace_preferences`)
	if !createTable.Match(sql) {
		t.Fatal("workspace preference migration must tolerate an existing table")
	}
}

func TestChatIdempotencyMigrationCanBeReapplied(t *testing.T) {
	sqlBytes, err := os.ReadFile("../../migrations/010_chat_message_idempotency.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}

	sql := string(sqlBytes)
	patterns := []string{
		`(?i)ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+client_request_id\s+UUID`,
		`(?i)ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+rerank_fallback\s+JSONB`,
		`(?i)CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_chat_messages_session_client_role`,
	}
	for _, pattern := range patterns {
		if !regexp.MustCompile(pattern).MatchString(sql) {
			t.Fatalf("expected migration to match %q", pattern)
		}
	}
}
