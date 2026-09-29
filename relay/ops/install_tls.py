#!/usr/bin/env python3
"""Install one Certbot lineage as regular relay-owned files, with recovery."""

import fcntl
import json
import os
import pwd
import re
import shutil
import ssl
import stat
import subprocess
import sys
import tempfile
import time

CONFIG = "/etc/babymonkey-relay/tls-install.json"
TLS_DIR = "/etc/babymonkey-relay/tls"
SERVICE = "babymonkey-relay.service"
CHECK = ["runuser", "-u", "babymonkey-relay", "--", "/opt/babymonkey-relay/current/babymonkey-relay", "-config", "/etc/babymonkey-relay/relay.json", "-check"]
CERT = "server-certificate.pem"
KEY = "server-private-key.pem"
MARKER = "transaction.json"


class SetupError(Exception):
    pass


def private_file(path, owner=None):
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or (owner is not None and info.st_uid != owner):
        raise SetupError("Expected a private regular file")
    return info


def load_config(path=CONFIG, root_uid=0):
    private_file(path, root_uid)
    with open(path, "rb") as source:
        raw = source.read(4097)
    if len(raw) > 4096:
        raise SetupError("TLS configuration is too large")
    try:
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError("duplicate key")
                result[key] = value
            return result
        data = json.loads(raw, object_pairs_hook=unique)
    except ValueError:
        raise SetupError("TLS configuration is invalid") from None
    if not isinstance(data, dict) or set(data) != {"hostname", "lineage"}:
        raise SetupError("TLS configuration has unexpected fields")
    host = data["hostname"]
    lineage = data["lineage"]
    if (not isinstance(host, str) or len(host) > 253 or len(host.split(".")) < 2 or
            any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                for label in host.split("."))):
        raise SetupError("TLS hostname is invalid")
    if lineage != "/etc/letsencrypt/live/" + host:
        raise SetupError("TLS lineage must be the exact configured hostname")
    return data


def source_pair(lineage, root="/etc/letsencrypt", root_uid=0):
    """Accept Certbot's live symlinks only when their targets remain in this lineage archive."""
    name = os.path.basename(lineage)
    expected_live = os.path.join(root, "live", name)
    if lineage != expected_live:
        raise SetupError("Unexpected certificate lineage")
    live_info = os.lstat(lineage)
    if not stat.S_ISDIR(live_info.st_mode) or live_info.st_uid != root_uid or live_info.st_mode & 0o022:
        raise SetupError("Certificate live directory is unsafe")
    archive_directory = os.path.join(root, "archive", name)
    archive_info = os.lstat(archive_directory)
    if not stat.S_ISDIR(archive_info.st_mode) or archive_info.st_uid != root_uid or archive_info.st_mode & 0o022:
        raise SetupError("Certificate archive directory is unsafe")
    result = []
    for filename in ("fullchain.pem", "privkey.pem"):
        link = os.path.join(lineage, filename)
        if not stat.S_ISLNK(os.lstat(link).st_mode):
            raise SetupError("Certbot live entry must be a symlink")
        target = os.path.realpath(link)
        archive = os.path.realpath(archive_directory) + os.sep
        if not target.startswith(archive) or os.path.dirname(target) != archive.rstrip(os.sep):
            raise SetupError("Certificate link escaped its archive")
        info = os.lstat(target)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != root_uid or not 0 < info.st_size <= 65536:
            raise SetupError("Certificate archive entry is invalid")
        if filename == "privkey.pem" and info.st_mode & 0o077:
            raise SetupError("Certificate private key is not private")
        result.append(target)
    return result


def validate_pair(cert, key, hostname, *, trust=True, trust_store="/etc/ssl/certs"):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    try:
        context.load_cert_chain(cert, key)
        decoded = ssl._ssl._test_decode_cert(cert)
        subprocess.run(["openssl", "x509", "-in", cert, "-noout", "-checkhost", hostname],
                       check=True, capture_output=True, timeout=10)
        if ssl.cert_time_to_seconds(decoded["notBefore"]) > time.time() or ssl.cert_time_to_seconds(decoded["notAfter"]) <= time.time() + 86400:
            raise SetupError("Certificate is not currently valid for at least one day")
        if trust:
            trust_option = "-CApath" if os.path.isdir(trust_store) else "-CAfile"
            subprocess.run(["openssl", "verify", "-purpose", "sslserver", "-verify_hostname", hostname,
                            trust_option, trust_store, "-untrusted", cert, cert], check=True, capture_output=True, timeout=10)
    except SetupError:
        raise
    except Exception:
        raise SetupError("TLS pair failed key, hostname, validity, or trust validation") from None


def write_private(path, data, uid, gid, *, exclusive=False):
    parent = os.path.dirname(path)
    fd, staged = tempfile.mkstemp(prefix=".tls-", dir=parent)
    try:
        os.fchmod(fd, 0o600)
        os.fchown(fd, uid, gid)
        with os.fdopen(fd, "wb") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        if exclusive:
            os.link(staged, path, follow_symlinks=False)
            os.unlink(staged)
        else:
            os.replace(staged, path)
    finally:
        if os.path.exists(staged):
            os.unlink(staged)
    sync_dir(parent)


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class SystemService:
    def run(self, *args):
        subprocess.run(["systemctl", *args, SERVICE], check=True, capture_output=True, timeout=25)

    def active(self):
        result = subprocess.run(["systemctl", "is-active", "--quiet", SERVICE], capture_output=True, timeout=10)
        if result.returncode not in (0, 3):
            raise SetupError("Cannot determine relay service state")
        return result.returncode == 0

    def check(self):
        subprocess.run(CHECK, check=True, capture_output=True, timeout=15)

    def require_active(self):
        # Type=simple may report a successful start before an immediate process
        # exit. Require uninterrupted active state through a short bounded window.
        deadline = time.monotonic() + 1.0
        while True:
            if not self.active():
                raise SetupError("Relay did not remain active after start")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            time.sleep(min(0.1, remaining))


def _read_bytes(path, limit=65536):
    with open(path, "rb") as source:
        data = source.read(limit + 1)
    if len(data) > limit:
        raise SetupError("TLS input exceeded size limit")
    return data


def _recover(tls_dir, uid, gid, service, root_uid=0):
    txn = os.path.join(tls_dir, ".install-transaction")
    marker = os.path.join(txn, MARKER)
    if not os.path.exists(marker):
        if os.path.exists(txn):
            raise SetupError("Incomplete TLS transaction staging needs owner inspection")
        return False
    private_file(marker, root_uid)
    with open(marker, "r", encoding="ascii") as source:
        state = json.load(source)
    if set(state) != {"version", "had_pair", "was_active"} or state["version"] != 1 or not isinstance(state["had_pair"], bool) or not isinstance(state["was_active"], bool):
        raise SetupError("TLS transaction marker is invalid")
    backups = {}
    if state["had_pair"]:
        # Validate both backups before stopping a currently healthy service.
        for filename in (CERT, KEY):
            backup = os.path.join(txn, filename)
            private_file(backup, root_uid)
            backups[filename] = _read_bytes(backup)
    if service.active():
        service.run("stop")
    for filename in (CERT, KEY):
        target = os.path.join(tls_dir, filename)
        if state["had_pair"]:
            write_private(target, backups[filename], uid, gid)
        elif os.path.lexists(target):
            private_file(target, uid)
            os.unlink(target)
    sync_dir(tls_dir)
    if state["had_pair"]:
        service.check()
    if state["was_active"]:
        service.run("start")
        service.require_active()
    shutil.rmtree(txn)
    sync_dir(tls_dir)
    return True


def install_pair(cert, key, tls_dir, hostname, uid, gid, service, *, trust=True, root_uid=0):
    directory = os.lstat(tls_dir)
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != root_uid or directory.st_mode & 0o022:
        raise SetupError("TLS destination must be root owned and non-writable by others")
    lock_path = os.path.join(tls_dir, ".install.lock")
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        private_file(lock_path, root_uid)
        _recover(tls_dir, uid, gid, service, root_uid)
        validate_pair(cert, key, hostname, trust=trust)
        targets = [os.path.join(tls_dir, CERT), os.path.join(tls_dir, KEY)]
        exists = [os.path.lexists(path) for path in targets]
        if exists[0] != exists[1]:
            raise SetupError("Only one installed TLS file exists; inspect before retry")
        if exists[0]:
            for target in targets:
                private_file(target, uid)
        was_active = service.active()
        txn = os.path.join(tls_dir, ".install-transaction")
        os.mkdir(txn, 0o700)
        try:
            if exists[0]:
                for target in targets:
                    write_private(os.path.join(txn, os.path.basename(target)), _read_bytes(target), root_uid, gid, exclusive=True)
            write_private(os.path.join(txn, MARKER), json.dumps({"version": 1, "had_pair": exists[0], "was_active": was_active}).encode(), root_uid, gid, exclusive=True)
            if was_active:
                service.run("stop")
            for source, target in zip((cert, key), targets):
                write_private(target, _read_bytes(source), uid, gid, exclusive=not exists[0])
            service.check()
            if was_active:
                service.run("start")
                service.require_active()
            shutil.rmtree(txn)
            sync_dir(tls_dir)
        except Exception:
            if os.path.exists(os.path.join(txn, MARKER)):
                _recover(tls_dir, uid, gid, service, root_uid)
            else:
                shutil.rmtree(txn)
            raise
    finally:
        os.close(lock_fd)


def selected_lineage(mode, configured, renewed):
    if mode != "--deploy-hook":
        return True
    if not renewed:
        raise SetupError("Certbot did not provide a renewed lineage")
    return renewed == configured


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("--install", "--deploy-hook", "--recover"):
        raise SetupError("Use: install_tls.py --install|--deploy-hook|--recover")
    if os.geteuid() != 0:
        raise SetupError("Run TLS installation as root")
    owner = pwd.getpwnam("babymonkey-relay")
    service = SystemService()
    if sys.argv[1] == "--recover":
        lock = os.open(os.path.join(TLS_DIR, ".install.lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
            private_file(os.path.join(TLS_DIR, ".install.lock"), 0)
            _recover(TLS_DIR, owner.pw_uid, owner.pw_gid, service)
        finally:
            os.close(lock)
        return
    config = load_config()
    lineage = config["lineage"]
    if not selected_lineage(sys.argv[1], lineage, os.environ.get("RENEWED_LINEAGE")):
        return  # global deploy hook: unrelated lineages are untouched
    cert, key = source_pair(lineage)
    install_pair(cert, key, TLS_DIR, config["hostname"], owner.pw_uid, owner.pw_gid, service)


if __name__ == "__main__":
    try:
        main()
    except (SetupError, OSError, subprocess.SubprocessError, ValueError, KeyboardInterrupt):
        # subprocess stderr may contain private paths; never relay it to logs.
        print("TLS installation failed; inspect the configured lineage and recovery marker privately", file=sys.stderr)
        sys.exit(1)
