package service

import (
	"kbchat/backend/internal/auth"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/retrieval"
)

type SystemService struct {
	cfg config.Config
}

func NewSystemService(cfg config.Config) *SystemService {
	return &SystemService{cfg: cfg}
}

// Capabilities reports the limits the request path already enforces: the upload
// allow list from validateFile, MAX_UPLOAD_SIZE_MB, the retrieval ceilings, and
// whether rerank is wired to a real provider.
func (s *SystemService) Capabilities() *dto.SystemCapabilitiesResponse {
	extensions := make([]string, len(AllowedDocumentExtensions))
	copy(extensions, AllowedDocumentExtensions)

	return &dto.SystemCapabilitiesResponse{
		RerankEnabled: s.cfg.RerankEnabled,
		Upload: dto.SystemUploadCapabilities{
			MaxFileBytes:      int64(s.cfg.MaxUploadSizeMB) * 1024 * 1024,
			AllowedExtensions: extensions,
		},
		Retrieval: dto.SystemRetrievalCapabilities{
			MaxVectorTopN: retrieval.MaxVectorTopN,
			MaxRerankTopK: retrieval.MaxRerankTopK,
		},
		Account: dto.SystemAccountCapabilities{
			MinPasswordLength:    MinPasswordLength,
			MaxPasswordBytes:     auth.MaxPasswordBytes,
			MaxDisplayNameLength: MaxDisplayNameLength,
			MaxAvatarURLLength:   MaxAvatarURLLength,
		},
	}
}
