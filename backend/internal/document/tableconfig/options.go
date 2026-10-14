package tableconfig

import (
	"encoding/json"
	"errors"
	"sort"
	"unicode/utf8"
)

var ErrInvalid = errors.New("invalid table import settings")

type Options struct {
	Sheets []Sheet `json:"sheets"`
}

type Sheet struct {
	Name string `json:"name"`
	// Zero selects the first nonempty record. Positive rows are physical rows.
	HeaderRow int `json:"headerRow"`
	// Nil selects all columns. An explicit list uses original one-based indices.
	Columns []int `json:"columns,omitempty"`
}

func Decode(data []byte) (*Options, error) {
	if len(data) == 0 || string(data) == "null" {
		return nil, nil
	}
	var result Options
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, ErrInvalid
	}
	return &result, nil
}

func Normalize(fileType string, input *Options) (*Options, error) {
	if input == nil {
		return nil, nil
	}
	if (fileType != "xlsx" && fileType != "csv") || len(input.Sheets) == 0 || len(input.Sheets) > 32 {
		return nil, ErrInvalid
	}
	result := &Options{Sheets: make([]Sheet, 0, len(input.Sheets))}
	names := map[string]bool{}
	for _, sheet := range input.Sheets {
		if names[sheet.Name] || utf8.RuneCountInString(sheet.Name) > 100 || sheet.HeaderRow < 0 || sheet.HeaderRow > 100000 {
			return nil, ErrInvalid
		}
		if (fileType == "csv" && (sheet.Name != "" || len(input.Sheets) != 1)) || (fileType == "xlsx" && sheet.Name == "") {
			return nil, ErrInvalid
		}
		names[sheet.Name] = true
		if sheet.Columns != nil {
			if len(sheet.Columns) == 0 || len(sheet.Columns) > 256 {
				return nil, ErrInvalid
			}
			sheet.Columns = append([]int(nil), sheet.Columns...)
			sort.Ints(sheet.Columns)
			for i, column := range sheet.Columns {
				if column < 1 || column > 256 || (i > 0 && column == sheet.Columns[i-1]) {
					return nil, ErrInvalid
				}
			}
		}
		result.Sheets = append(result.Sheets, sheet)
	}
	sort.Slice(result.Sheets, func(i, j int) bool { return result.Sheets[i].Name < result.Sheets[j].Name })
	return result, nil
}
