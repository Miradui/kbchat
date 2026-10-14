package retrieval

import (
	"gorm.io/datatypes"
	"testing"
)

func TestOCRSourceRequiresPDFMetadata(t *testing.T) {
	for _, test := range []struct{ input, want string }{
		{`{"fileType":"pdf","textSource":"ocr"}`, "ocr"},
		{`{"fileType":"txt","textSource":"ocr"}`, ""},
		{`{"fileType":"pdf","textSource":"unknown"}`, ""},
		{`{}`, ""}, {`invalid`, ""},
	} {
		if got := chunkTextSource(datatypes.JSON(test.input)); got != test.want {
			t.Fatalf("%s: %q", test.input, got)
		}
	}
}
