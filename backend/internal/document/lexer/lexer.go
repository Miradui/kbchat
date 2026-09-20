// Package lexer turns text into the lexemes used for keyword retrieval.
//
// Indexing and querying must agree on the token set exactly, so both the
// document processor and the retrieval path call the same Tokenize. The package
// also renders tokens as PostgreSQL tsvector / tsquery literals; PostgreSQL's
// own text-search parsers are never applied to our text, because they would
// re-split hyphenated codes, version strings and CJK runs differently from how
// they were indexed.
package lexer

import (
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// maxTokenBytes drops the pathological tokens (base64 blobs, long hashes, URLs
// without separators) that would never be typed as a query and only inflate
// the index. PostgreSQL's own lexeme limit is 2047 bytes; this is far below it.
const maxTokenBytes = 64

// Tokenize returns the lexemes of text in document order. Duplicates are kept
// so the tsvector rendering can assign positions; callers that need a set
// should dedupe themselves.
//
// Rules:
//   - Letters and digits are lower-cased. Runs of ASCII/Latin letters and
//     digits joined by '-', '_' or '.' form one token ("e-4021", "v1.2.3");
//     the joined parts are also emitted separately so either spelling matches.
//   - CJK ideographs, kana and Hangul are emitted as character bigrams. A run
//     of a single CJK character is emitted as-is.
//   - Everything else (whitespace, punctuation, symbols) separates tokens.
func Tokenize(text string) []string {
	var tokens []string
	var word []rune
	var cjk []rune

	flushWord := func() {
		if len(word) == 0 {
			return
		}
		tokens = appendWordTokens(tokens, word)
		word = word[:0]
	}
	flushCJK := func() {
		if len(cjk) == 0 {
			return
		}
		tokens = appendBigrams(tokens, cjk)
		cjk = cjk[:0]
	}

	for _, r := range text {
		switch {
		case isCJK(r):
			flushWord()
			cjk = append(cjk, r)
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			flushCJK()
			word = append(word, unicode.ToLower(r))
		case (r == '-' || r == '_' || r == '.') && len(word) > 0:
			// Joiners only count inside a word; a leading joiner is punctuation.
			flushCJK()
			word = append(word, r)
		default:
			flushWord()
			flushCJK()
		}
	}
	flushWord()
	flushCJK()
	return tokens
}

// appendWordTokens emits the whole word (with trailing joiners trimmed, so a
// sentence-final "abc." indexes as "abc") and, when the word contained
// joiners, each non-empty part.
func appendWordTokens(tokens []string, word []rune) []string {
	trimmed := strings.TrimRight(string(word), "-_.")
	if trimmed == "" {
		return tokens
	}
	if fits(trimmed) {
		tokens = append(tokens, trimmed)
	}
	if !strings.ContainsAny(trimmed, "-_.") {
		return tokens
	}
	for part := range strings.FieldsFuncSeq(trimmed, func(r rune) bool { return r == '-' || r == '_' || r == '.' }) {
		if part != "" && fits(part) {
			tokens = append(tokens, part)
		}
	}
	return tokens
}

func appendBigrams(tokens []string, run []rune) []string {
	if len(run) == 1 {
		return append(tokens, string(run))
	}
	for i := 0; i+1 < len(run); i++ {
		tokens = append(tokens, string(run[i:i+2]))
	}
	return tokens
}

func fits(token string) bool {
	return len(token) <= maxTokenBytes && utf8.ValidString(token)
}

func isCJK(r rune) bool {
	return unicode.Is(unicode.Han, r) ||
		unicode.Is(unicode.Hiragana, r) ||
		unicode.Is(unicode.Katakana, r) ||
		unicode.Is(unicode.Hangul, r)
}

// TSVector renders tokens as a tsvector literal with 1-based positions, e.g.
// `'知识':1 '识库':2`. The result is meant for a `?::tsvector` cast. Empty input
// renders as an empty string, which PostgreSQL accepts as the empty tsvector.
//
// PostgreSQL caps positions at 16383; later occurrences are clamped to that
// value rather than dropped so the lexeme still matches.
func TSVector(tokens []string) string {
	if len(tokens) == 0 {
		return ""
	}
	var b strings.Builder
	for i, token := range tokens {
		if i > 0 {
			b.WriteByte(' ')
		}
		writeQuoted(&b, token)
		b.WriteByte(':')
		b.WriteString(strconv.Itoa(min(i+1, 16383)))
	}
	return b.String()
}

// TSQuery renders tokens as an OR-joined tsquery literal, e.g.
// `'知识' | '识库'`, deduplicated. The result is meant for a `?::tsquery` cast.
// Empty input renders as an empty string; callers must skip the query in that
// case because PostgreSQL rejects an empty tsquery literal.
func TSQuery(tokens []string) string {
	if len(tokens) == 0 {
		return ""
	}
	seen := make(map[string]struct{}, len(tokens))
	var b strings.Builder
	for _, token := range tokens {
		if _, dup := seen[token]; dup {
			continue
		}
		seen[token] = struct{}{}
		if b.Len() > 0 {
			b.WriteString(" | ")
		}
		writeQuoted(&b, token)
	}
	return b.String()
}

// writeQuoted emits a single-quoted lexeme. Inside tsvector/tsquery quotes,
// both the quote and the backslash are escaped by doubling.
func writeQuoted(b *strings.Builder, token string) {
	b.WriteByte('\'')
	for _, r := range token {
		switch r {
		case '\'':
			b.WriteString("''")
		case '\\':
			b.WriteString(`\\`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('\'')
}
