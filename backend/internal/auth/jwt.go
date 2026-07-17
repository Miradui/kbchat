package auth

import (
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"rag/backend/internal/config"
)

type Claims struct {
	UserID string `json:"userId"`
	jwt.RegisteredClaims
}

func GenerateToken(cfg config.Config, userID uuid.UUID) (string, error) {
	secret, err := jwtSecret(cfg)
	if err != nil {
		return "", err
	}
	ttl, err := time.ParseDuration(cfg.JWTExpiresIn)
	if err != nil {
		ttl = 24 * time.Hour
	}

	claims := Claims{
		UserID: userID.String(),
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(ttl)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(secret)
}

func ParseToken(cfg config.Config, tokenString string) (*Claims, error) {
	secret, err := jwtSecret(cfg)
	if err != nil {
		return nil, err
	}
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method")
		}
		return secret, nil
	})
	if err != nil {
		return nil, err
	}

	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token")
	}

	return claims, nil
}

func jwtSecret(cfg config.Config) ([]byte, error) {
	if err := config.ValidateJWTSecret(cfg.JWTSecret); err != nil {
		return nil, err
	}
	return []byte(cfg.JWTSecret), nil
}
