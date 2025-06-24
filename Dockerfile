FROM ghcr.io/puppeteer/puppeteer:22.10.0

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install --production --omit=dev

COPY . .

EXPOSE 3000

CMD [ "node", "server.js" ]
