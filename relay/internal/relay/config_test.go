package relay

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestConfigurationAndCredentialPermissions(t *testing.T) {
	directory := t.TempDir()
	configPath := filepath.Join(directory, "relay.json")
	config := FileConfig{
		HTTPSListen:           ":443",
		ServerCertificateFile: "/etc/babymonkey-relay/tls/server-certificate.pem",
		ServerPrivateKeyFile:  "/etc/babymonkey-relay/tls/server-private-key.pem",
		ClientCAFile:          "/etc/babymonkey-relay/client-ca.pem",
		AllowlistFile:         "/etc/babymonkey-relay/allowlist.json",
		CredentialsFile:       "/etc/babymonkey-relay/credentials.json",
		ReplayStateFile:       "/var/lib/babymonkey-relay/replay.json",
	}
	data, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	writeMode600(t, configPath, data)
	loaded, err := LoadFileConfig(configPath)
	if err != nil || loaded != config {
		t.Fatalf("loaded=%#v err=%v", loaded, err)
	}
	if err := os.Chmod(configPath, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadFileConfig(configPath); err == nil {
		t.Fatal("accepted permissive config")
	}

	credentialsPath := filepath.Join(directory, "credentials.json")
	credentials := Credentials{
		TelegramBotToken: "123456:" + strings.Repeat("A", 32),
		Destination:      "-" + strings.Repeat("7", 12),
		Message:          strings.Join([]string{"synthetic", "fixed", "test"}, " "),
	}
	data, err = json.Marshal(credentials)
	if err != nil {
		t.Fatal(err)
	}
	writeMode600(t, credentialsPath, data)
	loadedCredentials, err := LoadCredentials(credentialsPath)
	if err != nil || loadedCredentials != credentials {
		t.Fatalf("loaded=%#v err=%v", loadedCredentials, err)
	}
	writeMode600(t, credentialsPath, []byte(`{"telegram_bot_token":"x","telegram_bot_token":"y","telegram_destination":"1","fixed_message":"x"}`))
	if _, err := LoadCredentials(credentialsPath); err == nil {
		t.Fatal("accepted duplicate credential field")
	}
}

func TestConfigurationCannotBroadenFilesystemOrListener(t *testing.T) {
	base := FileConfig{
		HTTPSListen:           ":443",
		ServerCertificateFile: "/etc/babymonkey-relay/tls/server-certificate.pem",
		ServerPrivateKeyFile:  "/etc/babymonkey-relay/tls/server-private-key.pem",
		ClientCAFile:          "/etc/babymonkey-relay/client-ca.pem",
		AllowlistFile:         "/etc/babymonkey-relay/allowlist.json",
		CredentialsFile:       "/etc/babymonkey-relay/credentials.json",
		ReplayStateFile:       "/var/lib/babymonkey-relay/replay.json",
	}
	mutations := []func(*FileConfig){
		func(config *FileConfig) { config.HTTPSListen = ":8080" },
		func(config *FileConfig) { config.CredentialsFile = "/home/unrelated-app/.env" },
		func(config *FileConfig) { config.AllowlistFile = "/tmp/allowlist.json" },
		func(config *FileConfig) { config.ReplayStateFile = "/var/lib/elsewhere/state.json" },
		func(config *FileConfig) { config.ReplayStateFile = "/var/lib/babymonkey-relay/../elsewhere/state.json" },
	}
	for index, mutate := range mutations {
		candidate := base
		mutate(&candidate)
		if err := candidate.ValidateProductionShape(); err == nil {
			t.Fatalf("mutation %d accepted: %#v", index, candidate)
		}
	}
}

func TestOwnerOnlyReaderRejectsSymlink(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "target.json")
	link := filepath.Join(directory, "link.json")
	writeMode600(t, target, []byte(`{}`))
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readOwnerOnlyRegularFile(link, 64); err == nil {
		t.Fatal("accepted symlink")
	}
}

func TestAtomicReplacementRejectsUnsafeTargetAndPreservesOwnerOnlyMode(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "allowlist.json")
	writeMode600(t, path, []byte(`{"version":1,"certificate_sha256_der":[]}`))
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteAllowlist(path, nil); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	beforeStat, beforeOK := before.Sys().(*syscall.Stat_t)
	afterStat, afterOK := after.Sys().(*syscall.Stat_t)
	if after.Mode().Perm() != 0o600 || !beforeOK || !afterOK || beforeStat.Uid != afterStat.Uid || beforeStat.Gid != afterStat.Gid {
		t.Fatalf("replacement mode=%o", after.Mode().Perm())
	}

	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := WriteAllowlist(path, nil); err == nil {
		t.Fatal("replaced a permissive allowlist")
	}

	target := filepath.Join(directory, "target.json")
	link := filepath.Join(directory, "linked-allowlist.json")
	writeMode600(t, target, []byte(`{"version":1,"certificate_sha256_der":[]}`))
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := WriteAllowlist(link, nil); err == nil {
		t.Fatal("replaced a symlinked allowlist")
	}
}
