"""AI / OCR provider abstraction.

Three implementations, all real:

  local     — zero-network heuristic extractor. Reads nothing but file metadata
              and returns an empty field set with `needs_review=True`. This is
              the honest default: we do not pretend to OCR without an engine.
  cloud     — OpenAI-compatible vision endpoint (works with OpenAI, Azure
              OpenAI, DeepSeek-VL gateways, local vLLM, Ollama, ...).
  disabled  — hard off switch for privacy-sensitive deployments.

The important part is the contract: `extract()` returns *suggestions* that a
human must confirm. Nothing is written to the database automatically.
"""

from __future__ import annotations

import base64
import json
import logging
import re
from abc import ABC, abstractmethod
from typing import Any

from ..config import settings

log = logging.getLogger("homeledger.ai")

SALE_FIELDS = [
    "name",
    "brand",
    "model",
    "serial_number",
    "barcode",
    "purchase_price",
    "purchase_date",
    "purchase_from",
    "warranty_until",
]


class AIProvider(ABC):
    name: str = "base"
    supports_vision: bool = False
    leaves_device: bool = False

    @abstractmethod
    def extract(
        self, image: bytes | None, *, mime: str = "image/jpeg", hint: str = ""
    ) -> dict[str, Any]: ...

    def describe(self) -> dict:
        return {
            "name": self.name,
            "supports_vision": self.supports_vision,
            "leaves_device": self.leaves_device,
            "privacy_notice": (
                "图片将上传到配置的云端 AI 服务进行识别" if self.leaves_device else "识别在本地完成，图片不会离开设备"
            ),
        }


class DisabledAIProvider(AIProvider):
    name = "disabled"

    def extract(self, image: bytes | None, *, mime: str = "image/jpeg", hint: str = "") -> dict:
        return {
            "fields": {},
            "confidence": 0.0,
            "needs_review": True,
            "text": "",
            "provider": self.name,
            "message": "AI 识别已在此部署中关闭。",
        }


class LocalHeuristicProvider(AIProvider):
    """No network, no model. Returns a scaffold for manual completion."""

    name = "local"

    def extract(self, image: bytes | None, *, mime: str = "image/jpeg", hint: str = "") -> dict:
        text = ""
        fields: dict[str, Any] = {}
        # Very light-weight signal extraction from the hint / filename.
        if hint:
            m = re.search(r"\b(\d{13}|\d{12}|\d{8})\b", hint)
            if m:
                fields["barcode"] = m.group(1)
            price = re.search(r"[¥￥]\s*(\d+(?:\.\d{1,2})?)", hint)
            if price:
                fields["purchase_price"] = float(price.group(1))
        return {
            "fields": fields,
            "confidence": 0.15 if fields else 0.0,
            "needs_review": True,
            "text": text,
            "provider": self.name,
            "message": "本地模式未安装 OCR 引擎。已保留图片，请手动补全字段，或配置云端识别。",
        }


class CloudAIProvider(AIProvider):
    """OpenAI-compatible chat/completions vision call."""

    name = "cloud"
    supports_vision = True
    leaves_device = True

    PROMPT = (
        "你是家庭物品管理系统的录入助手。请从这张小票/保修卡/商品标签图片中提取信息，"
        "只输出 JSON，不要解释。字段：name(物品名称), brand(品牌), model(型号), "
        "serial_number(序列号), barcode(商品条码，仅数字), purchase_price(数字，元), "
        "purchase_date(YYYY-MM-DD), purchase_from(商家), warranty_until(YYYY-MM-DD)。"
        "无法确定的字段请省略。"
    )

    def extract(self, image: bytes | None, *, mime: str = "image/jpeg", hint: str = "") -> dict:
        if not (settings.ai_endpoint and settings.ai_api_key):
            return {
                "fields": {},
                "confidence": 0.0,
                "needs_review": True,
                "text": "",
                "provider": self.name,
                "message": "云端识别未配置 HOMELEDGER_AI_ENDPOINT / HOMELEDGER_AI_API_KEY。",
            }
        try:
            import httpx

            url = settings.ai_endpoint.rstrip("/")
            if not url.endswith("/chat/completions"):
                url = url + "/chat/completions"
            content: list[dict[str, Any]] = [{"type": "text", "text": self.PROMPT}]
            if image:
                b64 = base64.b64encode(image).decode("ascii")
                content.append(
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}
                )
            resp = httpx.post(
                url,
                headers={
                    "Authorization": f"Bearer {settings.ai_api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "gpt-4o-mini",
                    "messages": [{"role": "user", "content": content}],
                    "temperature": 0,
                    "response_format": {"type": "json_object"},
                },
                timeout=45,
            )
            resp.raise_for_status()
            raw = resp.json()["choices"][0]["message"]["content"]
            data = json.loads(raw) if raw.strip().startswith("{") else {}
            fields = {k: v for k, v in data.items() if k in SALE_FIELDS and v not in ("", None)}
            return {
                "fields": fields,
                "confidence": 0.8 if fields else 0.2,
                "needs_review": True,
                "text": raw[:2000],
                "provider": self.name,
                "message": "云端识别完成，请人工核对后保存。",
            }
        except Exception as exc:
            log.warning("cloud ai failed: %s", exc)
            return {
                "fields": {},
                "confidence": 0.0,
                "needs_review": True,
                "text": "",
                "provider": self.name,
                "message": f"云端识别失败：{exc}",
            }


_instances: dict[str, AIProvider] = {
    "local": LocalHeuristicProvider(),
    "cloud": CloudAIProvider(),
    "disabled": DisabledAIProvider(),
}


def get_ai_provider() -> AIProvider:
    return _instances.get(settings.ai_provider, _instances["local"])


def all_providers() -> list[dict]:
    return [p.describe() for p in _instances.values()]
