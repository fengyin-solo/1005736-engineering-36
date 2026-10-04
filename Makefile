.PHONY: install dev frontend build test

install:
	cd frontend && npm install

# 一条命令跑通本地开发：先把依赖装齐，再起 dev server
dev: install
	cd frontend && npm run dev

frontend: dev

# 上线前构建：同样先确认依赖装齐
build: install
	cd frontend && npm run build

test: install
	cd frontend && npm run test
