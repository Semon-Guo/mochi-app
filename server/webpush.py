#!/usr/bin/env python3
"""Web Push（RFC 8291 消息加密 + RFC 8292 VAPID）的最小实现。

只依赖系统已有的 cryptography 库，不引入 pywebpush 那一串依赖——这台机器
装包一直不顺，能少一个是一个。

密码学代码不能靠「看起来对」，所以 test_webpush.py 用 RFC 8291 §5 的官方
测试向量逐字节比对加密结果。

推送内容是端到端加密的：Apple / Google 的推送服务转发时看不到明文，
只知道「某设备在某时刻收到一条多大的消息」。
"""
import base64
import json
import os
import struct
import time
import urllib.request
import urllib.error
from urllib.parse import urlparse

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils as asym_utils
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

CURVE = ec.SECP256R1()


def b64d(s: str) -> bytes:
    """base64url 解码，补回被省略的填充。"""
    if isinstance(s, bytes):
        s = s.decode()
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _hkdf(salt: bytes, ikm: bytes, info: bytes, length: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


def _pub_bytes(pub) -> bytes:
    """未压缩点格式 0x04||X||Y，共 65 字节——Web Push 里到处用的就是这个。"""
    return pub.public_bytes(serialization.Encoding.X962,
                            serialization.PublicFormat.UncompressedPoint)


# ─────────────────────────── VAPID ───────────────────────────

def generate_vapid_keys():
    """生成一对 VAPID 密钥；公钥要交给前端做 applicationServerKey。"""
    priv = ec.generate_private_key(CURVE)
    priv_raw = priv.private_numbers().private_value.to_bytes(32, "big")
    return {"private": b64e(priv_raw), "public": b64e(_pub_bytes(priv.public_key()))}


def load_vapid_private(b64_priv: str):
    return ec.derive_private_key(int.from_bytes(b64d(b64_priv), "big"), CURVE)


def vapid_headers(endpoint: str, private_b64: str, public_b64: str, subject: str) -> dict:
    """按 RFC 8292 生成 Authorization 头。aud 必须是 endpoint 的 origin。"""
    u = urlparse(endpoint)
    claims = {"aud": f"{u.scheme}://{u.netloc}",
              "exp": int(time.time()) + 12 * 3600,
              "sub": subject}
    header = b64e(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    body = b64e(json.dumps(claims, separators=(",", ":")).encode())
    signing_input = f"{header}.{body}".encode()

    der = load_vapid_private(private_b64).sign(signing_input, ec.ECDSA(hashes.SHA256()))
    # JWS 要的是定长 r||s，而 cryptography 给的是 DER，必须转换
    r, s = asym_utils.decode_dss_signature(der)
    sig = b64e(r.to_bytes(32, "big") + s.to_bytes(32, "big"))

    return {"Authorization": f"vapid t={header}.{body}.{sig}, k={public_b64}"}


# ─────────────────────── 消息加密（aes128gcm） ───────────────────────

def encrypt(payload: bytes, ua_public_b64: str, auth_secret_b64: str,
            salt: bytes = None, server_key=None) -> bytes:
    """RFC 8291。salt / server_key 只在测试里注入，生产一律随机。"""
    ua_public = ec.EllipticCurvePublicKey.from_encoded_point(CURVE, b64d(ua_public_b64))
    auth_secret = b64d(auth_secret_b64)
    salt = salt or os.urandom(16)
    server_key = server_key or ec.generate_private_key(CURVE)
    as_public = _pub_bytes(server_key.public_key())

    shared = server_key.exchange(ec.ECDH(), ua_public)
    # 注意顺序：先接收方公钥，再发送方公钥，反了就解不开
    key_info = b"WebPush: info\x00" + _pub_bytes(ua_public) + as_public
    ikm = _hkdf(auth_secret, shared, key_info, 32)

    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)

    # 单条记录，0x02 是「最后一条」的分隔符
    ciphertext = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)

    # 头部：salt(16) | rs(4) | idlen(1) | 发送方公钥(65)
    return salt + struct.pack("!IB", 4096, len(as_public)) + as_public + ciphertext


# ─────────────────────────── 发送 ───────────────────────────

class PushGone(Exception):
    """订阅已失效（404/410），调用方应当把它从库里删掉。"""


def send(subscription: dict, data: dict, vapid: dict, ttl: int = 3600, timeout: int = 10):
    """向一个订阅推送一条消息。成功返回状态码，订阅失效则抛 PushGone。"""
    endpoint = subscription["endpoint"]
    keys = subscription.get("keys") or {}
    body = encrypt(json.dumps(data, ensure_ascii=False).encode(), keys["p256dh"], keys["auth"])

    headers = {
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": str(ttl),
        **vapid_headers(endpoint, vapid["private"], vapid["public"], vapid["subject"]),
    }
    req = urllib.request.Request(endpoint, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status
    except urllib.error.HTTPError as e:
        if e.code in (404, 410):
            raise PushGone(f"订阅已失效 HTTP {e.code}") from e
        detail = ""
        try:
            detail = e.read()[:200].decode("utf-8", "replace")
        except Exception:
            pass
        raise RuntimeError(f"推送失败 HTTP {e.code} {detail}") from e
