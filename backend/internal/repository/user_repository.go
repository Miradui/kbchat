package repository

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"kbchat/backend/internal/model"
)

type UserRepository struct {
	db *gorm.DB
}

// ErrUserPasswordChanged means the password hash changed after the caller read
// and verified it, so a stale password update must not overwrite the winner.
var ErrUserPasswordChanged = errors.New("user password changed concurrently")

func NewUserRepository(db *gorm.DB) *UserRepository {
	return &UserRepository{db: db}
}

func (r *UserRepository) FindByUsername(ctx context.Context, username string) (*model.User, error) {
	var user model.User
	err := r.db.WithContext(ctx).Where("username = ?", username).First(&user).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &user, err
}

func (r *UserRepository) FindByID(ctx context.Context, id uuid.UUID) (*model.User, error) {
	var user model.User
	err := r.db.WithContext(ctx).Where("id = ?", id).First(&user).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &user, err
}

func (r *UserRepository) Create(ctx context.Context, user *model.User) error {
	return r.db.WithContext(ctx).Create(user).Error
}

// UpdateProfile writes presentation fields only. It intentionally accepts
// scalar values rather than a User snapshot so a stale profile form cannot
// restore an older password hash.
func (r *UserRepository) UpdateProfile(ctx context.Context, userID uuid.UUID, displayName, avatarURL string) error {
	result := r.db.WithContext(ctx).
		Model(&model.User{}).
		Where("id = ?", userID).
		Updates(map[string]any{
			"display_name": displayName,
			"avatar_url":   avatarURL,
			"updated_at":   time.Now(),
		})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

// UpdatePassword writes only the password hash and compares the hash that the
// service verified. Profile fields are excluded, and a concurrent password
// change makes the compare-and-swap fail instead of overwriting the winner.
func (r *UserRepository) UpdatePassword(
	ctx context.Context,
	userID uuid.UUID,
	expectedPasswordHash string,
	passwordHash string,
) error {
	result := r.db.WithContext(ctx).
		Model(&model.User{}).
		Where("id = ? AND password_hash = ?", userID, expectedPasswordHash).
		Updates(map[string]any{
			"password_hash": passwordHash,
			"updated_at":    time.Now(),
		})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrUserPasswordChanged
	}
	return nil
}

func (r *UserRepository) Search(ctx context.Context, query string, limit int) ([]model.User, error) {
	query = strings.TrimSpace(strings.ToLower(query))
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	db := r.db.WithContext(ctx).Model(&model.User{})
	if query != "" {
		like := "%" + query + "%"
		db = db.Where("LOWER(username) LIKE ? OR LOWER(display_name) LIKE ?", like, like)
	}

	var users []model.User
	err := db.Order("username asc").Limit(limit).Find(&users).Error
	return users, err
}
