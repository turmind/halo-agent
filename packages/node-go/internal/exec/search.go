package exec

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/turmind/halo-agent/packages/node-go/internal/jsregex"
	"github.com/turmind/halo-agent/packages/node-go/internal/jsv"
	"github.com/turmind/halo-agent/packages/node-go/internal/nodepath"
)

var (
	skipDirs     = map[string]bool{"node_modules": true, ".git": true, ".next": true, "dist": true}
	skipHaloDirs = map[string]bool{"sessions": true, "logs": true, "evo": true, "tmp": true, "assets": true, "canvas": true}
)

const (
	globMax        = 5000
	grepDefaultMax = 50
)

// walk is workspace-tools.ts walkDir: lstat, symlinks never followed.
// fn returns false to stop.
func walk(ctx context.Context, dir string, fn func(string) bool) bool {
	if ctx.Err() != nil {
		return false
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return true
	}
	for _, en := range entries {
		if ctx.Err() != nil {
			return false
		}
		name := en.Name()
		if skipDirs[name] {
			continue
		}
		if !utf8.ValidString(name) { // Node decodes it to U+FFFD, then lstat fails
			continue
		}
		full := filepath.Join(dir, name)
		st, err := os.Lstat(full)
		if err != nil {
			continue
		}
		switch {
		case st.IsDir():
			if filepath.Base(dir) == ".halo" && skipHaloDirs[name] {
				continue
			}
			if !walk(ctx, full, fn) {
				return false
			}
		case st.Mode().IsRegular():
			if !fn(full) {
				return false
			}
		}
	}
	return true
}

// compileAll compiles generated include / glob regexes once (nil = invalid → no match).
func compileAll(srcs []string) []*jsregex.Regexp {
	res := make([]*jsregex.Regexp, len(srcs))
	for i, src := range srcs {
		res[i], _ = jsregex.Compile(src)
	}
	return res
}

// matchAny is matchInclude / matchGlob's `try { new RegExp(src).test(s) } catch { false }`;
// a timeout / engine error (D10) is returned instead, to abort the whole call.
func matchAny(res []*jsregex.Regexp, s string) (bool, error) {
	for _, re := range res {
		if re == nil {
			continue
		}
		if ok, err := re.Test(s); ok || err != nil {
			return ok, err
		}
	}
	return false, nil
}

// matchFailed: the error a failed test() aborts grep / glob with.
func matchFailed(err error, at string) error {
	if err == jsregex.ErrTimeout {
		return fmt.Errorf("regex match timed out after %v on %s — call aborted (catastrophic backtracking: simplify the pattern)", jsregex.MatchTimeout, at)
	}
	return fmt.Errorf("%v on %s — call aborted", err, at)
}

var braceRe = regexp.MustCompile(`\{([^}]+)\}`)

func braces(s string) string {
	return braceRe.ReplaceAllStringFunc(s, func(m string) string {
		return "(" + strings.ReplaceAll(m[1:len(m)-1], ",", "|") + ")"
	})
}

// splitIncludeList: `for (const ch of include)` — a string by code point, an
// array (off-schema, but a model may send one) by whole element, where only an
// element that is exactly the string "{" / "}" / "," is structural.
func splitInclude(include any) []string {
	var chars []any
	switch v := include.(type) {
	case string:
		for _, r := range v {
			chars = append(chars, string(r))
		}
	case []any:
		chars = v
	}
	var parts []string
	depth := 0
	var cur strings.Builder
	for _, el := range chars {
		ch, _ := el.(string)
		switch {
		case ch == "{":
			depth++
			cur.WriteString(ch)
		case ch == "}":
			depth = max(0, depth-1)
			cur.WriteString(ch)
		case ch == "," && depth == 0:
			parts = append(parts, cur.String())
			cur.Reset()
		default:
			cur.WriteString(jsv.ToString(el))
		}
	}
	parts = append(parts, cur.String())
	var out []string
	for _, p := range parts {
		if p = jsv.Trim(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func includeRegex(p string) string {
	p = strings.ReplaceAll(p, ".", `\.`)
	p = strings.ReplaceAll(p, "**", "__GLOBSTAR__")
	p = strings.ReplaceAll(p, "*", "[^/]*")
	p = strings.ReplaceAll(p, "__GLOBSTAR__", ".*")
	return "^" + braces(p) + "$"
}

func globRegex(p string) string {
	p = strings.ReplaceAll(p, `\`, "/")
	p = strings.ReplaceAll(p, ".", `\.`)
	p = strings.ReplaceAll(p, "**/", "__GLOBSTAR_SLASH__")
	p = strings.ReplaceAll(p, "**", "__GLOBSTAR__")
	p = strings.ReplaceAll(p, "*", "[^/]*")
	p = strings.ReplaceAll(p, "__GLOBSTAR_SLASH__", "(.+/)?")
	p = strings.ReplaceAll(p, "__GLOBSTAR__", ".*")
	return "^" + braces(p) + "$"
}

func isBinary(p string) bool {
	f, err := os.Open(p)
	if err != nil {
		return true
	}
	defer f.Close()
	buf := make([]byte, 512)
	n, _ := f.Read(buf)
	for _, b := range buf[:n] {
		if b == 0 {
			return true
		}
	}
	return false
}

// grep.
func (e *Executor) grep(ctx context.Context, searchDir string, args map[string]any) (string, error) {
	maxV := jsv.Get(args, "max_results")
	maxN := float64(grepDefaultMax)
	if !jsv.IsNullish(maxV) {
		maxN = jsv.ToNumber(maxV) // NaN: `len >= NaN` is never true → no cap
	}
	patV := jsv.Get(args, "pattern")
	src := ""
	if _, u := patV.(jsv.Undef); !u {
		src = jsv.ToString(patV) // RegExp(undefined) is the empty regex
	}
	re, err := jsregex.Compile(src)
	if err != nil {
		return toolWarn + "\nError: Invalid regex pattern: " + err.Error(), nil
	}
	includeV := jsv.Get(args, "include")
	_, includeIsStr := includeV.(string)
	_, includeIsArr := includeV.([]any)
	useInclude := jsv.Truthy(includeV)
	var includeRes []*jsregex.Regexp
	if useInclude {
		var srcs []string
		for _, part := range splitInclude(includeV) {
			srcs = append(srcs, includeRegex(part))
		}
		includeRes = compileAll(srcs)
	}

	var results []string
	var thrown error
	visit := func(file string) bool {
		if float64(len(results)) >= maxN {
			return false
		}
		if useInclude {
			if !includeIsStr && !includeIsArr {
				thrown = errors.New("include is not iterable")
				return false
			}
			hit, err := matchAny(includeRes, filepath.Base(file))
			if err != nil {
				thrown = matchFailed(err, nodepath.Rel(e.s.Base, file))
				return false
			}
			if !hit {
				return true
			}
		}
		if isBinary(file) {
			return true
		}
		content, err := readFile(file) // TS: sandboxReadFile in a try → continue
		if err != nil {
			return true
		}
		rel := nodepath.Rel(e.s.Base, file)
		for i, line := range strings.Split(content, "\n") {
			if float64(len(results)) >= maxN {
				break
			}
			if ctx.Err() != nil {
				return false
			}
			ok, err := re.Test(line)
			if err != nil {
				thrown = matchFailed(err, fmt.Sprintf("%s:%d", rel, i+1))
				return false
			}
			if ok {
				results = append(results, fmt.Sprintf("%s:%d:%s", rel, i+1, line))
			}
		}
		return true
	}
	if st, err := os.Stat(searchDir); err == nil && st.Mode().IsRegular() {
		visit(searchDir)
	} else {
		walk(ctx, searchDir, visit)
	}
	if thrown != nil {
		return "", thrown
	}
	if len(results) == 0 {
		return fmt.Sprintf("No matches found for pattern \"%s\"", jsv.ToString(patV)), nil
	}
	return strings.Join(results, "\n"), nil
}

var extRe = regexp.MustCompile(`(?i)\.[a-z0-9]+$`)

// glob.
func (e *Executor) glob(ctx context.Context, searchDir string, args map[string]any) (string, error) {
	patV := jsv.Get(args, "pattern")
	pattern, isStr := patV.(string)
	var globRes []*jsregex.Regexp
	if isStr {
		globRes = compileAll([]string{globRegex(pattern)})
	}
	var results []string
	var thrown error
	walk(ctx, searchDir, func(file string) bool {
		if len(results) >= globMax {
			return false
		}
		if !isStr {
			switch patV.(type) {
			case jsv.Undef:
				thrown = errors.New("Cannot read properties of undefined (reading 'replace')")
			case nil:
				thrown = errors.New("Cannot read properties of null (reading 'replace')")
			default:
				thrown = errors.New("pattern.replace is not a function")
			}
			return false
		}
		rel := nodepath.Rel(e.s.Base, file)
		ok, err := matchAny(globRes, strings.ReplaceAll(rel, `\`, "/"))
		if err != nil {
			thrown = matchFailed(err, rel)
			return false
		}
		if ok {
			results = append(results, rel)
		}
		return true
	})
	if thrown != nil {
		return "", thrown
	}
	sort.SliceStable(results, func(i, j int) bool { return jsv.Less16(results[i], results[j]) })
	if len(results) > 0 {
		return strings.Join(results, "\n"), nil
	}
	if !isStr {
		switch patV.(type) {
		case jsv.Undef:
			return "", errors.New("Cannot read properties of undefined (reading 'split')")
		case nil:
			return "", errors.New("Cannot read properties of null (reading 'split')")
		}
		return "", errors.New("input.pattern.split is not a function")
	}
	hint := ""
	segs := strings.Split(pattern, "/")
	if !strings.ContainsAny(pattern, "*?") && !extRe.MatchString(segs[len(segs)-1]) {
		hint = fmt.Sprintf(" (glob matches files, not directory names — if \"%s\" is a directory, try \"%s/**\" to list its files, or use the `file_list` tool)", pattern, strings.TrimRight(pattern, "/"))
	}
	return fmt.Sprintf("No files found matching pattern \"%s\"%s", pattern, hint), nil
}
