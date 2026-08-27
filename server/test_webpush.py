#!/usr/bin/env python3
"""用 RFC 8291 §5 的官方测试向量验证消息加密。

自己实现密码学协议最大的风险是「跑通了但其实是错的」——密文格式稍有偏差，
浏览器会静默丢弃通知，而服务端看到的是 201 成功。所以这里拿 RFC 里给定的
输入逐字节比对输出，任何一步偏了都会立刻暴露。
"""
import sys

from webpush import b64d, b64e, encrypt, generate_vapid_keys, vapid_headers, load_vapid_private
from cryptography.hazmat.primitives.asymmetric import ec, utils as asym_utils
from cryptography.hazmat.primitives import hashes

passed = failed = 0


def chk(name, cond, info=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS  {name}" + (f"  {info}" if info else ""))
    else:
        failed += 1
        print(f"  FAIL  {name}" + (f"  {info}" if info else ""))


# ── RFC 8291 §5 的测试向量 ──
PLAINTEXT = b"When I grow up, I want to be a watermelon"
AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"
UA_PUBLIC = ("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")
AUTH_SECRET = "BTBZMqHH6r4Tts7J_aSIgg"
SALT = "DGv6ra1nlYgDCS1FRnbzlw"
EXPECTED = ("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS"
            "6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN")

print("\n── RFC 8291 §5 测试向量 ──")
out = encrypt(
    PLAINTEXT, UA_PUBLIC, AUTH_SECRET,
    salt=b64d(SALT),
    server_key=ec.derive_private_key(int.from_bytes(b64d(AS_PRIVATE), "big"), ec.SECP256R1()),
)
got = b64e(out)
chk("加密结果与 RFC 官方向量逐字节一致", got == EXPECTED,
    "" if got == EXPECTED else f"\n        期望 {EXPECTED[:60]}…\n        实得 {got[:60]}…")

exp = b64d(EXPECTED)
chk("salt 正确", out[:16] == exp[:16])
chk("记录大小与公钥长度字段正确", out[16:21] == exp[16:21], out[16:21].hex())
chk("发送方公钥正确", out[21:86] == exp[21:86])
chk("密文正确", out[86:] == exp[86:])

print("\n── 随机性 ──")
a = encrypt(b"x", UA_PUBLIC, AUTH_SECRET)
b = encrypt(b"x", UA_PUBLIC, AUTH_SECRET)
chk("每次加密用新的 salt 和临时密钥", a != b)
chk("输出长度合理", len(a) == 16 + 5 + 65 + (1 + 1 + 16), f"{len(a)} 字节")

print("\n── VAPID ──")
keys = generate_vapid_keys()
chk("生成的公钥是 65 字节未压缩点", len(b64d(keys["public"])) == 65, f'{len(b64d(keys["public"]))} 字节')
chk("生成的私钥是 32 字节", len(b64d(keys["private"])) == 32)

h = vapid_headers("https://web.push.apple.com/abc123", keys["private"], keys["public"], "mailto:a@b.c")
auth = h["Authorization"]
chk("Authorization 头格式正确", auth.startswith("vapid t=") and ", k=" in auth)

token = auth.split("vapid t=")[1].split(", k=")[0]
parts = token.split(".")
chk("JWT 三段式", len(parts) == 3)

import json
hdr = json.loads(b64d(parts[0]))
claims = json.loads(b64d(parts[1]))
chk("算法为 ES256", hdr.get("alg") == "ES256", str(hdr))
chk("aud 是 endpoint 的 origin（不是完整 URL）",
    claims.get("aud") == "https://web.push.apple.com", claims.get("aud"))
chk("exp 在未来且不超过 24 小时", 0 < claims["exp"] - int(__import__("time").time()) <= 86400)

sig = b64d(parts[2])
chk("签名是 64 字节定长 r||s（不是 DER）", len(sig) == 64, f"{len(sig)} 字节")

# 用公钥真正验一遍签名，确保不是随便凑的字节
pub = load_vapid_private(keys["private"]).public_key()
r = int.from_bytes(sig[:32], "big")
s_ = int.from_bytes(sig[32:], "big")
try:
    pub.verify(asym_utils.encode_dss_signature(r, s_), f"{parts[0]}.{parts[1]}".encode(),
               ec.ECDSA(hashes.SHA256()))
    chk("签名可被对应公钥验证通过", True)
except Exception as e:
    chk("签名可被对应公钥验证通过", False, str(e))

print(f"\n{'=' * 46}\n通过 {passed} 项，失败 {failed} 项\n{'=' * 46}")
sys.exit(1 if failed else 0)
