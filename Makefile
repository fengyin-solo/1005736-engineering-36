.PHONY: install frontend dev build test

# 一条命令把本地开发环境跑通：依赖没装齐就先装，再起 dev server
dev: install frontend

install:
	cd frontend && npm install

frontend:
	cd frontend && npm run dev

build:
	cd frontend && npm run build

test:
	cd frontend && npm test
