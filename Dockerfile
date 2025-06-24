# Dockerfile (Phiên bản "High-Performance")

# --- GIAI ĐOẠN 1: BUILDER ---
FROM --platform=$BUILDPLATFORM node:20-bookworm-slim AS builder
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --production --omit=dev


# --- GIAI ĐOẠN 2: PRODUCTION ---
FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium \
    # ... (giữ nguyên danh sách thư viện hệ thống như cũ)
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 \
    libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
    libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 \
    libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 \
    libxrender1 libxss1 libxtst6 lsb-release wget xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# --- THAY ĐỔI Ở ĐÂY ---
# Tạo một người dùng không phải root tên là 'pptruser' để chạy trình duyệt
# Đây là một biện pháp bảo mật tốt.
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && mkdir -p /home/pptruser/Downloads \
    && chown -R pptruser:pptruser /home/pptruser

# Tạo thư mục cho ứng dụng
WORKDIR /usr/src/app

# Tạo thư mục cache và gán quyền cho người dùng pptruser
RUN mkdir -p .browser-cache && chown -R pptruser:pptruser .browser-cache

# Sao chép các file cần thiết
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY . .

# Chuyển sang người dùng không phải root
USER pptruser

# Mở cổng 3000
EXPOSE 3000

# Lệnh để khởi động ứng dụng
CMD [ "node", "server.js" ]
