package model

import (
	"context"
	"fmt"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"gorm.io/gorm/schema"
)

// SearchVector is the keyword index of a chunk: a tsvector literal produced by
// lexer.TSVector. The application builds the literal itself so indexing and
// querying share one tokenizer; PostgreSQL only parses the literal syntax.
//
// On PostgreSQL the value is written through a `::tsvector` cast. On other
// dialects (the SQLite test fixtures) it is stored as plain text, which is
// enough for those tests since none of them run a keyword query.
type SearchVector string

var _ schema.GormDataTypeInterface = SearchVector("")
var _ gorm.Valuer = SearchVector("")

func (SearchVector) GormDataType() string { return "tsvector" }

func (v SearchVector) GormValue(_ context.Context, db *gorm.DB) clause.Expr {
	if db.Dialector.Name() == "postgres" {
		return clause.Expr{SQL: "?::tsvector", Vars: []any{string(v)}}
	}
	return clause.Expr{SQL: "?", Vars: []any{string(v)}}
}

// Scan accepts the text form PostgreSQL returns for tsvector; the value is kept
// only so a full-row SELECT does not fail, no code reads it back.
func (v *SearchVector) Scan(value any) error {
	switch raw := value.(type) {
	case nil:
		*v = ""
	case string:
		*v = SearchVector(raw)
	case []byte:
		*v = SearchVector(raw)
	default:
		return fmt.Errorf("SearchVector: cannot scan %T", value)
	}
	return nil
}
