package service

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"gorm.io/datatypes"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"os"
	"testing"
	"time"
)

type documentScopeRetrieval struct {
	request dto.SearchRequest
	calls   int
	docID   string
}

func (r *documentScopeRetrieval) Search(_ context.Context, _ uuid.UUID, kb uuid.UUID, request dto.SearchRequest) (*dto.SearchResponse, error) {
	r.request = request
	r.calls++
	return &dto.SearchResponse{Items: []dto.SearchResultResponse{{DocumentID: r.docID, KnowledgeBaseID: kb.String(), ChunkID: uuid.NewString(), Content: "所选文档的事实"}}}, nil
}

func TestDocumentChatScopePersistsAndNeverWidensAfterMove(t *testing.T) {
	ctx := context.Background()
	f := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, f.db, "scope-owner")
	kb := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "scope", "private", time.Now())
	document, err := f.documents.CreateText(ctx, owner.ID, kb.ID, dto.TextDocumentRequest{Title: "scope", Content: "content"})
	if err != nil {
		t.Fatal(err)
	}
	ret := &documentScopeRetrieval{docID: document.ID}
	f.chats.retrieval = ret
	f.chats.chatProvider = &fakeChatProvider{response: "所选资料 [source: 1]"}
	session, err := f.chats.CreateSession(ctx, owner.ID, dto.CreateChatSessionRequest{KnowledgeBaseID: kb.ID.String(), DocumentIDs: []string{document.ID}})
	if err != nil {
		t.Fatal(err)
	}
	sid := uuid.MustParse(session.ID)
	loaded, err := f.chats.GetSession(ctx, owner.ID, sid)
	if err != nil || len(loaded.Documents) != 1 || loaded.Documents[0].ID != document.ID {
		t.Fatalf("scope lost: %+v %v", loaded, err)
	}
	_, err = f.chats.SendMessage(ctx, owner.ID, sid, dto.SendChatMessageRequest{Content: "事实是什么", ClientRequestID: uuid.NewString()})
	if err != nil {
		t.Fatal(err)
	}
	if len(ret.request.DocumentIDs) != 1 || ret.request.DocumentIDs[0] != document.ID {
		t.Fatalf("unscoped request: %+v", ret.request)
	}
	other := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "other", "private", time.Now())
	if err = f.db.Model(&model.Document{}).Where("id = ?", document.ID).Update("knowledge_base_id", other.ID).Error; err != nil {
		t.Fatal(err)
	}
	_, err = f.chats.SendMessage(ctx, owner.ID, sid, dto.SendChatMessageRequest{Content: "再问一次", ClientRequestID: uuid.NewString()})
	assertAdminError(t, err, 409, "DOCUMENT_SCOPE_UNAVAILABLE")
	if ret.calls != 1 {
		t.Fatal("invalid document scope reached retrieval")
	}
	_, err = f.chats.CreateSession(ctx, owner.ID, dto.CreateChatSessionRequest{KnowledgeBaseID: kb.ID.String(), DocumentIDs: []string{document.ID}})
	assertAdminError(t, err, 409, "DOCUMENT_SCOPE_UNAVAILABLE")
}

func TestTextRevisionIdempotencyConflictAndOriginalBytes(t *testing.T) {
	ctx := context.Background()
	f := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, f.db, "edit-owner")
	kb := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "edit", "private", time.Now())
	old, err := f.documents.CreateText(ctx, owner.ID, kb.ID, dto.TextDocumentRequest{Title: "说明", Content: "# 原文\r\n中文\r\n", Format: "md"})
	if err != nil {
		t.Fatal(err)
	}
	id := uuid.MustParse(old.ID)
	text, err := f.documents.EditableText(ctx, owner.ID, id)
	if err != nil || text.Content != "# 原文\r\n中文\r\n" {
		t.Fatalf("original: %+v %v", text, err)
	}
	req := SaveDocumentTextRequest{RequestID: uuid.NewString(), Content: "# 新版\n修正后的中文\n"}
	saved, err := f.documents.SaveTextRevision(ctx, owner.ID, id, req)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := f.documents.SaveTextRevision(ctx, owner.ID, id, req)
	if err != nil || replay.ID != saved.ID {
		t.Fatalf("replay: %+v %v", replay, err)
	}
	var stored model.Document
	if err = f.db.First(&stored, "id = ?", saved.ID).Error; err != nil {
		t.Fatal(err)
	}
	bytes, err := os.ReadFile(stored.StoragePath)
	if err != nil || string(bytes) != req.Content {
		t.Fatalf("saved bytes %q %v", bytes, err)
	}
	original, err := f.documents.EditableText(ctx, owner.ID, id)
	if err != nil || original.Content != text.Content {
		t.Fatal("original was overwritten")
	}
	req.RequestID = uuid.NewString()
	req.Content = "另一用户的修改"
	_, err = f.documents.SaveTextRevision(ctx, owner.ID, id, req)
	assertAdminError(t, err, 409, "DOCUMENT_ALREADY_SUPERSEDED")
	stranger := createWorkspaceUser(t, f.db, "edit-stranger")
	_, err = f.documents.EditableText(ctx, stranger.ID, id)
	if err == nil {
		t.Fatal("unauthorized original read")
	}
}

func TestVersionStatusUsesPublishedContentAcrossDeletedIntermediate(t *testing.T) {
	ctx := context.Background()
	f := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, f.db, "status-owner")
	kb := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "status", "private", time.Now())
	docs := make([]*dto.DocumentResponse, 3)
	for i := range docs {
		doc, err := f.documents.CreateText(ctx, owner.ID, kb.ID, dto.TextDocumentRequest{Title: uuid.NewString(), Content: uuid.NewString()})
		if err != nil {
			t.Fatal(err)
		}
		docs[i] = doc
	}
	for i := 0; i < 2; i++ {
		if err := f.db.Model(&model.Document{}).Where("id = ?", docs[i].ID).Update("superseded_by_id", docs[i+1].ID).Error; err != nil {
			t.Fatal(err)
		}
	}
	publish := func(index int) {
		t.Helper()
		if err := f.db.Create(&model.DocumentChunk{DocumentID: uuid.MustParse(docs[index].ID), KnowledgeBaseID: kb.ID, Content: "published", Metadata: datatypes.JSON("{}")}).Error; err != nil {
			t.Fatal(err)
		}
	}
	publish(0)
	state, err := f.documents.VersionStatus(ctx, owner.ID, []string{docs[0].ID})
	if err != nil || state[0].State != "current" || !state[0].NewerPending {
		t.Fatalf("pending newer: %+v %v", state, err)
	}
	publish(2)
	f.db.Delete(&model.Document{}, "id = ?", docs[1].ID)
	state, err = f.documents.VersionStatus(ctx, owner.ID, []string{docs[0].ID})
	if err != nil || state[0].Current.ID != docs[2].ID || state[0].State != "newer_available" {
		t.Fatalf("latest: %+v %v", state, err)
	}
}

func TestOCRCorrectionCopiesPDFAndPreservesPageSources(t *testing.T) {
	ctx := context.Background()
	f := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, f.db, "correction-owner")
	kb := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "ocr", "private", time.Now())
	doc, err := f.documents.Upload(ctx, owner.ID, kb.ID, createUploadFile(t, "scan.pdf", "%PDF-fixture-original"))
	if err != nil {
		t.Fatal(err)
	}
	id := uuid.MustParse(doc.ID)
	snapshot := datatypes.JSON(`{"version":1,"totalPages":2,"pages":[{"pageNumber":1,"content":"原生文字"},{"pageNumber":2,"content":"错别宇","textSource":"ocr"}]}`)
	if err = f.db.Create(&model.DocumentPDFSnapshot{DocumentID: id, Content: snapshot}).Error; err != nil {
		t.Fatal(err)
	}
	view, err := f.documents.PDFCorrection(ctx, owner.ID, id)
	if err != nil || len(view.Pages) != 1 || view.Pages[0].PageNumber != 2 {
		t.Fatalf("view: %+v %v", view, err)
	}
	req := SavePDFCorrectionRequest{RequestID: uuid.NewString(), Revision: view.Revision, Pages: []PDFCorrectionPage{{PageNumber: 1, Content: "不能改原生页"}}}
	_, err = f.documents.SavePDFCorrection(ctx, owner.ID, id, req)
	assertAdminError(t, err, 400, "VALIDATION_ERROR")
	req.Pages = []PDFCorrectionPage{{PageNumber: 2, Content: "错别字已校正"}}
	saved, err := f.documents.SavePDFCorrection(ctx, owner.ID, id, req)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := f.documents.SavePDFCorrection(ctx, owner.ID, id, req)
	if err != nil || replay.ID != saved.ID {
		t.Fatalf("replay %+v %v", replay, err)
	}
	var baseline model.DocumentPDFCorrection
	if err = f.db.First(&baseline, "document_id = ?", saved.ID).Error; err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Pages []PDFCorrectionPage `json:"pages"`
	}
	if err = json.Unmarshal(baseline.Content, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Pages[0].Content != "原生文字" || decoded.Pages[0].TextSource != "" || decoded.Pages[1].TextSource != "ocr_corrected" {
		t.Fatalf("sources: %+v", decoded)
	}
	var copy model.Document
	f.db.First(&copy, "id = ?", saved.ID)
	bytes, err := os.ReadFile(copy.StoragePath)
	if err != nil || string(bytes) != "%PDF-fixture-original" {
		t.Fatal("PDF image bytes changed")
	}
}
