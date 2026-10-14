// Package ocr runs local, bounded PDF rendering and text recognition. It never
// sends a document to a model or external service.
package ocr

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	_ "image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	ErrUnavailable = errors.New("PDF OCR tools or language data unavailable")
	ErrTimeout     = errors.New("PDF OCR time limit exceeded")
	ErrFailed      = errors.New("PDF OCR failed")
	ErrLimit       = errors.New("PDF OCR resource limit exceeded")
)

const MaxPageTextBytes = 128 * 1024

type PageRecognizer interface {
	Recognize(context.Context, string, int) (string, error)
}

type Config struct {
	TesseractPath string
	PDFToPPMPath  string
	TessdataDir   string
	Languages     string
	MaxImageSide  int
	PageTimeout   time.Duration
}

type Local struct{ config Config }

func NewLocal(config Config) *Local { return &Local{config: config} }

// Ready runs once per document, before rendering any missing-text page. Checking
// the actual language list also detects installations with missing shared libs.
func (l *Local) Ready(ctx context.Context) error {
	if _, err := exec.LookPath(l.config.PDFToPPMPath); err != nil {
		return fmt.Errorf("%w: pdftoppm", ErrUnavailable)
	}
	args := []string{"--list-langs"}
	if l.config.TessdataDir != "" {
		args = append(args, "--tessdata-dir", l.config.TessdataDir)
	}
	checkCtx, cancel := context.WithTimeout(ctx, min(l.config.PageTimeout, 10*time.Second))
	defer cancel()
	output, err := run(checkCtx, l.config.TesseractPath, args, 64*1024)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		return fmt.Errorf("%w: tesseract language check", ErrUnavailable)
	}
	available := map[string]bool{}
	for _, line := range strings.Split(string(output), "\n") {
		available[strings.TrimSpace(line)] = true
	}
	for _, language := range strings.Split(l.config.Languages, "+") {
		if !available[language] {
			return fmt.Errorf("%w: missing language %s", ErrUnavailable, language)
		}
	}
	return nil
}

func (l *Local) Recognize(ctx context.Context, path string, page int) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if page < 1 || l.config.MaxImageSide < 512 || l.config.MaxImageSide > 4096 || l.config.PageTimeout <= 0 {
		return "", ErrLimit
	}
	path, err := filepath.Abs(path)
	if err != nil {
		return "", ErrFailed
	}
	pageCtx, cancel := context.WithTimeout(ctx, l.config.PageTimeout)
	defer cancel()
	number := strconv.Itoa(page)
	// No shell, output prefix or user-controlled arguments. Poppler writes a
	// single PNG to stdout, capped both in pixels and in encoded bytes.
	png, err := run(pageCtx, l.config.PDFToPPMPath, []string{"-f", number, "-l", number, "-singlefile", "-scale-to", strconv.Itoa(l.config.MaxImageSide), "-gray", "-png", path}, 20*1024*1024)
	if err != nil {
		return "", pageError(ctx, pageCtx, "render", err)
	}
	dimensions, _, err := image.DecodeConfig(bytes.NewReader(png))
	if err != nil || dimensions.Width <= 0 || dimensions.Height <= 0 {
		return "", fmt.Errorf("%w: invalid rendered page", ErrFailed)
	}
	if dimensions.Width > l.config.MaxImageSide || dimensions.Height > l.config.MaxImageSide {
		return "", ErrLimit
	}
	directory, err := os.MkdirTemp("", "rag-pdf-ocr-*")
	if err != nil {
		return "", fmt.Errorf("%w: create temporary image", ErrFailed)
	}
	defer os.RemoveAll(directory)
	imagePath := filepath.Join(directory, "page.png")
	if err := os.WriteFile(imagePath, png, 0600); err != nil {
		return "", fmt.Errorf("%w: write temporary image", ErrFailed)
	}
	args := []string{imagePath, "stdout", "-l", l.config.Languages, "--psm", "3"}
	if l.config.TessdataDir != "" {
		args = append(args, "--tessdata-dir", l.config.TessdataDir)
	}
	content, err := run(pageCtx, l.config.TesseractPath, args, MaxPageTextBytes)
	if err != nil {
		return "", pageError(ctx, pageCtx, "recognize", err)
	}
	if !utf8.Valid(content) {
		return "", fmt.Errorf("%w: invalid recognized encoding", ErrFailed)
	}
	return strings.TrimSpace(string(content)), nil
}

func pageError(parent, page context.Context, stage string, err error) error {
	if parent.Err() != nil {
		return parent.Err()
	}
	if page.Err() != nil {
		return fmt.Errorf("%w: %s", ErrTimeout, stage)
	}
	return fmt.Errorf("%s: %w", stage, err)
}

type boundedOutput struct {
	buffer   bytes.Buffer
	limit    int
	exceeded bool
	cancel   context.CancelFunc
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	if len(p) > b.limit-b.buffer.Len() {
		b.exceeded = true
		b.cancel()
		return 0, ErrLimit
	}
	return b.buffer.Write(p)
}

func run(ctx context.Context, executable string, args []string, maxOutput int) ([]byte, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	path, err := exec.LookPath(executable)
	if err != nil {
		return nil, ErrUnavailable
	}
	commandCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stdout := &boundedOutput{limit: maxOutput, cancel: cancel}
	stderr := &boundedOutput{limit: 16 * 1024, cancel: cancel}
	cmd := exec.CommandContext(commandCtx, path, args...)
	configureCommand(cmd)
	cmd.Env = append(os.Environ(), "OMP_THREAD_LIMIT=1")
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.WaitDelay = time.Second
	err = cmd.Run()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if stdout.exceeded || stderr.exceeded {
		return nil, ErrLimit
	}
	if err != nil {
		// Neither document content nor native stderr is returned to an API.
		return nil, ErrFailed
	}
	return stdout.buffer.Bytes(), nil
}
