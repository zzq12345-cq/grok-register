#!/bin/bash
# ============================================================
#  Grok Art Proxy - VPS 一键部署脚本
#  用法: 在服务器上运行 bash deploy_vps.sh
# ============================================================

set -e

APP_DIR="/opt/grok-art-proxy"
PORT=8787

echo "================================================"
echo "  Grok Art Proxy - VPS 部署"
echo "================================================"

# 1. 安装 Node.js (如果没有)
if ! command -v node &> /dev/null; then
    echo "[1/5] 安装 Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
else
    echo "[1/5] Node.js 已安装: $(node -v)"
fi

# 2. 安装 PM2 (进程管理)
if ! command -v pm2 &> /dev/null; then
    echo "[2/5] 安装 PM2..."
    npm install -g pm2
else
    echo "[2/5] PM2 已安装"
fi

# 3. 创建应用目录
echo "[3/5] 部署应用到 ${APP_DIR}..."
mkdir -p ${APP_DIR}

# 如果目录已有内容，备份
if [ -f "${APP_DIR}/package.json" ]; then
    echo "  检测到已有部署，更新中..."
fi

# 复制文件 (脚本应该在项目根目录执行)
cp -r . ${APP_DIR}/
cd ${APP_DIR}

# 4. 安装依赖
echo "[4/5] 安装依赖..."
npm install

# 5. 创建 .dev.vars 配置文件
if [ ! -f "${APP_DIR}/.dev.vars" ]; then
    echo "[5/5] 创建配置文件..."
    cat > ${APP_DIR}/.dev.vars << 'EOF'
AUTH_USERNAME=zzqq
AUTH_PASSWORD=Zh2005627
EOF
    echo "  配置文件已创建: ${APP_DIR}/.dev.vars"
    echo "  ⚠ 请修改 .dev.vars 中的用户名密码!"
else
    echo "[5/5] 配置文件已存在，跳过"
fi

# 启动/重启服务
echo ""
echo "================================================"
echo "  启动服务..."
echo "================================================"

# 停止旧实例
pm2 delete grok-art-proxy 2>/dev/null || true

# 使用 PM2 + wrangler dev 启动
pm2 start "npx wrangler dev --port ${PORT} --ip 0.0.0.0" \
    --name grok-art-proxy \
    --cwd ${APP_DIR} \
    --max-memory-restart 512M

# 设置开机自启
pm2 save
pm2 startup 2>/dev/null || true

echo ""
echo "================================================"
echo "  ✅ 部署成功!"
echo "================================================"
echo ""
echo "  访问地址: http://$(hostname -I | awk '{print $1}'):${PORT}"
echo "  管理命令:"
echo "    pm2 logs grok-art-proxy   # 查看日志"
echo "    pm2 restart grok-art-proxy # 重启"
echo "    pm2 stop grok-art-proxy   # 停止"
echo ""
echo "  配置文件: ${APP_DIR}/.dev.vars"
echo "  修改后重启: pm2 restart grok-art-proxy"
echo "================================================"
