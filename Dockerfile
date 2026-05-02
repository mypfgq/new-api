FROM eceasy/cli-proxy-api:latest

# 设置工作目录（镜像可能已设定，这里显式声明）
WORKDIR /CLIProxyAPI

# 暴露端口
EXPOSE 8317

# 注意：配置文件和 auth 目录需要在运行时挂载，不打包进镜像
# 构建命令: docker build -t my-cli-proxy-api .
# 运行命令: docker run --rm -p 8317:8317 \
#   -v /path/to/your/config.yaml:/CLIProxyAPI/config.yaml \
#   -v /path/to/your/auth-dir:/root/.cli-proxy-api \
#   my-cli-proxy-api:latest

# 如果镜像有默认启动命令，无需覆盖；如需自定义可取消下面注释
# CMD ["node", "index.js"]  # 示例，请根据实际启动命令调整
