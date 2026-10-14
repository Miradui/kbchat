package processor

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The migration is the source of truth for the schema, so the Go constants have to
// match it exactly. A value defined here but missing from the CHECK constraint makes
// every write of it fail with a constraint violation -- at the point a document has
// already failed to process, which is the worst moment to lose the reason. A value
// in the constraint but missing here is dead schema.
//
// Both directions are checked because the drift is silent either way: the unit tests
// pass on SQLite, which does not enforce the constraint, and nothing else compares
// the two lists.
func TestErrorCodeSetMatchesTheMigrationCheckConstraint(t *testing.T) {
	goCodes := []string{
		ErrorCodeUnsupportedType,
		ErrorCodeCorruptFile,
		ErrorCodeEncodingInvalid,
		ErrorCodeEmptyContent,
		ErrorCodeEmbeddingFailed,
		ErrorCodeStorageFailed,
		ErrorCodeCancelled,
		ErrorCodeInternal,
		ErrorCodeTableLimit,
		ErrorCodeTableImport,
	}

	sqlCodes := checkConstraintValues(t, "documents_error_code_check")
	assertSameSet(t, "documents.error_code", goCodes, sqlCodes)
}

// checkConstraintValues pulls the quoted values out of one named CHECK constraint in
// migration 041. Parsed rather than hard-coded: a copy of the list here would drift
// from the migration in exactly the way this test exists to catch.
func checkConstraintValues(t *testing.T, constraintName string) []string {
	t.Helper()

	path := filepath.Join("..", "..", "..", "migrations", "041_document_table_import.sql")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}

	body := strings.SplitN(string(content), "ADD CONSTRAINT "+constraintName, 2)
	if len(body) != 2 {
		t.Fatalf("constraint %s not found in %s", constraintName, path)
	}
	end := strings.Index(body[1], ");")
	if end < 0 {
		t.Fatalf("constraint %s is not terminated", constraintName)
	}

	values := regexp.MustCompile(`'([a-z_]+)'`).FindAllStringSubmatch(body[1][:end], -1)
	codes := make([]string, 0, len(values))
	for _, match := range values {
		codes = append(codes, match[1])
	}
	if len(codes) == 0 {
		t.Fatalf("no values parsed out of constraint %s", constraintName)
	}
	return codes
}

func assertSameSet(t *testing.T, subject string, goValues, sqlValues []string) {
	t.Helper()

	inSQL := map[string]bool{}
	for _, value := range sqlValues {
		inSQL[value] = true
	}
	inGo := map[string]bool{}
	for _, value := range goValues {
		inGo[value] = true
	}

	missingFromSQL := []string{}
	for _, value := range goValues {
		if !inSQL[value] {
			missingFromSQL = append(missingFromSQL, value)
		}
	}
	missingFromGo := []string{}
	for _, value := range sqlValues {
		if !inGo[value] {
			missingFromGo = append(missingFromGo, value)
		}
	}
	sort.Strings(missingFromSQL)
	sort.Strings(missingFromGo)

	if len(missingFromSQL) > 0 {
		t.Fatalf(
			"%s: %v defined in Go but not allowed by the CHECK constraint -- every write of these would fail",
			subject, missingFromSQL,
		)
	}
	if len(missingFromGo) > 0 {
		t.Fatalf(
			"%s: %v allowed by the CHECK constraint but not defined in Go -- dead schema",
			subject, missingFromGo,
		)
	}
}
