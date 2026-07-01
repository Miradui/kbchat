package apperror

import "net/http"

type Error struct {
	Status  int            `json:"-"`
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details"`
	Err     error          `json:"-"`
}

func (e *Error) Error() string {
	if e.Err != nil {
		return e.Err.Error()
	}
	return e.Message
}

func New(status int, code, message string) *Error {
	return &Error{
		Status:  status,
		Code:    code,
		Message: message,
		Details: map[string]any{},
	}
}

func Wrap(status int, code, message string, err error) *Error {
	e := New(status, code, message)
	e.Err = err
	return e
}

func Unauthorized() *Error {
	return New(http.StatusUnauthorized, "UNAUTHORIZED", "请先登录")
}

func Forbidden() *Error {
	return New(http.StatusForbidden, "FORBIDDEN", "无权限访问该资源")
}

func Validation(details map[string]any) *Error {
	e := New(http.StatusBadRequest, "VALIDATION_ERROR", "请求参数不合法")
	e.Details = details
	return e
}

func NotFound(code, message string) *Error {
	return New(http.StatusNotFound, code, message)
}

func Internal(err error) *Error {
	return Wrap(http.StatusInternalServerError, "INTERNAL_ERROR", "系统内部错误", err)
}
