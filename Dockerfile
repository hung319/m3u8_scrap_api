# Dockerfile (Phiên bản Tối ưu - "Optimized")

# --- GIAI ĐOẠN 1: BUILDER ---
# Giai đoạn này chỉ dùng để cài đặt node_modules một cách an toàn và hiệu quả
# Sử dụng --platform=$BUILDPLATFORM để đảm bảo npm install luôn chạy native trên máy build
FROM --platform=$BUILDPLATFORM node:20-bookworm-slim AS builder

LABEL author="hung319"

WORKDIR /usr/src/app

# Chỉ copy package.json để tận dụng cache. Lớp này chỉ build lại khi package.json thay đổi.
COPY package*.json ./

# Chạy npm install. --omit=dev để bỏ qua các gói dev, giúp node_modules nhẹ hơn
RUN npm install --production --omit=dev


# --- GIAI ĐOẠN 2: PRODUCTION ---
# Bắt đầu từ một image Node.js sạch, đảm bảo không có file rác từ môi trường build
FROM node:20-bookworm-slim

# Cài đặt các thư viện hệ thống cần thiết và trình duyệt Chromium
# Gộp tất cả vào một lệnh RUN duy nhất để tạo một layer duy nhất, giảm kích thước image
# --no-install-recommends: không cài các gói được gợi ý nhưng không bắt buộc
# ampersand (&&) để nối các lệnh
# rm -rf /var/lib/apt/lists/*: Xóa cache của apt ngay sau khi cài xong
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 \
    libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
    libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 \
    libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 \
    libxrender1 libxss1 libxtst6 lsb-release wget xdg-utils chromium \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Thiết lập các biến môi trường cho Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Tạo người dùng không phải root để chạy ứng dụng (bảo mật hơn)
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && mkdir -p /home/pptruser/Downloads \
    && chown -R pptruser:pptruser /home/pptruser

# Tạo thư mục ứng dụng và thư mục cache
WORKDIR /usr/src/app
RUN mkdir -p .browser-cache && chown -R pptruser:pptruser .browser-cache

# Sao chép các thư viện đã được cài đặt ở giai đoạn 'builder'
COPY --from=builder /usr/src/app/node_modules ./node_modules

# Sao chép mã nguồn ứng dụng
COPY . .

# Chuyển sang người dùng không phải root
USER pptruser

# Mở cổng 3000
EXPOSE 3000

# Lệnh để khởi động ứng dụng
CMD [ "node", "server.js" ]
