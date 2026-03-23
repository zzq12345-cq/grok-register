"""
Grok 注册助手 - Mac 版 (Chrome CDP)
使用真实 Chrome 浏览器 + CDP 连接，避免 Camoufox CSP/SRI 问题
"""
import asyncio
import json
import re
import time
import random
import gc
import os
import signal
import shutil
import string
import subprocess
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime as dt

from playwright.async_api import async_playwright

from email_utils import create_test_email, fetch_verification_code
from post_register import post_register, extract_user_id

# ── Mac 专用：代理绕过 ─────────────────────────────────────────
os.environ["NO_PROXY"] = "localhost,127.0.0.1"
os.environ["no_proxy"] = "localhost,127.0.0.1"

SIGNUP_URL = "https://accounts.x.ai/sign-up?redirect=grok-com"

file_lock = threading.Lock()
timestamp = dt.now().strftime("%m%d%H%M")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
GROK_DIR = os.path.join(SCRIPT_DIR, "result_grok")
DEBUG_DIR = os.path.join(os.path.expanduser("~"), "Library", "Logs", "grok_debug")
os.makedirs(GROK_DIR, exist_ok=True)
os.makedirs(DEBUG_DIR, exist_ok=True)

JSON_FILE = os.path.join(GROK_DIR, "grok.json")
RESERVED_RESULT_FILES = {os.path.basename(JSON_FILE), "sso.json"}

first_names = [
    "James", "John", "Robert", "Michael", "William",
    "David", "Richard", "Joseph", "Thomas", "Charles",
]
last_names = [
    "Smith", "Johnson", "Williams", "Brown", "Jones",
    "Garcia", "Miller", "Davis", "Rodriguez", "Martinez",
]


def generate_password(length=14) -> str:
    upper = random.choice(string.ascii_uppercase)
    lower = random.choice(string.ascii_lowercase)
    digit = random.choice(string.digits)
    special = random.choice("!@#$%&*")
    rest = random.choices(
        string.ascii_letters + string.digits + "!@#$%&*",
        k=length - 4,
    )
    chars = list(upper + lower + digit + special + "".join(rest))
    random.shuffle(chars)
    return "".join(chars)


def sanitize_email_filename(email_address: str) -> str:
    """将邮箱转换为安全的结果文件名。"""
    safe_email = (email_address or "").strip()
    if not safe_email:
        raise ValueError("邮箱不能为空")
    safe_email = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", safe_email)
    return f"{safe_email}.json"


def get_account_file_path(email_address: str) -> str:
    """获取单个账号结果文件路径。"""
    return os.path.join(GROK_DIR, sanitize_email_filename(email_address))


def list_account_files() -> list[str]:
    """列出 result_grok 下的账号结果文件。"""
    account_files = []
    for entry in os.listdir(GROK_DIR):
        if not entry.endswith(".json") or entry in RESERVED_RESULT_FILES:
            continue
        file_path = os.path.join(GROK_DIR, entry)
        if os.path.isfile(file_path):
            account_files.append(file_path)
    return account_files


def load_account_from_file(file_path: str) -> dict:
    """读取单个账号结果文件。"""
    with open(file_path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_latest_account() -> dict | None:
    """读取最近写入的账号结果。"""
    account_files = list_account_files()
    if not account_files:
        return None

    latest_file = max(account_files, key=os.path.getmtime)
    try:
        return load_account_from_file(latest_file)
    except (OSError, json.JSONDecodeError):
        return None


def save_account_result(account: dict) -> str:
    """按邮箱保存账号结果到独立 JSON 文件。"""
    account_file = get_account_file_path(account.get("email", ""))
    with file_lock:
        with open(account_file, "w", encoding="utf-8") as f:
            json.dump(account, f, ensure_ascii=False, indent=2)
    return account_file


async def wait_for_cookie_value(context, cookie_name: str, timeout_sec: int = 20) -> str:
    """等待指定 cookie 出现并返回其值。"""
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        try:
            cookies = await context.cookies()
            cdict = {c["name"]: c["value"] for c in cookies}
            if cdict.get(cookie_name):
                return cdict[cookie_name]
        except Exception:
            pass
        await asyncio.sleep(1)
    return ""


# ══════════════════════════════════════════════════════════════
#  Chrome 进程管理
# ══════════════════════════════════════════════════════════════

def _find_chrome() -> str:
    """查找 Chrome 可执行文件"""
    candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    return ""


def _kill_port(port: int):
    """杀掉占用指定端口的进程"""
    try:
        result = subprocess.run(
            ["lsof", "-ti", f":{port}"],
            capture_output=True, text=True, timeout=5,
        )
        for pid in result.stdout.strip().split():
            if pid:
                subprocess.run(["kill", "-9", pid], timeout=5)
    except Exception:
        pass


def _start_chrome(port: int, user_data_dir: str, headless: bool = False):
    """启动 Chrome 并等待 CDP 就绪"""
    chrome_exe = _find_chrome()
    if not chrome_exe:
        return None

    _kill_port(port)
    if os.path.exists(user_data_dir):
        shutil.rmtree(user_data_dir, ignore_errors=True)

    args = [
        chrome_exe,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={user_data_dir}",
        "--incognito",
        "--window-size=500,800",
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
        proc = subprocess.Popen(
            args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        import urllib.request
        for _ in range(10):
            try:
                urllib.request.urlopen(
                    f"http://localhost:{port}/json/version", timeout=1
                )
                return proc
            except Exception:
                time.sleep(1)
        return proc
    except Exception:
        return None


# ══════════════════════════════════════════════════════════════
#  核心注册逻辑 (Chrome CDP, 异步)
# ══════════════════════════════════════════════════════════════

async def async_run_job(
    thread_id: int,
    task_id: int,
    timeout_sec: int = 180,
    log_func=None,
    headless: bool = False,
    email_domain: str = "",
) -> dict | bool:
    """
    运行一次完整的注册流程 (Chrome CDP)
    return: 账号结果 dict (成功), False (失败/超时)
    """
    port = 9222 + thread_id
    user_data_dir = os.path.abspath(f"/tmp/ChromeDevData/Thread_{thread_id}")

    prefix = f"[T{thread_id}]"
    job_start = time.time()

    def log(msg):
        ts = dt.now().strftime("%H:%M:%S")
        full_msg = f"{prefix} {msg}"
        if log_func:
            log_func(msg)
        else:
            print(f"[{ts}] {full_msg}")

    def check_timeout():
        if time.time() - job_start > timeout_sec:
            raise TimeoutError("Timeout")

    chrome_proc = None
    pw = None
    browser = None
    context = None
    page = None

    try:
        # ── 步骤 1: 创建临时邮箱 ──────────────────────────────
        check_timeout()
        log("[步骤1] 创建临时邮箱...")
        email_token = None
        email_address = None

        for _retry in range(3):
            try:
                token, addr = await asyncio.to_thread(
                    create_test_email, email_domain or None
                )
                if token and addr:
                    email_token = token
                    email_address = addr
                    break
            except Exception as e:
                log(f"[步骤1] 第{_retry+1}次失败: {e}")
            await asyncio.sleep(3)

        if not email_address:
            log("[步骤1] ❌ 邮箱创建失败")
            return False
        log(f"[步骤1] ✓ 邮箱: {email_address}")

        grok_password = generate_password()
        fname = random.choice(first_names)
        lname = random.choice(last_names)

        # ── 步骤 2: 启动 Chrome ───────────────────────────────
        check_timeout()
        mode_label = "headless" if headless else "有头模式"
        log(f"[步骤2] 启动 Chrome ({mode_label})...")

        chrome_proc = await asyncio.to_thread(
            _start_chrome, port, user_data_dir, headless
        )
        if not chrome_proc:
            log("[步骤2] ❌ Chrome 启动失败")
            return False
        await asyncio.sleep(1)

        pw = await async_playwright().start()
        try:
            browser = await pw.chromium.connect_over_cdp(
                f"http://localhost:{port}", timeout=10000
            )
        except Exception as e:
            log(f"[步骤2] ❌ CDP 连接失败: {e}")
            return False

        context = browser.contexts[0]
        page = context.pages[0] if context.pages else await context.new_page()
        log(f"[步骤2] ✓ Chrome 就绪 ({mode_label})")

        # ── SSO Response Header 监听 ──────────────────────────
        sso_state = {"sso": "", "sso_rw": "", "found": False}

        async def on_response_sso(response):
            try:
                if sso_state["found"]:
                    return
                headers = await response.all_headers()
                set_cookie = headers.get("set-cookie", "")
                if "sso=" in set_cookie:
                    sso_match = re.search(r'(?<![a-z-])sso=([^;]+)', set_cookie)
                    sso_rw_match = re.search(r'sso-rw=([^;]+)', set_cookie)
                    if sso_match:
                        sso_state["sso"] = sso_match.group(1)
                        if sso_rw_match:
                            sso_state["sso_rw"] = sso_rw_match.group(1)
                        sso_state["found"] = True
                        log("[Response监听] ✓ 捕获 SSO cookie!")
            except Exception:
                pass

        page.on("response", on_response_sso)

        # ── 步骤 3: 打开注册页面 ──────────────────────────────
        check_timeout()
        log("[步骤3] 打开注册页面...")
        try:
            await page.goto(SIGNUP_URL, timeout=20000)
        except Exception as e:
            log(f"[步骤3] 页面加载异常(继续): {e}")

        log(f"[步骤3] URL: {page.url}")

        # 等待注册页面元素
        for cf_wait in range(30):
            has_signup = await page.locator(
                "button:has-text('Sign up with email'), "
                "button:has-text('Sign up with X'), "
                "input[name='email']"
            ).count()
            if has_signup > 0:
                log(f"[步骤3] ✓ 注册页面已加载 ({cf_wait}s)")
                break
            if cf_wait % 5 == 4:
                title = await page.title()
                log(f"[步骤3] 等待中... Title={title}")
            await asyncio.sleep(1)
        else:
            log("[步骤3] ⚠ 30s内未检测到注册页面元素")
            await page.screenshot(
                path=os.path.join(DEBUG_DIR, f"cf_T{thread_id}.png")
            )
            return False

        # 点击 Sign up with email
        try:
            btn = page.locator("button:has-text('Sign up with email')")
            if await btn.is_visible(timeout=3000):
                await btn.click()
                log("[步骤3] 点击 'Sign up with email'")
                await asyncio.sleep(1)
        except Exception:
            log("[步骤3] 'Sign up with email' 未找到，继续")

        # 填入邮箱
        check_timeout()
        log("[步骤3] 填入邮箱...")
        email_input = page.locator('input[name="email"]')
        await email_input.wait_for(timeout=5000)
        await email_input.fill(email_address)
        await asyncio.sleep(0.5)
        await page.keyboard.press("Enter")
        log("[步骤3] 邮箱已提交")
        await asyncio.sleep(2)

        # ── 步骤 4: 等待验证码 ────────────────────────────────
        check_timeout()
        log("[步骤4] 等待验证码...")

        code_filled = False
        for attempt in range(30):
            check_timeout()

            if await page.locator('input[name="password"]').count() > 0:
                log("[步骤4] ✓ 已到密码页面")
                break

            if not code_filled and await page.locator("input:visible").count() > 0:
                code = None
                for poll in range(15):
                    code = await asyncio.to_thread(
                        fetch_verification_code, email_token
                    )
                    if code:
                        break
                    if poll % 5 == 4:
                        log(f"[步骤4] 第{poll+1}次轮询...")
                    await asyncio.sleep(2)

                if code:
                    log(f"[步骤4] ✓ 验证码: {code}")
                    first_input = page.locator("input:visible").first
                    await first_input.click(timeout=2000)
                    await page.keyboard.type(str(code))
                    code_filled = True
                    await asyncio.sleep(2)
                else:
                    log("[步骤4] ❌ 未获取到验证码")
                    return False

            if code_filled:
                break
            await asyncio.sleep(1)

        # ── 步骤 5: 填写个人信息 ──────────────────────────────
        check_timeout()
        log("[步骤5] 填写个人信息...")

        try:
            await page.locator('input[name="password"]').wait_for(timeout=15000)
        except Exception:
            log("[步骤5] ❌ 密码页面未出现")
            await page.screenshot(
                path=os.path.join(DEBUG_DIR, f"no_pw_T{thread_id}.png")
            )
            return False

        # Chrome CDP: 直接 fill 即可, React 事件正常工作
        await page.fill('input[name="givenName"]', fname)
        await page.fill('input[name="familyName"]', lname)
        await page.fill('input[name="password"]', grok_password)
        log(f"[步骤5] ✓ {fname} {lname}, 密码长度={len(grok_password)}")

        # ── 步骤 6: Turnstile + 提交 ─────────────────────────
        check_timeout()
        log("[步骤6] 等待 Turnstile...")
        await asyncio.sleep(2)

        # Turnstile 检查
        async def check_turnstile():
            try:
                return await page.evaluate("""() => {
                    var inp = document.querySelector('input[name="cf-turnstile-response"]');
                    if (inp && inp.value && inp.value.length > 10) return true;
                    return false;
                }""")
            except Exception:
                return False

        # 先检查是否自动通过
        turnstile_ok = False
        for _ in range(3):
            if await check_turnstile():
                turnstile_ok = True
                log("[步骤6] ✓ Turnstile 已自动通过")
                break
            await asyncio.sleep(1)

        if not turnstile_ok:
            # 尝试点击 Turnstile
            click_count = 0
            for wait_sec in range(60):
                if sso_state["found"]:
                    break

                try:
                    ts = await page.evaluate("""() => {
                        var inp = document.querySelector('input[name="cf-turnstile-response"]');
                        if (!inp) return "no_input";
                        if (!inp.value) return "empty";
                        return "passed";
                    }""")
                except Exception as e:
                    if "TargetClosedError" in type(e).__name__ or "closed" in str(e).lower():
                        log("[步骤6] ⚠ 页面已关闭, 中断 Turnstile 等待")
                        break
                    ts = "empty"

                if ts == "passed":
                    log(f"[步骤6] ✓ Turnstile 已通过 ({wait_sec}s)")
                    turnstile_ok = True
                    break

                if ts == "no_input" and wait_sec >= 8:
                    log("[步骤6] 无 Turnstile 元素, 跳过")
                    turnstile_ok = True
                    break

                if wait_sec in (2, 5, 10, 16, 24, 35, 48):
                    try:
                        # 方法1: 直接定位 Turnstile iframe 中的 checkbox
                        cf_frame = None
                        for frame in page.frames:
                            if "turnstile" in (frame.url or "").lower() or "challenges.cloudflare" in (frame.url or ""):
                                cf_frame = frame
                                break

                        if cf_frame:
                            try:
                                checkbox = cf_frame.locator("input[type='checkbox'], .cb-i, #challenge-stage")
                                if await checkbox.count() > 0:
                                    click_count += 1
                                    log(f"[步骤6] 第{click_count}次点击 (iframe checkbox)")
                                    await checkbox.first.click(timeout=3000)
                                    await asyncio.sleep(2)
                                    if await check_turnstile():
                                        log("[步骤6] ✓ iframe 点击后 Turnstile 已通过!")
                                        turnstile_ok = True
                                        break
                                else:
                                    # iframe 内无 checkbox, 尝试点击 iframe 本身
                                    box = await cf_frame.locator("body").bounding_box()
                                    if box:
                                        click_count += 1
                                        cx = box["x"] + 30 + random.uniform(-3, 3)
                                        cy = box["y"] + box["height"] / 2 + random.uniform(-3, 3)
                                        log(f"[步骤6] 第{click_count}次点击 iframe body ({cx:.0f}, {cy:.0f})")
                                        await page.mouse.click(cx, cy)
                            except Exception:
                                pass

                        # 方法2: 通过 Turnstile widget 容器定位
                        if not turnstile_ok:
                            widget = page.locator("[class*='turnstile'], [id*='turnstile'], div:has(> iframe[src*='turnstile']), div:has(> iframe[src*='challenges.cloudflare'])")
                            wbox = await widget.first.bounding_box() if await widget.count() > 0 else None
                            if wbox:
                                click_count += 1
                                tx = wbox["x"] + 30 + random.uniform(-5, 5)
                                ty = wbox["y"] + wbox["height"] / 2 + random.uniform(-5, 5)
                                log(f"[步骤6] 第{click_count}次点击 widget ({tx:.0f}, {ty:.0f})")
                                await page.mouse.click(tx, ty)

                        # 方法3: 按钮坐标反推 (兜底)
                        if not turnstile_ok:
                            btn = page.locator("button:has-text('Complete sign up')")
                            box = await btn.bounding_box()
                            if box:
                                # 从截图分析: checkbox 在按钮正上方约 60px, 左侧约 x=70
                                tx = box["x"] + 30 + random.uniform(-5, 5)
                                ty = box["y"] - 60 + random.uniform(-5, 5)
                                if tx > 0 and ty > 0:
                                    click_count += 1
                                    log(f"[步骤6] 第{click_count}次点击 (坐标反推 {tx:.0f}, {ty:.0f})")
                                    await page.mouse.click(tx, ty)

                    except Exception as e:
                        if "TargetClosedError" in type(e).__name__ or "closed" in str(e).lower():
                            log("[步骤6] ⚠ 页面已关闭, 中断 Turnstile 等待")
                            break
                        log(f"[步骤6] 点击异常: {e}")

                    await asyncio.sleep(2)
                    try:
                        if await check_turnstile():
                            log("[步骤6] ✓ 点击后 Turnstile 已通过!")
                            turnstile_ok = True
                            break
                    except Exception:
                        pass
                    continue

                await asyncio.sleep(1)

        await page.screenshot(
            path=os.path.join(DEBUG_DIR, f"step6_T{thread_id}.png")
        )

        # 提交
        if not sso_state["found"]:
            log("[步骤6] 点击 'Complete sign up'...")
            try:
                submit = page.locator("button:has-text('Complete sign up')")
                if await submit.is_visible(timeout=2000):
                    await submit.click(timeout=3000)
                    log("[步骤6] ✓ 提交按钮已点击")
            except Exception as e:
                log(f"[步骤6] 按钮点击异常: {e}")
                await page.evaluate("""() => {
                    var btns = document.querySelectorAll("button");
                    var btn = Array.from(btns).find(
                        b => b.textContent.includes("Complete") || b.type === "submit"
                    );
                    if (btn) btn.click();
                }""")

        # ── 步骤 7: 等待注册结果 ──────────────────────────────
        log("[步骤7] 等待注册结果...")
        await asyncio.sleep(3)

        for i in range(15):
            # response header 监听
            if sso_state["found"]:
                log("[步骤7] ✓ 通过 response 监听捕获 SSO!")
                break

            # cookie 轮询
            try:
                cookies = await context.cookies()
                cdict = {c["name"]: c["value"] for c in cookies}
                if "sso" in cdict and not sso_state["found"]:
                    sso_state["sso"] = cdict["sso"]
                    sso_state["sso_rw"] = cdict.get("sso-rw", "")
                    sso_state["found"] = True
                    log("[步骤7] ✓ 通过 cookie 轮询捕获 SSO!")
                    break
            except Exception:
                pass

            if i % 5 == 4:
                log(f"[步骤7] {i+1}s URL: {page.url}")
            await asyncio.sleep(1)

        # 清理监听
        try:
            page.remove_listener("response", on_response_sso)
        except Exception:
            pass

        if not sso_state["found"]:
            log("[步骤7] ❌ 未获取 SSO, 收集诊断...")
            await page.screenshot(
                path=os.path.join(DEBUG_DIR, f"fail_T{thread_id}.png")
            )
            title = await page.title()
            log(f"[诊断] Title={title}")
            log(f"[诊断] URL={page.url}")
            try:
                body = await page.evaluate(
                    'document.body '
                    '? document.body.innerText.substring(0, 500) '
                    ': "NO_BODY"'
                )
                log(f"[诊断] 页面: {body[:300]}")
            except Exception:
                pass
            cookies = await context.cookies()
            log(f"[诊断] cookies: {[c['name'] for c in cookies]}")
            return False

        sso_val = sso_state["sso"]
        sso_rw_val = sso_state["sso_rw"]
        log(f"[步骤7] 🎉 注册成功! SSO={sso_val[:30]}...")

        # ── 步骤 8: 注册后处理 ────────────────────────────────
        log("[步骤8] 执行注册后处理...")

        # 提取 x-userid
        from post_register import extract_user_id, accept_tos
        x_userid = extract_user_id(sso_val)
        if x_userid:
            log(f"[步骤8] x-userid: {x_userid[:20]}...")
        else:
            log("[步骤8] ⚠ x-userid 提取失败")

        # TOS (accounts.x.ai 不受 Cloudflare 拦截)
        tos_result = await asyncio.to_thread(accept_tos, sso_val, sso_rw_val)
        if tos_result["ok"]:
            log("[步骤8] ✓ TOS 已同意")
        else:
            log(f"[步骤8] ⚠ TOS: {tos_result['error']}")

        cf_clearance_val = ""

        # 在浏览器中执行 NSFW 启用 (绕过 Cloudflare)
        try:
            # 先导航到 grok.com（浏览器已有 sso cookie）
            await page.goto("https://grok.com/", timeout=15000)
            await asyncio.sleep(2)

            cf_clearance_val = await wait_for_cookie_value(context, "cf_clearance", timeout_sec=8)
            if not cf_clearance_val and not headless:
                try:
                    title = await page.title()
                except Exception:
                    title = ""
                if "cloudflare" in title.lower() or "attention required" in title.lower():
                    log("[步骤8] ⚠ grok.com 仍在 Cloudflare 验证页，请手动完成后等待...")
                    cf_clearance_val = await wait_for_cookie_value(context, "cf_clearance", timeout_sec=60)

            if cf_clearance_val:
                log(f"[步骤8] ✓ grok.com cf_clearance 已获取: {cf_clearance_val[:20]}...")
            else:
                log("[步骤8] ⚠ grok.com 未获取到 cf_clearance")

            # 在浏览器中执行 fetch 设置生日
            birth_ok = await page.evaluate("""async () => {
                try {
                    const r = await fetch('/rest/auth/set-birth-date', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({birthDate: '2000-01-01T00:00:00.000Z'})
                    });
                    return r.ok;
                } catch(e) { return false; }
            }""")
            if birth_ok:
                log("[步骤8] ✓ 生日已设置")

            # 在浏览器中执行 gRPC 启用 NSFW
            nsfw_ok = await page.evaluate("""async () => {
                try {
                    // 构造 gRPC payload
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
                    return r.ok;
                } catch(e) { return false; }
            }""")
            if nsfw_ok:
                log("[步骤8] ✓ NSFW 已开启")
            else:
                log("[步骤8] ⚠ NSFW 开启失败")
        except Exception as e:
            log(f"[步骤8] ⚠ 浏览器 NSFW 异常: {e}")

        if not cf_clearance_val:
            try:
                cf_clearance_val = await wait_for_cookie_value(context, "cf_clearance", timeout_sec=3)
            except Exception as e:
                log(f"[步骤8] ⚠ 读取 cf_clearance 异常: {e}")

        account = {
            "email": email_address,
            "password": grok_password,
            "sso": sso_val,
            "sso_rw": sso_rw_val or "",
            "cf_clearance": cf_clearance_val,
            "name": email_address,
            "x-userid": x_userid,
        }
        account_file = save_account_result(account)
        log(f"[步骤9] ✓ 结果已保存: {os.path.basename(account_file)}")

        return account

    except TimeoutError:
        log(f"TIMEOUT ({time.time() - job_start:.1f}s)")
        if page:
            try:
                await page.screenshot(
                    path=os.path.join(DEBUG_DIR, f"timeout_T{thread_id}.png")
                )
            except Exception:
                pass
        return False
    except Exception as e:
        log(f"异常: {type(e).__name__}: {e}")
        traceback.print_exc()
        if page:
            try:
                await page.screenshot(
                    path=os.path.join(DEBUG_DIR, f"error_T{thread_id}.png")
                )
            except Exception:
                pass
        return False
    finally:
        try:
            if browser:
                await browser.close()
        except Exception:
            pass
        try:
            if pw:
                await pw.stop()
        except Exception:
            pass
        try:
            if chrome_proc:
                chrome_proc.terminate()
                try:
                    chrome_proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    chrome_proc.kill()
                    chrome_proc.wait(timeout=3)
        except Exception:
            pass
        _kill_port(port)
        try:
            if os.path.exists(user_data_dir):
                shutil.rmtree(user_data_dir, ignore_errors=True)
        except Exception:
            pass
        gc.collect()


# ══════════════════════════════════════════════════════════════
#  线程 Worker
# ══════════════════════════════════════════════════════════════

def run_job(thread_id: int, task_id: int, timeout_sec: int = 180) -> dict | bool:
    """在新的事件循环中运行单次注册任务"""
    return asyncio.run(async_run_job(thread_id, task_id, timeout_sec))


def worker(thread_id: int, count: int):
    prefix = f"[Thread-{thread_id}]"
    print(f"{prefix} 启动，目标: {count} 个账号")

    success_count = 0
    fail_streak = 0
    while success_count < count:
        current_task = success_count + 1
        success = run_job(thread_id, current_task, timeout_sec=180)
        if success:
            print(
                f"{prefix} 任务 {current_task} 完成! "
                f"(成功 {success_count + 1}/{count})"
            )
            success_count += 1
            fail_streak = 0
            time.sleep(3)
        else:
            fail_streak += 1
            print(
                f"{prefix} 任务 {current_task} 失败 "
                f"(连续失败 {fail_streak} 次)"
            )
            if fail_streak >= 5:
                print(f"{prefix} 连续失败 {fail_streak} 次，等待 10s")
                time.sleep(10)
                fail_streak = 0
            else:
                time.sleep(2)

    print(f"{prefix} 全部完成!")


# ══════════════════════════════════════════════════════════════
#  主入口
# ══════════════════════════════════════════════════════════════

def main():
    signal.signal(
        signal.SIGINT,
        lambda s, f: (print("\n\n⏹ 用户中断"), os._exit(0)),
    )

    print("=" * 60)
    print("     Grok 注册助手 [v13.0-mac - Chrome CDP]")
    print("=" * 60)
    chrome = _find_chrome()
    print(f"  Chrome: {chrome or '未找到!'}")
    print(f"  调试目录: {DEBUG_DIR}")
    print(f"  结果目录: {GROK_DIR}")

    try:
        total_count = int(input("\n每个线程注册次数: "))
        thread_count = int(input("线程数 (推荐 1-3): "))
    except (ValueError, EOFError, KeyboardInterrupt):
        total_count = 1
        thread_count = 1
        print("输入无效，默认 1 线程 x 1 次")

    print(f"\n{thread_count} 线程，每线程 {total_count} 次")
    print(f"输出: {GROK_DIR}/<邮箱>.json")
    print("=" * 60)

    with ThreadPoolExecutor(max_workers=thread_count) as executor:
        futures = []
        for i in range(thread_count):
            futures.append(executor.submit(worker, i, total_count))
            time.sleep(2)
        for f in futures:
            f.result()

    print("=" * 60)
    print("所有任务结束!")
    print(f"结果: {GROK_DIR}/<邮箱>.json")
    print("=" * 60)


if __name__ == "__main__":
    main()
