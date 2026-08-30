package access

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The role set is written twice: as AssignableRoles here and as a CHECK constraint
// in the migration. The unit tests run on SQLite, which does not enforce CHECK, so
// a role added in Go without the migration passes every test and then fails on the
// first real write -- while an owner is trying to grant someone access.
func TestAssignableRolesMatchTheMigrationCheckConstraint(t *testing.T) {
	path := filepath.Join("..", "..", "migrations", "020_member_role_matrix.sql")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}

	body := strings.SplitN(string(content), "ADD CONSTRAINT knowledge_base_members_role_check", 2)
	if len(body) != 2 {
		t.Fatal("knowledge_base_members_role_check not found in migration 020")
	}
	end := strings.Index(body[1], ");")
	if end < 0 {
		t.Fatal("knowledge_base_members_role_check is not terminated")
	}

	matches := regexp.MustCompile(`'([a-z_]+)'`).FindAllStringSubmatch(body[1][:end], -1)
	sqlRoles := make([]string, 0, len(matches))
	for _, match := range matches {
		sqlRoles = append(sqlRoles, match[1])
	}
	if len(sqlRoles) == 0 {
		t.Fatal("no values parsed out of the role constraint")
	}

	inSQL := map[string]bool{}
	for _, role := range sqlRoles {
		inSQL[role] = true
	}
	inGo := map[string]bool{}
	for _, role := range AssignableRoles {
		inGo[string(role)] = true
	}

	missingFromSQL, missingFromGo := []string{}, []string{}
	for _, role := range AssignableRoles {
		if !inSQL[string(role)] {
			missingFromSQL = append(missingFromSQL, string(role))
		}
	}
	for _, role := range sqlRoles {
		if !inGo[role] {
			missingFromGo = append(missingFromGo, role)
		}
	}
	sort.Strings(missingFromSQL)
	sort.Strings(missingFromGo)

	if len(missingFromSQL) > 0 {
		t.Fatalf("roles %v are assignable in Go but rejected by the CHECK constraint", missingFromSQL)
	}
	if len(missingFromGo) > 0 {
		t.Fatalf("roles %v are allowed by the CHECK constraint but not assignable in Go", missingFromGo)
	}
}

// The old vocabulary must not survive anywhere. A leftover 'member' row would
// resolve to RoleNone and silently strip access from someone the owner added, and
// the rewrite in the migration is the only thing preventing that.
func TestMigrationRewritesTheOldMemberRole(t *testing.T) {
	path := filepath.Join("..", "..", "migrations", "020_member_role_matrix.sql")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	sql := string(content)

	if !strings.Contains(sql, "WHERE role = 'member'") {
		t.Error("migration 020 does not rewrite the legacy 'member' rows")
	}
	if !strings.Contains(sql, "WHERE role NOT IN ('viewer', 'editor', 'manager')") {
		t.Error("migration 020 does not collapse unrecognised roles, so the new constraint can fail on existing data")
	}
	// The UPDATEs have to run without the old constraint in force, since it
	// forbids 'viewer'.
	dropAt := strings.Index(sql, "DROP CONSTRAINT IF EXISTS knowledge_base_members_role_check")
	updateAt := strings.Index(sql, "UPDATE knowledge_base_members")
	addAt := strings.Index(sql, "ADD CONSTRAINT knowledge_base_members_role_check")
	if dropAt < 0 || updateAt < 0 || addAt < 0 {
		t.Fatal("migration 020 is missing the drop/update/add sequence")
	}
	if !(dropAt < updateAt && updateAt < addAt) {
		t.Fatalf("migration 020 must drop the old constraint, then rewrite rows, then add the new one; got offsets drop=%d update=%d add=%d", dropAt, updateAt, addAt)
	}
	if Valid("member") {
		t.Fatal(`Valid("member") = true; the legacy value must not be assignable after this migration`)
	}
}
