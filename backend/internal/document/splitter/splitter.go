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

type textSpan struct {
	start int
	end   int
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
			overlap = ""
			if current.structureType() == "paragraph" {
				overlap = s.overlapText(current.body())
			}
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

	switch item.structureType {
	case "code":
		return splitOversizeCodeBlock(item, budget)
	case "table":
		return splitOversizeTableBlock(item, budget)
	case "list":
		return splitOversizeListBlock(item, budget)
	}

	spans := splitTextToBudgetSpans(item.content, budget)
	return blocksFromSpans(item, spans, nil)
}

func blocksFromSpans(item block, spans []textSpan, decorate func(string) string) []block {
	result := make([]block, 0, len(spans))
	for _, span := range spans {
		part := item.content[span.start:span.end]
		if part == "" {
			continue
		}
		if decorate != nil {
			part = decorate(part)
		}
		result = append(result, block{
			content:       part,
			fileType:      item.fileType,
			pageNumber:    copyIntPointer(item.pageNumber),
			headingPath:   copyStrings(item.headingPath),
			structureType: item.structureType,
			startOffset:   item.startOffset + span.start,
			endOffset:     item.startOffset + span.end,
		})
	}
	return result
}

func (s *Splitter) newChunkBuilder(item block, overlap string) chunkBuilder {
	if item.structureType != "paragraph" {
		overlap = ""
	}
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
	if item.startOffset < b.startOffset {
		b.startOffset = item.startOffset
	}
	if item.endOffset > b.endOffset {
		b.endOffset = item.endOffset
	}
}

func (b chunkBuilder) chunk(index int, maxTokens int) Chunk {
	content := contentWithinBudget(headingPrefix(b.headingPath), b.body(), maxTokens)
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

		content, contentSpan := trimTextSpan(text, pendingStart, pendingEnd)
		if content != "" {
			blocks = append(blocks, block{
				content:       content,
				fileType:      fileType,
				pageNumber:    copyIntPointer(pageNumber),
				headingPath:   copyStrings(headingPath),
				structureType: pendingType,
				startOffset:   contentSpan.start,
				endOffset:     contentSpan.end,
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
				codeStart := lineStart
				codeEnd := lineEnd
				for i+1 < len(lines) {
					i++
					raw = strings.TrimSuffix(lines[i], "\n")
					codeEnd = offset + len(raw)
					offset += len(lines[i])
					if isClosingFence(raw, fence) {
						break
					}
				}
				content, contentSpan := trimTextSpan(text, codeStart, codeEnd)
				if content != "" {
					blocks = append(blocks, block{
						content:       content,
						fileType:      fileType,
						pageNumber:    copyIntPointer(pageNumber),
						headingPath:   copyStrings(headingPath),
						structureType: "code",
						startOffset:   contentSpan.start,
						endOffset:     contentSpan.end,
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
	line = strings.TrimSpace(line)
	if line == "" || (line[0] != '`' && line[0] != '~') {
		return "", false
	}
	length := 0
	for length < len(line) && line[length] == line[0] {
		length++
	}
	if length < 3 {
		return "", false
	}
	return line[:length], true
}

func isClosingFence(line string, fence string) bool {
	line = strings.TrimSpace(line)
	if len(line) < len(fence) || fence == "" {
		return false
	}
	for index := range line {
		if line[index] != fence[0] {
			return false
		}
	}
	return true
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

func splitOversizeListBlock(item block, budget int) []block {
	lines := lineTextSpans(item.content)
	result := make([]block, 0, len(lines))
	pending := make([]textSpan, 0, len(lines))
	flushPending := func() {
		if len(pending) == 0 {
			return
		}
		result = append(result, blocksFromSpans(item, packTextSpans(item.content, pending, budget), nil)...)
		pending = nil
	}

	for _, line := range lines {
		content := item.content[line.start:line.end]
		if estimateTokens(content) <= budget {
			pending = append(pending, line)
			continue
		}

		flushPending()
		marker, ok := listMarker(content)
		bodyContent, body := trimTextSpan(item.content, line.start+len(marker), line.end)
		bodyBudget := budget - estimateTokens(marker)
		if !ok || bodyContent == "" || bodyBudget < 1 {
			spans := offsetTextSpans(splitTextToBudgetSpans(content, budget), line.start)
			result = append(result, blocksFromSpans(item, spans, nil)...)
			continue
		}

		relativeSpans := splitTextToBudgetSpans(bodyContent, bodyBudget)
		spans := make([]textSpan, 0, len(relativeSpans))
		for _, span := range relativeSpans {
			spans = append(spans, textSpan{start: body.start + span.start, end: body.start + span.end})
		}
		parts := blocksFromSpans(item, spans, func(part string) string { return marker + part })
		if len(parts) > 0 {
			parts[0].startOffset = item.startOffset + line.start
		}
		result = append(result, parts...)
	}
	flushPending()
	return result
}

func listMarker(line string) (string, bool) {
	if strings.HasPrefix(line, "- ") || strings.HasPrefix(line, "* ") || strings.HasPrefix(line, "+ ") {
		return line[:2], true
	}
	dot := strings.Index(line, ". ")
	if dot <= 0 {
		return "", false
	}
	for _, r := range line[:dot] {
		if !unicode.IsDigit(r) {
			return "", false
		}
	}
	return line[:dot+2], true
}

func splitOversizeCodeBlock(item block, budget int) []block {
	lines := lineTextSpans(item.content)
	if len(lines) < 3 {
		return blocksFromSpans(item, splitLineAwareTextToBudgetSpans(item.content, budget), nil)
	}

	opening := item.content[lines[0].start:lines[0].end]
	fence, ok := parseFence(strings.TrimSpace(opening))
	closing := item.content[lines[len(lines)-1].start:lines[len(lines)-1].end]
	if !ok || !isClosingFence(closing, fence) {
		return blocksFromSpans(item, splitLineAwareTextToBudgetSpans(item.content, budget), nil)
	}

	bodyContent, body := trimTextSpan(item.content, lines[0].end, lines[len(lines)-1].start)
	bodyBudget := budget - estimateTokens(opening+"\n"+closing)
	if bodyContent == "" || bodyBudget < 1 {
		return blocksFromSpans(item, splitLineAwareTextToBudgetSpans(item.content, budget), nil)
	}

	relativeSpans := splitLineAwareTextToBudgetSpans(bodyContent, bodyBudget)
	spans := make([]textSpan, 0, len(relativeSpans))
	for _, span := range relativeSpans {
		spans = append(spans, textSpan{
			start: body.start + span.start,
			end:   body.start + span.end,
		})
	}
	return blocksFromSpans(item, spans, func(content string) string {
		return opening + "\n" + content + "\n" + closing
	})
}

func splitOversizeTableBlock(item block, budget int) []block {
	lines := lineTextSpans(item.content)
	if len(lines) < 3 {
		return blocksFromSpans(item, splitLineAwareTextToBudgetSpans(item.content, budget), nil)
	}

	header := item.content[lines[0].start:lines[1].end]
	separator := item.content[lines[1].start:lines[1].end]
	bodyBudget := budget - estimateTokens(header)
	if !isMarkdownTableSeparator(separator) || bodyBudget < 1 {
		return blocksFromSpans(item, splitLineAwareTextToBudgetSpans(item.content, budget), nil)
	}

	result := make([]block, 0, len(lines)-2)
	pending := make([]textSpan, 0, len(lines)-2)
	flushPending := func() {
		if len(pending) == 0 {
			return
		}
		spans := packTextSpans(item.content, pending, bodyBudget)
		result = append(result, blocksFromSpans(item, spans, func(content string) string {
			return header + "\n" + content
		})...)
		pending = nil
	}

	for _, row := range lines[2:] {
		rowContent := item.content[row.start:row.end]
		if estimateTokens(rowContent) <= bodyBudget {
			pending = append(pending, row)
			continue
		}

		flushPending()
		cells := tableCellTextSpans(item.content, row)
		emptyRow := formatMarkdownTableRow(make([]string, len(cells)))
		cellBudget := bodyBudget - estimateTokens(emptyRow)
		if len(cells) == 0 || cellBudget < 1 {
			spans := offsetTextSpans(splitTextToBudgetSpans(rowContent, bodyBudget), row.start)
			result = append(result, blocksFromSpans(item, spans, func(content string) string {
				return header + "\n" + content
			})...)
			continue
		}

		for cellIndex, cell := range cells {
			cellContent := item.content[cell.start:cell.end]
			if cellContent == "" {
				continue
			}
			for _, relative := range splitTextToBudgetSpans(cellContent, cellBudget) {
				span := textSpan{start: cell.start + relative.start, end: cell.start + relative.end}
				values := make([]string, len(cells))
				values[cellIndex] = item.content[span.start:span.end]
				rowPart := formatMarkdownTableRow(values)
				result = append(result, blocksFromSpans(item, []textSpan{span}, func(string) string {
					return header + "\n" + rowPart
				})...)
			}
		}
	}
	flushPending()
	if len(result) > 0 {
		result[0].startOffset = item.startOffset + lines[0].start
	}
	return result
}

func tableCellTextSpans(text string, row textSpan) []textSpan {
	pipes := make([]int, 0)
	for index := row.start; index < row.end; index++ {
		if text[index] == '|' {
			pipes = append(pipes, index)
		}
	}
	if len(pipes) == 0 {
		return nil
	}

	cellStart := row.start
	pipeStart := 0
	if pipes[0] == row.start {
		cellStart = row.start + 1
		pipeStart = 1
	}
	cells := make([]textSpan, 0, len(pipes)+1)
	for _, pipe := range pipes[pipeStart:] {
		_, cell := trimTextSpan(text, cellStart, pipe)
		cells = append(cells, cell)
		cellStart = pipe + 1
	}
	if cellStart < row.end {
		_, cell := trimTextSpan(text, cellStart, row.end)
		cells = append(cells, cell)
	}
	return cells
}

func formatMarkdownTableRow(cells []string) string {
	return "| " + strings.Join(cells, " | ") + " |"
}

func offsetTextSpans(spans []textSpan, offset int) []textSpan {
	shifted := make([]textSpan, 0, len(spans))
	for _, span := range spans {
		shifted = append(shifted, textSpan{start: span.start + offset, end: span.end + offset})
	}
	return shifted
}

func isMarkdownTableSeparator(line string) bool {
	line = strings.Trim(strings.TrimSpace(line), "|")
	cells := strings.Split(line, "|")
	if len(cells) == 0 {
		return false
	}
	for _, cell := range cells {
		cell = strings.Trim(strings.TrimSpace(cell), ":")
		if len(cell) < 3 || strings.Trim(cell, "-") != "" {
			return false
		}
	}
	return true
}

func splitLineAwareTextToBudgetSpans(text string, budget int) []textSpan {
	lines := lineTextSpans(text)
	if len(lines) > 1 {
		return packTextSpans(text, lines, budget)
	}
	return splitTextToBudgetSpans(text, budget)
}

func lineTextSpans(text string) []textSpan {
	spans := make([]textSpan, 0)
	for start := 0; start < len(text); {
		end := len(text)
		if newline := strings.IndexByte(text[start:], '\n'); newline >= 0 {
			end = start + newline
		}
		if content, span := trimTextSpan(text, start, end); content != "" {
			spans = append(spans, span)
		}
		if end == len(text) {
			break
		}
		start = end + 1
	}
	return spans
}

func splitTextToBudgetSpans(text string, budget int) []textSpan {
	content, whole := trimTextSpan(text, 0, len(text))
	if content == "" {
		return nil
	}
	if estimateTokens(content) <= budget {
		return []textSpan{whole}
	}

	if units := paragraphTextSpans(text); len(units) > 1 {
		return packTextSpans(text, units, budget)
	}
	if units := sentenceTextSpans(text); len(units) > 1 {
		return packTextSpans(text, units, budget)
	}
	if units := wordTextSpans(text); len(units) > 1 {
		return packTextSpans(text, units, budget)
	}
	return packTextSpans(text, runeTextSpans(text), budget)
}

func packTextSpans(text string, units []textSpan, budget int) []textSpan {
	result := make([]textSpan, 0, len(units))
	for start := 0; start < len(units); {
		unitContent, unit := trimTextSpan(text, units[start].start, units[start].end)
		if unitContent == "" {
			start++
			continue
		}
		if estimateTokens(unitContent) > budget {
			for _, nested := range splitTextToBudgetSpans(unitContent, budget) {
				result = append(result, textSpan{
					start: unit.start + nested.start,
					end:   unit.start + nested.end,
				})
			}
			start++
			continue
		}

		end := start + 1
		chosen := unit
		for end < len(units) {
			candidateContent, candidate := trimTextSpan(text, unit.start, units[end].end)
			if estimateTokens(candidateContent) > budget {
				break
			}
			chosen = candidate
			end++
		}
		result = append(result, chosen)
		start = end
	}
	return result
}

func paragraphTextSpans(text string) []textSpan {
	spans := make([]textSpan, 0)
	start := 0
	for start < len(text) {
		separator := strings.Index(text[start:], "\n\n")
		if separator < 0 {
			if content, span := trimTextSpan(text, start, len(text)); content != "" {
				spans = append(spans, span)
			}
			break
		}
		end := start + separator
		if content, span := trimTextSpan(text, start, end); content != "" {
			spans = append(spans, span)
		}
		start = end + 2
		for start < len(text) && text[start] == '\n' {
			start++
		}
	}
	return spans
}

func sentenceTextSpans(text string) []textSpan {
	spans := make([]textSpan, 0)
	start := 0
	for index, r := range text {
		if !strings.ContainsRune(".!?。！？；;", r) {
			continue
		}
		end := index + utf8.RuneLen(r)
		if content, span := trimTextSpan(text, start, end); content != "" {
			spans = append(spans, span)
		}
		start = end
	}
	if content, span := trimTextSpan(text, start, len(text)); content != "" {
		spans = append(spans, span)
	}
	return spans
}

func wordTextSpans(text string) []textSpan {
	spans := make([]textSpan, 0)
	start := -1
	for index, r := range text {
		if unicode.IsSpace(r) {
			if start >= 0 {
				spans = append(spans, textSpan{start: start, end: index})
				start = -1
			}
			continue
		}
		if start < 0 {
			start = index
		}
	}
	if start >= 0 {
		spans = append(spans, textSpan{start: start, end: len(text)})
	}
	return spans
}

func runeTextSpans(text string) []textSpan {
	spans := make([]textSpan, 0, utf8.RuneCountInString(text))
	for index, r := range text {
		spans = append(spans, textSpan{start: index, end: index + utf8.RuneLen(r)})
	}
	return spans
}

func trimTextSpan(text string, start int, end int) (string, textSpan) {
	if start < 0 {
		start = 0
	}
	if end > len(text) {
		end = len(text)
	}
	if start >= end {
		return "", textSpan{start: start, end: start}
	}
	raw := text[start:end]
	content := strings.TrimSpace(raw)
	if content == "" {
		return "", textSpan{start: start, end: start}
	}
	relativeStart := strings.Index(raw, content)
	span := textSpan{
		start: start + relativeStart,
		end:   start + relativeStart + len(content),
	}
	return content, span
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

func contentWithinBudget(prefix string, body string, budget int) string {
	prefix = strings.TrimSpace(prefix)
	body = strings.TrimSpace(body)
	content := body
	if prefix != "" && body != "" {
		content = prefix + "\n" + body
	} else if prefix != "" {
		content = prefix
	}
	if estimateTokens(content) <= budget {
		return content
	}

	if estimateTokens(body) > budget {
		body = trimContentToBudget(body, budget)
	}
	remaining := budget - estimateTokens(body)
	if remaining <= 0 || prefix == "" {
		return body
	}
	prefix = trimContentToBudget(prefix, remaining)
	if prefix == "" {
		return body
	}
	if body == "" {
		return prefix
	}
	return prefix + "\n" + body
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
		count += estimateFieldTokens(field)
	}
	return count
}

func estimateFieldTokens(text string) int {
	const asciiRunesPerToken = 4

	tokens := 0
	asciiRunes := 0
	flushASCII := func() {
		if asciiRunes == 0 {
			return
		}
		tokens += (asciiRunes + asciiRunesPerToken - 1) / asciiRunesPerToken
		asciiRunes = 0
	}

	for _, r := range text {
		if r <= unicode.MaxASCII {
			asciiRunes++
			continue
		}
		flushASCII()
		tokens++
	}
	flushASCII()
	return tokens
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
