package relay

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"example.com/babymonkey/relay/internal/protocol"
)

func TestReplayReservationTerminalRecoveryAndRestart(t *testing.T) {
	store, path := newReplayStoreForTest(t)
	now := time.Unix(1_787_608_000, 0).UTC()
	var key [32]byte
	key[0] = 7
	first, err := store.Reserve(key, now, func() error { return nil })
	if err != nil || !first.New {
		t.Fatalf("first=%#v err=%v", first, err)
	}
	pending, err := store.Reserve(key, now, func() error { t.Fatal("replay consulted new-key authorization"); return errRateLimited })
	if err != nil || pending.New || pending.Outcome != protocol.Ambiguous {
		t.Fatalf("pending=%#v err=%v", pending, err)
	}
	restartedPending, err := LoadReplayStore(path)
	if err != nil {
		t.Fatal(err)
	}
	afterRestart, err := restartedPending.Reserve(key, now, func() error { return errRateLimited })
	if err != nil || afterRestart.Outcome != protocol.Ambiguous {
		t.Fatalf("afterRestart=%#v err=%v", afterRestart, err)
	}
	if err := store.Settle(key, protocol.Confirmed); err != nil {
		t.Fatal(err)
	}
	terminal, err := store.Reserve(key, now, func() error { return errRateLimited })
	if err != nil || terminal.Outcome != protocol.Confirmed {
		t.Fatalf("terminal=%#v err=%v", terminal, err)
	}
	restartedTerminal, err := LoadReplayStore(path)
	if err != nil {
		t.Fatal(err)
	}
	terminal, err = restartedTerminal.Reserve(key, now, func() error { return errRateLimited })
	if err != nil || terminal.Outcome != protocol.Confirmed {
		t.Fatalf("restarted terminal=%#v err=%v", terminal, err)
	}
	document := decodeReplayFile(t, path)
	if len(document.Entries) != 1 || document.Entries[0].State != replayTerminal || document.Entries[0].KeyHash == "" {
		t.Fatalf("unexpected replay state %#v", document)
	}
}

func TestConcurrentDuplicateReservesExactlyOnce(t *testing.T) {
	store, _ := newReplayStoreForTest(t)
	now := time.Unix(1_787_608_000, 0).UTC()
	var key [32]byte
	key[0] = 9
	var newCount atomic.Int64
	var wait sync.WaitGroup
	for index := 0; index < 24; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			result, err := store.Reserve(key, now, func() error { return nil })
			if err != nil {
				t.Errorf("reserve: %v", err)
				return
			}
			if result.New {
				newCount.Add(1)
			} else if result.Outcome != protocol.Ambiguous {
				t.Errorf("duplicate outcome=%q", result.Outcome)
			}
		}()
	}
	wait.Wait()
	if newCount.Load() != 1 {
		t.Fatalf("new reservations=%d", newCount.Load())
	}
}

func TestReplayWriteFailuresRemainFailClosed(t *testing.T) {
	store, path := newReplayStoreForTest(t)
	now := time.Unix(1_787_608_000, 0).UTC()
	var key [32]byte
	key[0] = 11
	store.persist = func(string, []byte) error { return errors.New("synthetic write failure") }
	if result, err := store.Reserve(key, now, func() error { return nil }); err == nil || result.New {
		t.Fatalf("reservation unexpectedly succeeded: %#v %v", result, err)
	}
	if len(decodeReplayFile(t, path).Entries) != 0 {
		t.Fatal("failed reservation changed durable state")
	}

	store.persist = writeExistingOwnerOnlyFileAtomically
	if _, err := store.Reserve(key, now, func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	store.persist = func(string, []byte) error { return errors.New("synthetic settlement failure") }
	if err := store.Settle(key, protocol.Confirmed); err == nil {
		t.Fatal("settlement unexpectedly succeeded")
	}
	restarted, err := LoadReplayStore(path)
	if err != nil {
		t.Fatal(err)
	}
	result, err := restarted.Reserve(key, now, func() error { return errRateLimited })
	if err != nil || result.Outcome != protocol.Ambiguous {
		t.Fatalf("crash recovery=%#v err=%v", result, err)
	}
}

func TestReplayCapacityAndCorruptionFailClosed(t *testing.T) {
	store, _ := newReplayStoreForTest(t)
	now := time.Unix(1_787_608_000, 0).UTC()
	for index := 0; index < ReplayCapacity; index++ {
		var key [32]byte
		key[0] = byte(index)
		key[1] = byte(index >> 8)
		if _, err := store.Reserve(key, now, func() error { return nil }); err != nil {
			t.Fatalf("reserve %d: %v", index, err)
		}
	}
	var overflow [32]byte
	overflow[0], overflow[1] = 1, 1
	if _, err := store.Reserve(overflow, now, func() error { return nil }); err == nil {
		t.Fatal("capacity overflow succeeded")
	}

	for _, data := range []string{
		`{"version":1,"entries":`,
		`{"version":1,"version":1,"entries":[]}`,
		`{"version":2,"entries":[]}`,
		`{"version":1,"entries":[{"key_hash":"bad","state":"reserved","expires_unix":1}]}`,
	} {
		path := filepath.Join(t.TempDir(), "replay.json")
		writeMode600(t, path, []byte(data))
		if _, err := LoadReplayStore(path); err == nil {
			t.Fatalf("accepted corrupt state %q", data)
		}
	}
	missing := filepath.Join(t.TempDir(), "missing.json")
	if _, err := LoadReplayStore(missing); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing state error=%v", err)
	}
	permissive := filepath.Join(t.TempDir(), "replay.json")
	if err := os.WriteFile(permissive, []byte(`{"version":1,"entries":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadReplayStore(permissive); err == nil {
		t.Fatal("accepted permissive state file")
	}
}
