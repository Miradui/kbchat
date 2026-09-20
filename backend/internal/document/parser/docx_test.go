package parser

import (
	"archive/zip"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseDOCXPreservesHeadingsListsTablesAndDeletedText(t *testing.T) {
	path := writeDOCXFixture(t, map[string]string{
		"word/styles.xml":    `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="TitleHeading"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Subhead"><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style></w:styles>`,
		"word/numbering.xml": `<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
		"word/document.xml":  `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="TitleHeading"/></w:pPr><w:r><w:t>产品手册</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Subhead"/></w:pPr><w:r><w:t>安装</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>第一步</w:t></w:r><w:del><w:r><w:delText>不应出现</w:delText></w:r></w:del></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="7"/></w:numPr></w:pPr><w:hyperlink><w:r><w:t>第二步</w:t></w:r></w:hyperlink></w:p><w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>名称</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>服务</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>状态 | 正常</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>`,
	})

	document, err := NewDefaultParser().ParseDocument(path, "docx")
	if err != nil {
		t.Fatalf("parse docx: %v", err)
	}
	if document.FileType != "docx" || len(document.Segments) != 1 {
		t.Fatalf("unexpected document shape: %#v", document)
	}
	want := "# 产品手册\n\n## 安装\n\n- 第一步\n\n  1. 第二步\n\n| 名称 |  |\n| --- | --- |\n| 服务 | 状态 \\| 正常 |"
	if document.Segments[0].Content != want {
		t.Fatalf("unexpected rendered markdown:\nwant:\n%s\n got:\n%s", want, document.Segments[0].Content)
	}
}

func TestParseDOCXRejectsMalformedAndEncryptedPackages(t *testing.T) {
	for _, fixture := range [][]byte{[]byte("not a zip"), {0xd0, 0xcf, 0x11, 0xe0, 0xa1}} {
		_, err := ParseDOCXBytes(fixture)
		if err == nil || !errors.Is(err, ErrCorruptFile) {
			t.Fatalf("expected corrupt docx error, got %v", err)
		}
	}
}

func TestParseDOCXMissingDocumentPartIsCorrupt(t *testing.T) {
	path := writeDOCXFixture(t, map[string]string{"word/styles.xml": "<w:styles/>"})
	_, err := NewDefaultParser().ParseDocument(path, "docx")
	if err == nil || !errors.Is(err, ErrCorruptFile) || !strings.Contains(err.Error(), "document.xml") {
		t.Fatalf("expected missing document part error, got %v", err)
	}
}

func writeDOCXFixture(t *testing.T, parts map[string]string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fixture.docx")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	archive := zip.NewWriter(file)
	for name, content := range parts {
		entry, createErr := archive.Create(name)
		if createErr != nil {
			t.Fatal(createErr)
		}
		if _, writeErr := entry.Write([]byte(content)); writeErr != nil {
			t.Fatal(writeErr)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}
