FROM node:20-slim

# Install required system dependencies with verification
RUN apt-get update && \
    apt-get install -y curl maven openjdk-17-jdk git jq && \
    echo "Curl location: $(which curl)" && \
    echo "JQ location: $(which jq)" && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy application files
COPY . .

# Make bash script executable
RUN chmod +x bash.sh 

# Fix Windows line endings if present
RUN apt-get update && apt-get install -y dos2unix && \
    dos2unix bash.sh && \
    rm -rf /var/lib/apt/lists/*

# Create the plugins directory
RUN mkdir -p generated-plugins

# Final verification of tools
RUN /usr/bin/curl --version && /usr/bin/jq --version

# Expose port
EXPOSE 3001

# Create a wrapper script to check environment before starting
RUN echo '#!/bin/bash\n\
echo "Verifying container environment:"\n\
echo "JQ: $(which jq)"\n\   
echo "Curl: $(which curl)"\n\
node wsl-api-server.js\n\
' > /app/start.sh && chmod +x /app/start.sh

# Start the application with the wrapper
CMD ["/app/start.sh"]