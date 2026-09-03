#!/bin/bash
# Setup script for interactive browser login via noVNC
# Run once on the server: bash setup-vnc.sh

set -e

echo "📦 Installing Xvfb (virtual display) and x11vnc (VNC server)..."
apt-get update
apt-get install -y xvfb x11vnc

echo "📦 Installing noVNC (web-based VNC client)..."
if [ ! -d "/opt/noVNC" ]; then
  git clone --depth 1 https://github.com/novnc/noVNC.git /opt/noVNC
fi
if [ ! -d "/opt/noVNC/utils/websockify" ]; then
  git clone --depth 1 https://github.com/novnc/websockify.git /opt/noVNC/utils/websockify
fi

echo "📄 Creating virtual display service..."
cat > /etc/systemd/system/xvfb.service << 'XVFB'
[Unit]
Description=Xvfb Virtual Display
After=network.target

[Service]
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x800x24 -ac
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
XVFB

echo "📄 Creating VNC server service..."
cat > /etc/systemd/system/x11vnc.service << 'VNC'
[Unit]
Description=x11vnc VNC Server
After=xvfb.service
Requires=xvfb.service

[Service]
Environment=DISPLAY=:99
ExecStart=/usr/bin/x11vnc -display :99 -forever -shared -rfbport 5900 -nopw -noxdamage
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
VNC

echo "📄 Creating noVNC web service..."
cat > /etc/systemd/system/novnc.service << 'NOVNC'
[Unit]
Description=noVNC Web Client
After=x11vnc.service
Requires=x11vnc.service

[Service]
ExecStart=/opt/noVNC/utils/novnc_proxy --vnc localhost:5900 --listen 6080
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
NOVNC

echo "🚀 Starting services..."
systemctl daemon-reload
systemctl enable xvfb x11vnc novnc
systemctl start xvfb x11vnc novnc

# Set DISPLAY for the scraper
echo "export DISPLAY=:99" >> /etc/environment

# Open firewall for noVNC
ufw allow 6080 2>/dev/null || iptables -I INPUT -p tcp --dport 6080 -j ACCEPT

echo ""
echo "✅ Done! noVNC is running on port 6080"
echo "   Open http://YOUR_SERVER_IP:6080/vnc.html to see the virtual display"
echo ""
echo "⚠️  Restart the scraper so it picks up DISPLAY=:99:"
echo "   export DISPLAY=:99"
echo "   pm2 restart salesnav-scraper"
echo ""
