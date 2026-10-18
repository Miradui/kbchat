package router

import (
	"context"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
	"gorm.io/gorm"

	"kbchat/backend/internal/cache"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/handler"
	"kbchat/backend/internal/middleware"
	"kbchat/backend/internal/observability"
	chatprovider "kbchat/backend/internal/provider/chat"
	embeddingprovider "kbchat/backend/internal/provider/embedding"
	rerankprovider "kbchat/backend/internal/provider/rerank"
	titleprovider "kbchat/backend/internal/provider/title"
	"kbchat/backend/internal/repository"
	"kbchat/backend/internal/rerank"
	"kbchat/backend/internal/retrieval"
	"kbchat/backend/internal/service"
	"kbchat/backend/internal/storage"
)

// Dependencies carries collaborators the router cannot construct itself.
//
// It is a struct rather than extra parameters so adding one later does not break
// the nine existing New/NewWithStorage call sites. Every field is optional: the
// diagnostics surface reports a nil dependency as not configured rather than
// failing.
type Dependencies struct {
	// Redis is injected rather than dialed here so the server keeps one client
	// with one connection pool, and so the probe checks the client the
	// application actually uses.
	Redis redisPinger
	// RateLimiter and EmbeddingCache share the server's Redis client but remain
	// explicit dependencies so router tests can substitute either concern.
	RateLimiter    cache.RateLimiter
	EmbeddingCache *cache.EmbeddingCache
	// Metrics is shared with the retrieval and chat services, which is the whole
	// point: the diagnostics page reads what request handling recorded.
	Metrics *observability.Recorder
	// Only the server supplies this; router tests never spawn background workers.
	WorkerContext context.Context
}

type redisPinger interface {
	Ping(ctx context.Context) *redis.StatusCmd
}

func New(cfg config.Config, db *gorm.DB, logger *zap.Logger) *gin.Engine {
	return NewWithDependencies(cfg, db, logger, Dependencies{})
}

func NewWithDependencies(cfg config.Config, db *gorm.DB, logger *zap.Logger, deps Dependencies) *gin.Engine {
	fileStorage, err := storage.NewFromConfig(cfg)
	if err != nil {
		panic(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := storage.EnsureReady(ctx, fileStorage); err != nil {
		panic(err)
	}
	return NewWithStorageAndDependencies(cfg, db, logger, fileStorage, deps)
}

func NewWithStorage(cfg config.Config, db *gorm.DB, logger *zap.Logger, fileStorage storage.Storage) *gin.Engine {
	return NewWithStorageAndDependencies(cfg, db, logger, fileStorage, Dependencies{})
}

func NewWithStorageAndDependencies(cfg config.Config, db *gorm.DB, logger *zap.Logger, fileStorage storage.Storage, deps Dependencies) *gin.Engine {
	if cfg.AppEnv == "production" {
		gin.SetMode(gin.ReleaseMode)
	}

	userRepo := repository.NewUserRepository(db)
	knowledgeBaseRepo := repository.NewKnowledgeBaseRepository(db)
	knowledgeBaseCategoryRepo := repository.NewKnowledgeBaseCategoryRepository(db)
	knowledgeBaseTagRepo := repository.NewKnowledgeBaseTagRepository(db)
	knowledgeBaseTagBindingRepo := repository.NewKnowledgeBaseTagBindingRepository(db)
	knowledgeBaseMemberRepo := repository.NewKnowledgeBaseMemberRepository(db)
	knowledgeBaseFavoriteRepo := repository.NewKnowledgeBaseFavoriteRepository(db)
	knowledgeBaseViewRepo := repository.NewKnowledgeBaseViewRepository(db)
	knowledgeBaseWorkspacePreferenceRepo := repository.NewKnowledgeBaseWorkspacePreferenceRepository(db)
	documentRepo := repository.NewDocumentRepository(db)
	storageCleanupRepo := repository.NewStorageCleanupRepository(db)
	chunkRepo := repository.NewChunkRepository(db)
	chatRepo := repository.NewChatRepository(db)
	globalSearchRepo := repository.NewGlobalSearchRepository(db)
	activityRepo := repository.NewActivityRepository(db)
	embedder := embeddingprovider.NewOpenAICompatibleProvider(cfg)
	reranker := newRerankProvider(cfg)
	chatProvider := chatprovider.NewOpenAICompatibleProvider(cfg)
	titleProvider := titleprovider.NewOpenAICompatibleProvider(cfg)
	authService := service.NewAuthService(cfg, userRepo)
	userService := service.NewUserService(userRepo)
	knowledgeBaseService := service.NewKnowledgeBaseService(knowledgeBaseRepo, knowledgeBaseCategoryRepo, knowledgeBaseFavoriteRepo, knowledgeBaseViewRepo, knowledgeBaseWorkspacePreferenceRepo, knowledgeBaseTagRepo, knowledgeBaseTagBindingRepo, knowledgeBaseMemberRepo, userRepo)
	knowledgeBaseService.SetChatAllowedModels(cfg.ChatAllowedModels)
	knowledgeBaseCategoryService := service.NewKnowledgeBaseCategoryService(knowledgeBaseCategoryRepo, knowledgeBaseRepo)
	knowledgeBaseTagService := service.NewKnowledgeBaseTagService(knowledgeBaseTagRepo, knowledgeBaseTagBindingRepo)
	documentService := service.NewDocumentService(cfg, documentRepo, chunkRepo, knowledgeBaseRepo, storageCleanupRepo, fileStorage)
	retrievalService := retrieval.NewService(cfg, chunkRepo, knowledgeBaseRepo, embedder, reranker)
	if deps.EmbeddingCache != nil {
		retrievalService.SetEmbeddingCache(deps.EmbeddingCache)
	}
	chatService := service.NewChatService(cfg, chatRepo, knowledgeBaseRepo, retrievalService, chatProvider, titleProvider)
	chatService.SetUsageRepository(repository.NewModelUsageRepository(db))
	chatService.SetUserRepository(userRepo)
	evaluationService := service.NewEvaluationService(repository.NewEvaluationRepository(db), knowledgeBaseRepo, chatService)
	chatService.SetEvaluations(evaluationService)
	globalSearchService := service.NewGlobalSearchService(globalSearchRepo)
	homeService := service.NewHomeService(knowledgeBaseService, documentService, chatService)
	activityService := service.NewActivityService(activityRepo)

	// The timeline is fed by the services that own each mutation. Recording is
	// best effort and wired after construction so it stays optional.
	activityRecorder := service.NewActivityRecorder(activityRepo)
	knowledgeBaseService.SetActivityRecorder(activityRecorder)
	documentService.SetActivityRecorder(activityRecorder)
	chatService.SetActivityRecorder(activityRecorder)
	// Metrics are shared: retrieval and chat write, diagnostics reads. Without a
	// recorder both sides degrade to no-ops rather than nil-panicking.
	metrics := deps.Metrics
	if metrics == nil {
		metrics = observability.NewRecorder()
	}
	metrics = metrics.WithLogger(logger)
	retrievalService.SetRecorder(metrics)
	chatService.SetRecorder(metrics)
	if deps.WorkerContext != nil {
		go evaluationService.RunWorker(deps.WorkerContext, logger)
	}

	systemService := service.NewSystemService(cfg)
	diagnosticsDeps := service.SystemDiagnosticsDeps{
		Database: repository.NewSystemRepository(db),
		Docs:     documentRepo,
		Cleanup:  storageCleanupRepo,
		Vector:   chunkRepo,
		Metrics:  metrics,
		Logger:   logger,
	}
	// Assigned conditionally, not through a constructor that may return a nil
	// pointer: a typed nil in an interface field is not nil, so the service's
	// not-configured check would pass it through and the probe would panic.
	if deps.Redis != nil {
		diagnosticsDeps.Redis = &redisProbe{client: deps.Redis}
	}
	if fileStorage != nil {
		diagnosticsDeps.Storage = &storageProbe{fileStorage: fileStorage}
	}
	systemService.SetDiagnosticsDeps(diagnosticsDeps)
	authHandler := handler.NewAuthHandler(authService)
	userHandler := handler.NewUserHandler(userService)
	knowledgeBaseHandler := handler.NewKnowledgeBaseHandler(knowledgeBaseService)
	knowledgeBaseCategoryHandler := handler.NewKnowledgeBaseCategoryHandler(knowledgeBaseCategoryService)
	knowledgeBaseTagHandler := handler.NewKnowledgeBaseTagHandler(knowledgeBaseTagService)
	documentHandler := handler.NewDocumentHandler(documentService, cfg.MaxUploadSizeMB)
	searchHandler := handler.NewSearchHandler(retrievalService)
	chatHandler := handler.NewChatHandler(chatService)
	evaluationHandler := handler.NewEvaluationHandler(evaluationService)
	globalSearchHandler := handler.NewGlobalSearchHandler(globalSearchService)
	homeHandler := handler.NewHomeHandler(homeService)
	activityHandler := handler.NewActivityHandler(activityService)
	systemHandler := handler.NewSystemHandler(systemService)
	systemAdmins := service.NewSystemAdminService(userRepo)
	adminUserService := service.NewAdminUserService(userRepo)
	adminUserService.SetActivityRecorder(activityRecorder)
	adminUserService.SetActivityLog(activityRepo)
	adminUserService.SetOwnershipService(knowledgeBaseService)
	adminUserHandler := handler.NewAdminUserHandler(adminUserService)

	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(middleware.RequestLogger(logger))
	r.Use(middleware.CORS(cfg.CORSAllowedOrigins))

	r.GET("/healthz", systemHandler.Health)

	v1 := r.Group("/api/v1")
	v1.GET("/healthz", systemHandler.Health)

	authRoutes := v1.Group("/auth")
	loginHandlers := []gin.HandlerFunc{authHandler.Login}
	var chatRateLimit gin.HandlerFunc
	if cfg.RateLimitEnabled {
		clientIPResolver, err := middleware.NewClientIPResolver(cfg.TrustedProxyCIDRs)
		if err != nil {
			panic(err)
		}
		loginRateLimit := middleware.RateLimit(deps.RateLimiter, middleware.RateLimitOptions{
			Scope:       middleware.RateLimitScopeLogin,
			Limit:       cfg.RateLimitLoginPerMinute,
			Window:      time.Minute,
			FailureMode: middleware.NormalizeRateLimitFailureMode(cfg.RateLimitFailureMode),
			Key:         clientIPResolver.Key,
			Logger:      logger,
			Recorder:    metrics,
		})
		loginHandlers = append([]gin.HandlerFunc{loginRateLimit}, loginHandlers...)
		chatRateLimit = middleware.RateLimit(deps.RateLimiter, middleware.RateLimitOptions{
			Scope:       middleware.RateLimitScopeChat,
			Limit:       cfg.RateLimitChatPerMinute,
			Window:      time.Minute,
			FailureMode: middleware.NormalizeRateLimitFailureMode(cfg.RateLimitFailureMode),
			Key:         middleware.CurrentUserKey,
			Logger:      logger,
			Recorder:    metrics,
		})
	}
	authRoutes.POST("/login", loginHandlers...)

	protected := v1.Group("")
	protected.Use(middleware.AuthRequired(cfg, userRepo))
	protected.GET("/auth/me", authHandler.Me)
	protected.PUT("/auth/me", authHandler.UpdateProfile)
	protected.POST("/auth/me/avatar", authHandler.UploadAvatar)
	protected.DELETE("/auth/me/avatar", authHandler.RemoveAvatar)
	protected.GET("/users/:id/avatar", authHandler.GetAvatar)
	protected.POST("/auth/change-password", authHandler.ChangePassword)
	protected.POST("/auth/logout", authHandler.Logout)
	protected.GET("/users/search", userHandler.Search)
	protected.GET("/system/capabilities", systemHandler.Capabilities)
	protected.GET("/system/diagnostics", handler.RequireSystemAdmin(systemAdmins), systemHandler.Diagnostics)
	adminUsers := protected.Group("/admin/users", handler.RequireSystemAdmin(systemAdmins))
	adminUsers.GET("", adminUserHandler.List)
	adminUsers.POST("", adminUserHandler.Create)
	adminUsers.PUT("/:id", adminUserHandler.Update)
	adminUsers.POST("/:id/reset-password", adminUserHandler.ResetPassword)
	adminUsers.PUT("/:id/role", adminUserHandler.UpdateRole)
	adminUsers.POST("/:id/transfer-knowledge-bases", adminUserHandler.TransferKnowledgeBases)
	protected.GET("/admin/activities", handler.RequireSystemAdmin(systemAdmins), adminUserHandler.ListActivities)
	protected.GET("/home/summary", homeHandler.Summary)
	protected.GET("/activities", activityHandler.List)
	protected.GET("/knowledge-base-categories", knowledgeBaseCategoryHandler.List)
	protected.POST("/knowledge-base-categories", knowledgeBaseCategoryHandler.Create)
	protected.POST("/knowledge-base-categories/reorder", knowledgeBaseCategoryHandler.Reorder)
	protected.PUT("/knowledge-base-categories/:id", knowledgeBaseCategoryHandler.Update)
	protected.DELETE("/knowledge-base-categories/:id", knowledgeBaseCategoryHandler.Delete)
	protected.GET("/knowledge-base-tags", knowledgeBaseTagHandler.List)
	protected.POST("/knowledge-base-tags", knowledgeBaseTagHandler.Create)
	protected.PUT("/knowledge-base-tags/:id", knowledgeBaseTagHandler.Update)
	protected.DELETE("/knowledge-base-tags/:id", knowledgeBaseTagHandler.Delete)
	protected.POST("/knowledge-bases", knowledgeBaseHandler.Create)
	protected.GET("/knowledge-bases", knowledgeBaseHandler.List)
	protected.GET("/knowledge-bases/workspace-preference", knowledgeBaseHandler.GetWorkspacePreference)
	protected.PUT("/knowledge-bases/workspace-preference", knowledgeBaseHandler.UpdateWorkspacePreference)
	protected.POST("/knowledge-bases/batch-favorite", knowledgeBaseHandler.BatchFavorite)
	protected.POST("/knowledge-bases/batch-move-category", knowledgeBaseHandler.BatchMoveCategory)
	protected.POST("/knowledge-bases/batch-tag", knowledgeBaseHandler.BatchTag)
	protected.POST("/knowledge-bases/batch-delete", knowledgeBaseHandler.BatchDelete)
	protected.POST("/knowledge-bases/batch-restore", knowledgeBaseHandler.BatchRestore)
	protected.GET("/knowledge-bases/recycle-bin", knowledgeBaseHandler.ListRecycleBin)
	protected.POST("/knowledge-bases/recycle-bin/empty", knowledgeBaseHandler.EmptyRecycleBin)
	protected.DELETE("/knowledge-bases/recycle-bin/:id", knowledgeBaseHandler.PermanentDelete)
	protected.GET("/knowledge-bases/stats", knowledgeBaseHandler.Stats)
	protected.GET("/knowledge-bases/:id", knowledgeBaseHandler.Get)
	protected.PUT("/knowledge-bases/:id", knowledgeBaseHandler.Update)
	protected.DELETE("/knowledge-bases/:id", knowledgeBaseHandler.Delete)
	protected.POST("/knowledge-bases/:id/transfer-ownership", knowledgeBaseHandler.TransferOwnership)
	protected.GET("/knowledge-bases/:id/permissions", knowledgeBaseHandler.GetPermissions)
	protected.GET("/knowledge-bases/:id/stats", knowledgeBaseHandler.DetailStats)
	protected.PUT("/knowledge-bases/:id/permissions", knowledgeBaseHandler.UpdatePermissions)
	protected.POST("/knowledge-bases/:id/members", knowledgeBaseHandler.AddMember)
	protected.PUT("/knowledge-bases/:id/members/:userId", knowledgeBaseHandler.UpdateMember)
	protected.DELETE("/knowledge-bases/:id/members/:userId", knowledgeBaseHandler.RemoveMember)
	protected.POST("/knowledge-bases/:id/restore", knowledgeBaseHandler.Restore)
	protected.POST("/knowledge-bases/:id/favorite", knowledgeBaseHandler.Favorite)
	protected.DELETE("/knowledge-bases/:id/favorite", knowledgeBaseHandler.Unfavorite)
	protected.POST("/knowledge-bases/:id/view", knowledgeBaseHandler.RecordView)
	protected.POST("/knowledge-bases/:id/search", searchHandler.Search)
	protected.POST("/knowledge-bases/search", searchHandler.SearchMany)
	protected.POST("/knowledge-bases/:id/documents", documentHandler.Upload)
	protected.POST("/knowledge-bases/:id/documents/text", documentHandler.CreateText)
	protected.GET("/knowledge-bases/:id/document-uploads/:requestId", documentHandler.UploadResult)
	protected.POST("/knowledge-bases/:id/document-import-preview", documentHandler.InspectTable)
	protected.GET("/knowledge-bases/:id/documents", documentHandler.List)
	protected.GET("/documents", documentHandler.ListGlobal)
	protected.GET("/documents/counts", documentHandler.CountsGlobal)
	protected.POST("/documents/version-status", documentHandler.VersionStatus)
	protected.GET("/documents/recycle-bin", documentHandler.ListRecycleBin)
	protected.POST("/documents/recycle-bin/empty", documentHandler.EmptyRecycleBin)
	protected.DELETE("/documents/recycle-bin/:id", documentHandler.PermanentDelete)
	protected.POST("/documents/batch-delete", documentHandler.BatchDelete)
	protected.POST("/documents/batch-restore", documentHandler.BatchRestore)
	protected.POST("/documents/batch-reprocess", documentHandler.BatchReprocess)
	protected.POST("/documents", documentHandler.UploadGlobal)
	protected.GET("/documents/:id", documentHandler.Get)
	protected.GET("/documents/:id/download", documentHandler.Download)
	protected.GET("/documents/:id/preview", documentHandler.Preview)
	protected.GET("/documents/:id/editable-text", documentHandler.EditableText)
	protected.POST("/documents/:id/text-revisions", documentHandler.SaveTextRevision)
	protected.GET("/documents/:id/ocr-correction", documentHandler.PDFCorrection)
	protected.POST("/documents/:id/ocr-corrections", documentHandler.SavePDFCorrection)
	protected.GET("/documents/:id/versions", documentHandler.Versions)
	protected.GET("/documents/:id/compare", documentHandler.Compare)
	protected.DELETE("/documents/:id", documentHandler.Delete)
	protected.PUT("/documents/:id", documentHandler.Update)
	protected.POST("/documents/:id/cancel", documentHandler.Cancel)
	protected.POST("/documents/:id/restore", documentHandler.Restore)
	protected.POST("/documents/:id/reprocess", documentHandler.Reprocess)
	protected.POST("/documents/:id/replace", documentHandler.Replace)
	protected.GET("/documents/:id/chunks", documentHandler.Chunks)
	protected.POST("/chat/sessions", chatHandler.CreateSession)
	protected.GET("/chat/sessions", chatHandler.ListSessions)
	protected.GET("/chat/messages/search", chatHandler.SearchMessages)
	protected.GET("/chat/bookmarks", chatHandler.ListBookmarks)
	protected.GET("/chat/templates", chatHandler.ListQuestionTemplates)
	protected.POST("/chat/templates", chatHandler.SaveQuestionTemplate)
	protected.PUT("/chat/templates/:templateId", chatHandler.SaveQuestionTemplate)
	protected.DELETE("/chat/templates/:templateId", chatHandler.DeleteQuestionTemplate)
	protected.PUT("/chat/messages/:messageId/bookmark", chatHandler.SaveBookmark)
	protected.DELETE("/chat/messages/:messageId/bookmark", chatHandler.DeleteBookmark)
	protected.GET("/chat/sessions/recycle-bin", chatHandler.ListRecycleBin)
	protected.POST("/chat/sessions/recycle-bin/empty", chatHandler.EmptyRecycleBin)
	protected.DELETE("/chat/sessions/recycle-bin/:id", chatHandler.PermanentDeleteSession)
	protected.GET("/chat/sessions/:id", chatHandler.GetSession)
	protected.GET("/chat/sessions/:id/quality-issue", chatHandler.QualityIssue)
	protected.PUT("/chat/sessions/:id/quality-issue", chatHandler.SaveQualityIssue)
	protected.POST("/chat/sessions/:id/branches", chatHandler.CreateBranch)
	protected.PUT("/chat/sessions/:id", chatHandler.UpdateSession)
	protected.DELETE("/chat/sessions/:id", chatHandler.DeleteSession)
	protected.POST("/chat/sessions/:id/archive", chatHandler.ArchiveSession)
	protected.POST("/chat/sessions/:id/restore", chatHandler.RestoreSession)
	protected.POST("/chat/sessions/:id/unarchive", chatHandler.UnarchiveSession)
	protected.GET("/chat/sessions/:id/messages", chatHandler.ListMessages)
	registerChatWriteRoute(protected, "/chat/sessions/:id/messages", chatRateLimit, chatHandler.SendMessage)
	registerChatWriteRoute(protected, "/chat/sessions/:id/messages/stream", chatRateLimit, chatHandler.SendMessageStream)
	// Editing regenerates the answer, so it spends model tokens like a send and
	// shares the same per-user window.
	registerChatEditRoute(protected, "/chat/sessions/:id/messages/:messageId/edit", chatRateLimit, chatHandler.EditMessage)
	registerChatWriteRoute(protected, "/chat/sessions/:id/messages/:messageId/regenerate", chatRateLimit, chatHandler.RegenerateMessage)
	protected.GET("/chat/sessions/:id/export", chatHandler.ExportSession)
	protected.POST("/chat/messages/:messageId/feedback", chatHandler.SetMessageFeedback)
	protected.GET("/chat/quality/overview", chatHandler.QualityOverview)
	protected.GET("/chat/quality/usage", chatHandler.Usage)
	protected.GET("/chat/quality/negative-feedback", chatHandler.ListNegativeFeedback)
	protected.GET("/chat/quality/knowledge-gaps", chatHandler.ListKnowledgeGaps)
	protected.GET("/knowledge-bases/:id/evaluation-cases", evaluationHandler.ListCases)
	protected.POST("/knowledge-bases/:id/evaluation-cases", evaluationHandler.SaveCase)
	protected.PUT("/knowledge-bases/:id/evaluation-cases/:caseId", evaluationHandler.SaveCase)
	protected.DELETE("/knowledge-bases/:id/evaluation-cases/:caseId", evaluationHandler.DeleteCase)
	protected.GET("/knowledge-bases/:id/evaluation-runs", evaluationHandler.ListRuns)
	protected.POST("/knowledge-bases/:id/evaluation-runs", evaluationHandler.CreateRun)
	protected.GET("/knowledge-bases/:id/evaluation-runs/:runId", evaluationHandler.GetRun)
	protected.POST("/knowledge-bases/:id/evaluation-runs/:runId/cancel", evaluationHandler.CancelRun)
	protected.GET("/search", globalSearchHandler.Search)
	protected.GET("/search/suggest", globalSearchHandler.Suggest)
	protected.GET("/search/export", globalSearchHandler.Export)

	return r
}

func registerChatWriteRoute(group *gin.RouterGroup, path string, rateLimit gin.HandlerFunc, handler gin.HandlerFunc) {
	if rateLimit == nil {
		group.POST(path, handler)
		return
	}
	group.POST(path, rateLimit, handler)
}

func registerChatEditRoute(group *gin.RouterGroup, path string, rateLimit gin.HandlerFunc, handler gin.HandlerFunc) {
	if rateLimit == nil {
		group.PUT(path, handler)
		return
	}
	group.PUT(path, rateLimit, handler)
}

func newRerankProvider(cfg config.Config) rerank.Provider {
	if !cfg.RerankEnabled {
		return rerank.NewDisabledProvider()
	}
	return rerankprovider.NewOpenAICompatibleProvider(cfg)
}

// redisProbe adapts the go-redis client to the service's plain pinger, keeping
// the redis package out of the service layer.
type redisProbe struct {
	client redisPinger
}

func (p *redisProbe) Ping(ctx context.Context) error {
	return p.client.Ping(ctx).Err()
}

// storageProbe adapts the optional storage.CheckHealth capability.
type storageProbe struct {
	fileStorage storage.Storage
}

func (p *storageProbe) CheckHealth(ctx context.Context) error {
	return storage.CheckHealth(ctx, p.fileStorage)
}
