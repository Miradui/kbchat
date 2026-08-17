package service

// ExportFile is a fully rendered download returned by a service to its handler.
// Keeping HTTP headers out of services preserves the handler/service boundary.
type ExportFile struct {
	Filename    string
	ContentType string
	Content     []byte
}
