package repository

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"

	"github.com/google/uuid"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/model"
)

func TestPostgresDocumentPDFSummaryMigration(t *testing.T) {
	db, _ := newPostgresConcurrencyTestDBs(t)
	documentID, jobID := uuid.New(), uuid.New()
	if err := db.Exec("INSERT INTO documents(id, status) VALUES (?, 'parsing')", documentID).Error; err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile("../../migrations/032_document_pdf_text_summary.sql")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := db.Exec(string(migration)).Error; err != nil {
			t.Fatal(err)
		}
	}
	var unknown int64
	if err := db.Raw("SELECT count(*) FROM documents WHERE pdf_text_summary IS NULL").Scan(&unknown).Error; err != nil || unknown != 1 {
		t.Fatalf("legacy summary must stay unknown: %d, %v", unknown, err)
	}
	if err := db.Exec("INSERT INTO document_jobs(id,document_id,job_type,status) VALUES (?,?,'process_document','running')", jobID, documentID).Error; err != nil {
		t.Fatal(err)
	}
	repo := NewDocumentRepository(db)
	summary := []byte(`{"totalPages":4,"textPages":2,"pagesWithoutText":[2,4]}`)
	if err := repo.SavePDFTextSummary(context.Background(), documentID, jobID, summary); err != nil {
		t.Fatal(err)
	}
	var loaded model.Document
	if err := db.Select("id", "pdf_text_summary").First(&loaded, "id = ?", documentID).Error; err != nil {
		t.Fatal(err)
	}
	var got struct {
		TotalPages       int
		TextPages        int
		PagesWithoutText []int
	}
	if err := json.Unmarshal(loaded.PDFTextSummary, &got); err != nil || got.TotalPages != 4 || got.TextPages != 2 || len(got.PagesWithoutText) != 2 || got.PagesWithoutText[1] != 4 {
		t.Fatalf("JSONB roundtrip: %+v, %v", got, err)
	}
	if err := db.Exec("UPDATE document_jobs SET status='cancelled' WHERE id=?", jobID).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.SavePDFTextSummary(context.Background(), documentID, jobID, []byte(`{}`)); !errors.Is(err, ErrDocumentJobCancelled) {
		t.Fatalf("inactive job replaced summary: %v", err)
	}
}

func TestPostgresDocumentCountsShareAccessAndFilters(t *testing.T) {
	db := newPostgresVectorTestDB(t)
	for _, statement := range []string{
		`CREATE TABLE knowledge_bases(id UUID PRIMARY KEY, owner_id UUID, name TEXT, deleted_at TIMESTAMPTZ)`,
		`CREATE TABLE knowledge_base_members(knowledge_base_id UUID, user_id UUID, role TEXT, PRIMARY KEY(knowledge_base_id,user_id))`,
		`CREATE TABLE documents(id UUID PRIMARY KEY, knowledge_base_id UUID, filename TEXT, file_type TEXT, status TEXT, deleted_at TIMESTAMPTZ)`,
	} {
		if err := db.Exec(statement).Error; err != nil {
			t.Fatal(err)
		}
	}
	owner, viewer, stranger, base := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	if err := db.Exec("INSERT INTO knowledge_bases(id,owner_id,name) VALUES (?,?,'PDF Library')", base, owner).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("INSERT INTO knowledge_base_members VALUES (?,?,'viewer')", base, viewer).Error; err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"completed", "uploaded", "parsing", "chunking", "embedding", "failed"} {
		if err := db.Exec("INSERT INTO documents VALUES (?,?,?,'pdf',?,NULL)", uuid.New(), base, "notes-"+status+".pdf", status).Error; err != nil {
			t.Fatal(err)
		}
	}
	repo := NewDocumentRepository(db)
	roles := access.MemberRolesWith(access.CapDocumentRead)
	assertCounts := func(actor uuid.UUID, query GlobalDocumentQuery, expected DocumentCounts) {
		t.Helper()
		counts, err := repo.CountsForActor(context.Background(), actor, roles, query)
		if err != nil || counts != expected {
			t.Fatalf("counts=%+v, expected=%+v, error=%v", counts, expected, err)
		}
	}
	all := DocumentCounts{Total: 6, Completed: 1, Processing: 4, Failed: 1}
	assertCounts(owner, GlobalDocumentQuery{}, all)
	assertCounts(viewer, GlobalDocumentQuery{Q: "pdf library", FileType: "pdf", KnowledgeBaseID: base, Status: "failed", Page: 7, PageSize: 1}, all)
	assertCounts(stranger, GlobalDocumentQuery{KnowledgeBaseID: base}, DocumentCounts{})
	assertCounts(viewer, GlobalDocumentQuery{Q: "notes-parsing"}, DocumentCounts{Total: 1, Processing: 1})
	assertCounts(viewer, GlobalDocumentQuery{FileType: "md"}, DocumentCounts{})
	if err := db.Exec("UPDATE documents SET deleted_at=NOW() WHERE status='completed'").Error; err != nil {
		t.Fatal(err)
	}
	assertCounts(viewer, GlobalDocumentQuery{}, DocumentCounts{Total: 5, Processing: 4, Failed: 1})
	if err := db.Exec("DELETE FROM knowledge_base_members WHERE user_id=?", viewer).Error; err != nil {
		t.Fatal(err)
	}
	assertCounts(viewer, GlobalDocumentQuery{}, DocumentCounts{})
	if err := db.Exec("UPDATE knowledge_bases SET deleted_at=NOW() WHERE id=?", base).Error; err != nil {
		t.Fatal(err)
	}
	assertCounts(owner, GlobalDocumentQuery{}, DocumentCounts{})
}
