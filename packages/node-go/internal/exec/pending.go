package exec

import (
	"context"
	"errors"
)

// Filled in after the first connect (M1 step 4).
var errPending = errors.New("not implemented yet")

func (e *Executor) write(full, placed string, args map[string]any) (string, error) { return "", errPending }
func (e *Executor) edit(full, placed string, args map[string]any) (string, error)  { return "", errPending }
func (e *Executor) list(ctx context.Context, full string, args map[string]any) (string, error) {
	return "", errPending
}
func (e *Executor) grep(ctx context.Context, full string, args map[string]any) (string, error) {
	return "", errPending
}
func (e *Executor) glob(ctx context.Context, full string, args map[string]any) (string, error) {
	return "", errPending
}
func (e *Executor) prepareRun(args map[string]any) (call, error) {
	if !e.s.AllowShell {
		return nil, &refusal{ShellDisabled, "shell disabled"}
	}
	return nil, errPending
}
