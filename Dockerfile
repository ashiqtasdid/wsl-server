FROM node:20-slim

# Install required system dependencies for bash.sh script
RUN apt-get update && apt-get install -y \
    curl \
    maven \
    openjdk-17-jdk \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy application files
COPY . .

# Make sure the bash script is executable
RUN chmod +x bash.sh

# Create the plugins directory
RUN mkdir -p generated-plugins

# Expose port
EXPOSE 3001

# Start the application
CMD ["node", "wsl-api-server.js"]