# Dockerfile (Phiên bản Multi-stage, Multi-platform)

# --- GIAI ĐOẠN 1: BUILDER ---
# Giai đoạn này chỉ dùng để cài đặt node_modules một cách an toàn
FROM ghcr.io/puppeteer/puppeteer:22.10.0 AS builder

# Đặt môi trường làm việc
WORKDIR /usr/src/app

# Sao chép file package.json và package-lock.json vào trước
COPY package*.json ./

# Chạy npm install để cài đặt các thư viện.
# Bước này sẽ được thực hiện riêng cho từng kiến trúc (amd64 hoặc arm64)
RUN npm install --production --omit=dev


# --- GIAI ĐOẠN 2: PRODUCTION (RUNNER) ---
# Giai đoạn này sẽ tạo ra image cuối cùng để chạy ứng dụng
# Bắt đầu lại từ image nền sạch để đảm bảo image cuối cùng nhỏ gọn
FROM ghcr.io/puppeteer/puppeteer:22.10.0

WORKDIR /usr/src/app

# Sao chép các thư viện đã được cài đặt ở giai đoạn 'builder' vào image cuối cùng
COPY --from=builder /usr/src/app/node_modules ./node_modules

# Sao chép toàn bộ mã nguồn ứng dụng
COPY . .

# Mở cổng 3000
EXPOSE 3000

# Lệnh để khởi động ứng dụng
CMD [ "node", "server.js" ]
