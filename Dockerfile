# --- Giai đoạn 1: Sử dụng Image nền chính thức của Puppeteer ---
# Image này đã có sẵn Node.js và tất cả các thư viện hệ thống cần thiết cho Chromium,
# giúp chúng ta không cần phải cài đặt thủ công như trước.
FROM ghcr.io/puppeteer/puppeteer:22.10.0

# Đặt môi trường làm việc bên trong container
WORKDIR /usr/src/app

# Sao chép file package.json và package-lock.json vào trước
# Docker sẽ cache lại bước này, giúp build nhanh hơn nếu các thư viện không thay đổi
COPY package*.json ./

# Cài đặt các thư viện Node.js cần thiết cho production
# Cờ --production sẽ bỏ qua các devDependencies, giúp image nhẹ hơn
RUN npm install --production --omit=dev

# Sao chép toàn bộ mã nguồn còn lại của ứng dụng vào
COPY . .

# Mở cổng 3000 để bên ngoài có thể truy cập vào server
EXPOSE 3000

# Lệnh để khởi động ứng dụng khi container chạy
CMD [ "node", "server.js" ]
