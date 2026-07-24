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
