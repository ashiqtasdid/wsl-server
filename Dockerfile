FROM node:20-slim

# Install pnpm
RUN npm install -g pnpm

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy application files
COPY . .

# Create the generated-plugins directory
RUN mkdir -p generated-plugins

# Make the bash.sh script executable
RUN chmod +x bash.sh

# Expose the port the app runs on
EXPOSE 3001

# Start the application
CMD ["node", "wsl-api-server.js"]