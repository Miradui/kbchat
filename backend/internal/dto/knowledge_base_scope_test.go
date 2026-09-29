package dto

import (
	"github.com/google/uuid"
	"testing"
)

func TestParseKnowledgeBaseScope(t *testing.T) {
	a, b := uuid.NewString(), uuid.NewString()
	for _, test := range []struct {
		name, primary string
		ids           []string
		want          int
	}{
		{"legacy", a, nil, 1}, {"many", "", []string{a, b}, 2}, {"both", a, []string{a, b}, 2},
		{"missing", "", nil, 0}, {"empty-array", a, []string{}, 0}, {"duplicate", "", []string{a, a}, 0},
		{"mismatch", b, []string{a, b}, 0}, {"nil-id", "", []string{uuid.Nil.String()}, 0},
		{"too-many", "", []string{a, b, uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()}, 0},
		{"five", "", []string{a, b, uuid.NewString(), uuid.NewString(), uuid.NewString()}, 5},
	} {
		t.Run(test.name, func(t *testing.T) {
			ids, err := ParseKnowledgeBaseIDs(test.primary, test.ids)
			if test.want == 0 {
				if err == nil {
					t.Fatal("invalid scope accepted")
				}
				return
			}
			if err != nil || len(ids) != test.want {
				t.Fatalf("scope: %v %v", ids, err)
			}
		})
	}
}
