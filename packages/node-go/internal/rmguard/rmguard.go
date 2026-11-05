// Package rmguard is sandbox.ts assertRmSafe (the accidental-deletion guard
// shell_exec runs before every command): it rejects an `rm` / `rmdir` whose
// target is the filesystem root, $HOME, ~/.halo, the workspace root, any
// parent of those, or a system directory / its direct children. A heuristic
// for mistakes, not a parser — command substitution, eval and scripts aren't
// followed. Pure: nothing is executed and the filesystem isn't touched.
//
// Parity notes (testdata/vectors.json, generated from the TS, pins them):
//   - the command is walked byte by byte; every character the TS compares
//     against is ASCII, so copying UTF-8 bytes gives the same words as
//     copying UTF-16 code units;
//   - home / cwd are inserted literally after the unset-variable pass, so a
//     `$&` / `$X` inside them is just text.
package rmguard

import (
	"errors"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

var systemDirs = []string{
	"/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib32", "/lib64", "/libx32", "/media", "/mnt", "/opt",
	"/proc", "/run", "/sbin", "/snap", "/srv", "/sys", "/usr", "/var",
	"/Applications", "/Library", "/System", "/Users", "/Volumes", "/private",
}

// Protected themselves, but their children are ordinary scratch (/root is
// $HOME in containers; $HOME itself is covered separately).
var exactDirs = []string{"/tmp", "/private/tmp", "/root"}

// Words that can precede the real command in a simple command.
var wrappers = map[string]bool{
	"sudo": true, "command": true, "env": true, "xargs": true, "nohup": true, "time": true, "exec": true, "nice": true,
	"if": true, "then": true, "else": true, "elif": true, "do": true, "while": true, "until": true,
}

var (
	assignRe  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
	redirRe   = regexp.MustCompile(`^(\d*|&)?[<>]`)
	redirOpRe = regexp.MustCompile(`^(\d*|&)?[<>]+&?$`)
	homeRe    = regexp.MustCompile(`\$\{HOME\}|\$HOME\b`)
	pwdRe     = regexp.MustCompile("\\$\\{PWD\\}|\\$PWD\\b|\\$\\(pwd\\)|`pwd`")
	unsetRe   = regexp.MustCompile("\\$\\{[^}]*\\}|\\$\\([^)]*\\)|`[^`]*`|\\$[A-Za-z_][A-Za-z0-9_]*|\\$\\d")
	// /^<<(-?)\s*(['"]?)([A-Za-z0-9_.-]+)\2/: RE2 has no backreference, so \2
	// is spelled out per quote, and JS \s (RE2's is ASCII-only) as a class.
	// Leftmost-first picks what V8's backtracking picks — incl. re-reading the
	// `-` as the delimiter when the dashed form fails (`<<-'EOF` unclosed → "-").
	heredocRe = regexp.MustCompile(`^<<(-?)[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*(?:'([A-Za-z0-9_.-]+)'|"([A-Za-z0-9_.-]+)"|([A-Za-z0-9_.-]+))`)
)

// Check is assertRmSafe(cmd, cwd) with os.homedir() = home (~/.halo is
// home/.halo): nil, or the TS error text. Relative targets resolve against
// cwd, following any `cd` earlier in the same command line.
func Check(cmd, cwd, home string) error {
	haloHome := filepath.Join(home, ".halo")
	wsRoot := resolve("", cwd)
	// Glob-escaped (escapeGlob); a `cd` keeps the globs its own argument wrote.
	dir := escapeGlob(wsRoot)
	for _, words := range shellSegments(cmd) {
		i := 0
		name := ""
		for ; i < len(words); i++ {
			name = strings.TrimLeft(words[i], "({!")
			if name == "" || assignRe.MatchString(name) {
				continue
			}
			// filepath.Base differs from path.basename only for "/"-only names,
			// which match no wrapper / rm / rmdir either way.
			if wrappers[filepath.Base(name)] {
				for i+1 < len(words) && strings.HasPrefix(words[i+1], "-") {
					i++
				}
				continue
			}
			break
		}
		if i >= len(words) {
			continue
		}

		if name == "cd" {
			if i+1 >= len(words) {
				dir = escapeGlob(home)
			} else if dest := words[i+1]; dest != "-" {
				w := expandWord(stripSubshellClose(dest), dir, home)
				if w == "" {
					w = "."
				}
				dir = resolve(dir, w)
			}
			continue
		}
		if base := filepath.Base(name); base != "rm" && base != "rmdir" {
			continue
		}

		optionsDone := false
		for j := i + 1; j < len(words); j++ {
			raw := words[j]
			if !optionsDone && raw == "--" {
				optionsDone = true
				continue
			}
			if !optionsDone && strings.HasPrefix(raw, "-") {
				continue
			}
			// Redirections: `2>/dev/null` is one word; a bare `>` takes the next.
			if redirRe.MatchString(raw) {
				if redirOpRe.MatchString(raw) {
					j++
				}
				continue
			}
			word := expandWord(stripSubshellClose(raw), dir, home)
			if word == "" {
				continue
			}

			abs := resolve(dir, word)
			// A glob that means "everything in X" (`*`, `.*`, `**`) is judged by X;
			// narrower globs (`*.log`) are left alone.
			parts := strings.Split(abs, "/")
			target := abs
			if k := slices.IndexFunc(parts, func(p string) bool { return strings.ContainsAny(p, "*?[") }); k != -1 {
				if strings.Trim(parts[k], ".*?") != "" {
					continue
				}
				if target = strings.Join(parts[:k], "/"); target == "" {
					target = "/"
				}
			}
			target = unescapeGlob(target)
			if reason := protectedReason(target, wsRoot, home, haloHome); reason != "" {
				return errors.New(`[Sandbox] rm blocked: "` + raw + `" resolves to ` + target + ", which is " + reason + ". Name the specific files or subdirectories to delete instead.")
			}
		}
	}
	return nil
}

func protectedReason(target, wsRoot, home, haloHome string) string {
	switch {
	case target == "/":
		return "the filesystem root"
	case isUnder(home, target):
		return "the home directory or a parent of it"
	case isUnder(haloHome, target):
		return "~/.halo or a parent of it"
	case isUnder(wsRoot, target):
		return "the workspace root or a parent of it"
	case slices.Contains(exactDirs, target):
		return "a system directory"
	}
	for _, d := range systemDirs {
		if target == d || filepath.Dir(target) == d {
			return "a system directory"
		}
	}
	return ""
}

// isUnder is sandbox.ts isUnder: p is dir or inside it (string compare, so a
// home with a trailing slash behaves exactly as in the TS).
func isUnder(p, dir string) bool {
	if p == dir {
		return true
	}
	if !strings.HasSuffix(dir, "/") {
		dir += "/"
	}
	return strings.HasPrefix(p, dir)
}

// resolve is path.resolve(base, p); a result still relative (only after a
// bare `cd` with a relative HOME) is taken against the process cwd, like Node.
func resolve(base, p string) string {
	if !filepath.IsAbs(p) {
		p = filepath.Join(base, p)
	}
	abs, _ := filepath.Abs(p)
	return abs
}

// expandWord is expandRmWord: `~` / $HOME / $PWD expanded; any other variable
// or substitution becomes empty — its value when unset, which is how
// `rm -rf "$DIR/"` goes wrong.
func expandWord(w, cwd, home string) string {
	// home / cwd go in last through NUL markers (as the TS): as-is, never
	// re-scanned by the unset pass. NUL can't reach a shell, so no clash.
	if w == "~" || strings.HasPrefix(w, "~/") {
		w = "\x00H" + w[1:]
	}
	w = homeRe.ReplaceAllLiteralString(w, "\x00H")
	w = pwdRe.ReplaceAllLiteralString(w, "\x00P")
	w = unsetRe.ReplaceAllLiteralString(w, "")
	return strings.NewReplacer("\x00H", escapeGlob(home), "\x00P", cwd).Replace(w)
}

// A runtime path's (home, the workspace root) glob chars as NUL escapes, so
// the everything-glob check only sees globs the command itself wrote —
// `/srv/proj [v2]` is a name, not a pattern. unescapeGlob restores them.
var (
	globEscaper   = strings.NewReplacer("*", "\x000", "?", "\x001", "[", "\x002")
	globUnescaper = strings.NewReplacer("\x000", "*", "\x001", "?", "\x002", "[")
)

func escapeGlob(p string) string   { return globEscaper.Replace(p) }
func unescapeGlob(p string) string { return globUnescaper.Replace(p) }

// stripSubshellClose drops a subshell's closing `)` glued to the last word
// (`(rm -rf x)`), leaving balanced `$(...)` intact.
func stripSubshellClose(w string) string {
	for strings.HasSuffix(w, ")") && strings.Count(w, "(") < strings.Count(w, ")") {
		w = w[:len(w)-1]
	}
	return w
}

// shellSegments splits a command into simple commands (on unquoted ; & |
// newline) of quote-stripped words. Heredoc bodies are skipped — they're data
// (a script being written to a file), not commands run here.
func shellSegments(s string) [][]string {
	type heredoc struct {
		delim string
		dash  bool
	}
	var (
		segments [][]string
		words    []string
		cur      strings.Builder
		inWord   bool
		quote    byte
		heredocs []heredoc
	)
	endWord := func() {
		if inWord {
			words = append(words, cur.String())
		}
		cur.Reset()
		inWord = false
	}
	endSegment := func() {
		endWord()
		if len(words) > 0 {
			segments = append(segments, words)
		}
		words = nil
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if quote != 0 {
			if c == quote {
				quote = 0
			} else if c == '\\' && quote == '"' && i+1 < len(s) {
				i++
				cur.WriteByte(s[i])
			} else {
				cur.WriteByte(c)
			}
			continue
		}
		if c == '<' && i+1 < len(s) && s[i+1] == '<' && (i+2 >= len(s) || s[i+2] != '<') {
			if n, delim, dash := heredocAt(s[i:]); n > 0 {
				endWord()
				heredocs = append(heredocs, heredoc{delim, dash})
				i += n - 1
				continue
			}
		}
		if c == '\n' && len(heredocs) > 0 {
			endSegment()
			// Skip each pending body up to its delimiter line.
			pos := i + 1
			for _, h := range heredocs {
				for pos < len(s) {
					line, next := s[pos:], len(s)
					if eol := strings.IndexByte(line, '\n'); eol != -1 {
						line, next = line[:eol], pos+eol+1
					}
					pos = next
					if h.dash {
						line = strings.TrimLeft(line, "\t")
					}
					if line == h.delim {
						break
					}
				}
			}
			heredocs = nil
			i = pos - 1
			continue
		}
		switch {
		case c == '"' || c == '\'':
			quote = c
			inWord = true
		case c == '\\' && i+1 < len(s) && s[i+1] == '\n':
			i++
		case c == '\\' && i+1 < len(s):
			i++
			cur.WriteByte(s[i])
			inWord = true
		case c == ';' || c == '&' || c == '|' || c == '\n':
			endSegment()
		case c == ' ' || c == '\t' || c == '\r':
			endWord()
		default:
			cur.WriteByte(c)
			inWord = true
		}
	}
	endSegment()
	return segments
}

// heredocAt is /^<<(-?)\s*(['"]?)([A-Za-z0-9_.-]+)\2/.exec(s): the match
// length (0 = none), delimiter and dash flag.
func heredocAt(s string) (n int, delim string, dash bool) {
	m := heredocRe.FindStringSubmatch(s)
	if m == nil {
		return 0, "", false
	}
	return len(m[0]), m[2] + m[3] + m[4], m[1] == "-"
}
