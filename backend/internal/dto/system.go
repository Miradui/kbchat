package dto

type SystemUploadCapabilities struct {
	MaxFileBytes      int64    `json:"maxFileBytes"`
	AllowedExtensions []string `json:"allowedExtensions"`
}

type SystemRetrievalCapabilities struct {
	MaxVectorTopN int `json:"maxVectorTopN"`
	MaxRerankTopK int `json:"maxRerankTopK"`
}

type SystemAccountCapabilities struct {
	MinPasswordLength    int `json:"minPasswordLength"`
	MaxPasswordBytes     int `json:"maxPasswordBytes"`
	MaxDisplayNameLength int `json:"maxDisplayNameLength"`
	MaxAvatarURLLength   int `json:"maxAvatarUrlLength"`
}

// SystemCapabilitiesResponse mirrors the server-side limits the frontend used to
// hardcode. Every value comes from the same constant or config entry the request
// path enforces, so the two cannot drift.
type SystemCapabilitiesResponse struct {
	RerankEnabled bool                        `json:"rerankEnabled"`
	Upload        SystemUploadCapabilities    `json:"upload"`
	Retrieval     SystemRetrievalCapabilities `json:"retrieval"`
	Account       SystemAccountCapabilities   `json:"account"`
}
