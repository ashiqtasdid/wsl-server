// Add dotenv configuration
require('dotenv').config();

const express = require('express');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');
const util = require('util');
const { networkInterfaces } = require('os');

// Initialize Express app
const app = express();
const port = process.env.PORT || 3001;
const execPromise = util.promisify(exec);

// Configuration
const scriptPath = process.env.SCRIPT_PATH || path.join(__dirname, 'bash.sh');
const corsOrigins = process.env.CORS_ORIGINS ? 
  process.env.CORS_ORIGINS.split(',') : 
  ['http://localhost:3000', 'http://127.0.0.1:3000'];
const timeoutSeconds = parseInt(process.env.SCRIPT_TIMEOUT_SECONDS || '600', 10);
const apiKey = process.env.API_KEY || ''; // Set a secure API key in production
const logLevel = process.env.LOG_LEVEL || 'info'; // 'debug', 'info', 'warn', 'error'

// Simple logger with levels
const logger = {
  debug: (...args) => logLevel === 'debug' && console.log('[DEBUG]', ...args),
  info: (...args) => ['debug', 'info'].includes(logLevel) && console.log('[INFO]', ...args),
  warn: (...args) => ['debug', 'info', 'warn'].includes(logLevel) && console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args)
};

// Configure CORS
app.use(cors({
  origin: corsOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
}));

// Enable pre-flight for all routes
app.options('*', cors());

// Parse JSON request bodies with larger limit
app.use(bodyParser.json({ limit: '10mb' }));

// API Key middleware for secured endpoints (optional, uncomment to enable)
// const apiKeyAuth = (req, res, next) => {
//   const key = req.headers['x-api-key'];
//   if (apiKey && (!key || key !== apiKey)) {
//     return res.status(401).json({
//       success: false,
//       message: 'Invalid or missing API key'
//     });
//   }
//   next();
// };

// Rate limiting middleware
const rateLimit = (windowMs = 60000, max = 10) => {
  const clients = new Map();
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const client = clients.get(ip) || { count: 0, resetTime: Date.now() + windowMs };
    
    if (Date.now() > client.resetTime) {
      client.count = 1;
      client.resetTime = Date.now() + windowMs;
    } else {
      client.count++;
    }
    
    clients.set(ip, client);
    
    if (client.count > max) {
      return res.status(429).json({
        success: false,
        message: 'Too many requests, please try again later'
      });
    }
    
    next();
  };
};

// Apply rate limiting to certain endpoints
app.use('/api/generate-plugin', rateLimit(60000, 5)); // 5 requests per minute

// Base directory for storing generated plugins
const PLUGINS_BASE_DIR = path.join(__dirname, 'generated-plugins');
if (!fs.existsSync(PLUGINS_BASE_DIR)) {
  fs.mkdirSync(PLUGINS_BASE_DIR, { recursive: true });
}

// Safe path resolution to prevent directory traversal
const safeJoin = (base, ...paths) => {
  const resolved = path.join(base, ...paths);
  if (!resolved.startsWith(base)) {
    throw new Error('Path traversal attempt detected');
  }
  return resolved;
};

// Build stages for tracking progress
const buildStages = {
  UNDERSTANDING: "Understanding plugin requirements",
  REFINING: "Refining implementation approach",
  GENERATING: "Generating code files",
  CREATING: "Creating project structure",
  COMPILING: "Compiling Java code",
  FIXING: "Fixing compilation errors",
  SUCCESS: "Build completed successfully",
  FAILED: "Build failed"
};

// In-memory storage for build logs
const activeBuilds = new Map();

// Endpoint to generate a plugin
app.post('/api/generate-plugin', async (req, res) => {
  const startTime = Date.now();
  let uniqueId;
  try {
    const { prompt, token, outputDir = './plugins', buildId } = req.body;

    if (!prompt || !token) {
      return res.status(400).json({
        success: false,
        message: "Prompt and token are required"
      });
    }

    // Use the provided buildId or generate a new one
    uniqueId = buildId || `plugin-${Date.now()}`;

    // Validate prompt (optional: add more validation as needed)
    if (prompt.length > 1000) {
      return res.status(400).json({
        success: false,
        message: "Prompt is too long (max 1000 characters)"
      });
    }

    // Check if script exists and is accessible
    if (!fs.existsSync(scriptPath)) {
      logger.error(`Bash script not found: ${scriptPath}`);
      return res.status(500).json({
        success: false,
        message: `Script file not found at ${scriptPath}. Server configuration error.`
      });
    }

    // Create a unique folder for this generation
    const timestamp = Date.now();
    uniqueId = `plugin-${timestamp}`;
    const outputPath = safeJoin(PLUGINS_BASE_DIR, uniqueId);

    if (!fs.existsSync(outputPath)) {
      fs.mkdirSync(outputPath, { recursive: true });
    }

    // Initialize log storage for this build with stage tracking
    activeBuilds.set(uniqueId, {
      logs: [],
      status: 'initializing',
      startTime: Date.now(),
      stage: buildStages.UNDERSTANDING,
      fixAttempts: 0
    });

    // Directly run the bash script
    const escapedPrompt = prompt.replace(/"/g, '\\"');
    
    // Command to execute the bash script directly
    const apiHost = process.env.API_HOST || "http://host.docker.internal:5000";
    const command = `API_HOST="${apiHost}" bash "${scriptPath}" "${escapedPrompt}" "${token}" "${outputPath}"`;

    logger.info(`Executing command with script: ${scriptPath}`);
    logger.info(`Using API host: ${apiHost}`);

    // Use spawn instead of exec for real-time output
    let stdoutChunks = [];
    let stderrChunks = [];

    try {
      // Set up the process with proper environment
      const env = { ...process.env, API_HOST: apiHost };
      const bashProcess = spawn('bash', [scriptPath, escapedPrompt, token, outputPath], { 
        env: env,
        timeout: timeoutSeconds * 1000
      });

      // Capture and log output in real-time
      bashProcess.stdout.on('data', (data) => {
        const output = data.toString();
        logger.info(`[SCRIPT] ${output.trim()}`);
        stdoutChunks.push(output);
        
        // Store logs for retrieval
        if (activeBuilds.has(uniqueId)) {
          const buildData = activeBuilds.get(uniqueId);
          buildData.logs.push({ type: 'stdout', message: output.trim(), time: Date.now() });
          
          // Update build stage based on output patterns
          if (output.includes("Analyzing your request") || output.includes("Understanding requirements")) {
            buildData.stage = buildStages.UNDERSTANDING;
          } else if (output.includes("Designing plugin structure") || output.includes("Refining implementation")) {
            buildData.stage = buildStages.REFINING;
          } else if (output.includes("Generating code") || output.includes("Writing plugin code")) {
            buildData.stage = buildStages.GENERATING;
          } else if (output.includes("Creating project files") || output.includes("Setting up project")) {
            buildData.stage = buildStages.CREATING;
          } else if (output.includes("Compiling") || output.includes("Running Maven")) {
            buildData.stage = buildStages.COMPILING;
          } else if (output.includes("Attempting to fix error") || output.includes("Fixing compilation issues")) {
            buildData.fixAttempts++;
            buildData.stage = buildStages.FIXING;
          } else if (output.includes("Build successful") || output.includes("Plugin generation complete")) {
            buildData.stage = buildStages.SUCCESS;
            buildData.status = 'completed';
          }
          
          activeBuilds.set(uniqueId, buildData);
        }
      });

      bashProcess.stderr.on('data', (data) => {
        const output = data.toString();
        logger.warn(`[SCRIPT-ERR] ${output.trim()}`);
        stderrChunks.push(output);
        
        // Store logs for retrieval
        if (activeBuilds.has(uniqueId)) {
          const buildData = activeBuilds.get(uniqueId);
          buildData.logs.push({ type: 'stderr', message: output.trim(), time: Date.now() });
          
          // Check for compilation errors
          if (output.includes("error:") || output.includes("Exception")) {
            buildData.stage = buildStages.FIXING;
          }
          
          activeBuilds.set(uniqueId, buildData);
        }
      });

      // Wait for the process to complete
      const exitCode = await new Promise((resolve, reject) => {
        bashProcess.on('close', resolve);
        bashProcess.on('error', reject);
      });

      // Combine all output
      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');

      // Check if the process was successful
      if (exitCode !== 0) {
        logger.error(`Script exited with code ${exitCode}`);
        
        // Update build status
        if (activeBuilds.has(uniqueId)) {
          const build = activeBuilds.get(uniqueId);
          build.status = 'failed';
          build.stage = buildStages.FAILED;
          activeBuilds.set(uniqueId, build);
        }
        
        return res.status(500).json({
          success: false,
          message: stderr || `Script exited with code ${exitCode}`
        });
      }

      // Continue with your existing code - Extract JAR file path from stdout...
      let jarPath = null;
      const newFormatMatch = stdout.match(/PLUGIN_JAR_PATH:(.*)/);
      
      if (newFormatMatch && newFormatMatch[1]) {
        jarPath = newFormatMatch[1].trim();
        logger.info("Found JAR path (new format):", jarPath);
      } else {
        // Fall back to the old format if needed
        const oldFormatMatch = stdout.match(/Plugin JAR file created:?\s*(.*\.jar)/);
        if (oldFormatMatch && oldFormatMatch[1]) {
          jarPath = oldFormatMatch[1].trim();
          logger.info("Found JAR path (old format):", jarPath);
        }
      }

      const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);
      logger.info(`Plugin generated in ${processingTime} seconds`);

      // At the end, update build status and clean up older builds
      const build = activeBuilds.get(uniqueId);
      if (build) {
        build.status = 'completed';
        build.jarPath = jarPath;
        build.stage = buildStages.SUCCESS;
        
        // Clean up old builds (keep only last 10)
        const builds = Array.from(activeBuilds.entries());
        if (builds.length > 10) {
          builds.sort((a, b) => b[1].startTime - a[1].startTime);
          for (let i = 10; i < builds.length; i++) {
            activeBuilds.delete(builds[i][0]);
          }
        }
      }

      return res.json({
        success: true,
        message: "Plugin generated successfully!",
        jarPath: jarPath,
        outputDir: outputPath,
        processingTime: `${processingTime}s`,
        log: stdout,
        buildId: uniqueId
      });

    } catch (error) {
      logger.error("Error spawning script process:", error);
      
      // Update build status on error
      if (activeBuilds.has(uniqueId)) {
        const build = activeBuilds.get(uniqueId);
        build.status = 'failed';
        build.stage = buildStages.FAILED;
        build.error = error.message;
        activeBuilds.set(uniqueId, build);
      }
      
      throw error; // Let the outer catch block handle this
    }

  } catch (error) {
    logger.error("Error generating plugin:", error);
    
    // Handle timeout error specifically
    if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
      return res.status(504).json({
        success: false,
        message: `Script execution timed out after ${timeoutSeconds} seconds`,
        error: error.message,
        buildId: uniqueId
      });
    }
    
    // Update build status on error
    if (uniqueId && activeBuilds.has(uniqueId)) {
      const build = activeBuilds.get(uniqueId);
      build.status = 'failed';
      build.stage = buildStages.FAILED;
      build.error = error.message;
      activeBuilds.set(uniqueId, build);
    }

    return res.status(500).json({
      success: false,
      message: error.message || "An unknown error occurred",
      buildId: uniqueId
    });
  }
});

// Endpoint to get build status
app.get('/api/build-status/:id', (req, res) => {
  try {
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Build ID is required"
      });
    }
    
    // Get the build from active builds
    if (activeBuilds.has(id)) {
      const build = activeBuilds.get(id);
      return res.json({
        success: true,
        status: build.status,
        stage: build.stage,
        fixAttempts: build.fixAttempts,
        elapsedTime: Date.now() - build.startTime
      });
    }
    
    // If build not found
    return res.status(404).json({
      success: false,
      message: `Build ${id} not found`
    });
  } catch (error) {
    logger.error("Error fetching build status:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "An unknown error occurred"
    });
  }
});

// Endpoint to download a generated file
app.get('/api/download', (req, res) => {
  try {
    let filePath = req.query.path;

    if (!filePath) {
      return res.status(400).json({
        success: false,
        message: "File path is required"
      });
    }

    // Normalize path separators (replace Windows backslashes with forward slashes)
    filePath = filePath.replace(/\\/g, '/');
    logger.info("Processing download request for:", filePath);

    // Basic security check - block paths with ../ to prevent directory traversal
    if (filePath.includes('../') || filePath.includes('..\\')) {
      return res.status(403).json({
        success: false,
        message: "Invalid file path: directory traversal not allowed"
      });
    }

    // Handle relative paths - check if path is relative
    if (!path.isAbsolute(filePath)) {
      // First, check if the path is relative to the generated-plugins directory
      let possiblePaths = [];

      // Look through all plugin directories to find the file
      if (fs.existsSync(PLUGINS_BASE_DIR)) {
        const dirs = fs.readdirSync(PLUGINS_BASE_DIR);

        for (const dir of dirs) {
          const dirPath = safeJoin(PLUGINS_BASE_DIR, dir);

          // Only check directories
          if (fs.statSync(dirPath).isDirectory()) {
            // Check if the file might be in this plugin's target directory
            try {
              const fullPath = safeJoin(dirPath, filePath);
              
              if (fs.existsSync(fullPath)) {
                filePath = fullPath;
                break;
              }

              // If the path doesn't include 'target' but the file might be there
              if (!filePath.includes('target') && filePath.endsWith('.jar')) {
                const targetPath = safeJoin(dirPath, 'target', path.basename(filePath));
                possiblePaths.push(targetPath);
              }
            } catch (err) {
              logger.warn(`Path resolution error: ${err.message}`);
              // Continue to next directory
            }
          }
        }

        // If we still haven't found the file, try the possible paths
        if (!fs.existsSync(filePath) && possiblePaths.length > 0) {
          for (const possiblePath of possiblePaths) {
            if (fs.existsSync(possiblePath)) {
              filePath = possiblePath;
              break;
            }
          }
        }
      }
    }

    // Check if the file exists
    if (!fs.existsSync(filePath)) {
      // Try one more approach - look for this filename in all target directories
      const filename = path.basename(filePath);
      let found = false;

      if (fs.existsSync(PLUGINS_BASE_DIR)) {
        const dirs = fs.readdirSync(PLUGINS_BASE_DIR);

        for (const dir of dirs) {
          try {
            const targetDir = safeJoin(PLUGINS_BASE_DIR, dir, 'target');

            if (fs.existsSync(targetDir) && fs.statSync(targetDir).isDirectory()) {
              const possiblePath = safeJoin(targetDir, filename);

              if (fs.existsSync(possiblePath)) {
                filePath = possiblePath;
                found = true;
                break;
              }
            }
          } catch (err) {
            logger.warn(`Path resolution error in target dir: ${err.message}`);
            // Continue to next directory
          }
        }
      }

      if (!found) {
        return res.status(404).json({
          success: false,
          message: `File not found: ${filename}`,
          searchedIn: PLUGINS_BASE_DIR
        });
      }
    }

    logger.info("Serving file from:", filePath);

    // Get the filename from the path
    const filename = path.basename(filePath);

    // Check file size before serving (optional)
    const stats = fs.statSync(filePath);
    if (stats.size > 50 * 1024 * 1024) { // 50MB
      logger.warn(`Large file download requested: ${filename} (${(stats.size/1024/1024).toFixed(2)}MB)`);
    }

    // Set headers for file download
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.setHeader('Content-Type', 'application/java-archive');
    res.setHeader('Content-Length', stats.size);

    // Stream the file to the response
    const fileStream = fs.createReadStream(filePath);
    fileStream.on('error', (error) => {
      logger.error(`Error streaming file: ${error.message}`);
      // Only send error if headers haven't been sent yet
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: "Error streaming file"
        });
      } else {
        res.end();
      }
    });
    fileStream.pipe(res);

  } catch (error) {
    logger.error("Error downloading file:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "An unknown error occurred"
    });
  }
});

// Get list of all generated plugins
app.get('/api/plugins', (req, res) => {
  try {
    const plugins = [];

    // Read all directories in the plugins base directory
    if (!fs.existsSync(PLUGINS_BASE_DIR)) {
      return res.json({
        success: true,
        plugins: []
      });
    }

    const dirs = fs.readdirSync(PLUGINS_BASE_DIR);

    for (const dir of dirs) {
      try {
        const dirPath = safeJoin(PLUGINS_BASE_DIR, dir);

        // Only process directories
        if (fs.statSync(dirPath).isDirectory()) {
          // Find JAR files in the directory
          let jarFiles = [];

          // Check if there's a 'target' directory (Maven output)
          const targetDir = safeJoin(dirPath, 'target');
          if (fs.existsSync(targetDir) && fs.statSync(targetDir).isDirectory()) {
            jarFiles = fs.readdirSync(targetDir)
              .filter(file => file.endsWith('.jar') && !file.includes('original'))
              .map(file => safeJoin(targetDir, file));
          }

          // Look for pom.xml to extract plugin info
          let pluginInfo = { name: path.basename(dir) };
          const pomPath = safeJoin(dirPath, 'pom.xml');
          if (fs.existsSync(pomPath)) {
            try {
              const pomContent = fs.readFileSync(pomPath, 'utf8');
              const artifactIdMatch = pomContent.match(/<artifactId>(.*?)<\/artifactId>/);
              const versionMatch = pomContent.match(/<version>(.*?)<\/version>/);
              
              if (artifactIdMatch && artifactIdMatch[1]) {
                pluginInfo.artifactId = artifactIdMatch[1];
              }
              if (versionMatch && versionMatch[1]) {
                pluginInfo.version = versionMatch[1];
              }
            } catch (pomErr) {
              logger.warn(`Error reading pom.xml: ${pomErr.message}`);
            }
          }

          plugins.push({
            id: dir,
            path: dirPath,
            info: pluginInfo,
            jarFiles: jarFiles.map(file => ({
              name: path.basename(file),
              path: file,
              size: fs.statSync(file).size
            })),
            createdAt: fs.statSync(dirPath).birthtime
          });
        }
      } catch (dirErr) {
        logger.warn(`Error processing directory ${dir}: ${dirErr.message}`);
        // Continue with next directory
      }
    }

    // Sort by creation date (newest first)
    plugins.sort((a, b) => b.createdAt - a.createdAt);

    return res.json({
      success: true,
      plugins,
      baseDir: PLUGINS_BASE_DIR
    });

  } catch (error) {
    logger.error("Error listing plugins:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "An unknown error occurred"
    });
  }
});

// Endpoint to fetch build logs
app.get('/api/build-logs', (req, res) => {
  try {
    const { id } = req.query;
    
    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Build ID is required"
      });
    }
    
    // Get the build from active builds or try to find in file system
    if (activeBuilds.has(id)) {
      const build = activeBuilds.get(id);
      return res.json({
        success: true,
        logs: build.logs,
        status: build.status,
        stage: build.stage,
        fixAttempts: build.fixAttempts,
        startTime: build.startTime,
        elapsedTime: Date.now() - build.startTime
      });
    } 
    
    // If build not in memory, try to get from generated plugins
    const pluginDir = safeJoin(PLUGINS_BASE_DIR, id);
    if (fs.existsSync(pluginDir)) {
      // Check if there's a logs.txt file
      const logFile = safeJoin(pluginDir, 'logs.txt');
      
      if (fs.existsSync(logFile)) {
        const logs = fs.readFileSync(logFile, 'utf8')
          .split('\n')
          .filter(line => line.trim())
          .map(line => ({ 
            type: line.includes('[ERROR]') ? 'stderr' : 'stdout', 
            message: line, 
            time: null 
          }));
          
        return res.json({
          success: true,
          logs,
          status: 'completed',
          stage: buildStages.SUCCESS,
          fromFile: true
        });
      }
      
      // If no log file, just return a simple completed status
      return res.json({
        success: true,
        logs: [{ type: 'stdout', message: 'Build completed, no logs available', time: null }],
        status: 'completed',
        stage: buildStages.SUCCESS,
        fromFile: true
      });
    }
    
    // If we can't find the build, return an error
    return res.status(404).json({
      success: false,
      message: `Build ${id} not found`
    });
  } catch (error) {
    logger.error("Error fetching build logs:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "An unknown error occurred"
    });
  }
});

// Debug endpoint to list all plugins and files
app.get('/api/debug', (req, res) => {
  try {
    const debug = {
      baseDir: PLUGINS_BASE_DIR,
      baseDirExists: fs.existsSync(PLUGINS_BASE_DIR),
      plugins: [],
      scriptPath: scriptPath,
      scriptExists: fs.existsSync(scriptPath),
      environment: {
        nodejs: process.version,
        platform: process.platform,
        arch: process.arch,
        env: {
          PATH: process.env.PATH
        }
      }
    };

    if (debug.baseDirExists) {
      const dirs = fs.readdirSync(PLUGINS_BASE_DIR);

      for (const dir of dirs) {
        try {
          const dirPath = safeJoin(PLUGINS_BASE_DIR, dir);
          const dirInfo = {
            name: dir,
            path: dirPath,
            isDirectory: fs.statSync(dirPath).isDirectory(),
            contents: []
          };

          if (dirInfo.isDirectory) {
            // List all files in this directory recursively
            const listFiles = (dir, base = '') => {
              try {
                const files = fs.readdirSync(dir);

                for (const file of files) {
                  try {
                    const filePath = safeJoin(dir, file);
                    const relativePath = path.join(base, file);
                    const stats = fs.statSync(filePath);

                    if (stats.isDirectory()) {
                      listFiles(filePath, relativePath);
                    } else {
                      dirInfo.contents.push({
                        name: file,
                        path: filePath,
                        relativePath: relativePath,
                        size: stats.size,
                        modified: stats.mtime
                      });
                    }
                  } catch (fileErr) {
                    logger.warn(`Error processing file ${file}: ${fileErr.message}`);
                  }
                }
              } catch (readErr) {
                logger.warn(`Error reading directory ${dir}: ${readErr.message}`);
              }
            };

            listFiles(dirPath);
          }

          debug.plugins.push(dirInfo);
        } catch (dirErr) {
          logger.warn(`Error processing directory in debug: ${dirErr.message}`);
        }
      }
    }

    return res.json(debug);
  } catch (error) {
    logger.error("Debug endpoint error:", error);
    return res.status(500).json({
      error: error.message
    });
  }
});

// Diagnostic endpoint to check connection details
app.get('/connection-test', (req, res) => {
  const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  
  // Get all network interfaces
  const nets = networkInterfaces();
  const results = {};
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // Skip over non-IPv4 and internal addresses
      if (net.family === 'IPv4' && !net.internal) {
        if (!results[name]) {
          results[name] = [];
        }
        results[name].push(net.address);
      }
    }
  }
  
  res.json({
    clientIP: clientIP,
    serverInterfaces: results,
    serverPort: port,
    requestHeaders: req.headers,
    apiHost: process.env.API_HOST || "http://host.docker.internal:5000"
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  // Check if script exists
  const scriptExists = fs.existsSync(scriptPath);
  // Check if plugins directory is writable
  let dirWritable = false;
  try {
    const testDir = safeJoin(PLUGINS_BASE_DIR, `test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    fs.rmdirSync(testDir);
    dirWritable = true;
  } catch (err) {
    logger.warn(`Plugins directory not writable: ${err.message}`);
  }
  
  const status = scriptExists && dirWritable ? 'healthy' : 'degraded';
  
  res.status(status === 'healthy' ? 200 : 503).json({
    status: status,
    version: '1.1.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {
      scriptExists,
      dirWritable
    }
  });
});

// Route for simple health check
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Minecraft Plugin Generator API</title></head>
      <body>
        <h1>API server is running</h1>
        <p>Use /api endpoints for functionality.</p>
        <ul>
          <li><a href="/health">Health Check</a></li>
          <li><a href="/api/plugins">List Plugins</a></li>
          <li><a href="/connection-test">Connection Test</a></li>
        </ul>
      </body>
    </html>
  `);
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : err.message
  });
});

// Start the server
app.listen(port, '0.0.0.0', () => {
  logger.info(`API server running at http://localhost:${port}`);
  logger.info(`Plugins directory: ${PLUGINS_BASE_DIR}`);
  logger.info(`Using script at: ${scriptPath}`);
  
  // Print network interfaces for debugging
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        logger.info(`Available on network: http://${net.address}:${port}`);
      }
    }
  }
});