package service

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"

	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/repository"
)

// Retrieval offsets let the source preview locate a citation in the original
// text; they have to survive the answer being stored and read back.
func TestCitationsKeepSourceOffsetsThroughPersistence(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)
	start, end := 12, 48
	chunkID := uuid.New()
	retrieval := &fakeChatRetrieval{response: &dto.SearchResponse{Items: []dto.SearchResultResponse{{
		ChunkID: chunkID.String(), DocumentID: uuid.New().String(), Filename: "manual.md",
		Content: "产品手册 > 安装\n正文", VectorScore: 0.8, StartOffset: &start, EndOffset: &end,
	}}}}
	chatProvider := &fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"安装","reason":"needs docs"}`,
		"answer",
	}}
	service := NewChatService(config.Config{VectorTopN: 30, RerankTopK: 5, ChatHistoryLimit: 10},
		repository.NewChatRepository(db), repository.NewKnowledgeBaseRepository(db), retrieval, chatProvider)

	res, err := service.SendMessage(ctx, user.ID, session.ID, dto.SendChatMessageRequest{Content: "怎么安装", ClientRequestID: uuid.New().String()})
	if err != nil {
		t.Fatalf("send message: %v", err)
	}
	if len(res.Citations) != 1 || res.Citations[0].StartOffset == nil || *res.Citations[0].StartOffset != start || *res.Citations[0].EndOffset != end {
		t.Fatalf("expected offsets on the response citation, got %#v", res.Citations)
	}

	stored, err := service.ListMessages(ctx, user.ID, session.ID)
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	var found bool
	for _, message := range stored.Items {
		for _, citation := range message.Citations {
			if citation.ChunkID == chunkID.String() {
				found = citation.StartOffset != nil && *citation.StartOffset == start && citation.EndOffset != nil && *citation.EndOffset == end
			}
		}
	}
	if !found {
		t.Fatalf("expected stored citation to keep its offsets, got %#v", stored.Items)
	}
}

// Citations written before offsets existed decode without them and serialize
// without the keys, so old answers are unchanged on the wire.
func TestCitationWithoutOffsetsOmitsThem(t *testing.T) {
	var citation dto.CitationResponse
	if err := json.Unmarshal([]byte(`{"documentId":"d","chunkId":"c","filename":"f","pageNumber":null,"content":"x","vectorScore":0.5,"rerankScore":null}`), &citation); err != nil {
		t.Fatal(err)
	}
	if citation.StartOffset != nil || citation.EndOffset != nil {
		t.Fatalf("expected no offsets, got %#v", citation)
	}
	encoded, err := json.Marshal(citation)
	if err != nil {
		t.Fatal(err)
	}
	var keys map[string]any
	_ = json.Unmarshal(encoded, &keys)
	if _, ok := keys["startOffset"]; ok {
		t.Fatalf("expected startOffset to be omitted, got %s", encoded)
	}
}
