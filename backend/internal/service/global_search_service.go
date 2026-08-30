package service

import (
	"bytes"
	"context"
	"encoding/csv"
	"strings"
	"unicode"

	"github.com/google/uuid"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/repository"
)

type GlobalSearchService struct {
	search *repository.GlobalSearchRepository
}

func NewGlobalSearchService(search *repository.GlobalSearchRepository) *GlobalSearchService {
	return &GlobalSearchService{search: search}
}

// globalSearchScope translates the capability matrix into the role sets the query
// needs. Global search spans knowledge bases the caller does not own, so the scope
// has to be derived here rather than assumed by the repository.
func globalSearchScope() repository.GlobalSearchScope {
	return repository.GlobalSearchScope{
		KnowledgeBaseRoles: access.MemberRolesWith(access.CapKnowledgeBaseRead),
		DocumentRoles:      access.MemberRolesWith(access.CapDocumentRead),
		ChunkRoles:         access.MemberRolesWith(access.CapKnowledgeBaseSearch),
	}
}

func (s *GlobalSearchService) Search(ctx context.Context, ownerID uuid.UUID, req dto.GlobalSearchRequest) (*dto.GlobalSearchResponse, error) {
	query := strings.TrimSpace(req.Query)
	if query == "" {
		return nil, apperror.Validation(map[string]any{"q": "查询不能为空"})
	}
	resultType := strings.TrimSpace(req.Type)
	if resultType == "" {
		resultType = "all"
	}
	if resultType != "all" && resultType != "knowledgeBase" && resultType != "document" && resultType != "chunk" {
		return nil, apperror.Validation(map[string]any{"type": "type must be one of all, knowledgeBase, document, chunk"})
	}
	page := req.Page
	if page <= 0 {
		page = 1
	}
	pageSize := req.PageSize
	if pageSize <= 0 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	items, total, err := s.search.Search(ctx, ownerID, globalSearchScope(), query, resultType, (page-1)*pageSize, pageSize)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res := dto.GlobalSearchResponse{
		Items:    make([]dto.GlobalSearchResultResponse, 0, len(items)),
		Total:    total,
		Page:     page,
		PageSize: pageSize,
	}
	for i := range items {
		res.Items = append(res.Items, toGlobalSearchResponse(&items[i], query))
	}
	return &res, nil
}

const maxSearchExportItems = 5000

func (s *GlobalSearchService) Export(ctx context.Context, ownerID uuid.UUID, req dto.GlobalSearchRequest) (*ExportFile, error) {
	req.Page = 1
	req.PageSize = 100
	first, err := s.Search(ctx, ownerID, req)
	if err != nil {
		return nil, err
	}
	if first.Total > maxSearchExportItems {
		return nil, apperror.New(400, "EXPORT_TOO_LARGE", "搜索结果过多，请缩小范围后再导出")
	}
	items := append([]dto.GlobalSearchResultResponse{}, first.Items...)
	for page := 2; int64(len(items)) < first.Total; page++ {
		req.Page = page
		next, searchErr := s.Search(ctx, ownerID, req)
		if searchErr != nil {
			return nil, searchErr
		}
		if len(next.Items) == 0 {
			break
		}
		items = append(items, next.Items...)
	}

	var buffer bytes.Buffer
	buffer.WriteString("\ufeff")
	writer := csv.NewWriter(&buffer)
	if err := writer.Write([]string{"类型", "知识库", "标题", "摘要", "知识库ID", "文档ID", "结果ID"}); err != nil {
		return nil, apperror.Internal(err)
	}
	for i := range items {
		if err := writer.Write([]string{
			items[i].Type,
			items[i].KnowledgeBaseName,
			items[i].Title,
			items[i].Snippet,
			items[i].KnowledgeBaseID,
			items[i].DocumentID,
			items[i].ID,
		}); err != nil {
			return nil, apperror.Internal(err)
		}
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		return nil, apperror.Internal(err)
	}
	return &ExportFile{
		Filename:    "search-results.csv",
		ContentType: "text/csv; charset=utf-8",
		Content:     buffer.Bytes(),
	}, nil
}

// MaxSearchSuggestLimit bounds the command palette request; the default is 10.
const MaxSearchSuggestLimit = 20

func (s *GlobalSearchService) Suggest(ctx context.Context, ownerID uuid.UUID, req dto.SearchSuggestRequest) (*dto.SearchSuggestResponse, error) {
	query := strings.TrimSpace(req.Query)
	if query == "" {
		return nil, apperror.Validation(map[string]any{"q": "查询不能为空"})
	}
	limit := req.Limit
	if limit <= 0 {
		limit = 10
	}
	if limit > MaxSearchSuggestLimit {
		limit = MaxSearchSuggestLimit
	}

	items, err := s.search.Suggest(ctx, ownerID, globalSearchScope(), query, limit)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res := dto.SearchSuggestResponse{Items: make([]dto.SearchSuggestItem, 0, len(items))}
	for i := range items {
		documentID := ""
		if items[i].DocumentID != nil {
			documentID = items[i].DocumentID.String()
		}
		res.Items = append(res.Items, dto.SearchSuggestItem{
			Type:              items[i].Type,
			ID:                items[i].ID.String(),
			KnowledgeBaseID:   items[i].KnowledgeBaseID.String(),
			KnowledgeBaseName: items[i].KnowledgeBaseName,
			DocumentID:        documentID,
			Title:             items[i].Title,
		})
	}
	return &res, nil
}

func toGlobalSearchResponse(item *repository.GlobalSearchResult, query string) dto.GlobalSearchResultResponse {
	documentID := ""
	if item.DocumentID != nil {
		documentID = item.DocumentID.String()
	}
	highlights := append(
		highlightRanges("title", item.Title, query),
		highlightRanges("snippet", item.Snippet, query)...,
	)
	return dto.GlobalSearchResultResponse{
		Type:              item.Type,
		ID:                item.ID.String(),
		KnowledgeBaseID:   item.KnowledgeBaseID.String(),
		KnowledgeBaseName: item.KnowledgeBaseName,
		DocumentID:        documentID,
		Filename:          item.Filename,
		Title:             item.Title,
		Snippet:           item.Snippet,
		Highlights:        highlights,
	}
}

// maxHighlightsPerField bounds a pathological result: a one-character query
// against a long chunk would otherwise produce thousands of ranges.
const maxHighlightsPerField = 50

// highlightRanges reports every non-overlapping, case-insensitive occurrence of
// query in text, using the same rule the SQL match uses (LOWER(...) LIKE '%q%').
//
// Offsets are UTF-16 code units so the frontend can use them as plain JavaScript
// string indices. Folding is done per rune against the original text rather than
// on a lowercased copy, so a fold that changes length cannot shift the offsets.
func highlightRanges(field, text, query string) []dto.SearchHighlight {
	if text == "" || query == "" {
		return nil
	}

	haystack := foldRunes(text)
	needle := foldRunes(query)
	if len(needle) == 0 || len(needle) > len(haystack) {
		return nil
	}

	// units[i] is the number of UTF-16 code units before rune i.
	units := make([]int, len(haystack)+1)
	for i, r := range haystack {
		width := 1
		if r > 0xFFFF {
			width = 2
		}
		units[i+1] = units[i] + width
	}

	highlights := make([]dto.SearchHighlight, 0, 4)
	for i := 0; i+len(needle) <= len(haystack); {
		if !runesEqual(haystack[i:i+len(needle)], needle) {
			i++
			continue
		}
		highlights = append(highlights, dto.SearchHighlight{
			Field: field,
			Start: units[i],
			End:   units[i+len(needle)],
		})
		if len(highlights) == maxHighlightsPerField {
			break
		}
		i += len(needle)
	}
	if len(highlights) == 0 {
		return nil
	}
	return highlights
}

func foldRunes(value string) []rune {
	runes := []rune(value)
	for i, r := range runes {
		runes[i] = unicode.ToLower(r)
	}
	return runes
}

func runesEqual(a, b []rune) bool {
	for i := range b {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
