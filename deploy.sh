#!/bin/bash
# 
# Title : git pull and deploy docker site
# Date : 2022-06-01


# download latest source
git pull

npm install
npm run build

# shutdown existing docker container
docker compose down

# clean up old docker image or cache
docker system prune -f

# build new image
docker compose up -d --build
