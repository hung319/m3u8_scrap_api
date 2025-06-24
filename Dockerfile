# Dockerfile (Phiên bản "From-Scratch", đáng tin cậy nhất cho Multi-Arch)

# --- GIAI ĐOẠN 1: BUILDER ---
# Giai đoạn này chỉ dùng để cài đặt node_modules một cách an toàn
FROM --platform=$BUILDPLATFORM node:20-bookworm-slim AS builder
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --production --omit=dev


# --- GIAI ĐOẠN 2: PRODUCTION ---
# Bắt đầu từ một image Node.js sạch, cùng phiên bản Debian (bookworm)
FROM node:20-bookworm-slim

# Cài đặt các thư viện hệ thống cần thiết cho Chromium một cách thủ công.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 \
    libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
    libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 \
    libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 \
    libxrender1 libxss1 libxtst6 lsb-release wget xdg-utils chromium \
    && rm -rf /var/lib/apt/lists/*

# Khai báo biến môi trường cho Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /usr/src/app

# Sao chép các thư viện đã được cài đặt ở giai đoạn 'builder'
COPY --from=builder /usr/src/app/node_modules ./node_modules

# Sao chép toàn bộ mã nguồn ứng dụng
COPY . .

# Mở cổng 3000
EXPOSE 3000

# Lệnh để khởi động ứng dụng
CMD [ "node", "server.js" ]
