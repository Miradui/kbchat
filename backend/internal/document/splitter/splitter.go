package splitter

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"rag/backend/internal/document/parser"
)

const (
	DefaultChunkSize    = 800
	DefaultChunkOverlap = 120
)

type Chunk struct {
	Index      int
	Content    string
	TokenCount int
	PageNumber *int
	Metadata   map[string]any
}

type Splitter struct {
	chunkSize    int
	chunkOverlap int
}

type block struct {
	content       string
	fileType      string
	pageNumber    *int
	headingPath   []string
	structureType string
	startOffset   int
	endOffset     int
}

type chunkBuilder struct {
	fileType       string
	pageNumber     *int
	headingPath    []string
	parts          []string
	structureTypes map[string]struct{}
	startOffset    int
	endOffset      int
}

func New(chunkSize int, chunkOverlap int) *Splitter {
	if chunkSize <= 0 {
		chunkSize = DefaultChunkSize
	}
	if chunkOverlap < 0 || chunkOverlap >= chunkSize {
		chunkOverlap = DefaultChunkOverlap
	}
	return &Splitter{chunkSize: chunkSize, chunkOverlap: chunkOverlap}
}

func (s *Splitter) Split(text string) []Chunk {
	return s.SplitDocument(parser.ParsedDocument{
		FileType: "md",
		Segments: []parser.Segment{{Content: text}},
	})
}

func (s *Splitter) SplitDocument(document parser.ParsedDocument) []Chunk {
	fileType := normalizeFileType(document.FileType)
	chunks := make([]Chunk, 0, len(document.Segments))
	for _, segment := range document.Segments {
		text := normalize(segment.Content)
		if text == "" {
			continue
		}
		blocks := parseBlocks(text, fileType == "md", fileType, segment.PageNumber)
		for _, chunk := range s.splitBlocks(blocks) {
			chunk.Index = len(chunks)
			chunks = append(chunks, chunk)
		}
	}
	return chunks
}

func (s *Splitter) splitBlocks(blocks []block) []Chunk {
	chunks := make([]Chunk, 0, len(blocks))
	current := chunkBuilder{}
	overlap := ""

	for _, original := range blocks {
		for _, item := range s.splitOversizeBlock(original) {
			if current.empty() {
				current = s.newChunkBuilder(item, overlap)
				overlap = ""
				continue
			}

			if sameSource(current, item) && sameHeadingPath(current.headingPath, item.headingPath) && s.fits(current.withBlock(item)) {
				current.addBlock(item)
				continue
			}

			chunks = append(chunks, current.chunk(len(chunks), s.chunkSize))
			overlap = s.overlapText(current.body())
			current = s.newChunkBuilder(item, overlap)
			overlap = ""
		}
	}

	if !current.empty() {
		chunks = append(chunks, current.chunk(len(chunks), s.chunkSize))
	}

	return chunks
}

func (s *Splitter) splitOversizeBlock(item block) []block {
	if s.fits(newChunkBuilder(item, "")) {
		return []block{item}
	}

	prefixBudget := estimateTokens(headingPrefix(item.headingPath))
	budget := s.chunkSize - prefixBudget
	if budget < 1 {
		budget = 1
	}

	parts := splitTextToBudget(item.content, budget, s.chunkOverlap)
	result := make([]block, 0, len(parts))
	offset := item.startOffset
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		result = append(result, block{
			content:       part,
			fileType:      item.fileType,
			pageNumber:    copyIntPointer(item.pageNumber),
			headingPath:   copyStrings(item.headingPath),
			structureType: item.structureType,
			startOffset:   offset,
			endOffset:     offset + len(part),
		})
		offset += len(part)
	}
	return result
}

func (s *Splitter) newChunkBuilder(item block, overlap string) chunkBuilder {
	builder := newChunkBuilder(item, overlap)
	if overlap != "" && !s.fits(builder) {
		return newChunkBuilder(item, "")
	}
	return builder
}

func (s *Splitter) fits(builder chunkBuilder) bool {
	if builder.empty() {
		return true
	}
	return estimateTokens(builder.content()) <= s.chunkSize
}

func (s *Splitter) overlapText(content string) string {
	content = strings.TrimSpace(content)
	if content == "" || s.chunkOverlap <= 0 {
		return ""
	}
	budget := s.chunkOverlap
	maxOverlap := s.chunkSize / 4
	if maxOverlap > 0 && budget > maxOverlap {
		budget = maxOverlap
	}
	return tailByTokenBudget(content, budget)
}

func newChunkBuilder(item block, overlap string) chunkBuilder {
	builder := chunkBuilder{
		fileType:       item.fileType,
		pageNumber:     copyIntPointer(item.pageNumber),
		headingPath:    copyStrings(item.headingPath),
		structureTypes: map[string]struct{}{},
		startOffset:    item.startOffset,
		endOffset:      item.endOffset,
	}
	if strings.TrimSpace(overlap) != "" {
		builder.parts = append(builder.parts, strings.TrimSpace(overlap))
	}
	builder.addBlock(item)
	return builder
}

func (b chunkBuilder) empty() bool {
	return len(b.parts) == 0
}

func (b chunkBuilder) body() string {
	return strings.TrimSpace(strings.Join(b.parts, "\n\n"))
}

func (b chunkBuilder) content() string {
	body := b.body()
	prefix := headingPrefix(b.headingPath)
	if prefix == "" {
		return body
	}
	if body == "" {
		return prefix
	}
	return prefix + "\n" + body
}

func (b chunkBuilder) withBlock(item block) chunkBuilder {
	next := b
	next.parts = append(copyStrings(b.parts), item.content)
	next.structureTypes = copyStructureTypes(b.structureTypes)
	next.structureTypes[item.structureType] = struct{}{}
	if item.endOffset > next.endOffset {
		next.endOffset = item.endOffset
	}
	return next
}

func (b *chunkBuilder) addBlock(item block) {
	if b.structureTypes == nil {
		b.structureTypes = map[string]struct{}{}
	}
	b.parts = append(b.parts, item.content)
	b.structureTypes[item.structureType] = struct{}{}
	if b.startOffset == 0 || item.startOffset < b.startOffset {
		b.startOffset = item.startOffset
	}
	if item.endOffset > b.endOffset {
		b.endOffset = item.endOffset
	}
}

func (b chunkBuilder) chunk(index int, maxTokens int) Chunk {
	content := b.content()
	if estimateTokens(content) > maxTokens {
		content = trimContentToBudget(content, maxTokens)
	}
	metadata := map[string]any{
		"fileType":      b.fileType,
		"headingPath":   copyStrings(b.headingPath),
		"structureType": b.structureType(),
		"startOffset":   b.startOffset,
		"endOffset":     b.endOffset,
	}
	if b.pageNumber != nil {
		metadata["pageNumber"] = *b.pageNumber
	}
	return Chunk{
		Index:      index,
		Content:    content,
		TokenCount: estimateTokens(content),
		PageNumber: copyIntPointer(b.pageNumber),
		Metadata:   metadata,
	}
}

func (b chunkBuilder) structureType() string {
	if len(b.structureTypes) == 1 {
		for value := range b.structureTypes {
			return value
		}
	}
	return "mixed"
}

func parseBlocks(text string, markdown bool, fileType string, pageNumber *int) []block {
	lines := strings.SplitAfter(text, "\n")
	blocks := make([]block, 0, len(lines))
	headingPath := []string{}
	pendingLines := []string{}
	pendingType := ""
	pendingStart := 0
	pendingEnd := 0
	offset := 0

	flush := func() {
		if len(pendingLines) == 0 {
			return
		}

		content := blockContent(pendingLines, pendingType)
		if content != "" {
			blocks = append(blocks, block{
				content:       content,
				fileType:      fileType,
				pageNumber:    copyIntPointer(pageNumber),
				headingPath:   copyStrings(headingPath),
				structureType: pendingType,
				startOffset:   pendingStart,
				endOffset:     pendingEnd,
			})
		}
		pendingLines = nil
		pendingType = ""
		pendingStart = 0
		pendingEnd = 0
	}

	for i := 0; i < len(lines); i++ {
		raw := strings.TrimSuffix(lines[i], "\n")
		lineStart := offset
		lineEnd := offset + len(raw)
		offset += len(lines[i])
		trimmed := strings.TrimSpace(raw)

		if trimmed == "" {
			flush()
			continue
		}

		if markdown {
			if level, title, ok := parseHeading(trimmed); ok {
				flush()
				headingPath = updateHeadingPath(headingPath, level, title)
				continue
			}
		}

		if markdown {
			if fence, ok := parseFence(trimmed); ok {
				flush()
				codeLines := []string{raw}
				codeStart := lineStart
				codeEnd := lineEnd
				for i+1 < len(lines) {
					i++
					raw = strings.TrimSuffix(lines[i], "\n")
					codeEnd = offset + len(raw)
					offset += len(lines[i])
					codeLines = append(codeLines, raw)
					if strings.HasPrefix(strings.TrimSpace(raw), fence) {
						break
					}
				}
				content := strings.TrimSpace(strings.Join(codeLines, "\n"))
				if content != "" {
					blocks = append(blocks, block{
						content:       content,
						fileType:      fileType,
						pageNumber:    copyIntPointer(pageNumber),
						headingPath:   copyStrings(headingPath),
						structureType: "code",
						startOffset:   codeStart,
						endOffset:     codeEnd,
					})
				}
				continue
			}
		}

		lineType := "paragraph"
		if markdown {
			lineType = structureTypeForLine(trimmed)
		}
		if pendingType != "" && pendingType != lineType {
			flush()
		}
		if len(pendingLines) == 0 {
			pendingStart = lineStart
		}
		pendingLines = append(pendingLines, strings.TrimSpace(raw))
		pendingType = lineType
		pendingEnd = lineEnd
	}

	flush()
	return blocks
}

func blockContent(lines []string, structureType string) string {
	if structureType == "paragraph" {
		return strings.TrimSpace(strings.Join(lines, " "))
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func parseHeading(line string) (int, string, bool) {
	if !strings.HasPrefix(line, "#") {
		return 0, "", false
	}
	level := 0
	for level < len(line) && line[level] == '#' {
		level++
	}
	if level == 0 || level > 6 || level >= len(line) || !unicode.IsSpace(rune(line[level])) {
		return 0, "", false
	}
	title := strings.TrimSpace(line[level:])
	title = strings.TrimSpace(strings.TrimRight(title, "#"))
	if title == "" {
		return 0, "", false
	}
	return level, title, true
}

func updateHeadingPath(path []string, level int, title string) []string {
	next := copyStrings(path)
	if len(next) >= level {
		next = next[:level-1]
	}
	for len(next) < level-1 {
		next = append(next, "")
	}
	return append(next, title)
}

func parseFence(line string) (string, bool) {
	if strings.HasPrefix(line, "```") {
		return "```", true
	}
	if strings.HasPrefix(line, "~~~") {
		return "~~~", true
	}
	return "", false
}

func structureTypeForLine(line string) string {
	if isTableLine(line) {
		return "table"
	}
	if isListLine(line) {
		return "list"
	}
	return "paragraph"
}

func isTableLine(line string) bool {
	return strings.Count(line, "|") >= 2
}

func isListLine(line string) bool {
	if strings.HasPrefix(line, "- ") || strings.HasPrefix(line, "* ") || strings.HasPrefix(line, "+ ") {
		return true
	}
	dot := strings.Index(line, ". ")
	if dot <= 0 {
		return false
	}
	for _, r := range line[:dot] {
		if !unicode.IsDigit(r) {
			return false
		}
	}
	return true
}

func splitTextToBudget(text string, budget int, overlap int) []string {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	if estimateTokens(text) <= budget {
		return []string{text}
	}

	if parts := splitParagraphs(text); len(parts) > 1 {
		return packTextUnits(parts, "\n\n", budget, overlap)
	}
	if parts := splitSentences(text); len(parts) > 1 {
		return packTextUnits(parts, " ", budget, overlap)
	}
	if parts := strings.Fields(text); len(parts) > 1 {
		return packTextUnits(parts, " ", budget, overlap)
	}
	return packRunes(text, budget, overlap)
}

func splitParagraphs(text string) []string {
	raw := strings.Split(text, "\n\n")
	parts := make([]string, 0, len(raw))
	for _, part := range raw {
		part = strings.TrimSpace(part)
		if part != "" {
			parts = append(parts, part)
		}
	}
	return parts
}

func splitSentences(text string) []string {
	var parts []string
	start := 0
	for index, r := range text {
		if strings.ContainsRune(".!?。！？；;", r) {
			end := index + utf8.RuneLen(r)
			part := strings.TrimSpace(text[start:end])
			if part != "" {
				parts = append(parts, part)
			}
			start = end
		}
	}
	if start < len(text) {
		part := strings.TrimSpace(text[start:])
		if part != "" {
			parts = append(parts, part)
		}
	}
	return parts
}

func packTextUnits(units []string, joiner string, budget int, overlap int) []string {
	var chunks []string
	for start := 0; start < len(units); {
		end := start
		var candidate []string
		for end < len(units) {
			next := append(copyStrings(candidate), units[end])
			if len(candidate) > 0 && estimateTokens(strings.Join(next, joiner)) > budget {
				break
			}
			candidate = next
			end++
			if estimateTokens(strings.Join(candidate, joiner)) >= budget {
				break
			}
		}
		if end == start {
			chunks = append(chunks, splitTextToBudget(units[start], budget, overlap)...)
			start++
			continue
		}
		chunks = append(chunks, strings.Join(candidate, joiner))
		if end >= len(units) {
			break
		}
		nextStart := end
		for nextStart > start && estimateTokens(strings.Join(units[nextStart:end], joiner)) < overlap {
			nextStart--
		}
		if nextStart <= start {
			nextStart = end
		}
		start = nextStart
	}
	return chunks
}

func packRunes(text string, budget int, overlap int) []string {
	runes := []rune(text)
	step := budget - overlap
	if step <= 0 {
		step = budget
	}
	var chunks []string
	for start := 0; start < len(runes); start += step {
		end := start + budget
		if end > len(runes) {
			end = len(runes)
		}
		chunks = append(chunks, strings.TrimSpace(string(runes[start:end])))
		if end == len(runes) {
			break
		}
	}
	return chunks
}

func tailByTokenBudget(text string, budget int) string {
	words := strings.Fields(text)
	if len(words) == 0 {
		return ""
	}
	for start := len(words) - 1; start >= 0; start-- {
		candidate := strings.Join(words[start:], " ")
		if estimateTokens(candidate) > budget {
			if start == len(words)-1 {
				return ""
			}
			return strings.Join(words[start+1:], " ")
		}
	}
	return strings.Join(words, " ")
}

func trimContentToBudget(text string, budget int) string {
	words := strings.Fields(text)
	if len(words) == 0 {
		return ""
	}
	var kept []string
	for _, word := range words {
		next := append(copyStrings(kept), word)
		if estimateTokens(strings.Join(next, " ")) > budget {
			break
		}
		kept = next
	}
	return strings.Join(kept, " ")
}

func headingPrefix(path []string) string {
	cleaned := make([]string, 0, len(path))
	for _, item := range path {
		item = strings.TrimSpace(item)
		if item != "" {
			cleaned = append(cleaned, item)
		}
	}
	return strings.Join(cleaned, " > ")
}

func normalize(text string) string {
	text = strings.TrimPrefix(text, "\ufeff")
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	return strings.TrimSpace(text)
}

func estimateTokens(text string) int {
	text = strings.TrimSpace(text)
	if text == "" {
		return 0
	}

	fields := strings.Fields(text)
	if len(fields) == 0 {
		return utf8.RuneCountInString(text)/2 + 1
	}

	count := 0
	for _, field := range fields {
		if containsWideRune(field) {
			count += utf8.RuneCountInString(field)
			continue
		}
		count++
	}
	return count
}

func containsWideRune(text string) bool {
	for _, r := range text {
		if unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) || unicode.Is(unicode.Katakana, r) || unicode.Is(unicode.Hangul, r) {
			return true
		}
	}
	return false
}

func normalizeFileType(fileType string) string {
	return strings.TrimPrefix(strings.ToLower(strings.TrimSpace(fileType)), ".")
}

func sameSource(builder chunkBuilder, item block) bool {
	if normalizeFileType(builder.fileType) != normalizeFileType(item.fileType) {
		return false
	}
	if builder.pageNumber == nil || item.pageNumber == nil {
		return builder.pageNumber == nil && item.pageNumber == nil
	}
	return *builder.pageNumber == *item.pageNumber
}

func sameHeadingPath(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func copyIntPointer(value *int) *int {
	if value == nil {
		return nil
	}
	copied := *value
	return &copied
}

func copyStrings(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	copied := make([]string, len(values))
	copy(copied, values)
	return copied
}

func copyStructureTypes(values map[string]struct{}) map[string]struct{} {
	copied := make(map[string]struct{}, len(values))
	for key, value := range values {
		copied[key] = value
	}
	return copied
}
