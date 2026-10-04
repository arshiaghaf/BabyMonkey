"""Synthetic-only tests for the private setup helpers. No provider request is made."""

import importlib.util
import json
import os
from pathlib import Path
import pty
import select
import subprocess
import tempfile
import termios
import unittest
from unittest import mock


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    item = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(item)
    return item


credentials = module("install_credentials")
tls = module("install_tls")
SYNTHETIC_TOKEN = "123456789:" + "A" * 36


class FakeResponse:
    status = 200

    def __init__(self, data):
        self.data = data

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, maximum):
        return self.data[:maximum]


class FakeOpener:
    def __init__(self, result):
        self.result = result
        self.request = None

    def open(self, request, timeout):
        self.request = request
        assert timeout == 10
        assert request.full_url.endswith("/getUpdates")
        assert request.get_method() == "POST"
        return FakeResponse(json.dumps({"ok": True, "result": self.result}).encode())


def start(chat, kind="private"):
    return {"message": {"text": "/start", "chat": {"id": chat, "type": kind}}}


class CredentialTests(unittest.TestCase):
    def test_terminal_echo_control_failure_aborts(self):
        master, slave = pty.openpty()
        try:
            with os.fdopen(slave, "r", buffering=1) as reader, open(os.ttyname(slave), "w", buffering=1) as output:
                with mock.patch.object(credentials.termios, "tcsetattr", side_effect=OSError("synthetic failure")):
                    with self.assertRaises(credentials.SetupError):
                        credentials.hidden_token(reader, output)
        finally:
            os.close(master)

    def test_attached_terminal_input_is_not_echoed(self):
        master, slave = pty.openpty()
        try:
            with os.fdopen(slave, "r", buffering=1) as reader, open(os.ttyname(slave), "w", buffering=1) as output:
                original = termios.tcgetattr(reader.fileno())
                class PromptTriggeredInput:
                    injected = False

                    def write(self, data):
                        return output.write(data)

                    def flush(self):
                        output.flush()
                        if not self.injected:
                            self.injected = True
                            os.write(master, (SYNTHETIC_TOKEN + "\n").encode())

                self.assertEqual(credentials.hidden_token(reader, PromptTriggeredInput()), SYNTHETIC_TOKEN)
                self.assertEqual(termios.tcgetattr(reader.fileno())[3] & termios.ECHO, original[3] & termios.ECHO)
                visible = b""
                while select.select([master], [], [], 0)[0]:
                    visible += os.read(master, 4096)
                self.assertNotIn(SYNTHETIC_TOKEN.encode(), visible)
        finally:
            os.close(master)

    def test_prompt_output_failure_restores_echo(self):
        master, slave = pty.openpty()
        try:
            with os.fdopen(slave, "r", buffering=1) as reader:
                original = termios.tcgetattr(reader.fileno())
                class FailingWriter:
                    def write(self, data):
                        return len(data)

                    def flush(self):
                        raise OSError("synthetic prompt failure")

                with self.assertRaises(OSError):
                    credentials.hidden_token(reader, FailingWriter())
                self.assertEqual(termios.tcgetattr(reader.fileno())[3] & termios.ECHO, original[3] & termios.ECHO)
        finally:
            os.close(master)

    def test_single_private_start_and_no_send(self):
        fake = FakeOpener([start(123), start(123)])
        self.assertEqual(credentials.private_destination(credentials.updates_for(SYNTHETIC_TOKEN, fake)), "123")
        self.assertEqual(fake.request.full_url.count("/getUpdates"), 1)

    def test_reject_ambiguous_or_unsafe_updates(self):
        for updates in ([], [start(1), start(2)], [start(1, "group")],
                        [{"message": {"text": "/start", "chat": {"id": "1", "type": "private"}}}]):
            with self.subTest(updates=updates), self.assertRaises(credentials.SetupError):
                credentials.private_destination(updates)
        with self.assertRaises(credentials.SetupError):
            credentials.updates_for(SYNTHETIC_TOKEN, FakeOpener([start(1)] * 100))

    def test_network_error_does_not_expose_token(self):
        class BrokenOpener:
            def open(self, request, timeout):
                raise RuntimeError("secret=" + SYNTHETIC_TOKEN)

        with self.assertRaises(credentials.SetupError) as caught:
            credentials.updates_for(SYNTHETIC_TOKEN, BrokenOpener())
        self.assertNotIn(SYNTHETIC_TOKEN, str(caught.exception))

    def test_first_install_replace_and_deny_all(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "credentials.json")
            payload = {"telegram_bot_token": SYNTHETIC_TOKEN, "telegram_destination": "123", "fixed_message": credentials.MESSAGE}
            credentials.install(path, payload, os.getuid(), os.getgid(), root_uid=os.getuid())
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            with self.assertRaises(credentials.SetupError):
                credentials.install(path, payload, os.getuid(), os.getgid(), root_uid=os.getuid())
            allowlist = os.path.join(tmp, "allowlist.json")
            Path(allowlist).write_text('{"version":1,"certificate_sha256_der":[]}')
            os.chmod(allowlist, 0o600)
            credentials.deny_all(allowlist)
            Path(allowlist).write_text('{"version":1,"certificate_sha256_der":["' + "a" * 64 + '"]}')
            with self.assertRaises(credentials.SetupError):
                credentials.deny_all(allowlist)
            payload["telegram_destination"] = "456"
            credentials.install(path, payload, os.getuid(), os.getgid(), replace=True, root_uid=os.getuid())
            self.assertEqual(json.loads(Path(path).read_text())["telegram_destination"], "456")
            self.assertEqual(list(Path(tmp).glob(".credentials-*")), [])


class FakeService:
    def __init__(self, active=False, start_results=None):
        self.running = active
        self.actions = []
        self.fail_check_once = False
        self.start_results = list(start_results or [])

    def active(self):
        return self.running

    def run(self, action):
        self.actions.append(action)
        self.running = (self.start_results.pop(0) if self.start_results else True) if action == "start" else False

    def check(self):
        self.actions.append("check")
        if self.fail_check_once:
            self.fail_check_once = False
            raise tls.SetupError("synthetic check failure")

    def require_active(self):
        self.actions.append("verify-active")
        if not self.running:
            raise tls.SetupError("synthetic start returned success but service is inactive")


def make_cert(folder, host, prefix):
    cert = os.path.join(folder, prefix + ".crt")
    key = os.path.join(folder, prefix + ".key")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3",
                    "-subj", "/CN=" + host, "-addext", "subjectAltName=DNS:" + host,
                    "-keyout", key, "-out", cert], check=True, capture_output=True)
    return cert, key


class TLSTests(unittest.TestCase):
    def test_system_service_detects_exit_inside_startup_window(self):
        service = tls.SystemService()
        with mock.patch.object(service, "active", side_effect=[True, False]) as active, mock.patch.object(tls.time, "sleep"):
            with self.assertRaises(tls.SetupError):
                service.require_active()
        self.assertEqual(active.call_count, 2)

    def test_hook_ignores_unrelated_lineage_and_requires_certbot_context(self):
        expected = "/etc/letsencrypt/live/relay.example.test"
        self.assertFalse(tls.selected_lineage("--deploy-hook", expected, "/etc/letsencrypt/live/other.example.test"))
        self.assertTrue(tls.selected_lineage("--deploy-hook", expected, expected))
        self.assertTrue(tls.selected_lineage("--install", expected, None))
        with self.assertRaises(tls.SetupError):
            tls.selected_lineage("--deploy-hook", expected, None)

    def test_config_rejects_inconsistent_host_and_duplicate_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "tls.json"
            config.write_text('{"hostname":"relay.example.test","lineage":"/etc/letsencrypt/live/other.example.test"}')
            config.chmod(0o600)
            with self.assertRaises(tls.SetupError):
                tls.load_config(str(config), root_uid=os.getuid())
            config.write_text('{"hostname":"relay.example.test","hostname":"other.example.test","lineage":"/etc/letsencrypt/live/other.example.test"}')
            with self.assertRaises(tls.SetupError):
                tls.load_config(str(config), root_uid=os.getuid())

    def test_lineage_guards(self):
        with tempfile.TemporaryDirectory() as tmp:
            live = Path(tmp) / "live" / "relay.example.test"
            archive = Path(tmp) / "archive" / "relay.example.test"
            live.mkdir(parents=True)
            archive.mkdir(parents=True)
            cert, key = make_cert(str(archive), "relay.example.test", "one")
            (live / "fullchain.pem").symlink_to(cert)
            (live / "privkey.pem").symlink_to(key)
            os.chmod(key, 0o600)
            self.assertEqual(tls.source_pair(str(live), tmp, root_uid=os.getuid()), [os.path.realpath(cert), os.path.realpath(key)])
            (live / "fullchain.pem").unlink()
            (live / "fullchain.pem").symlink_to(Path(tmp) / "elsewhere.pem")
            with self.assertRaises(tls.SetupError):
                tls.source_pair(str(live), tmp, root_uid=os.getuid())

    def test_initial_stopped_and_renewal_active(self):
        with tempfile.TemporaryDirectory() as tmp:
            cert, key = make_cert(tmp, "relay.example.test", "one")
            service = FakeService()
            tls.install_pair(cert, key, tmp, "relay.example.test", os.getuid(), os.getgid(), service,
                             trust=False, root_uid=os.getuid())
            self.assertEqual(service.actions, ["check"])
            self.assertFalse(service.running)
            self.assertEqual((Path(tmp) / tls.CERT).read_bytes(), Path(cert).read_bytes())
            self.assertEqual(os.stat(Path(tmp) / tls.KEY).st_mode & 0o777, 0o600)
            cert2, key2 = make_cert(tmp, "relay.example.test", "two")
            service.running = True
            tls.install_pair(cert2, key2, tmp, "relay.example.test", os.getuid(), os.getgid(), service,
                             trust=False, root_uid=os.getuid())
            self.assertEqual(service.actions[-4:], ["stop", "check", "start", "verify-active"])
            self.assertEqual((Path(tmp) / tls.CERT).read_bytes(), Path(cert2).read_bytes())
            self.assertFalse((Path(tmp) / ".install-transaction").exists())

    def test_invalid_pair_does_not_touch_service_or_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            cert, key = make_cert(tmp, "relay.example.test", "one")
            wrong_cert, wrong_key = make_cert(tmp, "other.example.test", "wrong")
            service = FakeService()
            tls.install_pair(cert, key, tmp, "relay.example.test", os.getuid(), os.getgid(), service,
                             trust=False, root_uid=os.getuid())
            before = (Path(tmp) / tls.CERT).read_bytes()
            service.actions.clear()
            with self.assertRaises(tls.SetupError):
                tls.install_pair(wrong_cert, wrong_key, tmp, "relay.example.test", os.getuid(), os.getgid(), service,
                                 trust=False, root_uid=os.getuid())
            self.assertEqual(service.actions, [])
            self.assertEqual((Path(tmp) / tls.CERT).read_bytes(), before)
            with self.assertRaises(tls.SetupError):
                tls.install_pair(cert, wrong_key, tmp, "relay.example.test", os.getuid(), os.getgid(), service,
                                 trust=False, root_uid=os.getuid())
            # A synthetic self-signed certificate must fail production trust validation.
            with self.assertRaises(tls.SetupError):
                tls.validate_pair(cert, key, "relay.example.test", trust=True)

    def test_trust_validation_accepts_matching_synthetic_anchor(self):
        with tempfile.TemporaryDirectory() as tmp:
            cert, key = make_cert(tmp, "relay.example.test", "anchor")
            tls.validate_pair(cert, key, "relay.example.test", trust=True, trust_store=cert)

    def test_hostname_mismatch_preserves_installed_pair_for_both_exit_behaviors(self):
        with tempfile.TemporaryDirectory() as tmp:
            cert, key = make_cert(tmp, "relay.example.test", "one")
            wrong_cert, wrong_key = make_cert(tmp, "other.example.test", "wrong")
            service = FakeService()
            tls.install_pair(cert, key, tmp, "relay.example.test", os.getuid(), os.getgid(), service,
                             trust=False, root_uid=os.getuid())
            before = {path.name: path.read_bytes() for path in Path(tmp).iterdir()}
            service.actions.clear()
            service.running = True
            actual_run = subprocess.run

            for exit_code in (0, 1):
                def checkhost_result(command, **kwargs):
                    if command[:2] == ["openssl", "x509"]:
                        self.assertEqual(command[-2:], ["-checkhost", "relay.example.test"])
                        self.assertTrue(kwargs["check"])
                        output = b"Hostname relay.example.test does NOT match certificate\n"
                        if exit_code:
                            raise subprocess.CalledProcessError(exit_code, command, output=output)
                        return subprocess.CompletedProcess(command, exit_code, stdout=output, stderr=b"")
                    return actual_run(command, **kwargs)

                with self.subTest(exit_code=exit_code), mock.patch.object(tls.subprocess, "run", side_effect=checkhost_result):
                    with self.assertRaises(tls.SetupError):
                        tls.install_pair(wrong_cert, wrong_key, tmp, "relay.example.test", os.getuid(), os.getgid(),
                                         service, trust=False, root_uid=os.getuid())
                self.assertEqual(service.actions, [])
                self.assertTrue(service.running)
                self.assertEqual({path.name: path.read_bytes() for path in Path(tmp).iterdir()}, before)

    def test_hostname_check_rejects_missing_or_unrecognized_success_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            cert, key = make_cert(tmp, "relay.example.test", "one")
            for output in (b"", b"Hostname other.example.test does match certificate\n",
                           b"Hostname relay.example.test does match certificate\nunexpected output\n"):
                result = subprocess.CompletedProcess([], 0, stdout=output, stderr=b"")
                with self.subTest(output=output), mock.patch.object(tls.subprocess, "run", return_value=result):
                    with self.assertRaises(tls.SetupError):
                        tls.validate_pair(cert, key, "relay.example.test", trust=False)

    def test_hostname_check_accepts_matching_wildcard_certificate(self):
        with tempfile.TemporaryDirectory() as tmp:
            cert, key = make_cert(tmp, "*.example.test", "wildcard")
            tls.validate_pair(cert, key, "relay.example.test", trust=False)
            with self.assertRaises(tls.SetupError):
                tls.validate_pair(cert, key, "relay.example.org", trust=False)

    def test_failed_check_rolls_back_prior_pair(self):
        with tempfile.TemporaryDirectory() as tmp:
            cert, key = make_cert(tmp, "relay.example.test", "one")
            cert2, key2 = make_cert(tmp, "relay.example.test", "two")
            service = FakeService(active=True)
            tls.install_pair(cert, key, tmp, "relay.example.test", os.getuid(), os.getgid(), service,
                             trust=False, root_uid=os.getuid())
            before = (Path(tmp) / tls.CERT).read_bytes()
            service.fail_check_once = True
            with self.assertRaises(tls.SetupError):
                tls.install_pair(cert2, key2, tmp, "relay.example.test", os.getuid(), os.getgid(), service,
                                 trust=False, root_uid=os.getuid())
            self.assertEqual((Path(tmp) / tls.CERT).read_bytes(), before)
            self.assertTrue(service.running)
            self.assertFalse((Path(tmp) / ".install-transaction").exists())

    def test_successful_start_returning_inactive_rolls_back_prior_pair(self):
        with tempfile.TemporaryDirectory() as tmp:
            cert, key = make_cert(tmp, "relay.example.test", "prior")
            next_cert, next_key = make_cert(tmp, "relay.example.test", "next")
            service = FakeService()
            tls.install_pair(cert, key, tmp, "relay.example.test", os.getuid(), os.getgid(), service,
                             trust=False, root_uid=os.getuid())
            prior = [(Path(tmp) / name).read_bytes() for name in (tls.CERT, tls.KEY)]
            service.running = True
            service.start_results = [False, True]
            with self.assertRaises(tls.SetupError):
                tls.install_pair(next_cert, next_key, tmp, "relay.example.test", os.getuid(), os.getgid(), service,
                                 trust=False, root_uid=os.getuid())
            self.assertEqual([(Path(tmp) / name).read_bytes() for name in (tls.CERT, tls.KEY)], prior)
            self.assertTrue(service.running)
            self.assertEqual(service.actions[-5:], ["start", "verify-active", "check", "start", "verify-active"])
            self.assertFalse((Path(tmp) / ".install-transaction").exists())

    def test_failed_restored_start_retains_transaction_for_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            cert, key = make_cert(tmp, "relay.example.test", "prior")
            next_cert, next_key = make_cert(tmp, "relay.example.test", "next")
            service = FakeService()
            tls.install_pair(cert, key, tmp, "relay.example.test", os.getuid(), os.getgid(), service,
                             trust=False, root_uid=os.getuid())
            prior = [(Path(tmp) / name).read_bytes() for name in (tls.CERT, tls.KEY)]
            service.running = True
            service.start_results = [False, False]
            with self.assertRaises(tls.SetupError):
                tls.install_pair(next_cert, next_key, tmp, "relay.example.test", os.getuid(), os.getgid(), service,
                                 trust=False, root_uid=os.getuid())
            txn = Path(tmp) / ".install-transaction"
            self.assertTrue((txn / tls.MARKER).is_file())
            self.assertEqual([(txn / name).read_bytes() for name in (tls.CERT, tls.KEY)], prior)
            self.assertEqual([(Path(tmp) / name).read_bytes() for name in (tls.CERT, tls.KEY)], prior)
            self.assertFalse(service.running)
            service.start_results = [True]
            self.assertTrue(tls._recover(tmp, os.getuid(), os.getgid(), service, os.getuid()))
            self.assertTrue(service.running)
            self.assertFalse(txn.exists())

    def test_recover_interrupted_first_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            txn = Path(tmp) / ".install-transaction"
            txn.mkdir(mode=0o700)
            marker = txn / tls.MARKER
            marker.write_text('{"version":1,"had_pair":false,"was_active":false}')
            marker.chmod(0o600)
            (Path(tmp) / tls.CERT).write_text("interrupted")
            (Path(tmp) / tls.CERT).chmod(0o600)
            service = FakeService()
            self.assertTrue(tls._recover(tmp, os.getuid(), os.getgid(), service, os.getuid()))
            self.assertFalse((Path(tmp) / tls.CERT).exists())
            self.assertFalse(service.running)

    def test_recover_interrupted_renewal_restores_prior_pair(self):
        with tempfile.TemporaryDirectory() as tmp:
            prior_cert, prior_key = make_cert(tmp, "relay.example.test", "prior")
            txn = Path(tmp) / ".install-transaction"
            txn.mkdir(mode=0o700)
            for name, source in ((tls.CERT, prior_cert), (tls.KEY, prior_key)):
                backup = txn / name
                backup.write_bytes(Path(source).read_bytes())
                backup.chmod(0o600)
            marker = txn / tls.MARKER
            marker.write_text('{"version":1,"had_pair":true,"was_active":true}')
            marker.chmod(0o600)
            installed = Path(tmp) / tls.CERT
            installed.write_text("interrupted")
            installed.chmod(0o600)
            service = FakeService()
            self.assertTrue(tls._recover(tmp, os.getuid(), os.getgid(), service, os.getuid()))
            self.assertEqual(installed.read_bytes(), Path(prior_cert).read_bytes())
            self.assertEqual((Path(tmp) / tls.KEY).read_bytes(), Path(prior_key).read_bytes())
            self.assertEqual(service.actions, ["check", "start", "verify-active"])

    def test_recovery_requires_both_backups_before_stopping_service(self):
        with tempfile.TemporaryDirectory() as tmp:
            txn = Path(tmp) / ".install-transaction"
            txn.mkdir(mode=0o700)
            marker = txn / tls.MARKER
            marker.write_text('{"version":1,"had_pair":true,"was_active":true}')
            marker.chmod(0o600)
            only_backup = txn / tls.CERT
            only_backup.write_text("synthetic prior certificate")
            only_backup.chmod(0o600)
            service = FakeService(active=True)
            with self.assertRaises(FileNotFoundError):
                tls._recover(tmp, os.getuid(), os.getgid(), service, os.getuid())
            self.assertTrue(service.running)
            self.assertEqual(service.actions, [])
            self.assertTrue(marker.exists())


if __name__ == "__main__":
    unittest.main()
