package lexer

import (
	"slices"
	"strings"
	"testing"
)

func TestTokenizeChineseBigrams(t *testing.T) {
	got := Tokenize("企业知识库")
	want := []string{"企业", "业知", "知识", "识库"}
	if !slices.Equal(got, want) {
		t.Fatalf("Tokenize = %q, want %q", got, want)
	}
}

func TestTokenizeSingleCJKCharacterIsKept(t *testing.T) {
	got := Tokenize("好")
	if !slices.Equal(got, []string{"好"}) {
		t.Fatalf("Tokenize = %q, want [好]", got)
	}
}

func TestTokenizeMixedChineseAndASCII(t *testing.T) {
	got := Tokenize("使用 pgvector 检索，Rerank 精排。")
	want := []string{"使用", "pgvector", "检索", "rerank", "精排"}
	if !slices.Equal(got, want) {
		t.Fatalf("Tokenize = %q, want %q", got, want)
	}
}

func TestTokenizeCJKAdjacentToASCIISplitsRuns(t *testing.T) {
	got := Tokenize("报错E4021怎么办")
	want := []string{"报错", "e4021", "怎么", "么办"}
	if !slices.Equal(got, want) {
		t.Fatalf("Tokenize = %q, want %q", got, want)
	}
}

func TestTokenizeKeepsCodesWithJoinersAndTheirParts(t *testing.T) {
	cases := map[string][]string{
		"E-4021":  {"e-4021", "e", "4021"},
		"v1.2.3":  {"v1.2.3", "v1", "2", "3"},
		"bge_m3":  {"bge_m3", "bge", "m3"},
		"abc.":    {"abc"},
		"-abc":    {"abc"},
		"a--b":    {"a--b", "a", "b"},
		"x.y.":    {"x.y", "x", "y"},
		"ABC-def": {"abc-def", "abc", "def"},
	}
	for input, want := range cases {
		if got := Tokenize(input); !slices.Equal(got, want) {
			t.Errorf("Tokenize(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestTokenizeDropsOversizedTokens(t *testing.T) {
	blob := strings.Repeat("a", maxTokenBytes+1)
	got := Tokenize(blob + " ok")
	if !slices.Equal(got, []string{"ok"}) {
		t.Fatalf("expected oversized token to be dropped, got %q", got)
	}
	code := strings.Repeat("b", maxTokenBytes-2) + "-cd"
	got = Tokenize(code)
	if slices.Contains(got, code) {
		t.Fatalf("expected the oversized joined form to be dropped, got %q", got)
	}
}

func TestTokenizeOversizedJoinedWordStillEmitsParts(t *testing.T) {
	code := strings.Repeat("b", maxTokenBytes-2) + "-cd"
	got := Tokenize(code)
	if !slices.Contains(got, "cd") {
		t.Fatalf("expected the short part to survive, got %q", got)
	}
}

func TestTokenizeEmptyAndPunctuationOnly(t *testing.T) {
	for _, input := range []string{"", "   ", "。，！？", "---", "..."} {
		if got := Tokenize(input); len(got) != 0 {
			t.Errorf("Tokenize(%q) = %q, want none", input, got)
		}
	}
}

func TestTokenizeURLDoesNotExplode(t *testing.T) {
	got := Tokenize("https://example.com/docs/index.html?x=1")
	want := []string{"https", "example.com", "example", "com", "docs", "index.html", "index", "html", "x", "1"}
	if !slices.Equal(got, want) {
		t.Fatalf("Tokenize = %q, want %q", got, want)
	}
}

func TestTokenizeJapaneseAndKorean(t *testing.T) {
	got := Tokenize("こんにちは 한국어")
	want := []string{"こん", "んに", "にち", "ちは", "한국", "국어"}
	if !slices.Equal(got, want) {
		t.Fatalf("Tokenize = %q, want %q", got, want)
	}
}

func TestTSVectorAssignsPositionsAndQuotes(t *testing.T) {
	got := TSVector([]string{"知识", "识库", "it's", `a\b`})
	want := `'知识':1 '识库':2 'it''s':3 'a\\b':4`
	if got != want {
		t.Fatalf("TSVector = %s, want %s", got, want)
	}
	if TSVector(nil) != "" {
		t.Fatal("expected empty tsvector literal for no tokens")
	}
}

func TestTSVectorClampsPositions(t *testing.T) {
	tokens := make([]string, 16385)
	for i := range tokens {
		tokens[i] = "t"
	}
	got := TSVector(tokens)
	if strings.Contains(got, ":16384") || strings.Contains(got, ":16385") {
		t.Fatal("expected positions above 16383 to be clamped")
	}
	if !strings.HasSuffix(got, "'t':16383") {
		t.Fatalf("expected clamped final position, got suffix %q", got[len(got)-12:])
	}
}

func TestTSQueryDeduplicatesAndJoinsWithOr(t *testing.T) {
	got := TSQuery([]string{"知识", "识库", "知识", "e-4021"})
	want := `'知识' | '识库' | 'e-4021'`
	if got != want {
		t.Fatalf("TSQuery = %s, want %s", got, want)
	}
	if TSQuery(nil) != "" {
		t.Fatal("expected empty tsquery literal for no tokens")
	}
}

func TestIndexAndQueryTokensAgree(t *testing.T) {
	document := "订单系统在处理退款时返回错误码 E-4021，请检查 v1.2.3 版本的配置。"
	query := "E-4021 退款 错误码"
	indexed := Tokenize(document)
	for _, token := range Tokenize(query) {
		if !slices.Contains(indexed, token) {
			t.Errorf("query token %q not produced by indexing the document: %q", token, indexed)
		}
	}
}
