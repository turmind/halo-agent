package exec

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/turmind/halo-agent/packages/node-go/internal/jsv"
)

func writeString(full, content string) error {
	f, err := os.OpenFile(full, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o666)
	if err != nil {
		return jsv.FsError(unwrapPathErr(err), "open", full)
	}
	_, werr := f.WriteString(content)
	cerr := f.Close()
	if werr != nil {
		return jsv.FsError(unwrapPathErr(werr), "write", "")
	}
	if cerr != nil {
		return jsv.FsError(unwrapPathErr(cerr), "close", "")
	}
	return nil
}

// toUint8 is a Uint8Array element store: NaN / ±Inf → 0, else truncate, mod 256.
func toUint8(f float64) byte {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0
	}
	return byte(int64(math.Mod(math.Trunc(f), 256)) & 0xff)
}

// describe is Node's ERR_INVALID_ARG_TYPE "Received …" tail.
func describe(v any) string {
	switch x := v.(type) {
	case jsv.Undef:
		return "undefined"
	case nil:
		return "null"
	case float64:
		return fmt.Sprintf("type number (%s)", jsv.NumberToString(x))
	case bool:
		return fmt.Sprintf("type boolean (%t)", x)
	case string:
		return fmt.Sprintf("type string (%s)", jsv.Stringify(x))
	case []any:
		return "an instance of Array"
	}
	return "an instance of Object"
}

// file_write (sandboxWriteFile at full access).
func (e *Executor) write(full, placed string, args map[string]any) (string, error) {
	if err := mkdirp(filepath.Dir(full)); err != nil {
		return "", err
	}
	switch c := jsv.Get(args, "content").(type) {
	case string:
		if err := writeString(full, c); err != nil {
			return "", err
		}
	case []any:
		// Node writes an iterable chunk by chunk (Buffer.from(chunk)): a string
		// as UTF-8, an array as bytes (ToUint8 of each element); any other chunk
		// throws after the earlier ones landed. Plain-object chunks (array-like
		// / {type:'Buffer'}) are not replicated (D5).
		var sb strings.Builder
		var bad any = jsv.Undefined
		for _, el := range c {
			if s, ok := el.(string); ok {
				sb.WriteString(s)
				continue
			}
			arr, ok := el.([]any)
			if !ok {
				bad = el
				break
			}
			for _, x := range arr {
				sb.WriteByte(toUint8(jsv.ToNumber(x)))
			}
		}
		if err := writeString(full, sb.String()); err != nil {
			return "", err
		}
		if _, isUndef := bad.(jsv.Undef); !isUndef {
			return "", errors.New("The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received " + describe(bad))
		}
	default:
		return "", errors.New(`The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ` + describe(c))
	}
	return "File written: " + placed, nil
}

// file_edit.
func (e *Executor) edit(full, placed string, args map[string]any) (string, error) {
	oldV, newV := jsv.Get(args, "old_string"), jsv.Get(args, "new_string")
	if s, ok := oldV.(string); ok && s == "" {
		return toolWarn + "\nError: old_string is empty. Provide the exact text to replace.", nil
	}
	if jsv.StrictEqual(oldV, newV) {
		return toolWarn + "\nError: old_string and new_string are identical — nothing to change.", nil
	}
	content, err := readFile(full)
	if err != nil {
		return "", err
	}
	old := jsv.ToString(oldV)
	first := strings.Index(content, old)
	if first < 0 {
		return toolWarn + "\nError: old_string not found in " + placed + ". Re-read the file to verify the exact bytes (whitespace / line endings / indentation).", nil
	}
	replaceAll := jsv.Truthy(jsv.Get(args, "replace_all"))
	if !replaceAll {
		// TS: indexOf(old, first + input.old_string.length) — `.length` of the
		// raw arg: an array's element count, undefined (→ NaN → from 0, so a
		// second hit always) for numbers / booleans / objects, a throw on null.
		from := -1
		switch x := oldV.(type) {
		case string:
			from = first + len(old)
		case []any:
			from = jsv.ByteOffset16(content, jsv.Len16(content[:first])+len(x))
		case nil:
			return "", errors.New("Cannot read properties of null (reading 'length')")
		case jsv.Undef:
			return "", errors.New("Cannot read properties of undefined (reading 'length')")
		default:
			from = 0
		}
		if strings.Contains(content[from:], old) {
			return toolWarn + "\nError: old_string appears more than once in " + placed + ". Either expand it with surrounding context until it's unique, or pass replace_all: true.", nil
		}
	}
	var out string
	if replaceAll {
		sep := jsv.ToString(newV)
		if _, u := newV.(jsv.Undef); u {
			sep = "," // content.split(old).join(undefined) joins with ","
		}
		out = strings.Join(strings.Split(content, old), sep)
	} else {
		out = strings.Replace(content, old, jsv.ToString(newV), 1)
	}
	if err := mkdirp(filepath.Dir(full)); err != nil {
		return "", err
	}
	if err := writeString(full, out); err != nil {
		return "", err
	}
	return "File edited: " + placed, nil
}

// file_list.
func (e *Executor) list(ctx context.Context, full string, args map[string]any) (string, error) {
	recursive := jsv.Get(args, "recursive") == true
	if !recursive {
		entries, err := os.ReadDir(full)
		if err != nil {
			return "", jsv.FsError(unwrapPathErr(err), "scandir", full)
		}
		var out []string
		for _, en := range entries {
			name := jsv.Decode([]byte(en.Name()))
			if name == "node_modules" || name == ".git" {
				continue
			}
			if en.IsDir() {
				out = append(out, "📁 "+name)
			} else {
				out = append(out, "📄 "+name)
			}
		}
		return strings.Join(out, "\n"), nil
	}
	const listCap = 500
	var out []string
	truncated := false
	var walk func(dir, prefix string) bool
	walk = func(dir, prefix string) bool {
		if len(out) >= listCap {
			truncated = true
			return false
		}
		if ctx.Err() != nil {
			return false
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return true
		}
		for _, en := range entries {
			raw := en.Name()
			name := jsv.Decode([]byte(raw))
			if name == "node_modules" || name == ".git" {
				continue
			}
			if len(out) >= listCap {
				truncated = true
				return false
			}
			rel := name
			if prefix != "" {
				rel = prefix + "/" + name
			}
			if en.IsDir() {
				out = append(out, "📁 "+rel+"/")
				// Node re-reads the dir by its decoded name: an invalid UTF-8
				// name fails to open, so it is listed but not entered.
				if utf8.ValidString(raw) && !walk(filepath.Join(dir, raw), rel) {
					return false
				}
			} else {
				out = append(out, "📄 "+rel)
			}
		}
		return true
	}
	walk(full, "")
	if truncated {
		out = append(out, fmt.Sprintf("… [truncated at %d entries — use glob with a more specific pattern]", listCap))
	}
	return strings.Join(out, "\n"), nil
}
