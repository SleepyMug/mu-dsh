"""Load and validate /etc/mu-dsh/config.toml."""

from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Listen:
    host: str
    port: int

    @classmethod
    def parse(cls, value: str, where: str) -> "Listen":
        m = re.fullmatch(r"\[([0-9a-fA-F:.]+)\]:(\d+)|([^:\[\]]+):(\d+)", value or "")
        if not m:
            raise ConfigError(f"{where}: expected HOST:PORT (IPv6 as [ADDR]:PORT), got {value!r}")
        host = m.group(1) or m.group(3)
        port = int(m.group(2) or m.group(4))
        if not 1 <= port <= 65535:
            raise ConfigError(f"{where}: port {port} out of range")
        return cls(host, port)


@dataclass(frozen=True)
class GatewayConfig:
    listen: Listen
    public_url: str  # normalized, no trailing slash
    session_max_age_days: int
    group: str  # group that may read gateway.json


@dataclass(frozen=True)
class RelayConfig:
    listen: Listen

    @property
    def base_url(self) -> str:
        host = f"[{self.listen.host}]" if ":" in self.listen.host else self.listen.host
        return f"http://{host}:{self.listen.port}/v1"


@dataclass(frozen=True)
class DshConfig:
    version: str
    npm_registry: str
    port_base: int
    node: str  # empty: find on PATH
    extra_args: tuple[str, ...]
    allow_scripts: tuple[str, ...]


@dataclass(frozen=True)
class LlmConfig:
    base_url: str
    api_key: str
    provider_id: str
    display_name: str
    api: str
    default_model: str
    models: tuple[dict, ...] = field(default_factory=tuple)
    compat: dict | None = None


@dataclass(frozen=True)
class Config:
    gateway: GatewayConfig
    relay: RelayConfig
    dsh: DshConfig
    llm: LlmConfig

    @property
    def public_host(self) -> str:
        return urlsplit(self.gateway.public_url).hostname or ""


# Packages whose npm install scripts dsh needs (as of dsh 0.2.1-rc.5); npm >= 11.20
# skips dependency install scripts that are not allowed by name.
DEFAULT_ALLOW_SCRIPTS = ["@deepseek-ai/dsh-subprocess-local", "koffi", "node-pty", "protobufjs", "@google/genai"]

_MODEL_KEYS = {
    "id": "id",
    "name": "name",
    "context_window": "contextWindow",
    "max_tokens": "maxTokens",
    "input": "input",
    "reasoning_efforts": "reasoningEfforts",
}


def _table(data: dict, key: str) -> dict:
    value = data.get(key, {})
    if not isinstance(value, dict):
        raise ConfigError(f"[{key}] must be a table")
    return value


def _str(table: dict, key: str, where: str, default: str | None = None) -> str:
    value = table.get(key, default)
    if value is None:
        raise ConfigError(f"{where}.{key} is required")
    if not isinstance(value, str):
        raise ConfigError(f"{where}.{key} must be a string")
    return value


def _int(table: dict, key: str, where: str, default: int) -> int:
    value = table.get(key, default)
    if not isinstance(value, int) or isinstance(value, bool):
        raise ConfigError(f"{where}.{key} must be an integer")
    return value


def _str_list(table: dict, key: str, where: str, default: list[str]) -> tuple[str, ...]:
    value = table.get(key, default)
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ConfigError(f"{where}.{key} must be a list of strings")
    return tuple(value)


def _http_url(value: str, where: str) -> str:
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ConfigError(f"{where} must be an http(s) URL, got {value!r}")
    return value.rstrip("/")


def _model(raw: object, index: int) -> dict:
    where = f"llm.models[{index}]"
    if not isinstance(raw, dict):
        raise ConfigError(f"{where} must be a table")
    model: dict = {}
    for key, value in raw.items():
        # Known snake_case keys map to dsh's camelCase; anything else passes through verbatim.
        model[_MODEL_KEYS.get(key, key)] = value
    if not isinstance(model.get("id"), str) or not model["id"]:
        raise ConfigError(f"{where}.id is required")
    return model


def parse(data: dict) -> Config:
    gw = _table(data, "gateway")
    public_url = _http_url(_str(gw, "public_url", "gateway"), "gateway.public_url")
    if urlsplit(public_url).path not in ("", "/"):
        raise ConfigError("gateway.public_url must not contain a path; mu-dsh serves from the root")
    gateway = GatewayConfig(
        listen=Listen.parse(_str(gw, "listen", "gateway", "0.0.0.0:8080"), "gateway.listen"),
        public_url=public_url,
        session_max_age_days=_int(gw, "session_max_age_days", "gateway", 30),
        group=_str(gw, "group", "gateway", "mu-dsh"),
    )

    rl = _table(data, "relay")
    relay = RelayConfig(listen=Listen.parse(_str(rl, "listen", "relay", "127.0.0.1:8401"), "relay.listen"))

    d = _table(data, "dsh")
    dsh = DshConfig(
        version=_str(d, "version", "dsh"),
        npm_registry=_str(d, "npm_registry", "dsh", ""),
        port_base=_int(d, "port_base", "dsh", 20000),
        node=_str(d, "node", "dsh", ""),
        extra_args=_str_list(d, "extra_args", "dsh", []),
        allow_scripts=_str_list(d, "allow_install_scripts", "dsh", DEFAULT_ALLOW_SCRIPTS),
    )
    if not 1024 <= dsh.port_base <= 65000:
        raise ConfigError("dsh.port_base must be between 1024 and 65000")

    l = _table(data, "llm")
    raw_models = l.get("models", [])
    if not isinstance(raw_models, list) or not raw_models:
        raise ConfigError("llm.models must list at least one model ([[llm.models]] tables)")
    models = tuple(_model(m, i) for i, m in enumerate(raw_models))
    ids = [m["id"] for m in models]
    default_model = _str(l, "default_model", "llm", ids[0])
    if default_model not in ids:
        raise ConfigError(f"llm.default_model {default_model!r} is not one of llm.models ({', '.join(ids)})")
    provider_id = _str(l, "provider_id", "llm", "mu-dsh")
    if not re.fullmatch(r"[a-z][a-z0-9-]*", provider_id):
        raise ConfigError("llm.provider_id must be a lowercase hyphenated identifier")
    api = _str(l, "api", "llm", "openai-completions")
    if api not in ("openai-completions", "openai-responses", "anthropic-messages"):
        raise ConfigError("llm.api must be openai-completions, openai-responses or anthropic-messages")
    compat = l.get("compat")
    if compat is not None and not isinstance(compat, dict):
        raise ConfigError("llm.compat must be a table")
    llm = LlmConfig(
        base_url=_http_url(_str(l, "base_url", "llm"), "llm.base_url"),
        api_key=_str(l, "api_key", "llm", ""),
        provider_id=provider_id,
        display_name=_str(l, "display_name", "llm", "Company LLM"),
        api=api,
        default_model=default_model,
        models=models,
        compat=compat,
    )
    return Config(gateway=gateway, relay=relay, dsh=dsh, llm=llm)


def load(path: Path) -> Config:
    try:
        with open(path, "rb") as f:
            data = tomllib.load(f)
    except FileNotFoundError:
        raise ConfigError(f"{path}: not found") from None
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"{path}: {e}") from None
    try:
        return parse(data)
    except ConfigError as e:
        raise ConfigError(f"{path}: {e}") from None


class ConfigFile:
    """config.toml on disk; ``load()`` re-reads it each time (for reloads)."""

    def __init__(self, path: Path):
        self.path = path

    def load(self) -> Config:
        return load(self.path)
