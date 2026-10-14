//go:build !windows

package ocr

import "os/exec"

func configureCommand(_ *exec.Cmd) {}
