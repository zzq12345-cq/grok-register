---
description: 同步本地代码到服务器并重启
---

// turbo-all

1. 上传核心文件到服务器

```bash
sshpass -p 'Zh2005627' scp -P 17997 -o StrictHostKeyChecking=no \
  /Users/zhouzhiqi/Documents/grok注册机/server.py \
  /Users/zhouzhiqi/Documents/grok注册机/grok_register_mac.py \
  /Users/zhouzhiqi/Documents/grok注册机/email_utils.py \
  /Users/zhouzhiqi/Documents/grok注册机/post_register.py \
  root@70.39.195.121:/opt/grok-panel/
```

2. 上传静态资源和模板

```bash
sshpass -p 'Zh2005627' scp -P 17997 -r -o StrictHostKeyChecking=no \
  /Users/zhouzhiqi/Documents/grok注册机/static \
  /Users/zhouzhiqi/Documents/grok注册机/templates \
  root@70.39.195.121:/opt/grok-panel/
```

3. 重启服务

```bash
sshpass -p 'Zh2005627' ssh -p 17997 -o StrictHostKeyChecking=no root@70.39.195.121 "pm2 restart grok-panel && sleep 2 && curl -s -o /dev/null -w 'HTTP %{http_code}' http://127.0.0.1:8086/v1/models && echo ' ✅'"
```
