package repository

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"kbchat/backend/internal/model"
)

type UserRepository struct {
	db *gorm.DB
}

var (
	ErrAdminUserNotFound  = errors.New("admin user not found")
	ErrAdminSelfMutation  = errors.New("cannot disable or demote yourself")
	ErrAdminLastAdmin     = errors.New("cannot remove the last administrator")
	ErrAdminInvalidStatus = errors.New("invalid user status")
	ErrAdminInvalidRole   = errors.New("invalid system role")
)

type AdminUserQuery struct {
	Query    string
	Status   string
	Role     string
	Page     int
	PageSize int
}

// ErrUserPasswordChanged means the password hash changed after the caller read
// and verified it, so a stale password update must not overwrite the winner.
var ErrUserPasswordChanged = errors.New("user password changed concurrently")

var ErrUserAvatarChanged = errors.New("user avatar changed concurrently")

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

// UsernameExistsFold reports whether any user has the given username ignoring
// case, so "Admin" cannot be created next to "admin". Stored case is preserved.
func (r *UserRepository) UsernameExistsFold(ctx context.Context, username string) (bool, error) {
	var count int64
	err := r.db.WithContext(ctx).Model(&model.User{}).Where("LOWER(username) = LOWER(?)", username).Count(&count).Error
	return count > 0, err
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

func (r *UserRepository) IsActive(ctx context.Context, id uuid.UUID) (bool, error) {
	var user model.User
	err := r.db.WithContext(ctx).Select("id", "status").First(&user, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		// A signed token whose account no longer exists is not a valid login.
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return user.Status == "" || user.Status == "active", nil
}

func (r *UserRepository) TouchLastLogin(ctx context.Context, id uuid.UUID, at time.Time) error {
	return r.db.WithContext(ctx).Model(&model.User{}).Where("id = ?", id).Update("last_login_at", at).Error
}

func (r *UserRepository) ListAdmin(ctx context.Context, query AdminUserQuery) ([]model.User, int64, error) {
	page, pageSize := query.Page, query.PageSize
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	db := r.db.WithContext(ctx).Model(&model.User{})
	if value := strings.TrimSpace(strings.ToLower(query.Query)); value != "" {
		like := "%" + value + "%"
		db = db.Where("LOWER(username) LIKE ? OR LOWER(display_name) LIKE ?", like, like)
	}
	if query.Status == "active" || query.Status == "disabled" {
		db = db.Where("status = ?", query.Status)
	}
	if query.Role == model.SystemRoleUser || query.Role == model.SystemRoleAdmin {
		db = db.Where("role = ?", query.Role)
	}
	var total int64
	if err := db.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var users []model.User
	err := db.Order("created_at desc, id desc").Offset((page - 1) * pageSize).Limit(pageSize).Find(&users).Error
	return users, total, err
}

func (r *UserRepository) CreateAdminUser(ctx context.Context, user *model.User) error {
	return r.db.WithContext(ctx).Create(user).Error
}

func (r *UserRepository) UpdateAdminProfile(ctx context.Context, id uuid.UUID, displayName, status string) (*model.User, error) {
	var user model.User
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := lockAdminMutations(tx); err != nil {
			return err
		}
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&user, "id = ?", id).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrAdminUserNotFound
			}
			return err
		}
		if status != "active" && status != "disabled" {
			return ErrAdminInvalidStatus
		}
		if user.Role == model.SystemRoleAdmin && status == "disabled" && userIsActive(user) {
			others, err := countOtherActiveAdmins(tx, user.ID)
			if err != nil {
				return err
			}
			if others == 0 {
				return ErrAdminLastAdmin
			}
		}
		if err := tx.Model(&user).Updates(map[string]any{"display_name": displayName, "status": status, "updated_at": time.Now()}).Error; err != nil {
			return err
		}
		return tx.First(&user, "id = ?", id).Error
	})
	return &user, err
}

func (r *UserRepository) ResetAdminPassword(ctx context.Context, id uuid.UUID, passwordHash string) (*model.User, error) {
	var user model.User
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&user, "id = ?", id).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrAdminUserNotFound
			}
			return err
		}
		if err := tx.Model(&user).Updates(map[string]any{"password_hash": passwordHash, "updated_at": time.Now()}).Error; err != nil {
			return err
		}
		return tx.First(&user, "id = ?", id).Error
	})
	return &user, err
}

func (r *UserRepository) UpdateAdminRole(ctx context.Context, actorID, targetID uuid.UUID, role string) (*model.User, error) {
	var user model.User
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if role != model.SystemRoleUser && role != model.SystemRoleAdmin {
			return ErrAdminInvalidRole
		}
		if actorID == targetID {
			return ErrAdminSelfMutation
		}
		if err := lockAdminMutations(tx); err != nil {
			return err
		}
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&user, "id = ?", targetID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrAdminUserNotFound
			}
			return err
		}
		if user.Role == model.SystemRoleAdmin && role == model.SystemRoleUser && userIsActive(user) {
			others, err := countOtherActiveAdmins(tx, user.ID)
			if err != nil {
				return err
			}
			if others == 0 {
				return ErrAdminLastAdmin
			}
		}
		if err := tx.Model(&user).Updates(map[string]any{"role": role, "updated_at": time.Now()}).Error; err != nil {
			return err
		}
		return tx.First(&user, "id = ?", targetID).Error
	})
	return &user, err
}

// adminMutationLockKey is the transaction-scoped advisory lock that serializes
// every operation able to remove the last active administrator.
const adminMutationLockKey int64 = 0x52414741444C4153

// lockAdminMutations serializes the last-admin decision across transactions.
//
// Locking only the target row leaves a write-skew window: two administrators
// disabling or demoting each other lock different rows, both read the other as
// still active, and both commit, leaving role='admin' AND status='active' empty.
// That locks every operator endpoint out and the CLI cannot recover it either.
// PostgreSQL has no predicate lock for the count, so the decision itself is
// serialized. SQLite tests are single-writer and skip it, matching
// BootstrapSystemAdmin.
func lockAdminMutations(tx *gorm.DB) error {
	if tx.Dialector.Name() != "postgres" {
		return nil
	}
	return tx.Exec("SELECT pg_advisory_xact_lock(?)", adminMutationLockKey).Error
}

// userIsActive treats the legacy empty status as active, matching IsActive.
func userIsActive(user model.User) bool {
	return user.Status == "" || user.Status == "active"
}

// countOtherActiveAdmins counts active administrators other than the target so
// last-admin protection is decided by who would remain, not by who exists now.
func countOtherActiveAdmins(tx *gorm.DB, excluding uuid.UUID) (int64, error) {
	var count int64
	err := tx.Model(&model.User{}).
		Where("role = ? AND (status = ? OR status = '' OR status IS NULL) AND id <> ?", model.SystemRoleAdmin, "active", excluding).
		Count(&count).Error
	return count, err
}

func (r *UserRepository) CountActiveAdmins(ctx context.Context) (int64, error) {
	var count int64
	err := r.db.WithContext(ctx).Model(&model.User{}).Where("role = ? AND status = ?", model.SystemRoleAdmin, "active").Count(&count).Error
	return count, err
}

// UpdateProfile writes presentation fields only. It intentionally accepts
// scalar values rather than a User snapshot so a stale profile form cannot
// restore an older password hash.
func (r *UserRepository) UpdateProfile(ctx context.Context, userID uuid.UUID, displayName string, avatarURL *string) error {
	values := map[string]any{"display_name": displayName, "updated_at": time.Now()}
	if avatarURL != nil {
		values["avatar_url"] = *avatarURL
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		result := tx.Model(&model.User{}).Where("id = ?", userID).Updates(values)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		if avatarURL != nil {
			// The user update locks the row before this check, serializing profile
			// writes with avatar replacement. A stale URL rolls back both fields.
			prefix := "/api/v1/users/" + userID.String() + "/avatar?v="
			if strings.HasPrefix(*avatarURL, prefix) {
				version, err := uuid.Parse(strings.TrimPrefix(*avatarURL, prefix))
				if err != nil {
					return err
				}
				var count int64
				if err := tx.Model(&model.UserAvatar{}).Where("user_id = ? AND version = ?", userID, version).Count(&count).Error; err != nil {
					return err
				}
				if count != 1 {
					return ErrUserAvatarChanged
				}
				return nil
			}
			return tx.Where("user_id = ?", userID).Delete(&model.UserAvatar{}).Error
		}
		return nil
	})
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
	db := r.db.WithContext(ctx).Model(&model.User{}).
		// Disabled accounts cannot sign in, so they must not be offered as new members.
		Where("status <> ?", "disabled")
	if query != "" {
		like := "%" + query + "%"
		db = db.Where("LOWER(username) LIKE ? OR LOWER(display_name) LIKE ?", like, like)
	}

	var users []model.User
	err := db.Order("username asc").Limit(limit).Find(&users).Error
	return users, err
}
