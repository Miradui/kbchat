package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"kbchat/backend/internal/service"
)

type SystemHandler struct {
	system *service.SystemService
}

func NewSystemHandler(system *service.SystemService) *SystemHandler {
	return &SystemHandler{system: system}
}

func (h *SystemHandler) Capabilities(c *gin.Context) {
	c.JSON(http.StatusOK, h.system.Capabilities())
}

// Diagnostics reports dependency, queue, provider and latency state.
//
// Always 200, even when a dependency is down: the failing dependency is the
// payload, and a non-2xx would make the client show a generic error instead of
// the diagnosis. Callers gate on the "status" field.
func (h *SystemHandler) Diagnostics(c *gin.Context) {
	c.JSON(http.StatusOK, h.system.Diagnostics(c.Request.Context()))
}

// Health is the unauthenticated liveness probe.
//
// It stays 200 even when a dependency is down, and reports the truth in the body
// instead. This is liveness, not readiness: a 503 makes a Kubernetes
// livenessProbe restart the container, and restarting the API does not bring
// Redis back -- it just adds an outage to an outage. The body is limited to
// dependency names and statuses because this endpoint is unauthenticated.
func (h *SystemHandler) Health(c *gin.Context) {
	c.JSON(http.StatusOK, h.system.Health(c.Request.Context()))
}
