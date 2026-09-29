package main

import "testing"

func TestListenerExitCode(t *testing.T) {
	if listenerExitCode(false) != 0 {
		t.Fatal("clean shutdown must exit successfully")
	}
	if listenerExitCode(true) == 0 {
		t.Fatal("listener failure must request service restart")
	}
}
