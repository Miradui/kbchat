package auth

import "golang.org/x/crypto/bcrypt"

// MaxPasswordBytes is bcrypt's hard input limit. It is a byte limit, not a
// Unicode character limit, so every password creation path must check the UTF-8
// encoded size before hashing.
const MaxPasswordBytes = 72

func ValidatePasswordBytes(password string) error {
	if len([]byte(password)) > MaxPasswordBytes {
		return bcrypt.ErrPasswordTooLong
	}
	return nil
}

func HashPassword(password string) (string, error) {
	if err := ValidatePasswordBytes(password); err != nil {
		return "", err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	return string(hash), err
}

func CheckPassword(hash, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}
