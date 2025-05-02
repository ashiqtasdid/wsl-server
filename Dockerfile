FROM node:23-slim

# Install curl and other dependencies needed by your bash script
RUN apt-get update && apt-get install -y \
    curl \
    maven \
    openjdk-17-jdk \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g pnpm

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* ./

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