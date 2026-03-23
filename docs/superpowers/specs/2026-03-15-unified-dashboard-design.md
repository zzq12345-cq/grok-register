# Grok 注册机 + AI 代理统一面板设计文档

## 概述

将 Grok 注册系统（8080端口）和 AI 代理管理界面（8787端口）整合为单一应用，统一白色仙侠风 UI，通过 Tab 切换各功能模块。

## 目标

- 单端口访问所有功能
- 统一白色仙侠风视觉风格
- 前端合并，后端保留 Cloudflare Workers
- 零学习成本的平滑迁移

## 技术方案

### 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Flask 统一面板 (8080)                      │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                    前端页面 (HTML/CSS/JS)                 │ │
│  │  ┌─────┬─────┬─────┬─────┬─────┐                        │ │
│  │  │注册 │灵牌 │符钥 │图灵 │影像 │  ← Tab 切换             │ │
│  │  │造册 │管理 │管理 │造像 │合成 │                        │ │
│  │  └─────┴─────┴─────┴─────┴─────┘                        │ │
│  └─────────────────────────────────────────────────────────┘ │
│                           │                                  │
│  ┌────────────────────────┼────────────────────────┐        │
│  │                        ▼                         │        │
│  │    注册 API (本地 Flask)    代理 API 调用        │        │
│  │    /api/start              → Workers URL        │        │
│  │    /api/stop               → /api/tokens        │        │
│  │    /api/status             → /v1/images         │        │
│  │    /api/stream             → /v1/videos         │        │
│  └─────────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────┐
              │   Cloudflare Workers      │
              │   (原有后端保持不变)        │
              │   Token / API Key 管理     │
              │   图片/视频生成 API        │
              └───────────────────────────┘
```

### 配置管理

Workers URL 通过环境变量配置，Flask 渲染时注入到前端：

```env
# .env
WORKERS_URL=https://grok-art-proxy.xxx.workers.dev
```

```python
# server.py
WORKERS_URL = os.environ.get('WORKERS_URL', 'http://localhost:8787')
```

```html
<!-- 渲染到页面 -->
<script>
window.WORKERS_URL = "{{ workers_url }}";
</script>
```

## 功能模块

### Tab 1: 注册造册

原 8080 端口的注册功能，保持不变：
- 线程数/任务数设置
- 有头/无头模式切换
- 实时 SSE 进度推送
- 注册结果列表

### Tab 2: 灵牌管理

原 8787 的 Token 管理功能：
- 批量导入 Token
- Token 列表分页展示
- 批量启用 NSFW
- 导出 Token

### Tab 3: 符钥管理

原 8787 的 API Key 管理功能：
- 创建 API Key
- 启用/禁用 Key
- API 使用说明

### Tab 4: 图灵造像

原 8787 的图片生成功能：
- 提示词输入
- 尺寸/数量选择
- NSFW 开关
- 图片网格展示

### Tab 5: 影像合成

原 8787 的视频生成功能：
- 从图片选择
- 动作提示词
- 时长/分辨率选择

## 视觉设计

### 色彩系统（白色仙侠风）

```css
:root {
  /* 主色调 - 白色系 */
  --bg-primary: #FAFAFA;
  --bg-secondary: #F5F5F5;
  --bg-card: #FFFFFF;

  /* 点缀色 - 仙侠金 */
  --gold-primary: #C5A55A;
  --gold-light: #D4B96B;
  --gold-deep: #8B7332;

  /* 强调色 - 仙气蓝 */
  --accent-primary: #6B8DD6;
  --accent-light: #8BA8E8;

  /* 文字 */
  --text-primary: #2C2C2C;
  --text-secondary: #666666;
  --text-muted: #999999;

  /* 状态色 */
  --success: #5CB85C;
  --warning: #F0AD4E;
  --error: #D9534F;
}
```

### 字体

```css
/* 标题用仙侠风字体 */
font-family: 'Ma Shan Zheng', 'ZCOOL XiaoWei', serif;

/* 正文用清晰字体 */
font-family: 'Noto Serif SC', serif;
```

### 组件风格

- **卡片**: 白色背景 + 金色细边 + 淡淡阴影
- **按钮**: 白底金字边框，hover 时金光流转
- **Tab**: 简洁下划线式，激活时金色高亮
- **输入框**: 白底金边，聚焦时金光外溢

## 文件结构

```
grok注册机/
├── server.py              # Flask 主入口（修改）
├── .env                   # 环境变量配置（新增）
├── templates/
│   └── index.html         # 统一页面（重写）
├── static/
│   ├── css/
│   │   └── style.css      # 白色仙侠风样式（重写）
│   └── js/
│       ├── app.js         # 主入口（重写）
│       ├── utils.js       # 工具函数（复用）
│       └── modules/
│           ├── register.js    # 注册模块（改造）
│           ├── tokens.js      # Token 管理（改造）
│           ├── apikeys.js     # API Key 管理（改造）
│           ├── imageGen.js    # 图片生成（改造）
│           └── videoGen.js    # 视频生成（改造）
└── grok-art-proxy/        # Workers 项目（保持不变）
```

## API 调用改造

### 原 8787 的 API 调用

```javascript
// 原来：相对路径
await fetch('/api/tokens')
```

### 改造后

```javascript
// 现在：使用 Workers URL
await fetch(`${window.WORKERS_URL}/api/tokens`, {
  credentials: 'include'  // 携带 cookie
})
```

## 实施步骤

1. **创建统一页面模板**
   - 新 HTML 结构
   - Tab 导航组件
   - 各模块容器

2. **重构 CSS**
   - 白色仙侠风色彩系统
   - 组件样式
   - 动画效果

3. **重构 JS 模块**
   - 改造注册模块
   - 改造 Token/API Key/图片/视频模块
   - API 调用改为使用 WORKERS_URL

4. **修改 Flask 后端**
   - 添加 .env 支持
   - 渲染 WORKERS_URL 到页面

5. **测试验证**
   - 注册功能正常
   - Workers API 调用正常
   - 跨域问题处理

## 注意事项

1. **跨域问题**: Workers 需要配置 CORS 允许 8080 域名访问
2. **Cookie/认证**: 如果 Workers 有登录认证，需要处理跨域 cookie
3. **错误处理**: Workers 不可用时的友好提示

## 成功标准

- [ ] 单一端口 8080 访问所有功能
- [ ] 5 个 Tab 功能完整可用
- [ ] 白色仙侠风 UI 统一美观
- [ ] 注册功能与原版一致
- [ ] Workers API 调用正常
- [ ] 无跨域错误
