package relay

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"syscall"
)

func readOwnerOnlyRegularFile(path string, maxBytes int64) ([]byte, error) {
	before, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() || before.Mode().Perm()&0o077 != 0 || before.Size() > maxBytes {
		return nil, errors.New("file must be a bounded owner-only regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !os.SameFile(before, after) || !after.Mode().IsRegular() || after.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("file changed or is not owner-only")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, errors.New("file exceeds size limit")
	}
	return data, nil
}

func decodeStrictJSON(data []byte, destination any) error {
	validator := json.NewDecoder(bytesReader(data))
	validator.UseNumber()
	if err := rejectDuplicateKeys(validator); err != nil {
		return err
	}
	if token, err := validator.Token(); !errors.Is(err, io.EOF) || token != nil {
		return errors.New("JSON contains trailing data")
	}
	decoder := json.NewDecoder(bytesReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("JSON contains trailing data")
	}
	return nil
}

type byteReader struct {
	data []byte
	off  int
}

func bytesReader(data []byte) *byteReader { return &byteReader{data: data} }

func (r *byteReader) Read(p []byte) (int, error) {
	if r.off >= len(r.data) {
		return 0, io.EOF
	}
	n := copy(p, r.data[r.off:])
	r.off += n
	return n, nil
}

func rejectDuplicateKeys(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	return rejectDuplicateKeysAfterToken(decoder, token)
}

func rejectDuplicateKeysAfterToken(decoder *json.Decoder, token json.Token) error {
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		seen := map[string]struct{}{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("JSON object key is not a string")
			}
			if _, duplicate := seen[key]; duplicate {
				return fmt.Errorf("duplicate JSON key %q", key)
			}
			seen[key] = struct{}{}
			if err := rejectDuplicateKeys(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim('}') {
			return errors.New("invalid JSON object")
		}
	case '[':
		for decoder.More() {
			if err := rejectDuplicateKeys(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim(']') {
			return errors.New("invalid JSON array")
		}
	default:
		return errors.New("unexpected JSON delimiter")
	}
	return nil
}

func writeFileAtomically(path string, data []byte) error {
	var existingOwnership *syscall.Stat_t
	existing, err := os.Lstat(path)
	if err == nil {
		if _, err := readOwnerOnlyRegularFile(path, 1<<20); err != nil {
			return err
		}
		ownership, ok := existing.Sys().(*syscall.Stat_t)
		if !ok {
			return errors.New("cannot preserve file ownership")
		}
		existingOwnership = ownership
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	directory := filepathDir(path)
	temporary, err := os.CreateTemp(directory, ".babymonkey-relay-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}
	if existingOwnership != nil && ownershipChangeRequired(
		existingOwnership.Uid,
		existingOwnership.Gid,
		os.Geteuid(),
		os.Getegid(),
	) {
		if err := temporary.Chown(int(existingOwnership.Uid), int(existingOwnership.Gid)); err != nil {
			cleanup()
			return err
		}
	}
	if err := temporary.Chmod(0o600); err != nil {
		cleanup()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		cleanup()
		return err
	}
	if err := temporary.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryPath)
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		_ = os.Remove(temporaryPath)
		return err
	}
	directoryFile, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer directoryFile.Close()
	return directoryFile.Sync()
}

func ownershipChangeRequired(existingUID, existingGID uint32, effectiveUID, effectiveGID int) bool {
	return uint64(existingUID) != uint64(effectiveUID) ||
		uint64(existingGID) != uint64(effectiveGID)
}

func writeExistingOwnerOnlyFileAtomically(path string, data []byte) error {
	if _, err := readOwnerOnlyRegularFile(path, 1<<20); err != nil {
		return err
	}
	return writeFileAtomically(path, data)
}

func filepathDir(path string) string {
	for index := len(path) - 1; index >= 0; index-- {
		if path[index] == os.PathSeparator {
			if index == 0 {
				return string(os.PathSeparator)
			}
			return path[:index]
		}
	}
	return "."
}
