package service

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// answer_status has the same exposure as documents.error_code: the unit tests run on
// SQLite, which does not enforce a CHECK constraint, so a status added in Go without
// the migration passes every test here and then fails on the first real write -- at
// the end of a chat turn whose answer has already been generated.
func TestAnswerStatusSetMatchesTheMigrationCheckConstraint(t *testing.T) {
	goStatuses := []string{
		AnswerStatusAnswered,
		AnswerStatusNoBasis,
		AnswerStatusRetrievalFailed,
		AnswerStatusModelRefused,
	}

	path := filepath.Join("..", "..", "migrations", "019_document_versions_and_answer_status.sql")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}

	body := strings.SplitN(string(content), "ADD CONSTRAINT chat_messages_answer_status_check", 2)
	if len(body) != 2 {
		t.Fatal("chat_messages_answer_status_check not found in migration 019")
	}
	end := strings.Index(body[1], ");")
	if end < 0 {
		t.Fatal("chat_messages_answer_status_check is not terminated")
	}

	matches := regexp.MustCompile(`'([a-z_]+)'`).FindAllStringSubmatch(body[1][:end], -1)
	sqlStatuses := make([]string, 0, len(matches))
	for _, match := range matches {
		sqlStatuses = append(sqlStatuses, match[1])
	}
	if len(sqlStatuses) == 0 {
		t.Fatal("no values parsed out of the answer_status constraint")
	}

	inSQL := map[string]bool{}
	for _, status := range sqlStatuses {
		inSQL[status] = true
	}
	inGo := map[string]bool{}
	for _, status := range goStatuses {
		inGo[status] = true
	}

	missingFromSQL, missingFromGo := []string{}, []string{}
	for _, status := range goStatuses {
		if !inSQL[status] {
			missingFromSQL = append(missingFromSQL, status)
		}
	}
	for _, status := range sqlStatuses {
		if !inGo[status] {
			missingFromGo = append(missingFromGo, status)
		}
	}
	sort.Strings(missingFromSQL)
	sort.Strings(missingFromGo)

	if len(missingFromSQL) > 0 {
		t.Fatalf("answer_status %v defined in Go but rejected by the CHECK constraint", missingFromSQL)
	}
	if len(missingFromGo) > 0 {
		t.Fatalf("answer_status %v allowed by the CHECK constraint but not defined in Go", missingFromGo)
	}
}

// The gap categories are the same strings as the answer statuses, and the list
// endpoint accepts them as a filter. If the two ever diverge a client could filter on
// a category no row can carry, which looks like "no problems found".
func TestGapCategoryNamesMatchTheAnswerStatuses(t *testing.T) {
	pairs := []struct {
		category string
		status   string
	}{
		{"retrieval_failed", AnswerStatusRetrievalFailed},
		{"model_refused", AnswerStatusModelRefused},
	}
	for _, pair := range pairs {
		if pair.category != pair.status {
			t.Fatalf("gap category %q does not match answer status %q", pair.category, pair.status)
		}
	}
}
