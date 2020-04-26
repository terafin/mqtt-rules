FROM node:6-alpine


RUN mkdir -p /usr/node_app
COPY . /usr/node_app
WORKDIR /usr/node_app
RUN apk add --no-cache git

ENV TZ=America/Los_Angeles
RUN apk add --no-cache tzdata && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

RUN npm install --production

CMD ["npm", "start"]
