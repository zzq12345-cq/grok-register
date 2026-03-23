"""
注册后处理模块
注册成功后执行: 同意 TOS → 设置生日 → 开启 NSFW → 提取 x-userid
借鉴 /Users/zhouzhiqi/Downloads/grokzhuce/g/ 的实现
"""
import base64
import json
import struct
from typing import Any, Dict, Optional

import requests

DEFAULT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/136.0.0.0 Safari/537.36"
)
TIMEOUT = 15

# 创建绕过代理的 session（避免代理 IP 被 Cloudflare 拦截）
_no_proxy_session = requests.Session()
_no_proxy_session.trust_env = False  # 忽略所有环境变量代理


# ══════════════════════════════════════════════════════════════
#  1. 从 SSO JWT 提取 x-userid (session_id)
# ══════════════════════════════════════════════════════════════

def extract_user_id(sso: str) -> str:
    """从 SSO JWT token 中解码 payload，提取 session_id 作为 x-userid"""
    try:
        parts = sso.split(".")
        if len(parts) >= 2:
            payload = parts[1]
            # 补齐 Base64 padding
            padding = 4 - len(payload) % 4
            if padding != 4:
                payload += "=" * padding
            decoded = base64.urlsafe_b64decode(payload)
            data = json.loads(decoded)
            return data.get("session_id", "")
    except Exception:
        pass
    return ""


# ══════════════════════════════════════════════════════════════
#  2. 同意 TOS (gRPC-Web)
# ══════════════════════════════════════════════════════════════

def accept_tos(sso: str, sso_rw: str) -> Dict[str, Any]:
    """
    调用 SetTosAcceptedVersion gRPC 端点同意服务条款
    返回: {"ok": bool, "error": str|None}
    """
    if not sso or not sso_rw:
        return {"ok": False, "error": "缺少 sso/sso_rw"}

    url = "https://accounts.x.ai/auth_mgmt.AuthManagement/SetTosAcceptedVersion"
    headers = {
        "content-type": "application/grpc-web+proto",
        "origin": "https://accounts.x.ai",
        "referer": "https://accounts.x.ai/accept-tos",
        "x-grpc-web": "1",
        "user-agent": DEFAULT_UA,
    }
    cookies = {"sso": sso, "sso-rw": sso_rw}

    # gRPC payload: Field 2 = 1 (版本号)
    data = b"\x00\x00\x00\x00\x02\x10\x01"

    try:
        res = _no_proxy_session.post(
            url, headers=headers, cookies=cookies, data=data, timeout=TIMEOUT
        )
        grpc_status = res.headers.get("grpc-status")
        ok = res.status_code == 200 and grpc_status in (None, "0")
        return {
            "ok": ok,
            "error": None if ok else f"HTTP {res.status_code}, gRPC {grpc_status}",
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ══════════════════════════════════════════════════════════════
#  3. 设置生日 (REST)
# ══════════════════════════════════════════════════════════════

def set_birth_date(sso: str, sso_rw: str) -> Dict[str, Any]:
    """
    设置生日为 2000-01-01 (确保 18+)
    返回: {"ok": bool, "error": str|None}
    """
    if not sso:
        return {"ok": False, "error": "缺少 sso"}

    url = "https://grok.com/rest/auth/set-birth-date"
    headers = {
        "content-type": "application/json",
        "origin": "https://grok.com",
        "referer": "https://grok.com/",
        "user-agent": DEFAULT_UA,
    }
    cookies = {"sso": sso}
    if sso_rw:
        cookies["sso-rw"] = sso_rw

    payload = '{"birthDate":"2000-01-01T00:00:00.000Z"}'

    try:
        res = _no_proxy_session.post(
            url, headers=headers, cookies=cookies, data=payload, timeout=TIMEOUT
        )
        ok = res.status_code == 200
        return {
            "ok": ok,
            "error": None if ok else f"HTTP {res.status_code}",
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ══════════════════════════════════════════════════════════════
#  4. 开启 NSFW (gRPC-Web)
# ══════════════════════════════════════════════════════════════

# gRPC payload: 开启 always_show_nsfw_content
ENABLE_NSFW_PAYLOAD = bytes([
    # gRPC-Web 帧头
    0x00,
    0x00, 0x00, 0x00, 0x20,  # 长度: 32 字节
    # protobuf 消息
    0x0a, 0x02, 0x10, 0x01,  # field 1: nsfw=true
    0x12, 0x1a, 0x0a, 0x18,  # field 2: feature_name
    # "always_show_nsfw_content" (24 bytes)
    0x61, 0x6c, 0x77, 0x61, 0x79, 0x73, 0x5f, 0x73,
    0x68, 0x6f, 0x77, 0x5f, 0x6e, 0x73, 0x66, 0x77,
    0x5f, 0x63, 0x6f, 0x6e, 0x74, 0x65, 0x6e, 0x74,
])


def enable_nsfw(sso: str, sso_rw: str) -> Dict[str, Any]:
    """
    开启 NSFW (两步: 设置生日 → 开启 feature)
    返回: {"ok": bool, "error": str|None}
    """
    if not sso:
        return {"ok": False, "error": "缺少 sso"}

    # Step 1: 设置生日
    birth_result = set_birth_date(sso, sso_rw)
    # 即使失败也继续（可能已设置过）

    # Step 2: 开启 NSFW feature
    url = "https://grok.com/auth_mgmt.AuthManagement/UpdateUserFeatureControls"
    headers = {
        "content-type": "application/grpc-web+proto",
        "origin": "https://grok.com",
        "referer": "https://grok.com/",
        "x-grpc-web": "1",
        "x-user-agent": "connect-es/2.1.1",
        "user-agent": DEFAULT_UA,
    }
    cookies = {"sso": sso}
    if sso_rw:
        cookies["sso-rw"] = sso_rw

    try:
        res = _no_proxy_session.post(
            url,
            headers=headers,
            cookies=cookies,
            data=ENABLE_NSFW_PAYLOAD,
            timeout=TIMEOUT,
        )
        if res.status_code == 200:
            return {"ok": True, "error": None}
        return {"ok": False, "error": f"HTTP {res.status_code}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ══════════════════════════════════════════════════════════════
#  5. 注册后处理 (统一入口)
# ══════════════════════════════════════════════════════════════

def post_register(
    sso: str,
    sso_rw: str,
    log_func=None,
) -> Dict[str, Any]:
    """
    注册成功后的完整处理流程:
    1. 提取 x-userid
    2. 同意 TOS
    3. 设置生日 + 开启 NSFW

    返回: {
        "x_userid": str,
        "tos_ok": bool,
        "nsfw_ok": bool,
        "errors": list[str],
    }
    """

    def log(msg):
        if log_func:
            log_func(msg)
        else:
            print(msg)

    result = {
        "x_userid": "",
        "tos_ok": False,
        "nsfw_ok": False,
        "errors": [],
    }

    # 1. 提取 x-userid
    x_userid = extract_user_id(sso)
    result["x_userid"] = x_userid
    if x_userid:
        log(f"[步骤8] x-userid: {x_userid[:20]}...")
    else:
        log("[步骤8] ⚠ x-userid 提取失败")
        result["errors"].append("x-userid 提取失败")

    # 2. 同意 TOS
    tos = accept_tos(sso, sso_rw)
    result["tos_ok"] = tos["ok"]
    if tos["ok"]:
        log("[步骤8] ✓ TOS 已同意")
    else:
        log(f"[步骤8] ⚠ TOS 失败: {tos['error']}")
        result["errors"].append(f"TOS: {tos['error']}")

    # 3. 开启 NSFW (包含设置生日)
    nsfw = enable_nsfw(sso, sso_rw)
    result["nsfw_ok"] = nsfw["ok"]
    if nsfw["ok"]:
        log("[步骤8] ✓ NSFW 已开启")
    else:
        log(f"[步骤8] ⚠ NSFW 失败: {nsfw['error']}")
        result["errors"].append(f"NSFW: {nsfw['error']}")

    return result


if __name__ == "__main__":
    # 测试: 用实际 SSO token 运行
    import sys
    if len(sys.argv) < 2:
        print("用法: python post_register.py <sso_token> [sso_rw_token]")
        sys.exit(1)

    sso = sys.argv[1]
    sso_rw = sys.argv[2] if len(sys.argv) > 2 else ""

    print(f"SSO: {sso[:30]}...")
    print(f"SSO-RW: {sso_rw[:30]}..." if sso_rw else "SSO-RW: (无)")

    result = post_register(sso, sso_rw)
    print(f"\n结果: {json.dumps(result, ensure_ascii=False, indent=2)}")
