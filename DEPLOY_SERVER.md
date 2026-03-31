# 服务器发布指南（Ubuntu + PM2 + Nginx）

本文目标：让用户可通过 `域名` 或 `服务器IP` 直接访问项目。

## 1. 服务器准备

以 Ubuntu 22.04/24.04 为例：

```bash
sudo apt update
sudo apt install -y nginx git curl build-essential python3 make g++
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm i -g pm2
```

检查版本：

```bash
node -v
npm -v
pm2 -v
```

## 2. 上传并安装项目

```bash
sudo mkdir -p /opt/afk
sudo chown -R $USER:$USER /opt/afk
cd /opt/afk
git clone <你的仓库地址> .
npm ci
npm run build
```

## 3. 配置环境变量（必须）

本项目必须设置 `JWT_SECRET`，否则服务不会启动。

```bash
cat > /opt/afk/.env <<'EOF'
NODE_ENV=production
PORT=3001
JWT_SECRET=请替换为高强度随机密钥
GEMINI_API_KEY=可选_如需AI功能请填写
APP_URL=http://你的域名或IP
EOF
```

建议生成随机密钥：

```bash
openssl rand -base64 48
```

## 4. 用 PM2 启动后端

项目里已提供 PM2 配置：`deploy/ecosystem.config.cjs`。

```bash
cd /opt/afk
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup
```

查看状态和日志：

```bash
pm2 status
pm2 logs afk-app --lines 200
```

## 5. 配置 Nginx（域名/IP 统一入口）

```bash
sudo cp /opt/afk/deploy/nginx.afk.conf /etc/nginx/sites-available/afk
sudo ln -sf /etc/nginx/sites-available/afk /etc/nginx/sites-enabled/afk
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

如果你用域名，请把 `deploy/nginx.afk.conf` 里的 `server_name _;` 改成你的域名后再重启 Nginx。

## 6. 开放防火墙

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
sudo ufw status
```

## 7. HTTPS（可选但强烈建议）

域名已解析到服务器后执行：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 你的域名
```

## 8. 验证发布

```bash
curl -I http://127.0.0.1:3001
curl -I http://你的服务器IP
curl -I http://你的域名
```

浏览器访问：

- `http://你的服务器IP`
- `http://你的域名`（或 `https://你的域名`）

## 9. 更新发布（以后每次发版）

```bash
cd /opt/afk
git pull
npm ci
npm run build
pm2 restart afk-app --update-env
```

