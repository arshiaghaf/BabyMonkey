package relay

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestAllowlistWriterCredentialHelperInteroperability(t *testing.T) {
	path := filepath.Join(t.TempDir(), "allowlist.json")
	for _, empty := range [][]string{nil, {}} {
		if err := WriteAllowlist(path, empty); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != `{"version":1,"certificate_sha256_der":[]}` {
			t.Fatalf("noncanonical deny-all: %s", data)
		}
		// Execute the real helper's replacement precondition against real writer bytes.
		command := exec.Command("python3", "-B", "-c", `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('credentials', sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
helper.deny_all(sys.argv[2])
`, filepath.Join("..", "..", "ops", "install_credentials.py"), path)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("helper rejects writer deny-all: %v %s", err, output)
		}
	}
	for _, fingerprints := range [][]string{{strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64)}, {strings.Repeat("a", 64), strings.Repeat("a", 64)}, {strings.Repeat("A", 64)}, {"invalid"}} {
		if err := WriteAllowlist(path, fingerprints); err == nil {
			t.Fatal("accepted invalid/beyond-bound allowlist")
		}
		data, _ := os.ReadFile(path)
		if string(data) != `{"version":1,"certificate_sha256_der":[]}` {
			t.Fatal("rejection changed deny-all")
		}
	}
	values := []string{strings.Repeat("b", 64), strings.Repeat("a", 64)}
	if err := WriteAllowlist(path, values); err != nil {
		t.Fatal(err)
	}
	if values[0] != strings.Repeat("b", 64) {
		t.Fatal("writer mutated caller slice")
	}
	command := exec.Command("python3", "-B", "-c", `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('credentials', sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
try: helper.deny_all(sys.argv[2])
except helper.SetupError: sys.exit(0)
sys.exit('helper accepted nonempty allowlist')
`, filepath.Join("..", "..", "ops", "install_credentials.py"), path)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("nonempty helper gate: %v %s", err, output)
	}
}
