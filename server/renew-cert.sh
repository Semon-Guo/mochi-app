#!/bin/bash
# 续签服务器证书（在 Mac 上跑，不是在服务器上）。
#
# CA 私钥只存在 ~/.mochi-ca/ca.key，从不上传服务器——那台机器是多用户的，
# 有 root 的人能读到上面的一切。所以签发必须在本地做。
#
# iOS 限制服务器证书有效期 ≤398 天，所以每年要跑一次这个脚本。
# 设备上装的是 CA（10 年有效），换服务器证书不需要重装任何设备。
#
#     ./renew-cert.sh [服务器IP]
set -euo pipefail

CA_DIR=~/.mochi-ca
IP="${1:-172.29.249.177}"
REMOTE="wang@${IP}"

[ -f "$CA_DIR/ca.key" ] || { echo "找不到 CA 私钥 $CA_DIR/ca.key"; exit 1; }

cd "$CA_DIR"
echo "为 $IP 签发新证书..."

cat > server.ext <<EOF
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:${IP},IP:127.0.0.1,DNS:localhost
EOF

openssl req -newkey rsa:2048 -keyout server.key -out server.csr -nodes \
  -subj "/CN=${IP}/O=Mochi Lab" 2>/dev/null
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 397 -sha256 -extfile server.ext 2>/dev/null
chmod 600 server.key

echo "新证书有效期："
openssl x509 -in server.crt -noout -dates
openssl verify -CAfile ca.crt server.crt

echo "上传并重启服务..."
scp -q server.crt server.key "$REMOTE:~/mochi/certs/"
ssh "$REMOTE" 'chmod 600 ~/mochi/certs/server.key && systemctl --user restart mochi.service'
sleep 2

echo "验证："
curl -sS -m 8 --cacert "$CA_DIR/ca.crt" "https://${IP}:3000/api/health" && echo
echo "完成。设备端无需任何操作——装的是 CA，不是这张证书。"
