package repository

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/google/uuid"
	"gorm.io/datatypes"
	"kbchat/backend/internal/model"
)

func TestPostgresPDFOCRMigrationAndSnapshotLifecycle(t *testing.T) {
	db, _ := newPostgresConcurrencyTestDBs(t)
	if err := db.Exec("ALTER TABLE documents ADD COLUMN error_code VARCHAR(32)").Error; err != nil {
		t.Fatal(err)
	}
	sql, err := os.ReadFile("../../migrations/043_document_pdf_ocr.sql")
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := db.Exec(string(sql)).Error; err != nil {
			t.Fatal(err)
		}
	}
	id := uuid.New()
	if err := db.Exec("INSERT INTO documents (id,filename) VALUES (?, 'scanned.pdf')", id).Error; err != nil {
		t.Fatal(err)
	}
	repo := NewDocumentRepository(db)
	if content, err := repo.PDFSnapshot(context.Background(), id); err != nil || len(content) != 0 {
		t.Fatal("legacy document has invented OCR snapshot", err)
	}
	content := datatypes.JSON(`{"version":1,"totalPages":2,"pages":[{"pageNumber":2,"content":"中文识别内容","textSource":"ocr"}]}`)
	if err := db.Create(&model.DocumentPDFSnapshot{DocumentID: id, Content: content}).Error; err != nil {
		t.Fatal(err)
	}
	read, err := repo.PDFSnapshot(context.Background(), id)
	var got, want any
	if err != nil || json.Unmarshal(read, &got) != nil || json.Unmarshal(content, &want) != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("JSONB OCR snapshot mismatch %s %v", read, err)
	}
	for _, code := range []string{"pdf_limit_exceeded", "ocr_unavailable", "ocr_timeout", "ocr_failed", "ocr_limit_exceeded"} {
		if err := db.Table("documents").Where("id = ?", id).Update("error_code", code).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Exec("DELETE FROM documents WHERE id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	if read, err := repo.PDFSnapshot(context.Background(), id); err != nil || len(read) != 0 {
		t.Fatal("hard delete left OCR snapshot", err)
	}
}
