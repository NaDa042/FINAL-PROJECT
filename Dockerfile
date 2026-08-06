
FROM node:20

WORKDIR /app
COPY package.json package-lock.json ./

RUN npm install
COPY . .

EXPOSE 8080
RUN npm run build

CMD [ "npm","run","start" ]



 


