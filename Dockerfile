FROM node:current-bookworm

RUN npm install -g pnpm

WORKDIR /src

COPY package.json pnpm-lock.yaml ./

RUN pnpm install

CMD ["/bin/sh", "-c", "pnpm start"]
