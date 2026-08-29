package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestSelectMigrationFiles(t *testing.T) {
	dir := t.TempDir()
	files := []string{
		filepath.Join(dir, "014_chat_message_feedback.sql"),
		filepath.Join(dir, "013_chat_message_editing.sql"),
	}

	selected, err := selectMigrationFiles(files, "014_chat_message_feedback.sql")
	if err != nil {
		t.Fatalf("select migration: %v", err)
	}
	if len(selected) != 1 || selected[0] != files[0] {
		t.Fatalf("expected only migration 014, got %v", selected)
	}

	all, err := selectMigrationFiles(files, "")
	if err != nil {
		t.Fatalf("select all migrations: %v", err)
	}
	if len(all) != 2 || filepath.Base(all[0]) != "013_chat_message_editing.sql" {
		t.Fatalf("expected sorted migrations, got %v", all)
	}
}

func TestSelectMigrationFilesRejectsUnsafeOrUnknownNames(t *testing.T) {
	files := []string{filepath.Join(t.TempDir(), "014_chat_message_feedback.sql")}
	for _, name := range []string{
		"../014_chat_message_feedback.sql",
		`..\014_chat_message_feedback.sql`,
		"missing.sql",
		"014_chat_message_feedback.txt",
	} {
		t.Run(name, func(t *testing.T) {
			_, err := selectMigrationFiles(files, name)
			if err == nil {
				t.Fatalf("expected %q to be rejected", name)
			}
		})
	}
}

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

func TestChatFeedbackMigrationCanBeReapplied(t *testing.T) {
	sqlBytes, err := os.ReadFile("../../migrations/014_chat_message_feedback.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}

	sql := string(sqlBytes)
	for _, fragment := range []string{
		"ADD COLUMN IF NOT EXISTS feedback_rating",
		"ADD COLUMN IF NOT EXISTS feedback_updated_at",
		"DROP CONSTRAINT IF EXISTS chat_messages_feedback_rating_check",
		"feedback_rating IN ('positive', 'negative')",
	} {
		if !strings.Contains(sql, fragment) {
			t.Fatalf("expected migration to contain %q", fragment)
		}
	}
}

func TestDocumentJobProgressMigrationCanBeReapplied(t *testing.T) {
	sqlBytes, err := os.ReadFile("../../migrations/016_document_job_progress.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}

	sql := string(sqlBytes)
	for _, fragment := range []string{
		"ADD COLUMN IF NOT EXISTS progress",
		"DROP CONSTRAINT IF EXISTS document_jobs_progress_check",
		"progress BETWEEN 0 AND 100",
	} {
		if !strings.Contains(sql, fragment) {
			t.Fatalf("expected migration to contain %q", fragment)
		}
	}
}

func TestChatQualityFeedbackIndexMigrationCanBeReapplied(t *testing.T) {
	sqlBytes, err := os.ReadFile("../../migrations/017_chat_quality_feedback_index.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	sql := string(sqlBytes)
	for _, fragment := range []string{
		"CREATE INDEX IF NOT EXISTS idx_chat_messages_negative_feedback",
		"feedback_updated_at DESC",
		"WHERE role = 'assistant' AND feedback_rating = 'negative'",
	} {
		if !strings.Contains(sql, fragment) {
			t.Fatalf("expected migration to contain %q", fragment)
		}
	}
}
