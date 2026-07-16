package dto

import (
	"encoding/json"
	"testing"
)

func TestChunkListResponseIncludesPaginationFieldsWhenEmpty(t *testing.T) {
	payload, err := json.Marshal(ChunkListResponse{Items: []ChunkResponse{}})
	if err != nil {
		t.Fatalf("marshal chunk list response: %v", err)
	}

	var body map[string]json.RawMessage
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatalf("unmarshal chunk list response: %v", err)
	}
	for _, field := range []string{"total", "page", "pageSize"} {
		if _, ok := body[field]; !ok {
			t.Fatalf("expected %q in empty chunk list response, got %s", field, payload)
		}
	}
}

func TestChatSessionResponseIncludesNullArchivedAt(t *testing.T) {
	payload, err := json.Marshal(ChatSessionResponse{})
	if err != nil {
		t.Fatalf("marshal chat session response: %v", err)
	}

	var body map[string]json.RawMessage
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatalf("unmarshal chat session response: %v", err)
	}
	archivedAt, ok := body["archivedAt"]
	if !ok {
		t.Fatalf("expected archivedAt in unarchived session response, got %s", payload)
	}
	if string(archivedAt) != "null" {
		t.Fatalf("expected null archivedAt, got %s", archivedAt)
	}
}
