package service

import "kbchat/backend/internal/apperror"

func normalizeDocumentVersionPolicy(input *string, stored string) (string, error) {
	if input == nil {
		return storedDocumentVersionPolicy(stored), nil
	}
	if *input != "all" && *input != "current" {
		return "", apperror.Validation(map[string]any{"documentVersionPolicy": "版本检索范围须为 all 或 current"})
	}
	return *input, nil
}

func storedDocumentVersionPolicy(value string) string {
	if value == "current" {
		return value
	}
	return "all"
}
