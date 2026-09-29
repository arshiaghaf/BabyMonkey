package relay

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDeploymentArtifactsRemainNarrowAndUnconfigured(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate test source")
	}
	relayRoot := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "..", ".."))
	unit := readArtifact(t, filepath.Join(relayRoot, "ops", "babymonkey-relay.service"))
	required := []string{
		"User=babymonkey-relay",
		"UMask=0077",
		"StateDirectory=babymonkey-relay",
		"StateDirectoryMode=0700",
		"ReadOnlyPaths=/etc/babymonkey-relay /opt/babymonkey-relay",
		"ReadWritePaths=/var/lib/babymonkey-relay",
		"MemoryMax=64M",
		"MemorySwapMax=0",
		"CPUQuota=10%",
		"CPUWeight=10",
		"IOWeight=10",
		"TasksMax=24",
		"LimitNOFILE=128",
		"LimitCORE=0",
		"NoNewPrivileges=true",
	}
	for _, value := range required {
		if !strings.Contains(unit, value) {
			t.Errorf("service unit lacks %q", value)
		}
	}
	for _, forbidden := range []string{"Environment=", "EnvironmentFile=", "ReadWritePaths=/ ", "DynamicUser=true"} {
		if strings.Contains(unit, forbidden) {
			t.Errorf("service unit contains forbidden surface %q", forbidden)
		}
	}

	config := readArtifact(t, filepath.Join(relayRoot, "config", "relay.example.json"))
	for _, forbidden := range []string{"hostname", "certificate_id", "telegram_bot_token", "telegram_destination", "fixed_message"} {
		if strings.Contains(config, forbidden) {
			t.Errorf("example runtime configuration contains %q", forbidden)
		}
	}

	allowlist := readArtifact(t, filepath.Join(relayRoot, "config", "allowlist.deny-all.json"))
	if allowlist != "{\"version\":1,\"certificate_sha256_der\":[]}\n" {
		t.Fatalf("default allowlist is not exact deny-all: %q", allowlist)
	}
}

func readArtifact(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
