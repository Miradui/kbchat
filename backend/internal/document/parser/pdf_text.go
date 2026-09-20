package parser

import (
	"fmt"
	"strings"

	"github.com/ledongthuc/pdf"
)

// Keep text-object order, as GetPlainText did, but emit layout separators as
// Unicode rather than decoding them through the active font. In subset fonts,
// byte 0x0A can map to a real Chinese glyph instead of a newline. Font resource
// names belong to each page and must not share a cache across pages.
func readPDFPageText(page pdf.Page) (text string, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			text = ""
			err = fmt.Errorf("decode PDF text: %v", recovered)
		}
	}()
	if page.V.IsNull() || page.V.Key("Contents").Kind() == pdf.Null {
		return "", nil
	}
	fonts := make(map[string]pdf.TextEncoding)
	for _, name := range page.Fonts() {
		font := page.Font(name)
		fonts[name] = font.Encoder()
	}
	var output strings.Builder
	var encoding pdf.TextEncoding
	lineBreak := func() { output.WriteByte('\n') }
	show := func(raw string) {
		if encoding != nil {
			raw = encoding.Decode(raw)
		}
		output.WriteString(raw)
	}
	pdf.Interpret(page.V.Key("Contents"), func(stack *pdf.Stack, op string) {
		args := make([]pdf.Value, stack.Len())
		for i := len(args) - 1; i >= 0; i-- {
			args[i] = stack.Pop()
		}
		require := func(count int) {
			if len(args) != count {
				panic(fmt.Sprintf("invalid %s operands", op))
			}
		}
		switch op {
		case "BT", "T*":
			lineBreak()
		case "Tf":
			require(2)
			encoding = fonts[args[0].Name()]
		case "Td", "TD":
			require(2)
			if args[1].Float64() != 0 {
				lineBreak()
			}
		case "Tj":
			require(1)
			show(args[0].RawString())
		case "'":
			require(1)
			lineBreak()
			show(args[0].RawString())
		case "\"":
			require(3)
			lineBreak()
			show(args[2].RawString())
		case "TJ":
			require(1)
			for i := 0; i < args[0].Len(); i++ {
				value := args[0].Index(i)
				if value.Kind() == pdf.String {
					show(value.RawString())
				}
			}
		}
	})
	return output.String(), nil
}
