import random
import re
import string
from typing import List, Optional, Tuple

import requests

# =========================
# Cloudflare Temp Email 配置
# 使用自建的 cloudflare-temp-email 服务（自定义域名，不会被封）
# 项目: https://github.com/dreamhunter2333/cloudflare_temp_email
# =========================
CF_TEMP_EMAIL_BASE_URL = "https://cloudflare-temp-email.ellswortheladia.workers.dev"
REQUEST_TIMEOUT = 15

# 域名缓存
_cached_domains: List[str] = []

CODE_PATTERNS = [
    # 适配类似: ABC-123 xAI confirmation code
    re.compile(r"([A-Z0-9]{3})-?([A-Z0-9]{3})\s+xAI confirmation code", re.IGNORECASE),
    # 兜底匹配任意 6 位字母数字
    re.compile(r"\b([A-Z0-9]{6})\b"),
]


def _short_body(text: str, limit: int = 300) -> str:
    """压缩响应文本，便于日志查看。"""
    return (text or "").replace("\n", " ").strip()[:limit]


def _get_domains() -> List[str]:
    """从 cloudflare-temp-email 获取可用域名列表（带缓存）。"""
    global _cached_domains
    if _cached_domains:
        return _cached_domains

    try:
        res = requests.get(
            f"{CF_TEMP_EMAIL_BASE_URL}/open_api/settings",
            timeout=REQUEST_TIMEOUT,
        )
        if res.status_code == 200:
            data = res.json()
            domains = data.get("domains", [])
            if domains:
                _cached_domains = domains
                return _cached_domains
    except Exception:
        pass

    # 备选: 尝试 /api/open_settings
    try:
        res = requests.get(
            f"{CF_TEMP_EMAIL_BASE_URL}/user_api/open_settings",
            timeout=REQUEST_TIMEOUT,
        )
        if res.status_code == 200:
            data = res.json()
            domains = data.get("domains", [])
            if domains:
                _cached_domains = domains
                return _cached_domains
    except Exception as e:
        print(f"获取域名异常: {e}")

    return []


def _get_domain() -> Optional[str]:
    """随机选择一个可用域名。"""
    domains = _get_domains()
    return random.choice(domains) if domains else None


def generate_random_name(length: int = 10) -> str:
    """生成随机邮箱名称，小写字母+数字。"""
    chars = string.ascii_lowercase + string.digits
    return "".join(random.choices(chars, k=length))


def create_test_email(domain: Optional[str] = None) -> Tuple[Optional[str], Optional[str]]:
    """
    通过 cloudflare-temp-email API 创建临时邮箱。
    domain: 指定域名，为空则随机选择
    返回: (jwt_token, email_address)
    """
    if not domain:
        domain = _get_domain()

    name = generate_random_name(10)

    # 调用 /api/new_address 创建邮箱
    try:
        payload = {"name": name}
        if domain:
            payload["domain"] = domain

        res = requests.post(
            f"{CF_TEMP_EMAIL_BASE_URL}/api/new_address",
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=REQUEST_TIMEOUT,
        )
        if res.status_code not in (200, 201):
            print(f"创建邮箱失败: {res.status_code} | body={_short_body(res.text)}")
            return None, None

        data = res.json()
        jwt_token = data.get("jwt")
        email_address = data.get("address", "")

        if not jwt_token:
            print(f"未获取到 JWT: {res.text[:200]}")
            return None, None

        return jwt_token, email_address
    except Exception as e:
        print(f"创建邮箱异常: {e}")
        return None, None


def _extract_code(text: str) -> Optional[str]:
    """从文本中提取验证码。"""
    if not text:
        return None

    for pattern in CODE_PATTERNS:
        match = pattern.search(text)
        if match:
            if len(match.groups()) == 2:
                return (match.group(1) + match.group(2)).upper()
            return match.group(1).upper()
    return None


def fetch_verification_code(jwt_token: str) -> Optional[str]:
    """
    使用 JWT Token 查收邮件并提取验证码。
    返回: 验证码（例如 ABC123），无结果返回 None
    """
    if not jwt_token:
        return None

    headers = {
        "Authorization": f"Bearer {jwt_token}",
    }

    try:
        # 获取邮件列表
        res = requests.get(
            f"{CF_TEMP_EMAIL_BASE_URL}/api/mails",
            headers=headers,
            params={"limit": 10, "offset": 0},
            timeout=REQUEST_TIMEOUT,
        )
        if res.status_code != 200:
            return None

        data = res.json()
        # cloudflare-temp-email 返回格式: { results: [...] }
        messages = data.get("results", [])
        if not messages:
            return None

        # 先从主题/摘要提取
        for msg in messages:
            subject = str(msg.get("subject", ""))
            code = _extract_code(subject)
            if code:
                return code

        # 主题未命中，读取详情
        for msg in messages[:5]:
            msg_id = msg.get("id")
            if not msg_id:
                continue

            detail_res = requests.get(
                f"{CF_TEMP_EMAIL_BASE_URL}/api/mail/{msg_id}",
                headers=headers,
                timeout=REQUEST_TIMEOUT,
            )
            if detail_res.status_code != 200:
                continue

            detail = detail_res.json()
            # 尝试从多个字段提取
            text_body = str(detail.get("text", ""))
            html_body = str(detail.get("html", ""))
            subject = str(detail.get("subject", ""))
            raw = str(detail.get("raw", ""))

            code = (
                _extract_code(subject)
                or _extract_code(text_body)
                or _extract_code(html_body)
                or _extract_code(raw)
            )
            if code:
                return code

        return None
    except Exception as e:
        print(f"获取验证码异常: {e}")
        return None


if __name__ == "__main__":
    print("测试 Cloudflare Temp Email 临时邮箱...")
    print(f"服务地址: {CF_TEMP_EMAIL_BASE_URL}")
    domains = _get_domains()
    print(f"可用域名 ({len(domains)}): {', '.join(domains) if domains else '未获取到'}")
    token, email = create_test_email()
    print("JWT:", token[:30] + "..." if token else None)
    print("Email:", email)
