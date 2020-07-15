FROM node:14-alpine

RUN apk add --no-cache git tzdata

RUN mkdir -p /usr/node_app
COPY . /usr/node_app
WORKDIR /usr/node_app

RUN npm install --production

CMD ["npm", "start"]
