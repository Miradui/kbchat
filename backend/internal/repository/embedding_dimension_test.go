package repository

import "testing"

func TestCheckEmbeddingDimension(t *testing.T) {
	for _, test := range []struct {
		actual, configured int
		valid              bool
	}{{1536, 1536, true}, {1024, 1536, false}, {0, 1536, false}, {-1, 1536, false}, {1536, 0, false}} {
		err := CheckEmbeddingDimension(test.actual, test.configured)
		if (err == nil) != test.valid {
			t.Fatalf("actual=%d configured=%d: %v", test.actual, test.configured, err)
		}
	}
}
