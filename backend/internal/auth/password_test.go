package auth

import (
	"errors"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestHashPasswordMatchesBcryptUTF8ByteBoundary(t *testing.T) {
	tests := []struct {
		name     string
		password string
		wantErr  bool
	}{
		{name: "72 ASCII bytes", password: strings.Repeat("a", 72)},
		{name: "73 ASCII bytes", password: strings.Repeat("a", 73), wantErr: true},
		{name: "24 Chinese characters are 72 bytes", password: strings.Repeat("界", 24)},
		{name: "25 Chinese characters are 75 bytes", password: strings.Repeat("界", 25), wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hash, err := HashPassword(tt.password)
			if tt.wantErr {
				if !errors.Is(err, bcrypt.ErrPasswordTooLong) {
					t.Fatalf("expected bcrypt.ErrPasswordTooLong, got hash=%q err=%v", hash, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("hash password: %v", err)
			}
			if !CheckPassword(hash, tt.password) {
				t.Fatal("expected the boundary password to verify")
			}
		})
	}
}
