from __future__ import annotations
"""
仙侠绘卷 - Grok 统一管理面板
白色仙侠风主题
"""

import json
import os
import queue
import random
import re
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime as dt, timezone
UTC = timezone.utc
import hashlib
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request
from dotenv import load_dotenv

# 加载 .env 配置
load_dotenv()

# Workers URL (从环境变量读取)
WORKERS_URL = os.environ.get('WORKERS_URL', 'http://localhost:8787')

# Workers 认证
WORKERS_AUTH_USER = os.environ.get('WORKERS_AUTH_USER', '')
WORKERS_AUTH_PASS = os.environ.get('WORKERS_AUTH_PASS', '')

# ── 复用注册核心逻辑 ──────────────────────────────────────────
from grok_register_mac import (
    GROK_DIR,
    async_run_job,
    file_lock,
    list_account_files,
    load_account_from_file,
    load_latest_account,
)
from email_utils import _get_domains as get_email_domains
import asyncio

app = Flask(__name__)

# ══════════════════════════════════════════════════════════════
#  全局状态
# ══════════════════════════════════════════════════════════════

class TaskManager:
    """管理所有注册任务的全局状态"""

    def __init__(self):
        self.lock = threading.Lock()
        self.running = False
        self.stop_event = threading.Event()
        self.threads: list[threading.Thread] = []
        self.headless = False  # 默认有头模式
        self.email_domain = ""  # 指定邮箱域名（空=随机）

        # 统计
        self.total_tasks = 0
        self.success_count = 0
        self.fail_count = 0

        # 线程进度 {thread_id: {current, total, step, status}}
        self.thread_progress: dict[int, dict] = {}

        # 注册结果
        self.results: list[dict] = []

        # SSE 订阅者队列
        self.subscribers: list[queue.Queue] = []

    def add_subscriber(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=200)
        with self.lock:
            self.subscribers.append(q)
        return q

    def remove_subscriber(self, q: queue.Queue):
        with self.lock:
            if q in self.subscribers:
                self.subscribers.remove(q)

    def broadcast(self, event_type: str, data: dict):
        """向所有 SSE 订阅者广播事件"""
        msg = {"type": event_type, **data}
        dead = []
        with self.lock:
            for q in self.subscribers:
                try:
                    q.put_nowait(msg)
                except queue.Full:
                    dead.append(q)
            for q in dead:
                self.subscribers.remove(q)

    def get_status(self) -> dict:
        with self.lock:
            rate = (
                round(self.success_count / (self.success_count + self.fail_count) * 100, 1)
                if (self.success_count + self.fail_count) > 0
                else 0
            )
            return {
                "running": self.running,
                "total_tasks": self.total_tasks,
                "success": self.success_count,
                "fail": self.fail_count,
                "rate": rate,
                "threads": dict(self.thread_progress),
                "results": list(self.results[-50:]),  # 最近 50 条
            }

    def reset(self):
        with self.lock:
            self.total_tasks = 0
            self.success_count = 0
            self.fail_count = 0
            self.thread_progress.clear()
            self.results.clear()


manager = TaskManager()


# ══════════════════════════════════════════════════════════════
#  日志钩子：拦截 print → SSE
# ══════════════════════════════════════════════════════════════

def make_log_hook(thread_id: int):
    """创建一个日志函数，将日志推送到 SSE（不再 print，async_run_job 内部会 print）"""

    def log_hook(msg: str):
        timestamp = dt.now().strftime("%H:%M:%S")
        log_entry = f"[{timestamp}] [T{thread_id}] {msg}"
        manager.broadcast("log", {"message": log_entry, "thread_id": thread_id})

        # 解析步骤信息更新进度
        if "[步骤" in msg:
            step = msg.split("]")[0].replace("[", "") if "]" in msg else ""
            with manager.lock:
                if thread_id in manager.thread_progress:
                    manager.thread_progress[thread_id]["step"] = step

    return log_hook


# ══════════════════════════════════════════════════════════════
#  注册 Worker（带 SSE 推送）
# ══════════════════════════════════════════════════════════════

def dashboard_worker(thread_id: int, count: int, headless: bool = False, email_domain: str = ""):
    """注册 worker，支持 SSE 推送和停止控制"""
    log = make_log_hook(thread_id)

    with manager.lock:
        manager.thread_progress[thread_id] = {
            "current": 0,
            "total": count,
            "step": "等待启动",
            "status": "running",
        }

    success_count = 0
    fail_streak = 0

    while success_count < count and not manager.stop_event.is_set():
        current_task = success_count + 1

        with manager.lock:
            manager.thread_progress[thread_id]["current"] = current_task
            manager.thread_progress[thread_id]["step"] = "运行中"

        log(f"开始任务 {current_task}/{count}")

        manager.broadcast("progress", {
            "thread_id": thread_id,
            "current": current_task,
            "total": count,
        })

        # 运行注册任务（传入 log_hook 使详细步骤日志推送到面板）
        try:
            run_result = asyncio.run(async_run_job(
                thread_id, current_task, timeout_sec=180,
                log_func=log, headless=headless,
                email_domain=email_domain,
            ))
        except Exception as e:
            log(f"异常: {e}")
            run_result = False

        if manager.stop_event.is_set():
            log("收到停止信号，退出")
            break

        if run_result:
            success_count += 1
            fail_streak = 0
            with manager.lock:
                manager.success_count += 1

            # 读取最新结果并自动导入到 Token 管理
            try:
                result_entry = {
                    "id": str(uuid.uuid4())[:8],
                    "thread_id": thread_id,
                    "task_id": current_task,
                    "time": dt.now().strftime("%H:%M:%S"),
                    "status": "success",
                }
                account = run_result if isinstance(run_result, dict) else load_latest_account()
                if account:
                    result_entry["email"] = account.get("email", "")
                    result_entry["sso"] = (account.get("sso", "") or "")[:30] + "..."

                    # 自动导入到灵牌名录
                    try:
                        import_data = [{
                            "sso": account.get("sso", ""),
                            "sso_rw": account.get("sso_rw", ""),
                            "user_id": account.get("x-userid", ""),
                            "cf_clearance": account.get("cf_clearance", ""),
                            "name": account.get("email", ""),
                        }]
                        log(f"🔄 准备自动导入: {account.get('email', '')}")
                        session, cookies = get_workers_client()
                        import_resp = session.post(
                            f"{WORKERS_URL}/api/tokens/import",
                            json={"text": json.dumps(import_data)},
                            headers={'Content-Type': 'application/json'},
                            cookies=cookies,
                            timeout=10
                        )
                        log(f"📋 导入响应: {import_resp.status_code}")
                        if import_resp.status_code == 200:
                            result = import_resp.json()
                            log(f"📤 已自动导入到灵牌名录: {result}")
                        else:
                            log(f"⚠️ 自动导入失败: {import_resp.status_code} - {import_resp.text[:100]}")
                    except Exception as e:
                        log(f"⚠️ 自动导入异常: {e}")
                else:
                    log("⚠️ 未找到最新账号结果")

                with manager.lock:
                    manager.results.append(result_entry)

            except Exception as e:
                log(f"⚠️ 读取结果异常: {e}")

            log(f"✅ 任务 {current_task} 成功! ({success_count}/{count})")
            manager.broadcast("success", {
                "thread_id": thread_id,
                "task_id": current_task,
                **manager.get_status(),
            })
            time.sleep(3)
        else:
            fail_streak += 1
            with manager.lock:
                manager.fail_count += 1

            log(f"❌ 任务 {current_task} 失败 (连续失败 {fail_streak})")
            manager.broadcast("fail", {
                "thread_id": thread_id,
                "task_id": current_task,
                **manager.get_status(),
            })

            if fail_streak >= 5:
                log(f"连续失败 {fail_streak} 次，等待 10s")
                for _ in range(10):
                    if manager.stop_event.is_set():
                        break
                    time.sleep(1)
                fail_streak = 0
            else:
                time.sleep(2)

    with manager.lock:
        manager.thread_progress[thread_id]["status"] = "done"
        manager.thread_progress[thread_id]["step"] = "已完成"

    log(f"线程结束 (成功 {success_count}/{count})")


# ══════════════════════════════════════════════════════════════
#  Flask 路由
# ══════════════════════════════════════════════════════════════

@app.route("/")
def index():
    return render_template("index.html", workers_url=WORKERS_URL)


@app.route("/api/domains")
def api_domains():
    """获取可用的邮箱域名列表"""
    try:
        domains = get_email_domains()
        return jsonify({"domains": domains})
    except Exception as e:
        return jsonify({"domains": [], "error": str(e)})


@app.route("/api/start", methods=["POST"])
def api_start():
    """启动注册任务"""
    if manager.running:
        return jsonify({"success": False, "error": "任务已在运行中"}), 400

    data = request.get_json() or {}
    thread_count = min(max(int(data.get("threads", 1)), 1), 10)
    task_count = min(max(int(data.get("count", 1)), 1), 100)
    headless = bool(data.get("headless", False))
    email_domain = str(data.get("domain", "")).strip()

    manager.reset()
    manager.stop_event.clear()
    manager.running = True
    manager.headless = headless
    manager.email_domain = email_domain
    manager.total_tasks = thread_count * task_count

    manager.broadcast("status", {"running": True, "message": "任务启动"})

    # 启动 worker 线程
    manager.threads.clear()
    for i in range(thread_count):
        t = threading.Thread(
            target=dashboard_worker,
            args=(i, task_count, manager.headless, manager.email_domain),
            daemon=True,
        )
        manager.threads.append(t)
        t.start()
        time.sleep(1)

    # 监控线程：等待所有 worker 结束后更新状态
    def monitor():
        for t in manager.threads:
            t.join()
        manager.running = False
        manager.broadcast("status", {"running": False, "message": "所有任务已结束"})

    threading.Thread(target=monitor, daemon=True).start()

    return jsonify({
        "success": True,
        "threads": thread_count,
        "count": task_count,
        "total": thread_count * task_count,
    })


@app.route("/api/stop", methods=["POST"])
def api_stop():
    """停止所有任务"""
    if not manager.running:
        return jsonify({"success": False, "error": "没有运行中的任务"}), 400

    manager.stop_event.set()
    manager.broadcast("status", {"running": False, "message": "正在停止..."})
    return jsonify({"success": True, "message": "已发送停止信号"})


@app.route("/api/status")
def api_status():
    """获取当前状态"""
    return jsonify(manager.get_status())


@app.route("/api/import-last", methods=["POST"])
def api_import_last():
    """导入最新注册结果到灵牌名录"""
    try:
        last_account = load_latest_account()
        if not last_account:
            return jsonify({"success": False, "error": "注册结果为空"}), 400

        # 构造导入数据
        import_data = [{
            "sso": last_account.get("sso", ""),
            "sso_rw": last_account.get("sso_rw", ""),
            "user_id": last_account.get("x-userid", ""),
            "cf_clearance": last_account.get("cf_clearance", ""),
            "name": last_account.get("email", ""),
        }]
        # 调用 Workers API 导入
        session, cookies = get_workers_client()
        import_resp = session.post(
            f"{WORKERS_URL}/api/tokens/import",
            json={"text": json.dumps(import_data)},
            headers={'Content-Type': 'application/json'},
            cookies=cookies,
            timeout=10
        )
        if import_resp.status_code == 200:
            result = import_resp.json()
            return jsonify({"success": True, "imported": result.get("imported", 1)})
        else:
            return jsonify({"success": False, "error": f"导入失败: {import_resp.text}"}), 500
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/results")
def api_results():
    """获取注册结果"""
    with manager.lock:
        return jsonify({"results": list(manager.results)})


# ══════════════════════════════════════════════════════════════
#  Workers API 代理
# ══════════════════════════════════════════════════════════════

import requests

# Workers Session (保持 Cookie)
_workers_session = None
_workers_cookies = None

def get_workers_client():
    """获取 Workers 客户端 (Session + Cookies)"""
    global _workers_session, _workers_cookies

    if _workers_session is None:
        _workers_session = requests.Session()

    # 如果已有 cookie，直接返回
    if _workers_cookies:
        return _workers_session, _workers_cookies

    # 登录获取 cookie
    if WORKERS_AUTH_USER and WORKERS_AUTH_PASS:
        try:
            login_resp = _workers_session.post(
                f"{WORKERS_URL}/api/auth/login",
                json={"username": WORKERS_AUTH_USER, "password": WORKERS_AUTH_PASS},
                headers={'Content-Type': 'application/json'},
                timeout=10
            )
            if login_resp.status_code == 200:
                _workers_cookies = dict(_workers_session.cookies)
                print(f"✅ Workers 登录成功")
            else:
                print(f"⚠️ Workers 登录失败: {login_resp.text}")
        except Exception as e:
            print(f"⚠️ Workers 登录异常: {e}")


    return _workers_session, _workers_cookies or {}

LOCAL_MAX_CHAT_BATCH_SIZE = 4
LOCAL_DIAGNOSE_BATCH_SIZE = 10
LOCAL_TOKEN_BLOCK_TTL_SEC = 20 * 60
ASSETS_BASE = "https://assets.grok.com"
IMAGINE_PUBLIC_BASE = "https://imagine-public.x.ai"
ABSOLUTE_IMAGE_URL_PATTERN = re.compile(r'https?://[^\s"\'<>\\]+?\.(?:jpg|jpeg|png|webp)(?:\?[^\s"\'<>\\)]*)?', re.IGNORECASE)
RELATIVE_IMAGINE_URL_PATTERN = re.compile(r'/imagine-public/[^\s"\'<>\\]+?\.(?:jpg|jpeg|png|webp)(?:\?[^\s"\'<>\\)]*)?', re.IGNORECASE)
IMAGE_EXT_PATTERN = re.compile(r'\.(?:jpg|jpeg|png|webp)(?:\?[^\s"\'<>\\)]*)?$', re.IGNORECASE)
_LOCAL_TOKEN_BLOCKS: dict[str, float] = {}
_LOCAL_TOKEN_BLOCK_LOCK = threading.Lock()
_RUNTIME_CF_CLEARANCE_CACHE = {"value": "", "expires_at": 0.0}
_RUNTIME_CF_CLEARANCE_LOCK = threading.Lock()

# ── TLS 指纹伪造直连 (借鉴 grok2api) ─────────────────────────────

GROK_CHAT_API = "https://grok.com/rest/app-chat/conversations/new"
GROK_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
GROK_TLS_CLIENT_ID = "chrome_131"


def _gen_statsig_id() -> str:
    """生成 Statsig ID（借鉴 grok2api StatsigGenerator）"""
    import base64
    rand_str = "".join(random.choices("abcdefghijklmnopqrstuvwxyz0123456789", k=8))
    if random.choice([True, False]):
        message = f"e:TypeError: Cannot read properties of null (reading 'children['{rand_str}']')"
    else:
        message = f"e:TypeError: Cannot read properties of undefined (reading '{rand_str}')"
    return base64.b64encode(message.encode()).decode()


def _build_grok_cookie(token: dict) -> str:
    """构建 SSO cookie 字符串"""
    parts = [f"sso={token.get('sso', '')}"]
    if token.get("sso_rw"):
        parts.append(f"sso-rw={token.get('sso_rw', '')}")
    cf = token.get("cf_clearance", "")
    if cf and _is_cookie_value_safe(cf):
        parts.append(f"cf_clearance={cf}")
    return "; ".join(parts)


def _build_grok_headers(token: dict) -> dict:
    """构建完整的 grok.com API 请求头（借鉴 grok2api build_headers）"""
    return {
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "en-US,en;q=0.9",
        "Baggage": "sentry-environment=production,sentry-release=d6add6fb0460641fd482d767a335ef72b9b6abb8,sentry-public_key=b311e0f2690c81f25e2c4cf6d4f7ce1c",
        "Content-Type": "application/json",
        "Cookie": _build_grok_cookie(token),
        "Origin": "https://grok.com",
        "Priority": "u=1, i",
        "Referer": "https://grok.com/",
        "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not(A:Brand";v="24"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"macOS"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "User-Agent": GROK_USER_AGENT,
        "x-statsig-id": _gen_statsig_id(),
        "x-xai-request-id": str(uuid.uuid4()),
    }


def _build_grok_chat_payload(prompt: str, count: int, aspect_ratio: str, enable_nsfw: bool) -> dict:
    """构建 grok chat payload（带 deviceEnvInfo）"""
    return {
        "deviceEnvInfo": {
            "darkModeEnabled": False,
            "devicePixelRatio": 2,
            "screenHeight": 1329,
            "screenWidth": 2056,
            "viewportHeight": 1083,
            "viewportWidth": 2056,
        },
        "temporary": True,
        "modelName": "grok-3",
        "modelMode": "MODEL_MODE_FAST",
        "message": prompt,
        "fileAttachments": [],
        "imageAttachments": [],
        "disableSearch": False,
        "enableImageGeneration": True,
        "returnImageBytes": False,
        "returnRawGrokInXaiRequest": False,
        "enableImageStreaming": True,
        "imageGenerationCount": count,
        "forceConcise": False,
        "toolOverrides": {"imageGen": True},
        "enableSideBySide": True,
        "sendFinalMetadata": True,
        "isReasoning": False,
        "disableTextFollowUps": False,
        "disableMemory": True,
        "forceSideBySide": False,
        "isAsyncChat": False,
        "disableSelfHarmShortCircuit": False,
        "responseMetadata": {
            "requestModelDetails": {"modelId": "grok-3"},
            "experiments": [],
            "modelConfigOverride": {
                "modelMap": {
                    "imageGenModelConfig": {
                        "aspectRatio": aspect_ratio,
                        "enableNsfw": enable_nsfw,
                        "imageGenerationCount": count,
                    },
                },
            },
        },
    }


def _extract_images_from_text(text: str, max_count: int = 10) -> list[dict]:
    """从响应文本中提取图片 URL（支持 streamingImageGenerationResponse）"""
    normalized = text.replace("\\/", "/")

    # 优先从 streamingImageGenerationResponse 提取 progress=100 的最终图
    streaming_pattern = re.compile(
        r'"streamingImageGenerationResponse"\s*:\s*\{[^}]*"imageUrl"\s*:\s*"([^"]+)"[^}]*"progress"\s*:\s*100',
        re.DOTALL,
    )
    streaming_matches = streaming_pattern.findall(normalized)

    # 兜底：正则匹配所有图片 URL
    abs_matches = ABSOLUTE_IMAGE_URL_PATTERN.findall(normalized)
    rel_matches = RELATIVE_IMAGINE_URL_PATTERN.findall(normalized)

    seen: set[str] = set()
    images: list[dict] = []

    # 先处理 streaming 图片（最终图）
    for raw_url in streaming_matches:
        url = raw_url.strip()
        if not url:
            continue
        # users/xxx/generated/xxx/image.jpg → https://assets.grok.com/users/xxx/...
        if not url.startswith("http"):
            url = f"{ASSETS_BASE}/{url}"
        if url in seen:
            continue
        seen.add(url)
        images.append({"url": url, "image_url": url})
        if len(images) >= max_count:
            return images

    # 再处理常规正则匹配
    for raw_url in abs_matches + rel_matches:
        url = raw_url.strip().rstrip("),")
        if not url:
            continue
        if url.startswith("/imagine-public/"):
            url = f"{IMAGINE_PUBLIC_BASE}{url}"
        elif url.startswith("/"):
            url = f"{ASSETS_BASE}{url}"
        if url in seen:
            continue
        seen.add(url)
        images.append({"url": url, "image_url": url})
        if len(images) >= max_count:
            break
    return images


def _tls_generate_images(token: dict, prompt: str, count: int, aspect_ratio: str, enable_nsfw: bool) -> dict:
    """使用 tls_client TLS 指纹伪造直连 grok.com 生图"""
    import tls_client
    from urllib.parse import quote

    session = tls_client.Session(client_identifier=GROK_TLS_CLIENT_ID)
    headers = _build_grok_headers(token)
    payload = _build_grok_chat_payload(prompt, count, aspect_ratio, enable_nsfw)

    try:
        response = session.post(
            GROK_CHAT_API,
            headers=headers,
            json=payload,
            timeout_seconds=60,
        )
    except Exception as exc:
        return {"images": [], "error": f"Network error: {exc}", "status": 0, "raw": ""}
    finally:
        session.close()

    text = response.text or ""
    images = _extract_images_from_text(text, count)

    # 提取 requestId
    request_id = ""
    rid_match = re.search(r'"responseId"\s*:\s*"([^"]+)"', text)
    if rid_match:
        request_id = rid_match.group(1)

    token_id = token.get("id", "")
    for idx, img in enumerate(images):
        img["prompt"] = prompt
        img["request_id"] = request_id or f"tls-{idx + 1}"
        original_url = img["url"]
        img["original_url"] = original_url
        # 代理 URL：附带 token_id 确保用正确的 cookie
        img["url"] = f"/api/image-proxy?url={quote(original_url, safe='')}&tid={quote(token_id, safe='')}"
        img["image_url"] = img["url"]

    error = ""
    if response.status_code != 200:
        error = f"HTTP {response.status_code}: {text[:500]}"
    elif not images:
        lower = text.lower()
        if any(k in lower for k in ["429", "rate limit", "rate_limit", "too many requests"]):
            error = f"Rate limited: {text[:240]}"
        elif any(k in lower for k in ["cloudflare", "forbidden", "access denied", "anti-bot", "captcha"]):
            error = f"Upstream blocked: {text[:240]}"
        elif any(k in lower for k in ["unauthorized", "invalid token", "sign in", "401"]):
            error = f"Unauthorized: {text[:240]}"
        else:
            error = "No images generated via tls-client"

    return {
        "ok": response.status_code == 200 and len(images) > 0,
        "status": response.status_code,
        "request_id": request_id,
        "images": images,
        "error": error,
        "raw": text[:500],
    }


LOCAL_IMAGE_FETCH_JS = r"""async (input) => {
    const CHAT_API = '/rest/app-chat/conversations/new';
    const ASSETS_BASE = 'https://assets.grok.com';
    const IMAGINE_PUBLIC_BASE = 'https://imagine-public.x.ai';
    const ABSOLUTE_IMAGE_URL_PATTERN = /https?:\/\/[^\s"'<>\\]+?\.(?:jpg|jpeg|png|webp)(?:\?[^\s"'<>\\)]*)?/gi;
    const RELATIVE_IMAGINE_URL_PATTERN = /\/imagine-public\/[^\s"'<>\\]+?\.(?:jpg|jpeg|png|webp)(?:\?[^\s"'<>\\)]*)?/gi;
    const REQUEST_ID_PATTERN = /"responseId"\s*:\s*"([^"]+)"/;
    const targetCount = Math.max(1, Number(input.count || 1));

    function buildPayload(prompt, count, aspectRatio, enableNsfw) {
        return {
            temporary: true,
            modelName: 'grok-3',
            modelMode: 'MODEL_MODE_FAST',
            message: prompt,
            fileAttachments: [],
            imageAttachments: [],
            disableSearch: false,
            enableImageGeneration: true,
            returnImageBytes: false,
            returnRawGrokInXaiRequest: false,
            enableImageStreaming: true,
            imageGenerationCount: count,
            forceConcise: false,
            toolOverrides: { imageGen: true },
            enableSideBySide: true,
            sendFinalMetadata: true,
            isReasoning: false,
            disableTextFollowUps: false,
            disableMemory: false,
            forceSideBySide: false,
            isAsyncChat: false,
            disableSelfHarmShortCircuit: false,
            responseMetadata: {
                experiments: [],
                modelConfigOverride: {
                    modelMap: {
                        imageGenModelConfig: {
                            aspectRatio,
                            enableNsfw,
                            imageGenerationCount: count,
                        },
                    },
                },
            },
        };
    }

    function isRateLimitMessage(message) {
        const lower = String(message || '').toLowerCase();
        return lower.includes('429')
            || lower.includes('rate limit')
            || lower.includes('rate_limit')
            || lower.includes('too many requests');
    }

    function normalizeImageUrl(rawUrl) {
        const value = String(rawUrl || '').trim().replace(/[),]+$/, '');
        if (!value) return '';
        if (value.startsWith('http://') || value.startsWith('https://')) {
            return /\.(?:jpg|jpeg|png|webp)(?:\?[^\s"'<>\\)]*)?$/i.test(value) ? value : '';
        }
        if (value.startsWith('/imagine-public/')) {
            return `${IMAGINE_PUBLIC_BASE}${value}`;
        }
        if (value.startsWith('/')) {
            return `${ASSETS_BASE}${value}`;
        }
        return '';
    }

    function extractImageUrls(text) {
        const normalizedText = String(text || '').replace(/\\\//g, '/');
        const matches = [
            ...(normalizedText.match(ABSOLUTE_IMAGE_URL_PATTERN) || []),
            ...(normalizedText.match(RELATIVE_IMAGINE_URL_PATTERN) || []),
        ];
        const unique = [];
        const seen = new Set();
        for (const match of matches) {
            const normalized = normalizeImageUrl(match);
            if (normalized && !seen.has(normalized)) {
                seen.add(normalized);
                unique.push(normalized);
            }
            if (unique.length >= targetCount) break;
        }
        return unique;
    }

    function extractRequestId(text) {
        const match = String(text || '').match(REQUEST_ID_PATTERN);
        return match ? match[1] : '';
    }

    function extractErrorMessage(text) {
        const normalizedText = String(text || '').replace(/\\\//g, '/');
        const lower = normalizedText.toLowerCase();
        if (isRateLimitMessage(normalizedText)) {
            return `Rate limited: ${normalizedText.slice(0, 240)}`;
        }
        if (
            lower.includes('unauthorized')
            || lower.includes('invalid token')
            || lower.includes('sign in')
            || lower.includes('login')
            || lower.includes(' 401')
            || lower.includes('"401"')
        ) {
            return `Unauthorized: ${normalizedText.slice(0, 240)}`;
        }
        if (
            lower.includes('cloudflare')
            || lower.includes('attention required')
            || lower.includes('access denied')
            || lower.includes('cf_clearance')
            || lower.includes('__cf$cv$params')
            || lower.includes('challenge-platform')
            || lower.includes('please enable javascript')
            || lower.includes('captcha')
            || lower.includes('forbidden')
        ) {
            return `Upstream blocked: ${normalizedText.slice(0, 240)}`;
        }
        return '';
    }

    const controller = new AbortController();
    const timeoutMs = Math.max(5000, Number(input.timeout_ms || 45000));
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(CHAT_API, {
            method: 'POST',
            credentials: 'include',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                'Accept': '*/*',
                'Origin': 'https://grok.com',
                'Referer': 'https://grok.com/',
            },
            body: JSON.stringify(buildPayload(
                String(input.prompt || ''),
                targetCount,
                String(input.aspect_ratio || '2:3'),
                Boolean(input.enable_nsfw),
            )),
        });

        const text = await response.text().catch(() => '');
        clearTimeout(timer);

        const images = extractImageUrls(text).slice(0, targetCount).map((url, index) => ({
            url,
            prompt: String(input.prompt || ''),
            full_prompt: String(input.prompt || ''),
            request_id: extractRequestId(text) || `chat-image-${index + 1}`,
            width: 0,
            height: 0,
            model_name: 'grok-3',
        }));

        let error = '';
        if (!response.ok) {
            error = `HTTP ${response.status}: ${text.slice(0, 500)}`;
        } else if (images.length === 0) {
            error = extractErrorMessage(text) || 'No images generated via app-chat';
        }

        return {
            ok: response.ok,
            status: response.status,
            request_id: extractRequestId(text),
            images,
            error,
            raw: text.slice(0, 500),
        };
    } catch (error) {
        clearTimeout(timer);
        return {
            ok: false,
            status: 0,
            request_id: '',
            images: [],
            error: `Network error: ${error instanceof Error ? error.message : String(error)}`,
            raw: '',
        };
    }
}"""


def _now_iso() -> str:
    return dt.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _emit_queue_event(out_queue: queue.Queue, event: str, payload: dict):
    out_queue.put((event, payload))


def _find_free_port() -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _cleanup_local_token_blocks():
    now = time.time()
    with _LOCAL_TOKEN_BLOCK_LOCK:
        expired = [token_id for token_id, until in _LOCAL_TOKEN_BLOCKS.items() if until <= now]
        for token_id in expired:
            _LOCAL_TOKEN_BLOCKS.pop(token_id, None)


def _block_local_token(token_id: str, ttl_sec: int = LOCAL_TOKEN_BLOCK_TTL_SEC):
    if not token_id:
        return
    with _LOCAL_TOKEN_BLOCK_LOCK:
        _LOCAL_TOKEN_BLOCKS[token_id] = time.time() + ttl_sec


def _is_local_token_blocked(token_id: str) -> bool:
    if not token_id:
        return False
    _cleanup_local_token_blocks()
    with _LOCAL_TOKEN_BLOCK_LOCK:
        return _LOCAL_TOKEN_BLOCKS.get(token_id, 0) > time.time()


def _is_rate_limit_message(message: str) -> bool:
    lower = str(message or "").lower()
    return (
        "429" in lower
        or "rate limit" in lower
        or "rate_limit" in lower
        or "too many requests" in lower
    )


def _classify_rest_error(error_text: str) -> dict:
    detail = str(error_text or "Unknown error")[:500]
    lower = detail.lower()

    if _is_rate_limit_message(detail):
        return {"ok": False, "code": "rate_limited", "message": "上游返回速率限制", "detail": detail, "probe": "app_chat_rest", "images_received": 0}
    if any(marker in lower for marker in ["cloudflare", "attention required", "access denied", "cf_clearance", "captcha", "forbidden", "__cf$cv$params", "challenge-platform", "please enable javascript", "anti-bot", "request rejected by anti-bot rules"]):
        return {"ok": False, "code": "upstream_blocked", "message": "上游拦截，可能需要额外验证或更换出口 IP", "detail": detail, "probe": "app_chat_rest", "images_received": 0}
    if any(marker in lower for marker in ["401", "unauthorized", "invalid token", "sign in", "login", "jwt"]):
        return {"ok": False, "code": "auth_invalid", "message": "鉴权失效，令牌可能已过期", "detail": detail, "probe": "app_chat_rest", "images_received": 0}
    return {"ok": False, "code": "unknown_error", "message": "未识别的上游错误", "detail": detail, "probe": "app_chat_rest", "images_received": 0}


def _empty_diagnostic_summary() -> dict:
    return {"ok": 0, "rate_limited": 0, "auth_invalid": 0, "ws_upgrade_failed": 0, "upstream_blocked": 0, "unknown_error": 0}


def _workers_request(method: str, path: str, *, json_body=None, timeout: int = 15, stream: bool = False):
    session, cookies = get_workers_client()
    kwargs = {"cookies": cookies, "timeout": timeout}
    if json_body is not None:
        kwargs["json"] = json_body
        kwargs["headers"] = {"Content-Type": "application/json"}
    if stream:
        kwargs["stream"] = True
    return session.request(method=method, url=f"{WORKERS_URL}{path}", **kwargs)


def _workers_json(method: str, path: str, *, json_body=None, timeout: int = 15) -> dict:
    resp = _workers_request(method, path, json_body=json_body, timeout=timeout)
    if resp.status_code >= 400:
        raise RuntimeError(f"{path} -> HTTP {resp.status_code}: {resp.text[:200]}")
    return resp.json()


def _refresh_cooling_tokens_best_effort():
    try:
        _workers_request("POST", "/api/tokens/refresh-cooling", json_body={}, timeout=10)
    except Exception:
        pass


def _merge_token_rows(info_tokens: list[dict], export_tokens: list[dict]) -> list[dict]:
    export_by_name: dict[str, list[dict]] = {}
    for export_token in export_tokens:
        export_by_name.setdefault(export_token.get("name", ""), []).append(export_token)

    merged: list[dict] = []
    for index, info_token in enumerate(info_tokens):
        export_token = export_tokens[index] if index < len(export_tokens) else None
        if export_token and info_token.get("name") and export_token.get("name") and export_token.get("name") != info_token.get("name"):
            candidates = export_by_name.get(info_token.get("name", ""), [])
            export_token = candidates[0] if candidates else export_token
        export_token = export_token or {}
        merged.append({
            **export_token,
            "id": info_token.get("id", ""),
            "name": info_token.get("name") or export_token.get("name", ""),
            "user_id": export_token.get("x-userid", ""),
            "status": info_token.get("status", ""),
            "nsfw_enabled": info_token.get("nsfw_enabled", False),
            "use_count": info_token.get("use_count", 0),
            "quota": info_token.get("quota", 0),
            "cooling_since": info_token.get("cooling_since"),
            "has_cf_clearance": info_token.get("has_cf_clearance", bool(export_token.get("cf_clearance"))),
        })
    return merged


def _load_full_tokens() -> list[dict]:
    _refresh_cooling_tokens_best_effort()
    info_payload = _workers_json("GET", "/api/tokens", timeout=15)
    export_payload = _workers_json("GET", "/api/tokens/export", timeout=15)
    return _merge_token_rows(info_payload.get("tokens", []), export_payload.get("tokens", []))


def _pick_generation_candidates(tokens: list[dict], token_id: str = "") -> list[dict]:
    _cleanup_local_token_blocks()
    if token_id:
        return [token for token in tokens if token.get("id") == token_id and token.get("sso")]
    candidates = [token for token in tokens if token.get("status") == "active" and token.get("sso") and not _is_local_token_blocked(token.get("id", ""))]
    candidates.sort(key=lambda token: (-(int(token.get("quota") or 0)), int(token.get("use_count") or 0), token.get("name", "")))
    return candidates


def _is_cookie_value_safe(value: str) -> bool:
    text = str(value or "")
    if not text:
        return False
    return all(32 <= ord(ch) <= 126 for ch in text)


def _get_chrome_safe_storage_password() -> str:
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-w", "-s", "Chrome Safe Storage"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
        return result.stdout.strip()
    except Exception:
        return ""


def _decrypt_chromium_cookie(encrypted_value: bytes, password: str) -> str:
    if not encrypted_value:
        return ""
    if isinstance(encrypted_value, memoryview):
        encrypted_value = encrypted_value.tobytes()
    if encrypted_value.startswith((b"v10", b"v11")):
        try:
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

            key = hashlib.pbkdf2_hmac("sha1", password.encode("utf-8"), b"saltysalt", 1003, dklen=16)
            cipher = Cipher(algorithms.AES(key), modes.CBC(b" " * 16))
            decryptor = cipher.decryptor()
            padded = decryptor.update(encrypted_value[3:]) + decryptor.finalize()
            pad_len = padded[-1]
            if 1 <= pad_len <= 16:
                padded = padded[:-pad_len]
            return padded.decode("utf-8", errors="ignore")
        except Exception:
            return ""
    try:
        return encrypted_value.decode("utf-8", errors="ignore")
    except Exception:
        return ""


def _load_runtime_cf_clearance() -> str:
    now = time.time()
    with _RUNTIME_CF_CLEARANCE_LOCK:
        cached = _RUNTIME_CF_CLEARANCE_CACHE.get("value", "")
        expires_at = _RUNTIME_CF_CLEARANCE_CACHE.get("expires_at", 0.0)
        if cached and expires_at > now:
            return cached

    password = _get_chrome_safe_storage_password()
    if not password:
        return ""

    cookie_db = os.path.expanduser("~/Library/Application Support/Google/Chrome/Default/Cookies")
    if not os.path.exists(cookie_db):
        return ""

    temp_db = os.path.join(tempfile.gettempdir(), f"chrome_cookies_{uuid.uuid4().hex}.sqlite")
    try:
        shutil.copy2(cookie_db, temp_db)
        conn = sqlite3.connect(temp_db)
        try:
            row = conn.execute(
                """
                SELECT encrypted_value
                FROM cookies
                WHERE name = 'cf_clearance'
                  AND (host_key = '.grok.com' OR host_key = 'grok.com')
                ORDER BY last_access_utc DESC, creation_utc DESC
                LIMIT 1
                """
            ).fetchone()
        finally:
            conn.close()
    except Exception:
        row = None
    finally:
        try:
            os.remove(temp_db)
        except Exception:
            pass

    if not row:
        return ""

    value = _decrypt_chromium_cookie(row[0], password).strip()
    if not _is_cookie_value_safe(value):
        return ""

    with _RUNTIME_CF_CLEARANCE_LOCK:
        _RUNTIME_CF_CLEARANCE_CACHE["value"] = value
        _RUNTIME_CF_CLEARANCE_CACHE["expires_at"] = time.time() + 300
    return value


def _build_token_cookies(token: dict, seed_cf_clearance: str = "") -> list[dict]:
    base_url = "https://grok.com/"
    cookie_list = [{"name": "sso", "value": token.get("sso", ""), "url": base_url}]
    if token.get("sso_rw"):
        cookie_list.append({"name": "sso-rw", "value": token.get("sso_rw", ""), "url": base_url})
    if token.get("user_id"):
        cookie_list.append({"name": "x-userid", "value": token.get("user_id", ""), "url": base_url})
    cf_clearance = token.get("cf_clearance", "")
    if not _is_cookie_value_safe(cf_clearance):
        cf_clearance = seed_cf_clearance
    if _is_cookie_value_safe(cf_clearance):
        cookie_list.append({"name": "cf_clearance", "value": cf_clearance, "url": base_url})
    return cookie_list


def _seed_chrome_profile(user_data_dir: str):
    source_root = os.path.expanduser("~/Library/Application Support/Google/Chrome")
    for relative_path in [
        "Local State",
        "Default/Cookies",
        "Default/Preferences",
        "Default/Secure Preferences",
    ]:
        source_path = os.path.join(source_root, relative_path)
        if not os.path.exists(source_path):
            continue
        target_path = os.path.join(user_data_dir, relative_path)
        os.makedirs(os.path.dirname(target_path), exist_ok=True)
        shutil.copy2(source_path, target_path)


def _start_chrome_with_seeded_profile(port: int, user_data_dir: str, headless: bool = False):
    import urllib.request
    from grok_register_mac import _find_chrome, _kill_port

    chrome_exe = _find_chrome()
    if not chrome_exe:
        return None

    _kill_port(port)
    shutil.rmtree(user_data_dir, ignore_errors=True)
    os.makedirs(user_data_dir, exist_ok=True)
    _seed_chrome_profile(user_data_dir)

    args = [
        chrome_exe,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={user_data_dir}",
        "--profile-directory=Default",
        "--window-size=400,600",
        "--window-position=0,0",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--lang=en-US",
        "--accept-lang=en-US",
    ]
    if headless:
        args.append("--headless=new")

    try:
        proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(15):
            try:
                urllib.request.urlopen(f"http://localhost:{port}/json/version", timeout=1)
                return proc
            except Exception:
                time.sleep(1)
        return proc
    except Exception:
        return None


async def _extract_seed_cf_clearance(context) -> str:
    try:
        page = context.pages[0] if context.pages else await context.new_page()
        try:
            await page.goto("https://grok.com/", wait_until="domcontentloaded", timeout=20000)
        except Exception:
            pass
        await asyncio.sleep(2)
        cookies = await context.cookies("https://grok.com/")
    except Exception:
        return ""

    for cookie in cookies:
        if cookie.get("name") == "cf_clearance":
            value = str(cookie.get("value", ""))
            if _is_cookie_value_safe(value):
                return value
    return ""


def _minimize_chrome_window():
    """通过 AppleScript 将 Chrome 窗口最小化到 Dock（仅 macOS）"""
    try:
        subprocess.run(
            ["osascript", "-e", 'tell application "Google Chrome" to set miniaturized of every window to true'],
            capture_output=True,
            timeout=5,
        )
    except Exception:
        pass


async def _open_local_browser(namespace: str):
    from playwright.async_api import async_playwright

    port = _find_free_port()
    user_data_dir = os.path.abspath(os.path.join(tempfile.gettempdir(), f"ChromeDevData_{namespace}_{uuid.uuid4().hex}"))
    chrome_proc = await asyncio.to_thread(_start_chrome_with_seeded_profile, port, user_data_dir, False)
    if not chrome_proc:
        raise RuntimeError("Chrome 启动失败")
    await asyncio.sleep(1)
    # 有头模式下自动最小化窗口，减少对用户的干扰
    await asyncio.to_thread(_minimize_chrome_window)
    pw = await async_playwright().start()
    browser = await pw.chromium.connect_over_cdp(f"http://localhost:{port}", timeout=15000)
    context = browser.contexts[0] if browser.contexts else await browser.new_context()
    seed_cf_clearance = await _extract_seed_cf_clearance(context)
    return {"port": port, "user_data_dir": user_data_dir, "chrome_proc": chrome_proc, "pw": pw, "browser": browser, "context": context, "seed_cf_clearance": seed_cf_clearance}


async def _close_local_browser(state: dict):
    browser = state.get("browser")
    pw = state.get("pw")
    chrome_proc = state.get("chrome_proc")
    user_data_dir = state.get("user_data_dir")
    if browser:
        try:
            await browser.close()
        except Exception:
            pass
    if pw:
        try:
            await pw.stop()
        except Exception:
            pass
    if chrome_proc:
        try:
            chrome_proc.terminate()
            chrome_proc.wait(timeout=5)
        except Exception:
            try:
                chrome_proc.kill()
            except Exception:
                pass
    if user_data_dir:
        shutil.rmtree(user_data_dir, ignore_errors=True)


async def _inspect_page_access(page) -> tuple[bool, str]:
    try:
        title = await page.title()
    except Exception:
        title = ""
    try:
        snapshot = await page.evaluate("() => (document.documentElement && document.documentElement.outerHTML ? document.documentElement.outerHTML : '').slice(0, 4000)")
    except Exception:
        snapshot = ""
    detail = f"{title}\n{snapshot}"[:500]
    lower = detail.lower()
    markers = ["__cf$cv$params", "challenge-platform", "just a moment", "attention required", "please enable javascript", "access denied", "captcha"]
    return (not any(marker in lower for marker in markers), detail)


async def _open_grok_token_page(browser_state: dict, token: dict):
    ctx = browser_state["context"]
    for existing_page in list(ctx.pages):
        try:
            await existing_page.close()
        except Exception:
            pass
    await ctx.add_cookies(_build_token_cookies(token, browser_state.get("seed_cf_clearance", "")))
    page = await ctx.new_page()
    page.set_default_navigation_timeout(30000)
    try:
        await page.goto("https://grok.com/", wait_until="domcontentloaded", timeout=30000)
    except Exception:
        pass

    # 有头模式下等待更长时间，让 Cloudflare challenge 自动通过
    # 首次等待 5 秒让页面完全加载
    await asyncio.sleep(5)

    # 轮询等待 Cloudflare challenge 通过（最多 30 秒）
    ready = False
    detail = ""
    for wait_round in range(10):
        ready, detail = await _inspect_page_access(page)
        if ready:
            break
        # 如果页面仍显示 Cloudflare challenge，继续等待
        await asyncio.sleep(3)

    # 等待 cf_clearance cookie 出现（最多 15 秒）
    if ready:
        for _ in range(15):
            try:
                cookies = await ctx.cookies("https://grok.com/")
                for cookie in cookies:
                    if cookie.get("name") == "cf_clearance":
                        value = str(cookie.get("value", ""))
                        if _is_cookie_value_safe(value):
                            browser_state["seed_cf_clearance"] = value
                            break
                if browser_state.get("seed_cf_clearance"):
                    break
            except Exception:
                pass
            await asyncio.sleep(1)

    return page, ready, detail


async def _collect_images_with_page(page, prompt: str, count: int, aspect_ratio: str, enable_nsfw: bool) -> dict:
    try:
        result = await asyncio.wait_for(page.evaluate(LOCAL_IMAGE_FETCH_JS, {"prompt": prompt, "count": count, "aspect_ratio": aspect_ratio, "enable_nsfw": enable_nsfw, "timeout_ms": 45000}), timeout=60)
    except asyncio.TimeoutError:
        return {"images": [], "error": "Network error: local browser fetch timeout", "status": 0, "raw": ""}
    except Exception as exc:
        return {"images": [], "error": f"Browser error: {exc}", "status": 0, "raw": ""}
    return result if isinstance(result, dict) else {"images": [], "error": "Browser error: invalid response payload", "status": 0, "raw": ""}


def _build_diagnostic_result(result: dict) -> dict:
    images = result.get("images") or []
    if images:
        return {"ok": True, "code": "ok", "message": f"连接正常，已收到 {len(images)} 条图片结果", "detail": "", "checked_at": _now_iso(), "probe": "app_chat_rest", "images_received": len(images)}
    error = result.get("error", "")
    if error:
        classified = _classify_rest_error(error)
        return {**classified, "checked_at": _now_iso()}
    return {"ok": False, "code": "unknown_error", "message": "未知错误：未生成图片但无错误信息", "detail": result.get("raw", "")[:500], "checked_at": _now_iso(), "probe": "app_chat_rest", "images_received": 0}


def _sync_token_usage_best_effort(token_id: str):
    if not token_id:
        return
    try:
        _workers_request("POST", f"/api/tokens/{token_id}/sync-usage", json_body={}, timeout=10)
    except Exception:
        pass


async def _diagnose_tokens_locally(tokens: list[dict], delay_ms: int = 250) -> list[dict]:
    """使用 TLS 指纹伪造直连诊断 Token（不再需要浏览器）"""
    results: list[dict] = []
    for index, token in enumerate(tokens):
        try:
            result = _build_diagnostic_result(
                await asyncio.to_thread(_tls_generate_images, token, "diagnostic probe", 1, "1:1", False)
            )
        except Exception as exc:
            result = _build_diagnostic_result({"images": [], "error": f"TLS client error: {exc}"})
        if result.get("code") == "rate_limited":
            _block_local_token(token.get("id", ""))
        results.append(result)
        if index < len(tokens) - 1 and delay_ms > 0:
            await asyncio.sleep(delay_ms / 1000)
    return results


async def _run_local_imagine_job(body: dict, out_queue: queue.Queue):
    prompt = str(body.get("prompt", "")).strip()
    if not prompt:
        _emit_queue_event(out_queue, "error", {"type": "error", "message": "提示词不能为空"})
        return
    count = min(max(int(body.get("count", 10) or 10), 1), 20)
    aspect_ratio = str(body.get("aspect_ratio", "2:3") or "2:3")
    enable_nsfw = bool(body.get("enable_nsfw", True))
    token_id = str(body.get("token_id", "") or "").strip()

    _emit_queue_event(out_queue, "info", {"type": "info", "message": "已切换到 TLS 指纹直连生图（无需浏览器）"})
    _emit_queue_event(out_queue, "progress", {"type": "progress", "progress": 0, "current": 0, "total": count})

    try:
        tokens = _load_full_tokens()
    except Exception as exc:
        _emit_queue_event(out_queue, "error", {"type": "error", "message": f"加载令牌失败: {exc}"})
        return

    active_tokens = [token for token in tokens if token.get("status") == "active" and token.get("sso")]
    candidates = _pick_generation_candidates(tokens, token_id=token_id)
    if not candidates:
        if token_id:
            _emit_queue_event(out_queue, "error", {"type": "error", "message": "指定令牌不存在或缺少 SSO"})
        elif active_tokens and all(_is_local_token_blocked(token.get("id", "")) for token in active_tokens):
            _emit_queue_event(out_queue, "error", {"type": "error", "message": f"All tokens rate limited (tried {len(active_tokens)} tokens)"})
        else:
            _emit_queue_event(out_queue, "error", {"type": "error", "message": "没有可用令牌，请先导入或刷新令牌"})
        return

    seen_urls: set[str] = set()
    total_collected = 0
    last_error_message = ""

    for candidate_index, token in enumerate(candidates, start=1):
        if total_collected >= count:
            break
        token_name = token.get("name") or token.get("id") or f"token-{candidate_index}"
        _emit_queue_event(out_queue, "info", {"type": "info", "message": f"尝试令牌 {candidate_index}/{len(candidates)}：{token_name}"})

        token_used = False
        while total_collected < count:
            batch_count = min(LOCAL_MAX_CHAT_BATCH_SIZE, count - total_collected)
            result = await asyncio.to_thread(_tls_generate_images, token, prompt, batch_count, aspect_ratio, enable_nsfw)
            images = result.get("images") or []
            emitted_this_round = 0

            for image in images:
                url = image.get("url") or image.get("image_url")
                if not url or url in seen_urls:
                    continue
                seen_urls.add(url)
                total_collected += 1
                emitted_this_round += 1
                token_used = True
                payload = {"type": "image", "url": url, "image_url": url, "prompt": image.get("prompt") or prompt, "id": image.get("request_id") or f"tls-{total_collected}"}
                _emit_queue_event(out_queue, "image", payload)
                _emit_queue_event(out_queue, "progress", {"type": "progress", "progress": round(total_collected / count * 100, 1), "current": total_collected, "total": count})
                if total_collected >= count:
                    break

            if total_collected >= count:
                break

            error = str(result.get("error", "") or "").strip()
            if error:
                last_error_message = error
                classified = _classify_rest_error(error)
                if classified["code"] == "rate_limited":
                    _block_local_token(token.get("id", ""))
                    _emit_queue_event(out_queue, "info", {"type": "info", "message": f"Token rate limited, switching to another (attempt {candidate_index}/{len(candidates)}) [{error[:120]}]"})
                elif emitted_this_round == 0:
                    _emit_queue_event(out_queue, "info", {"type": "info", "message": f"{token_name}: {classified['message']}"})
                break

            if emitted_this_round == 0:
                last_error_message = result.get("raw", "")[:200] or "No images generated via tls-client"
                _emit_queue_event(out_queue, "info", {"type": "info", "message": f"{token_name}: 未返回图片，切换下一个令牌"})
                break

            if emitted_this_round < batch_count:
                _emit_queue_event(out_queue, "info", {"type": "info", "message": f"{token_name}: 本轮仅返回 {emitted_this_round}/{batch_count} 张，切换下一个令牌"})
                break

        if token_used:
            _sync_token_usage_best_effort(token.get("id", ""))

    if total_collected > 0:
        _emit_queue_event(out_queue, "info", {"type": "info", "message": f"本次共返回 {total_collected}/{count} 张图片"})
        _emit_queue_event(out_queue, "done", {"type": "done"})
        return

    final_message = last_error_message or (f"All tokens rate limited (tried {len(candidates)} tokens)" if candidates else "没有可用令牌")
    _emit_queue_event(out_queue, "error", {"type": "error", "message": final_message})

@app.route("/api/tokens", methods=["GET", "POST", "DELETE"])
def proxy_tokens():
    """代理 Token API"""
    session, cookies = get_workers_client()
    headers = {'Content-Type': 'application/json'}
    resp = session.request(
        method=request.method,
        url=f"{WORKERS_URL}/api/tokens",
        headers=headers,
        cookies=cookies,
        data=request.get_data() if request.method != "GET" else None
    )
    return Response(resp.content, status=resp.status_code)


@app.route("/api/tokens/<token_id>/diagnose", methods=["POST"])
def local_token_diagnose(token_id):
    """本地真实浏览器诊断单个 Token 图片能力"""
    try:
        tokens = _load_full_tokens()
    except Exception as e:
        return jsonify({"success": False, "error": f"加载 token 失败: {e}"}), 500

    token = next((item for item in tokens if item.get("id") == token_id), None)
    if not token:
        return jsonify({"success": False, "error": "Token not found"}), 404

    try:
        result = asyncio.run(_diagnose_tokens_locally([token], 0))[0]
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

    return jsonify({
        "success": True,
        "result": {
            "token_id": token.get("id", ""),
            "token_name": token.get("name", ""),
            "token_status": token.get("status", ""),
            **result,
        },
    })


@app.route("/api/tokens/diagnose", methods=["POST"])
def local_tokens_diagnose():
    """本地真实浏览器批量诊断 Token 图片能力"""
    data = request.get_json(silent=True) or {}
    offset = max(0, int(data.get("offset", 0) or 0))
    batch_size = min(LOCAL_DIAGNOSE_BATCH_SIZE, max(1, int(data.get("batch_size", LOCAL_DIAGNOSE_BATCH_SIZE) or LOCAL_DIAGNOSE_BATCH_SIZE)))
    delay_ms = min(1000, max(0, int(data.get("delay_ms", 250) or 250)))
    active_only = data.get("active_only", True) is not False

    try:
        tokens = _load_full_tokens()
    except Exception as e:
        return jsonify({"success": False, "error": f"加载 token 失败: {e}"}), 500

    filtered = [token for token in tokens if token.get("sso") and (not active_only or token.get("status") == "active")]
    batch = filtered[offset:offset + batch_size]

    if not batch:
        return jsonify({
            "success": True,
            "total": len(filtered),
            "processed": min(len(filtered), offset),
            "batch_size": 0,
            "done": True,
            "next_offset": None,
            "summary": _empty_diagnostic_summary(),
            "results": [],
        })

    try:
        local_results = asyncio.run(_diagnose_tokens_locally(batch, delay_ms))
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

    summary = _empty_diagnostic_summary()
    results = []
    for token, result in zip(batch, local_results):
        summary[result["code"]] = summary.get(result["code"], 0) + 1
        results.append({
            "token_id": token.get("id", ""),
            "token_name": token.get("name", ""),
            "token_status": token.get("status", ""),
            **result,
        })

    processed = min(len(filtered), offset + len(batch))
    done = processed >= len(filtered)

    return jsonify({
        "success": True,
        "total": len(filtered),
        "processed": processed,
        "batch_size": len(batch),
        "done": done,
        "next_offset": None if done else processed,
        "summary": summary,
        "results": results,
    })


@app.route("/api/tokens/<path:path>", methods=["GET", "POST", "DELETE"])
def proxy_tokens_detail(path):
    """代理 Token 详情 API，DELETE 时同步清理本地文件"""
    session, cookies = get_workers_client()
    headers = {'Content-Type': 'application/json'}

    if request.method == "DELETE":
        token_sso = None
        token_name = None
        try:
            info_resp = session.get(f"{WORKERS_URL}/api/tokens", cookies=cookies, timeout=10)
            if info_resp.status_code == 200:
                tokens = info_resp.json().get("tokens", [])
                target = next((t for t in tokens if t["id"] == path), None)
                if target:
                    token_sso = target.get("sso_preview", "")
                    token_name = target.get("name", "")
            export_resp = session.get(f"{WORKERS_URL}/api/tokens/export", cookies=cookies, timeout=10)
            if export_resp.status_code == 200:
                exports = export_resp.json().get("tokens", [])
                target_export = next((t for t in exports if token_name and t.get("name") == token_name), None)
                if target_export:
                    token_sso = target_export.get("sso", token_sso)
        except Exception as e:
            print(f"⚠️ 获取 token SSO 失败: {e}")

        resp = session.request(method="DELETE", url=f"{WORKERS_URL}/api/tokens/{path}", headers=headers, cookies=cookies)
        if resp.status_code == 200 and token_sso:
            _clean_token_from_files(token_sso, token_name)
        return Response(resp.content, status=resp.status_code)

    resp = session.request(
        method=request.method,
        url=f"{WORKERS_URL}/api/tokens/{path}",
        headers=headers,
        cookies=cookies,
        data=request.get_data() if request.method != "GET" else None
    )
    return Response(resp.content, status=resp.status_code)

def _clean_token_from_files(sso: str, name: str = ""):
    """从本地文件中清理已删除的 token"""
    cleaned = []

    # 1. 清理 result_grok/<邮箱>.json
    try:
        for json_file in list_account_files():
            with file_lock:
                try:
                    account = load_account_from_file(json_file)
                except (OSError, json.JSONDecodeError):
                    continue

                if account.get("sso") == sso and os.path.exists(json_file):
                    os.remove(json_file)
                    cleaned.append(os.path.basename(json_file))
    except Exception as e:
        print(f"⚠️ 清理账号结果文件失败: {e}")

    # 2. 清理旧版 result_grok/*.txt（兼容历史文件）
    try:
        import glob
        for txt_file in glob.glob(os.path.join(GROK_DIR, "*.txt")):
            with open(txt_file, "r", encoding="utf-8") as f:
                content = f.read()
            if sso in content:
                # 按账号块分割（每个账号用空行分隔）
                blocks = content.split("\n\n")
                new_blocks = [b for b in blocks if sso not in b]
                if len(new_blocks) < len(blocks):
                    with open(txt_file, "w", encoding="utf-8") as f:
                        f.write("\n\n".join(new_blocks))
                    cleaned.append(f"{os.path.basename(txt_file)}")
    except Exception as e:
        print(f"⚠️ 清理 result_grok txt 失败: {e}")

    if cleaned:
        print(f"🗑️ 已清理 token [{name or sso[:10]}...] 的本地文件: {', '.join(cleaned)}")
    else:
        print(f"ℹ️ 未在本地文件中找到 token [{name or sso[:10]}...] 的记录")

@app.route("/api/tokens/import", methods=["POST"])
def proxy_tokens_import():
    """代理 Token 导入 API"""
    session, cookies = get_workers_client()
    resp = session.post(
        f"{WORKERS_URL}/api/tokens/import",
        json=request.get_json(),
        headers={'Content-Type': 'application/json'},
        cookies=cookies
    )
    return Response(resp.content, status=resp.status_code)

@app.route("/api/tokens/export", methods=["GET"])
def proxy_tokens_export():
    """代理 Token 导出 API"""
    session, cookies = get_workers_client()
    resp = session.get(f"{WORKERS_URL}/api/tokens/export", cookies=cookies)
    return Response(resp.content, status=resp.status_code)

@app.route("/api/tokens/enable-nsfw", methods=["POST"])
def local_tokens_nsfw():
    """通过真实 Chrome CDP 执行 NSFW 启用（绕过 Cloudflare WAF）"""
    import asyncio
    from grok_register_mac import _find_chrome, _start_chrome, _kill_port

    data = request.get_json() or {}
    offset = int(data.get("offset", 0))
    BATCH_SIZE = 5

    # 从 Workers 获取 token 完整数据
    session, cookies = get_workers_client()
    try:
        export_resp = session.get(
            f"{WORKERS_URL}/api/tokens/export",
            cookies=cookies, timeout=10,
        )
        if export_resp.status_code != 200:
            return jsonify({"success": False, "error": f"获取 token 列表失败: {export_resp.status_code}"}), 500
        all_tokens = export_resp.json().get("tokens", [])
    except Exception as e:
        return jsonify({"success": False, "error": f"获取 token 失败: {e}"}), 500

    # 获取 token info（含 nsfw_enabled 状态和 id）
    try:
        info_resp = session.get(f"{WORKERS_URL}/api/tokens", cookies=cookies, timeout=10)
        token_infos = {t["name"]: t for t in info_resp.json().get("tokens", [])} if info_resp.status_code == 200 else {}
    except Exception:
        token_infos = {}

    # 过滤未启用 NSFW 的 token
    tokens_to_process = [t for t in all_tokens if not token_infos.get(t.get("name", ""), {}).get("nsfw_enabled", False)]

    if not tokens_to_process:
        return jsonify({
            "success": True, "message": "所有 Token 都已开启 NSFW",
            "total": 0, "processed": 0, "skipped": len(all_tokens), "done": True,
        })

    batch = tokens_to_process[offset:offset + BATCH_SIZE]

    # NSFW JS 脚本（在浏览器中执行）
    NSFW_JS = """async () => {
        // 设置生日
        try {
            await fetch('/rest/auth/set-birth-date', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({birthDate: '2000-01-01T00:00:00.000Z'})
            });
        } catch(e) {}
        // 启用 NSFW
        try {
            const payload = new Uint8Array([
                0x00, 0x00, 0x00, 0x00, 0x20,
                0x0a, 0x02, 0x10, 0x01,
                0x12, 0x1a, 0x0a, 0x18,
                0x61, 0x6c, 0x77, 0x61, 0x79, 0x73, 0x5f, 0x73,
                0x68, 0x6f, 0x77, 0x5f, 0x6e, 0x73, 0x66, 0x77,
                0x5f, 0x63, 0x6f, 0x6e, 0x74, 0x65, 0x6e, 0x74
            ]);
            const r = await fetch('/auth_mgmt.AuthManagement/UpdateUserFeatureControls', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/grpc-web+proto',
                    'x-grpc-web': '1',
                    'x-user-agent': 'connect-es/2.1.1'
                },
                body: payload
            });
            return {ok: r.ok, status: r.status};
        } catch(e) { return {ok: false, status: e.message}; }
    }"""

    async def _batch_nsfw():
        """使用真实 Chrome CDP 批量执行 NSFW 启用"""
        from playwright.async_api import async_playwright
        import shutil

        CDP_PORT = 9322  # 使用不同端口避免与注册冲突
        user_data_dir = os.path.abspath("/tmp/ChromeDevData/NSFW_batch")

        results = []
        success_count = 0
        fail_count = 0
        chrome_proc = None
        pw = None
        browser = None

        try:
            # 启动真实 Chrome
            chrome_proc = _start_chrome(CDP_PORT, user_data_dir, headless=True)
            if not chrome_proc:
                return [{"name": "系统", "success": False, "message": "Chrome 启动失败"}], 0, len(batch)

            import time as _time
            _time.sleep(1)

            pw = await async_playwright().start()
            browser = await pw.chromium.connect_over_cdp(
                f"http://localhost:{CDP_PORT}", timeout=10000
            )

            for token in batch:
                sso = token.get("sso", "")
                sso_rw = token.get("sso_rw", "")
                cf_clearance = token.get("cf_clearance", "")
                name = token.get("name", sso[:8] + "...")

                if not sso:
                    results.append({"name": name, "success": False, "message": "无 SSO"})
                    fail_count += 1
                    continue

                ctx = None
                page = None
                try:
                    ctx = await browser.new_context()
                    # 设置 SSO cookies
                    cookie_list = [
                        {"name": "sso", "value": sso, "domain": ".grok.com", "path": "/"},
                    ]
                    if sso_rw:
                        cookie_list.append({"name": "sso-rw", "value": sso_rw, "domain": ".grok.com", "path": "/"})
                    if cf_clearance:
                        cookie_list.append({"name": "cf_clearance", "value": cf_clearance, "domain": ".grok.com", "path": "/"})
                    await ctx.add_cookies(cookie_list)

                    page = await ctx.new_page()
                    await page.goto("https://grok.com/", timeout=20000)
                    await asyncio.sleep(3)  # 等待 Cloudflare 验证通过

                    nsfw_ok = await page.evaluate(NSFW_JS)

                    if nsfw_ok and nsfw_ok.get("ok"):
                        success_count += 1
                        # 更新 Workers 端状态
                        info = token_infos.get(name, {})
                        tid = info.get("id", "")
                        if tid:
                            try:
                                session.post(
                                    f"{WORKERS_URL}/api/tokens/{tid}/enable-nsfw",
                                    json={}, headers={'Content-Type': 'application/json'},
                                    cookies=cookies, timeout=5,
                                )
                            except Exception:
                                pass
                        results.append({"name": name, "success": True, "message": "OK"})
                    else:
                        fail_count += 1
                        status = nsfw_ok.get("status", "?") if nsfw_ok else "?"
                        results.append({"name": name, "success": False, "message": f"HTTP {status}"})

                except Exception as e:
                    fail_count += 1
                    results.append({"name": name, "success": False, "message": str(e)[:100]})
                finally:
                    if ctx:
                        try:
                            await ctx.close()
                        except Exception:
                            pass

        except Exception as e:
            if not results:
                results.append({"name": "系统", "success": False, "message": str(e)[:100]})
                fail_count = len(batch)
        finally:
            if browser:
                try:
                    await browser.close()
                except Exception:
                    pass
            if pw:
                try:
                    await pw.stop()
                except Exception:
                    pass
            if chrome_proc:
                try:
                    chrome_proc.terminate()
                    chrome_proc.wait(timeout=5)
                except Exception:
                    try:
                        chrome_proc.kill()
                    except Exception:
                        pass
            _kill_port(CDP_PORT)
            try:
                if os.path.exists(user_data_dir):
                    shutil.rmtree(user_data_dir, ignore_errors=True)
            except Exception:
                pass

        return results, success_count, fail_count

    # 在新的事件循环中运行
    results, success_count, fail_count = asyncio.run(_batch_nsfw())

    new_offset = offset + len(batch)
    done = new_offset >= len(tokens_to_process)

    return jsonify({
        "success": True,
        "results": results,
        "success_count": success_count,
        "fail_count": fail_count,
        "processed": new_offset,
        "total": len(tokens_to_process),
        "skipped": len(all_tokens) - len(tokens_to_process),
        "done": done,
        "next_offset": None if done else new_offset,
    })

@app.route("/api/logs", methods=["GET", "DELETE"])
def proxy_logs():
    """代理日志 API"""
    session, cookies = get_workers_client()
    if request.method == "DELETE":
        resp = session.delete(
            f"{WORKERS_URL}/api/logs",
            cookies=cookies
        )
    else:
        resp = session.get(
            f"{WORKERS_URL}/api/logs",
            params=request.args,
            cookies=cookies
        )
    return Response(resp.content, status=resp.status_code)

@app.route("/api/logs/stats", methods=["GET"])
def proxy_logs_stats():
    """代理日志统计 API"""
    session, cookies = get_workers_client()
    resp = session.get(f"{WORKERS_URL}/api/logs/stats", cookies=cookies)
    return Response(resp.content, status=resp.status_code)

@app.route("/api/api-keys", methods=["GET", "POST"])
def proxy_apikeys():
    """代理 API Key 列表/创建"""
    session, cookies = get_workers_client()
    if request.method == "POST":
        resp = session.post(
            f"{WORKERS_URL}/api/keys",
            json=request.get_json(),
            headers={'Content-Type': 'application/json'},
            cookies=cookies
        )
    else:
        resp = session.get(f"{WORKERS_URL}/api/keys", cookies=cookies)
    return Response(resp.content, status=resp.status_code)

@app.route("/api/api-keys/<path:key_id>", methods=["GET", "DELETE"])
def proxy_apikey_detail(key_id):
    """代理 API Key 详情"""
    session, cookies = get_workers_client()
    if request.method == "DELETE":
        resp = session.delete(f"{WORKERS_URL}/api/keys/{key_id}", cookies=cookies)
    else:
        resp = session.get(f"{WORKERS_URL}/api/keys/{key_id}", cookies=cookies)
    return Response(resp.content, status=resp.status_code)

@app.route("/api/api-keys/<path:key_id>/toggle", methods=["POST"])
def proxy_apikey_toggle(key_id):
    """代理 API Key 切换 - 需要先获取当前状态再反转"""
    session, cookies = get_workers_client()
    # 先获取当前状态
    resp = session.get(f"{WORKERS_URL}/api/keys", cookies=cookies)
    if resp.status_code == 200:
        keys = resp.json().get("keys", [])
        current_key = next((k for k in keys if k["id"] == key_id), None)
        if current_key:
            new_enabled = not current_key.get("enabled", True)
            resp = session.patch(
                f"{WORKERS_URL}/api/keys/{key_id}",
                json={"enabled": new_enabled},
                headers={'Content-Type': 'application/json'},
                cookies=cookies
            )
            return Response(resp.content, status=resp.status_code)
    return Response(resp.content, status=resp.status_code)


# ── OpenAI 兼容 API (/v1/chat/completions) ──────────────────────

API_KEYS_FILE = os.path.join(os.path.dirname(__file__), "api_keys.json")

GROK_MODEL_MAP = {
    # Grok 3 系列
    "grok-3":             {"grokModel": "grok-3",                     "modelMode": "MODEL_MODE_AUTO"},
    "grok-3-fast":        {"grokModel": "grok-3",                     "modelMode": "MODEL_MODE_FAST"},
    # Grok 4 系列
    "grok-4":             {"grokModel": "grok-4",                     "modelMode": "MODEL_MODE_AUTO"},
    "grok-4-mini":        {"grokModel": "grok-4-mini-thinking-tahoe", "modelMode": "MODEL_MODE_GROK_4_MINI_THINKING"},
    "grok-4-fast":        {"grokModel": "grok-4",                     "modelMode": "MODEL_MODE_FAST"},
    "grok-4-heavy":       {"grokModel": "grok-4",                     "modelMode": "MODEL_MODE_HEAVY"},
    # Grok 4.1 系列
    "grok-4.1":           {"grokModel": "grok-4-1-thinking-1129",     "modelMode": "MODEL_MODE_AUTO"},
    "grok-4.1-fast":      {"grokModel": "grok-4-1-thinking-1129",     "modelMode": "MODEL_MODE_FAST"},
    "grok-4.1-expert":    {"grokModel": "grok-4-1-thinking-1129",     "modelMode": "MODEL_MODE_EXPERT"},
    "grok-4.1-thinking":  {"grokModel": "grok-4-1-thinking-1129",     "modelMode": "MODEL_MODE_GROK_4_1_THINKING"},
    # Image 模型（各种宽高比）
    "grok-image":         {"grokModel": "grok-3", "modelMode": "MODEL_MODE_FAST", "type": "image", "ratio": "1:1"},
    "grok-image-1_1":     {"grokModel": "grok-3", "modelMode": "MODEL_MODE_FAST", "type": "image", "ratio": "1:1"},
    "grok-image-2_3":     {"grokModel": "grok-3", "modelMode": "MODEL_MODE_FAST", "type": "image", "ratio": "2:3"},
    "grok-image-3_2":     {"grokModel": "grok-3", "modelMode": "MODEL_MODE_FAST", "type": "image", "ratio": "3:2"},
    "grok-image-16_9":    {"grokModel": "grok-3", "modelMode": "MODEL_MODE_FAST", "type": "image", "ratio": "16:9"},
    "grok-image-9_16":    {"grokModel": "grok-3", "modelMode": "MODEL_MODE_FAST", "type": "image", "ratio": "9:16"},
    # 兼容别名
    "grok-3-mini":        {"grokModel": "grok-3",                     "modelMode": "MODEL_MODE_FAST"},
    "grok-2":             {"grokModel": "grok-3",                     "modelMode": "MODEL_MODE_FAST"},
}


def _load_api_keys() -> list[dict]:
    if not os.path.exists(API_KEYS_FILE):
        return []
    try:
        with open(API_KEYS_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return []


def _save_api_keys(keys: list[dict]):
    with open(API_KEYS_FILE, "w") as f:
        json.dump(keys, f, indent=2, ensure_ascii=False)


def _validate_bearer(req) -> dict | None:
    """从 Authorization: Bearer <key> 验证 API Key，返回 key 信息或 None"""
    auth = req.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth[7:].strip()
    if not token:
        return None
    keys = _load_api_keys()
    for k in keys:
        if k.get("key") == token and k.get("enabled", True):
            return k
    return None


def _openai_error(message: str, status: int, code: str = ""):
    return jsonify({"error": {"message": message, "type": "invalid_request_error" if status < 500 else "server_error", "code": code or None}}), status


def _openai_sse_chunk(resp_id: str, model: str, content: str = "", role: str | None = None, finish_reason: str | None = None) -> str:
    delta = {}
    if role:
        delta["role"] = role
        delta["content"] = ""
    elif content:
        delta["content"] = content
    chunk = {
        "id": resp_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "logprobs": None, "finish_reason": finish_reason}],
    }
    return f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"


def _extract_openai_messages(messages: list[dict]) -> str:
    """将 OpenAI messages 格式转成单个文本"""
    parts = []
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if isinstance(content, list):
            text_parts = [item.get("text", "") for item in content if item.get("type") == "text"]
            content = "\n".join(text_parts)
        if not content:
            continue
        if role == "system":
            parts.append(f"[System]: {content}")
        elif role == "assistant":
            parts.append(f"[Assistant]: {content}")
        else:
            parts.append(content)
    return "\n\n".join(parts)


def _tls_stream_chat(token: dict, text: str, model_id: str):
    """用 tls_client 流式聊天，yield (type, data) 元组"""
    import tls_client

    model_info = GROK_MODEL_MAP.get(model_id, GROK_MODEL_MAP.get("grok-3-fast"))
    grok_model = model_info["grokModel"]
    model_mode = model_info["modelMode"]

    payload = {
        "temporary": True,
        "modelName": grok_model,
        "modelMode": model_mode,
        "message": text,
        "fileAttachments": [],
        "imageAttachments": [],
        "disableSearch": False,
        "enableImageGeneration": False,
        "returnImageBytes": False,
        "returnRawGrokInXaiRequest": False,
        "enableImageStreaming": False,
        "imageGenerationCount": 0,
        "forceConcise": False,
        "toolOverrides": {},
        "enableSideBySide": True,
        "sendFinalMetadata": True,
        "isReasoning": False,
        "disableTextFollowUps": False,
        "disableMemory": True,
        "forceSideBySide": False,
        "isAsyncChat": False,
        "disableSelfHarmShortCircuit": False,
    }

    session = tls_client.Session(client_identifier=GROK_TLS_CLIENT_ID)
    headers = _build_grok_headers(token)

    try:
        resp = session.post(
            GROK_CHAT_API,
            headers=headers,
            json=payload,
            timeout_seconds=120,
        )
    except Exception as exc:
        yield ("error", f"Network error: {exc}")
        return
    finally:
        session.close()

    if resp.status_code != 200:
        yield ("error", f"HTTP {resp.status_code}: {(resp.text or '')[:300]}")
        return

    text_body = resp.text or ""
    is_thinking = False
    thinking_finished = False
    response_id = ""

    for line in text_body.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue

        r = (data.get("result") or {}).get("response")
        if not r:
            continue

        if r.get("responseId") and not response_id:
            response_id = r["responseId"]

        # modelResponse = 最终响应，结束
        if r.get("modelResponse"):
            if is_thinking:
                yield ("token", "\n</think>\n")
            break

        # token 流
        tok = r.get("token")
        if tok is not None and tok != "":
            tok = str(tok)
            current_thinking = bool(r.get("isThinking"))

            if thinking_finished and current_thinking:
                continue

            content = tok
            if not is_thinking and current_thinking:
                content = f"<think>\n{content}"
            elif is_thinking and not current_thinking:
                content = f"\n</think>\n{content}"
                thinking_finished = True

            yield ("token", content)
            is_thinking = current_thinking

    if is_thinking:
        yield ("token", "\n</think>\n")

    yield ("done", response_id)


# ── Token 远程同步路由 ──

@app.route("/api/import-tokens", methods=["POST"])
def api_import_tokens():
    """接收远程推送过来的 tokens 并合并到本地"""
    body = request.get_json(silent=True) or {}
    incoming = body.get("tokens", [])
    if not incoming:
        return jsonify({"success": False, "error": "No tokens provided"}), 400

    existing = _load_full_tokens()
    existing_emails = {t.get("email", "").lower() for t in existing if t.get("email")}

    added = 0
    for t in incoming:
        email = (t.get("email") or "").lower()
        if email and email not in existing_emails:
            existing.append(t)
            existing_emails.add(email)
            added += 1

    _save_tokens(existing)
    return jsonify({"success": True, "added": added, "total": len(existing)})


@app.route("/api/sync-tokens-to-remote", methods=["POST"])
def api_sync_tokens_to_remote():
    """把本地 tokens 推送到远程服务器"""
    body = request.get_json(silent=True) or {}
    remote_url = body.get("remote_url", "").strip().rstrip("/")
    if not remote_url:
        return jsonify({"success": False, "error": "remote_url is required"}), 400

    tokens = _load_full_tokens()
    active_tokens = [t for t in tokens if t.get("status") == "active" and t.get("sso")]
    if not active_tokens:
        return jsonify({"success": False, "error": "No active tokens to sync"}), 400

    try:
        import requests as req_lib
        resp = req_lib.post(
            f"{remote_url}/api/import-tokens",
            json={"tokens": active_tokens},
            timeout=30,
        )
        result = resp.json()
        return jsonify({"success": True, "remote_response": result, "sent": len(active_tokens)})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ── API Key 管理路由 ──

@app.route("/api/keys", methods=["GET"])
def api_keys_list():
    keys = _load_api_keys()
    return jsonify({"keys": [
        {**k, "key_preview": k.get("key", "")[:8] + "..."} for k in keys
    ], "total": len(keys), "enabled": sum(1 for k in keys if k.get("enabled", True))})


@app.route("/api/keys", methods=["POST"])
def api_keys_create():
    body = request.get_json(silent=True) or {}
    name = str(body.get("name", "")).strip() or "default"
    new_key = {
        "id": uuid.uuid4().hex[:16],
        "key": f"sk-{uuid.uuid4().hex}",
        "name": name,
        "enabled": True,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "usage_count": 0,
    }
    keys = _load_api_keys()
    keys.append(new_key)
    _save_api_keys(keys)
    return jsonify({"success": True, "key": new_key})


@app.route("/api/keys/<key_id>", methods=["DELETE"])
def api_keys_delete(key_id):
    keys = _load_api_keys()
    new_keys = [k for k in keys if k.get("id") != key_id]
    if len(new_keys) == len(keys):
        return jsonify({"success": False, "error": "Not found"}), 404
    _save_api_keys(new_keys)
    return jsonify({"success": True})


@app.route("/api/keys/<key_id>", methods=["PATCH"])
def api_keys_toggle(key_id):
    body = request.get_json(silent=True) or {}
    keys = _load_api_keys()
    for k in keys:
        if k.get("id") == key_id:
            if "enabled" in body:
                k["enabled"] = bool(body["enabled"])
            _save_api_keys(keys)
            return jsonify({"success": True})
    return jsonify({"success": False, "error": "Not found"}), 404


# ── OpenAI 兼容路由 ──

@app.route("/v1/chat/completions", methods=["POST"])
def openai_chat_completions():
    """OpenAI 兼容聊天接口"""
    # Bearer Token 认证
    key_info = _validate_bearer(request)
    if not key_info:
        return _openai_error("Invalid API key", 401, "invalid_api_key")

    body = request.get_json(silent=True) or {}
    model = str(body.get("model", "grok-3-fast"))
    messages = body.get("messages", [])
    stream = bool(body.get("stream", False))

    if not messages:
        return _openai_error("messages is required", 400)

    text = _extract_openai_messages(messages)
    if not text.strip():
        return _openai_error("Empty message", 400)

    # 加载 tokens 进行轮换
    try:
        tokens = _load_full_tokens()
    except Exception:
        return _openai_error("Failed to load tokens", 500)

    candidates = [t for t in tokens if t.get("status") == "active" and t.get("sso")]
    if not candidates:
        return _openai_error("No available tokens", 503)

    random.shuffle(candidates)
    resp_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"

    # ── Image 模型：走生图逻辑 ──
    model_cfg = GROK_MODEL_MAP.get(model, {})
    if model_cfg.get("type") == "image":
        aspect_ratio = model_cfg.get("ratio", "1:1")
        base_url = request.host_url.rstrip("/")  # e.g. http://70.39.195.121:8086
        img_content = ""
        for token in candidates:
            result = _tls_generate_images(token, text, 4, aspect_ratio, False)
            if result.get("images"):
                for i, img in enumerate(result["images"]):
                    # 用代理 URL 让客户端能直接显示图片
                    proxy_url = img.get("url") or img.get("image_url", "")
                    if proxy_url.startswith("/"):
                        proxy_url = f"{base_url}{proxy_url}"
                    img_content += f"![image-{i+1}]({proxy_url})\n\n"
                break
            err = result.get("error", "")
            if "rate" in err.lower() or "429" in err:
                _block_local_token(token.get("id", ""))
                continue
            img_content = f"生图失败: {err}"
            break
        if not img_content:
            img_content = "所有 token 速率限制，请稍后再试"

        # 更新 usage
        keys = _load_api_keys()
        for k in keys:
            if k.get("id") == key_info.get("id"):
                k["usage_count"] = k.get("usage_count", 0) + 1
                break
        _save_api_keys(keys)

        if stream:
            def img_stream():
                yield _openai_sse_chunk(resp_id, model, "", "assistant", None)
                yield _openai_sse_chunk(resp_id, model, img_content)
                yield _openai_sse_chunk(resp_id, model, "", None, "stop")
                yield "data: [DONE]\n\n"
            return Response(img_stream(), mimetype="text/event-stream", headers={
                "Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"})
        return jsonify({
            "id": resp_id, "object": "chat.completion", "created": int(time.time()), "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": img_content}, "logprobs": None, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        })

    if stream:
        def generate_stream():
            yield _openai_sse_chunk(resp_id, model, "", "assistant", None)
            success = False

            for token in candidates:
                for event_type, event_data in _tls_stream_chat(token, text, model):
                    if event_type == "token":
                        yield _openai_sse_chunk(resp_id, model, event_data)
                    elif event_type == "done":
                        success = True
                        break
                    elif event_type == "error":
                        err_lower = event_data.lower()
                        if "429" in err_lower or "rate" in err_lower:
                            _block_local_token(token.get("id", ""))
                            break
                        yield _openai_sse_chunk(resp_id, model, f"[Error: {event_data}]")
                        break
                if success:
                    break

            if not success and not any("Error" in "" for _ in []):
                yield _openai_sse_chunk(resp_id, model, "[Error: All tokens exhausted]")

            yield _openai_sse_chunk(resp_id, model, "", None, "stop")
            yield "data: [DONE]\n\n"

            # 更新 usage
            keys = _load_api_keys()
            for k in keys:
                if k.get("id") == key_info.get("id"):
                    k["usage_count"] = k.get("usage_count", 0) + 1
                    break
            _save_api_keys(keys)

        return Response(generate_stream(), mimetype="text/event-stream", headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        })

    # 非流式
    full_content = ""
    success = False

    for token in candidates:
        for event_type, event_data in _tls_stream_chat(token, text, model):
            if event_type == "token":
                full_content += event_data
            elif event_type == "done":
                success = True
                break
            elif event_type == "error":
                err_lower = event_data.lower()
                if "429" in err_lower or "rate" in err_lower:
                    _block_local_token(token.get("id", ""))
                    full_content = ""
                    break
                return _openai_error(event_data, 500)
        if success:
            break

    if not success:
        return _openai_error("All tokens rate limited", 429, "rate_limit_exceeded")

    # 更新 usage
    keys = _load_api_keys()
    for k in keys:
        if k.get("id") == key_info.get("id"):
            k["usage_count"] = k.get("usage_count", 0) + 1
            break
    _save_api_keys(keys)

    return jsonify({
        "id": resp_id,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": full_content}, "logprobs": None, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    })


@app.route("/v1/models", methods=["GET"])
def openai_list_models():
    """OpenAI 兼容模型列表"""
    models = []
    for mid in GROK_MODEL_MAP:
        models.append({"id": mid, "object": "model", "created": 1700000000, "owned_by": "xai"})
    return jsonify({"object": "list", "data": models})


@app.route("/api/image-proxy")
def proxy_grok_image():
    """代理 assets.grok.com 图片下载（用生成该图的 token 的 cookie）"""
    import tls_client
    target_url = request.args.get("url", "").strip()
    token_id = request.args.get("tid", "").strip()
    if not target_url or not target_url.startswith("https://assets.grok.com/"):
        return jsonify({"error": "Invalid or missing URL"}), 400

    try:
        tokens = _load_full_tokens()
        # 优先找指定 token，找不到则降级用第一个活跃 token
        token = None
        if token_id:
            token = next((t for t in tokens if t.get("id") == token_id and t.get("sso")), None)
        if not token:
            active = [t for t in tokens if t.get("status") == "active" and t.get("sso")]
            token = active[0] if active else None
        if not token:
            return jsonify({"error": "No available tokens"}), 500

        # 用 requests 下载图片（tls_client 对二进制有 UTF-8 编码损坏）
        img_resp = requests.get(
            target_url,
            headers={
                "Accept": "image/*,*/*;q=0.8",
                "Cookie": _build_grok_cookie(token),
                "Referer": "https://grok.com/",
                "User-Agent": GROK_USER_AGENT,
            },
            timeout=60,
        )

        if img_resp.status_code != 200:
            return jsonify({"error": f"Upstream {img_resp.status_code}"}), img_resp.status_code

        content_type = img_resp.headers.get("content-type", "image/jpeg")
        return Response(img_resp.content, mimetype=content_type, headers={
            "Cache-Control": "public, max-age=86400",
            "Access-Control-Allow-Origin": "*",
        })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/imagine", methods=["POST"])
def proxy_imagine():
    """本地真实浏览器直连图片生成 API (SSE 流)"""
    req_data = request.get_json(silent=True) or {}
    out_queue: queue.Queue = queue.Queue()

    def runner():
        try:
            asyncio.run(_run_local_imagine_job(req_data, out_queue))
        except Exception as e:
            _emit_queue_event(out_queue, "error", {"type": "error", "message": str(e)})
        finally:
            out_queue.put(None)

    threading.Thread(target=runner, daemon=True).start()

    def generate():
        while True:
            item = out_queue.get()
            if item is None:
                break
            event, payload = item
            yield _sse(event, payload)

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )

@app.route("/api/video/generate", methods=["POST"])
def proxy_video_generate():
    """代理视频生成 API (SSE 流)"""
    session, cookies = get_workers_client()
    headers = {'Content-Type': 'application/json'}
    # 在生成器外部获取请求数据，避免 context 问题
    req_data = request.get_json()

    def generate():
        resp = session.post(
            f"{WORKERS_URL}/api/video/generate",
            json=req_data,
            headers=headers,
            cookies=cookies,
            stream=True
        )
        for chunk in resp.iter_content(chunk_size=None):
            yield chunk

    return Response(generate(), mimetype="text/event-stream")

@app.route("/api/proxy/video")
def proxy_video_url():
    """代理视频 URL，解决 CORS 问题"""
    video_url = request.args.get("url")
    if not video_url:
        return jsonify({"error": "Missing url parameter"}), 400

    session, cookies = get_workers_client()
    try:
        resp = session.get(video_url, cookies=cookies, stream=True, timeout=60)
        excluded_headers = ['content-encoding', 'content-length', 'transfer-encoding', 'connection']
        headers = [(k, v) for k, v in resp.headers.items() if k.lower() not in excluded_headers]
        return Response(resp.iter_content(chunk_size=8192), status=resp.status_code, headers=headers)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/v1/<path:path>", methods=["GET", "POST"])
def proxy_v1_api(path):
    """代理 OpenAI 兼容 API"""
    session, cookies = get_workers_client()
    headers = {k: v for k, v in request.headers if k.lower() in ['content-type', 'authorization']}
    resp = session.request(
        method=request.method,
        url=f"{WORKERS_URL}/v1/{path}",
        headers=headers,
        cookies=cookies,
        data=request.get_data()
    )
    return Response(resp.content, status=resp.status_code)



# ══════════════════════════════════════════════════════════════
#  SSE 事件流
# ══════════════════════════════════════════════════════════════

@app.route("/api/stream")
def api_stream():
    """SSE 事件流"""

    def event_generator():
        q = manager.add_subscriber()
        try:
            # 发送初始状态
            yield f"data: {json.dumps(manager.get_status(), ensure_ascii=False)}\n\n"

            while True:
                try:
                    msg = q.get(timeout=30)
                    yield f"data: {json.dumps(msg, ensure_ascii=False)}\n\n"
                except queue.Empty:
                    # 心跳保活
                    yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
        except GeneratorExit:
            pass
        finally:
            manager.remove_subscriber(q)

    return Response(
        event_generator(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ══════════════════════════════════════════════════════════════
#  Workers 代理路由 (将 /api/workers/* 代理到 Workers)
# ══════════════════════════════════════════════════════════════

import requests

WORKERS_SESSION = requests.Session()

@app.route("/api/workers/<path:subpath>", methods=["GET", "POST", "DELETE", "PUT", "PATCH"])
def proxy_workers(subpath):
    """代理 Workers API 请求"""
    url = f"{WORKERS_URL}/{subpath}"

    # 转发请求
    resp = WORKERS_SESSION.request(
        method=request.method,
        url=url,
        headers={k: v for k, v in request.headers if k.lower() not in ['host', 'content-length']},
        data=request.get_data(),
        params=request.args,
        allow_redirects=False
    )

    # 返回响应
    excluded_headers = ['content-encoding', 'content-length', 'transfer-encoding', 'connection']
    headers = [(k, v) for k, v in resp.headers.items() if k.lower() not in excluded_headers]

    return Response(resp.content, resp.status_code, headers)


# ══════════════════════════════════════════════════════════════
#  启动
# ══════════════════════════════════════════════════════════════

if __name__ == "__main__":
    print("=" * 50)
    print("  仙侠绘卷 · Grok 统一面板")
    print("  打开浏览器访问: http://localhost:8086")
    print(f"  Workers URL: {WORKERS_URL}")
    print("=" * 50)
    app.run(host="0.0.0.0", port=8086, debug=False, threaded=True)
