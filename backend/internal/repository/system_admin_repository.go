package repository

import (
	"context"
	"errors"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"kbchat/backend/internal/model"
)

var (
	ErrSystemAdminAlreadyInitialized = errors.New("system administrator already initialized")
	ErrBootstrapUserNotFound         = errors.New("bootstrap user not found")
	ErrBootstrapUserExists           = errors.New("bootstrap user already exists")
	ErrBootstrapUserRole             = errors.New("bootstrap user has an unsupported system role")
)

type SystemAdminBootstrapResult struct {
	User   model.User
	Action string
}

// BootstrapSystemAdmin grants the first system-admin role to an explicit target.
// A transaction lock serializes competing first-admin commands, including when
// the users table is empty. Existing account credentials and profile stay intact.
func (r *UserRepository) BootstrapSystemAdmin(ctx context.Context, username string, create *model.User) (*SystemAdminBootstrapResult, error) {
	result := &SystemAdminBootstrapResult{}
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if tx.Dialector.Name() == "postgres" {
			// Stable, transaction-scoped namespace for this bootstrap operation.
			if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", int64(0x52414741444D494E)).Error; err != nil {
				return err
			}
		}
		var user model.User
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("username = ?", username).First(&user).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		exists := err == nil
		if exists && user.Role == model.SystemRoleAdmin {
			result.User, result.Action = user, "unchanged"
			return nil
		}
		var admins int64
		if err := tx.Model(&model.User{}).Where("role = ?", model.SystemRoleAdmin).Count(&admins).Error; err != nil {
			return err
		}
		if admins != 0 {
			return ErrSystemAdminAlreadyInitialized
		}
		if !exists {
			if create == nil {
				return ErrBootstrapUserNotFound
			}
			user = *create
			user.Username, user.Role = username, model.SystemRoleAdmin
			if err := tx.Create(&user).Error; err != nil {
				return err
			}
			result.User, result.Action = user, "created"
			return nil
		}
		if create != nil {
			return ErrBootstrapUserExists
		}
		if user.Role != model.SystemRoleUser {
			return ErrBootstrapUserRole
		}
		if err := tx.Model(&user).Update("role", model.SystemRoleAdmin).Error; err != nil {
			return err
		}
		result.User, result.Action = user, "promoted"
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}
