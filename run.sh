#!/bin/sh

echo "Moving Directory"

cd /usr/node_app

echo "Installing"

npm install --production

echo "Starting up"

npm start