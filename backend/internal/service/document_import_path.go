package service

import (
	"kbchat/backend/internal/apperror"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Provenance only; this value is never used as an object key or filesystem path.
func normalizeDocumentSourcePath(value, filename string) (string, error) {
	if value == "" {
		return "", nil
	}
	invalid := func() (string, error) {
		return "", apperror.Validation(map[string]any{"sourcePath": "来源路径须为有效相对路径，不能包含 ..、绝对路径或控制字符，最多 1024 字节"})
	}
	value = strings.ReplaceAll(value, `\`, "/")
	if !utf8.ValidString(value) || len(value) > 1024 || strings.HasPrefix(value, "/") || strings.Contains(value, ":") {
		return invalid()
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return invalid()
		}
	}
	parts := strings.Split(value, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || utf8.RuneCountInString(part) > 255 {
			return invalid()
		}
	}
	if parts[len(parts)-1] != filename {
		return "", apperror.Validation(map[string]any{"sourcePath": "来源路径的文件名须与上传文件一致"})
	}
	return value, nil
}
