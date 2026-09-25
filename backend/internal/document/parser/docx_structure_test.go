package parser

import (
	"archive/zip"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const docxNS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`

func parseDOCXBodyFixture(t *testing.T, parts map[string]string, body string) string {
	t.Helper()
	parts["word/document.xml"] = `<?xml version="1.0"?><w:document ` + docxNS + `><w:body>` + body + `<w:sectPr/></w:body></w:document>`
	document, err := NewDefaultParser().ParseDocument(writeDOCXFixture(t, parts), "docx")
	if err != nil {
		t.Fatalf("parse docx: %v", err)
	}
	return document.Segments[0].Content
}

func docxParagraphXML(text string) string {
	return `<w:p><w:r><w:t>` + text + `</w:t></w:r></w:p>`
}

func TestParseDOCXVerticallyMergedCellsKeepOnlyTheTopValue(t *testing.T) {
	got := parseDOCXBodyFixture(t, map[string]string{}, `<w:tbl>`+
		`<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr>`+docxParagraphXML("区域")+`</w:tc><w:tc>`+docxParagraphXML("华东")+`</w:tc></w:tr>`+
		`<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr>`+docxParagraphXML("区域")+`</w:tc><w:tc>`+docxParagraphXML("华南")+`</w:tc></w:tr>`+
		`<w:tr><w:tc><w:tcPr><w:vMerge w:val="continue"/></w:tcPr><w:p/></w:tc><w:tc>`+docxParagraphXML("华北")+`</w:tc></w:tr>`+
		`</w:tbl>`)
	want := "| 区域 | 华东 |\n| --- | --- |\n|  | 华南 |\n|  | 华北 |"
	if got != want {
		t.Fatalf("unexpected merged table:\nwant:\n%s\ngot:\n%s", want, got)
	}
}

func TestParseDOCXNumberedHeadingsStayHeadingsAndNumIdZeroIsNotAList(t *testing.T) {
	parts := map[string]string{
		"word/styles.xml": `<?xml version="1.0"?><w:styles ` + docxNS + `>` +
			`<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>` +
			`<w:style w:type="paragraph" w:styleId="Custom"><w:basedOn w:val="Heading2"/></w:style>` +
			`<w:style w:type="paragraph" w:styleId="Heading2"><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>` +
			`</w:styles>`,
		"word/numbering.xml": `<?xml version="1.0"?><w:numbering ` + docxNS + `><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
	}
	got := parseDOCXBodyFixture(t, parts,
		`<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>概述</w:t></w:r></w:p>`+
			`<w:p><w:pPr><w:pStyle w:val="Custom"/></w:pPr><w:r><w:t>派生标题</w:t></w:r></w:p>`+
			`<w:p><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:r><w:t>直接大纲级别</w:t></w:r></w:p>`+
			`<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr></w:pPr><w:r><w:t>取消编号的正文</w:t></w:r></w:p>`+
			`<w:p/><w:p><w:r><w:t>   </w:t></w:r></w:p>`+
			docxParagraphXML("中文正文段落，包含标点。"))
	want := "# 概述\n\n## 派生标题\n\n### 直接大纲级别\n\n取消编号的正文\n\n中文正文段落，包含标点。"
	if got != want {
		t.Fatalf("unexpected rendering:\nwant:\n%s\ngot:\n%s", want, got)
	}
}

func TestParseDOCXKeepsConsecutiveListItemsInOneBlock(t *testing.T) {
	parts := map[string]string{
		"word/numbering.xml": `<?xml version="1.0"?><w:numbering ` + docxNS + `><w:abstractNum w:abstractNumId="1">` +
			`<w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="2"><w:numFmt w:val="decimal"/></w:lvl>` +
			`</w:abstractNum><w:num w:numId="5"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
	}
	item := func(level, text string) string {
		return `<w:p><w:pPr><w:numPr><w:ilvl w:val="` + level + `"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>` + text + `</w:t></w:r></w:p>`
	}
	got := parseDOCXBodyFixture(t, parts, item("0", "一级")+item("1", "二级")+item("2", "三级")+docxParagraphXML("结束"))
	want := "- 一级\n  - 二级\n    1. 三级\n\n结束"
	if got != want {
		t.Fatalf("unexpected list rendering:\nwant:\n%s\ngot:\n%s", want, got)
	}
}

func TestParseDOCXReadsContentControlsFieldsAndNestedTables(t *testing.T) {
	got := parseDOCXBodyFixture(t, map[string]string{},
		`<w:sdt><w:sdtPr><w:alias w:val="封面"/></w:sdtPr><w:sdtContent>`+docxParagraphXML("封面标题")+`</w:sdtContent></w:sdt>`+
			`<w:p><w:r><w:t>见</w:t></w:r><w:sdt><w:sdtContent><w:r><w:t>行内控件</w:t></w:r></w:sdtContent></w:sdt>`+
			`<w:fldSimple w:instr="PAGE"><w:r><w:t>第 1 页</w:t></w:r></w:fldSimple><w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r><w:r><w:t>末尾</w:t></w:r></w:p>`+
			`<w:tbl><w:tr><w:tc>`+docxParagraphXML("外层")+`<w:tbl><w:tr><w:tc>`+docxParagraphXML("内层")+`</w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>`)
	want := "封面标题\n\n见行内控件第 1 页 末尾\n\n| 外层 内层 |\n| --- |"
	if got != want {
		t.Fatalf("unexpected rendering:\nwant:\n%s\ngot:\n%s", want, got)
	}
}

func TestParseDOCXRejectsOLECompoundFilesAsLegacyOrEncrypted(t *testing.T) {
	ole := append([]byte{0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1}, make([]byte, 512)...)
	_, err := ParseDOCXBytes(ole)
	if !errors.Is(err, ErrCorruptFile) || !errors.Is(err, ErrDOCXLegacyOrEncrypted) {
		t.Fatalf("expected legacy/encrypted error from bytes, got %v", err)
	}
	path := filepath.Join(t.TempDir(), "encrypted.docx")
	if err := os.WriteFile(path, ole, 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = NewDefaultParser().ParseDocument(path, "docx")
	if !errors.Is(err, ErrDOCXLegacyOrEncrypted) {
		t.Fatalf("expected legacy/encrypted error from path, got %v", err)
	}
}

func TestParseDOCXRejectsOversizedParts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bomb.docx")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	archive := zip.NewWriter(file)
	entry, err := archive.Create("word/document.xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entry.Write([]byte(`<w:document ` + docxNS + `><w:body><w:p><w:r><w:t>`)); err != nil {
		t.Fatal(err)
	}
	filler := strings.Repeat("a", 1<<20)
	for written := 0; written <= docxMaxPartBytes; written += len(filler) {
		if _, err := entry.Write([]byte(filler)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := entry.Write([]byte(`</w:t></w:r></w:p></w:body></w:document>`)); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = NewDefaultParser().ParseDocument(path, "docx")
	if !errors.Is(err, ErrCorruptFile) || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("expected oversized part rejection, got %v", err)
	}
}
