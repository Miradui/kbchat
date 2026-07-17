package router

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
	"gorm.io/gorm"

	"rag/backend/internal/config"
	"rag/backend/internal/handler"
	"rag/backend/internal/middleware"
	chatprovider "rag/backend/internal/provider/chat"
	embeddingprovider "rag/backend/internal/provider/embedding"
	rerankprovider "rag/backend/internal/provider/rerank"
	titleprovider "rag/backend/internal/provider/title"
	"rag/backend/internal/repository"
	"rag/backend/internal/rerank"
	"rag/backend/internal/retrieval"
	"rag/backend/internal/service"
	"rag/backend/internal/storage"
)

func New(cfg config.Config, db *gorm.DB, logger *zap.Logger) *gin.Engine {
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
	chunkRepo := repository.NewChunkRepository(db)
	chatRepo := repository.NewChatRepository(db)
	globalSearchRepo := repository.NewGlobalSearchRepository(db)
	localStorage := storage.NewLocalStorage(cfg.UploadDir)
	embedder := embeddingprovider.NewOpenAICompatibleProvider(cfg)
	reranker := newRerankProvider(cfg)
	chatProvider := chatprovider.NewOpenAICompatibleProvider(cfg)
	titleProvider := titleprovider.NewOpenAICompatibleProvider(cfg)
	authService := service.NewAuthService(cfg, userRepo)
	userService := service.NewUserService(userRepo)
	knowledgeBaseService := service.NewKnowledgeBaseService(knowledgeBaseRepo, knowledgeBaseCategoryRepo, knowledgeBaseFavoriteRepo, knowledgeBaseViewRepo, knowledgeBaseWorkspacePreferenceRepo, knowledgeBaseTagRepo, knowledgeBaseTagBindingRepo, knowledgeBaseMemberRepo, userRepo)
	knowledgeBaseCategoryService := service.NewKnowledgeBaseCategoryService(knowledgeBaseCategoryRepo, knowledgeBaseRepo)
	knowledgeBaseTagService := service.NewKnowledgeBaseTagService(knowledgeBaseTagRepo, knowledgeBaseTagBindingRepo)
	documentService := service.NewDocumentService(cfg, documentRepo, chunkRepo, knowledgeBaseRepo, localStorage)
	retrievalService := retrieval.NewService(cfg, chunkRepo, knowledgeBaseRepo, embedder, reranker)
	chatService := service.NewChatService(cfg, chatRepo, knowledgeBaseRepo, retrievalService, chatProvider, titleProvider)
	globalSearchService := service.NewGlobalSearchService(globalSearchRepo)
	authHandler := handler.NewAuthHandler(authService)
	userHandler := handler.NewUserHandler(userService)
	knowledgeBaseHandler := handler.NewKnowledgeBaseHandler(knowledgeBaseService)
	knowledgeBaseCategoryHandler := handler.NewKnowledgeBaseCategoryHandler(knowledgeBaseCategoryService)
	knowledgeBaseTagHandler := handler.NewKnowledgeBaseTagHandler(knowledgeBaseTagService)
	documentHandler := handler.NewDocumentHandler(documentService)
	searchHandler := handler.NewSearchHandler(retrievalService)
	chatHandler := handler.NewChatHandler(chatService)
	globalSearchHandler := handler.NewGlobalSearchHandler(globalSearchService)

	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(middleware.RequestLogger(logger))
	r.Use(middleware.CORS(cfg.CORSAllowedOrigins))

	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status": "ok",
			"env":    cfg.AppEnv,
		})
	})

	v1 := r.Group("/api/v1")
	v1.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status": "ok",
			"env":    cfg.AppEnv,
		})
	})

	authRoutes := v1.Group("/auth")
	authRoutes.POST("/login", authHandler.Login)

	protected := v1.Group("")
	protected.Use(middleware.AuthRequired(cfg))
	protected.GET("/auth/me", authHandler.Me)
	protected.POST("/auth/logout", authHandler.Logout)
	protected.GET("/users/search", userHandler.Search)
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
	protected.POST("/knowledge-bases/batch-delete", knowledgeBaseHandler.BatchDelete)
	protected.POST("/knowledge-bases/batch-restore", knowledgeBaseHandler.BatchRestore)
	protected.GET("/knowledge-bases/recycle-bin", knowledgeBaseHandler.ListRecycleBin)
	protected.POST("/knowledge-bases/recycle-bin/empty", knowledgeBaseHandler.EmptyRecycleBin)
	protected.DELETE("/knowledge-bases/recycle-bin/:id", knowledgeBaseHandler.PermanentDelete)
	protected.GET("/knowledge-bases/stats", knowledgeBaseHandler.Stats)
	protected.GET("/knowledge-bases/:id", knowledgeBaseHandler.Get)
	protected.PUT("/knowledge-bases/:id", knowledgeBaseHandler.Update)
	protected.DELETE("/knowledge-bases/:id", knowledgeBaseHandler.Delete)
	protected.GET("/knowledge-bases/:id/permissions", knowledgeBaseHandler.GetPermissions)
	protected.PUT("/knowledge-bases/:id/permissions", knowledgeBaseHandler.UpdatePermissions)
	protected.POST("/knowledge-bases/:id/members", knowledgeBaseHandler.AddMember)
	protected.PUT("/knowledge-bases/:id/members/:userId", knowledgeBaseHandler.UpdateMember)
	protected.DELETE("/knowledge-bases/:id/members/:userId", knowledgeBaseHandler.RemoveMember)
	protected.POST("/knowledge-bases/:id/restore", knowledgeBaseHandler.Restore)
	protected.POST("/knowledge-bases/:id/favorite", knowledgeBaseHandler.Favorite)
	protected.DELETE("/knowledge-bases/:id/favorite", knowledgeBaseHandler.Unfavorite)
	protected.POST("/knowledge-bases/:id/view", knowledgeBaseHandler.RecordView)
	protected.POST("/knowledge-bases/:id/search", searchHandler.Search)
	protected.POST("/knowledge-bases/:id/documents", documentHandler.Upload)
	protected.GET("/knowledge-bases/:id/documents", documentHandler.List)
	protected.GET("/documents", documentHandler.ListGlobal)
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
	protected.DELETE("/documents/:id", documentHandler.Delete)
	protected.POST("/documents/:id/restore", documentHandler.Restore)
	protected.POST("/documents/:id/reprocess", documentHandler.Reprocess)
	protected.GET("/documents/:id/chunks", documentHandler.Chunks)
	protected.POST("/chat/sessions", chatHandler.CreateSession)
	protected.GET("/chat/sessions", chatHandler.ListSessions)
	protected.GET("/chat/sessions/:id", chatHandler.GetSession)
	protected.PUT("/chat/sessions/:id", chatHandler.UpdateSession)
	protected.DELETE("/chat/sessions/:id", chatHandler.DeleteSession)
	protected.POST("/chat/sessions/:id/archive", chatHandler.ArchiveSession)
	protected.GET("/chat/sessions/:id/messages", chatHandler.ListMessages)
	protected.POST("/chat/sessions/:id/messages", chatHandler.SendMessage)
	protected.POST("/chat/sessions/:id/messages/:messageId/regenerate", chatHandler.RegenerateMessage)
	protected.GET("/search", globalSearchHandler.Search)

	return r
}

func newRerankProvider(cfg config.Config) rerank.Provider {
	if !cfg.RerankEnabled {
		return rerank.NewDisabledProvider()
	}
	return rerankprovider.NewOpenAICompatibleProvider(cfg)
}
