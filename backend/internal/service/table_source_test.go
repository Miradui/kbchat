package service

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/repository"
)

func TestTablePreviewExposesPhysicalRowsAndUTF8Offsets(t *testing.T) {
	f := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, f.db, "table-owner")
	other := createWorkspaceUser(t, f.db, "table-other")
	kb := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "tables", "private", time.Now())
	doc, err := f.documents.Upload(ctx, owner.ID, kb.ID, createUploadFile(t, "资料.csv", "名称,说明\n\n甲😀,\"第一行\n第二行\"\n乙,最后\n"))
	if err != nil {
		t.Fatal(err)
	}
	p, err := f.documents.Preview(ctx, owner.ID, uuid.MustParse(doc.ID))
	if err != nil || p.Kind != "text" || len(p.TableRows) != 2 {
		t.Fatalf("preview: %#v %v", p, err)
	}
	for i, row := range p.TableRows {
		if row.StartOffset < 0 || row.EndOffset > len(p.Content) || row.StartOffset >= row.EndOffset {
			t.Fatalf("invalid byte range: %#v", row)
		}
		part := p.Content[row.StartOffset:row.EndOffset]
		if i == 0 && (row.RowStart != 3 || row.RowEnd != 4 || !strings.Contains(part, "名称：甲😀") || strings.Contains(part, "最后")) {
			t.Fatalf("wrong physical row or UTF8 range: %#v %q", row, part)
		}
	}
	if _, err := f.documents.Preview(ctx, other.ID, uuid.MustParse(doc.ID)); err == nil {
		t.Fatal("another user could preview private table")
	}
}

func TestTableCitationsKeepSourcesInPromptAndStoredAnswers(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)
	table := &dto.TableSource{SheetName: "销售", HeaderRow: 2, RowStart: 5, RowEnd: 5}
	r := &fakeChatRetrieval{response: &dto.SearchResponse{Items: []dto.SearchResultResponse{{
		ChunkID: uuid.NewString(), DocumentID: uuid.NewString(), Filename: "资料.xlsx", Content: "产品：设备\n金额：3", Table: table,
	}}}}
	p := &fakeChatProvider{responses: []string{`{"intent":"knowledge_base","standaloneQuery":"设备金额","reason":"docs"}`, "设备金额为 3。[1]"}}
	s := NewChatService(config.Config{VectorTopN: 30, RerankTopK: 5, ChatHistoryLimit: 10}, repository.NewChatRepository(db), repository.NewKnowledgeBaseRepository(db), r, p)
	res, err := s.SendMessage(ctx, user.ID, session.ID, dto.SendChatMessageRequest{Content: "设备金额？", ClientRequestID: uuid.NewString()})
	if err != nil || len(res.Citations) != 1 || res.Citations[0].Table == nil || *res.Citations[0].Table != *table {
		t.Fatalf("response provenance: %#v %v", res, err)
	}
	prompt := p.messages[len(p.messages)-1].Content
	for _, expected := range []string{"sheetName: 销售", "rowStart: 5", "rowEnd: 5", "产品：设备"} {
		if !strings.Contains(prompt, expected) {
			t.Errorf("prompt lost %q", expected)
		}
	}
	messages, err := s.ListMessages(ctx, user.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	last := messages.Items[len(messages.Items)-1]
	if len(last.Citations) != 1 || last.Citations[0].Table == nil || *last.Citations[0].Table != *table || last.Citations[0].StartOffset != nil {
		t.Fatalf("stored answer lost source or invented offsets: %#v", last)
	}
}
