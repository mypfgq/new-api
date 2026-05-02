FROM calciumion/new-api:latest

# 设置工作目录
WORKDIR /app

# 暴露端口（镜像本身已暴露，这里可再声明）
EXPOSE 3000

# 容器启动命令（镜像已有 ENTRYPOINT，可覆盖）
# CMD ["/new-api"]
