// Add dotenv configuration
require('dotenv').config();

const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');
const util = require('util');

const app = express();
const port = process.env.PORT || 3001;
const execPromise = util.promisify(exec);

// Configurable script path - use environment variable or default to a local path
const scriptPath = process.env.SCRIPT_PATH || path.join(__dirname, 'bash.sh');

// Middleware
app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
  methods: ['GET', 'POST'],
  credentials: true
}));
app.use(bodyParser.json({ limit: '10mb' })); // Parse JSON request bodies with larger limit

// Base directory for storing generated plugins
const PLUGINS_BASE_DIR = path.join(__dirname, 'generated-plugins');
if (!fs.existsSync(PLUGINS_BASE_DIR)) {
  fs.mkdirSync(PLUGINS_BASE_DIR, { recursive: true });
}

// Endpoint to generate a plugin
app.post('/api/generate-plugin', async (req, res) => {
  try {
    const { prompt, token, outputDir = './plugins' } = req.body;

    if (!prompt || !token) {
      return res.status(400).json({
        success: false,
        message: "Prompt and token are required"
      });
    }

    // Check if script exists and is accessible
    if (!fs.existsSync(scriptPath)) {
      console.error(`Bash script not found: ${scriptPath}`);
      return res.status(500).json({
        success: false,
        message: `Script file not found at ${scriptPath}. Server configuration error.`
      });
    }

    // Create a unique folder for this generation
    const timestamp = Date.now();
    const uniqueId = `plugin-${timestamp}`;
    const outputPath = path.join(PLUGINS_BASE_DIR, uniqueId);

    if (!fs.existsSync(outputPath)) {
      fs.mkdirSync(outputPath, { recursive: true });
    }

    // Directly run the bash script
    const escapedPrompt = prompt.replace(/"/g, '\\"');

    // Command to execute the bash script directly
    const command = `bash "${scriptPath}" "${escapedPrompt}" "${token}" "${outputPath}"`;

    console.log(`Executing command with script: ${scriptPath}`);

    // Execute the command asynchronously
    const { stdout, stderr } = await execPromise(command);

    // Check if the process was successful
    if (stderr && !stderr.includes("Downloading:")) {
      console.log("Script stderr:", stderr);
      return res.status(500).json({
        success: false,
        message: stderr
      });
    }

    console.log("Script stdout:", stdout);

    // Extract JAR file path from stdout if available
    const jarPathMatch = stdout.match(/Plugin JAR file created: (.*\.jar)/);
    let jarPath = null;

    if (jarPathMatch && jarPathMatch[1]) {
      jarPath = jarPathMatch[1];
      console.log("Found JAR path:", jarPath);
    }

    return res.json({
      success: true,
      message: "Plugin generated successfully!",
      jarPath: jarPath,
      outputDir: outputPath,
      log: stdout
    });

  } catch (error) {
    console.error("Error generating plugin:", error);
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

    // Handle relative paths - check if path is relative
    if (!path.isAbsolute(filePath)) {
      // First, check if the path is relative to the generated-plugins directory
      let possiblePaths = [];

      // Look through all plugin directories to find the file
      if (fs.existsSync(PLUGINS_BASE_DIR)) {
        const dirs = fs.readdirSync(PLUGINS_BASE_DIR);

        for (const dir of dirs) {
          const dirPath = path.join(PLUGINS_BASE_DIR, dir);

          // Only check directories
          if (fs.statSync(dirPath).isDirectory()) {
            // Check if the file might be in this plugin's target directory
            const fullPath = path.join(dirPath, filePath);

            if (fs.existsSync(fullPath)) {
              filePath = fullPath;
              break;
            }

            // If the path doesn't include 'target' but the file might be there
            if (!filePath.includes('target') && filePath.endsWith('.jar')) {
              const targetPath = path.join(dirPath, 'target', path.basename(filePath));
              possiblePaths.push(targetPath);
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
          const targetDir = path.join(PLUGINS_BASE_DIR, dir, 'target');

          if (fs.existsSync(targetDir) && fs.statSync(targetDir).isDirectory()) {
            const possiblePath = path.join(targetDir, filename);

            if (fs.existsSync(possiblePath)) {
              filePath = possiblePath;
              found = true;
              break;
            }
          }
        }
      }

      if (!found) {
        return res.status(404).json({
          success: false,
          message: `File not found: ${filePath}`,
          searchedIn: PLUGINS_BASE_DIR
        });
      }
    }

    console.log("Serving file from:", filePath);

    // Get the filename from the path
    const filename = path.basename(filePath);

    // Set headers for file download
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.setHeader('Content-Type', 'application/java-archive');

    // Stream the file to the response
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

  } catch (error) {
    console.error("Error downloading file:", error);
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
      const dirPath = path.join(PLUGINS_BASE_DIR, dir);

      // Only process directories
      if (fs.statSync(dirPath).isDirectory()) {
        // Find JAR files in the directory
        let jarFiles = [];

        // Check if there's a 'target' directory (Maven output)
        const targetDir = path.join(dirPath, 'target');
        if (fs.existsSync(targetDir) && fs.statSync(targetDir).isDirectory()) {
          jarFiles = fs.readdirSync(targetDir)
            .filter(file => file.endsWith('.jar') && !file.includes('original'))
            .map(file => path.join(targetDir, file));
        }

        plugins.push({
          id: dir,
          path: dirPath,
          jarFiles: jarFiles.map(file => ({
            name: path.basename(file),
            path: file
          })),
          createdAt: fs.statSync(dirPath).birthtime
        });
      }
    }

    // Sort by creation date (newest first)
    plugins.sort((a, b) => b.createdAt - a.createdAt);

    return res.json({
      success: true,
      plugins
    });

  } catch (error) {
    console.error("Error listing plugins:", error);
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
      scriptExists: fs.existsSync(scriptPath)
    };

    if (debug.baseDirExists) {
      const dirs = fs.readdirSync(PLUGINS_BASE_DIR);

      for (const dir of dirs) {
        const dirPath = path.join(PLUGINS_BASE_DIR, dir);
        const dirInfo = {
          name: dir,
          path: dirPath,
          isDirectory: fs.statSync(dirPath).isDirectory(),
          contents: []
        };

        if (dirInfo.isDirectory) {
          // List all files in this directory recursively
          const listFiles = (dir, base = '') => {
            const files = fs.readdirSync(dir);

            for (const file of files) {
              const filePath = path.join(dir, file);
              const relativePath = path.join(base, file);

              if (fs.statSync(filePath).isDirectory()) {
                listFiles(filePath, relativePath);
              } else {
                dirInfo.contents.push({
                  name: file,
                  path: filePath,
                  relativePath: relativePath
                });
              }
            }
          };

          listFiles(dirPath);
        }

        debug.plugins.push(dirInfo);
      }
    }

    return res.json(debug);
  } catch (error) {
    return res.status(500).json({
      error: error.message
    });
  }
});

// Route for simple health check
app.get('/', (req, res) => {
  res.send('API server is running. Use /api endpoints for functionality.');
});

// Start the server
app.listen(port, '0.0.0.0', () => {
  console.log(`API server running at http://localhost:${port}`);
  console.log(`Plugins directory: ${PLUGINS_BASE_DIR}`);
  console.log(`Using script at: ${scriptPath}`);
});