package parser

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPDFTextOperatorsDoNotDecodeLineBreaksAsGlyphs(t *testing.T) {
	path := writePDFTextFixture(t, []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 9 0 R >>",
		pdfTextFixtureStream("BT /F1 12 Tf 14 TL 20 180 Td <01> Tj T* <02> Tj ET"),
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 7 0 R >> >> /Contents 8 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 10 0 R >>",
		pdfTextFixtureStream("BT /F1 12 Tf 14 TL 20 180 Td <01> Tj T* <02> Tj ET"),
		pdfTextFixtureCMap("7532", "4E59"),
		pdfTextFixtureCMap("4E19", "4E01"),
	})
	doc, err := NewDefaultParser().ParseDocument(path, "pdf")
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Segments) != 2 {
		t.Fatalf("expected two physical pages, got %d", len(doc.Segments))
	}
	for i, want := range []string{"甲\n乙", "丙\n丁"} {
		if doc.Segments[i].Content != want || *doc.Segments[i].PageNumber != i+1 {
			t.Errorf("page %d: got %q, want %q with independent page fonts", i+1, doc.Segments[i].Content, want)
		}
	}
}

func TestPDFTextSupportsQuotedAndPositionedLines(t *testing.T) {
	path := writePDFTextFixture(t, []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		pdfTextFixtureStream("BT /F1 12 Tf 14 TL 20 180 Td (First) Tj (Second) ' 0 0 (Third) \" 0 -14 Td [(Fo) 10 (urth)] TJ ET"),
	})
	doc, err := NewDefaultParser().ParseDocument(path, "pdf")
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Segments) != 1 || doc.Segments[0].Content != "First\nSecond\nThird\nFourth" {
		t.Fatalf("unexpected PDF lines: %#v", doc.Segments)
	}
}

func pdfTextFixtureCMap(first, second string) string {
	return pdfTextFixtureStream(fmt.Sprintf("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Fixture def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n3 beginbfchar\n<01> <%s>\n<02> <%s>\n<0A> <4EFD>\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend", first, second))
}

func pdfTextFixtureStream(content string) string {
	return fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content)
}

func writePDFTextFixture(t *testing.T, objects []string) string {
	t.Helper()
	var body strings.Builder
	body.WriteString("%PDF-1.4\n")
	offsets := []int{0}
	for i, obj := range objects {
		offsets = append(offsets, body.Len())
		fmt.Fprintf(&body, "%d 0 obj\n%s\nendobj\n", i+1, obj)
	}
	xref := body.Len()
	fmt.Fprintf(&body, "xref\n0 %d\n0000000000 65535 f \n", len(offsets))
	for _, offset := range offsets[1:] {
		fmt.Fprintf(&body, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&body, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets), xref)
	path := filepath.Join(t.TempDir(), "operators.pdf")
	if err := os.WriteFile(path, []byte(body.String()), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}
func TestPDFPredefinedUnicodeCMaps(t *testing.T) {
	for _, tc := range []struct {
		name, code, want string
		corrupt          bool
	}{
		{"UniGB-UCS2-H", "661F686559074EFD4FDD7559003300355929", "星桥备份保留35天", false},
		{"UniGB-UCS2-V", "59074EFD", "备份", false},
		{"UniGB-UTF16-H", "5907D840DC00", "备𠀀", false},
		{"UniGB-UTF16-V", "4EFD", "份", false},
		{"UniGB-UCS2-H", "59074E", "", true},
		{"UniGB-UCS2-H", "D840DC00", "", true},
		{"UniGB-UTF16-H", "D8400041", "", true},
		{"UniGB-UTF16-H", "DC00", "", true},
	} {
		t.Run(tc.name+"/"+tc.code, func(t *testing.T) {
			path := writePDFTextFixture(t, []string{
				"<< /Type /Catalog /Pages 2 0 R >>",
				"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
				"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
				fmt.Sprintf("<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /%s /DescendantFonts [6 0 R] >>", tc.name),
				pdfTextFixtureStream("BT /F1 12 Tf <" + tc.code + "> Tj ET"),
				"<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 0 >> >>",
			})
			doc, err := NewDefaultParser().ParseDocument(path, "pdf")
			if tc.corrupt {
				if err == nil || !errors.Is(err, ErrCorruptFile) {
					t.Fatalf("expected corrupt text, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(doc.Segments) != 1 || doc.Segments[0].Content != tc.want || *doc.Segments[0].PageNumber != 1 {
				t.Fatalf("unexpected decoded page: %#v", doc)
			}
		})
	}
}
