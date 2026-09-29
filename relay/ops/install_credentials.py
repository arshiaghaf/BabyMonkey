#!/usr/bin/env python3
"""Owner-only, attached-terminal installer for the relay's fixed credentials."""

import json
import os
import pwd
import re
import stat
import sys
import tempfile
import termios
import urllib.request

TARGET = "/etc/babymonkey-relay/credentials.json"
ALLOWLIST = "/etc/babymonkey-relay/allowlist.json"
MESSAGE = "Please reach out when you can."
TOKEN = re.compile(r"^[0-9]{6,12}:[A-Za-z0-9_-]{30,64}$")
CHAT = re.compile(r"^-?[0-9]{1,20}$")


class SetupError(Exception):
    pass


def updates_for(token, opener=None):
    # Telegram requires the bot token in the API path. It is never put in argv,
    # the environment, a browser, a log, or a shell command.
    if opener is None:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(
        "https://api.telegram.org/bot" + token + "/getUpdates",
        data=b'{"limit":100,"timeout":0,"allowed_updates":["message"]}',
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with opener.open(request, timeout=10) as response:
            if response.status != 200:
                raise SetupError("Bot API query failed")
            raw = response.read(65537)
    except Exception:
        raise SetupError("Bot API query failed; check the bot token and webhook state privately") from None
    if len(raw) > 65536:
        raise SetupError("Bot API response exceeded the limit")
    try:
        data = json.loads(raw)
        if data.get("ok") is not True or not isinstance(data.get("result"), list):
            raise ValueError()
        result = data["result"]
    except (ValueError, AttributeError, TypeError):
        raise SetupError("Bot API response was invalid") from None
    if len(result) >= 100:
        raise SetupError("Too many pending updates to identify one destination safely")
    return result


def private_destination(updates):
    chats = set()
    for update in updates:
        if not isinstance(update, dict):
            raise SetupError("Malformed update")
        message = update.get("message")
        if not isinstance(message, dict):
            continue
        text = message.get("text")
        if not isinstance(text, str) or not re.fullmatch(r"/start(?:@[A-Za-z0-9_]+)?", text):
            continue
        chat = message.get("chat")
        if not isinstance(chat, dict) or chat.get("type") != "private":
            raise SetupError("A /start update did not come from a private chat")
        chat_id = chat.get("id")
        if isinstance(chat_id, bool) or not isinstance(chat_id, int) or not CHAT.fullmatch(str(chat_id)):
            raise SetupError("Invalid private chat identifier")
        chats.add(str(chat_id))
    if len(chats) != 1:
        raise SetupError("Expected exactly one distinct private /start chat")
    return chats.pop()


def secure_existing(path, owner=None):
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or (owner is not None and info.st_uid != owner):
        raise SetupError("Existing owner file is not a private regular file")
    return info


def install(path, payload, uid, gid, replace=False, root_uid=0):
    parent = os.path.dirname(path)
    directory = os.lstat(parent)
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != root_uid or directory.st_mode & 0o022:
        raise SetupError("Credential directory must be root owned and non-writable by others")
    old = None
    try:
        old = secure_existing(path, uid)
    except FileNotFoundError:
        pass
    if replace != (old is not None):
        raise SetupError("Install/replacement mode does not match existing credential state")
    fd, staged = tempfile.mkstemp(prefix=".credentials-", dir=parent)
    try:
        os.fchmod(fd, 0o600)
        os.fchown(fd, uid, gid)
        with os.fdopen(fd, "wb") as out:
            out.write(json.dumps(payload, separators=(",", ":")).encode() + b"\n")
            out.flush()
            os.fsync(out.fileno())
        if replace:
            now = secure_existing(path, uid)
            if not os.path.samestat(old, now):
                raise SetupError("Credentials changed during replacement")
            os.replace(staged, path)
        else:
            os.link(staged, path, follow_symlinks=False)  # exclusive, atomic first install
            os.unlink(staged)
        directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(staged):
            os.unlink(staged)


def deny_all(path=ALLOWLIST, owner=None):
    secure_existing(path, owner)
    with open(path, "rb") as source:
        raw = source.read(4097)
    if len(raw) > 4096:
        raise SetupError("Allowlist is too large")
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
        raise SetupError("Allowlist is invalid") from None
    if data != {"version": 1, "certificate_sha256_der": []}:
        raise SetupError("Replacement requires the relay allowlist to be deny-all")


def hidden_token(reader, writer):
    try:
        original = termios.tcgetattr(reader.fileno())
        hidden = original.copy()
        hidden[3] &= ~termios.ECHO
        termios.tcsetattr(reader.fileno(), termios.TCSANOW, hidden)
    except (OSError, termios.error):
        raise SetupError("Cannot disable terminal echo") from None
    prompt_complete = False
    try:
        writer.write("New bot token: ")
        writer.flush()
        prompt_complete = True
        value = reader.readline()
        if not value:
            raise SetupError("Token input was cancelled")
        return value.rstrip("\r\n")
    finally:
        termios.tcsetattr(reader.fileno(), termios.TCSANOW, original)
        if prompt_complete:
            writer.write("\n")
            writer.flush()


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("install", "replace"):
        raise SetupError("Use: sudo python3 install_credentials.py install|replace")
    if os.geteuid() != 0:
        raise SetupError("Run as root from an attached terminal")
    with open("/dev/tty", "r") as reader, open("/dev/tty", "w") as writer:
        if not os.isatty(reader.fileno()) or not os.isatty(writer.fileno()):
            raise SetupError("An attached terminal is required")
        replace = sys.argv[1] == "replace"
        owner = pwd.getpwnam("babymonkey-relay")
        if replace:
            secure_existing(TARGET, owner.pw_uid)
            deny_all(owner=owner.pw_uid)
            writer.write("Verify notifications are disabled in D1 using the owner CLI. This helper cannot verify D1. Type REPLACE only after that check: ")
            writer.flush()
            if reader.readline().strip() != "REPLACE":
                raise SetupError("Replacement was not confirmed")
        elif os.path.lexists(TARGET):
            raise SetupError("Credentials already exist; inspect before replacement")
        token = hidden_token(reader, writer)
        if not TOKEN.fullmatch(token):
            raise SetupError("Bot token format is invalid")
        destination = private_destination(updates_for(token))
        writer.write("Exactly one private /start chat was found. Verify the intended recipient privately, then type INSTALL: ")
        writer.flush()
        if reader.readline().strip() != "INSTALL":
            raise SetupError("Installation was not confirmed")
        install(TARGET, {"telegram_bot_token": token, "telegram_destination": destination,
                         "fixed_message": MESSAGE}, owner.pw_uid, owner.pw_gid, replace)
        writer.write("Credentials installed. Run the relay -check after TLS, CA, and replay files are installed.\n")


if __name__ == "__main__":
    try:
        main()
    except (SetupError, OSError, EOFError, KeyboardInterrupt) as exc:
        # Never print network exceptions, paths containing a token, or response bodies.
        print("Credential installation failed: " + (str(exc) if isinstance(exc, SetupError) else "file or terminal error"), file=sys.stderr)
        sys.exit(1)
