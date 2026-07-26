package handler

import (
	"errors"
	"net/http"
	"net/url"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"rag/backend/internal/apperror"
	"rag/backend/internal/dto"
	"rag/backend/internal/middleware"
	"rag/backend/internal/service"
)

type DocumentHandler struct {
	documents             *service.DocumentService
	maxUploadRequestBytes int64
}

func NewDocumentHandler(documents *service.DocumentService, maxUploadSizeMB int) *DocumentHandler {
	if maxUploadSizeMB <= 0 {
		maxUploadSizeMB = 50
	}
	return &DocumentHandler{
		documents:             documents,
		maxUploadRequestBytes: int64(maxUploadSizeMB)*1024*1024 + 1*1024*1024,
	}
}

func (h *DocumentHandler) Upload(c *gin.Context) {
	h.limitUploadBody(c)
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}

	kbID, ok := parseUUIDParam(c, "id", "知识库 ID 不合法")
	if !ok {
		return
	}

	file, err := c.FormFile("file")
	if err != nil {
		RespondError(c, uploadFileError(err))
		return
	}

	res, err := h.documents.Upload(c.Request.Context(), userID, kbID, file)
	if err != nil {
		RespondError(c, err)
		return
	}

	c.JSON(http.StatusCreated, res)
}

func (h *DocumentHandler) UploadGlobal(c *gin.Context) {
	h.limitUploadBody(c)
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	file, err := c.FormFile("file")
	if err != nil {
		RespondError(c, uploadFileError(err))
		return
	}
	kbID, err := uuid.Parse(c.PostForm("knowledgeBaseId"))
	if err != nil {
		RespondError(c, apperror.Validation(map[string]any{"knowledgeBaseId": "知识库 ID 不合法"}))
		return
	}
	res, err := h.documents.Upload(c.Request.Context(), userID, kbID, file)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusCreated, res)
}

func (h *DocumentHandler) limitUploadBody(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, h.maxUploadRequestBytes)
}

func uploadFileError(err error) error {
	var maxBytesError *http.MaxBytesError
	if errors.As(err, &maxBytesError) {
		return apperror.Validation(map[string]any{"file": "file size exceeds limit"})
	}
	return apperror.Validation(map[string]any{"file": "文件不能为空"})
}

func (h *DocumentHandler) List(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}

	kbID, ok := parseUUIDParam(c, "id", "知识库 ID 不合法")
	if !ok {
		return
	}

	res, err := h.documents.List(c.Request.Context(), userID, kbID)
	if err != nil {
		RespondError(c, err)
		return
	}

	c.JSON(http.StatusOK, res)
}

func (h *DocumentHandler) ListGlobal(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	var knowledgeBaseID *string
	if value := c.Query("knowledgeBaseId"); value != "" {
		knowledgeBaseID = &value
	}
	res, err := h.documents.ListGlobal(c.Request.Context(), userID, dto.GlobalDocumentListQuery{
		Q:               c.Query("q"),
		KnowledgeBaseID: knowledgeBaseID,
		Status:          c.Query("status"),
		FileType:        c.Query("fileType"),
		Sort:            c.Query("sort"),
		Page:            queryInt(c, "page", 1),
		PageSize:        queryInt(c, "pageSize", 20),
	})
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *DocumentHandler) BatchDelete(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	var req dto.DocumentBatchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请求参数不合法"}))
		return
	}
	res, err := h.documents.BatchDelete(c.Request.Context(), userID, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *DocumentHandler) BatchRestore(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	var req dto.DocumentBatchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请求参数不合法"}))
		return
	}
	res, err := h.documents.BatchRestore(c.Request.Context(), userID, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *DocumentHandler) BatchReprocess(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	var req dto.DocumentBatchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请求参数不合法"}))
		return
	}
	res, err := h.documents.BatchReprocess(c.Request.Context(), userID, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *DocumentHandler) Get(c *gin.Context) {
	userID, documentID, ok := userAndDocumentID(c)
	if !ok {
		return
	}

	res, err := h.documents.Get(c.Request.Context(), userID, documentID)
	if err != nil {
		RespondError(c, err)
		return
	}

	c.JSON(http.StatusOK, res)
}

func (h *DocumentHandler) Delete(c *gin.Context) {
	userID, documentID, ok := userAndDocumentID(c)
	if !ok {
		return
	}

	if err := h.documents.Delete(c.Request.Context(), userID, documentID); err != nil {
		RespondError(c, err)
		return
	}

	c.Status(http.StatusNoContent)
}

func (h *DocumentHandler) Reprocess(c *gin.Context) {
	userID, documentID, ok := userAndDocumentID(c)
	if !ok {
		return
	}

	res, err := h.documents.Reprocess(c.Request.Context(), userID, documentID)
	if err != nil {
		RespondError(c, err)
		return
	}

	c.JSON(http.StatusOK, res)
}

func (h *DocumentHandler) Chunks(c *gin.Context) {
	userID, documentID, ok := userAndDocumentID(c)
	if !ok {
		return
	}
	var chunkID *uuid.UUID
	if rawChunkID, provided := c.GetQuery("chunkId"); provided {
		parsedChunkID, err := uuid.Parse(rawChunkID)
		if err != nil {
			RespondError(c, apperror.Validation(map[string]any{"chunkId": "Chunk ID 不合法"}))
			return
		}
		chunkID = &parsedChunkID
	}

	res, err := h.documents.Chunks(c.Request.Context(), userID, documentID, dto.ChunkListQuery{
		Page:     queryInt(c, "page", 1),
		PageSize: queryInt(c, "pageSize", 20),
		Q:        c.Query("q"),
		ChunkID:  chunkID,
	})
	if err != nil {
		RespondError(c, err)
		return
	}

	c.JSON(http.StatusOK, res)
}

func (h *DocumentHandler) Download(c *gin.Context) {
	userID, documentID, ok := userAndDocumentID(c)
	if !ok {
		return
	}
	file, err := h.documents.Download(c.Request.Context(), userID, documentID)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.Header("Content-Type", file.ContentType)
	c.Header("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(file.Filename))
	c.File(file.Path)
}

func (h *DocumentHandler) Preview(c *gin.Context) {
	userID, documentID, ok := userAndDocumentID(c)
	if !ok {
		return
	}
	res, err := h.documents.Preview(c.Request.Context(), userID, documentID)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *DocumentHandler) ListRecycleBin(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	res, err := h.documents.ListRecycleBin(c.Request.Context(), userID, queryInt(c, "page", 1), queryInt(c, "pageSize", 20))
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *DocumentHandler) Restore(c *gin.Context) {
	userID, documentID, ok := userAndDocumentID(c)
	if !ok {
		return
	}
	if err := h.documents.Restore(c.Request.Context(), userID, documentID); err != nil {
		RespondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *DocumentHandler) PermanentDelete(c *gin.Context) {
	userID, documentID, ok := userAndDocumentID(c)
	if !ok {
		return
	}
	if err := h.documents.PermanentDelete(c.Request.Context(), userID, documentID); err != nil {
		RespondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *DocumentHandler) EmptyRecycleBin(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	if err := h.documents.EmptyRecycleBin(c.Request.Context(), userID); err != nil {
		RespondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func userAndDocumentID(c *gin.Context) (uuid.UUID, uuid.UUID, bool) {
	userID, ok := middleware.CurrentUserID(c)
	if !ok {
		RespondError(c, apperror.Unauthorized())
		return uuid.Nil, uuid.Nil, false
	}

	documentID, ok := parseUUIDParam(c, "id", "文档 ID 不合法")
	if !ok {
		return uuid.Nil, uuid.Nil, false
	}

	return userID, documentID, true
}

func parseUUIDParam(c *gin.Context, name string, message string) (uuid.UUID, bool) {
	id, err := uuid.Parse(c.Param(name))
	if err != nil {
		RespondError(c, apperror.Validation(map[string]any{name: message}))
		return uuid.Nil, false
	}
	return id, true
}
