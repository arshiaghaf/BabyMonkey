package relay

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"sync"
	"time"

	"example.com/babymonkey/relay/internal/protocol"
)

const (
	replayStateVersion = 1
	ReplayTTL          = 10 * time.Minute
	ReplayCapacity     = 256
)

type replayState string

const (
	replayReserved replayState = "reserved"
	replayTerminal replayState = "terminal"
)

type replayEntry struct {
	KeyHash     string           `json:"key_hash"`
	State       replayState      `json:"state"`
	Outcome     protocol.Outcome `json:"outcome,omitempty"`
	ExpiresUnix int64            `json:"expires_unix"`
}

type replayDocument struct {
	Version int           `json:"version"`
	Entries []replayEntry `json:"entries"`
}

type replayDisposition struct {
	New     bool
	Outcome protocol.Outcome
}

type ReplayStore struct {
	mu      sync.Mutex
	path    string
	entries map[string]replayEntry
	persist func(string, []byte) error
}

func LoadReplayStore(path string) (*ReplayStore, error) {
	data, err := readOwnerOnlyRegularFile(path, 1<<20)
	if err != nil {
		return nil, err
	}
	var document replayDocument
	if err := decodeStrictJSON(data, &document); err != nil {
		return nil, err
	}
	if document.Version != replayStateVersion || len(document.Entries) > ReplayCapacity {
		return nil, errors.New("invalid replay state version or capacity")
	}
	store := &ReplayStore{
		path:    path,
		entries: make(map[string]replayEntry, len(document.Entries)),
		persist: writeExistingOwnerOnlyFileAtomically,
	}
	for _, entry := range document.Entries {
		if err := validateReplayEntry(entry); err != nil {
			return nil, err
		}
		if _, duplicate := store.entries[entry.KeyHash]; duplicate {
			return nil, errors.New("duplicate replay state entry")
		}
		store.entries[entry.KeyHash] = entry
	}
	return store, nil
}

func validateReplayEntry(entry replayEntry) error {
	decoded, err := hex.DecodeString(entry.KeyHash)
	if err != nil || len(decoded) != sha256.Size || hex.EncodeToString(decoded) != entry.KeyHash || entry.ExpiresUnix <= 0 {
		return errors.New("invalid replay state entry")
	}
	switch entry.State {
	case replayReserved:
		if entry.Outcome != "" {
			return errors.New("reserved replay entry has outcome")
		}
	case replayTerminal:
		if !validOutcome(entry.Outcome) {
			return errors.New("terminal replay entry has invalid outcome")
		}
	default:
		return errors.New("invalid replay state")
	}
	return nil
}

func (store *ReplayStore) Reserve(
	replayKey [32]byte,
	now time.Time,
	authorizeNew func() error,
) (replayDisposition, error) {
	return store.reserveHash(hashReplayKey(replayKey), now, authorizeNew)
}


func (store *ReplayStore) reserveHash(keyHash string, now time.Time, authorizeNew func() error) (replayDisposition, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.verifyDiskLocked(); err != nil {
		return replayDisposition{}, err
	}
	if entry, exists := store.entries[keyHash]; exists && entry.ExpiresUnix > now.Unix() {
		if entry.State == replayTerminal {
			return replayDisposition{Outcome: entry.Outcome}, nil
		}
		return replayDisposition{Outcome: protocol.Ambiguous}, nil
	}
	if err := authorizeNew(); err != nil {
		return replayDisposition{}, err
	}
	candidate := make(map[string]replayEntry, len(store.entries)+1)
	for key, entry := range store.entries {
		if entry.ExpiresUnix > now.Unix() {
			candidate[key] = entry
		}
	}
	if len(candidate) >= ReplayCapacity {
		return replayDisposition{}, errors.New("replay capacity reached")
	}
	candidate[keyHash] = replayEntry{
		KeyHash:     keyHash,
		State:       replayReserved,
		ExpiresUnix: now.Add(ReplayTTL).Unix(),
	}
	if err := store.persistEntries(candidate); err != nil {
		return replayDisposition{}, err
	}
	store.entries = candidate
	return replayDisposition{New: true}, nil
}

func (store *ReplayStore) Settle(
	replayKey [32]byte,
	outcome protocol.Outcome,
) error {
	return store.settleHash(hashReplayKey(replayKey), outcome)
}


func (store *ReplayStore) settleHash(keyHash string, outcome protocol.Outcome) error {
	if !validOutcome(outcome) {
		return errors.New("invalid settlement outcome")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.verifyDiskLocked(); err != nil {
		return err
	}
	entry, exists := store.entries[keyHash]
	if !exists || entry.State != replayReserved {
		return errors.New("missing reserved replay entry")
	}
	candidate := cloneEntries(store.entries)
	entry.State = replayTerminal
	entry.Outcome = outcome
	candidate[keyHash] = entry
	if err := store.persistEntries(candidate); err != nil {
		return err
	}
	store.entries = candidate
	return nil
}

func (store *ReplayStore) verifyDiskLocked() error {
	data, err := readOwnerOnlyRegularFile(store.path, 1<<20)
	if err != nil {
		return err
	}
	var document replayDocument
	if err := decodeStrictJSON(data, &document); err != nil {
		return err
	}
	if document.Version != replayStateVersion || len(document.Entries) > ReplayCapacity {
		return errors.New("invalid durable replay state")
	}
	durable := make(map[string]replayEntry, len(document.Entries))
	for _, entry := range document.Entries {
		if err := validateReplayEntry(entry); err != nil {
			return err
		}
		if _, duplicate := durable[entry.KeyHash]; duplicate {
			return errors.New("duplicate durable replay entry")
		}
		durable[entry.KeyHash] = entry
	}
	if !reflect.DeepEqual(durable, store.entries) {
		return errors.New("durable replay state changed unexpectedly")
	}
	return nil
}

func (store *ReplayStore) persistEntries(entries map[string]replayEntry) error {
	document := replayDocument{Version: replayStateVersion, Entries: make([]replayEntry, 0, len(entries))}
	for _, entry := range entries {
		document.Entries = append(document.Entries, entry)
	}
	sort.Slice(document.Entries, func(i, j int) bool {
		return document.Entries[i].KeyHash < document.Entries[j].KeyHash
	})
	data, err := json.Marshal(document)
	if err != nil {
		return err
	}
	if len(data) > 1<<20 {
		return fmt.Errorf("replay state exceeds size limit")
	}
	return store.persist(store.path, data)
}

func cloneEntries(source map[string]replayEntry) map[string]replayEntry {
	result := make(map[string]replayEntry, len(source))
	for key, entry := range source {
		result[key] = entry
	}
	return result
}

func hashReplayKey(key [32]byte) string {
	hasher := sha256.New()
	_, _ = hasher.Write([]byte("babymonkey-relay-v1\x00"))
	_, _ = hasher.Write(key[:])
	return hex.EncodeToString(hasher.Sum(nil))
}

func validOutcome(outcome protocol.Outcome) bool {
	return outcome == protocol.Confirmed || outcome == protocol.DefinitiveFailure || outcome == protocol.Ambiguous
}
