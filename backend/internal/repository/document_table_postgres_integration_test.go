package repository

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/google/uuid"
	"gorm.io/datatypes"
	"kbchat/backend/internal/document/tableconfig"
)

func TestPostgresTableImportSettingsMigration(t *testing.T) {
	db, _ := newPostgresConcurrencyTestDBs(t)
	if err := db.Exec("ALTER TABLE documents ADD COLUMN error_code VARCHAR(32)").Error; err != nil {
		t.Fatal(err)
	}
	legacyID := uuid.New()
	if err := db.Exec("INSERT INTO documents (id, filename) VALUES (?, 'legacy.csv')", legacyID).Error; err != nil {
		t.Fatal(err)
	}
	sql, err := os.ReadFile("../../migrations/041_document_table_import.sql")
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := db.Exec(string(sql)).Error; err != nil {
			t.Fatal(err)
		}
	}
	var legacy struct{ TableImport datatypes.JSON }
	if err := db.Table("documents").Select("table_import").Where("id = ?", legacyID).Scan(&legacy).Error; err != nil || len(legacy.TableImport) != 0 {
		t.Fatalf("legacy defaults changed: %s %v", legacy.TableImport, err)
	}
	settings := tableconfig.Options{Sheets: []tableconfig.Sheet{{Name: "销售", HeaderRow: 3, Columns: []int{1, 4}}}}
	encoded, err := json.Marshal(settings)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Table("documents").Where("id = ?", legacyID).Update("table_import", datatypes.JSON(encoded)).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Table("documents").Select("table_import").Where("id = ?", legacyID).Scan(&legacy).Error; err != nil {
		t.Fatal(err)
	}
	decoded, err := tableconfig.Decode(legacy.TableImport)
	if err != nil || decoded.Sheets[0].HeaderRow != 3 || decoded.Sheets[0].Columns[1] != 4 {
		t.Fatalf("jsonb roundtrip: %s %v", legacy.TableImport, err)
	}
	if err := db.Table("documents").Where("id = ?", legacyID).Update("error_code", "table_import_invalid").Error; err != nil {
		t.Fatal(err)
	}
}
