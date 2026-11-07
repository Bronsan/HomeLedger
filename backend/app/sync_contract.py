"""Validated protocol bounds shared by the sync endpoints."""
from __future__ import annotations

import base64
import binascii
from typing import Literal

from pydantic import BaseModel, Field, StrictInt, field_validator, model_validator


class SyncKeyIn(BaseModel):
    kdf: Literal["argon2id"] = "argon2id"
    salt: str = Field(max_length=64)
    memory_kib: StrictInt = Field(ge=19456, le=131072)
    iterations: StrictInt = Field(ge=2, le=6)
    parallelism: StrictInt = Field(ge=1, le=4)
    wrapped_dek: str = Field(max_length=128)
    verifier: str = Field(max_length=128)
    rotate: bool = False

    @field_validator("salt", "wrapped_dek", "verifier")
    @classmethod
    def check_bytes(cls, value, info):
        try:
            raw = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError):
            raise ValueError("密钥材料不是有效 Base64")
        expected = {"salt": 16, "wrapped_dek": 72, "verifier": 50}[info.field_name]
        if len(raw) != expected or base64.b64encode(raw).decode() != value:
            raise ValueError("密钥材料长度或格式不正确")
        return value

    @model_validator(mode="after")
    def check_work(self):
        if self.memory_kib * self.iterations > 393216:
            raise ValueError("密钥派生参数超过资源预算")
        return self


class SyncResetIn(BaseModel):
    confirm_head: StrictInt = Field(ge=0)
