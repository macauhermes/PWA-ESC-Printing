# Dockerfile

# base image
FROM node:26.11-alpine

# Copy your application code
COPY . .

# Build the Next.js application
RUN npm run build

EXPOSE 3000

# Start the production server
CMD ["npm", "run", "start"]
