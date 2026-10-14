package service

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"kbchat/backend/internal/document/tableconfig"
	"kbchat/backend/internal/model"
)

func TestTableImportSettingsPersistAcrossPreviewComparisonReprocessAndRetry(t *testing.T) {
	s := newWorkspaceTestServices(t)
	ctx := context.Background()
	actor := createWorkspaceUser(t, s.db, "table-settings")
	kb := createWorkspaceKB(t, s.db, actor.ID, uuid.Nil, "tables", "private", time.Now())
	file := createUploadFile(t, "表格.csv", "报表说明\n名称,价格,备注\n设备,8,不要导入\n")
	settings := &tableconfig.Options{Sheets: []tableconfig.Sheet{{HeaderRow: 2, Columns: []int{2, 1}}}}
	opts := DocumentUploadOptions{TableImport: settings, RequestID: uuid.NewString()}
	doc, err := s.documents.UploadWithOptions(ctx, actor.ID, kb.ID, file, opts)
	if err != nil || doc.TableImport == nil || !reflect.DeepEqual(doc.TableImport.Sheets[0].Columns, []int{1, 2}) {
		t.Fatalf("settings: %+v %v", doc, err)
	}
	preview, err := s.documents.Preview(ctx, actor.ID, uuid.MustParse(doc.ID))
	if err != nil || strings.Contains(preview.Content, "不要导入") || len(preview.TableRows) != 1 || preview.TableRows[0].HeaderRow != 2 {
		t.Fatalf("preview settings lost: %+v %v", preview, err)
	}
	settings.Sheets[0].Columns = []int{1, 2}
	replayed, err := s.documents.UploadWithOptions(ctx, actor.ID, kb.ID, file, opts)
	if err != nil || replayed.ID != doc.ID {
		t.Fatalf("canonical replay: %+v %v", replayed, err)
	}
	settings.Sheets[0].Columns = []int{3}
	_, err = s.documents.UploadWithOptions(ctx, actor.ID, kb.ID, file, opts)
	assertAppError(t, err, "DOCUMENT_UPLOAD_REQUEST_CONFLICT")
	if err := s.db.Model(&model.Document{}).Where("id = ?", doc.ID).Update("status", "completed").Error; err != nil {
		t.Fatal(err)
	}
	if err := s.db.Model(&model.DocumentJob{}).Where("document_id = ?", doc.ID).Update("status", "completed").Error; err != nil {
		t.Fatal(err)
	}
	var stored model.Document
	if err := s.db.First(&stored, "id = ?", doc.ID).Error; err != nil {
		t.Fatal(err)
	}
	lines, err := s.documents.comparableText(ctx, stored)
	if err != nil || strings.Contains(strings.Join(lines, "\n"), "不要导入") {
		t.Fatalf("comparison settings lost: %v %v", lines, err)
	}
	reprocessed, err := s.documents.Reprocess(ctx, actor.ID, stored.ID)
	if err != nil || !reflect.DeepEqual(reprocessed.TableImport, doc.TableImport) {
		t.Fatalf("reprocess settings lost: %+v %v", reprocessed, err)
	}
}

func TestTableInspectionAndInvalidSettingsNeverCreateDocuments(t *testing.T) {
	s := newWorkspaceTestServices(t)
	ctx := context.Background()
	actor := createWorkspaceUser(t, s.db, "table-preview")
	other := createWorkspaceUser(t, s.db, "table-no-access")
	kb := createWorkspaceKB(t, s.db, actor.ID, uuid.Nil, "tables", "private", time.Now())
	file := createUploadFile(t, "表.csv", "名称,数量\n甲,2\n")
	preview, err := s.documents.InspectTable(ctx, actor.ID, kb.ID, file)
	if err != nil || preview.Sheets[0].ColumnCount != 2 {
		t.Fatalf("inspection: %+v %v", preview, err)
	}
	if _, err := s.documents.InspectTable(ctx, other.ID, kb.ID, file); err == nil {
		t.Fatal("private inspection allowed")
	}
	_, err = s.documents.UploadWithOptions(ctx, actor.ID, kb.ID, file, DocumentUploadOptions{TableImport: &tableconfig.Options{Sheets: []tableconfig.Sheet{{HeaderRow: 99}}}})
	assertAppError(t, err, "DOCUMENT_TABLE_IMPORT_INVALID")
	var count int64
	s.db.Model(&model.Document{}).Count(&count)
	if count != 0 || countUploadedFiles(t, s.uploadRoot) != 0 {
		t.Fatal("preflight wrote documents or objects")
	}
}
