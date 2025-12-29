FROM node:20-slim
RUN apt-get update && \
    apt-get install -y dnsutils && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /usr/src/app
ADD . .
RUN npm install
CMD [ "node", "index6" ]
