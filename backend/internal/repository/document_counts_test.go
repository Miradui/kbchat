package repository

import (
	"bytes"
	"context"
	"log"
	"strings"
	"testing"

	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"

	"kbchat/backend/internal/access"
)

func TestDocumentCountsUseOneQueryWithoutLoadingDocumentsOrJobs(t *testing.T) {
	db := newDocumentRepositoryTestDB(t)
	doc := createDocumentRepositoryTestDocument(t, db)
	var output bytes.Buffer
	observed := db.Session(&gorm.Session{Logger: gormlogger.New(log.New(&output, "", 0), gormlogger.Config{LogLevel: gormlogger.Info})})
	counts, err := NewDocumentRepository(observed).CountsForActor(context.Background(), doc.UploaderID,
		access.MemberRolesWith(access.CapDocumentRead), GlobalDocumentQuery{Status: "failed", Page: 9, PageSize: 1})
	if err != nil || counts != (DocumentCounts{Total: 1, Completed: 1}) {
		t.Fatalf("counts = %#v, %v", counts, err)
	}
	sql := output.String()
	if strings.Count(sql, "[rows:") != 1 || strings.Contains(sql, "document_jobs") || strings.Contains(sql, "LIMIT") {
		t.Fatalf("expected one aggregate statement without row/job loading: %s", sql)
	}
}
