# Grok Art Proxy

基于 Cloudflare Workers 的 Grok AI 代理服务，提供 Web 管理界面和 OpenAI 兼容 API，支持文本对话、图片生成和视频生成。

## 功能特性

### Web 管理界面
- **图片生成** - 可视化界面，支持多种宽高比、批量生成、NSFW 模式
- **视频生成** - 从图片一键生成视频，支持时长和分辨率选择
- **Token 管理** - 批量导入/导出 Grok Token，状态监控
- **API Key 管理** - 创建多个 API Key，设置速率限制

### OpenAI 兼容 API
- **标准接口** - 支持 `/v1/chat/completions`、`/v1/images/generations`、`/v1/models`
- **多模型支持** - Grok 3/4/4.1 系列文本模型
- **图片/视频生成** - 通过 Chat API 生成图片和视频
- **Token 自动轮换** - 遇到速率限制自动切换账号重试

### 其他特性
- **视频海报预览** - 视频返回可点击的海报预览图
- **认证保护** - 后台管理需用户名密码登录
- **一键部署** - Fork 后通过 GitHub Actions 自动部署

## 支持的模型

### 文本模型

| 模型 ID | 说明 |
|---------|------|
| `grok-3` | Grok 3 标准模式 |
| `grok-3-fast` | Grok 3 快速模式 |
| `grok-4` | Grok 4 标准模式 |
| `grok-4-mini` | Grok 4 Mini (思维链) |
| `grok-4-fast` | Grok 4 快速模式 |
| `grok-4-heavy` | Grok 4 深度模式 |
| `grok-4.1` | Grok 4.1 标准模式 |
| `grok-4.1-fast` | Grok 4.1 快速模式 |
| `grok-4.1-expert` | Grok 4.1 专家模式 |
| `grok-4.1-thinking` | Grok 4.1 思维链模式 |

### 图片模型

| 模型 ID | 宽高比 |
|---------|--------|
| `grok-image` | 1:1 (默认) |
| `grok-image-1_1` | 1:1 |
| `grok-image-2_3` | 2:3 (竖向) |
| `grok-image-3_2` | 3:2 (横向) |
| `grok-image-16_9` | 16:9 (宽屏) |
| `grok-image-9_16` | 9:16 (竖屏) |

### 视频模型

| 模型 ID | 宽高比 |
|---------|--------|
| `grok-video` | 16:9 (默认) |
| `grok-video-1_1` | 1:1 |
| `grok-video-2_3` | 2:3 |
| `grok-video-3_2` | 3:2 |
| `grok-video-16_9` | 16:9 |
| `grok-video-9_16` | 9:16 |

## 一键部署

### 前置要求

1. [Cloudflare 账号](https://dash.cloudflare.com/sign-up)
2. GitHub 账号

### 步骤 1: Fork 项目

点击右上角 **Fork** 按钮，将项目 Fork 到你的 GitHub 账号。

### 步骤 2: 获取 Cloudflare 凭证

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 获取 **Account ID** (在 Workers 页面右侧可见)
3. 创建 **API Token**:
   - 进入 [API Tokens](https://dash.cloudflare.com/profile/api-tokens)
   - 点击 **Create Token**
   - 选择 **Edit Cloudflare Workers** 模板
   - 确保包含权限: Workers Scripts Edit, Workers KV Edit, D1 Edit

### 步骤 3: 配置 GitHub Secrets

进入 Fork 的仓库 → **Settings** → **Secrets and variables** → **Actions**

| Secret 名称 | 说明 | 必填 |
|-------------|------|------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token | ✅ |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID | ✅ |
| `AUTH_USERNAME` | 后台登录用户名 | ✅ |
| `AUTH_PASSWORD` | 后台登录密码 | ✅ |

### 步骤 4: 部署

1. 进入 **Actions** 标签页
2. 点击 **Deploy to Cloudflare Workers**
3. 点击 **Run workflow**
4. 等待部署完成

### 步骤 5: 开始使用

部署完成后访问 `https://grok-art-proxy.<your-subdomain>.workers.dev`

## Web 端使用

### 登录

访问部署地址，使用配置的用户名密码登录。

### 导入 Token

1. 进入 **令牌管理** 页面
2. 在文本框中粘贴 Token，支持多种格式：
   - 纯 SSO Token（每行一个）
   - JSON 数组格式
   - CSV 格式: `sso,sso_rw,name`
3. 点击 **导入数据**

### 生成图片

1. 进入 **图片生成** 页面
2. 输入提示词
3. 选择数量、宽高比
4. 可选开启 NSFW 模式
5. 点击 **开始生成**

### 生成视频

1. 先生成图片
2. 点击图片下方的 **生成视频** 按钮
3. 输入动作描述（可选）
4. 选择时长和分辨率
5. 点击 **生成视频**

### 创建 API Key

1. 进入 **API Key 管理** 页面
2. 点击 **创建 API Key**
3. 设置名称和速率限制（0 表示无限制）
4. 复制生成的 API Key

## API 使用

### 对话补全

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### 图片生成

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-image-16_9",
    "messages": [{"role": "user", "content": "一只可爱的猫咪"}],
    "stream": true
  }'
```

### 视频生成

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-video",
    "messages": [{"role": "user", "content": "一只猫咪在草地上奔跑"}],
    "stream": true
  }'
```

### 获取模型列表

```bash
curl https://your-worker.workers.dev/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `AUTH_USERNAME` | 后台登录用户名 | - |
| `AUTH_PASSWORD` | 后台登录密码 | - |
| `VIDEO_POSTER_PREVIEW` | 视频返回海报预览模式 | `true` |

## 更新部署

如果你之前已经部署过，更新到最新版本：

1. 在 GitHub 上点击 **Sync fork** 同步最新代码
2. 进入 **Actions** → **Deploy to Cloudflare Workers** → **Run workflow**
3. 等待部署完成

数据库迁移会自动执行，原有数据不会丢失。

## 本地开发

```bash
# 安装依赖
npm install

# 创建 .dev.vars 文件
echo "AUTH_USERNAME=admin" > .dev.vars
echo "AUTH_PASSWORD=password" >> .dev.vars

# 创建本地数据库
npx wrangler d1 create grok-imagine --local
npx wrangler d1 migrations apply DB --local

# 启动开发服务器
npm run dev
```

## 技术栈

- **Runtime**: Cloudflare Workers
- **Framework**: Hono
- **Database**: Cloudflare D1 (SQLite)
- **Cache**: Cloudflare KV
- **Frontend**: Vanilla JS

## License

MIT
