FROM eceasy/cli-proxy-api:latest

WORKDIR /CLIProxyAPI

# 暴露端口
EXPOSE 8317

# 下载配置模板并修改为适合 apply.build 的默认值
ADD https://github.com/router-for-me/CLIProxyAPI/raw/refs/heads/main/config.example.yaml /tmp/config.yaml

RUN sed -i 's/allow-remote: false/allow-remote: true/g' /tmp/config.yaml && \
    sed -i 's/secret-key: ""/secret-key: "test1234"/g' /tmp/config.yaml && \
    mkdir -p /CLIProxyAPI/config && \
    cp /tmp/config.yaml /CLIProxyAPI/config/config.yaml && \
    rm -f /tmp/config.yaml

# 持久化目录（认证文件等）
VOLUME ["/root/.cli-proxy-api"]

# 启动（使用自定义配置）
CMD ["./CLIProxyAPI", "--config", "/CLIProxyAPI/config/config.yaml"]
