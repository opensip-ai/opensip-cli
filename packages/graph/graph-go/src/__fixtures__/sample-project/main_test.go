// Integration test exercising util.Helper.
package main

import (
	"testing"

	"example.com/sample-project/util"
)

func TestHelperPrependsPrefix(t *testing.T) {
	if got := util.Helper("ok"); got != "helper:ok" {
		t.Fatalf("got %q", got)
	}
}

func TestHelperHandlesEmptyString(t *testing.T) {
	if got := util.Helper(""); got != "helper:" {
		t.Fatalf("got %q", got)
	}
}
