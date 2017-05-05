FROM node:alpine

RUN mkdir -p /usr/node_app
COPY . /usr/node_app
WORKDIR /usr/node_app
RUN npm install --production
RUN npm install pm2@next -g

# Start process.yml
CMD ["pm2-docker", "mqtt-rules.js"]
