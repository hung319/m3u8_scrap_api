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
# Danh sách này được lấy từ tài liệu chính thức của Puppeteer.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libgconf-2-4 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    # Và quan trọng nhất, cài đặt trình duyệt Chromium
    chromium \
    # Dọn dẹp cache để giữ image nhỏ gọn
    && rm -rf /var/lib/apt/lists/*

# Khai báo các biến môi trường cho Puppeteer
# 1. Bỏ qua việc tải Chromium khi npm install, vì chúng ta đã tự cài ở trên
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
# 2. Chỉ cho Puppeteer biết đường dẫn đến file thực thi của Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /usr/src/app

# Sao chép các thư viện đã được cài đặt ở giai đoạn 'builder'
COPY --from=builder /usr/src/app/node_modules ./node_modules

# Sao chép toàn bộ mã nguồn ứng dụng
COPY . .

# Mở cổng 3000
EXPOSE 3000

# Lệnh để khởi động ứng dụng
CMD [ "node", "server.js" ]
