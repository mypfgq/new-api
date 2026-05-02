FROM eceasy/cli-proxy-api:latest

# 设置工作目录
WORKDIR /CLIProxyAPI

# 暴露端口
EXPOSE 8317

# 安装 curl（用于下载配置文件）
USER root
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# 下载并修改配置文件
RUN curl -fsSL "https://github.com/router-for-me/CLIProxyAPI/raw/refs/heads/main/config.example.yaml" \
    -o /tmp/config.example.yaml && \
    sed -i 's/allow-remote: false/allow-remote: true/g' /tmp/config.example.yaml && \
    sed -i 's/secret-key: ""/secret-key: "test1234"/g' /tmp/config.example.yaml && \
    mkdir -p /CLIProxyAPI/config && \
    cp /tmp/config.example.yaml /CLIProxyAPI/config/config.yaml && \
    rm -f /tmp/config.example.yaml

# 创建 auth 目录（用于存储 OAuth tokens 等运行时数据）
RUN mkdir -p /root/.cli-proxy-api && \
    chmod 700 /root/.cli-proxy-api

# 设置启动命令，通过 --config 指定配置文件路径
# 如果镜像已有 ENTRYPOINT，这里用 CMD 传递参数；如不生效可改用 ENTRYPOINT
CMD ["--config", "/CLIProxyAPI/config/config.yaml"]

# 切换回非 root 用户（如果镜像定义了非 root 用户，请取消下面一行的注释）
# USER cli-proxy
