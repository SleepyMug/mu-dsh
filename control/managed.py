"""Content of the two files mu-dsh owns inside each user's ~/.dsh:

* ``cordis.patch.yml`` — the home-level patch layer dsh applies to every
  profile after the profile's own patch. mu-dsh rewrites it whole.
* a marked block inside ``.env`` carrying the user's relay key.
"""

from __future__ import annotations

import json
import re

from control.config import Config

PATCH_MARKER = "# Managed by mu-dsh"
ENV_BEGIN = "# >>> mu-dsh managed >>>"
ENV_END = "# <<< mu-dsh managed <<<"
LLM_KEY_ENV = "MUDSH_LLM_KEY"

_PLAIN_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_.-]*")


def _scalar(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)  # a JSON string is a valid YAML double-quoted scalar
    raise TypeError(f"cannot emit {type(value).__name__} as YAML")


def _key(key: str) -> str:
    return key if _PLAIN_KEY.fullmatch(key) else json.dumps(key, ensure_ascii=False)


def _emit(value: object, indent: int) -> list[str]:
    pad = "  " * indent
    if isinstance(value, dict):
        if not value:
            return [pad + "{}"]
        lines = []
        for k, v in value.items():
            if isinstance(v, (dict, list)) and v:
                lines.append(f"{pad}{_key(k)}:")
                lines += _emit(v, indent + 1)
            elif isinstance(v, (dict, list)):
                lines.append(f"{pad}{_key(k)}: {'{}' if isinstance(v, dict) else '[]'}")
            else:
                lines.append(f"{pad}{_key(k)}: {_scalar(v)}")
        return lines
    if isinstance(value, list):
        if not value:
            return [pad + "[]"]
        lines = []
        for item in value:
            sub = _emit(item, indent + 1)
            lines.append(f"{pad}- {sub[0].lstrip()}")
            lines += sub[1:]
        return lines
    return [pad + _scalar(value)]


def to_yaml(value: object) -> str:
    return "\n".join(_emit(value, 0)) + "\n"


def patch_entries(config: Config) -> list[dict]:
    llm = config.llm
    provider: dict = {
        "displayName": llm.display_name,
        "api": llm.api,
        "baseURL": config.relay.base_url,
        "apiKeyEnv": LLM_KEY_ENV,
        "models": [dict(m) for m in llm.models],
    }
    if llm.compat:
        provider["compat"] = llm.compat
    return [
        {"id": "llm-pi-ai", "config": {"providers": {llm.provider_id: provider}}},
        {"id": "agent-default-model", "config": {"provider": llm.provider_id, "model": llm.default_model}},
        # Web search goes to DeepSeek's official API with DEEPSEEK_API_KEY; not available on-prem.
        {"id": "web-search-deepseek", "disabled": True},
        {"id": "web-deepseek-api", "disabled": True},
        {"id": "session-telemetry-otel", "config": {"mode": "DISABLED"}},
    ]


def patch_text(config: Config) -> str:
    header = (
        f"{PATCH_MARKER}; this file is rewritten whenever mu-dsh starts or reloads.\n"
        "# Put your own changes in ~/.dsh/profiles/<profile>/cordis.patch.yml instead;\n"
        "# note that rows set here (model provider, default model, web search,\n"
        "# telemetry) take precedence over the same rows there.\n"
    )
    return header + to_yaml(patch_entries(config))


def env_block(llm_key: str) -> str:
    return f"{ENV_BEGIN}\n{LLM_KEY_ENV}={llm_key}\n{ENV_END}\n"
