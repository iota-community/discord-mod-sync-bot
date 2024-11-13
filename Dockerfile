# Use Node.js version 22
FROM node:22-alpine

# Create app directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install app dependencies
RUN npm install

# Copy the rest of the app's source code
COPY . .

# Build the TypeScript code
RUN npm run build

# Start the bot
CMD ["npm", "start"]
