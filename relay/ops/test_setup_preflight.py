"""Execute the guide's actual first-install shell guard with synthetic host stubs."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


class PreflightTests(unittest.TestCase):
    def test_extracted_first_install_refuses_existing_state_before_mutation(self):
        guide = (Path(__file__).resolve().parents[2] / "docs/SETUP.md").read_text()
        blocks = re.findall(r"```sh\n(.*?)\n```", guide, re.S)
        preflight = next(block for block in blocks if "unit_state=$(systemctl show" in block)
        paths = ["/opt/babymonkey-relay", "/etc/babymonkey-relay", "/var/lib/babymonkey-relay", "/etc/systemd/system/babymonkey-relay.service"]
        cases = ["clean", "user", "group", "service", "service-error"] + ["path-" + str(i) for i in range(4)] + ["symlink"]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            commands = {
                "sudo": 'exec "$@"',
                "getent": 'if [ "$1" = passwd ] && [ "$CASE" = user ]; then exit 0; fi\nif [ "$1" = group ] && [ "$CASE" = group ]; then exit 0; fi\nexit 2',
                "systemctl": 'if [ "$CASE" = service-error ]; then exit 1; fi\nif [ "$CASE" = service ]; then echo loaded; else echo not-found; fi',
                "useradd": 'echo mutation >> "$MUTATIONS"',
            }
            for name, body in commands.items():
                command = root / name
                command.write_text("#!/bin/sh\n" + body + "\n")
                command.chmod(0o700)
            for case in cases:
                with self.subTest(case=case), tempfile.TemporaryDirectory(dir=tmp) as state:
                    state = Path(state)
                    script = preflight
                    for index, original in enumerate(paths):
                        script = script.replace(original, str(state / ("path-" + str(index))))
                    if case == "path-3":
                        (state / case).write_text("synthetic existing unit")
                    elif case.startswith("path-"):
                        (state / case).mkdir()
                    if case == "symlink":
                        (state / "path-0").symlink_to(state / "missing")
                    mutations = state / "mutations"
                    # This represents the guide's required stop-on-first-failure
                    # sequence. No host command or real mutation is executed.
                    result = subprocess.run(["sh", "-c", "set -e\n" + script + "\nuseradd synthetic"],
                        env={**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"], "CASE": case, "MUTATIONS": str(mutations)},
                        capture_output=True, text=True, timeout=5)
                    self.assertEqual(result.returncode == 0, case == "clean", result.stderr)
                    self.assertEqual(mutations.exists(), case == "clean")
                    if case == "clean":
                        self.assertEqual(mutations.read_text(), "mutation\n")
