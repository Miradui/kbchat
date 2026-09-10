package handler

import (
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/service"
	"net/http"
)

type EvaluationHandler struct{ service *service.EvaluationService }

func NewEvaluationHandler(s *service.EvaluationService) *EvaluationHandler {
	return &EvaluationHandler{service: s}
}

func evaluationScope(c *gin.Context) (uuid.UUID, uuid.UUID, bool) {
	actor, ok := currentUserIDOrError(c)
	if !ok {
		return uuid.Nil, uuid.Nil, false
	}
	kbID, ok := parseUUIDParam(c, "id", "knowledge base id is invalid")
	return actor, kbID, ok
}

func bindEvaluation(c *gin.Context, target any) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 128<<10)
	if err := c.ShouldBindJSON(target); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "invalid evaluation request"}))
		return false
	}
	return true
}

func (h *EvaluationHandler) ListCases(c *gin.Context) {
	actor, kbID, ok := evaluationScope(c)
	if !ok {
		return
	}
	items, err := h.service.ListCases(c.Request.Context(), actor, kbID)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

func (h *EvaluationHandler) SaveCase(c *gin.Context) {
	actor, kbID, ok := evaluationScope(c)
	if !ok {
		return
	}
	id := uuid.Nil
	if c.Param("caseId") != "" {
		id, ok = parseUUIDParam(c, "caseId", "case id is invalid")
		if !ok {
			return
		}
	}
	var req dto.EvaluationCaseRequest
	if !bindEvaluation(c, &req) {
		return
	}
	item, err := h.service.SaveCase(c.Request.Context(), actor, kbID, id, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	status := http.StatusOK
	if id == uuid.Nil {
		status = http.StatusCreated
	}
	c.JSON(status, item)
}

func (h *EvaluationHandler) DeleteCase(c *gin.Context) {
	actor, kbID, ok := evaluationScope(c)
	if !ok {
		return
	}
	id, ok := parseUUIDParam(c, "caseId", "case id is invalid")
	if !ok {
		return
	}
	if err := h.service.DeleteCase(c.Request.Context(), actor, kbID, id); err != nil {
		RespondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *EvaluationHandler) ListRuns(c *gin.Context) {
	actor, kbID, ok := evaluationScope(c)
	if !ok {
		return
	}
	items, err := h.service.ListRuns(c.Request.Context(), actor, kbID)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

func (h *EvaluationHandler) CreateRun(c *gin.Context) {
	actor, kbID, ok := evaluationScope(c)
	if !ok {
		return
	}
	var req dto.EvaluationRunRequest
	if !bindEvaluation(c, &req) {
		return
	}
	item, err := h.service.CreateRun(c.Request.Context(), actor, kbID, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusAccepted, item)
}

func (h *EvaluationHandler) GetRun(c *gin.Context) {
	actor, kbID, ok := evaluationScope(c)
	if !ok {
		return
	}
	id, ok := parseUUIDParam(c, "runId", "run id is invalid")
	if !ok {
		return
	}
	item, err := h.service.GetRun(c.Request.Context(), actor, kbID, id)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, item)
}

func (h *EvaluationHandler) CancelRun(c *gin.Context) {
	actor, kbID, ok := evaluationScope(c)
	if !ok {
		return
	}
	id, ok := parseUUIDParam(c, "runId", "run id is invalid")
	if !ok {
		return
	}
	item, err := h.service.CancelRun(c.Request.Context(), actor, kbID, id)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, item)
}
