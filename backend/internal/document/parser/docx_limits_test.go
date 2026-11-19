package parser

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
)

func styleGraphFixture(t testing.TB, count int) string {
	t.Helper()
	var styles strings.Builder
	styles.WriteString(`<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`)
	for i := 0; i < count; i++ {
		fmt.Fprintf(&styles, `<w:style w:styleId="cycle%d"><w:basedOn w:val="cycle%d"/></w:style>`, i, i)
		fmt.Fprintf(&styles, `<w:style w:styleId="chain%d"><w:basedOn w:val="chain%d"/></w:style>`, i, i+1)
	}
	fmt.Fprintf(&styles, `<w:style w:styleId="chain%d"><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>`, count)
	styles.WriteString(`<w:style w:styleId="a"><w:basedOn w:val="b"/></w:style><w:style w:styleId="b"><w:basedOn w:val="a"/></w:style></w:styles>`)
	return writeDOCXFixture(t, map[string]string{
		"word/styles.xml":   styles.String(),
		"word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="cycle0"/></w:pPr><w:r><w:t>plain</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="chain0"/></w:pPr><w:r><w:t>heading</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="a"/></w:pPr><w:r><w:t>cycle</w:t></w:r></w:p></w:body></w:document>`,
	})
}

func TestDOCXResolvesSharedStyleChainsAndCycles(t *testing.T) {
	file := styleGraphFixture(t, 5000)
	doc, err := NewDefaultParser().ParseDocument(file, "docx")
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	preview, err := ParseDOCXBytes(data)
	if err != nil {
		t.Fatal(err)
	}
	for _, result := range []ParsedDocument{doc, preview} {
		if len(result.Segments) != 1 || result.Segments[0].Content != "plain\n\n## heading\n\ncycle" {
			t.Fatalf("style inheritance changed rendered content: %#v", result)
		}
	}
}

func BenchmarkDOCXStyleGraph(b *testing.B) {
	data, err := os.ReadFile(styleGraphFixture(b, 5000))
	if err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := ParseDOCXBytes(data); err != nil {
			b.Fatal(err)
		}
	}
}

func TestDOCXRejectsNumericExpansion(t *testing.T) {
	for _, value := range []string{"-1", "9", "500000", "999999999999999999999999"} {
		t.Run("list_"+value, func(t *testing.T) {
			assertDOCXRejected(t, `<w:p><w:pPr><w:numPr><w:ilvl w:val="`+value+`"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>item</w:t></w:r></w:p>`)
		})
	}
	for _, value := range []string{"-1", "0", "257", "100000", "999999999999999999999999"} {
		t.Run("span_"+value, func(t *testing.T) {
			assertDOCXRejected(t, `<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="`+value+`"/></w:tcPr><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`)
		})
	}
}

func TestDOCXRejectsAggregateExpansion(t *testing.T) {
	cell := `<w:tc><w:tcPr><w:gridSpan w:val="256"/></w:tcPr><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc>`
	t.Run("combined_row_width", func(t *testing.T) {
		assertDOCXRejected(t, `<w:tbl><w:tr>`+cell+cell+`</w:tr></w:tbl>`)
	})
	t.Run("padded_cells", func(t *testing.T) {
		assertDOCXRejected(t, `<w:tbl>`+strings.Repeat(`<w:tr>`+cell+`</w:tr>`, 400)+`</w:tbl>`)
	})
	t.Run("recursive_containers", func(t *testing.T) {
		assertDOCXRejected(t, strings.Repeat(`<w:sdt>`, 150)+`<w:p><w:r><w:t>deep</w:t></w:r></w:p>`+strings.Repeat(`</w:sdt>`, 150))
	})
	t.Run("element_budget", func(t *testing.T) {
		assertDOCXRejected(t, strings.Repeat(`<w:p/>`, 200001))
	})
	t.Run("text_budget", func(t *testing.T) {
		assertDOCXRejected(t, `<w:p><w:r><w:t>`+strings.Repeat("x", 8*1024*1024+1)+`</w:t></w:r></w:p>`)
	})
}

func assertDOCXRejected(t *testing.T, body string) {
	t.Helper()
	file := writeDOCXFixture(t, map[string]string{"word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` + body + `</w:body></w:document>`})
	if _, err := NewDefaultParser().ParseDocument(file, "docx"); !errors.Is(err, ErrCorruptFile) {
		t.Fatalf("file parser must reject unsupported DOCX structure: %v", err)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseDOCXBytes(data); !errors.Is(err, ErrCorruptFile) {
		t.Fatalf("byte parser must reject unsupported DOCX structure: %v", err)
	}
}
