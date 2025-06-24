# Dockerfile (Phiên bản "Resilient Multi-Arch")

# --- GIAI ĐOẠN 1: BUILDER ---
# Sử dụng image Node.js chính thức, cùng phiên bản Debian (bookworm) với image puppeteer.
# --platform=$BUILDPLATFORM đảm bảo giai đoạn này luôn chạy native, không qua giả lập.
FROM --platform=$BUILDPLATFORM node:20-bookworm-slim AS builder

# Tên tác giả (tùy chọn)
LABEL author="Your Name"

# Đặt môi trường làm việc
WORKDIR /usr/src/app

# Sao chép file package.json và package-lock.json
COPY package*.json ./

# Chạy npm install. Vì đang chạy native nên sẽ không còn lỗi "Invalid ELF image".
RUN npm install --production --omit=dev


# --- GIAI ĐOẠN 2: PRODUCTION ---
# Quay trở lại image puppeteer chính thức để có trình duyệt và các thư viện hệ thống.
FROM ghcr.io/puppeteer/puppeteer:22.10.0

# Biến môi trường này báo cho puppeteer không cần tải lại trình duyệt,
# vì nó đã có sẵn trong image nền này.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /usr/src/app

# Sao chép các thư viện đã được cài đặt ở giai đoạn 'builder' vào image cuối cùng
COPY --from=builder /usr/src/app/node_modules ./node_modules

# Sao chép toàn bộ mã nguồn ứng dụng
COPY . .

# Mở cổng 3000
EXPOSE 3000

# Lệnh để khởi động ứng dụng
# Thêm --disable-dev-shm-usage là một best practice khi chạy Chrome trong Docker
CMD [ "node", "server.js" ]
