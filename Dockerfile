FROM node:20-slim

# Install required system dependencies with verification
RUN apt-get update && \
    apt-get install -y curl maven openjdk-17-jdk git && \
    curl --version && \
    java -version && \
    mvn --version && \
    rm -rf /var/lib/apt/lists/*

# Fix potential Windows line endings
RUN apt-get update && apt-get install -y dos2unix && dos2unix *.sh || true

# Create app directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy application files
COPY . .

# Make sure the bash script is executable and fix line endings
RUN chmod +x bash.sh && \
    (which dos2unix && dos2unix bash.sh || true)

# Create the plugins directory
RUN mkdir -p generated-plugins

# Verify curl is available in the final image
RUN curl --version

# Expose port
EXPOSE 3001

# Start the application
CMD ["node", "wsl-api-server.js"]