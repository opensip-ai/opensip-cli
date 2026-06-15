package main

import (
	"log/slog"
)

// This service logs via the structured logger, never the unstructured
// stdout printers from the fmt package.
func main() {
	x := compute()
	slog.Info("computed result", "value", x)
	msg := formatResult(x)
	slog.Info(msg)
}

func formatResult(x int) string {
	return fmt.Sprintf("result is %d", x)
}

func compute() int {
	return 42
}
