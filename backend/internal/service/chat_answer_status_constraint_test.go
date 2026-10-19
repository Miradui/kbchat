package service

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// answer_status and intent have the same exposure as documents.error_code: the
// unit tests run on SQLite, which does not enforce a CHECK constraint, so a value
// added in Go without the migration passes every test here and then fails on the
// first real write -- at the end of a chat turn whose answer has already been
// generated. These tests compare the Go constant set with what the migration
// actually accepts.
func TestAnswerStatusSetMatchesTheMigrationCheckConstraint(t *testing.T) {
	goStatuses := []string{
		AnswerStatusAnswered,
		AnswerStatusNoBasis,
		AnswerStatusRetrievalFailed,
		AnswerStatusModelRefused,
	}

	sqlStatuses := parseConstraintValues(t, "019_document_versions_and_answer_status.sql", "chat_messages_answer_status_check")
	assertSameSet(t, "answer_status", goStatuses, sqlStatuses)
}

func TestChatIntentSetMatchesTheMigrationCheckConstraint(t *testing.T) {
	goIntents := []string{
		chatIntentConversation,
		chatIntentGeneral,
		chatIntentKnowledgeBase,
	}

	sqlIntents := parseConstraintValues(t, "048_chat_message_general_intent.sql", "chat_messages_intent_check")
	assertSameSet(t, "intent", goIntents, sqlIntents)
}

func parseConstraintValues(t *testing.T, migrationFile, constraint string) []string {
	t.Helper()

	path := filepath.Join("..", "..", "migrations", migrationFile)
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}

	body := strings.SplitN(string(content), "ADD CONSTRAINT "+constraint, 2)
	if len(body) != 2 {
		t.Fatalf("%s not found in %s", constraint, migrationFile)
	}
	end := strings.Index(body[1], ");")
	if end < 0 {
		t.Fatalf("%s is not terminated", constraint)
	}

	matches := regexp.MustCompile(`'([a-z_]+)'`).FindAllStringSubmatch(body[1][:end], -1)
	values := make([]string, 0, len(matches))
	for _, match := range matches {
		values = append(values, match[1])
	}
	if len(values) == 0 {
		t.Fatalf("no values parsed out of the %s constraint", constraint)
	}
	return values
}

func assertSameSet(t *testing.T, label string, goValues, sqlValues []string) {
	t.Helper()

	inSQL := map[string]bool{}
	for _, value := range sqlValues {
		inSQL[value] = true
	}
	inGo := map[string]bool{}
	for _, value := range goValues {
		inGo[value] = true
	}

	missingFromSQL, missingFromGo := []string{}, []string{}
	for _, value := range goValues {
		if !inSQL[value] {
			missingFromSQL = append(missingFromSQL, value)
		}
	}
	for _, value := range sqlValues {
		if !inGo[value] {
			missingFromGo = append(missingFromGo, value)
		}
	}
	sort.Strings(missingFromSQL)
	sort.Strings(missingFromGo)

	if len(missingFromSQL) > 0 {
		t.Fatalf("%s %v defined in Go but rejected by the CHECK constraint", label, missingFromSQL)
	}
	if len(missingFromGo) > 0 {
		t.Fatalf("%s %v allowed by the CHECK constraint but not defined in Go", label, missingFromGo)
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
